-- A2b-1 ADDITIVE CANDIDATE: apply after v1.14 and owner-acceptance.registry.v1.
-- Deterministic identity only. This function does not prove approval, registration,
-- current scope, source readiness, expiry or revocation; consumers must check those
-- independently in their transaction before storing or publishing any content.
BEGIN;

-- p_snapshot must be produced from the actual candidate by the existing
-- content_governance_snapshot AFTER business validation. No caller-supplied digest.
-- The record binds the review-input hash; this final hash binds the record and the
-- final review metadata. Keeping these preimages separate avoids circular hashes.
CREATE FUNCTION public.owner_acceptance_content_hash(
  p_snapshot JSONB, p_script_version INTEGER, p_record_sha256 TEXT
) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
     OR p_script_version IS NULL OR p_script_version < 1
     OR p_record_sha256 IS NULL OR p_record_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_CONTENT_HASH_INVALID';
  END IF;
  -- Reuse the closed snapshot key contract; an upstream field addition must fail
  -- until both review-input and final-content preimages have been reviewed.
  PERFORM public.owner_acceptance_review_input_sha256(p_snapshot, p_script_version);
  IF p_snapshot -> 'review_mode' IS DISTINCT FROM '"owner_acceptance"'::jsonb
     OR p_snapshot -> 'has_conflict' IS DISTINCT FROM 'false'::jsonb
     OR jsonb_typeof(p_snapshot -> 'primary_reviewer_id') IS DISTINCT FROM 'string'
     OR (p_snapshot ->> 'primary_reviewer_id') !~ '^[0-9a-f]{64}$'
     OR p_snapshot -> 'primary_reviewer_role' IS DISTINCT FROM '"ROLE-CONTENT-LEAD"'::jsonb
     OR jsonb_typeof(p_snapshot -> 'primary_review_evd') IS DISTINCT FROM 'string'
     OR (p_snapshot ->> 'primary_review_evd') !~ '^EVD-[A-Z0-9-]{6,127}$'
     OR p_snapshot -> 'secondary_reviewer_id' IS DISTINCT FROM 'null'::jsonb
     OR p_snapshot -> 'secondary_reviewer_role' IS DISTINCT FROM 'null'::jsonb
     OR p_snapshot -> 'secondary_review_evd' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_CONTENT_HASH_INVALID';
  END IF;
  RETURN encode(public.digest(convert_to(public.jsonb_jcs(jsonb_build_object(
    'hash_version', 'customer-agent/owner-acceptance-content/v1',
    'script_version', p_script_version,
    'owner_acceptance_record_sha256', p_record_sha256,
    'content', p_snapshot
  )), 'UTF8'), 'sha256'), 'hex');
END;
$$;

REVOKE ALL ON FUNCTION public.owner_acceptance_content_hash(JSONB,INTEGER,TEXT) FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO cs_ai_definer;
ALTER FUNCTION public.owner_acceptance_content_hash(JSONB,INTEGER,TEXT) OWNER TO cs_ai_definer;
REVOKE CREATE ON SCHEMA public FROM cs_ai_definer;
COMMENT ON FUNCTION public.owner_acceptance_content_hash(JSONB,INTEGER,TEXT) IS
  'Versioned final content identity, not approval or activation; normalized actual content required, no application grant.';
COMMIT;
