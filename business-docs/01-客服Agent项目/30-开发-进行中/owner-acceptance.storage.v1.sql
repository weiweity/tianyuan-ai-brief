-- A2b-3 ADDITIVE CANDIDATE: after owner-acceptance.content-scope.v1.
-- Per-row storage integrity. Full-set admission remains a consuming batch check;
-- existing import/finalize/publish/rollback interfaces are NOT yet owner-enabled.
BEGIN;

-- One owner for active-record timing, source readiness and revocation fences.
-- Both full-set admission and row storage call this within their write transaction.
CREATE FUNCTION public.owner_acceptance_active_record(
  p_tenant TEXT, p_sha256 TEXT, p_owner_hash TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_record JSONB;
BEGIN
  -- Repeatable-read snapshots could miss a revocation committed before our lock.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_ISOLATION_DENIED';
  END IF;
  IF p_tenant IS NULL OR p_tenant !~ '^[a-zA-Z0-9_-]{1,128}$'
     OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$'
     OR p_owner_hash IS NULL OR p_owner_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_NOT_ACTIVE';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtext('cs_ai_content_publish'));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_tenant || ':' || p_sha256, 0));
  SELECT record INTO v_record FROM public.owner_acceptance_records
    WHERE tenant_id = p_tenant AND record_sha256 = p_sha256 AND owner_subject_hash = p_owner_hash;
  IF NOT FOUND OR v_record ->> 'purpose' IS DISTINCT FROM 'g1a_offline_only'
     OR public.owner_acceptance_instant(v_record -> 'accepted_at') > clock_timestamp()
     OR public.owner_acceptance_instant(v_record -> 'expires_at') <= clock_timestamp()
     OR NOT public.owner_acceptance_sources_ready(p_tenant, v_record)
     OR EXISTS (SELECT 1 FROM public.owner_acceptance_revocations WHERE tenant_id = p_tenant AND record_sha256 = p_sha256) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_NOT_ACTIVE';
  END IF;
  RETURN v_record;
END;
$$;
CREATE OR REPLACE FUNCTION public.assert_owner_acceptance(
  p_tenant TEXT, p_sha256 TEXT, p_owner_hash TEXT, p_purpose TEXT, p_observed_scope JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_record JSONB;
BEGIN
  IF p_purpose IS DISTINCT FROM 'g1a_offline_only' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_NOT_ACTIVE';
  END IF;
  v_record := public.owner_acceptance_active_record(p_tenant,p_sha256,p_owner_hash);
  IF v_record -> 'scope' IS DISTINCT FROM p_observed_scope THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_NOT_ACTIVE';
  END IF;
END;
$$;

-- Shared review-shape policy; coalesce makes SQL NULL fail closed. Business risk,
-- questions, placeholders, source and effective-window constraints remain separate.
CREATE FUNCTION public.owner_acceptance_review_shape(
  p_risk TEXT,p_conflict BOOLEAN,p_mode TEXT,p_primary TEXT,p_role TEXT,p_evd TEXT,
  p_secondary TEXT,p_secondary_role TEXT,p_secondary_evd TEXT,p_record_sha256 TEXT
) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(
    p_primary ~ '^[0-9a-f]{64}$' AND p_role = 'ROLE-CONTENT-LEAD' AND btrim(p_evd) <> ''
    AND (
      (p_mode = 'owner_acceptance' AND NOT p_conflict
        AND p_record_sha256 ~ '^[0-9a-f]{64}$' AND p_record_sha256 IS NOT NULL
        AND p_evd ~ '^EVD-[A-Z0-9-]{6,127}$'
        AND p_secondary IS NULL AND p_secondary_role IS NULL AND p_secondary_evd IS NULL)
      OR (p_record_sha256 IS NULL AND (
        (p_mode = 'dual' AND (p_risk = 'high' OR p_conflict)
          AND p_secondary ~ '^[0-9a-f]{64}$' AND p_secondary <> p_primary
          AND p_secondary_role = 'ROLE-CS-MANAGER' AND btrim(p_secondary_evd) <> '')
        OR (p_mode = 'single' AND p_risk IN ('low','medium') AND NOT p_conflict
          AND p_secondary IS NULL AND p_secondary_role IS NULL AND p_secondary_evd IS NULL)
      ))
    ), FALSE)
$$;

ALTER TABLE public.scripts ADD COLUMN owner_acceptance_record_sha256 TEXT;
ALTER TABLE public.staging_scripts ADD COLUMN owner_acceptance_record_sha256 TEXT;
ALTER TABLE public.staging_scripts ADD COLUMN script_version INTEGER;
ALTER TABLE public.release_items ADD COLUMN owner_acceptance_record_sha256 TEXT;
ALTER TABLE public.scripts DROP CONSTRAINT scripts_review_mode_check,
  DROP CONSTRAINT scripts_review_shape,
  ADD CONSTRAINT scripts_review_shape CHECK (public.owner_acceptance_review_shape(risk_level,has_conflict,review_mode,
      primary_reviewer_id,primary_reviewer_role,primary_review_evd,
      secondary_reviewer_id,secondary_reviewer_role,secondary_review_evd,
      owner_acceptance_record_sha256));
ALTER TABLE public.release_items DROP CONSTRAINT release_items_review_mode_check,
  DROP CONSTRAINT release_review_shape,
  ADD CONSTRAINT release_review_shape CHECK (public.owner_acceptance_review_shape(risk_level,has_conflict,review_mode,
      primary_reviewer_id,primary_reviewer_role,primary_review_evd,
      secondary_reviewer_id,secondary_reviewer_role,secondary_review_evd,
      owner_acceptance_record_sha256));
ALTER TABLE public.staging_scripts DROP CONSTRAINT staging_operation_shape,
  ADD CONSTRAINT staging_operation_shape CHECK (
    (
      operation = 'withdraw'
      AND title IS NULL AND answer_text IS NULL AND content_hash IS NULL
      AND owner_role IS NULL AND review_due_at IS NULL
      AND platform_scope IS NULL AND product_scope_type IS NULL AND product_scope_refs IS NULL
      AND campaign_tag IS NULL
      AND effective_from IS NULL AND effective_to IS NULL
      AND intent_taxonomy_version IS NULL AND intent_id IS NULL
      AND risk_level IS NULL AND risk_categories IS NULL
      AND has_conflict IS NULL AND review_mode IS NULL
      AND owner_acceptance_record_sha256 IS NULL AND script_version IS NULL
      AND primary_reviewer_id IS NULL AND primary_reviewer_role IS NULL
      AND primary_review_evd IS NULL
      AND secondary_reviewer_id IS NULL AND secondary_reviewer_role IS NULL
      AND secondary_review_evd IS NULL
      AND placeholder_keys IS NULL
      AND search_document IS NULL AND search_fallback_text IS NULL
      AND pg_catalog.jsonb_array_length(questions_json) = 0
      AND quality_status = 'clean' AND quality_gate_passed
    )
    OR (
      operation = 'upsert'
      AND title IS NOT NULL AND answer_text IS NOT NULL
      AND pg_catalog.btrim(title) <> '' AND pg_catalog.btrim(answer_text) <> ''
      AND owner_role IS NOT NULL AND pg_catalog.btrim(owner_role) <> ''
      AND review_due_at IS NOT NULL
      AND effective_from IS NOT NULL
      AND (effective_to IS NULL OR effective_from < effective_to)
      AND public.content_text_array_is_nonblank_unique(platform_scope)
      AND pg_catalog.cardinality(platform_scope) > 0
      AND platform_scope <@ ARRAY['qianniu','douyin']::TEXT[]
      AND product_scope_type IN ('storewide','category','sku')
      AND public.content_text_array_is_nonblank_unique(product_scope_refs)
      AND (
        (product_scope_type = 'storewide' AND pg_catalog.cardinality(product_scope_refs) = 0)
        OR (product_scope_type IN ('category','sku') AND pg_catalog.cardinality(product_scope_refs) > 0)
      )
      AND intent_taxonomy_version IS NOT NULL AND intent_id IS NOT NULL
      AND risk_level IN ('low','medium','high') AND has_conflict IS NOT NULL
      AND public.content_risk_categories_are_valid(risk_level, risk_categories)
      AND public.owner_acceptance_review_shape(risk_level,has_conflict,review_mode,
      primary_reviewer_id,primary_reviewer_role,primary_review_evd,
      secondary_reviewer_id,secondary_reviewer_role,secondary_review_evd,
      owner_acceptance_record_sha256)
      AND public.content_template_placeholders_are_valid(answer_text, placeholder_keys)
      AND content_hash ~ '^[0-9a-f]{64}$' AND search_document IS NOT NULL
      AND pg_catalog.length(search_document) > 0
      AND search_fallback_text IS NOT NULL AND pg_catalog.btrim(search_fallback_text) <> ''
    )
  );
ALTER TABLE public.staging_scripts ADD CONSTRAINT staging_acceptance_version CHECK (
  (review_mode = 'owner_acceptance' AND script_version IS NOT NULL AND script_version >= 1)
  OR (review_mode IS DISTINCT FROM 'owner_acceptance' AND script_version IS NULL)
);

-- Normalize the actual typed row at the storage boundary. No supplied snapshot,
-- membership flag or digest can replace this observation. This guard proves one
-- approved member, not whole-set completeness: batch consumers must also call
-- assert_owner_acceptance_content with their independently selected four sources.
CREATE FUNCTION public.owner_acceptance_storage_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_snapshot JSONB; v_record JSONB; v_item JSONB; v_tenant TEXT; v_version INTEGER;
BEGIN
  IF NEW.review_mode IS DISTINCT FROM 'owner_acceptance' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'scripts' THEN
    v_version := NEW.version; v_tenant := NEW.tenant_id;
  ELSIF TG_TABLE_NAME = 'staging_scripts' THEN
    v_version := NEW.script_version;
    SELECT tenant_id INTO v_tenant FROM public.import_batches WHERE import_batch_id = NEW.import_batch_id;
  ELSIF TG_TABLE_NAME = 'release_items' THEN
    v_version := NEW.script_version;
    SELECT tenant_id INTO v_tenant FROM public.content_releases WHERE release_id = NEW.release_id;
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'OWNER_ACCEPTANCE_STORAGE_DENIED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.authoritative_source_versions
    WHERE source_version_id = NEW.source_version_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_NOT_ACTIVE';
  END IF;
  v_record := public.owner_acceptance_active_record(v_tenant,NEW.owner_acceptance_record_sha256,NEW.primary_reviewer_id);
  v_snapshot := public.content_governance_snapshot(
    NEW.script_id,NEW.category,NEW.title,NEW.answer_text,NEW.source_ref,NEW.source_version_id,
    NEW.owner_role,NEW.review_due_at,NEW.platform_scope,NEW.product_scope_type,NEW.product_scope_refs,
    NEW.effective_from,NEW.effective_to,NEW.intent_taxonomy_version,NEW.intent_id,
    NEW.risk_level,NEW.risk_categories,NEW.has_conflict,NEW.review_mode,
    NEW.primary_reviewer_id,NEW.primary_reviewer_role,NEW.primary_review_evd,
    NEW.secondary_reviewer_id,NEW.secondary_reviewer_role,NEW.secondary_review_evd,
    NEW.placeholder_keys,NEW.questions_json);
  v_item := jsonb_build_object('script_id',NEW.script_id,'script_version',v_version,
    'domain',NEW.category,'source_version_id',NEW.source_version_id,
    'review_input_sha256',public.owner_acceptance_review_input_sha256(v_snapshot,v_version),
    'risk_level',NEW.risk_level,'risk_categories',v_snapshot -> 'risk_categories','has_conflict',NEW.has_conflict);
  IF NOT ((v_record #> '{scope,items}') @> jsonb_build_array(v_item))
     OR NEW.primary_review_evd IS DISTINCT FROM v_record ->> 'approval_evidence_id'
     OR NEW.content_hash IS DISTINCT FROM public.owner_acceptance_content_hash(v_snapshot,v_version,NEW.owner_acceptance_record_sha256) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_STORAGE_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER owner_acceptance_storage_guard BEFORE INSERT OR UPDATE ON public.scripts
  FOR EACH ROW EXECUTE FUNCTION public.owner_acceptance_storage_guard();
CREATE TRIGGER owner_acceptance_storage_guard BEFORE INSERT OR UPDATE ON public.staging_scripts
  FOR EACH ROW EXECUTE FUNCTION public.owner_acceptance_storage_guard();
CREATE TRIGGER owner_acceptance_storage_guard BEFORE INSERT OR UPDATE ON public.release_items
  FOR EACH ROW EXECUTE FUNCTION public.owner_acceptance_storage_guard();

REVOKE ALL ON FUNCTION public.owner_acceptance_active_record(TEXT,TEXT,TEXT),
  public.owner_acceptance_review_shape(TEXT,BOOLEAN,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT),
  public.owner_acceptance_storage_guard() FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO cs_ai_definer;
ALTER FUNCTION public.owner_acceptance_active_record(TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.owner_acceptance_review_shape(TEXT,BOOLEAN,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.owner_acceptance_storage_guard() OWNER TO cs_ai_definer;
REVOKE CREATE ON SCHEMA public FROM cs_ai_definer;
COMMENT ON COLUMN public.staging_scripts.script_version IS
  'Required exact approved version for owner_acceptance; legacy single/dual keep NULL until existing publish assignment.';
COMMIT;
