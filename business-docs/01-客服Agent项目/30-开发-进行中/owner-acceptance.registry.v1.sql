-- owner-acceptance.registry.v1: ADDITIVE LOCAL CANDIDATE, NOT RUNTIME ACTIVATION.
-- Apply only after schema.v1.14 in an isolated synthetic PostgreSQL 15 database.
-- No existing review CHECK, hash, publish, rollback, current or runtime grant changes.
-- Registration trusts a separately provisioned capability, never a payload role claim.
BEGIN;
DO $install$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper)
     OR pg_catalog.to_regclass('public.authoritative_source_versions') IS NULL
     OR pg_catalog.to_regprocedure('public.jsonb_jcs(jsonb)') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'OWNER_ACCEPTANCE_INSTALL_DENIED';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_owner_acceptance_registrar') THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'OWNER_ACCEPTANCE_ROLE_ALREADY_EXISTS';
  END IF;
  CREATE ROLE app_owner_acceptance_registrar NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END
$install$;

CREATE TABLE public.owner_acceptance_records (
  tenant_id TEXT NOT NULL CHECK (tenant_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  record_sha256 TEXT NOT NULL CHECK (record_sha256 ~ '^[0-9a-f]{64}$'),
  owner_subject_hash TEXT NOT NULL CHECK (owner_subject_hash ~ '^[0-9a-f]{64}$'),
  record JSONB NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, record_sha256)
);
CREATE TABLE public.owner_acceptance_revocations (
  tenant_id TEXT NOT NULL,
  record_sha256 TEXT NOT NULL,
  evidence_id TEXT NOT NULL CHECK (evidence_id ~ '^EVD-[A-Z0-9-]{6,127}$'),
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, record_sha256),
  FOREIGN KEY (tenant_id, record_sha256) REFERENCES public.owner_acceptance_records
);

CREATE FUNCTION public.owner_acceptance_immutable() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'OWNER_ACCEPTANCE_IMMUTABLE';
END;
$$;
CREATE TRIGGER owner_acceptance_records_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON public.owner_acceptance_records FOR EACH STATEMENT EXECUTE FUNCTION public.owner_acceptance_immutable();
CREATE TRIGGER owner_acceptance_revocations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON public.owner_acceptance_revocations FOR EACH STATEMENT EXECUTE FUNCTION public.owner_acceptance_immutable();

-- Closed JSON shapes mirror owner-acceptance.v1.schema.json at the DB trust boundary.
-- Differential synthetic tests must accompany any schema evolution.
CREATE FUNCTION public.owner_acceptance_keys(p_value JSONB, p_keys TEXT[]) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(p_value) = 'object'
    THEN p_value ?& p_keys AND p_value - p_keys = '{}'::jsonb ELSE FALSE END
$$;
-- Input MUST be the normalized output of content_governance_snapshot, derived from
-- actual candidate content. Removing only review metadata avoids a circular hash.
-- Closed key set deliberately fails if the upstream snapshot gains business fields.
CREATE FUNCTION public.owner_acceptance_review_input_sha256(p_snapshot JSONB, p_script_version INTEGER)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_script_version IS NULL OR p_script_version < 1
     OR NOT public.owner_acceptance_keys(p_snapshot, ARRAY[
       'answer_text','category','effective_from','effective_to','has_conflict','intent_id',
       'intent_taxonomy_version','owner_role','placeholder_keys','platform_scope',
       'primary_reviewer_id','primary_reviewer_role','primary_review_evd','product_scope_refs',
       'product_scope_type','questions','review_due_at','review_mode','risk_categories',
       'risk_level','script_id','secondary_reviewer_id','secondary_reviewer_role',
       'secondary_review_evd','source_ref','source_version_id','title'
     ]) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_INPUT_INVALID';
  END IF;
  RETURN encode(public.digest(convert_to(public.jsonb_jcs(
    (p_snapshot - ARRAY['review_mode','primary_reviewer_id','primary_reviewer_role','primary_review_evd',
      'secondary_reviewer_id','secondary_reviewer_role','secondary_review_evd'])
    || jsonb_build_object('projection_version','customer-agent/owner-acceptance-input/v1','script_version',p_script_version)
  ), 'UTF8'), 'sha256'), 'hex');
END;
$$;
CREATE FUNCTION public.owner_acceptance_instant(p_value JSONB) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_text TEXT := p_value #>> '{}'; v_time TIMESTAMPTZ;
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'string'
     OR v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_TIME_INVALID';
  END IF;
  v_time := v_text::timestamptz;
  IF to_char(v_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> v_text THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_TIME_INVALID';
  END IF;
  RETURN v_time;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
  RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_TIME_INVALID';
END;
$$;
CREATE FUNCTION public.owner_acceptance_validate_record(p_record JSONB) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_scope JSONB := p_record -> 'scope'; v_binding JSONB; v_item JSONB;
  v_prev TEXT := ''; v_risk JSONB; v_previous_risk TEXT;
  v_domains TEXT[] := ARRAY[]::text[]; v_versions TEXT[] := ARRAY[]::text[];
  v_accepted TIMESTAMPTZ; v_expires TIMESTAMPTZ;
BEGIN
  IF NOT public.owner_acceptance_keys(p_record, ARRAY['schema','review_mode','purpose','owner_subject_hash','approval_evidence_id','accepted_at','expires_at','scope'])
     OR p_record -> 'schema' IS DISTINCT FROM '"customer-agent/owner-acceptance/v1"'::jsonb
     OR p_record -> 'review_mode' IS DISTINCT FROM '"owner_acceptance"'::jsonb
     OR p_record -> 'purpose' IS DISTINCT FROM '"g1a_offline_only"'::jsonb
     OR jsonb_typeof(p_record -> 'owner_subject_hash') IS DISTINCT FROM 'string'
     OR (p_record ->> 'owner_subject_hash') !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(p_record -> 'approval_evidence_id') IS DISTINCT FROM 'string'
     OR (p_record ->> 'approval_evidence_id') !~ '^EVD-[A-Z0-9-]{6,127}$'
     OR NOT public.owner_acceptance_keys(v_scope, ARRAY['source_bindings','items'])
     OR jsonb_typeof(v_scope -> 'source_bindings') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_scope -> 'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_RECORD_INVALID';
  END IF;
  IF jsonb_array_length(v_scope -> 'source_bindings') <> 4
     OR jsonb_array_length(v_scope -> 'items') NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_SCOPE_INVALID';
  END IF;
  v_accepted := public.owner_acceptance_instant(p_record -> 'accepted_at');
  v_expires := public.owner_acceptance_instant(p_record -> 'expires_at');
  IF v_accepted >= v_expires THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_TIME_INVALID';
  END IF;
  FOR v_binding IN SELECT value FROM jsonb_array_elements(v_scope -> 'source_bindings') LOOP
    IF NOT public.owner_acceptance_keys(v_binding, ARRAY['domain','source_version_id','snapshot_sha256','review_due_at'])
       OR (v_binding ->> 'domain') NOT IN ('aftersale','campaign','presale','product')
       OR jsonb_typeof(v_binding -> 'domain') IS DISTINCT FROM 'string'
       OR (v_binding ->> 'domain') COLLATE "C" <= v_prev COLLATE "C"
       OR jsonb_typeof(v_binding -> 'source_version_id') IS DISTINCT FROM 'string'
       OR (v_binding ->> 'source_version_id') !~ '^srcv_[A-Za-z0-9][A-Za-z0-9._-]{7,126}$'
       OR (v_binding ->> 'source_version_id') = ANY(v_versions)
       OR jsonb_typeof(v_binding -> 'snapshot_sha256') IS DISTINCT FROM 'string'
       OR (v_binding ->> 'snapshot_sha256') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_SCOPE_INVALID';
    END IF;
    IF v_expires > public.owner_acceptance_instant(v_binding -> 'review_due_at') THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_TIME_INVALID';
    END IF;
    v_prev := v_binding ->> 'domain';
    v_domains := array_append(v_domains, v_prev);
    v_versions := array_append(v_versions, v_binding ->> 'source_version_id');
  END LOOP;
  v_prev := '';
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_scope -> 'items') LOOP
    IF NOT public.owner_acceptance_keys(v_item, ARRAY['script_id','script_version','domain','source_version_id','review_input_sha256','risk_level','risk_categories','has_conflict'])
       OR jsonb_typeof(v_item -> 'script_id') IS DISTINCT FROM 'string'
       OR (v_item ->> 'script_id') !~ '^[a-z][a-z0-9_-]{7,127}$'
       OR (v_item ->> 'script_id') COLLATE "C" <= v_prev COLLATE "C"
       OR jsonb_typeof(v_item -> 'script_version') IS DISTINCT FROM 'number'
       OR (v_item ->> 'script_version') !~ '^[1-9][0-9]{0,9}$'
       OR jsonb_typeof(v_item -> 'domain') IS DISTINCT FROM 'string'
       OR array_position(v_domains, v_item ->> 'domain') IS NULL
       OR v_item -> 'source_version_id' IS DISTINCT FROM to_jsonb(v_versions[array_position(v_domains, v_item ->> 'domain')])
       OR jsonb_typeof(v_item -> 'review_input_sha256') IS DISTINCT FROM 'string'
       OR (v_item ->> 'review_input_sha256') !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(v_item -> 'risk_level') IS DISTINCT FROM 'string'
       OR (v_item ->> 'risk_level') NOT IN ('low','medium','high')
       OR jsonb_typeof(v_item -> 'risk_categories') IS DISTINCT FROM 'array'
       OR v_item -> 'has_conflict' IS DISTINCT FROM 'false'::jsonb THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_SCOPE_INVALID';
    END IF;
    IF (v_item ->> 'script_version')::bigint > 2147483647
       OR jsonb_array_length(v_item -> 'risk_categories') > 7
       OR ((v_item ->> 'risk_level') = 'high') <> (jsonb_array_length(v_item -> 'risk_categories') > 0) THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_RISK_INVALID';
    END IF;
    v_previous_risk := '';
    FOR v_risk IN SELECT value FROM jsonb_array_elements(v_item -> 'risk_categories') LOOP
      IF jsonb_typeof(v_risk) IS DISTINCT FROM 'string'
         OR (v_risk #>> '{}') NOT IN ('refund_compensation','price_discount','campaign_rules','efficacy_safety_claim','account_privacy','complaint_escalation','legal_commitment')
         OR (v_risk #>> '{}') COLLATE "C" <= v_previous_risk COLLATE "C" THEN
        RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_RISK_INVALID';
      END IF;
      v_previous_risk := v_risk #>> '{}';
    END LOOP;
    v_prev := v_item ->> 'script_id';
  END LOOP;
END;
$$;

-- Recheck authoritative DB facts every time, not merely the self-reported record.
CREATE FUNCTION public.owner_acceptance_sources_ready(p_tenant TEXT, p_record JSONB) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT count(*) = 4 FROM jsonb_array_elements(p_record #> '{scope,source_bindings}') b
  JOIN public.authoritative_source_versions s ON s.source_version_id = b ->> 'source_version_id'
    AND s.tenant_id = p_tenant AND s.domain = b ->> 'domain'
    AND s.snapshot_sha256 = b ->> 'snapshot_sha256' AND s.use_class = 'canonical'
    AND s.approved_at <= statement_timestamp()
    AND s.review_due_at = public.owner_acceptance_instant(b -> 'review_due_at')
    AND s.review_due_at > statement_timestamp()
  WHERE NOT EXISTS (SELECT 1 FROM public.authoritative_source_suspensions x WHERE x.source_version_id = s.source_version_id)
$$;

CREATE FUNCTION public.register_owner_acceptance(
  p_tenant TEXT, p_raw_record TEXT, p_approved_sha256 TEXT, p_expected_owner_hash TEXT
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_record JSONB; v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_ISOLATION_DENIED';
  END IF;
  IF p_tenant IS NULL OR p_tenant !~ '^[a-zA-Z0-9_-]{1,128}$'
     OR p_approved_sha256 IS NULL OR p_approved_sha256 !~ '^[0-9a-f]{64}$'
     OR p_expected_owner_hash IS NULL OR p_expected_owner_hash !~ '^[0-9a-f]{64}$'
     OR p_raw_record IS NULL OR octet_length(p_raw_record) > 2097152 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_RECORD_INVALID';
  END IF;
  IF encode(public.digest(convert_to(p_raw_record, 'UTF8'), 'sha256'), 'hex') <> p_approved_sha256 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_ANCHOR_MISMATCH';
  END IF;
  BEGIN
    v_record := p_raw_record::jsonb;
    PERFORM public.owner_acceptance_validate_record(v_record);
    IF public.jsonb_jcs(v_record) || E'\n' <> p_raw_record THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_RECORD_INVALID';
    END IF;
  EXCEPTION WHEN invalid_text_representation OR untranslatable_character OR character_not_in_repertoire THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_RECORD_INVALID';
  END;
  IF v_record ->> 'owner_subject_hash' <> p_expected_owner_hash THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_OWNER_MISMATCH';
  END IF;
  -- Match the existing source-suspension fence first; keep one global lock order.
  PERFORM pg_advisory_xact_lock_shared(hashtext('cs_ai_content_publish'));
  -- Exclusive advisory lock serializes registration/revocation against bound uses.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant || ':' || p_approved_sha256, 0));
  IF public.owner_acceptance_instant(v_record -> 'accepted_at') > v_now
     OR public.owner_acceptance_instant(v_record -> 'expires_at') <= clock_timestamp()
     OR NOT public.owner_acceptance_sources_ready(p_tenant, v_record)
     OR EXISTS (SELECT 1 FROM public.owner_acceptance_revocations WHERE tenant_id = p_tenant AND record_sha256 = p_approved_sha256) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_NOT_ACTIVE';
  END IF;
  INSERT INTO public.owner_acceptance_records(tenant_id, record_sha256, owner_subject_hash, record)
    VALUES(p_tenant, p_approved_sha256, p_expected_owner_hash, v_record) ON CONFLICT DO NOTHING;
  RETURN p_approved_sha256;
END;
$$;

CREATE FUNCTION public.revoke_owner_acceptance(p_tenant TEXT, p_sha256 TEXT, p_evidence TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_ISOLATION_DENIED';
  END IF;
  IF p_tenant IS NULL OR p_tenant !~ '^[a-zA-Z0-9_-]{1,128}$'
     OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$'
     OR p_evidence IS NULL OR p_evidence !~ '^EVD-[A-Z0-9-]{6,127}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_RECORD_INVALID';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant || ':' || p_sha256, 0));
  IF NOT EXISTS (SELECT 1 FROM public.owner_acceptance_records WHERE tenant_id = p_tenant AND record_sha256 = p_sha256) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA002', MESSAGE = 'OWNER_ACCEPTANCE_NOT_FOUND';
  END IF;
  INSERT INTO public.owner_acceptance_revocations(tenant_id, record_sha256, evidence_id)
    VALUES(p_tenant, p_sha256, p_evidence) ON CONFLICT DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public.owner_acceptance_revocations WHERE tenant_id = p_tenant
      AND record_sha256 = p_sha256 AND evidence_id = p_evidence) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'OWNER_ACCEPTANCE_REVOCATION_CONFLICT';
  END IF;
END;
$$;

-- Caller must independently derive p_observed_scope from the exact candidate. This
-- internal primitive has NO app role grant and is not itself a loader/publish gate.
-- Invoke inside the consuming transaction; shared lock lasts until transaction end.
CREATE FUNCTION public.assert_owner_acceptance(
  p_tenant TEXT, p_sha256 TEXT, p_owner_hash TEXT, p_purpose TEXT, p_observed_scope JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_record JSONB;
BEGIN
  -- Repeatable-read snapshots could miss a revocation committed before our lock.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_ISOLATION_DENIED';
  END IF;
  IF p_tenant IS NULL OR p_tenant !~ '^[a-zA-Z0-9_-]{1,128}$'
     OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$'
     OR p_owner_hash IS NULL OR p_owner_hash !~ '^[0-9a-f]{64}$'
     OR p_purpose IS DISTINCT FROM 'g1a_offline_only' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_NOT_ACTIVE';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtext('cs_ai_content_publish'));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_tenant || ':' || p_sha256, 0));
  SELECT record INTO v_record FROM public.owner_acceptance_records
    WHERE tenant_id = p_tenant AND record_sha256 = p_sha256 AND owner_subject_hash = p_owner_hash;
  IF NOT FOUND OR v_record -> 'scope' IS DISTINCT FROM p_observed_scope
     OR public.owner_acceptance_instant(v_record -> 'accepted_at') > clock_timestamp()
     OR public.owner_acceptance_instant(v_record -> 'expires_at') <= clock_timestamp()
     OR NOT public.owner_acceptance_sources_ready(p_tenant, v_record)
     OR EXISTS (SELECT 1 FROM public.owner_acceptance_revocations WHERE tenant_id = p_tenant AND record_sha256 = p_sha256) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_NOT_ACTIVE';
  END IF;
END;
$$;

REVOKE ALL ON public.owner_acceptance_records, public.owner_acceptance_revocations
  FROM PUBLIC, app_runtime, app_content_admin, app_import_worker, app_work_order_worker, app_owner_acceptance_registrar;
REVOKE ALL ON FUNCTION public.owner_acceptance_immutable(), public.owner_acceptance_keys(JSONB,TEXT[]),
  public.owner_acceptance_review_input_sha256(JSONB,INTEGER),
  public.owner_acceptance_instant(JSONB), public.owner_acceptance_validate_record(JSONB),
  public.owner_acceptance_sources_ready(TEXT,JSONB), public.register_owner_acceptance(TEXT,TEXT,TEXT,TEXT),
  public.revoke_owner_acceptance(TEXT,TEXT,TEXT), public.assert_owner_acceptance(TEXT,TEXT,TEXT,TEXT,JSONB) FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO cs_ai_definer;
ALTER FUNCTION public.owner_acceptance_immutable() OWNER TO cs_ai_definer;
ALTER FUNCTION public.owner_acceptance_keys(JSONB,TEXT[]) OWNER TO cs_ai_definer;
ALTER FUNCTION public.owner_acceptance_review_input_sha256(JSONB,INTEGER) OWNER TO cs_ai_definer;
ALTER FUNCTION public.owner_acceptance_instant(JSONB) OWNER TO cs_ai_definer;
ALTER FUNCTION public.owner_acceptance_validate_record(JSONB) OWNER TO cs_ai_definer;
ALTER FUNCTION public.owner_acceptance_sources_ready(TEXT,JSONB) OWNER TO cs_ai_definer;
ALTER FUNCTION public.register_owner_acceptance(TEXT,TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.revoke_owner_acceptance(TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.assert_owner_acceptance(TEXT,TEXT,TEXT,TEXT,JSONB) OWNER TO cs_ai_definer;
REVOKE CREATE ON SCHEMA public FROM cs_ai_definer;
GRANT SELECT, INSERT ON public.owner_acceptance_records, public.owner_acceptance_revocations TO cs_ai_definer;
GRANT USAGE ON SCHEMA public TO app_owner_acceptance_registrar;
GRANT EXECUTE ON FUNCTION public.register_owner_acceptance(TEXT,TEXT,TEXT,TEXT),
  public.revoke_owner_acceptance(TEXT,TEXT,TEXT) TO app_owner_acceptance_registrar;
COMMENT ON TABLE public.owner_acceptance_records IS
  'Offline metadata registry candidate only; no existing SQL or runtime gate consumes this table yet.';
COMMIT;
