-- A2b-2 ADDITIVE CANDIDATE: apply after owner-acceptance.content-hash.v1.
-- Internal consumption check only; existing storage/publish gates are unchanged.
BEGIN;

-- Caller owns business validation and must construct snapshots from the actual
-- candidate via content_governance_snapshot, never from the approved record.
-- Source IDs are the independently selected package inputs, including empty domains.
-- Call in the consuming READ COMMITTED transaction: source/revocation fences from
-- assert_owner_acceptance remain held until that transaction ends.
CREATE FUNCTION public.assert_owner_acceptance_content(
  p_tenant TEXT, p_record_sha256 TEXT, p_expected_owner_hash TEXT,
  p_source_version_ids TEXT[], p_content JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_sources JSONB; v_source_map JSONB; v_items JSONB; v_entry JSONB;
  v_snapshot JSONB; v_version INTEGER; v_evidence TEXT;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_ISOLATION_DENIED';
  END IF;
  IF p_source_version_ids IS NULL OR cardinality(p_source_version_ids) <> 4
     OR (SELECT count(DISTINCT id) FROM unnest(p_source_version_ids) id) <> 4
     OR p_content IS NULL OR jsonb_typeof(p_content) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_CONTENT_INVALID';
  END IF;
  IF jsonb_array_length(p_content) NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_CONTENT_INVALID';
  END IF;
  -- Read immutable source identities once. The existing assertion below checks
  -- readiness under its shared source fence, including concurrent suspensions.
  SELECT jsonb_agg(jsonb_build_object('domain',s.domain,'source_version_id',s.source_version_id,
      'snapshot_sha256',s.snapshot_sha256,'review_due_at',
      to_char(s.review_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY s.domain COLLATE "C"),
    jsonb_object_agg(s.source_version_id,jsonb_build_object('domain',s.domain,'source_ref',s.source_ref))
    INTO v_sources,v_source_map
    FROM public.authoritative_source_versions s
    WHERE s.tenant_id = p_tenant AND s.source_version_id = ANY(p_source_version_ids);
  IF v_sources IS NULL OR jsonb_array_length(v_sources) <> 4 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_NOT_ACTIVE';
  END IF;
  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_content) LOOP
    IF NOT public.owner_acceptance_keys(v_entry,ARRAY['script_version','snapshot','content_hash'])
       OR jsonb_typeof(v_entry -> 'script_version') IS DISTINCT FROM 'number'
       OR (v_entry ->> 'script_version') !~ '^[1-9][0-9]{0,9}$' THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_CONTENT_INVALID';
    END IF;
    IF (v_entry ->> 'script_version')::bigint > 2147483647 THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_CONTENT_INVALID';
    END IF;
    v_version := (v_entry ->> 'script_version')::integer;
    v_snapshot := v_entry -> 'snapshot';
    IF v_entry -> 'content_hash' IS DISTINCT FROM to_jsonb(public.owner_acceptance_content_hash(
         v_snapshot,v_version,p_record_sha256))
       OR jsonb_typeof(v_snapshot -> 'source_version_id') IS DISTINCT FROM 'string'
       OR NOT (v_source_map ? (v_snapshot ->> 'source_version_id'))
       OR v_snapshot -> 'category' IS DISTINCT FROM v_source_map #> ARRAY[v_snapshot ->> 'source_version_id','domain']
       OR v_snapshot -> 'source_ref' IS DISTINCT FROM v_source_map #> ARRAY[v_snapshot ->> 'source_version_id','source_ref'] THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_CONTENT_MISMATCH';
    END IF;
  END LOOP;
  SELECT jsonb_agg(jsonb_build_object(
    'script_id',e #> '{snapshot,script_id}','script_version',e -> 'script_version',
    'domain',e #> '{snapshot,category}','source_version_id',e #> '{snapshot,source_version_id}',
    'review_input_sha256',public.owner_acceptance_review_input_sha256(e -> 'snapshot',(e ->> 'script_version')::integer),
    'risk_level',e #> '{snapshot,risk_level}','risk_categories',e #> '{snapshot,risk_categories}',
    'has_conflict',e #> '{snapshot,has_conflict}') ORDER BY (e #>> '{snapshot,script_id}') COLLATE "C")
    INTO v_items FROM jsonb_array_elements(p_content) e;
  PERFORM public.assert_owner_acceptance(p_tenant,p_record_sha256,p_expected_owner_hash,
    'g1a_offline_only',jsonb_build_object('source_bindings',v_sources,'items',v_items));
  -- Review metadata is intentionally excluded from review-input identity, so bind
  -- it explicitly to the trusted owner and the immutable registered evidence.
  SELECT record ->> 'approval_evidence_id' INTO v_evidence FROM public.owner_acceptance_records
    WHERE tenant_id = p_tenant AND record_sha256 = p_record_sha256;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_content) e
    WHERE e #> '{snapshot,primary_reviewer_id}' IS DISTINCT FROM to_jsonb(p_expected_owner_hash)
       OR e #> '{snapshot,primary_review_evd}' IS DISTINCT FROM to_jsonb(v_evidence)) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_CONTENT_MISMATCH';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.assert_owner_acceptance_content(TEXT,TEXT,TEXT,TEXT[],JSONB) FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO cs_ai_definer;
ALTER FUNCTION public.assert_owner_acceptance_content(TEXT,TEXT,TEXT,TEXT[],JSONB) OWNER TO cs_ai_definer;
REVOKE CREATE ON SCHEMA public FROM cs_ai_definer;
COMMENT ON FUNCTION public.assert_owner_acceptance_content(TEXT,TEXT,TEXT,TEXT[],JSONB) IS
  'Private exact candidate/registered scope check; actual normalized input required; same-transaction use only; no runtime activation.';
COMMIT;
