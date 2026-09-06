-- A2b-5 ADDITIVE CANDIDATE: apply after owner-acceptance.import.v1.
-- SQL consumers validate the existing g1a_offline_only record; this migration does
-- not authorize production intake, bind a registrar login or activate runtime.
BEGIN;

-- One release-level admission owner. Observe immutable persisted content and the
-- independently stored four source bindings, never a caller-supplied scope.
-- Successful owner checks keep source/record shared transaction fences; expected
-- contract denials become readiness=false, unexpected database errors propagate.
CREATE FUNCTION public.owner_acceptance_release_content_ready(p_release_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_tenant TEXT; v_source_ids TEXT[]; v_group RECORD;
BEGIN
  SELECT tenant_id INTO v_tenant FROM public.content_releases WHERE release_id = p_release_id;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.release_items
      WHERE release_id = p_release_id AND review_mode = 'owner_acceptance') THEN
    RETURN TRUE;
  END IF;
  SELECT array_agg(source_version_id ORDER BY domain COLLATE "C") INTO v_source_ids
    FROM public.release_source_bindings WHERE release_id = p_release_id;
  IF cardinality(v_source_ids) IS DISTINCT FROM 4 THEN RETURN FALSE; END IF;
  FOR v_group IN
    SELECT ri.owner_acceptance_record_sha256,ri.primary_reviewer_id,
      jsonb_agg(jsonb_build_object('script_version',ri.script_version,'content_hash',ri.content_hash,
        'snapshot',public.content_governance_snapshot(
          ri.script_id,ri.category,ri.title,ri.answer_text,ri.source_ref,ri.source_version_id,
          ri.owner_role,ri.review_due_at,ri.platform_scope,ri.product_scope_type,ri.product_scope_refs,
          ri.effective_from,ri.effective_to,ri.intent_taxonomy_version,ri.intent_id,
          ri.risk_level,ri.risk_categories,ri.has_conflict,ri.review_mode,
          ri.primary_reviewer_id,ri.primary_reviewer_role,ri.primary_review_evd,
          ri.secondary_reviewer_id,ri.secondary_reviewer_role,ri.secondary_review_evd,
          ri.placeholder_keys,ri.questions_json)) ORDER BY ri.script_id COLLATE "C") AS content
    FROM public.release_items ri
    WHERE ri.release_id = p_release_id AND ri.review_mode = 'owner_acceptance'
    GROUP BY ri.owner_acceptance_record_sha256,ri.primary_reviewer_id
    ORDER BY ri.owner_acceptance_record_sha256,ri.primary_reviewer_id
  LOOP
    PERFORM public.assert_owner_acceptance_content(v_tenant,v_group.owner_acceptance_record_sha256,
      v_group.primary_reviewer_id,v_source_ids,v_group.content);
  END LOOP;
  RETURN TRUE;
EXCEPTION WHEN SQLSTATE 'ZA001' OR SQLSTATE 'ZA004' THEN
  -- These are closed content/acceptance validation denials, not infrastructure errors.
  RETURN FALSE;
END;
$$;
REVOKE ALL ON FUNCTION public.owner_acceptance_release_content_ready(TEXT) FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO cs_ai_definer;
ALTER FUNCTION public.owner_acceptance_release_content_ready(TEXT) OWNER TO cs_ai_definer;
REVOKE CREATE ON SCHEMA public FROM cs_ai_definer;

-- Read admission relies on per-row storage membership plus immutable release
-- content: each (release,script_id) is unique, so the exact approved member count
-- proves completeness without reserializing or hashing business payloads. New
-- members still pass the storage guard; UPDATE/DELETE of release rows are denied.
CREATE FUNCTION public.owner_acceptance_release_ready(p_release_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_tenant TEXT; v_source_ids TEXT[]; v_expected_ids TEXT[]; v_group RECORD; v_record JSONB;
BEGIN
  SELECT tenant_id INTO v_tenant FROM public.content_releases WHERE release_id = p_release_id;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  SELECT array_agg(source_version_id ORDER BY domain COLLATE "C") INTO v_source_ids
    FROM public.release_source_bindings WHERE release_id = p_release_id;
  FOR v_group IN
    SELECT owner_acceptance_record_sha256,primary_reviewer_id,count(*) AS member_count
    FROM public.release_items WHERE release_id = p_release_id AND review_mode = 'owner_acceptance'
    GROUP BY owner_acceptance_record_sha256,primary_reviewer_id
    ORDER BY owner_acceptance_record_sha256,primary_reviewer_id
  LOOP
    v_record := public.owner_acceptance_active_record(v_tenant,v_group.owner_acceptance_record_sha256,v_group.primary_reviewer_id);
    SELECT array_agg(binding ->> 'source_version_id' ORDER BY binding ->> 'domain' COLLATE "C")
      INTO v_expected_ids FROM jsonb_array_elements(v_record #> '{scope,source_bindings}') binding;
    IF v_group.member_count <> jsonb_array_length(v_record #> '{scope,items}')
       OR v_source_ids IS DISTINCT FROM v_expected_ids THEN RETURN FALSE; END IF;
  END LOOP;
  RETURN TRUE;
EXCEPTION WHEN SQLSTATE 'ZA004' THEN
  RETURN FALSE; -- Expected lifecycle/isolation denial; never suppress infrastructure failures.
END;
$$;
REVOKE ALL ON FUNCTION public.owner_acceptance_release_ready(TEXT) FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO cs_ai_definer;
ALTER FUNCTION public.owner_acceptance_release_ready(TEXT) OWNER TO cs_ai_definer;
REVOKE CREATE ON SCHEMA public FROM cs_ai_definer;

CREATE OR REPLACE FUNCTION public.owner_acceptance_storage_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_snapshot JSONB; v_record JSONB; v_item JSONB; v_tenant TEXT; v_version INTEGER;
BEGIN
  IF NEW.review_mode IS DISTINCT FROM 'owner_acceptance' THEN RETURN NEW; END IF;
  -- Archival only removes authoring eligibility. Never require stale evidence to
  -- retire content, and never allow an accompanying content/identity change.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'scripts' THEN
    IF NEW.status = 'archived'
       AND (to_jsonb(NEW) - ARRAY['status','updated_at']) =
           (to_jsonb(OLD) - ARRAY['status','updated_at']) THEN RETURN NEW; END IF;
  END IF;
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

CREATE OR REPLACE FUNCTION publish_content_release(
  p_import_batch_id TEXT,
  p_title TEXT,
  p_summary TEXT,
  p_actor_user_id TEXT,
  p_actor_role TEXT
) RETURNS TABLE(release_id TEXT, release_seq BIGINT, announcement_id TEXT, source_binding_hash TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_got BOOLEAN;
  v_release_id TEXT;
  v_seq BIGINT;
  v_ann TEXT;
  v_prev TEXT;
  v_base TEXT;
  v_expected_source_hash TEXT;
  v_source_hash TEXT;
  v_source_count INT;
  v_source_noncanonical BOOLEAN;
  v_source_suspended BOOLEAN;
  v_ok_count INT;
  v_publishable_upsert_count INT;
  v_quality_population_hash TEXT;
  v_batch_claimed INT;
  v_tenant TEXT;
BEGIN
  -- p_actor_role is a server-verified end-user claim used for policy/audit. DB ACL authenticates
  -- the isolated app_content_admin workload identity; the API must select that pool only after
  -- verified owner authorization. The parameter itself is not independent database authentication.
  IF p_actor_role IS DISTINCT FROM 'owner'
     OR p_actor_user_id IS NULL OR pg_catalog.btrim(p_actor_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'phase1 publish requires owner', DETAIL = 'FORBIDDEN';
  END IF;
  IF p_import_batch_id IS NULL OR pg_catalog.btrim(p_import_batch_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'import_batch_id is required', DETAIL = 'VALIDATION';
  END IF;

  v_got := pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('cs_ai_content_publish'));
  IF NOT v_got THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'publish single-flight lock not acquired', DETAIL = 'CONFLICT';
  END IF;
  PERFORM pg_catalog.set_config('app.publishing', 'on', true);

  -- Atomic compare-and-set is the publish/cancel serialization point. If cancel wins first, this
  -- touches zero rows; if publish wins first, cancel waits on the row lock and then sees publishing.
  UPDATE public.import_batches
  SET status = 'publishing'
  WHERE import_batch_id = p_import_batch_id
    AND status = 'staged';
  GET DIAGNOSTICS v_batch_claimed = ROW_COUNT;
  IF v_batch_claimed <> 1 THEN
    IF NOT EXISTS (SELECT 1 FROM public.import_batches WHERE import_batch_id = p_import_batch_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA002', MESSAGE = 'import_batch does not exist', DETAIL = 'NOT_FOUND';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'import_batch is not staged or is concurrently changing', DETAIL = 'CONFLICT';
  END IF;

  SELECT b.base_release_id, b.source_binding_hash, b.tenant_id
  INTO v_base, v_expected_source_hash, v_tenant
  FROM public.import_batches b
  WHERE b.import_batch_id = p_import_batch_id;

  SELECT c.current_release_id INTO v_prev
  FROM public.content_current c WHERE c.id = 1 FOR UPDATE;
  IF v_prev IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'import was validated against a stale current release', DETAIL = 'SOURCE_BASE_RELEASE_STALE';
  END IF;

  IF EXISTS (SELECT 1 FROM public.content_releases previous
      WHERE previous.release_id = v_prev AND previous.tenant_id IS DISTINCT FROM v_tenant)
    OR EXISTS (SELECT 1 FROM public.staging_scripts staged JOIN public.scripts existing USING (script_id)
      WHERE staged.import_batch_id = p_import_batch_id AND existing.tenant_id IS DISTINCT FROM v_tenant)
    OR EXISTS (SELECT 1 FROM public.import_batch_source_bindings binding
      JOIN public.authoritative_source_versions source USING (source_version_id)
      WHERE binding.import_batch_id = p_import_batch_id AND source.tenant_id IS DISTINCT FROM v_tenant) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'publish tenant binding mismatch', DETAIL = 'OWNER_ACCEPTANCE_NOT_ACTIVE';
  END IF;
  IF EXISTS (SELECT 1 FROM public.staging_scripts staged LEFT JOIN public.scripts existing USING (script_id)
      WHERE staged.import_batch_id = p_import_batch_id AND staged.review_mode = 'owner_acceptance'
        AND staged.script_version::bigint IS DISTINCT FROM coalesce(existing.version::bigint,0) + 1) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'approved version changed after import', DETAIL = 'OWNER_ACCEPTANCE_IMPORT_VERSION_MISMATCH';
  END IF;

  WITH prospective AS (
    SELECT ib.domain, ib.source_version_id
    FROM public.import_batch_source_bindings ib
    WHERE ib.import_batch_id = p_import_batch_id
    UNION ALL
    SELECT rb.domain, rb.source_version_id
    FROM public.release_source_bindings rb
    WHERE rb.release_id = v_prev
      AND NOT EXISTS (
        SELECT 1 FROM public.import_batch_source_bindings ib
        WHERE ib.import_batch_id = p_import_batch_id AND ib.domain = rb.domain
      )
  )
  SELECT
    pg_catalog.count(*)::INT,
    pg_catalog.encode(public.digest(pg_catalog.convert_to(
      pg_catalog.string_agg(p.domain || ':' || p.source_version_id, '|' ORDER BY p.domain),
      'UTF8'
    ), 'sha256'), 'hex'),
    coalesce(pg_catalog.bool_or(asv.use_class <> 'canonical'), FALSE),
    coalesce(pg_catalog.bool_or(susp.source_version_id IS NOT NULL), FALSE)
  INTO v_source_count, v_source_hash, v_source_noncanonical, v_source_suspended
  FROM prospective p
  JOIN public.authoritative_source_versions asv
    ON asv.source_version_id = p.source_version_id AND asv.domain = p.domain
  LEFT JOIN public.authoritative_source_suspensions susp
    ON susp.source_version_id = p.source_version_id;

  IF v_source_count <> 4 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'prospective release requires exactly four source domains', DETAIL = 'SOURCE_SET_INCOMPLETE';
  END IF;
  IF v_source_noncanonical THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'prospective release contains a reference-only source', DETAIL = 'SOURCE_NOT_ELIGIBLE';
  END IF;
  IF v_source_suspended THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'prospective release contains a suspended source', DETAIL = 'SOURCE_SUSPENDED';
  END IF;
  IF v_source_hash IS DISTINCT FROM v_expected_source_hash THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'prospective source set changed after enqueue', DETAIL = 'SOURCE_BINDING_HASH_MISMATCH';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.staging_scripts s
    WHERE s.import_batch_id = p_import_batch_id AND s.validation_ok IS NOT TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'staging has invalid rows', DETAIL = 'VALIDATION';
  END IF;

  SELECT COUNT(*) INTO v_ok_count FROM public.staging_scripts s
  WHERE s.import_batch_id = p_import_batch_id
    AND s.validation_ok
    AND s.quality_status = 'clean'
    AND s.quality_gate_passed;
  IF v_ok_count IS NULL OR v_ok_count < 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'no clean content passed the quality gate', DETAIL = 'QUALITY_GATE_NOT_PASSED';
  END IF;
  SELECT pg_catalog.count(*)::INT INTO v_publishable_upsert_count
  FROM public.staging_scripts s
  WHERE s.import_batch_id = p_import_batch_id
    AND s.validation_ok
    AND s.quality_status = 'clean'
    AND s.quality_gate_passed
    AND s.operation = 'upsert';
  v_quality_population_hash :=
    public.content_quality_staging_population_manifest_hash(p_import_batch_id);
  IF NOT EXISTS (
    SELECT 1 FROM public.import_batches b
    WHERE b.import_batch_id = p_import_batch_id
      AND b.quality_gate_passed
      AND b.clean_count = v_ok_count
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'batch quality gate evidence is missing or stale', DETAIL = 'QUALITY_GATE_NOT_PASSED';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.content_quality_review_plans plan
    JOIN public.content_quality_review_evidence evidence ON evidence.plan_id = plan.plan_id
    WHERE plan.import_batch_id = p_import_batch_id
      AND evidence.import_batch_id = p_import_batch_id
      AND plan.population_manifest_hash = v_quality_population_hash
      AND evidence.population_manifest_hash = v_quality_population_hash
      AND plan.clean_population_count = (
        SELECT pg_catalog.count(*)::INTEGER
        FROM public.staging_scripts population
        WHERE population.import_batch_id = p_import_batch_id
          AND population.operation = 'upsert'
      )
      AND evidence.publishable_clean_count = v_publishable_upsert_count
      AND evidence.review_quarantined_count = (
        SELECT pg_catalog.count(*)::INTEGER
        FROM public.staging_scripts quarantined
        WHERE quarantined.import_batch_id = p_import_batch_id
          AND quarantined.operation = 'upsert'
          AND quarantined.quality_status = 'quarantined'
      )
      AND evidence.conclusion = 'passed'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'frozen quality review evidence has not passed', DETAIL = 'QUALITY_GATE_NOT_PASSED';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.staging_scripts s
    WHERE s.import_batch_id = p_import_batch_id
      AND s.validation_ok
      AND s.quality_status = 'clean'
      AND s.quality_gate_passed
      AND s.operation = 'withdraw'
      AND NOT EXISTS (
        SELECT 1 FROM public.release_items ri
        WHERE ri.release_id = v_prev AND ri.script_id = s.script_id
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'withdraw target not in current release', DETAIL = 'VALIDATION';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.staging_scripts s
    WHERE s.import_batch_id = p_import_batch_id
      AND s.validation_ok
      AND s.quality_status = 'clean'
      AND s.quality_gate_passed
      AND s.operation = 'upsert'
      AND (
        s.search_document IS NULL
        OR s.search_fallback_text IS NULL
        OR (s.review_mode <> 'owner_acceptance' AND s.content_hash IS DISTINCT FROM
          public.content_governance_hash(
            s.script_id, s.category, s.title, s.answer_text, s.source_ref, s.source_version_id,
            s.owner_role, s.review_due_at, s.platform_scope, s.product_scope_type,
            s.product_scope_refs, s.effective_from, s.effective_to,
            s.intent_taxonomy_version, s.intent_id, s.risk_level, s.risk_categories, s.has_conflict,
            s.review_mode, s.primary_reviewer_id, s.primary_reviewer_role, s.primary_review_evd,
            s.secondary_reviewer_id, s.secondary_reviewer_role, s.secondary_review_evd,
            s.placeholder_keys, s.questions_json
          ))
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'upsert governance hash/search_document mismatch', DETAIL = 'GOVERNANCE_HASH_MISMATCH';
  END IF;

  -- Register only the non-PII source indirection at the owner-controlled publish boundary. Ordinary
  -- workers cannot write this table or assert promotion/retirement evidence.
  PERFORM pg_catalog.set_config('app.semantic_asset_write', 'publish', true);
  INSERT INTO public.semantic_source_assets(
    source_asset_id, source, origin_fingerprint, origin_fingerprint_key_version,
    source_query_id, promotion_review_ref, promoted_by_role, promoted_at,
    lifecycle, created_at
  )
  SELECT DISTINCT ON (question.value ->> 'source_asset_id')
    question.value ->> 'source_asset_id',
    question.value ->> 'source',
    question.value ->> 'origin_fingerprint',
    question.value ->> 'origin_fingerprint_key_version',
    question.value ->> 'source_query_id',
    question.value ->> 'promotion_review_ref',
    question.value ->> 'promoted_by_role',
    CASE WHEN question.value ->> 'promoted_at' IS NULL THEN NULL
      ELSE (question.value ->> 'promoted_at')::TIMESTAMPTZ END,
    'active',
    pg_catalog.clock_timestamp()
  FROM public.staging_scripts staged
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(staged.questions_json) question(value)
  WHERE staged.import_batch_id = p_import_batch_id
    AND staged.validation_ok AND staged.quality_status = 'clean'
    AND staged.quality_gate_passed AND staged.operation = 'upsert'
  ORDER BY question.value ->> 'source_asset_id', staged.script_id,
    question.value ->> 'question_id'
  ON CONFLICT (source_asset_id) DO NOTHING;

  IF EXISTS (
    SELECT 1
    FROM public.staging_scripts staged
    WHERE staged.import_batch_id = p_import_batch_id
      AND staged.validation_ok AND staged.quality_status = 'clean'
      AND staged.quality_gate_passed AND staged.operation = 'upsert'
      AND public.content_questions_source_assets_are_active(staged.questions_json) IS DISTINCT FROM TRUE
  ) OR EXISTS (
    SELECT 1
    FROM public.release_items prior
    WHERE prior.release_id = v_prev
      AND NOT EXISTS (
        SELECT 1 FROM public.import_batch_source_bindings touched
        WHERE touched.import_batch_id = p_import_batch_id AND touched.domain = prior.category
      )
      AND public.content_questions_source_assets_are_active(prior.questions_json) IS DISTINCT FROM TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'prospective release uses missing, mismatched or retired semantic source asset', DETAIL = 'SEMANTIC_SOURCE_ASSET_NOT_ACTIVE';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.staging_scripts s
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(s.questions_json) question(value)
    JOIN public.script_questions existing
      ON existing.question_id = question.value ->> 'question_id'
    JOIN public.semantic_source_assets existing_asset
      ON existing_asset.source_asset_id = existing.source_asset_id
    WHERE s.import_batch_id = p_import_batch_id
      AND s.validation_ok AND s.quality_status = 'clean' AND s.quality_gate_passed
      AND s.operation = 'upsert'
      AND (
        existing.script_id IS DISTINCT FROM s.script_id
        OR existing.question_version > (question.value ->> 'question_version')::INTEGER
        OR (
          existing.question_version = (question.value ->> 'question_version')::INTEGER
          AND (
            existing.question_text IS DISTINCT FROM question.value ->> 'question_text'
            OR existing.question_hash IS DISTINCT FROM question.value ->> 'question_hash'
            OR existing.semantic_family_id IS DISTINCT FROM question.value ->> 'semantic_family_id'
            OR existing.origin_fingerprint IS DISTINCT FROM question.value ->> 'origin_fingerprint'
            OR existing.origin_fingerprint_key_version IS DISTINCT FROM question.value ->> 'origin_fingerprint_key_version'
            OR existing.source_asset_id IS DISTINCT FROM question.value ->> 'source_asset_id'
            OR existing.source IS DISTINCT FROM question.value ->> 'source'
            OR existing.intent_taxonomy_version IS DISTINCT FROM question.value ->> 'intent_taxonomy_version'
            OR existing.intent_id IS DISTINCT FROM question.value ->> 'intent_id'
            OR existing.source_query_id IS NOT NULL
            OR existing.promotion_review_ref IS DISTINCT FROM question.value ->> 'promotion_review_ref'
            OR existing.promoted_by_role IS DISTINCT FROM question.value ->> 'promoted_by_role'
            OR existing.promoted_at IS DISTINCT FROM CASE
              WHEN question.value ->> 'promoted_at' IS NULL THEN NULL
              ELSE (question.value ->> 'promoted_at')::TIMESTAMPTZ
            END
            OR existing.status IS DISTINCT FROM 'active'
            OR existing_asset.source_query_id IS DISTINCT FROM question.value ->> 'source_query_id'
            OR existing_asset.lifecycle IS DISTINCT FROM 'active'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'stable question identity conflicts with published lineage', DETAIL = 'QUESTION_IDENTITY_CONFLICT';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.staging_scripts s
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(s.questions_json) question(value)
    LEFT JOIN LATERAL (
      SELECT pg_catalog.max(existing.question_version) AS max_version
      FROM public.script_questions existing
      WHERE existing.question_id = question.value ->> 'question_id'
    ) lineage ON TRUE
    WHERE s.import_batch_id = p_import_batch_id
      AND s.validation_ok AND s.quality_status = 'clean' AND s.quality_gate_passed
      AND s.operation = 'upsert'
      AND (
        (lineage.max_version IS NULL AND (question.value ->> 'question_version')::INTEGER <> 1)
        OR (
          lineage.max_version IS NOT NULL
          AND (question.value ->> 'question_version')::INTEGER > lineage.max_version
          AND (question.value ->> 'question_version')::INTEGER <> lineage.max_version + 1
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'question version must start at one and advance without gaps', DETAIL = 'QUESTION_VERSION_GAP';
  END IF;

  -- A bound domain is a complete snapshot. Archive every prior live row in touched domains first;
  -- staging upserts below republish only rows present in the approved replacement snapshot.
  UPDATE public.scripts sc
  SET status = 'archived', updated_at = now()
  WHERE sc.tenant_id = v_tenant AND EXISTS (
    SELECT 1 FROM public.import_batch_source_bindings ib
    WHERE ib.import_batch_id = p_import_batch_id AND ib.domain = sc.category
  );

  -- Upsert live scripts from staging upserts only.
  INSERT INTO public.scripts AS sc (
    script_id, category, title, answer_text, status, version, content_hash,
    source_ref, source_version_id, platform_scope, product_scope_type, product_scope_refs,
    campaign_tag, effective_from, effective_to,
    intent_taxonomy_version, intent_id, risk_level, risk_categories, has_conflict, review_mode, owner_acceptance_record_sha256,
    primary_reviewer_id, primary_reviewer_role, primary_review_evd,
    secondary_reviewer_id, secondary_reviewer_role, secondary_review_evd,
    placeholder_keys, questions_json,
    priority, owner_role, review_due_at, created_at, updated_at, published_at, tenant_id
  )
  SELECT
    s.script_id, s.category, s.title, s.answer_text, 'published', coalesce(s.script_version,1), s.content_hash,
    s.source_ref, s.source_version_id, s.platform_scope, s.product_scope_type, s.product_scope_refs,
    s.campaign_tag, s.effective_from, s.effective_to,
    s.intent_taxonomy_version, s.intent_id, s.risk_level, s.risk_categories, s.has_conflict, s.review_mode, s.owner_acceptance_record_sha256,
    s.primary_reviewer_id, s.primary_reviewer_role, s.primary_review_evd,
    s.secondary_reviewer_id, s.secondary_reviewer_role, s.secondary_review_evd,
    s.placeholder_keys, s.questions_json,
    0, s.owner_role, s.review_due_at, now(), now(), now(), v_tenant
  FROM public.staging_scripts s
  WHERE s.import_batch_id = p_import_batch_id
    AND s.validation_ok AND s.quality_status = 'clean' AND s.quality_gate_passed
    AND s.operation = 'upsert'
  ON CONFLICT (script_id) DO UPDATE SET
    category = EXCLUDED.category,
    title = EXCLUDED.title,
    answer_text = EXCLUDED.answer_text,
    status = 'published',
    version = sc.version + 1,
    content_hash = EXCLUDED.content_hash,
    source_ref = EXCLUDED.source_ref,
    source_version_id = EXCLUDED.source_version_id,
    platform_scope = EXCLUDED.platform_scope,
    product_scope_type = EXCLUDED.product_scope_type,
    product_scope_refs = EXCLUDED.product_scope_refs,
    campaign_tag = EXCLUDED.campaign_tag,
    effective_from = EXCLUDED.effective_from,
    effective_to = EXCLUDED.effective_to,
    intent_taxonomy_version = EXCLUDED.intent_taxonomy_version,
    intent_id = EXCLUDED.intent_id,
    risk_level = EXCLUDED.risk_level,
    risk_categories = EXCLUDED.risk_categories,
    has_conflict = EXCLUDED.has_conflict,
    review_mode = EXCLUDED.review_mode,
    owner_acceptance_record_sha256 = EXCLUDED.owner_acceptance_record_sha256,
    primary_reviewer_id = EXCLUDED.primary_reviewer_id,
    primary_reviewer_role = EXCLUDED.primary_reviewer_role,
    primary_review_evd = EXCLUDED.primary_review_evd,
    secondary_reviewer_id = EXCLUDED.secondary_reviewer_id,
    secondary_reviewer_role = EXCLUDED.secondary_reviewer_role,
    secondary_review_evd = EXCLUDED.secondary_review_evd,
    placeholder_keys = EXCLUDED.placeholder_keys,
    questions_json = EXCLUDED.questions_json,
    owner_role = EXCLUDED.owner_role,
    review_due_at = EXCLUDED.review_due_at,
    updated_at = now(),
    published_at = now();

  -- Immutable question lineage projection. Existing (question_id,version) rows are never overwritten;
  -- a changed semantic/source/taxonomy mapping must arrive as the next version.
  INSERT INTO public.script_questions AS question (
    question_id, script_id, question_version, question_text, question_hash,
    semantic_family_id, origin_fingerprint, origin_fingerprint_key_version,
    source_asset_id, source, intent_taxonomy_version, intent_id, source_query_id,
    promotion_review_ref, promoted_by_role, promoted_at, status, created_at, updated_at
  )
  SELECT
    payload.question_id, s.script_id, payload.question_version, payload.question_text,
    payload.question_hash, payload.semantic_family_id, payload.origin_fingerprint,
    payload.origin_fingerprint_key_version, payload.source_asset_id, payload.source,
    payload.intent_taxonomy_version, payload.intent_id, NULL,
    payload.promotion_review_ref, payload.promoted_by_role, payload.promoted_at,
    'active', now(), now()
  FROM public.staging_scripts s
  CROSS JOIN LATERAL pg_catalog.jsonb_to_recordset(s.questions_json) AS payload(
    question_id TEXT,
    question_version INTEGER,
    question_text TEXT,
    question_hash TEXT,
    semantic_family_id TEXT,
    origin_fingerprint TEXT,
    origin_fingerprint_key_version TEXT,
    source_asset_id TEXT,
    source TEXT,
    intent_taxonomy_version TEXT,
    intent_id TEXT,
    source_query_id TEXT,
    promotion_review_ref TEXT,
    promoted_by_role TEXT,
    promoted_at TIMESTAMPTZ
  )
  WHERE s.import_batch_id = p_import_batch_id
    AND s.validation_ok AND s.quality_status = 'clean' AND s.quality_gate_passed
    AND s.operation = 'upsert'
  ON CONFLICT (question_id, question_version) DO NOTHING;

  -- Withdraw is an explicit tombstone: archive live material and exclude it from the new snapshot.
  UPDATE public.scripts sc
  SET status = 'archived', updated_at = now()
  FROM public.staging_scripts s
  WHERE s.import_batch_id = p_import_batch_id
    AND s.validation_ok AND s.quality_status = 'clean' AND s.quality_gate_passed
    AND s.operation = 'withdraw'
    AND sc.script_id = s.script_id;

  v_seq := pg_catalog.nextval('public.content_release_seq'::pg_catalog.regclass);
  v_release_id := 'rel_' || v_seq::text;
  v_ann := 'ann_' || v_seq::text;

  UPDATE public.content_releases SET status = 'superseded' WHERE status = 'published';

  INSERT INTO public.content_releases(
    release_id, release_seq, title, summary, import_batch_id, rollback_of_release_id,
    status, source_binding_hash, published_by, published_by_role, published_at, tenant_id
  )
  VALUES (
    v_release_id, v_seq, p_title, p_summary, p_import_batch_id, NULL,
    'published', v_source_hash, p_actor_user_id, p_actor_role, now(), v_tenant
  );

  INSERT INTO public.release_source_bindings(release_id, domain, source_version_id, created_at)
  SELECT v_release_id, p.domain, p.source_version_id, now()
  FROM (
    SELECT ib.domain, ib.source_version_id
    FROM public.import_batch_source_bindings ib
    WHERE ib.import_batch_id = p_import_batch_id
    UNION ALL
    SELECT rb.domain, rb.source_version_id
    FROM public.release_source_bindings rb
    WHERE rb.release_id = v_prev
      AND NOT EXISTS (
        SELECT 1 FROM public.import_batch_source_bindings ib
        WHERE ib.import_batch_id = p_import_batch_id AND ib.domain = rb.domain
      )
  ) p;

  -- MERGE by authoritative domain: prior rows from every touched domain are removed as one unit.
  INSERT INTO public.release_items(
    release_id, script_id, script_version, content_hash, answer_text, title, category,
    source_ref, source_version_id, owner_role, review_due_at,
    effective_from, effective_to, platform_scope, product_scope_type, product_scope_refs,
    intent_taxonomy_version, intent_id, risk_level, risk_categories, has_conflict, review_mode, owner_acceptance_record_sha256,
    primary_reviewer_id, primary_reviewer_role, primary_review_evd,
    secondary_reviewer_id, secondary_reviewer_role, secondary_review_evd,
    placeholder_keys, questions_json,
    search_document, search_fallback_text
  )
  SELECT
    v_release_id, x.script_id, x.script_version, x.content_hash, x.answer_text, x.title, x.category,
    x.source_ref, x.source_version_id, x.owner_role, x.review_due_at,
    x.effective_from, x.effective_to, x.platform_scope, x.product_scope_type, x.product_scope_refs,
    x.intent_taxonomy_version, x.intent_id, x.risk_level, x.risk_categories, x.has_conflict, x.review_mode, x.owner_acceptance_record_sha256,
    x.primary_reviewer_id, x.primary_reviewer_role, x.primary_review_evd,
    x.secondary_reviewer_id, x.secondary_reviewer_role, x.secondary_review_evd,
    x.placeholder_keys, x.questions_json,
    x.search_document, x.search_fallback_text
  FROM (
    -- upsert wins
    SELECT
      s.script_id, sc.version AS script_version, s.content_hash, s.answer_text, s.title, s.category,
      s.source_ref, s.source_version_id, s.owner_role, s.review_due_at,
      s.effective_from, s.effective_to, s.platform_scope, s.product_scope_type, s.product_scope_refs,
      s.intent_taxonomy_version, s.intent_id, s.risk_level, s.risk_categories, s.has_conflict, s.review_mode, s.owner_acceptance_record_sha256,
      s.primary_reviewer_id, s.primary_reviewer_role, s.primary_review_evd,
      s.secondary_reviewer_id, s.secondary_reviewer_role, s.secondary_review_evd,
      s.placeholder_keys, s.questions_json,
      s.search_document, s.search_fallback_text
    FROM public.staging_scripts s
    JOIN public.scripts sc ON sc.script_id = s.script_id
    WHERE s.import_batch_id = p_import_batch_id
      AND s.validation_ok AND s.quality_status = 'clean' AND s.quality_gate_passed
      AND s.operation = 'upsert'
    UNION ALL
    -- previous rows not mentioned by either upsert or withdraw remain
    SELECT
      ri.script_id, ri.script_version, ri.content_hash, ri.answer_text, ri.title, ri.category,
      ri.source_ref, ri.source_version_id, ri.owner_role, ri.review_due_at,
      ri.effective_from, ri.effective_to, ri.platform_scope, ri.product_scope_type, ri.product_scope_refs,
      ri.intent_taxonomy_version, ri.intent_id, ri.risk_level, ri.risk_categories, ri.has_conflict, ri.review_mode, ri.owner_acceptance_record_sha256,
      ri.primary_reviewer_id, ri.primary_reviewer_role, ri.primary_review_evd,
      ri.secondary_reviewer_id, ri.secondary_reviewer_role, ri.secondary_review_evd,
      ri.placeholder_keys, ri.questions_json,
      ri.search_document, ri.search_fallback_text
    FROM public.release_items ri
    WHERE v_prev IS NOT NULL
      AND ri.release_id = v_prev
      AND NOT EXISTS (
        SELECT 1 FROM public.import_batch_source_bindings ib
        WHERE ib.import_batch_id = p_import_batch_id AND ib.domain = ri.category
      )
  ) x;

  IF NOT public.owner_acceptance_release_content_ready(v_release_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'release acceptance is not active or complete', DETAIL = 'OWNER_ACCEPTANCE_NOT_ACTIVE';
  END IF;

  INSERT INTO public.content_current(id, current_release_id, updated_at)
  VALUES (1, v_release_id, now())
  ON CONFLICT (id) DO UPDATE SET current_release_id = EXCLUDED.current_release_id, updated_at = now();

  INSERT INTO public.announcements(announcement_id, release_id, title, summary, created_at)
  VALUES (v_ann, v_release_id, COALESCE(p_title, '话术库更新'), p_summary, now());

  UPDATE public.import_batches SET status = 'published', finished_at = now()
  WHERE import_batch_id = p_import_batch_id;

  INSERT INTO public.change_audits(
    change_id, action, actor_role, actor_user_id, source, metadata, created_at
  ) VALUES (
    'chg_' || pg_catalog.gen_random_uuid()::text,
    'content_publish', p_actor_role, p_actor_user_id, 'publish_content_release',
    pg_catalog.jsonb_build_object(
      'release_id', v_release_id,
      'previous_release_id', v_prev,
      'import_batch_id', p_import_batch_id,
      'source_binding_hash', v_source_hash
    ),
    now()
  );

  release_id := v_release_id;
  release_seq := v_seq;
  announcement_id := v_ann;
  source_binding_hash := v_source_hash;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION rollback_content_release(
  p_target_release_id TEXT,
  p_title TEXT,
  p_summary TEXT,
  p_actor_user_id TEXT,
  p_actor_role TEXT
) RETURNS TABLE(
  release_id TEXT,
  release_seq BIGINT,
  announcement_id TEXT,
  rollback_of_release_id TEXT,
  source_binding_hash TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_got BOOLEAN;
  v_current TEXT;
  v_release_id TEXT;
  v_seq BIGINT;
  v_ann TEXT;
  v_source_hash TEXT;
  v_stored_source_hash TEXT;
  v_source_count INT;
  v_source_noncanonical BOOLEAN;
  v_source_suspended BOOLEAN;
  v_tenant TEXT;
BEGIN
  IF p_actor_role IS DISTINCT FROM 'owner'
     OR p_actor_user_id IS NULL OR pg_catalog.btrim(p_actor_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'phase1 rollback requires owner', DETAIL = 'FORBIDDEN';
  END IF;
  IF p_target_release_id IS NULL OR pg_catalog.btrim(p_target_release_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'target_release_id is required', DETAIL = 'VALIDATION';
  END IF;

  v_got := pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('cs_ai_content_publish'));
  IF NOT v_got THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'publish single-flight lock not acquired', DETAIL = 'CONFLICT';
  END IF;
  PERFORM pg_catalog.set_config('app.publishing', 'on', true);

  IF NOT EXISTS (
    SELECT 1 FROM public.content_releases cr WHERE cr.release_id = p_target_release_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA002', MESSAGE = 'target release does not exist', DETAIL = 'NOT_FOUND';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.release_items ri WHERE ri.release_id = p_target_release_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA002', MESSAGE = 'target release snapshot is empty', DETAIL = 'NOT_FOUND';
  END IF;

  SELECT target.tenant_id INTO v_tenant FROM public.content_releases target WHERE target.release_id = p_target_release_id;
  IF NOT public.owner_acceptance_release_content_ready(p_target_release_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'rollback acceptance is not active or complete', DETAIL = 'OWNER_ACCEPTANCE_NOT_ACTIVE';
  END IF;

  SELECT
    pg_catalog.count(*)::INT,
    pg_catalog.encode(public.digest(pg_catalog.convert_to(
      pg_catalog.string_agg(rsb.domain || ':' || rsb.source_version_id, '|' ORDER BY rsb.domain),
      'UTF8'
    ), 'sha256'), 'hex'),
    coalesce(pg_catalog.bool_or(asv.use_class <> 'canonical'), FALSE),
    coalesce(pg_catalog.bool_or(susp.source_version_id IS NOT NULL), FALSE),
    pg_catalog.max(cr.source_binding_hash)
  INTO v_source_count, v_source_hash, v_source_noncanonical, v_source_suspended, v_stored_source_hash
  FROM public.content_releases cr
  JOIN public.release_source_bindings rsb ON rsb.release_id = cr.release_id
  JOIN public.authoritative_source_versions asv
    ON asv.source_version_id = rsb.source_version_id AND asv.domain = rsb.domain
  LEFT JOIN public.authoritative_source_suspensions susp
    ON susp.source_version_id = rsb.source_version_id
  WHERE cr.release_id = p_target_release_id;
  IF v_source_count <> 4 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'rollback target has an incomplete source set', DETAIL = 'SOURCE_SET_INCOMPLETE';
  END IF;
  IF v_source_noncanonical THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'rollback target contains a reference-only source', DETAIL = 'SOURCE_NOT_ELIGIBLE';
  END IF;
  IF v_source_suspended THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'rollback target contains a suspended source', DETAIL = 'SOURCE_SUSPENDED';
  END IF;
  IF v_source_hash IS DISTINCT FROM v_stored_source_hash THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'rollback target source binding hash mismatch', DETAIL = 'SOURCE_BINDING_HASH_MISMATCH';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.release_items ri
    WHERE ri.release_id = p_target_release_id
      AND ri.review_mode <> 'owner_acceptance'
      AND ri.content_hash IS DISTINCT FROM public.content_governance_hash(
        ri.script_id, ri.category, ri.title, ri.answer_text, ri.source_ref, ri.source_version_id,
        ri.owner_role, ri.review_due_at, ri.platform_scope, ri.product_scope_type,
        ri.product_scope_refs, ri.effective_from, ri.effective_to,
        ri.intent_taxonomy_version, ri.intent_id, ri.risk_level, ri.risk_categories, ri.has_conflict,
        ri.review_mode, ri.primary_reviewer_id, ri.primary_reviewer_role, ri.primary_review_evd,
        ri.secondary_reviewer_id, ri.secondary_reviewer_role, ri.secondary_review_evd,
        ri.placeholder_keys, ri.questions_json
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'rollback target governance snapshot hash mismatch', DETAIL = 'GOVERNANCE_HASH_MISMATCH';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.release_items item
    WHERE item.release_id = p_target_release_id
      AND public.content_questions_source_assets_are_active(item.questions_json) IS DISTINCT FROM TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'rollback target uses retired semantic source asset', DETAIL = 'SEMANTIC_SOURCE_ASSET_NOT_ACTIVE';
  END IF;

  SELECT cc.current_release_id INTO v_current
  FROM public.content_current cc WHERE cc.id = 1 FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.content_releases current_release
      WHERE current_release.release_id = v_current AND current_release.tenant_id IS DISTINCT FROM v_tenant) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'rollback tenant binding mismatch', DETAIL = 'OWNER_ACCEPTANCE_NOT_ACTIVE';
  END IF;
  IF v_current IS NOT DISTINCT FROM p_target_release_id THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'target release is already current', DETAIL = 'CONFLICT';
  END IF;

  v_seq := pg_catalog.nextval('public.content_release_seq'::pg_catalog.regclass);
  v_release_id := 'rel_' || v_seq::text;
  v_ann := 'ann_' || v_seq::text;

  UPDATE public.content_releases SET status = 'superseded' WHERE status = 'published';
  INSERT INTO public.content_releases(
    release_id, release_seq, title, summary, import_batch_id, rollback_of_release_id,
    status, source_binding_hash, published_by, published_by_role, published_at, tenant_id
  ) VALUES (
    v_release_id,
    v_seq,
    COALESCE(NULLIF(p_title, ''), '回滚到 ' || p_target_release_id),
    p_summary,
    NULL,
    p_target_release_id,
    'published',
    v_source_hash,
    p_actor_user_id,
    p_actor_role,
    now(),
    v_tenant
  );

  INSERT INTO public.release_source_bindings(release_id, domain, source_version_id, created_at)
  SELECT v_release_id, rsb.domain, rsb.source_version_id, now()
  FROM public.release_source_bindings rsb
  WHERE rsb.release_id = p_target_release_id;

  INSERT INTO public.release_items(
    release_id, script_id, script_version, content_hash, answer_text, title, category,
    source_ref, source_version_id, owner_role, review_due_at,
    effective_from, effective_to, platform_scope, product_scope_type, product_scope_refs,
    intent_taxonomy_version, intent_id, risk_level, risk_categories, has_conflict, review_mode, owner_acceptance_record_sha256,
    primary_reviewer_id, primary_reviewer_role, primary_review_evd,
    secondary_reviewer_id, secondary_reviewer_role, secondary_review_evd,
    placeholder_keys, questions_json,
    search_document, search_fallback_text
  )
  SELECT
    v_release_id, ri.script_id, ri.script_version, ri.content_hash, ri.answer_text,
    ri.title, ri.category, ri.source_ref, ri.source_version_id, ri.owner_role, ri.review_due_at,
    ri.effective_from, ri.effective_to, ri.platform_scope, ri.product_scope_type, ri.product_scope_refs,
    ri.intent_taxonomy_version, ri.intent_id, ri.risk_level, ri.risk_categories, ri.has_conflict, ri.review_mode, ri.owner_acceptance_record_sha256,
    ri.primary_reviewer_id, ri.primary_reviewer_role, ri.primary_review_evd,
    ri.secondary_reviewer_id, ri.secondary_reviewer_role, ri.secondary_review_evd,
    ri.placeholder_keys,
    ri.questions_json, ri.search_document, ri.search_fallback_text
  FROM public.release_items ri
  WHERE ri.release_id = p_target_release_id;

  IF NOT public.owner_acceptance_release_content_ready(v_release_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'release acceptance is not active or complete', DETAIL = 'OWNER_ACCEPTANCE_NOT_ACTIVE';
  END IF;

  INSERT INTO public.content_current(id, current_release_id, updated_at)
  VALUES (1, v_release_id, now())
  ON CONFLICT (id) DO UPDATE
    SET current_release_id = EXCLUDED.current_release_id, updated_at = now();

  INSERT INTO public.announcements(announcement_id, release_id, title, summary, created_at)
  VALUES (
    v_ann,
    v_release_id,
    COALESCE(NULLIF(p_title, ''), '话术库已回滚'),
    p_summary,
    now()
  );

  INSERT INTO public.change_audits(
    change_id, action, actor_role, actor_user_id, source, metadata, created_at
  ) VALUES (
    'chg_' || pg_catalog.gen_random_uuid()::text,
    'content_rollback', p_actor_role, p_actor_user_id, 'rollback_content_release',
    pg_catalog.jsonb_build_object(
      'release_id', v_release_id,
      'previous_release_id', v_current,
      'rollback_of_release_id', p_target_release_id,
      'source_binding_hash', v_source_hash
    ),
    now()
  );

  release_id := v_release_id;
  release_seq := v_seq;
  announcement_id := v_ann;
  rollback_of_release_id := p_target_release_id;
  source_binding_hash := v_source_hash;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE VIEW v_release_source_gate AS
SELECT
  cr.release_id,
  cr.release_seq,
  cr.source_binding_hash,
  (
    owner_gate.ready AND stats.source_count = 4
    AND NOT stats.has_noncanonical
    AND NOT stats.has_suspension
    AND stats.computed_hash IS NOT DISTINCT FROM cr.source_binding_hash
  ) AS source_gate_ready,
  CASE
    WHEN NOT owner_gate.ready THEN 'OWNER_ACCEPTANCE_NOT_ACTIVE'
    WHEN stats.source_count <> 4 THEN 'SOURCE_SET_INCOMPLETE'
    WHEN stats.has_noncanonical THEN 'SOURCE_NOT_ELIGIBLE'
    WHEN stats.has_suspension THEN 'SOURCE_SUSPENDED'
    WHEN stats.computed_hash IS DISTINCT FROM cr.source_binding_hash THEN 'SOURCE_BINDING_HASH_MISMATCH'
    ELSE NULL
  END AS source_gate_reason,
  CASE
    WHEN owner_gate.ready AND stats.source_count = 4
      AND NOT stats.has_noncanonical
      AND NOT stats.has_suspension
      AND stats.computed_hash IS NOT DISTINCT FROM cr.source_binding_hash
    THEN NULL
    ELSE 'SOURCE_GATE_NOT_READY'
  END AS runtime_error_reason
FROM public.content_releases cr
-- OFFSET 0 keeps the volatile admission check single-evaluation per release;
-- the release-id filter can still reach content_releases before this lateral call.
CROSS JOIN LATERAL (SELECT public.owner_acceptance_release_ready(cr.release_id) AS ready OFFSET 0) owner_gate
CROSS JOIN LATERAL (
  SELECT
    pg_catalog.count(*)::INT AS source_count,
    coalesce(pg_catalog.bool_or(asv.use_class <> 'canonical'), FALSE) AS has_noncanonical,
    coalesce(pg_catalog.bool_or(susp.source_version_id IS NOT NULL), FALSE) AS has_suspension,
    pg_catalog.encode(public.digest(pg_catalog.convert_to(
      pg_catalog.string_agg(rsb.domain || ':' || rsb.source_version_id, '|' ORDER BY rsb.domain),
      'UTF8'
    ), 'sha256'), 'hex') AS computed_hash
  FROM public.release_source_bindings rsb
  JOIN public.authoritative_source_versions asv
    ON asv.source_version_id = rsb.source_version_id AND asv.domain = rsb.domain
  LEFT JOIN public.authoritative_source_suspensions susp
    ON susp.source_version_id = rsb.source_version_id
  WHERE rsb.release_id = cr.release_id
) stats;

CREATE OR REPLACE FUNCTION issue_snapshot_offline_lease(
  p_client_id TEXT,
  p_user_id TEXT,
  p_ttl_seconds INTEGER DEFAULT 600
) RETURNS TABLE(
  offline_lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  release_id TEXT,
  source_binding_hash TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_got BOOLEAN;
  v_release_id TEXT;
  v_source_binding_hash TEXT;
  v_issued_at TIMESTAMPTZ;
  v_token_hash TEXT;
  v_acceptance_deadline TIMESTAMPTZ;
BEGIN
  IF p_client_id IS NULL OR pg_catalog.btrim(p_client_id) = ''
     OR p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = ''
     OR p_ttl_seconds IS NULL OR p_ttl_seconds < 60 OR p_ttl_seconds > 900 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'client, user and 60..900 second lease ttl are required', DETAIL = 'VALIDATION';
  END IF;

  v_got := pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('cs_ai_content_publish'));
  IF NOT v_got THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'snapshot lease source lock not acquired', DETAIL = 'CONFLICT';
  END IF;
  SELECT cc.current_release_id, gate.source_binding_hash
  INTO v_release_id, v_source_binding_hash
  FROM public.content_current cc
  JOIN public.v_release_source_gate gate
    ON gate.release_id = cc.current_release_id
   AND gate.source_gate_ready
  WHERE cc.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'current source set is not ready for offline use', DETAIL = 'SOURCE_GATE_NOT_READY';
  END IF;

  v_issued_at := pg_catalog.clock_timestamp();
  offline_lease_token := 'osl_' || pg_catalog.encode(public.gen_random_bytes(32), 'hex');
  -- Offline consumers cannot recheck a revoked record while disconnected; the
  -- issued lease must at least never outlive the known acceptance deadline.
  -- Its online use still revalidates current acceptance on every page/ACK.
  SELECT min(public.owner_acceptance_instant(accepted.record -> 'expires_at'))
    INTO v_acceptance_deadline
    FROM public.release_items item
    JOIN public.content_releases release ON release.release_id = item.release_id
    JOIN public.owner_acceptance_records accepted
      ON accepted.tenant_id = release.tenant_id AND accepted.record_sha256 = item.owner_acceptance_record_sha256
    WHERE item.release_id = v_release_id AND item.review_mode = 'owner_acceptance';
  lease_expires_at := least(v_issued_at + pg_catalog.make_interval(secs => p_ttl_seconds),v_acceptance_deadline);
  IF lease_expires_at <= v_issued_at THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'current acceptance expired during lease issuance', DETAIL = 'SOURCE_GATE_NOT_READY';
  END IF;
  release_id := v_release_id;
  source_binding_hash := v_source_binding_hash;
  v_token_hash := pg_catalog.encode(public.digest(
    pg_catalog.convert_to(offline_lease_token, 'UTF8'), 'sha256'
  ), 'hex');

  INSERT INTO public.snapshot_offline_leases(
    lease_token_hash, client_id, user_id, release_id, source_binding_hash,
    issued_at, expires_at, created_at
  ) VALUES (
    v_token_hash, p_client_id, p_user_id, v_release_id, v_source_binding_hash,
    v_issued_at, lease_expires_at, v_issued_at
  );
  RETURN NEXT;
END;
$$;
COMMIT;
