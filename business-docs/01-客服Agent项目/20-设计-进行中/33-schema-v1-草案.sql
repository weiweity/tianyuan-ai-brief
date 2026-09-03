-- schema.v1.13 — 客服 Agent 一期 · PostgreSQL SoR (Architecture SSOT 37 / CR-004 / DEC-042 search-runtime projection closure)
-- Dialect: PostgreSQL 15+
-- Client cache (optional SQLite FTS snapshot) is NOT this file — see 33b note in 37 §2.
-- Phase1 invariants enforced where CHECK can express them. Business work-order analysis
-- uses work_order_*; internal script-improvement work uses iteration_task*; the domains never share raw rows.
-- Phase1 runtime facts are query/impression/adoption-terminal plus auxiliary escalation actions only.
-- CLEAN-INSTALL REFERENCE DDL ONLY. Do not run this file as an in-place production upgrade;
-- 46 §6 requires immutable expand/backfill/validate/contract migrations derived from it.
-- Run a clean install as a privileged deployment owner in a dedicated database/schema. End-user RBAC is
-- authenticated by the API; actor parameters below are server-derived audit claims, not DB login proof.
-- Stable application SQLSTATE catalog (HTTP mapping lives in 39; callers must not parse message text):
-- ZA001 VALIDATION · ZA002 NOT_FOUND · ZA003 CONFLICT · ZA004 POLICY_DENIED ·
-- ZA005 FORBIDDEN/INV_BYPASS · ZA006 LEASE_LOST.

BEGIN;
SET LOCAL search_path = public, pg_catalog, pg_temp;

DO $install_preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = current_user AND rolsuper
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'clean-install reference DDL requires a PostgreSQL superuser; managed-service migrations must use the provider-specific 46 §6 path';
  END IF;
END
$install_preflight$;

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid if needed
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- fallback ILIKE/exact acceleration only; NOT the 2-gram primary index

-- Fail-closed DB roles. Login roles are provisioned by deployment tooling and granted membership;
-- this schema deliberately creates NOLOGIN group/owner roles and never embeds passwords.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'cs_ai_definer') THEN
    CREATE ROLE cs_ai_definer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_content_admin') THEN
    CREATE ROLE app_content_admin NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_import_worker') THEN
    CREATE ROLE app_import_worker NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_work_order_worker') THEN
    CREATE ROLE app_work_order_worker NOLOGIN;
  END IF;
END
$roles$;

DO $role_attribute_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname IN ('cs_ai_definer','app_runtime','app_content_admin','app_import_worker','app_work_order_worker')
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'capability roles must already be NOLOGIN/NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS; refuse to repurpose a privileged cluster role';
  END IF;
END
$role_attribute_preflight$;

ALTER ROLE cs_ai_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE app_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE app_content_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE app_import_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE app_work_order_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

DO $role_membership_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
    JOIN pg_catalog.pg_roles granted_role ON granted_role.oid = membership.roleid
    WHERE member_role.rolname IN ('cs_ai_definer','app_runtime','app_content_admin','app_import_worker','app_work_order_worker')
       OR granted_role.rolname IN ('cs_ai_definer','app_runtime','app_content_admin','app_import_worker','app_work_order_worker')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'capability roles must have no pre-existing inbound or outbound membership; install first, then bind login roles from an explicit deployment allowlist';
  END IF;
END
$role_membership_preflight$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM cs_ai_definer, app_runtime, app_content_admin, app_import_worker, app_work_order_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ─── Identity (minimal; OAuth ADR may extend) ───
CREATE TABLE IF NOT EXISTS app_users (
  user_id         TEXT PRIMARY KEY,
  feishu_open_id  TEXT UNIQUE,
  display_name    TEXT,
  role            TEXT NOT NULL CHECK (role IN ('agent','coach','owner','system')),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The notice body/version is an auditable product contract. A pilot-recorded search is accepted only
-- after the current authenticated user has accepted the one current notice version.
CREATE TABLE IF NOT EXISTS privacy_notices (
  notice_version   TEXT PRIMARY KEY,
  notice_text      TEXT NOT NULL CHECK (pg_catalog.btrim(notice_text) <> ''),
  content_hash     TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  status           TEXT NOT NULL CHECK (status IN ('draft','current','retired')),
  published_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT privacy_notice_publish_shape CHECK (
    (status = 'draft' AND published_at IS NULL)
    OR (status IN ('current','retired') AND published_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_privacy_notice_current
  ON privacy_notices(status) WHERE status = 'current';

-- One explicit decision per user/version. A changed decision requires a new notice version; the row is
-- append-only to app_runtime because it is the evidence that unlocked pilot_recorded collection.
CREATE TABLE IF NOT EXISTS notice_decisions (
  notice_version   TEXT NOT NULL REFERENCES privacy_notices(notice_version),
  user_id          TEXT NOT NULL,
  decision         TEXT NOT NULL CHECK (decision IN ('accepted','declined')),
  decision_source  TEXT NOT NULL DEFAULT 'first_run_prompt' CHECK (
    decision_source IN ('first_run_prompt','settings')
  ),
  decided_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notice_version, user_id)
);

-- CR-004 authoritative-source registry. A row is one approved, content-addressed source version;
-- "current" is deliberately NOT stored here. The only current canonical set is derived from
-- content_current -> content_releases -> release_source_bindings, so registry and runtime cannot drift.
-- source_ref is a safe public alias only. Internal URLs, tokens and object-store locators never belong here.
CREATE TABLE IF NOT EXISTS authoritative_source_versions (
  tenant_id          TEXT NOT NULL DEFAULT 'default' CHECK (pg_catalog.btrim(tenant_id) <> ''),
  source_version_id  TEXT PRIMARY KEY CHECK (
    source_version_id ~ '^srcv_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'
  ),
  source_ref         TEXT NOT NULL CHECK (
    source_ref ~ '^SRC-[A-Z0-9][A-Z0-9._-]{0,126}$'
  ),
  domain             TEXT NOT NULL CHECK (domain IN ('presale','campaign','aftersale','product')),
  upstream_version   TEXT NOT NULL CHECK (pg_catalog.btrim(upstream_version) <> ''),
  snapshot_sha256    TEXT NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  use_class          TEXT NOT NULL CHECK (use_class IN ('canonical','reference')),
  owner_role         TEXT NOT NULL CHECK (pg_catalog.btrim(owner_role) <> ''),
  approval_evd       TEXT NOT NULL CHECK (pg_catalog.btrim(approval_evd) <> ''),
  approved_by        TEXT NOT NULL CHECK (pg_catalog.btrim(approved_by) <> ''),
  approved_at        TIMESTAMPTZ NOT NULL,
  review_due_at      TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT authoritative_source_review_window CHECK (review_due_at >= approved_at),
  CONSTRAINT authoritative_source_alias_version_unique
    UNIQUE (tenant_id, source_ref, upstream_version),
  CONSTRAINT authoritative_source_version_domain_unique
    UNIQUE (source_version_id, domain),
  CONSTRAINT authoritative_source_version_alias_unique
    UNIQUE (source_version_id, domain, source_ref)
);

-- Suspension is permanent evidence for one immutable version. Restoring content requires registering
-- a new source_version_id; UPDATE/DELETE cannot erase the reason the old version stopped being eligible.
CREATE TABLE IF NOT EXISTS authoritative_source_suspensions (
  suspension_id      TEXT PRIMARY KEY CHECK (
    suspension_id ~ '^susp_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'
  ),
  source_version_id  TEXT NOT NULL UNIQUE REFERENCES authoritative_source_versions(source_version_id),
  reason_code        TEXT NOT NULL CHECK (reason_code IN (
    'SOURCE_REVOKED','SOURCE_COMPROMISED','SOURCE_EXPIRED','SOURCE_REPLACED'
  )),
  evidence_ref       TEXT NOT NULL CHECK (pg_catalog.btrim(evidence_ref) <> ''),
  suspended_by       TEXT NOT NULL CHECK (pg_catalog.btrim(suspended_by) <> ''),
  suspended_by_role  TEXT NOT NULL CHECK (suspended_by_role = 'owner'),
  suspended_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- DEC-042 taxonomy history is append-only. A new taxonomy release gets a new version; old intent
-- IDs remain addressable and a version-to-version migration is expressed by an explicit mapping.
CREATE TABLE IF NOT EXISTS intent_taxonomy_versions (
  intent_taxonomy_version TEXT PRIMARY KEY CHECK (
    intent_taxonomy_version ~ '^itax_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'
  ),
  approval_evd            TEXT NOT NULL CHECK (pg_catalog.btrim(approval_evd) <> ''),
  approved_by             TEXT NOT NULL CHECK (pg_catalog.btrim(approved_by) <> ''),
  approved_at             TIMESTAMPTZ NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intent_taxonomy_entries (
  intent_taxonomy_version TEXT NOT NULL REFERENCES intent_taxonomy_versions(intent_taxonomy_version),
  intent_id                TEXT NOT NULL CHECK (intent_id ~ '^intent_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'),
  label                    TEXT NOT NULL CHECK (pg_catalog.btrim(label) <> ''),
  lifecycle                TEXT NOT NULL CHECK (lifecycle IN ('active','deprecated')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (intent_taxonomy_version, intent_id)
);

CREATE TABLE IF NOT EXISTS intent_taxonomy_mappings (
  mapping_id                 TEXT PRIMARY KEY CHECK (mapping_id ~ '^itmap_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'),
  from_taxonomy_version      TEXT NOT NULL,
  from_intent_id             TEXT NOT NULL,
  to_taxonomy_version        TEXT NOT NULL,
  to_intent_id               TEXT NOT NULL,
  mapping_type               TEXT NOT NULL CHECK (mapping_type IN ('rename','merge','split','deprecate')),
  approval_evd               TEXT NOT NULL CHECK (pg_catalog.btrim(approval_evd) <> ''),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT intent_taxonomy_mapping_source_fk
    FOREIGN KEY (from_taxonomy_version, from_intent_id)
    REFERENCES intent_taxonomy_entries(intent_taxonomy_version, intent_id),
  CONSTRAINT intent_taxonomy_mapping_target_fk
    FOREIGN KEY (to_taxonomy_version, to_intent_id)
    REFERENCES intent_taxonomy_entries(intent_taxonomy_version, intent_id),
  CONSTRAINT intent_taxonomy_mapping_not_identity CHECK (
    (from_taxonomy_version, from_intent_id) IS DISTINCT FROM
    (to_taxonomy_version, to_intent_id)
  ),
  CONSTRAINT intent_taxonomy_mapping_unique UNIQUE (
    from_taxonomy_version, from_intent_id, to_taxonomy_version, to_intent_id, mapping_type
  )
);

-- Arrays used as business scopes are sets: non-null, no blank member and no duplicate member.
CREATE OR REPLACE FUNCTION public.content_text_array_is_nonblank_unique(
  p_values TEXT[]
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_values IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.unnest(p_values) AS value(item)
      WHERE value.item IS NULL OR pg_catalog.btrim(value.item) = ''
    )
    AND pg_catalog.cardinality(p_values) = (
      SELECT pg_catalog.count(DISTINCT value.item)
      FROM pg_catalog.unnest(p_values) AS value(item)
    )
$$;
REVOKE ALL ON FUNCTION public.content_text_array_is_nonblank_unique(TEXT[]) FROM PUBLIC;

-- Phase 1 templates may contain only the two approved display placeholders. Machine keys are stored;
-- customer/order/date values and rendered answer bodies have no schema column and must never be logged.
CREATE OR REPLACE FUNCTION public.content_template_placeholders_are_valid(
  p_answer_text TEXT,
  p_placeholder_keys TEXT[]
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_answer_text IS NOT NULL
    AND pg_catalog.btrim(p_answer_text) <> ''
    AND public.content_text_array_is_nonblank_unique(p_placeholder_keys)
    AND p_placeholder_keys <@ ARRAY['order_id','date']::TEXT[]
    AND (pg_catalog.strpos(p_answer_text, '{订单号}') > 0) = ('order_id' = ANY(p_placeholder_keys))
    AND (pg_catalog.strpos(p_answer_text, '{日期}') > 0) = ('date' = ANY(p_placeholder_keys))
    AND pg_catalog.regexp_replace(
      pg_catalog.regexp_replace(p_answer_text, '\{订单号\}', '', 'g'),
      '\{日期\}', '', 'g'
    ) !~ '[{}]'
$$;
REVOKE ALL ON FUNCTION public.content_template_placeholders_are_valid(TEXT,TEXT[]) FROM PUBLIC;

-- Search must apply both scope dimensions. Storewide content can match without product context;
-- category/sku content requires an exact typed context and therefore cannot be guessed from sku_hint.
CREATE OR REPLACE FUNCTION public.content_scope_matches(
  p_platform_scope TEXT[],
  p_product_scope_type TEXT,
  p_product_scope_refs TEXT[],
  p_platform TEXT,
  p_product_context_type TEXT,
  p_product_context_ref TEXT
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_platform IN ('qianniu','douyin')
    AND p_platform = ANY(p_platform_scope)
    AND (
      p_product_scope_type = 'storewide'
      OR (
        p_product_context_type = p_product_scope_type
        AND p_product_context_type IN ('category','sku')
        AND p_product_context_ref IS NOT NULL
        AND p_product_context_ref = ANY(p_product_scope_refs)
      )
    )
$$;
REVOKE ALL ON FUNCTION public.content_scope_matches(TEXT[],TEXT,TEXT[],TEXT,TEXT,TEXT) FROM PUBLIC;

-- Question identity comes from the normalized source asset, never row_number/ordinality. The array
-- is ordered only when hashing/publishing, after every stable ID and fingerprint has been supplied.
CREATE OR REPLACE FUNCTION public.content_questions_are_valid(
  p_questions JSONB
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN pg_catalog.jsonb_typeof(p_questions) IS DISTINCT FROM 'array' THEN FALSE
    WHEN pg_catalog.jsonb_array_length(p_questions) < 1 THEN FALSE
    WHEN EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(p_questions) AS question(value)
      WHERE pg_catalog.jsonb_typeof(question.value) IS DISTINCT FROM 'object'
         OR NOT question.value ?& ARRAY[
           'question_id','question_version','question_text','question_hash',
           'semantic_family_id','origin_fingerprint','source_asset_id','source'
         ]
         OR question.value - ARRAY[
           'question_id','question_version','question_text','question_hash',
           'semantic_family_id','origin_fingerprint','source_asset_id','source',
           'source_query_id','promotion_review_ref','promoted_by_role','promoted_at'
         ] <> '{}'::jsonb
         OR coalesce(question.value ->> 'question_id', '') !~ '^q_[A-Za-z0-9][A-Za-z0-9_-]{7,126}$'
         OR coalesce(question.value ->> 'question_version', '') !~ '^[1-9][0-9]{0,8}$'
         OR coalesce(pg_catalog.btrim(question.value ->> 'question_text'), '') = ''
         OR pg_catalog.length(question.value ->> 'question_text') > 500
         OR coalesce(question.value ->> 'question_hash', '') !~ '^[0-9a-f]{64}$'
         OR coalesce(question.value ->> 'semantic_family_id', '') !~ '^sf_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'
         OR coalesce(question.value ->> 'origin_fingerprint', '') !~ '^[0-9a-f]{64}$'
         OR coalesce(question.value ->> 'source_asset_id', '') !~ '^sa_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'
         OR coalesce(question.value ->> 'source', '') NOT IN ('manual','from_log','import')
         OR (
           question.value ->> 'source' = 'from_log'
           AND (
             coalesce(pg_catalog.btrim(question.value ->> 'source_query_id'), '') = ''
             OR coalesce(pg_catalog.btrim(question.value ->> 'promotion_review_ref'), '') = ''
             OR coalesce(pg_catalog.btrim(question.value ->> 'promoted_by_role'), '') = ''
             OR coalesce(pg_catalog.btrim(question.value ->> 'promoted_at'), '') = ''
           )
         )
         OR (
           question.value ->> 'source' <> 'from_log'
           AND (
             question.value ->> 'source_query_id' IS NOT NULL
             OR question.value ->> 'promotion_review_ref' IS NOT NULL
             OR question.value ->> 'promoted_by_role' IS NOT NULL
             OR question.value ->> 'promoted_at' IS NOT NULL
           )
         )
    ) THEN FALSE
    WHEN (
      SELECT pg_catalog.count(*) = pg_catalog.count(DISTINCT question.value ->> 'question_id')
         AND pg_catalog.count(*) = pg_catalog.count(DISTINCT question.value ->> 'origin_fingerprint')
      FROM pg_catalog.jsonb_array_elements(p_questions) AS question(value)
    ) IS DISTINCT FROM TRUE THEN FALSE
    ELSE TRUE
  END
$$;
REVOKE ALL ON FUNCTION public.content_questions_are_valid(JSONB) FROM PUBLIC;

-- DEC-042 fixed ASCII-key JCS subset. This helper is deliberately NOT a general Unicode RFC 8785
-- implementation: governance builders use fixed ASCII member names, C byte-order sorting, arrays,
-- strings, booleans, null and integers only. Arbitrary Unicode keys and numeric forms are rejected.
CREATE OR REPLACE FUNCTION public.jsonb_jcs(
  p_value JSONB
) RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_type TEXT;
  v_result TEXT;
BEGIN
  v_type := pg_catalog.jsonb_typeof(p_value);
  IF v_type = 'object' THEN
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_each(p_value) AS member(key, value)
      WHERE pg_catalog.octet_length(member.key) <> pg_catalog.length(member.key)
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'ZA001',
        MESSAGE = 'DEC-042 JCS subset only accepts fixed ASCII object keys',
        DETAIL = 'DEC042_JCS_SUBSET_INVALID';
    END IF;
    SELECT coalesce(
      '{' || pg_catalog.string_agg(
        pg_catalog.to_jsonb(member.key)::TEXT || ':' || public.jsonb_jcs(member.value),
        ',' ORDER BY member.key COLLATE "C"
      ) || '}',
      '{}'
    ) INTO v_result
    FROM pg_catalog.jsonb_each(p_value) AS member(key, value);
    RETURN v_result;
  ELSIF v_type = 'array' THEN
    SELECT coalesce(
      '[' || pg_catalog.string_agg(
        public.jsonb_jcs(member.value), ',' ORDER BY member.ordinality
      ) || ']',
      '[]'
    ) INTO v_result
    FROM pg_catalog.jsonb_array_elements(p_value) WITH ORDINALITY AS member(value, ordinality);
    RETURN v_result;
  ELSIF v_type = 'number' AND p_value::TEXT !~ '^-?(0|[1-9][0-9]*)$' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'ZA001',
      MESSAGE = 'DEC-042 JCS subset accepts integer numbers only',
      DETAIL = 'DEC042_JCS_SUBSET_INVALID';
  END IF;
  RETURN p_value::TEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.jsonb_jcs(JSONB) FROM PUBLIC;

-- Timestamps participating in a governance hash are serialized as fixed-width UTC strings. Casting a
-- timestamptz directly to JSON is session-TimeZone-sensitive and would produce different hashes for the
-- same instant. Microseconds are retained so this contract is deterministic without rounding.
CREATE OR REPLACE FUNCTION public.content_utc_timestamp_text(
  p_value TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT pg_catalog.to_char(
    p_value AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  )
$$;
REVOKE ALL ON FUNCTION public.content_utc_timestamp_text(TIMESTAMPTZ) FROM PUBLIC;

-- Question hashes bind stable identity, version, redacted text, semantic family, source asset,
-- taxonomy and the separately keyed origin HMAC + key version. The HMAC is computed independently,
-- so including its opaque result is not circular. Promotion time is normalized to UTC again here.
CREATE OR REPLACE FUNCTION public.content_question_hash(
  p_question JSONB
) RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT pg_catalog.encode(public.digest(pg_catalog.convert_to(public.jsonb_jcs(
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'intent_id', p_question ->> 'intent_id',
      'intent_taxonomy_version', p_question ->> 'intent_taxonomy_version',
      'origin_fingerprint', p_question ->> 'origin_fingerprint',
      'origin_fingerprint_key_version', p_question ->> 'origin_fingerprint_key_version',
      'promoted_by_role', p_question ->> 'promoted_by_role',
      'promoted_at', CASE
        WHEN p_question ->> 'promoted_at' IS NULL THEN NULL
        WHEN p_question ->> 'promoted_at' ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
        THEN public.content_utc_timestamp_text((p_question ->> 'promoted_at')::TIMESTAMPTZ)
        ELSE p_question ->> 'promoted_at'
      END,
      'promotion_review_ref', p_question ->> 'promotion_review_ref',
      'question_id', p_question ->> 'question_id',
      'question_text', p_question ->> 'question_text',
      'question_version', CASE
        WHEN p_question ->> 'question_version' ~ '^[1-9][0-9]{0,8}$'
        THEN (p_question ->> 'question_version')::INTEGER
        ELSE NULL
      END,
      'semantic_family_id', p_question ->> 'semantic_family_id',
      'source', p_question ->> 'source',
      'source_asset_id', p_question ->> 'source_asset_id',
      'source_query_id', p_question ->> 'source_query_id'
    ))
  ), 'UTF8'), 'sha256'), 'hex')
$$;
REVOKE ALL ON FUNCTION public.content_question_hash(JSONB) FROM PUBLIC;

-- Replace the early bootstrap definition with the complete DEC-042 execution contract before any
-- table CHECK consumes it. A question version is immutable and carries its own taxonomy and HMAC-key
-- version; from_log promotion evidence is non-null and UTC-normalized.
CREATE OR REPLACE FUNCTION public.content_questions_are_valid(
  p_questions JSONB
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN pg_catalog.jsonb_typeof(p_questions) IS DISTINCT FROM 'array' THEN FALSE
    WHEN pg_catalog.jsonb_array_length(p_questions) < 1 THEN FALSE
    WHEN EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(p_questions) AS question(value)
      WHERE pg_catalog.jsonb_typeof(question.value) IS DISTINCT FROM 'object'
         OR NOT question.value ?& ARRAY[
           'question_id','question_version','question_text','question_hash',
           'semantic_family_id','origin_fingerprint','origin_fingerprint_key_version',
           'source_asset_id','source','intent_taxonomy_version','intent_id'
         ]
         OR question.value - ARRAY[
           'question_id','question_version','question_text','question_hash',
           'semantic_family_id','origin_fingerprint','origin_fingerprint_key_version',
           'source_asset_id','source','intent_taxonomy_version','intent_id',
           'source_query_id','promotion_review_ref','promoted_by_role','promoted_at'
         ] <> '{}'::jsonb
         OR pg_catalog.jsonb_typeof(question.value -> 'question_id') IS DISTINCT FROM 'string'
         OR pg_catalog.jsonb_typeof(question.value -> 'question_version') IS DISTINCT FROM 'number'
         OR pg_catalog.jsonb_typeof(question.value -> 'question_text') IS DISTINCT FROM 'string'
         OR pg_catalog.jsonb_typeof(question.value -> 'question_hash') IS DISTINCT FROM 'string'
         OR pg_catalog.jsonb_typeof(question.value -> 'semantic_family_id') IS DISTINCT FROM 'string'
         OR pg_catalog.jsonb_typeof(question.value -> 'origin_fingerprint') IS DISTINCT FROM 'string'
         OR pg_catalog.jsonb_typeof(question.value -> 'origin_fingerprint_key_version') IS DISTINCT FROM 'string'
         OR pg_catalog.jsonb_typeof(question.value -> 'source_asset_id') IS DISTINCT FROM 'string'
         OR pg_catalog.jsonb_typeof(question.value -> 'source') IS DISTINCT FROM 'string'
         OR pg_catalog.jsonb_typeof(question.value -> 'intent_taxonomy_version') IS DISTINCT FROM 'string'
         OR pg_catalog.jsonb_typeof(question.value -> 'intent_id') IS DISTINCT FROM 'string'
         OR (
           question.value ? 'source_query_id'
           AND pg_catalog.jsonb_typeof(question.value -> 'source_query_id') NOT IN ('string','null')
         )
         OR (
           question.value ? 'promotion_review_ref'
           AND pg_catalog.jsonb_typeof(question.value -> 'promotion_review_ref') NOT IN ('string','null')
         )
         OR (
           question.value ? 'promoted_by_role'
           AND pg_catalog.jsonb_typeof(question.value -> 'promoted_by_role') NOT IN ('string','null')
         )
         OR (
           question.value ? 'promoted_at'
           AND pg_catalog.jsonb_typeof(question.value -> 'promoted_at') NOT IN ('string','null')
         )
         OR coalesce(question.value ->> 'question_id', '') !~ '^q_[A-Za-z0-9][A-Za-z0-9_-]{7,126}$'
         OR coalesce(question.value ->> 'question_version', '') !~ '^[1-9][0-9]{0,8}$'
         OR coalesce(pg_catalog.btrim(question.value ->> 'question_text'), '') = ''
         OR pg_catalog.length(question.value ->> 'question_text') > 500
         OR coalesce(question.value ->> 'question_hash', '') !~ '^[0-9a-f]{64}$'
         OR question.value ->> 'question_hash' IS DISTINCT FROM public.content_question_hash(question.value)
         OR coalesce(question.value ->> 'semantic_family_id', '') !~ '^sf_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'
         OR coalesce(question.value ->> 'origin_fingerprint', '') !~ '^[0-9a-f]{64}$'
         OR coalesce(question.value ->> 'origin_fingerprint_key_version', '') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
         OR coalesce(question.value ->> 'source_asset_id', '') !~ '^sa_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'
         OR coalesce(question.value ->> 'source', '') NOT IN ('manual','from_log','import')
         OR coalesce(question.value ->> 'intent_taxonomy_version', '') !~ '^itax_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'
         OR coalesce(question.value ->> 'intent_id', '') !~ '^intent_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'
         OR (
           question.value ->> 'source' = 'from_log'
           AND (
             coalesce(pg_catalog.btrim(question.value ->> 'source_query_id'), '') = ''
             OR coalesce(pg_catalog.btrim(question.value ->> 'promotion_review_ref'), '') = ''
             OR coalesce(pg_catalog.btrim(question.value ->> 'promoted_by_role'), '') = ''
             OR coalesce(question.value ->> 'promoted_at', '') !~
               '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
           )
         )
         OR (
           question.value ->> 'source' <> 'from_log'
           AND (
             question.value ->> 'source_query_id' IS NOT NULL
             OR question.value ->> 'promotion_review_ref' IS NOT NULL
             OR question.value ->> 'promoted_by_role' IS NOT NULL
             OR question.value ->> 'promoted_at' IS NOT NULL
           )
         )
    ) THEN FALSE
    WHEN (
      SELECT pg_catalog.count(*) = pg_catalog.count(DISTINCT question.value ->> 'question_id')
         AND pg_catalog.count(*) = pg_catalog.count(DISTINCT (
           question.value ->> 'origin_fingerprint_key_version',
           question.value ->> 'origin_fingerprint'
         ))
      FROM pg_catalog.jsonb_array_elements(p_questions) AS question(value)
    ) IS DISTINCT FROM TRUE THEN FALSE
    ELSE TRUE
  END
$$;
REVOKE ALL ON FUNCTION public.content_questions_are_valid(JSONB) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.content_questions_align_intent(
  p_questions JSONB,
  p_intent_taxonomy_version TEXT,
  p_intent_id TEXT
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.content_questions_are_valid(p_questions)
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(p_questions) AS question(value)
      WHERE question.value ->> 'intent_taxonomy_version' IS DISTINCT FROM p_intent_taxonomy_version
         OR question.value ->> 'intent_id' IS DISTINCT FROM p_intent_id
    )
$$;
REVOKE ALL ON FUNCTION public.content_questions_align_intent(JSONB,TEXT,TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.content_risk_categories_are_valid(
  p_risk_level TEXT,
  p_risk_categories TEXT[]
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.content_text_array_is_nonblank_unique(p_risk_categories)
    AND p_risk_categories <@ ARRAY[
      'refund_compensation','price_discount','campaign_rules','efficacy_safety_claim',
      'account_privacy','complaint_escalation','legal_commitment'
    ]::TEXT[]
    AND (
      (p_risk_level = 'high' AND pg_catalog.cardinality(p_risk_categories) > 0)
      OR (p_risk_level IN ('low','medium') AND pg_catalog.cardinality(p_risk_categories) = 0)
    )
$$;
REVOKE ALL ON FUNCTION public.content_risk_categories_are_valid(TEXT,TEXT[]) FROM PUBLIC;

-- Immutable identity of the exact quality-review population. Only deterministic, non-PII fields
-- participate; array order and unrelated worker metadata cannot change the hash. Equal counts with a
-- substituted script/content tuple therefore produce a different manifest and fail closed.
CREATE OR REPLACE FUNCTION public.content_quality_population_manifest_hash(
  p_rows JSONB
) RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_manifest JSONB;
BEGIN
  IF pg_catalog.jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'quality population must be a JSON array', DETAIL = 'QUALITY_POPULATION_INVALID';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_rows) AS row_item(value)
    WHERE pg_catalog.jsonb_typeof(row_item.value) IS DISTINCT FROM 'object'
       OR (
         row_item.value ? 'operation'
         AND pg_catalog.jsonb_typeof(row_item.value -> 'operation') IS DISTINCT FROM 'string'
       )
       OR (
         coalesce(row_item.value ->> 'operation', 'upsert') = 'upsert'
         AND (
           pg_catalog.jsonb_typeof(row_item.value -> 'staging_id') IS DISTINCT FROM 'string'
           OR pg_catalog.jsonb_typeof(row_item.value -> 'script_id') IS DISTINCT FROM 'string'
           OR pg_catalog.jsonb_typeof(row_item.value -> 'content_hash') IS DISTINCT FROM 'string'
           OR pg_catalog.jsonb_typeof(row_item.value -> 'risk_level') IS DISTINCT FROM 'string'
           OR pg_catalog.jsonb_typeof(row_item.value -> 'has_conflict') IS DISTINCT FROM 'boolean'
           OR pg_catalog.jsonb_typeof(row_item.value -> 'quality_status') IS DISTINCT FROM 'string'
           OR coalesce(pg_catalog.btrim(row_item.value ->> 'staging_id'), '') = ''
           OR coalesce(pg_catalog.btrim(row_item.value ->> 'script_id'), '') = ''
           OR coalesce(row_item.value ->> 'content_hash', '') !~ '^[0-9a-f]{64}$'
           OR coalesce(row_item.value ->> 'risk_level', '') NOT IN ('low','medium','high')
           OR coalesce(row_item.value ->> 'quality_status', '') NOT IN ('clean','quarantined')
         )
       )
       OR coalesce(row_item.value ->> 'operation', 'upsert') NOT IN ('upsert','withdraw')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'quality population tuple is invalid', DETAIL = 'QUALITY_POPULATION_INVALID';
  END IF;

  SELECT coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'content_hash', row_item.value ->> 'content_hash',
        'has_conflict', row_item.value -> 'has_conflict',
        'quality_status', row_item.value ->> 'quality_status',
        'risk_level', row_item.value ->> 'risk_level',
        'script_id', row_item.value ->> 'script_id',
        'staging_id', row_item.value ->> 'staging_id'
      ) ORDER BY
        (row_item.value ->> 'script_id') COLLATE "C",
        (row_item.value ->> 'content_hash') COLLATE "C",
        (row_item.value ->> 'staging_id') COLLATE "C"
    ),
    '[]'::jsonb
  ) INTO v_manifest
  FROM pg_catalog.jsonb_array_elements(p_rows) AS row_item(value)
  WHERE coalesce(row_item.value ->> 'operation', 'upsert') = 'upsert';

  RETURN pg_catalog.encode(public.digest(
    pg_catalog.convert_to(public.jsonb_jcs(v_manifest), 'UTF8'),
    'sha256'
  ), 'hex');
END;
$$;
REVOKE ALL ON FUNCTION public.content_quality_population_manifest_hash(JSONB) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.content_governance_snapshot(
  p_script_id TEXT,
  p_category TEXT,
  p_title TEXT,
  p_answer_text TEXT,
  p_source_ref TEXT,
  p_source_version_id TEXT,
  p_owner_role TEXT,
  p_review_due_at TIMESTAMPTZ,
  p_platform_scope TEXT[],
  p_product_scope_type TEXT,
  p_product_scope_refs TEXT[],
  p_effective_from TIMESTAMPTZ,
  p_effective_to TIMESTAMPTZ,
  p_intent_taxonomy_version TEXT,
  p_intent_id TEXT,
  p_risk_level TEXT,
  p_risk_categories TEXT[],
  p_has_conflict BOOLEAN,
  p_review_mode TEXT,
  p_primary_reviewer_id TEXT,
  p_primary_reviewer_role TEXT,
  p_primary_review_evd TEXT,
  p_secondary_reviewer_id TEXT,
  p_secondary_reviewer_role TEXT,
  p_secondary_review_evd TEXT,
  p_placeholder_keys TEXT[],
  p_questions JSONB
) RETURNS JSONB
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'answer_text', p_answer_text,
    'category', p_category,
    'effective_from', public.content_utc_timestamp_text(p_effective_from),
    'effective_to', CASE WHEN p_effective_to IS NULL THEN NULL ELSE public.content_utc_timestamp_text(p_effective_to) END,
    'has_conflict', p_has_conflict,
    'intent_id', p_intent_id,
    'intent_taxonomy_version', p_intent_taxonomy_version,
    'owner_role', p_owner_role,
    'placeholder_keys', (
      SELECT coalesce(pg_catalog.jsonb_agg(value.item ORDER BY value.item), '[]'::jsonb)
      FROM pg_catalog.unnest(p_placeholder_keys) AS value(item)
    ),
    'platform_scope', (
      SELECT pg_catalog.jsonb_agg(value.item ORDER BY value.item)
      FROM pg_catalog.unnest(p_platform_scope) AS value(item)
    ),
    'primary_reviewer_id', p_primary_reviewer_id,
    'primary_reviewer_role', p_primary_reviewer_role,
    'primary_review_evd', p_primary_review_evd,
    'product_scope_refs', (
      SELECT coalesce(pg_catalog.jsonb_agg(value.item ORDER BY value.item), '[]'::jsonb)
      FROM pg_catalog.unnest(p_product_scope_refs) AS value(item)
    ),
    'product_scope_type', p_product_scope_type,
    'questions', (
      SELECT pg_catalog.jsonb_agg(question.value ORDER BY question.value ->> 'question_id')
      FROM pg_catalog.jsonb_array_elements(p_questions) AS question(value)
    ),
    'review_due_at', public.content_utc_timestamp_text(p_review_due_at),
    'review_mode', p_review_mode,
    'risk_categories', (
      SELECT coalesce(pg_catalog.jsonb_agg(value.item ORDER BY value.item), '[]'::jsonb)
      FROM pg_catalog.unnest(p_risk_categories) AS value(item)
    ),
    'risk_level', p_risk_level,
    'script_id', p_script_id,
    'secondary_reviewer_id', p_secondary_reviewer_id,
    'secondary_reviewer_role', p_secondary_reviewer_role,
    'secondary_review_evd', p_secondary_review_evd,
    'source_ref', p_source_ref,
    'source_version_id', p_source_version_id,
    'title', p_title
  )
$$;
REVOKE ALL ON FUNCTION public.content_governance_snapshot(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT[],TEXT,TEXT[],TIMESTAMPTZ,TIMESTAMPTZ,
  TEXT,TEXT,TEXT,TEXT[],BOOLEAN,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT[],JSONB
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.content_governance_hash(
  p_script_id TEXT,
  p_category TEXT,
  p_title TEXT,
  p_answer_text TEXT,
  p_source_ref TEXT,
  p_source_version_id TEXT,
  p_owner_role TEXT,
  p_review_due_at TIMESTAMPTZ,
  p_platform_scope TEXT[],
  p_product_scope_type TEXT,
  p_product_scope_refs TEXT[],
  p_effective_from TIMESTAMPTZ,
  p_effective_to TIMESTAMPTZ,
  p_intent_taxonomy_version TEXT,
  p_intent_id TEXT,
  p_risk_level TEXT,
  p_risk_categories TEXT[],
  p_has_conflict BOOLEAN,
  p_review_mode TEXT,
  p_primary_reviewer_id TEXT,
  p_primary_reviewer_role TEXT,
  p_primary_review_evd TEXT,
  p_secondary_reviewer_id TEXT,
  p_secondary_reviewer_role TEXT,
  p_secondary_review_evd TEXT,
  p_placeholder_keys TEXT[],
  p_questions JSONB
) RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT pg_catalog.encode(public.digest(pg_catalog.convert_to(public.jsonb_jcs(
    public.content_governance_snapshot(
      p_script_id, p_category, p_title, p_answer_text, p_source_ref, p_source_version_id,
      p_owner_role, p_review_due_at, p_platform_scope, p_product_scope_type,
      p_product_scope_refs, p_effective_from, p_effective_to,
      p_intent_taxonomy_version, p_intent_id, p_risk_level, p_risk_categories, p_has_conflict,
      p_review_mode, p_primary_reviewer_id, p_primary_reviewer_role, p_primary_review_evd,
      p_secondary_reviewer_id, p_secondary_reviewer_role, p_secondary_review_evd,
      p_placeholder_keys, p_questions
    )
  ), 'UTF8'), 'sha256'), 'hex')
$$;
REVOKE ALL ON FUNCTION public.content_governance_hash(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT[],TEXT,TEXT[],TIMESTAMPTZ,TIMESTAMPTZ,
  TEXT,TEXT,TEXT,TEXT[],BOOLEAN,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT[],JSONB
) FROM PUBLIC;

-- ─── Scripts (authoring/latest lineage; active answer SoR = content_current -> release_items) ───
CREATE TABLE IF NOT EXISTS scripts (
  script_id       TEXT PRIMARY KEY,
  category        TEXT NOT NULL CHECK (category IN ('presale','campaign','aftersale','product')),
  title           TEXT NOT NULL,
  answer_text     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('draft','in_review','published','archived')),
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  content_hash    TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  source_ref      TEXT NOT NULL CHECK (pg_catalog.btrim(source_ref) <> ''),
  source_version_id TEXT NOT NULL,
  platform_scope  TEXT[] NOT NULL,
  product_scope_type TEXT NOT NULL CHECK (product_scope_type IN ('storewide','category','sku')),
  product_scope_refs TEXT[] NOT NULL,
  campaign_tag    TEXT,
  effective_from  TIMESTAMPTZ NOT NULL,
  effective_to    TIMESTAMPTZ,  -- NULL = +infinity
  intent_taxonomy_version TEXT NOT NULL,
  intent_id        TEXT NOT NULL,
  risk_level       TEXT NOT NULL CHECK (risk_level IN ('low','medium','high')),
  risk_categories  TEXT[] NOT NULL,
  has_conflict     BOOLEAN NOT NULL DEFAULT FALSE,
  review_mode      TEXT NOT NULL CHECK (review_mode IN ('single','dual')),
  primary_reviewer_id TEXT NOT NULL CHECK (primary_reviewer_id ~ '^[0-9a-f]{64}$'),
  primary_reviewer_role TEXT NOT NULL CHECK (primary_reviewer_role = 'ROLE-CONTENT-LEAD'),
  primary_review_evd TEXT NOT NULL CHECK (pg_catalog.btrim(primary_review_evd) <> ''),
  secondary_reviewer_id TEXT,
  secondary_reviewer_role TEXT,
  secondary_review_evd TEXT,
  placeholder_keys TEXT[] NOT NULL,
  questions_json  JSONB NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 0,
  owner_role      TEXT NOT NULL CHECK (pg_catalog.btrim(owner_role) <> ''),
  review_due_at   TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ,
  CONSTRAINT scripts_effective_window CHECK (
    effective_to IS NULL OR effective_from < effective_to
  ),
  CONSTRAINT scripts_platform_scope CHECK (
    public.content_text_array_is_nonblank_unique(platform_scope)
    AND pg_catalog.cardinality(platform_scope) > 0
    AND platform_scope <@ ARRAY['qianniu','douyin']::TEXT[]
  ),
  CONSTRAINT scripts_product_scope CHECK (
    public.content_text_array_is_nonblank_unique(product_scope_refs)
    AND (
      (product_scope_type = 'storewide' AND pg_catalog.cardinality(product_scope_refs) = 0)
      OR (product_scope_type IN ('category','sku') AND pg_catalog.cardinality(product_scope_refs) > 0)
    )
  ),
  CONSTRAINT scripts_review_shape CHECK (
    (
      (risk_level = 'high' OR has_conflict)
      AND review_mode = 'dual'
      AND secondary_reviewer_id IS NOT NULL
      AND secondary_reviewer_id ~ '^[0-9a-f]{64}$'
      AND secondary_reviewer_id <> primary_reviewer_id
      AND secondary_reviewer_role = 'ROLE-CS-MANAGER'
      AND secondary_review_evd IS NOT NULL
      AND pg_catalog.btrim(secondary_review_evd) <> ''
    ) OR (
      risk_level IN ('low','medium') AND NOT has_conflict
      AND review_mode = 'single'
      AND secondary_reviewer_id IS NULL
      AND secondary_reviewer_role IS NULL
      AND secondary_review_evd IS NULL
    )
  ),
  CONSTRAINT scripts_risk_categories CHECK (
    public.content_risk_categories_are_valid(risk_level, risk_categories)
  ),
  CONSTRAINT scripts_placeholders CHECK (
    public.content_template_placeholders_are_valid(answer_text, placeholder_keys)
  ),
  CONSTRAINT scripts_questions CHECK (
    public.content_questions_align_intent(questions_json, intent_taxonomy_version, intent_id)
  ),
  CONSTRAINT scripts_intent_fk
    FOREIGN KEY (intent_taxonomy_version, intent_id)
    REFERENCES intent_taxonomy_entries(intent_taxonomy_version, intent_id),
  CONSTRAINT scripts_source_version_fk
    FOREIGN KEY (source_version_id, category, source_ref)
    REFERENCES authoritative_source_versions(source_version_id, domain, source_ref)
);

CREATE TABLE IF NOT EXISTS script_questions (
  question_id     TEXT NOT NULL CHECK (question_id ~ '^q_[A-Za-z0-9][A-Za-z0-9_-]{7,126}$'),
  script_id       TEXT NOT NULL REFERENCES scripts(script_id),
  question_version INTEGER NOT NULL CHECK (question_version >= 1),
  question_text   TEXT NOT NULL,
  question_hash   TEXT NOT NULL CHECK (question_hash ~ '^[0-9a-f]{64}$'),
  semantic_family_id TEXT NOT NULL CHECK (semantic_family_id ~ '^sf_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'),
  origin_fingerprint TEXT NOT NULL CHECK (origin_fingerprint ~ '^[0-9a-f]{64}$'),
  origin_fingerprint_key_version TEXT NOT NULL CHECK (
    origin_fingerprint_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  source_asset_id TEXT NOT NULL CHECK (source_asset_id ~ '^sa_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'),
  source          TEXT NOT NULL CHECK (source IN ('manual','from_log','import')),
  intent_taxonomy_version TEXT NOT NULL,
  intent_id        TEXT NOT NULL,
  source_query_id TEXT,
  promotion_review_ref TEXT,
  promoted_by_role TEXT,
  promoted_at     TIMESTAMPTZ,
  status          TEXT NOT NULL CHECK (status IN ('active','disabled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, question_version),
  CONSTRAINT script_question_promotion_shape CHECK (
    (
      source = 'from_log'
      AND source_query_id IS NOT NULL
      AND promotion_review_ref IS NOT NULL
      AND pg_catalog.btrim(promotion_review_ref) <> ''
      AND promoted_by_role IS NOT NULL
      AND pg_catalog.btrim(promoted_by_role) <> ''
      AND promoted_at IS NOT NULL
    )
    OR (
      source <> 'from_log'
      AND source_query_id IS NULL
      AND promotion_review_ref IS NULL
      AND promoted_by_role IS NULL
      AND promoted_at IS NULL
    )
  ),
  CONSTRAINT script_question_intent_fk
    FOREIGN KEY (intent_taxonomy_version, intent_id)
    REFERENCES intent_taxonomy_entries(intent_taxonomy_version, intent_id),
  CONSTRAINT script_question_origin_version_unique
    UNIQUE (origin_fingerprint_key_version, origin_fingerprint, question_version)
);

-- Full-text search (Postgres). Client may rebuild local FTS from release snapshot.
CREATE INDEX IF NOT EXISTS idx_scripts_published ON scripts(status) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_scripts_effective ON scripts(effective_from, effective_to);
CREATE INDEX IF NOT EXISTS idx_questions_script ON script_questions(script_id);

-- v_scripts_recommendable created after release_items / content_current (see end of file).
-- MUST read current release_items only — never raw scripts alone.

-- ─── Events ───
CREATE TABLE IF NOT EXISTS query_events (
  query_id            TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  parent_query_id     TEXT REFERENCES query_events(query_id),
  interaction_reason  TEXT NOT NULL DEFAULT 'original' CHECK (
    interaction_reason IN ('original','reselection')
  ),
  request_hash        TEXT NOT NULL,
  request_hash_key_version TEXT NOT NULL,
  query_text_redacted TEXT,
  query_text_hash     TEXT,
  hash_key_version    TEXT NOT NULL,
  text_storage_status TEXT NOT NULL CHECK (text_storage_status IN ('stored','suppressed')),
  collection_mode     TEXT NOT NULL CHECK (
    collection_mode IN ('synthetic','approved_redacted','pilot_recorded')
  ),
  detected_category   TEXT,
  detected_platform   TEXT CHECK (
    detected_platform IS NULL OR detected_platform IN ('qianniu','douyin','unknown')
  ),
  platform            TEXT CHECK (platform IS NULL OR platform IN ('qianniu','douyin','unknown')),
  platform_source     TEXT NOT NULL CHECK (
    platform_source IN ('manual','foreground_process','native_integration','unknown')
  ),
  product_context_type TEXT CHECK (
    product_context_type IS NULL OR product_context_type IN ('category','sku')
  ),
  product_context_ref_hash TEXT CHECK (
    product_context_ref_hash IS NULL OR product_context_ref_hash ~ '^[0-9a-f]{64}$'
  ),
  product_context_hash_key_version TEXT,
  redaction_policy_version TEXT NOT NULL CHECK (pg_catalog.btrim(redaction_policy_version) <> ''),
  hit_status          TEXT NOT NULL CHECK (hit_status IN ('hit','no_hit')),
  latency_ms          INTEGER,
  release_id          TEXT NOT NULL,  -- exact immutable content release used by this operation
  text_expires_at     TIMESTAMPTZ,
  event_expires_at    TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT query_text_storage_shape CHECK (
    (
      text_storage_status = 'stored'
      AND query_text_redacted IS NOT NULL
      AND pg_catalog.btrim(query_text_redacted) <> ''
      AND query_text_hash IS NOT NULL
      AND query_text_hash ~ '^[0-9a-f]{64}$'
    )
    OR (
      text_storage_status = 'suppressed'
      AND query_text_redacted IS NULL
      AND query_text_hash IS NULL
    )
  ),
  CONSTRAINT query_expiry_shape CHECK (
    (text_expires_at IS NULL OR text_expires_at >= created_at)
    AND (event_expires_at IS NULL OR event_expires_at >= created_at)
    AND (
      text_expires_at IS NULL OR event_expires_at IS NULL OR text_expires_at <= event_expires_at
    )
  ),
  CONSTRAINT query_interaction_shape CHECK (
    (interaction_reason = 'original' AND parent_query_id IS NULL)
    OR (interaction_reason = 'reselection' AND parent_query_id IS NOT NULL)
  ),
  CONSTRAINT query_platform_provenance_shape CHECK (
    platform_source IN ('manual','native_integration')
    OR (
      platform_source = 'foreground_process'
      AND detected_platform IS NOT NULL
      AND platform IS NOT NULL
      AND detected_platform IN ('qianniu','douyin')
      AND platform = detected_platform
    )
    OR (
      platform_source = 'unknown'
      AND (platform IS NULL OR platform = 'unknown')
    )
  ),
  CONSTRAINT query_product_context_shape CHECK (
    (
      product_context_type IS NULL
      AND product_context_ref_hash IS NULL
      AND product_context_hash_key_version IS NULL
    ) OR (
      product_context_type IN ('category','sku')
      AND product_context_ref_hash IS NOT NULL
      AND product_context_hash_key_version IS NOT NULL
      AND pg_catalog.btrim(product_context_hash_key_version) <> ''
    )
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_query_user ON query_events(query_id, user_id);
CREATE INDEX IF NOT EXISTS idx_query_parent ON query_events(parent_query_id)
  WHERE parent_query_id IS NOT NULL;

-- Semantic-source indirection keeps a from_log query FK only while the asset is active. Retirement
-- is a one-way, controlled tombstone: the query FK may then be released for retention, while the
-- separately keyed origin HMAC and promotion/retirement evidence remain non-PII lineage.
CREATE TABLE IF NOT EXISTS semantic_source_assets (
  source_asset_id TEXT PRIMARY KEY CHECK (
    source_asset_id ~ '^sa_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'
  ),
  source TEXT NOT NULL CHECK (source IN ('manual','from_log','import')),
  origin_fingerprint TEXT NOT NULL CHECK (origin_fingerprint ~ '^[0-9a-f]{64}$'),
  origin_fingerprint_key_version TEXT NOT NULL CHECK (
    origin_fingerprint_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  source_query_id TEXT REFERENCES query_events(query_id) ON DELETE RESTRICT,
  promotion_review_ref TEXT,
  promoted_by_role TEXT,
  promoted_at TIMESTAMPTZ,
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','retired')),
  retirement_evd TEXT,
  retired_by_subject_hash TEXT,
  retired_by_subject_key_version TEXT,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT semantic_source_asset_identity_unique UNIQUE (
    source_asset_id, source, origin_fingerprint_key_version, origin_fingerprint
  ),
  CONSTRAINT semantic_source_asset_origin_shape CHECK (
    (
      source = 'from_log'
      AND promotion_review_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'
      AND promoted_by_role IS NOT NULL AND pg_catalog.btrim(promoted_by_role) <> ''
      AND promoted_at IS NOT NULL
      AND (
        (lifecycle = 'active' AND source_query_id IS NOT NULL)
        OR (lifecycle = 'retired' AND source_query_id IS NULL)
      )
    ) OR (
      source IN ('manual','import')
      AND source_query_id IS NULL
      AND promotion_review_ref IS NULL
      AND promoted_by_role IS NULL
      AND promoted_at IS NULL
    )
  ),
  CONSTRAINT semantic_source_asset_retirement_shape CHECK (
    (
      lifecycle = 'active'
      AND retirement_evd IS NULL
      AND retired_by_subject_hash IS NULL
      AND retired_by_subject_key_version IS NULL
      AND retired_at IS NULL
    ) OR (
      lifecycle = 'retired'
      AND retirement_evd ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'
      AND retired_by_subject_hash ~ '^[0-9a-f]{64}$'
      AND retired_by_subject_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      AND retired_at IS NOT NULL AND retired_at >= created_at
    )
  )
);
CREATE INDEX IF NOT EXISTS idx_semantic_source_assets_query
  ON semantic_source_assets(source_query_id) WHERE source_query_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_semantic_source_assets_lifecycle
  ON semantic_source_assets(lifecycle, source_asset_id);

-- Upgrade migration: one asset id must already mean one canonical origin. Ambiguity fails closed;
-- the migration never picks an arbitrary query or promotion record.
DO $semantic_asset_legacy_conflict$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.script_questions question
    GROUP BY question.source_asset_id
    HAVING pg_catalog.count(DISTINCT ROW(
      question.source,
      question.origin_fingerprint_key_version,
      question.origin_fingerprint,
      question.source_query_id,
      question.promotion_review_ref,
      question.promoted_by_role,
      question.promoted_at
    )) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'ZA001',
      MESSAGE = 'legacy semantic source asset id has conflicting lineage',
      DETAIL = 'SEMANTIC_ASSET_MIGRATION_CONFLICT';
  END IF;
END
$semantic_asset_legacy_conflict$;

INSERT INTO public.semantic_source_assets(
  source_asset_id, source, origin_fingerprint, origin_fingerprint_key_version,
  source_query_id, promotion_review_ref, promoted_by_role, promoted_at,
  lifecycle, created_at
)
SELECT DISTINCT ON (question.source_asset_id)
  question.source_asset_id,
  question.source,
  question.origin_fingerprint,
  question.origin_fingerprint_key_version,
  question.source_query_id,
  question.promotion_review_ref,
  question.promoted_by_role,
  question.promoted_at,
  'active',
  question.created_at
FROM public.script_questions question
WHERE NOT EXISTS (
  SELECT 1 FROM public.semantic_source_assets asset
  WHERE asset.source_asset_id = question.source_asset_id
)
ORDER BY question.source_asset_id, question.question_id, question.question_version;

DO $semantic_asset_legacy_identity$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.script_questions question
    JOIN public.semantic_source_assets asset
      ON asset.source_asset_id = question.source_asset_id
    WHERE asset.source IS DISTINCT FROM question.source
       OR asset.origin_fingerprint_key_version IS DISTINCT FROM question.origin_fingerprint_key_version
       OR asset.origin_fingerprint IS DISTINCT FROM question.origin_fingerprint
       OR (
         question.source_query_id IS NOT NULL
         AND asset.source_query_id IS DISTINCT FROM question.source_query_id
       )
       OR asset.promotion_review_ref IS DISTINCT FROM question.promotion_review_ref
       OR asset.promoted_by_role IS DISTINCT FROM question.promoted_by_role
       OR asset.promoted_at IS DISTINCT FROM question.promoted_at
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'ZA001',
      MESSAGE = 'legacy question lineage differs from semantic source asset',
      DETAIL = 'SEMANTIC_ASSET_MIGRATION_CONFLICT';
  END IF;
END
$semantic_asset_legacy_identity$;

-- The query FK now lives only on semantic_source_assets. Immutable question versions bind the
-- stable asset/HMAC identity and intentionally retain no direct query pointer.
ALTER TABLE script_questions DROP CONSTRAINT IF EXISTS script_question_promotion_shape;
-- A v1.11 database already has the immutable trigger. Drop and recreate it inside this transaction
-- so the one migration-only pointer move is executable; rollback restores the old trigger atomically.
DROP TRIGGER IF EXISTS script_questions_immutable ON script_questions;
UPDATE script_questions SET source_query_id = NULL WHERE source_query_id IS NOT NULL;
ALTER TABLE script_questions
  ADD CONSTRAINT script_question_promotion_shape CHECK (
    source_query_id IS NULL
    AND (
      (
        source = 'from_log'
        AND promotion_review_ref IS NOT NULL AND pg_catalog.btrim(promotion_review_ref) <> ''
        AND promoted_by_role IS NOT NULL AND pg_catalog.btrim(promoted_by_role) <> ''
        AND promoted_at IS NOT NULL
      ) OR (
        source <> 'from_log'
        AND promotion_review_ref IS NULL
        AND promoted_by_role IS NULL
        AND promoted_at IS NULL
      )
    )
  );

CREATE TABLE IF NOT EXISTS candidate_impressions (
  query_id        TEXT NOT NULL REFERENCES query_events(query_id),
  rank            INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 3),
  release_id      TEXT NOT NULL,
  script_id       TEXT NOT NULL,
  script_version  INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  score           DOUBLE PRECISION,
  PRIMARY KEY (query_id, rank)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_candidate_query_rank_script
  ON candidate_impressions(query_id, rank, script_id);

CREATE TABLE IF NOT EXISTS adoption_events (
  query_id          TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  outcome           TEXT NOT NULL CHECK (outcome IN ('adopted','dismissed','no_hit_exit','timeout')),
  chosen_rank       INTEGER CHECK (chosen_rank IS NULL OR chosen_rank BETWEEN 1 AND 3),
  chosen_script_id  TEXT,
  push_method       TEXT CHECK (push_method IS NULL OR push_method IN ('clipboard','autofill','failed','pending')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Honesty: adopted means a successful copy/push into the client input carrier, never "sent".
  -- clipboard is the Phase1 primary path; autofill is retained as a compatible successful push value.
  CONSTRAINT adoption_adopted_requires_success CHECK (
    outcome <> 'adopted'
    OR (push_method IS NOT NULL AND push_method IN ('clipboard','autofill'))
  ),
  CONSTRAINT adoption_choice_shape CHECK (
    (outcome = 'adopted' AND chosen_rank IS NOT NULL AND chosen_script_id IS NOT NULL)
    OR
    (outcome <> 'adopted' AND chosen_rank IS NULL AND chosen_script_id IS NULL)
  ),
  CONSTRAINT adoption_query_owner_fk
    FOREIGN KEY (query_id, user_id) REFERENCES query_events(query_id, user_id),
  CONSTRAINT adoption_candidate_fk
    FOREIGN KEY (query_id, chosen_rank, chosen_script_id)
    REFERENCES candidate_impressions(query_id, rank, script_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_adoption_copy_provenance
  ON adoption_events(query_id, user_id, outcome, push_method);

CREATE TABLE IF NOT EXISTS escalate_actions (
  escalate_id  TEXT PRIMARY KEY,
  query_id     TEXT NOT NULL REFERENCES query_events(query_id),
  action       TEXT NOT NULL CHECK (action IN ('open_feishu','copy_contact','other')),
  user_id      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT escalate_query_action_unique UNIQUE (query_id, action)
);

-- Reselection is a new search operation linked to one terminal parent operation. It is never an
-- in-place mutation. The trigger makes same-user ownership and append-only, acyclic lineage executable.
CREATE OR REPLACE FUNCTION trg_query_lineage_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_parent_user_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND (
       NEW.query_id IS DISTINCT FROM OLD.query_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.parent_query_id IS DISTINCT FROM OLD.parent_query_id
    OR NEW.interaction_reason IS DISTINCT FROM OLD.interaction_reason
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'query lineage is append-only', DETAIL = 'INV_BYPASS';
  END IF;

  IF NEW.interaction_reason = 'original' THEN
    IF NEW.parent_query_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'original query cannot have parent_query_id', DETAIL = 'VALIDATION';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.parent_query_id IS NULL OR NEW.parent_query_id = NEW.query_id THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'reselection requires a different parent query', DETAIL = 'VALIDATION';
  END IF;

  SELECT q.user_id INTO v_parent_user_id
  FROM public.query_events q
  WHERE q.query_id = NEW.parent_query_id;

  IF v_parent_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA002', MESSAGE = 'parent query not found', DETAIL = 'NOT_FOUND';
  END IF;
  IF v_parent_user_id <> NEW.user_id THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'parent query belongs to another user', DETAIL = 'FORBIDDEN';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.adoption_events a WHERE a.query_id = NEW.parent_query_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'parent query is not terminal', DETAIL = 'CONFLICT';
  END IF;
  IF EXISTS (
    WITH RECURSIVE ancestors(query_id, parent_query_id) AS (
      SELECT q.query_id, q.parent_query_id
      FROM public.query_events q
      WHERE q.query_id = NEW.parent_query_id
      UNION ALL
      SELECT q.query_id, q.parent_query_id
      FROM public.query_events q
      JOIN ancestors a ON q.query_id = a.parent_query_id
    )
    SELECT 1 FROM ancestors WHERE query_id = NEW.query_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'query lineage cycle detected', DETAIL = 'CONFLICT';
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION trg_query_lineage_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS query_lineage_guard ON query_events;
CREATE TRIGGER query_lineage_guard
  BEFORE INSERT OR UPDATE ON query_events
  FOR EACH ROW EXECUTE FUNCTION trg_query_lineage_guard();

-- Internal quality workflow only. This is NOT a business work-order record.
CREATE TABLE IF NOT EXISTS iteration_tasks (
  task_id               TEXT PRIMARY KEY,
  signal_id             TEXT NOT NULL,
  cluster_key           TEXT NOT NULL,
  sample_query_ids      TEXT[] NOT NULL DEFAULT '{}',
  suspected_cause       TEXT NOT NULL CHECK (
    suspected_cause IN ('content_gap','ranking','stale','mixed')
  ),
  suggested_script_ids  TEXT[] NOT NULL DEFAULT '{}',
  status                TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN ('open','in_progress','resolved','wont_fix')
  ),
  resolution            TEXT CHECK (resolution IN ('resolved','wont_fix')),
  resolution_note       TEXT,
  assignee_role         TEXT,
  version               INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at           TIMESTAMPTZ,
  CONSTRAINT iteration_task_initial_and_terminal_shape CHECK (
    (
      status IN ('open','in_progress')
      AND resolution IS NULL
      AND resolution_note IS NULL
      AND resolved_at IS NULL
    )
    OR (
      status IN ('resolved','wont_fix')
      AND resolution = status
      AND resolution_note IS NOT NULL
      AND pg_catalog.btrim(resolution_note) <> ''
      AND pg_catalog.length(resolution_note) <= 2000
      AND resolved_at IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS iteration_task_status_audits (
  audit_id        TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES iteration_tasks(task_id),
  before_status   TEXT,
  after_status    TEXT NOT NULL,
  actor_user_id   TEXT,
  actor_role      TEXT,
  resolution      TEXT,
  resolution_note TEXT,
  version         INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION trg_iteration_task_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.version <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'iteration task must start open at version 1', DETAIL = 'VALIDATION';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('resolved', 'wont_fix') THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'terminal iteration task is immutable', DETAIL = 'INV_BYPASS';
  END IF;
  IF NOT (
    (OLD.status = 'open' AND NEW.status = 'in_progress')
    OR (OLD.status = 'in_progress' AND NEW.status IN ('resolved', 'wont_fix'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid iteration task transition', DETAIL = 'VALIDATION';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'iteration task version mismatch', DETAIL = 'VERSION_MISMATCH';
  END IF;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION trg_iteration_task_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION trg_iteration_task_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO public.iteration_task_status_audits(
    audit_id, task_id, before_status, after_status, actor_user_id, actor_role,
    resolution, resolution_note, version, created_at
  ) VALUES (
    'ita_' || pg_catalog.gen_random_uuid()::text,
    NEW.task_id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
    NEW.status,
    pg_catalog.current_setting('app.actor_user_id', true),
    pg_catalog.current_setting('app.actor_role', true),
    NEW.resolution,
    NEW.resolution_note,
    NEW.version,
    pg_catalog.clock_timestamp()
  );
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION trg_iteration_task_audit() FROM PUBLIC;

DROP TRIGGER IF EXISTS iteration_task_guard ON iteration_tasks;
CREATE TRIGGER iteration_task_guard
  BEFORE INSERT OR UPDATE ON iteration_tasks
  FOR EACH ROW EXECUTE FUNCTION trg_iteration_task_guard();

DROP TRIGGER IF EXISTS iteration_task_audit ON iteration_tasks;
CREATE TRIGGER iteration_task_audit
  AFTER INSERT OR UPDATE ON iteration_tasks
  FOR EACH ROW EXECUTE FUNCTION trg_iteration_task_audit();

CREATE OR REPLACE FUNCTION start_iteration_task(
  p_task_id TEXT,
  p_expected_version INTEGER,
  p_actor_user_id TEXT,
  p_actor_role TEXT
)
RETURNS iteration_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  result public.iteration_tasks;
BEGIN
  IF p_actor_role NOT IN ('coach','owner') THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'iteration task role denied', DETAIL = 'FORBIDDEN';
  END IF;
  IF p_actor_user_id IS NULL OR pg_catalog.btrim(p_actor_user_id) = '' OR p_expected_version IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid iteration task actor or version', DETAIL = 'VALIDATION';
  END IF;

  PERFORM pg_catalog.set_config('app.actor_user_id', p_actor_user_id, true);
  PERFORM pg_catalog.set_config('app.actor_role', p_actor_role, true);

  UPDATE public.iteration_tasks
  SET status = 'in_progress',
      version = version + 1
  WHERE task_id = p_task_id
    AND status = 'open'
    AND version = p_expected_version
  RETURNING * INTO result;

  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM public.iteration_tasks WHERE task_id = p_task_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA002', MESSAGE = 'iteration task not found', DETAIL = 'NOT_FOUND';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'iteration task transition conflict', DETAIL = 'VERSION_OR_STATUS_CONFLICT';
  END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION start_iteration_task(TEXT,INTEGER,TEXT,TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION close_iteration_task(
  p_task_id TEXT,
  p_expected_version INTEGER,
  p_status TEXT,
  p_resolution_note TEXT,
  p_actor_user_id TEXT,
  p_actor_role TEXT
)
RETURNS iteration_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  result public.iteration_tasks;
BEGIN
  IF p_actor_role NOT IN ('coach','owner') THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'iteration task role denied', DETAIL = 'FORBIDDEN';
  END IF;
  IF p_status NOT IN ('resolved','wont_fix')
     OR p_resolution_note IS NULL
     OR pg_catalog.btrim(p_resolution_note) = ''
     OR pg_catalog.length(p_resolution_note) > 2000
     OR p_actor_user_id IS NULL
     OR pg_catalog.btrim(p_actor_user_id) = ''
     OR p_expected_version IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid iteration task closure', DETAIL = 'VALIDATION';
  END IF;

  PERFORM pg_catalog.set_config('app.actor_user_id', p_actor_user_id, true);
  PERFORM pg_catalog.set_config('app.actor_role', p_actor_role, true);

  UPDATE public.iteration_tasks
  SET status = p_status,
      resolution = p_status,
      resolution_note = p_resolution_note,
      resolved_at = pg_catalog.clock_timestamp(),
      version = version + 1
  WHERE task_id = p_task_id
    AND status = 'in_progress'
    AND version = p_expected_version
  RETURNING * INTO result;

  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM public.iteration_tasks WHERE task_id = p_task_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA002', MESSAGE = 'iteration task not found', DETAIL = 'NOT_FOUND';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'iteration task transition conflict', DETAIL = 'VERSION_OR_STATUS_CONFLICT';
  END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION close_iteration_task(TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

-- Business work-order analysis. Only normalized allowlisted fields are persisted here.
-- There is intentionally no raw_payload/raw_row/external_writeback column.
CREATE TABLE IF NOT EXISTS work_order_import_batches (
  import_batch_id       TEXT PRIMARY KEY,
  tenant_scope          TEXT NOT NULL,
  source_system         TEXT NOT NULL,
  source_ref            TEXT,
  source_file_name_safe TEXT,
  source_sha256         TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_size_bytes     BIGINT NOT NULL CHECK (source_size_bytes >= 0),
  mapping_version       TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'validating' CHECK (
    status IN ('received','validating','ready','failed')
  ),
  record_count          INTEGER NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  accepted_count        INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  rejected_count        INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  data_from             TIMESTAMPTZ,
  data_to               TIMESTAMPTZ,
  error_report          JSONB,
  actor_user_id         TEXT NOT NULL,
  actor_role            TEXT NOT NULL CHECK (actor_role IN ('coach','owner')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  CONSTRAINT work_order_import_counts CHECK (
    status NOT IN ('ready','failed') OR record_count = accepted_count + rejected_count
  ),
  CONSTRAINT work_order_import_dates CHECK (
    data_from IS NULL OR data_to IS NULL OR data_to >= data_from
  ),
  CONSTRAINT work_order_import_terminal_shape CHECK (
    (status IN ('received','validating') AND completed_at IS NULL)
    OR (status = 'ready' AND completed_at IS NOT NULL AND error_report IS NULL)
    OR (status = 'failed' AND completed_at IS NOT NULL AND error_report IS NOT NULL)
  ),
  CONSTRAINT work_order_import_source_unique UNIQUE (
    tenant_scope, source_sha256, mapping_version
  )
);

CREATE TABLE IF NOT EXISTS work_order_records (
  record_id             TEXT PRIMARY KEY,
  import_batch_id       TEXT NOT NULL REFERENCES work_order_import_batches(import_batch_id),
  tenant_scope          TEXT NOT NULL,
  source_record_hash    TEXT NOT NULL CHECK (source_record_hash ~ '^[0-9a-f]{64}$'),
  category              TEXT,
  issue_type            TEXT,
  product_ref_hash      TEXT CHECK (product_ref_hash IS NULL OR product_ref_hash ~ '^[0-9a-f]{64}$'),
  channel               TEXT,
  record_status         TEXT,
  opened_at             TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ,
  handling_seconds      INTEGER CHECK (handling_seconds IS NULL OR handling_seconds >= 0),
  error_type            TEXT,
  escalated             BOOLEAN NOT NULL DEFAULT FALSE,
  quality_tags          TEXT[] NOT NULL DEFAULT '{}',
  normalization_version TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT work_order_record_times CHECK (
    opened_at IS NULL OR closed_at IS NULL OR closed_at >= opened_at
  ),
  CONSTRAINT work_order_record_source_unique UNIQUE (import_batch_id, source_record_hash)
);

CREATE TABLE IF NOT EXISTS work_order_export_audits (
  export_id       TEXT PRIMARY KEY,
  tenant_scope    TEXT NOT NULL,
  actor_user_id   TEXT NOT NULL,
  actor_role      TEXT NOT NULL CHECK (actor_role IN ('coach','owner')),
  filter_hash     TEXT NOT NULL CHECK (filter_hash ~ '^[0-9a-f]{64}$'),
  field_set       TEXT[] NOT NULL,
  row_count       INTEGER NOT NULL CHECK (row_count >= 0),
  result          TEXT NOT NULL CHECK (result IN ('succeeded','denied','failed')),
  diagnostic_id   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT work_order_export_diagnostic_shape CHECK (
    (result = 'succeeded' AND diagnostic_id IS NULL)
    OR (result IN ('denied','failed') AND diagnostic_id ~ '^diag_[0-9a-f]{32}$')
  )
);

CREATE INDEX IF NOT EXISTS idx_iteration_tasks_status_created
  ON iteration_tasks(status, created_at DESC, task_id DESC);
CREATE INDEX IF NOT EXISTS idx_iteration_tasks_signal
  ON iteration_tasks(signal_id, status);
CREATE INDEX IF NOT EXISTS idx_work_order_batches_scope_created
  ON work_order_import_batches(tenant_scope, created_at DESC, import_batch_id DESC);
CREATE INDEX IF NOT EXISTS idx_work_order_records_scope_opened
  ON work_order_records(tenant_scope, opened_at DESC, record_id DESC);
CREATE INDEX IF NOT EXISTS idx_work_order_records_batch
  ON work_order_records(import_batch_id, record_id);
CREATE INDEX IF NOT EXISTS idx_work_order_records_dimensions
  ON work_order_records(tenant_scope, channel, category, issue_type, record_status, error_type);
CREATE INDEX IF NOT EXISTS idx_work_order_export_audits_actor_created
  ON work_order_export_audits(actor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION record_work_order_export(
  p_tenant_scope TEXT,
  p_actor_user_id TEXT,
  p_actor_role TEXT,
  p_filter_hash TEXT,
  p_field_set TEXT[],
  p_row_count INTEGER,
  p_result TEXT,
  p_diagnostic_id TEXT DEFAULT NULL
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_export_id TEXT;
  v_allowed_fields CONSTANT TEXT[] := ARRAY[
    'record_id','category','issue_type','product_ref_hash','channel','record_status',
    'opened_at','closed_at','handling_seconds','error_type','escalated','quality_tags',
    'normalization_version','import_batch_id'
  ];
BEGIN
  IF p_actor_role NOT IN ('coach','owner') THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'work-order export role denied', DETAIL = 'FORBIDDEN';
  END IF;
  IF p_tenant_scope IS NULL OR pg_catalog.btrim(p_tenant_scope) = ''
     OR p_actor_user_id IS NULL OR pg_catalog.btrim(p_actor_user_id) = ''
     OR p_filter_hash IS NULL OR p_filter_hash !~ '^[0-9a-f]{64}$'
     OR p_field_set IS NULL OR pg_catalog.cardinality(p_field_set) = 0
     OR NOT p_field_set <@ v_allowed_fields
     OR p_row_count IS NULL OR p_row_count < 0
     OR p_result NOT IN ('succeeded','denied','failed')
     OR (p_result = 'succeeded' AND p_diagnostic_id IS NOT NULL)
     OR (p_result IN ('denied','failed') AND coalesce(p_diagnostic_id, '') !~ '^diag_[0-9a-f]{32}$') THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid work-order export audit', DETAIL = 'VALIDATION';
  END IF;

  v_export_id := 'wox_' || pg_catalog.gen_random_uuid()::text;
  INSERT INTO public.work_order_export_audits(
    export_id, tenant_scope, actor_user_id, actor_role, filter_hash, field_set,
    row_count, result, diagnostic_id, created_at
  ) VALUES (
    v_export_id, p_tenant_scope, p_actor_user_id, p_actor_role, p_filter_hash,
    p_field_set, p_row_count, p_result, p_diagnostic_id, pg_catalog.clock_timestamp()
  );
  RETURN v_export_id;
END;
$$;
REVOKE ALL ON FUNCTION record_work_order_export(TEXT,TEXT,TEXT,TEXT,TEXT[],INTEGER,TEXT,TEXT) FROM PUBLIC;

CREATE TABLE IF NOT EXISTS change_audits (
  change_id    TEXT PRIMARY KEY,
  script_id    TEXT,
  action       TEXT NOT NULL,
  before_hash  TEXT,
  after_hash   TEXT,
  actor_role   TEXT,
  actor_user_id TEXT,
  source       TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_query_created ON query_events(created_at);
CREATE INDEX IF NOT EXISTS idx_query_hit ON query_events(hit_status);
CREATE INDEX IF NOT EXISTS idx_query_user ON query_events(user_id);
CREATE INDEX IF NOT EXISTS idx_query_text_expiry
  ON query_events(text_expires_at) WHERE text_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_query_event_expiry
  ON query_events(event_expires_at) WHERE event_expires_at IS NOT NULL;
DROP INDEX IF EXISTS idx_script_questions_source_query;
CREATE INDEX IF NOT EXISTS idx_script_questions_source_asset
  ON script_questions(source_asset_id);

-- ─── Multi-user content: Import → Staging → Publish → Announce ───

CREATE TABLE IF NOT EXISTS import_batches (
  import_batch_id  TEXT PRIMARY KEY,
  source_type      TEXT NOT NULL CHECK (source_type IN ('excel','csv','feishu_api','seed','other')),
  source_ref       TEXT, -- restricted upload/object locator; never expose through HTTP responses
  source_sha256    TEXT,
  source_size_bytes BIGINT CHECK (source_size_bytes IS NULL OR source_size_bytes >= 0),
  base_release_id  TEXT,
  source_binding_hash TEXT NOT NULL CHECK (source_binding_hash ~ '^[0-9a-f]{64}$'),
  status           TEXT NOT NULL CHECK (status IN (
    'validating','failed','staged','publishing','published','rolled_back'
  )),
  quality_gate_passed BOOLEAN NOT NULL DEFAULT FALSE,
  clean_count      INTEGER NOT NULL DEFAULT 0 CHECK (clean_count >= 0),
  quarantined_count INTEGER NOT NULL DEFAULT 0 CHECK (quarantined_count >= 0),
  error_report     JSONB,
  actor_user_id    TEXT,
  actor_role       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);

-- DEC-042 quality sampling is a two-step immutable protocol: freeze the plan before inspecting
-- results, then append exactly one evidence row. High-risk/conflict rows are excluded from the
-- ordinary denominator and reviewed 100% through mandatory_full_review_count.
CREATE TABLE IF NOT EXISTS content_quality_review_plans (
  plan_id                    TEXT PRIMARY KEY CHECK (
    plan_id ~ '^qplan_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'
  ),
  import_batch_id            TEXT NOT NULL UNIQUE REFERENCES import_batches(import_batch_id),
  sampling_policy_version    TEXT NOT NULL CHECK (pg_catalog.btrim(sampling_policy_version) <> ''),
  cutoff_at                  TIMESTAMPTZ NOT NULL,
  clean_population_count     INTEGER NOT NULL CHECK (clean_population_count BETWEEN 0 AND 5000),
  ordinary_population_count  INTEGER NOT NULL CHECK (ordinary_population_count >= 0),
  mandatory_full_review_count INTEGER NOT NULL CHECK (mandatory_full_review_count >= 0),
  initial_sample_target      INTEGER NOT NULL CHECK (initial_sample_target >= 0),
  expanded_sample_target     INTEGER NOT NULL CHECK (expanded_sample_target >= 0),
  selection_seed_hash        TEXT NOT NULL CHECK (selection_seed_hash ~ '^[0-9a-f]{64}$'),
  selection_manifest_hash    TEXT NOT NULL CHECK (selection_manifest_hash ~ '^[0-9a-f]{64}$'),
  population_manifest_hash   TEXT NOT NULL CHECK (population_manifest_hash ~ '^[0-9a-f]{64}$'),
  selection_algorithm        TEXT NOT NULL CHECK (selection_algorithm = 'sha256-ranked-v1'),
  frozen_at                  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT quality_plan_population_partition CHECK (
    clean_population_count = ordinary_population_count + mandatory_full_review_count
  ),
  CONSTRAINT quality_plan_initial_target CHECK (
    initial_sample_target = CASE
      WHEN ordinary_population_count <= 500 THEN ordinary_population_count
      ELSE LEAST(
        300,
        GREATEST(100, pg_catalog.ceil(ordinary_population_count * 0.10)::INTEGER)
      )
    END
  ),
  CONSTRAINT quality_plan_expanded_target CHECK (
    expanded_sample_target = CASE
      WHEN ordinary_population_count <= 500 THEN ordinary_population_count
      ELSE pg_catalog.ceil(ordinary_population_count * 0.30)::INTEGER
    END
  ),
  CONSTRAINT quality_plan_frozen_after_cutoff CHECK (frozen_at >= cutoff_at),
  CONSTRAINT quality_plan_manifest_identity UNIQUE (
    plan_id, import_batch_id, population_manifest_hash
  )
);

CREATE TABLE IF NOT EXISTS content_quality_review_evidence (
  plan_id                       TEXT PRIMARY KEY REFERENCES content_quality_review_plans(plan_id),
  import_batch_id               TEXT NOT NULL,
  population_manifest_hash      TEXT NOT NULL CHECK (population_manifest_hash ~ '^[0-9a-f]{64}$'),
  initial_sample_reviewed_count INTEGER NOT NULL CHECK (initial_sample_reviewed_count >= 0),
  initial_defect_count          INTEGER NOT NULL CHECK (
    initial_defect_count >= 0 AND initial_defect_count <= initial_sample_reviewed_count
  ),
  expanded_sample_reviewed_count INTEGER,
  expanded_defect_count          INTEGER,
  mandatory_reviewed_count       INTEGER NOT NULL CHECK (mandatory_reviewed_count >= 0),
  mandatory_defect_count         INTEGER NOT NULL CHECK (
    mandatory_defect_count >= 0 AND mandatory_defect_count <= mandatory_reviewed_count
  ),
  publishable_clean_count        INTEGER NOT NULL CHECK (publishable_clean_count >= 0),
  review_quarantined_count       INTEGER NOT NULL CHECK (review_quarantined_count >= 0),
  conclusion                     TEXT NOT NULL CHECK (conclusion IN ('passed','blocked')),
  evidence_ref                   TEXT NOT NULL CHECK (pg_catalog.btrim(evidence_ref) <> ''),
  recorded_at                    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT quality_evidence_expansion_pair CHECK (
    (expanded_sample_reviewed_count IS NULL AND expanded_defect_count IS NULL)
    OR (
      expanded_sample_reviewed_count IS NOT NULL AND expanded_sample_reviewed_count >= 0
      AND expanded_defect_count IS NOT NULL AND expanded_defect_count >= 0
      AND expanded_defect_count <= expanded_sample_reviewed_count
    )
  ),
  CONSTRAINT quality_evidence_population_fk
    FOREIGN KEY (plan_id, import_batch_id, population_manifest_hash)
    REFERENCES content_quality_review_plans(plan_id, import_batch_id, population_manifest_hash)
);

-- v1.12 upgrade closure. There are no Ddev consumers; any legacy non-empty plan without an exact
-- population identity must fail this migration instead of being silently grandfathered.
ALTER TABLE content_quality_review_plans
  ADD COLUMN IF NOT EXISTS population_manifest_hash TEXT;
ALTER TABLE content_quality_review_plans
  ALTER COLUMN population_manifest_hash SET NOT NULL;
ALTER TABLE content_quality_review_evidence
  ADD COLUMN IF NOT EXISTS import_batch_id TEXT;
ALTER TABLE content_quality_review_evidence
  ALTER COLUMN import_batch_id SET NOT NULL;
ALTER TABLE content_quality_review_evidence
  ADD COLUMN IF NOT EXISTS population_manifest_hash TEXT;
ALTER TABLE content_quality_review_evidence
  ALTER COLUMN population_manifest_hash SET NOT NULL;
DO $quality_population_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.content_quality_review_plans'::pg_catalog.regclass
      AND conname = 'quality_plan_population_manifest_shape'
  ) THEN
    ALTER TABLE content_quality_review_plans
      ADD CONSTRAINT quality_plan_population_manifest_shape
      CHECK (population_manifest_hash ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.content_quality_review_evidence'::pg_catalog.regclass
      AND conname = 'quality_evidence_population_manifest_shape'
  ) THEN
    ALTER TABLE content_quality_review_evidence
      ADD CONSTRAINT quality_evidence_population_manifest_shape
      CHECK (population_manifest_hash ~ '^[0-9a-f]{64}$');
  END IF;
  ALTER TABLE content_quality_review_evidence
    DROP CONSTRAINT IF EXISTS quality_evidence_population_fk;
  ALTER TABLE content_quality_review_plans
    DROP CONSTRAINT IF EXISTS quality_plan_manifest_identity;
  ALTER TABLE content_quality_review_plans
    ADD CONSTRAINT quality_plan_manifest_identity UNIQUE (
      plan_id, import_batch_id, population_manifest_hash
    );
  ALTER TABLE content_quality_review_evidence
    ADD CONSTRAINT quality_evidence_population_fk
    FOREIGN KEY (plan_id, import_batch_id, population_manifest_hash)
    REFERENCES content_quality_review_plans(plan_id, import_batch_id, population_manifest_hash);
END
$quality_population_constraints$;

-- Review decisions are server-side evidence, never normalized upload fields. `reviewer_subject_hash`
-- is a versioned HMAC/pseudonymous subject, not a real name or account ID. A high/conflict target must
-- have two approved rows with distinct subjects; the finalizer resolves them by (script_id,content_hash).
CREATE TABLE IF NOT EXISTS content_review_decisions (
  decision_id                 TEXT PRIMARY KEY CHECK (
    decision_id ~ '^crd_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'
  ),
  script_id                   TEXT NOT NULL CHECK (pg_catalog.btrim(script_id) <> ''),
  content_hash                TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  reviewer_role               TEXT NOT NULL CHECK (
    reviewer_role IN ('ROLE-CONTENT-LEAD','ROLE-CS-MANAGER')
  ),
  reviewer_subject_hash       TEXT NOT NULL CHECK (reviewer_subject_hash ~ '^[0-9a-f]{64}$'),
  reviewer_subject_key_version TEXT NOT NULL CHECK (
    reviewer_subject_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  evidence_ref                TEXT NOT NULL CHECK (pg_catalog.btrim(evidence_ref) <> ''),
  decision                    TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  decided_at                  TIMESTAMPTZ NOT NULL,
  recorded_at                 TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT content_review_role_once UNIQUE (script_id, content_hash, reviewer_role)
);

-- Defense in depth for the JSONB CHECK below. Authorized writers already validate this list in the
-- fenced finalizer; the immutable helper also closes JSONB duplicate/null/type gaps for privileged DML.
CREATE OR REPLACE FUNCTION public.import_issue_codes_are_public(
  p_codes JSONB
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN p_codes IS NULL THEN TRUE
    WHEN pg_catalog.jsonb_typeof(p_codes) IS DISTINCT FROM 'array' THEN FALSE
    ELSE
      pg_catalog.jsonb_array_length(p_codes) <= 26
      AND p_codes <@ '[
        "MISSING_REQUIRED_FIELD", "INVALID_FIELD_TYPE", "INVALID_VALUE",
        "DUPLICATE_SCRIPT_ID", "UNKNOWN_SCRIPT_ID", "INVALID_EFFECTIVE_WINDOW",
        "MISSING_EFFECTIVE_WINDOW", "HASH_MISMATCH", "UNSUPPORTED_FORMAT",
        "MACRO_DETECTED", "EXTERNAL_LINK_DETECTED", "ROW_LIMIT_EXCEEDED",
        "CONTENT_TOO_LARGE", "SOURCE_NOT_REGISTERED", "SOURCE_NOT_CANONICAL",
        "SOURCE_SUSPENDED", "SOURCE_DOMAIN_MISMATCH", "SOURCE_SNAPSHOT_MISMATCH",
        "SOURCE_SET_INCOMPLETE", "MISSING_PLATFORM_SCOPE", "INVALID_PRODUCT_SCOPE",
        "INVALID_TAXONOMY_REF", "INVALID_QUESTION_IDENTITY",
        "INVALID_REVIEW_EVIDENCE", "INVALID_PLACEHOLDER_TEMPLATE",
        "GOVERNANCE_HASH_MISMATCH"
      ]'::jsonb
      AND (
        SELECT pg_catalog.count(*) = pg_catalog.count(DISTINCT issue.code)
        FROM pg_catalog.jsonb_array_elements_text(p_codes) AS issue(code)
      )
  END
$$;
REVOKE ALL ON FUNCTION public.import_issue_codes_are_public(JSONB) FROM PUBLIC;

-- Row-quality issues are safe to expose in import preview. They never convert a malformed,
-- unsafe or unbound row into a quarantined row; those failures remain batch-fatal above.
CREATE OR REPLACE FUNCTION public.content_quality_issue_codes_are_public(
  p_codes JSONB
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN pg_catalog.jsonb_typeof(p_codes) IS DISTINCT FROM 'array' THEN FALSE
    ELSE
      pg_catalog.jsonb_array_length(p_codes) <= 8
      AND p_codes <@ '[
        "UNKNOWN_INTENT", "INTENT_MAPPING_REQUIRED", "UNRESOLVED_CONFLICT",
        "REVIEW_EVIDENCE_MISSING", "QUESTION_DUPLICATE",
        "QUESTION_HASH_MISMATCH", "QUESTION_ORIGIN_UNVERIFIED",
        "CONTENT_NEEDS_REVIEW"
      ]'::jsonb
      AND (
        SELECT pg_catalog.count(*) = pg_catalog.count(DISTINCT issue.code)
        FROM pg_catalog.jsonb_array_elements_text(p_codes) AS issue(code)
      )
  END
$$;
REVOKE ALL ON FUNCTION public.content_quality_issue_codes_are_public(JSONB) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.work_order_issue_codes_are_public(
  p_codes JSONB
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN p_codes IS NULL THEN TRUE
    WHEN pg_catalog.jsonb_typeof(p_codes) IS DISTINCT FROM 'array' THEN FALSE
    ELSE
      pg_catalog.jsonb_array_length(p_codes) <= 13
      AND p_codes <@ '[
        "MISSING_REQUIRED_FIELD", "INVALID_FIELD_TYPE", "INVALID_VALUE",
        "DUPLICATE_SOURCE_RECORD", "UNKNOWN_COLUMN", "SENSITIVE_COLUMN",
        "INVALID_DATE", "INVALID_DURATION", "HASH_MISMATCH",
        "UNSUPPORTED_FORMAT", "FORMULA_DETECTED", "ROW_LIMIT_EXCEEDED",
        "FILE_TOO_LARGE"
      ]'::jsonb
      AND (
        SELECT pg_catalog.count(*) = pg_catalog.count(DISTINCT issue.code)
        FROM pg_catalog.jsonb_array_elements_text(p_codes) AS issue(code)
      )
  END
$$;
REVOKE ALL ON FUNCTION public.work_order_issue_codes_are_public(JSONB) FROM PUBLIC;

-- Requested source bindings are an immutable input to one import. base_release_id lives on the batch;
-- publish later compares it with content_current before it may switch the four-domain source set.
CREATE TABLE IF NOT EXISTS import_batch_source_bindings (
  import_batch_id    TEXT NOT NULL REFERENCES import_batches(import_batch_id),
  domain             TEXT NOT NULL CHECK (domain IN ('presale','campaign','aftersale','product')),
  source_version_id  TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (import_batch_id, domain),
  CONSTRAINT import_batch_source_binding_triple_unique
    UNIQUE (import_batch_id, domain, source_version_id),
  CONSTRAINT import_batch_source_version_fk
    FOREIGN KEY (source_version_id, domain)
    REFERENCES authoritative_source_versions(source_version_id, domain)
);

-- Staging rows: not searchable until publish succeeds
CREATE TABLE IF NOT EXISTS staging_scripts (
  staging_id       TEXT PRIMARY KEY,
  import_batch_id  TEXT NOT NULL REFERENCES import_batches(import_batch_id),
  script_id        TEXT NOT NULL,
  operation        TEXT NOT NULL DEFAULT 'upsert' CHECK (operation IN ('upsert','withdraw')),
  category         TEXT NOT NULL CHECK (category IN ('presale','campaign','aftersale','product')),
  title            TEXT,
  answer_text      TEXT,
  content_hash     TEXT,
  source_ref       TEXT NOT NULL CHECK (source_ref ~ '^SRC-[A-Z0-9][A-Z0-9._-]{0,126}$'),
  source_version_id TEXT NOT NULL,
  owner_role       TEXT,
  review_due_at    TIMESTAMPTZ,
  platform_scope   TEXT[],
  product_scope_type TEXT,
  product_scope_refs TEXT[],
  campaign_tag     TEXT,
  effective_from   TIMESTAMPTZ,
  effective_to     TIMESTAMPTZ,
  intent_taxonomy_version TEXT,
  intent_id        TEXT,
  risk_level       TEXT,
  risk_categories  TEXT[],
  has_conflict     BOOLEAN,
  review_mode      TEXT,
  primary_reviewer_id TEXT,
  primary_reviewer_role TEXT,
  primary_review_evd TEXT,
  secondary_reviewer_id TEXT,
  secondary_reviewer_role TEXT,
  secondary_review_evd TEXT,
  placeholder_keys TEXT[],
  questions_json   JSONB NOT NULL DEFAULT '[]'::jsonb,
  search_document  TSVECTOR,
  search_fallback_text TEXT,
  validation_ok    BOOLEAN NOT NULL DEFAULT FALSE,
  validation_errors TEXT,
  quality_status   TEXT NOT NULL CHECK (quality_status IN ('clean','quarantined')),
  quality_issue_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  quality_gate_passed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT staging_questions_array CHECK (
    operation = 'withdraw' OR public.content_questions_align_intent(
      questions_json, intent_taxonomy_version, intent_id
    )
  ),
  CONSTRAINT staging_quality_issue_codes CHECK (
    public.content_quality_issue_codes_are_public(quality_issue_codes)
  ),
  CONSTRAINT staging_quality_shape CHECK (
    (
      quality_status = 'clean'
      AND quality_issue_codes = '[]'::jsonb
      AND quality_gate_passed
    ) OR (
      quality_status = 'quarantined'
      AND pg_catalog.jsonb_array_length(quality_issue_codes) > 0
      AND NOT quality_gate_passed
    )
  ),
  CONSTRAINT staging_operation_shape CHECK (
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
      AND review_mode IN ('single','dual')
      AND primary_reviewer_id ~ '^[0-9a-f]{64}$'
      AND primary_reviewer_role = 'ROLE-CONTENT-LEAD'
      AND primary_review_evd IS NOT NULL AND pg_catalog.btrim(primary_review_evd) <> ''
      AND (
        (
          (risk_level = 'high' OR has_conflict)
          AND review_mode = 'dual'
          AND secondary_reviewer_id IS NOT NULL
          AND secondary_reviewer_id ~ '^[0-9a-f]{64}$'
          AND secondary_reviewer_id <> primary_reviewer_id
          AND secondary_reviewer_role = 'ROLE-CS-MANAGER'
          AND secondary_review_evd IS NOT NULL
          AND pg_catalog.btrim(secondary_review_evd) <> ''
        ) OR (
          risk_level IN ('low','medium') AND NOT has_conflict
          AND review_mode = 'single'
          AND secondary_reviewer_id IS NULL AND secondary_reviewer_role IS NULL
          AND secondary_review_evd IS NULL
        )
      )
      AND public.content_template_placeholders_are_valid(answer_text, placeholder_keys)
      AND content_hash ~ '^[0-9a-f]{64}$' AND search_document IS NOT NULL
      AND pg_catalog.length(search_document) > 0
      AND search_fallback_text IS NOT NULL AND pg_catalog.btrim(search_fallback_text) <> ''
    )
  ),
  CONSTRAINT staging_source_version_fk
    FOREIGN KEY (source_version_id, category, source_ref)
    REFERENCES authoritative_source_versions(source_version_id, domain, source_ref),
  CONSTRAINT staging_batch_source_binding_fk
    FOREIGN KEY (import_batch_id, category, source_version_id)
    REFERENCES import_batch_source_bindings(import_batch_id, domain, source_version_id),
  CONSTRAINT staging_batch_script_unique UNIQUE (import_batch_id, script_id)
);

CREATE INDEX IF NOT EXISTS idx_staging_batch ON staging_scripts(import_batch_id);

-- Recompute the quality population identity from rows actually persisted by the fenced finalizer.
-- This is intentionally a safe tuple projection; reviewer subjects, source locators and free text
-- never enter the long-lived quality evidence identity.
CREATE OR REPLACE FUNCTION public.content_quality_staging_population_manifest_hash(
  p_import_batch_id TEXT
) RETURNS TEXT
LANGUAGE sql
STABLE
STRICT
PARALLEL RESTRICTED
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.content_quality_population_manifest_hash(
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'staging_id', staged.staging_id,
          'script_id', staged.script_id,
          'operation', staged.operation,
          'content_hash', staged.content_hash,
          'risk_level', staged.risk_level,
          'has_conflict', staged.has_conflict,
          'quality_status', staged.quality_status
        ) ORDER BY staged.staging_id COLLATE "C"
      ),
      '[]'::jsonb
    )
  )
  FROM public.staging_scripts staged
  WHERE staged.import_batch_id = p_import_batch_id
$$;
REVOKE ALL ON FUNCTION public.content_quality_staging_population_manifest_hash(TEXT) FROM PUBLIC;

-- Immutable publish unit
CREATE TABLE IF NOT EXISTS content_releases (
  release_id       TEXT PRIMARY KEY,
  release_seq      BIGINT NOT NULL UNIQUE,
  title            TEXT,
  summary          TEXT,
  import_batch_id  TEXT REFERENCES import_batches(import_batch_id),
  rollback_of_release_id TEXT REFERENCES content_releases(release_id),
  status           TEXT NOT NULL CHECK (status IN ('published','superseded','rolled_back')),
  source_binding_hash TEXT NOT NULL CHECK (source_binding_hash ~ '^[0-9a-f]{64}$'),
  published_by     TEXT,
  published_by_role TEXT,
  published_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_release_source_binding_hash
  ON content_releases(release_id, source_binding_hash);

-- One immutable source version per domain, exactly four rows per release. A deferred constraint trigger
-- below checks completeness after the release row, bindings and items have been built in one transaction.
CREATE TABLE IF NOT EXISTS release_source_bindings (
  release_id         TEXT NOT NULL REFERENCES content_releases(release_id),
  domain             TEXT NOT NULL CHECK (domain IN ('presale','campaign','aftersale','product')),
  source_version_id  TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (release_id, domain),
  CONSTRAINT release_source_binding_triple_unique
    UNIQUE (release_id, domain, source_version_id),
  CONSTRAINT release_source_version_fk
    FOREIGN KEY (source_version_id, domain)
    REFERENCES authoritative_source_versions(source_version_id, domain)
);

-- Snapshot of each script body AT publish time (immutable history)
CREATE TABLE IF NOT EXISTS release_items (
  release_id       TEXT NOT NULL REFERENCES content_releases(release_id),
  script_id        TEXT NOT NULL,
  script_version   INTEGER NOT NULL,
  content_hash     TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  answer_text      TEXT NOT NULL,  -- frozen copy; phase1 search answers must match SoR or this snapshot
  title            TEXT NOT NULL,
  category         TEXT NOT NULL CHECK (category IN ('presale','campaign','aftersale','product')),
  source_ref       TEXT NOT NULL CHECK (pg_catalog.btrim(source_ref) <> ''),
  source_version_id TEXT NOT NULL,
  owner_role       TEXT NOT NULL CHECK (pg_catalog.btrim(owner_role) <> ''),
  review_due_at    TIMESTAMPTZ NOT NULL,
  effective_from   TIMESTAMPTZ NOT NULL,
  effective_to     TIMESTAMPTZ,
  platform_scope   TEXT[] NOT NULL,
  product_scope_type TEXT NOT NULL CHECK (product_scope_type IN ('storewide','category','sku')),
  product_scope_refs TEXT[] NOT NULL,
  intent_taxonomy_version TEXT NOT NULL,
  intent_id        TEXT NOT NULL,
  risk_level       TEXT NOT NULL CHECK (risk_level IN ('low','medium','high')),
  risk_categories  TEXT[] NOT NULL,
  has_conflict     BOOLEAN NOT NULL,
  review_mode      TEXT NOT NULL CHECK (review_mode IN ('single','dual')),
  primary_reviewer_id TEXT NOT NULL CHECK (primary_reviewer_id ~ '^[0-9a-f]{64}$'),
  primary_reviewer_role TEXT NOT NULL CHECK (primary_reviewer_role = 'ROLE-CONTENT-LEAD'),
  primary_review_evd TEXT NOT NULL CHECK (pg_catalog.btrim(primary_review_evd) <> ''),
  secondary_reviewer_id TEXT,
  secondary_reviewer_role TEXT,
  secondary_review_evd TEXT,
  placeholder_keys TEXT[] NOT NULL,
  questions_json   JSONB NOT NULL,
  search_document  TSVECTOR NOT NULL,
  search_fallback_text TEXT NOT NULL,
  PRIMARY KEY (release_id, script_id),
  CONSTRAINT release_questions_array CHECK (
    public.content_questions_align_intent(questions_json, intent_taxonomy_version, intent_id)
  ),
  CONSTRAINT release_effective_window CHECK (
    effective_to IS NULL OR effective_from < effective_to
  ),
  CONSTRAINT release_platform_scope CHECK (
    public.content_text_array_is_nonblank_unique(platform_scope)
    AND pg_catalog.cardinality(platform_scope) > 0
    AND platform_scope <@ ARRAY['qianniu','douyin']::TEXT[]
  ),
  CONSTRAINT release_product_scope CHECK (
    public.content_text_array_is_nonblank_unique(product_scope_refs)
    AND (
      (product_scope_type = 'storewide' AND pg_catalog.cardinality(product_scope_refs) = 0)
      OR (product_scope_type IN ('category','sku') AND pg_catalog.cardinality(product_scope_refs) > 0)
    )
  ),
  CONSTRAINT release_review_shape CHECK (
    (
      (risk_level = 'high' OR has_conflict)
      AND review_mode = 'dual'
      AND secondary_reviewer_id IS NOT NULL
      AND secondary_reviewer_id ~ '^[0-9a-f]{64}$'
      AND secondary_reviewer_id <> primary_reviewer_id
      AND secondary_reviewer_role = 'ROLE-CS-MANAGER'
      AND secondary_review_evd IS NOT NULL
      AND pg_catalog.btrim(secondary_review_evd) <> ''
    ) OR (
      risk_level IN ('low','medium') AND NOT has_conflict
      AND review_mode = 'single'
      AND secondary_reviewer_id IS NULL AND secondary_reviewer_role IS NULL
      AND secondary_review_evd IS NULL
    )
  ),
  CONSTRAINT release_risk_categories CHECK (
    public.content_risk_categories_are_valid(risk_level, risk_categories)
  ),
  CONSTRAINT release_placeholders CHECK (
    public.content_template_placeholders_are_valid(answer_text, placeholder_keys)
  ),
  CONSTRAINT release_text_nonempty CHECK (
    pg_catalog.btrim(title) <> '' AND pg_catalog.btrim(answer_text) <> ''
    AND pg_catalog.btrim(search_fallback_text) <> ''
  ),
  CONSTRAINT release_item_source_version_fk
    FOREIGN KEY (source_version_id, category, source_ref)
    REFERENCES authoritative_source_versions(source_version_id, domain, source_ref),
  CONSTRAINT release_item_source_binding_fk
    FOREIGN KEY (release_id, category, source_version_id)
    REFERENCES release_source_bindings(release_id, domain, source_version_id),
  CONSTRAINT release_item_intent_fk
    FOREIGN KEY (intent_taxonomy_version, intent_id)
    REFERENCES intent_taxonomy_entries(intent_taxonomy_version, intent_id),
  CONSTRAINT release_search_document_nonempty CHECK (pg_catalog.length(search_document) > 0)
);

CREATE INDEX IF NOT EXISTS idx_release_items_search_document
  ON release_items USING GIN (search_document);
CREATE INDEX IF NOT EXISTS idx_release_items_search_fallback_trgm
  ON release_items USING GIN (search_fallback_text gin_trgm_ops);

CREATE TABLE IF NOT EXISTS content_current (
  id                   INT PRIMARY KEY CHECK (id = 1),
  current_release_id   TEXT NOT NULL REFERENCES content_releases(release_id),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS announcements (
  announcement_id  TEXT PRIMARY KEY,
  release_id       TEXT NOT NULL REFERENCES content_releases(release_id),
  title            TEXT NOT NULL,
  summary          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Short, immutable offline entitlement. Only the SHA-256 of the bearer token is stored; the token
-- returned once by issue_snapshot_offline_lease is bound to one client/user/release/source-set and
-- expires within 15 minutes. ACK records use but can never extend or replace this expiry.
CREATE TABLE IF NOT EXISTS snapshot_offline_leases (
  lease_token_hash    TEXT PRIMARY KEY CHECK (lease_token_hash ~ '^[0-9a-f]{64}$'),
  client_id           TEXT NOT NULL CHECK (pg_catalog.btrim(client_id) <> ''),
  user_id             TEXT NOT NULL CHECK (pg_catalog.btrim(user_id) <> ''),
  release_id          TEXT NOT NULL,
  source_binding_hash TEXT NOT NULL CHECK (source_binding_hash ~ '^[0-9a-f]{64}$'),
  issued_at           TIMESTAMPTZ NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT snapshot_offline_lease_release_fk
    FOREIGN KEY (release_id, source_binding_hash)
    REFERENCES content_releases(release_id, source_binding_hash),
  CONSTRAINT snapshot_offline_lease_window CHECK (
    expires_at > issued_at
    AND expires_at <= issued_at + INTERVAL '15 minutes'
  )
);

-- Rejected source operations are audited only after the rejected business transaction rolls back.
-- This table intentionally contains no raw query, internal source locator, token or stack trace.
CREATE TABLE IF NOT EXISTS source_denial_audits (
  denial_key          TEXT PRIMARY KEY CHECK (denial_key ~ '^sda_[0-9a-f]{64}$'),
  operation           TEXT NOT NULL CHECK (operation IN (
    'content_import','content_publish','content_rollback','search',
    'announce_current','announce_snapshot','announce_ack','source_suspend'
  )),
  reason_code         TEXT NOT NULL CHECK (reason_code IN (
    'SOURCE_NOT_REGISTERED','SOURCE_NOT_ELIGIBLE','SOURCE_SUSPENDED',
    'SOURCE_DOMAIN_MISMATCH','SOURCE_SNAPSHOT_MISMATCH','SOURCE_SET_INCOMPLETE',
    'SOURCE_BASE_RELEASE_STALE','SOURCE_BINDING_HASH_MISMATCH','SOURCE_GATE_NOT_READY',
    'OFFLINE_LEASE_INVALID','OFFLINE_LEASE_EXPIRED','OFFLINE_LEASE_BINDING_MISMATCH'
  )),
  actor_subject_hash  TEXT NOT NULL CHECK (actor_subject_hash ~ '^[0-9a-f]{64}$'),
  hash_key_version    TEXT NOT NULL CHECK (pg_catalog.btrim(hash_key_version) <> ''),
  actor_role          TEXT NOT NULL CHECK (actor_role IN ('agent','coach','owner')),
  release_id          TEXT CHECK (release_id IS NULL OR pg_catalog.btrim(release_id) <> ''),
  source_version_id   TEXT CHECK (
    source_version_id IS NULL OR source_version_id ~ '^srcv_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'
  ),
  source_binding_hash TEXT CHECK (
    source_binding_hash IS NULL OR source_binding_hash ~ '^[0-9a-f]{64}$'
  ),
  diagnostic_id       TEXT NOT NULL CHECK (diagnostic_id ~ '^diag_[0-9a-f]{32}$'),
  committed_at        TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE IF NOT EXISTS client_sync_state (
  client_id              TEXT PRIMARY KEY,
  user_id                TEXT,
  last_seen_release_id   TEXT,
  last_seen_release_seq  BIGINT,
  last_seen_source_binding_hash TEXT,
  last_ack_lease_token_hash TEXT,
  last_ack_at            TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE client_sync_state ADD COLUMN IF NOT EXISTS last_seen_source_binding_hash TEXT;
ALTER TABLE client_sync_state ADD COLUMN IF NOT EXISTS last_ack_lease_token_hash TEXT;
-- Legacy ACKs have no cryptographic source-set/lease binding and therefore cannot authorize offline use.
-- Reset only the derived sync cursor; clients must obtain a fresh short lease and ACK again.
UPDATE client_sync_state
SET last_seen_release_id = NULL,
    last_seen_release_seq = NULL,
    last_seen_source_binding_hash = NULL,
    last_ack_lease_token_hash = NULL,
    last_ack_at = NULL,
    updated_at = pg_catalog.clock_timestamp()
WHERE last_seen_release_id IS NOT NULL
  AND (last_seen_source_binding_hash IS NULL OR last_ack_lease_token_hash IS NULL);

CREATE INDEX IF NOT EXISTS idx_announcements_release ON announcements(release_id);
CREATE INDEX IF NOT EXISTS idx_release_seq ON content_releases(release_seq);

-- Provenance closure. Search is disabled until a release exists, therefore every recorded query and
-- candidate must point to the exact immutable snapshot used for that answer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_query_release
  ON query_events(query_id, release_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_release_id_seq
  ON content_releases(release_id, release_seq);
CREATE UNIQUE INDEX IF NOT EXISTS uq_release_item_provenance
  ON release_items(release_id, script_id, script_version, content_hash);

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.query_events'::pg_catalog.regclass AND conname = 'query_release_fk') THEN
    ALTER TABLE query_events
      ADD CONSTRAINT query_release_fk
      FOREIGN KEY (release_id) REFERENCES content_releases(release_id);
  END IF;
  ALTER TABLE script_questions DROP CONSTRAINT IF EXISTS script_question_source_query_fk;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.script_questions'::pg_catalog.regclass
      AND conname = 'script_question_source_asset_fk'
  ) THEN
    ALTER TABLE script_questions
      ADD CONSTRAINT script_question_source_asset_fk
      FOREIGN KEY (
        source_asset_id, source, origin_fingerprint_key_version, origin_fingerprint
      ) REFERENCES semantic_source_assets(
        source_asset_id, source, origin_fingerprint_key_version, origin_fingerprint
      ) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.candidate_impressions'::pg_catalog.regclass AND conname = 'candidate_query_release_fk') THEN
    ALTER TABLE candidate_impressions
      ADD CONSTRAINT candidate_query_release_fk
      FOREIGN KEY (query_id, release_id) REFERENCES query_events(query_id, release_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.candidate_impressions'::pg_catalog.regclass AND conname = 'candidate_release_item_fk') THEN
    ALTER TABLE candidate_impressions
      ADD CONSTRAINT candidate_release_item_fk
      FOREIGN KEY (release_id, script_id) REFERENCES release_items(release_id, script_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.candidate_impressions'::pg_catalog.regclass AND conname = 'candidate_release_item_provenance_fk') THEN
    ALTER TABLE candidate_impressions
      ADD CONSTRAINT candidate_release_item_provenance_fk
      FOREIGN KEY (release_id, script_id, script_version, content_hash)
      REFERENCES release_items(release_id, script_id, script_version, content_hash);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.escalate_actions'::pg_catalog.regclass AND conname = 'escalate_query_owner_fk') THEN
    ALTER TABLE escalate_actions
      ADD CONSTRAINT escalate_query_owner_fk
      FOREIGN KEY (query_id, user_id) REFERENCES query_events(query_id, user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.client_sync_state'::pg_catalog.regclass AND conname = 'client_sync_release_pair_shape') THEN
    ALTER TABLE client_sync_state
      ADD CONSTRAINT client_sync_release_pair_shape CHECK (
        (last_seen_release_id IS NULL AND last_seen_release_seq IS NULL)
        OR (last_seen_release_id IS NOT NULL AND last_seen_release_seq IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.client_sync_state'::pg_catalog.regclass AND conname = 'client_sync_release_pair_fk') THEN
    ALTER TABLE client_sync_state
      ADD CONSTRAINT client_sync_release_pair_fk
      FOREIGN KEY (last_seen_release_id, last_seen_release_seq)
      REFERENCES content_releases(release_id, release_seq);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.client_sync_state'::pg_catalog.regclass AND conname = 'client_sync_lease_shape') THEN
    ALTER TABLE client_sync_state
      ADD CONSTRAINT client_sync_lease_shape CHECK (
        (
          last_seen_release_id IS NULL
          AND last_seen_release_seq IS NULL
          AND last_seen_source_binding_hash IS NULL
          AND last_ack_lease_token_hash IS NULL
        )
        OR (
          user_id IS NOT NULL
          AND last_seen_release_id IS NOT NULL
          AND last_seen_release_seq IS NOT NULL
          AND last_seen_source_binding_hash ~ '^[0-9a-f]{64}$'
          AND last_ack_lease_token_hash ~ '^[0-9a-f]{64}$'
        )
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.client_sync_state'::pg_catalog.regclass AND conname = 'client_sync_source_binding_fk') THEN
    ALTER TABLE client_sync_state
      ADD CONSTRAINT client_sync_source_binding_fk
      FOREIGN KEY (last_seen_release_id, last_seen_source_binding_hash)
      REFERENCES content_releases(release_id, source_binding_hash);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.client_sync_state'::pg_catalog.regclass AND conname = 'client_sync_lease_token_fk') THEN
    ALTER TABLE client_sync_state
      ADD CONSTRAINT client_sync_lease_token_fk
      FOREIGN KEY (last_ack_lease_token_hash)
      REFERENCES snapshot_offline_leases(lease_token_hash);
  END IF;
  -- v1.12 deliberately replaces the named constraint. IF NOT EXISTS would leave an upgraded
  -- database with the old enum and make valid finalizer failures roll back the whole transaction.
  ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batch_error_report_shape;
  ALTER TABLE import_batches
    ADD CONSTRAINT import_batch_error_report_shape CHECK (
        ((
          status = 'failed'
          AND error_report IS NOT NULL
          AND pg_catalog.jsonb_typeof(error_report) = 'object'
          AND error_report ?& ARRAY['code','diagnostic_id']
          AND error_report ->> 'code' IN (
            'CANCELLED', 'MAX_ATTEMPTS_EXHAUSTED', 'VALIDATION_FAILED',
            'SOURCE_UNREADABLE', 'HASH_MISMATCH', 'UNSUPPORTED_FORMAT',
            'STORAGE_UNAVAILABLE', 'SOURCE_NOT_ELIGIBLE', 'SOURCE_SUSPENDED',
            'SOURCE_DOMAIN_MISMATCH', 'SOURCE_SNAPSHOT_MISMATCH', 'SOURCE_SET_INCOMPLETE',
            'CONTENT_CONTRACT_INVALID', 'GOVERNANCE_HASH_MISMATCH'
          )
          AND coalesce(error_report ->> 'diagnostic_id', '') ~ '^diag_[0-9a-f]{32}$'
          AND (
            (
              error_report ->> 'code' = 'CANCELLED'
              AND error_report - ARRAY['code','diagnostic_id'] = '{}'::jsonb
            )
            OR (
              error_report ->> 'code' = 'MAX_ATTEMPTS_EXHAUSTED'
              AND error_report ?& ARRAY['attempts','max_attempts']
              AND error_report - ARRAY['code','diagnostic_id','attempts','max_attempts'] = '{}'::jsonb
              AND pg_catalog.jsonb_typeof(error_report -> 'attempts') = 'number'
              AND error_report ->> 'attempts' ~ '^[1-9][0-9]{0,8}$'
              AND pg_catalog.jsonb_typeof(error_report -> 'max_attempts') = 'number'
              AND error_report ->> 'max_attempts' ~ '^[1-9][0-9]{0,8}$'
            )
            OR (
              error_report ->> 'code' IN (
                'VALIDATION_FAILED', 'SOURCE_UNREADABLE', 'HASH_MISMATCH',
                'UNSUPPORTED_FORMAT', 'STORAGE_UNAVAILABLE', 'SOURCE_NOT_ELIGIBLE',
                'SOURCE_SUSPENDED', 'SOURCE_DOMAIN_MISMATCH', 'SOURCE_SNAPSHOT_MISMATCH',
                'SOURCE_SET_INCOMPLETE', 'CONTENT_CONTRACT_INVALID',
                'GOVERNANCE_HASH_MISMATCH'
              )
              AND error_report - ARRAY['code','diagnostic_id','row','column','error_count','issue_codes'] = '{}'::jsonb
              AND CASE WHEN error_report ? 'row' THEN
                pg_catalog.jsonb_typeof(error_report -> 'row') = 'number'
                AND error_report ->> 'row' ~ '^[1-9][0-9]{0,8}$'
              ELSE TRUE END
              AND CASE WHEN error_report ? 'column' THEN
                pg_catalog.jsonb_typeof(error_report -> 'column') = 'number'
                AND error_report ->> 'column' ~ '^[1-9][0-9]{0,8}$'
              ELSE TRUE END
              AND CASE WHEN error_report ? 'error_count' THEN
                pg_catalog.jsonb_typeof(error_report -> 'error_count') = 'number'
                AND error_report ->> 'error_count' ~ '^[1-9][0-9]{0,8}$'
              ELSE TRUE END
              AND public.import_issue_codes_are_public(error_report -> 'issue_codes')
            )
          )
        ) IS TRUE)
        OR ((
          status <> 'failed'
          AND error_report IS NULL
        ) IS TRUE)
    );
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.import_batches'::pg_catalog.regclass AND conname = 'import_batch_base_release_fk') THEN
    ALTER TABLE import_batches
      ADD CONSTRAINT import_batch_base_release_fk
      FOREIGN KEY (base_release_id) REFERENCES content_releases(release_id);
  END IF;
END
$constraints$;

DO $work_order_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.work_order_import_batches'::pg_catalog.regclass
      AND conname = 'work_order_import_error_report_shape'
  ) THEN
    ALTER TABLE work_order_import_batches
      ADD CONSTRAINT work_order_import_error_report_shape CHECK (
        ((
          status = 'failed'
          AND error_report IS NOT NULL
          AND pg_catalog.jsonb_typeof(error_report) = 'object'
          AND error_report ?& ARRAY['code','diagnostic_id']
          AND error_report ->> 'code' IN (
            'VALIDATION_FAILED','SOURCE_UNREADABLE','HASH_MISMATCH',
            'UNSUPPORTED_FORMAT','STORAGE_UNAVAILABLE','MAX_ATTEMPTS_EXHAUSTED'
          )
          AND coalesce(error_report ->> 'diagnostic_id', '') ~ '^diag_[0-9a-f]{32}$'
          AND error_report - ARRAY[
            'code','diagnostic_id','row','column','error_count','issue_codes'
          ] = '{}'::jsonb
          AND CASE WHEN error_report ? 'row' THEN
            pg_catalog.jsonb_typeof(error_report -> 'row') = 'number'
            AND error_report ->> 'row' ~ '^[1-9][0-9]{0,8}$'
          ELSE TRUE END
          AND CASE WHEN error_report ? 'column' THEN
            pg_catalog.jsonb_typeof(error_report -> 'column') = 'number'
            AND error_report ->> 'column' ~ '^[1-9][0-9]{0,8}$'
          ELSE TRUE END
          AND CASE WHEN error_report ? 'error_count' THEN
            pg_catalog.jsonb_typeof(error_report -> 'error_count') = 'number'
            AND error_report ->> 'error_count' ~ '^[1-9][0-9]{0,8}$'
          ELSE TRUE END
          AND public.work_order_issue_codes_are_public(error_report -> 'issue_codes')
        ) IS TRUE)
        OR ((status <> 'failed' AND error_report IS NULL) IS TRUE)
      );
  END IF;
END
$work_order_constraints$;

-- Policy flags (phase plugs). Phase1: rewrite=false, auto_send=false.
CREATE TABLE IF NOT EXISTS policy_flags (
  flag_key     TEXT PRIMARY KEY,
  flag_value   BOOLEAN NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT
);

INSERT INTO policy_flags (flag_key, flag_value) VALUES
  ('rewrite', FALSE),
  ('auto_send', FALSE),
  ('autofill_adapter', FALSE),
  ('llm_ranker', FALSE),
  ('metrics_experimental_kpi', FALSE)
ON CONFLICT (flag_key) DO NOTHING;

-- Upgrade safety is fail-closed: a legacy/customized database must not retain dangerous phase1 flags.
-- This UPDATE is intentionally unconditional and is an executable migration invariant, not a default only.
UPDATE policy_flags
SET flag_value = FALSE,
    updated_at = now(),
    updated_by = 'schema.v1.3.phase1-hard-off'
WHERE flag_key IN ('rewrite', 'auto_send')
  AND flag_value IS DISTINCT FROM FALSE;

-- AUTH_MODE is deployment config, not a mutable policy flag. Remove legacy ambiguity.
DELETE FROM policy_flags WHERE flag_key = 'mock_auth';

-- ─── NFR v1.3: architecture-contract invariants (static evidence, not runtime certification) ───

-- Tenant reserve (phase1 always 'default')
ALTER TABLE scripts ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE query_events ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE content_releases ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

-- Enrich immutable snapshot (questions + DEC-042 governance frozen at publish)
ALTER TABLE scripts ADD COLUMN IF NOT EXISTS questions_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE release_items ADD COLUMN IF NOT EXISTS platform_scope TEXT[];
ALTER TABLE release_items ADD COLUMN IF NOT EXISTS product_scope_type TEXT;
ALTER TABLE release_items ADD COLUMN IF NOT EXISTS product_scope_refs TEXT[];
ALTER TABLE release_items ADD COLUMN IF NOT EXISTS questions_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE release_items ADD COLUMN IF NOT EXISTS search_document TSVECTOR;
ALTER TABLE release_items ADD COLUMN IF NOT EXISTS search_fallback_text TEXT;
ALTER TABLE staging_scripts ADD COLUMN IF NOT EXISTS operation TEXT NOT NULL DEFAULT 'upsert';
ALTER TABLE staging_scripts ADD COLUMN IF NOT EXISTS search_document TSVECTOR;
ALTER TABLE staging_scripts ADD COLUMN IF NOT EXISTS search_fallback_text TEXT;
ALTER TABLE content_releases ADD COLUMN IF NOT EXISTS rollback_of_release_id TEXT REFERENCES content_releases(release_id);
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS source_sha256 TEXT;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS source_size_bytes BIGINT;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS quality_gate_passed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS clean_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS quarantined_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE change_audits ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE query_events ADD COLUMN IF NOT EXISTS request_hash TEXT;
ALTER TABLE query_events ADD COLUMN IF NOT EXISTS request_hash_key_version TEXT;
ALTER TABLE query_events ADD COLUMN IF NOT EXISTS hash_key_version TEXT;

-- Existing v1 data must be backfilled by the same-version import validator before a follow-up
-- migration applies NOT NULL to search_document/search_fallback_text/request_hash/hash_key_version.
-- Never backfill an empty tsvector merely to make the constraint green.

-- Idempotency concurrent state machine
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope            TEXT NOT NULL,  -- e.g. 'publish'|'/v1/events/adoption'|user-scoped route
  idem_key         TEXT NOT NULL,
  user_id          TEXT,
  request_hash     TEXT NOT NULL,   -- versioned HMAC for PII-capable bodies; SHA-256/JCS otherwise
  request_hash_key_version TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
  status_code      INT,
  response_body    JSONB,
  lease_owner      TEXT,           -- instance_id that claimed pending
  lease_version    BIGINT NOT NULL DEFAULT 1,
  lease_expires_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope, idem_key)
);
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS lease_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS request_hash_key_version TEXT;
CREATE INDEX IF NOT EXISTS idx_idem_expires ON idempotency_keys(expires_at);
CREATE INDEX IF NOT EXISTS idx_idem_status ON idempotency_keys(status);

-- Cross-instance rate limit (token bucket in Postgres; Redis optional later)
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key     TEXT PRIMARY KEY,  -- 'global:search' | 'user:{id}:search' | ...
  tokens         DOUBLE PRECISION NOT NULL,
  capacity       DOUBLE PRECISION NOT NULL,
  refill_per_sec DOUBLE PRECISION NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Outbox + rewrite job type
CREATE TABLE IF NOT EXISTS outbox_jobs (
  job_id       TEXT PRIMARY KEY,
  job_type     TEXT NOT NULL CHECK (job_type IN (
    'import_validate','work_order_import_validate','event_upload','announce_fanout','rewrite_candidate','other'
  )),
  payload      JSONB NOT NULL,
  status       TEXT NOT NULL CHECK (status IN (
    'pending','running','done','failed','dead'
  )),
  attempts     INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner  TEXT,
  lease_version BIGINT NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  last_error   TEXT,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE outbox_jobs ADD COLUMN IF NOT EXISTS lease_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE outbox_jobs ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 5;
ALTER TABLE outbox_jobs ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE outbox_jobs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_outbox_claim_v13
  ON outbox_jobs(job_type, status, available_at, lease_expires_at, created_at);

DO $outbox_constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.outbox_jobs'::pg_catalog.regclass AND conname = 'outbox_max_attempts_range') THEN
    ALTER TABLE outbox_jobs
      ADD CONSTRAINT outbox_max_attempts_range CHECK (max_attempts BETWEEN 1 AND 20);
  END IF;
END
$outbox_constraints$;

CREATE SEQUENCE IF NOT EXISTS content_release_seq START 1;
DO $release_sequence_alignment$
DECLARE
  v_max_release_seq BIGINT;
  v_sequence_last BIGINT;
  v_sequence_called BOOLEAN;
BEGIN
  SELECT pg_catalog.max(release_seq) INTO v_max_release_seq FROM public.content_releases;
  SELECT last_value, is_called INTO v_sequence_last, v_sequence_called FROM public.content_release_seq;
  IF v_max_release_seq IS NOT NULL
     AND (v_sequence_last < v_max_release_seq OR (v_sequence_last = v_max_release_seq AND NOT v_sequence_called)) THEN
    PERFORM pg_catalog.setval('public.content_release_seq'::pg_catalog.regclass, v_max_release_seq, TRUE);
  END IF;
END
$release_sequence_alignment$;

-- CR-004 history is append-only even inside a publishing transaction. Publish and rollback create a
-- new release; neither path needs UPDATE/DELETE on release_items or source-binding history.
CREATE OR REPLACE FUNCTION trg_release_items_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'release_items history is immutable', DETAIL = 'SOURCE_HISTORY_IMMUTABLE';
END;
$$;
DROP TRIGGER IF EXISTS release_items_immutable ON release_items;
CREATE TRIGGER release_items_immutable
  BEFORE UPDATE OR DELETE ON release_items
  FOR EACH ROW EXECUTE FUNCTION trg_release_items_immutable();

CREATE OR REPLACE FUNCTION trg_source_history_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'ZA005',
    MESSAGE = pg_catalog.format('%I source/audit history is immutable', TG_TABLE_NAME),
    DETAIL = 'SOURCE_HISTORY_IMMUTABLE';
END;
$$;

DROP TRIGGER IF EXISTS authoritative_source_versions_immutable ON authoritative_source_versions;
CREATE TRIGGER authoritative_source_versions_immutable
  BEFORE UPDATE OR DELETE ON authoritative_source_versions
  FOR EACH ROW EXECUTE FUNCTION trg_source_history_immutable();
DROP TRIGGER IF EXISTS authoritative_source_suspensions_immutable ON authoritative_source_suspensions;
CREATE TRIGGER authoritative_source_suspensions_immutable
  BEFORE UPDATE OR DELETE ON authoritative_source_suspensions
  FOR EACH ROW EXECUTE FUNCTION trg_source_history_immutable();
DROP TRIGGER IF EXISTS intent_taxonomy_versions_immutable ON intent_taxonomy_versions;
CREATE TRIGGER intent_taxonomy_versions_immutable
  BEFORE UPDATE OR DELETE ON intent_taxonomy_versions
  FOR EACH ROW EXECUTE FUNCTION trg_source_history_immutable();
DROP TRIGGER IF EXISTS intent_taxonomy_entries_immutable ON intent_taxonomy_entries;
CREATE TRIGGER intent_taxonomy_entries_immutable
  BEFORE UPDATE OR DELETE ON intent_taxonomy_entries
  FOR EACH ROW EXECUTE FUNCTION trg_source_history_immutable();
DROP TRIGGER IF EXISTS intent_taxonomy_mappings_immutable ON intent_taxonomy_mappings;
CREATE TRIGGER intent_taxonomy_mappings_immutable
  BEFORE UPDATE OR DELETE ON intent_taxonomy_mappings
  FOR EACH ROW EXECUTE FUNCTION trg_source_history_immutable();
DROP TRIGGER IF EXISTS script_questions_immutable ON script_questions;
CREATE TRIGGER script_questions_immutable
  BEFORE UPDATE OR DELETE ON script_questions
  FOR EACH ROW EXECUTE FUNCTION trg_source_history_immutable();
DROP TRIGGER IF EXISTS content_quality_review_plans_immutable ON content_quality_review_plans;
CREATE TRIGGER content_quality_review_plans_immutable
  BEFORE UPDATE OR DELETE ON content_quality_review_plans
  FOR EACH ROW EXECUTE FUNCTION trg_source_history_immutable();
DROP TRIGGER IF EXISTS content_quality_review_evidence_immutable ON content_quality_review_evidence;
CREATE TRIGGER content_quality_review_evidence_immutable
  BEFORE UPDATE OR DELETE ON content_quality_review_evidence
  FOR EACH ROW EXECUTE FUNCTION trg_source_history_immutable();
DROP TRIGGER IF EXISTS content_review_decisions_immutable ON content_review_decisions;
CREATE TRIGGER content_review_decisions_immutable
  BEFORE UPDATE OR DELETE ON content_review_decisions
  FOR EACH ROW EXECUTE FUNCTION trg_source_history_immutable();
DROP TRIGGER IF EXISTS import_batch_source_bindings_immutable ON import_batch_source_bindings;
CREATE TRIGGER import_batch_source_bindings_immutable
  BEFORE UPDATE OR DELETE ON import_batch_source_bindings
  FOR EACH ROW EXECUTE FUNCTION trg_source_history_immutable();
DROP TRIGGER IF EXISTS change_audits_immutable ON change_audits;
CREATE TRIGGER change_audits_immutable
  BEFORE UPDATE OR DELETE ON change_audits
  FOR EACH ROW EXECUTE FUNCTION trg_source_history_immutable();
DROP TRIGGER IF EXISTS source_denial_audits_immutable ON source_denial_audits;
CREATE TRIGGER source_denial_audits_immutable
  BEFORE UPDATE OR DELETE ON source_denial_audits
  FOR EACH ROW EXECUTE FUNCTION trg_source_history_immutable();
DROP TRIGGER IF EXISTS snapshot_offline_leases_immutable ON snapshot_offline_leases;
CREATE TRIGGER snapshot_offline_leases_immutable
  BEFORE UPDATE OR DELETE ON snapshot_offline_leases
  FOR EACH ROW EXECUTE FUNCTION trg_source_history_immutable();

-- Cross-table semantic lineage cannot be a CHECK constraint. Publish/search/rollback use this
-- stable reader and INSERT is independently fenced below. Every payload field that identifies the
-- source asset must match, and only an active asset is eligible.
CREATE OR REPLACE FUNCTION public.content_questions_source_assets_are_active(
  p_questions JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
STRICT
PARALLEL RESTRICTED
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF public.content_questions_are_valid(p_questions) IS DISTINCT FROM TRUE THEN
    RETURN FALSE;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_questions) AS question(value)
    LEFT JOIN public.semantic_source_assets asset
      ON asset.source_asset_id = question.value ->> 'source_asset_id'
     AND asset.source = question.value ->> 'source'
     AND asset.origin_fingerprint_key_version = question.value ->> 'origin_fingerprint_key_version'
     AND asset.origin_fingerprint = question.value ->> 'origin_fingerprint'
    WHERE asset.source_asset_id IS NULL
       OR asset.lifecycle <> 'active'
       OR asset.promotion_review_ref IS DISTINCT FROM question.value ->> 'promotion_review_ref'
       OR asset.promoted_by_role IS DISTINCT FROM question.value ->> 'promoted_by_role'
       OR asset.promoted_at IS DISTINCT FROM CASE
         WHEN question.value ->> 'promoted_at' IS NULL THEN NULL
         ELSE (question.value ->> 'promoted_at')::TIMESTAMPTZ
       END
       OR asset.source_query_id IS DISTINCT FROM question.value ->> 'source_query_id'
  );
END;
$$;
REVOKE ALL ON FUNCTION public.content_questions_source_assets_are_active(JSONB) FROM PUBLIC;

-- Closed public Question mapper shared by snapshot and any future controlled public reader. It does
-- not expose source query/asset ids, origin HMAC/key, promotion evidence, reviewer roles or times.
CREATE OR REPLACE FUNCTION public.content_public_questions(
  p_questions JSONB
) RETURNS JSONB
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'question_id', question.value ->> 'question_id',
        'question_version', (question.value ->> 'question_version')::INTEGER,
        'question_text', question.value ->> 'question_text',
        'question_hash', question.value ->> 'question_hash',
        'semantic_family_id', question.value ->> 'semantic_family_id'
      ) ORDER BY question.ordinality
    ),
    '[]'::jsonb
  )
  FROM pg_catalog.jsonb_array_elements(p_questions)
    WITH ORDINALITY AS question(value, ordinality)
$$;
REVOKE ALL ON FUNCTION public.content_public_questions(JSONB) FROM PUBLIC;

CREATE OR REPLACE FUNCTION trg_semantic_source_asset_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'semantic source assets cannot be deleted', DETAIL = 'SEMANTIC_ASSET_IMMUTABLE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF pg_catalog.current_setting('app.semantic_asset_write', true) IS DISTINCT FROM 'publish' THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'semantic source asset insert requires publish fence', DETAIL = 'INV_BYPASS';
    END IF;
    RETURN NEW;
  END IF;
  IF pg_catalog.current_setting('app.semantic_asset_write', true) IS DISTINCT FROM 'retire'
     OR OLD.lifecycle IS DISTINCT FROM 'active'
     OR NEW.lifecycle IS DISTINCT FROM 'retired'
     OR NEW.source_asset_id IS DISTINCT FROM OLD.source_asset_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.origin_fingerprint IS DISTINCT FROM OLD.origin_fingerprint
     OR NEW.origin_fingerprint_key_version IS DISTINCT FROM OLD.origin_fingerprint_key_version
     OR NEW.promotion_review_ref IS DISTINCT FROM OLD.promotion_review_ref
     OR NEW.promoted_by_role IS DISTINCT FROM OLD.promoted_by_role
     OR NEW.promoted_at IS DISTINCT FROM OLD.promoted_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.source_query_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'semantic source asset transition is immutable', DETAIL = 'SEMANTIC_ASSET_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION trg_semantic_source_asset_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS semantic_source_asset_guard ON semantic_source_assets;
CREATE TRIGGER semantic_source_asset_guard
  BEFORE INSERT OR UPDATE OR DELETE ON semantic_source_assets
  FOR EACH ROW EXECUTE FUNCTION trg_semantic_source_asset_guard();

CREATE OR REPLACE FUNCTION retire_semantic_source_asset(
  p_source_asset_id TEXT,
  p_retirement_evd TEXT,
  p_actor_subject_hash TEXT,
  p_actor_subject_key_version TEXT,
  p_actor_role TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_got BOOLEAN;
  v_asset public.semantic_source_assets%ROWTYPE;
BEGIN
  IF p_source_asset_id IS NULL OR p_source_asset_id !~ '^sa_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'
     OR p_retirement_evd IS NULL OR p_retirement_evd !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'
     OR p_actor_subject_hash IS NULL OR p_actor_subject_hash !~ '^[0-9a-f]{64}$'
     OR p_actor_subject_key_version IS NULL
     OR p_actor_subject_key_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
     OR p_actor_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'semantic asset retirement capability or payload is invalid', DETAIL = 'FORBIDDEN';
  END IF;

  v_got := pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('cs_ai_content_publish'));
  IF NOT v_got THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'publish/retirement lock not acquired', DETAIL = 'CONFLICT';
  END IF;
  SELECT asset.* INTO v_asset
  FROM public.semantic_source_assets asset
  WHERE asset.source_asset_id = p_source_asset_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA002', MESSAGE = 'semantic source asset not found', DETAIL = 'NOT_FOUND';
  END IF;
  IF v_asset.lifecycle = 'retired' THEN
    IF v_asset.retirement_evd IS DISTINCT FROM p_retirement_evd
       OR v_asset.retired_by_subject_hash IS DISTINCT FROM p_actor_subject_hash
       OR v_asset.retired_by_subject_key_version IS DISTINCT FROM p_actor_subject_key_version THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'retirement replay differs from tombstone', DETAIL = 'IDEMPOTENCY_BODY_MISMATCH';
    END IF;
    RETURN p_source_asset_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.content_current current_release
    JOIN public.release_items item ON item.release_id = current_release.current_release_id
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(item.questions_json) question(value)
    WHERE question.value ->> 'source_asset_id' = p_source_asset_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'current release still uses semantic source asset', DETAIL = 'SEMANTIC_ASSET_IN_USE';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.snapshot_offline_leases lease
    JOIN public.release_items item ON item.release_id = lease.release_id
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(item.questions_json) question(value)
    WHERE lease.expires_at > pg_catalog.clock_timestamp()
      AND question.value ->> 'source_asset_id' = p_source_asset_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'unexpired snapshot lease still uses semantic source asset', DETAIL = 'SEMANTIC_ASSET_IN_USE';
  END IF;

  PERFORM pg_catalog.set_config('app.semantic_asset_write', 'retire', true);
  UPDATE public.semantic_source_assets
  SET lifecycle = 'retired',
      source_query_id = NULL,
      retirement_evd = p_retirement_evd,
      retired_by_subject_hash = p_actor_subject_hash,
      retired_by_subject_key_version = p_actor_subject_key_version,
      retired_at = pg_catalog.clock_timestamp()
  WHERE source_asset_id = p_source_asset_id AND lifecycle = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'semantic source asset retirement conflict', DETAIL = 'CONFLICT';
  END IF;

  INSERT INTO public.change_audits(
    change_id, action, actor_role, source, metadata, created_at
  ) VALUES (
    'chg_' || pg_catalog.gen_random_uuid()::text,
    'semantic_source_asset_retired',
    p_actor_role,
    'retire_semantic_source_asset',
    pg_catalog.jsonb_build_object(
      'source_asset_id', p_source_asset_id,
      'retirement_evd', p_retirement_evd,
      'actor_subject_hash', p_actor_subject_hash,
      'actor_subject_key_version', p_actor_subject_key_version
    ),
    pg_catalog.clock_timestamp()
  );
  RETURN p_source_asset_id;
END;
$$;
REVOKE ALL ON FUNCTION retire_semantic_source_asset(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

-- A source can be suspended only through the owner-only definer operation below. It shares the
-- publish advisory lock, so "publish passed the source check" and "source became suspended" cannot
-- both commit across the same serialization point. A committed suspension makes reads fail closed.
CREATE OR REPLACE FUNCTION trg_authoritative_source_suspension_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.source_governance_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'ZA005',
      MESSAGE = 'authoritative source suspension requires governance fence',
      DETAIL = 'INV_BYPASS';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS authoritative_source_suspension_insert_guard ON authoritative_source_suspensions;
CREATE TRIGGER authoritative_source_suspension_insert_guard
  BEFORE INSERT ON authoritative_source_suspensions
  FOR EACH ROW EXECUTE FUNCTION trg_authoritative_source_suspension_insert_guard();

CREATE OR REPLACE FUNCTION suspend_authoritative_source(
  p_source_version_id TEXT,
  p_reason_code TEXT,
  p_evidence_ref TEXT,
  p_actor_user_id TEXT,
  p_actor_role TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_got BOOLEAN;
  v_suspension_id TEXT;
  v_domain TEXT;
  v_source_ref TEXT;
BEGIN
  IF p_actor_role IS DISTINCT FROM 'owner'
     OR p_actor_user_id IS NULL OR pg_catalog.btrim(p_actor_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'only owner may suspend an authoritative source', DETAIL = 'FORBIDDEN';
  END IF;
  IF p_source_version_id IS NULL OR pg_catalog.btrim(p_source_version_id) = ''
     OR p_reason_code IS NULL OR p_reason_code NOT IN (
       'SOURCE_REVOKED','SOURCE_COMPROMISED','SOURCE_EXPIRED','SOURCE_REPLACED'
     )
     OR p_evidence_ref IS NULL OR pg_catalog.btrim(p_evidence_ref) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'source version, reason and evidence are required', DETAIL = 'VALIDATION';
  END IF;

  v_got := pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('cs_ai_content_publish'));
  IF NOT v_got THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'source governance lock not acquired', DETAIL = 'CONFLICT';
  END IF;

  SELECT asv.domain, asv.source_ref
  INTO v_domain, v_source_ref
  FROM public.authoritative_source_versions asv
  WHERE asv.source_version_id = p_source_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA002', MESSAGE = 'authoritative source version does not exist', DETAIL = 'NOT_FOUND';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.authoritative_source_suspensions susp
    WHERE susp.source_version_id = p_source_version_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'authoritative source version is already suspended', DETAIL = 'SOURCE_SUSPENDED';
  END IF;

  PERFORM pg_catalog.set_config('app.source_governance_write', 'on', true);
  v_suspension_id := 'susp_' || pg_catalog.gen_random_uuid()::text;
  INSERT INTO public.authoritative_source_suspensions(
    suspension_id, source_version_id, reason_code, evidence_ref,
    suspended_by, suspended_by_role, suspended_at
  ) VALUES (
    v_suspension_id, p_source_version_id, p_reason_code, p_evidence_ref,
    p_actor_user_id, p_actor_role, now()
  );
  INSERT INTO public.change_audits(
    change_id, script_id, action, before_hash, after_hash, actor_role, actor_user_id,
    source, metadata, created_at
  ) VALUES (
    'chg_' || pg_catalog.gen_random_uuid()::text,
    NULL,
    'authoritative_source_suspended',
    NULL,
    NULL,
    p_actor_role,
    p_actor_user_id,
    'suspend_authoritative_source',
    pg_catalog.jsonb_build_object(
      'source_version_id', p_source_version_id,
      'source_ref', v_source_ref,
      'domain', v_domain,
      'reason_code', p_reason_code,
      'evidence_ref', p_evidence_ref
    ),
    now()
  );
  RETURN v_suspension_id;
END;
$$;
REVOKE ALL ON FUNCTION suspend_authoritative_source(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

-- IMPORTANT transaction contract: this function MUST run only after the denied business transaction
-- has rolled back, on a fresh transaction/connection, and that audit transaction MUST commit before
-- the API returns the denial. Calling it inside the doomed business transaction is non-conforming.
-- denial_key is an HMAC-derived idempotency key; a replay with a different safe body is rejected.
CREATE OR REPLACE FUNCTION record_source_denial_audit(
  p_denial_key TEXT,
  p_operation TEXT,
  p_reason_code TEXT,
  p_actor_subject_hash TEXT,
  p_hash_key_version TEXT,
  p_actor_role TEXT,
  p_release_id TEXT,
  p_source_version_id TEXT,
  p_source_binding_hash TEXT,
  p_diagnostic_id TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_existing public.source_denial_audits%ROWTYPE;
BEGIN
  IF p_denial_key IS NULL OR p_denial_key !~ '^sda_[0-9a-f]{64}$'
     OR p_operation IS NULL OR p_operation NOT IN (
       'content_import','content_publish','content_rollback','search',
       'announce_current','announce_snapshot','announce_ack','source_suspend'
     )
     OR p_reason_code IS NULL OR p_reason_code NOT IN (
       'SOURCE_NOT_REGISTERED','SOURCE_NOT_ELIGIBLE','SOURCE_SUSPENDED',
       'SOURCE_DOMAIN_MISMATCH','SOURCE_SNAPSHOT_MISMATCH','SOURCE_SET_INCOMPLETE',
       'SOURCE_BASE_RELEASE_STALE','SOURCE_BINDING_HASH_MISMATCH','SOURCE_GATE_NOT_READY',
       'OFFLINE_LEASE_INVALID','OFFLINE_LEASE_EXPIRED','OFFLINE_LEASE_BINDING_MISMATCH'
     )
     OR p_actor_subject_hash IS NULL OR p_actor_subject_hash !~ '^[0-9a-f]{64}$'
     OR p_hash_key_version IS NULL OR pg_catalog.btrim(p_hash_key_version) = ''
     OR p_actor_role IS NULL OR p_actor_role NOT IN ('agent','coach','owner')
     OR (p_release_id IS NOT NULL AND pg_catalog.btrim(p_release_id) = '')
     OR (p_source_version_id IS NOT NULL AND p_source_version_id !~ '^srcv_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$')
     OR (p_source_binding_hash IS NOT NULL AND p_source_binding_hash !~ '^[0-9a-f]{64}$')
     OR p_diagnostic_id IS NULL OR p_diagnostic_id !~ '^diag_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid safe source denial audit', DETAIL = 'VALIDATION';
  END IF;

  INSERT INTO public.source_denial_audits(
    denial_key, operation, reason_code, actor_subject_hash, hash_key_version,
    actor_role, release_id, source_version_id, source_binding_hash, diagnostic_id, committed_at
  ) VALUES (
    p_denial_key, p_operation, p_reason_code, p_actor_subject_hash, p_hash_key_version,
    p_actor_role, p_release_id, p_source_version_id, p_source_binding_hash,
    p_diagnostic_id, pg_catalog.clock_timestamp()
  )
  ON CONFLICT (denial_key) DO NOTHING;

  SELECT * INTO STRICT v_existing
  FROM public.source_denial_audits sda
  WHERE sda.denial_key = p_denial_key;
  IF v_existing.operation IS DISTINCT FROM p_operation
     OR v_existing.reason_code IS DISTINCT FROM p_reason_code
     OR v_existing.actor_subject_hash IS DISTINCT FROM p_actor_subject_hash
     OR v_existing.hash_key_version IS DISTINCT FROM p_hash_key_version
     OR v_existing.actor_role IS DISTINCT FROM p_actor_role
     OR v_existing.release_id IS DISTINCT FROM p_release_id
     OR v_existing.source_version_id IS DISTINCT FROM p_source_version_id
     OR v_existing.source_binding_hash IS DISTINCT FROM p_source_binding_hash
     OR v_existing.diagnostic_id IS DISTINCT FROM p_diagnostic_id THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'denial audit key was reused with a different safe body', DETAIL = 'IDEMPOTENCY_BODY_MISMATCH';
  END IF;
  RETURN p_denial_key;
END;
$$;
REVOKE ALL ON FUNCTION record_source_denial_audit(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

-- Workload wrappers keep the shared writer private and make the operation set executable. Runtime
-- cannot claim publish/admin denials; admin cannot use its capability as a general search logger.
CREATE OR REPLACE FUNCTION record_runtime_source_denial_audit(
  p_denial_key TEXT,
  p_operation TEXT,
  p_reason_code TEXT,
  p_actor_subject_hash TEXT,
  p_hash_key_version TEXT,
  p_actor_role TEXT,
  p_release_id TEXT,
  p_source_version_id TEXT,
  p_source_binding_hash TEXT,
  p_diagnostic_id TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_operation NOT IN ('content_import','search','announce_current','announce_snapshot','announce_ack') THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'runtime source-denial operation is not permitted', DETAIL = 'FORBIDDEN';
  END IF;
  RETURN public.record_source_denial_audit(
    p_denial_key, p_operation, p_reason_code, p_actor_subject_hash, p_hash_key_version,
    p_actor_role, p_release_id, p_source_version_id, p_source_binding_hash, p_diagnostic_id
  );
END;
$$;
REVOKE ALL ON FUNCTION record_runtime_source_denial_audit(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION record_admin_source_denial_audit(
  p_denial_key TEXT,
  p_operation TEXT,
  p_reason_code TEXT,
  p_actor_subject_hash TEXT,
  p_hash_key_version TEXT,
  p_actor_role TEXT,
  p_release_id TEXT,
  p_source_version_id TEXT,
  p_source_binding_hash TEXT,
  p_diagnostic_id TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_operation NOT IN ('content_publish','content_rollback','source_suspend') THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'admin source-denial operation is not permitted', DETAIL = 'FORBIDDEN';
  END IF;
  RETURN public.record_source_denial_audit(
    p_denial_key, p_operation, p_reason_code, p_actor_subject_hash, p_hash_key_version,
    p_actor_role, p_release_id, p_source_version_id, p_source_binding_hash, p_diagnostic_id
  );
END;
$$;
REVOKE ALL ON FUNCTION record_admin_source_denial_audit(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION trg_import_source_binding_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.import_binding_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'import source bindings require enqueue fence', DETAIL = 'INV_BYPASS';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS import_source_binding_insert_guard ON import_batch_source_bindings;
CREATE TRIGGER import_source_binding_insert_guard
  BEFORE INSERT ON import_batch_source_bindings
  FOR EACH ROW EXECUTE FUNCTION trg_import_source_binding_insert_guard();

CREATE OR REPLACE FUNCTION trg_release_source_binding_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' OR current_setting('app.publishing', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'release source binding history is immutable', DETAIL = 'SOURCE_HISTORY_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS release_source_binding_guard ON release_source_bindings;
CREATE TRIGGER release_source_binding_guard
  BEFORE INSERT OR UPDATE OR DELETE ON release_source_bindings
  FOR EACH ROW EXECUTE FUNCTION trg_release_source_binding_guard();

CREATE OR REPLACE FUNCTION trg_release_source_set_complete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_count INT;
  v_hash TEXT;
  v_noncanonical BOOLEAN;
  v_suspended BOOLEAN;
BEGIN
  SELECT
    pg_catalog.count(*)::INT,
    pg_catalog.encode(public.digest(pg_catalog.convert_to(
      pg_catalog.string_agg(rsb.domain || ':' || rsb.source_version_id, '|' ORDER BY rsb.domain),
      'UTF8'
    ), 'sha256'), 'hex'),
    coalesce(pg_catalog.bool_or(asv.use_class <> 'canonical'), FALSE),
    coalesce(pg_catalog.bool_or(susp.source_version_id IS NOT NULL), FALSE)
  INTO v_count, v_hash, v_noncanonical, v_suspended
  FROM public.release_source_bindings rsb
  JOIN public.authoritative_source_versions asv
    ON asv.source_version_id = rsb.source_version_id AND asv.domain = rsb.domain
  LEFT JOIN public.authoritative_source_suspensions susp
    ON susp.source_version_id = rsb.source_version_id
  WHERE rsb.release_id = NEW.release_id;

  IF v_count <> 4 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'release requires exactly four authoritative source domains', DETAIL = 'SOURCE_SET_INCOMPLETE';
  END IF;
  IF v_noncanonical THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'release contains a reference-only source', DETAIL = 'SOURCE_NOT_ELIGIBLE';
  END IF;
  IF v_suspended THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'release contains a suspended source', DETAIL = 'SOURCE_SUSPENDED';
  END IF;
  IF NEW.source_binding_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'release source binding hash mismatch', DETAIL = 'SOURCE_BINDING_HASH_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS release_source_set_complete ON content_releases;
CREATE CONSTRAINT TRIGGER release_source_set_complete
  AFTER INSERT ON content_releases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_release_source_set_complete();

CREATE OR REPLACE FUNCTION trg_scripts_protect_published()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'published'
     AND (
       NEW.answer_text IS DISTINCT FROM OLD.answer_text
       OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
       OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
       OR NEW.source_version_id IS DISTINCT FROM OLD.source_version_id
       OR NEW.owner_role IS DISTINCT FROM OLD.owner_role
       OR NEW.review_due_at IS DISTINCT FROM OLD.review_due_at
       OR NEW.platform_scope IS DISTINCT FROM OLD.platform_scope
       OR NEW.product_scope_type IS DISTINCT FROM OLD.product_scope_type
       OR NEW.product_scope_refs IS DISTINCT FROM OLD.product_scope_refs
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
       OR NEW.intent_taxonomy_version IS DISTINCT FROM OLD.intent_taxonomy_version
       OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
       OR NEW.risk_level IS DISTINCT FROM OLD.risk_level
       OR NEW.risk_categories IS DISTINCT FROM OLD.risk_categories
       OR NEW.has_conflict IS DISTINCT FROM OLD.has_conflict
       OR NEW.review_mode IS DISTINCT FROM OLD.review_mode
       OR NEW.primary_reviewer_id IS DISTINCT FROM OLD.primary_reviewer_id
       OR NEW.primary_reviewer_role IS DISTINCT FROM OLD.primary_reviewer_role
       OR NEW.primary_review_evd IS DISTINCT FROM OLD.primary_review_evd
       OR NEW.secondary_reviewer_id IS DISTINCT FROM OLD.secondary_reviewer_id
       OR NEW.secondary_reviewer_role IS DISTINCT FROM OLD.secondary_reviewer_role
       OR NEW.secondary_review_evd IS DISTINCT FROM OLD.secondary_review_evd
       OR NEW.placeholder_keys IS DISTINCT FROM OLD.placeholder_keys
       OR NEW.questions_json IS DISTINCT FROM OLD.questions_json
     )
     AND current_setting('app.publishing', true) IS DISTINCT FROM 'on'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'published script body only mutable during app.publishing=on', DETAIL = 'INV_BYPASS';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS scripts_protect_published ON scripts;
CREATE TRIGGER scripts_protect_published
  BEFORE UPDATE ON scripts
  FOR EACH ROW EXECUTE FUNCTION trg_scripts_protect_published();

-- A staged batch is immutable input to publish. Only the fenced validator may write rows while the
-- owning batch is still validating; no lost worker or API code can patch a staged/published batch.
CREATE OR REPLACE FUNCTION trg_staging_mutable_while_validating()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_batch_id TEXT;
  v_status TEXT;
BEGIN
  v_batch_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.import_batch_id ELSE NEW.import_batch_id END;
  SELECT status INTO v_status
  FROM public.import_batches
  WHERE import_batch_id = v_batch_id;
  IF v_status IS DISTINCT FROM 'validating' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'staging rows are mutable only while batch is validating', DETAIL = 'INV_BYPASS';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS staging_mutable_while_validating ON staging_scripts;
CREATE TRIGGER staging_mutable_while_validating
  BEFORE INSERT OR UPDATE OR DELETE ON staging_scripts
  FOR EACH ROW EXECUTE FUNCTION trg_staging_mutable_while_validating();

DO $content_constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.scripts'::pg_catalog.regclass AND conname = 'scripts_campaign_requires_window') THEN
    ALTER TABLE scripts ADD CONSTRAINT scripts_campaign_requires_window CHECK (
      category <> 'campaign' OR (effective_from IS NOT NULL AND effective_to IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.staging_scripts'::pg_catalog.regclass AND conname = 'staging_campaign_requires_window') THEN
    ALTER TABLE staging_scripts ADD CONSTRAINT staging_campaign_requires_window CHECK (
      operation = 'withdraw' OR category <> 'campaign'
      OR (effective_from IS NOT NULL AND effective_to IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.release_items'::pg_catalog.regclass AND conname = 'release_campaign_requires_window') THEN
    ALTER TABLE release_items ADD CONSTRAINT release_campaign_requires_window CHECK (
      category <> 'campaign' OR (effective_from IS NOT NULL AND effective_to IS NOT NULL)
    );
  END IF;
END
$content_constraints$;

CREATE TABLE IF NOT EXISTS rewrite_logs (
  rewrite_id         TEXT PRIMARY KEY,
  source_script_id   TEXT,
  proposed_text      TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending_review','approved','rejected')),
  model              TEXT,
  prompt_hash        TEXT,
  tenant_id          TEXT NOT NULL DEFAULT 'default',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Policy flag write-only via function (dangerous flags audited)
CREATE OR REPLACE FUNCTION set_policy_flag(
  p_flag_key TEXT,
  p_flag_value BOOLEAN,
  p_actor_user_id TEXT,
  p_actor_role TEXT,
  p_adr_id TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_before BOOLEAN;
BEGIN
  IF p_actor_role IS DISTINCT FROM 'owner'
     OR p_actor_user_id IS NULL OR pg_catalog.btrim(p_actor_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'only owner may set policy flags', DETAIL = 'FORBIDDEN';
  END IF;
  IF p_flag_key IS NULL OR pg_catalog.btrim(p_flag_key) = '' OR p_flag_value IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'policy flag key and value are required', DETAIL = 'VALIDATION';
  END IF;
  IF p_flag_key NOT IN ('rewrite','auto_send','autofill_adapter','llm_ranker','metrics_experimental_kpi') THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = pg_catalog.format('unknown or deployment-only policy flag %s', p_flag_key), DETAIL = 'VALIDATION';
  END IF;
  -- Phase1 hard gate: ADR is evidence, not permission to cross a lifecycle boundary.
  IF p_flag_key IN ('rewrite','auto_send') AND p_flag_value IS TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = pg_catalog.format('phase1 forbids enabling %s even with adr_id', p_flag_key), DETAIL = 'POLICY_DENIED';
  END IF;
  SELECT flag_value INTO v_before FROM public.policy_flags WHERE flag_key = p_flag_key FOR UPDATE;
  INSERT INTO public.policy_flags(flag_key, flag_value, updated_at, updated_by)
  VALUES (p_flag_key, p_flag_value, now(), p_actor_user_id)
  ON CONFLICT (flag_key) DO UPDATE
    SET flag_value = EXCLUDED.flag_value,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by;
  INSERT INTO public.change_audits(
    change_id, script_id, action, before_hash, after_hash, actor_role, actor_user_id,
    source, metadata, created_at
  )
  VALUES (
    'chg_' || pg_catalog.gen_random_uuid()::text,
    NULL,
    'policy_set',
    NULL,
    NULL,
    p_actor_role,
    p_actor_user_id,
    'set_policy_flag',
    pg_catalog.jsonb_build_object(
      'flag_key', p_flag_key,
      'before_value', v_before,
      'after_value', p_flag_value,
      'adr_id', p_adr_id
    ),
    now()
  );
END;
$$;
REVOKE ALL ON FUNCTION set_policy_flag(TEXT,BOOLEAN,TEXT,TEXT,TEXT) FROM PUBLIC;

-- Publish: MERGE semantics (prev current release_items ∪ staging overwrite by script_id).
-- Never "batch-only world". Empty ok-count → VALIDATION.
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

  SELECT b.base_release_id, b.source_binding_hash
  INTO v_base, v_expected_source_hash
  FROM public.import_batches b
  WHERE b.import_batch_id = p_import_batch_id;

  SELECT c.current_release_id INTO v_prev
  FROM public.content_current c WHERE c.id = 1 FOR UPDATE;
  IF v_prev IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'import was validated against a stale current release', DETAIL = 'SOURCE_BASE_RELEASE_STALE';
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
        OR s.content_hash IS DISTINCT FROM
          public.content_governance_hash(
            s.script_id, s.category, s.title, s.answer_text, s.source_ref, s.source_version_id,
            s.owner_role, s.review_due_at, s.platform_scope, s.product_scope_type,
            s.product_scope_refs, s.effective_from, s.effective_to,
            s.intent_taxonomy_version, s.intent_id, s.risk_level, s.risk_categories, s.has_conflict,
            s.review_mode, s.primary_reviewer_id, s.primary_reviewer_role, s.primary_review_evd,
            s.secondary_reviewer_id, s.secondary_reviewer_role, s.secondary_review_evd,
            s.placeholder_keys, s.questions_json
          )
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
  WHERE EXISTS (
    SELECT 1 FROM public.import_batch_source_bindings ib
    WHERE ib.import_batch_id = p_import_batch_id AND ib.domain = sc.category
  );

  -- Upsert live scripts from staging upserts only.
  INSERT INTO public.scripts AS sc (
    script_id, category, title, answer_text, status, version, content_hash,
    source_ref, source_version_id, platform_scope, product_scope_type, product_scope_refs,
    campaign_tag, effective_from, effective_to,
    intent_taxonomy_version, intent_id, risk_level, risk_categories, has_conflict, review_mode,
    primary_reviewer_id, primary_reviewer_role, primary_review_evd,
    secondary_reviewer_id, secondary_reviewer_role, secondary_review_evd,
    placeholder_keys, questions_json,
    priority, owner_role, review_due_at, created_at, updated_at, published_at, tenant_id
  )
  SELECT
    s.script_id, s.category, s.title, s.answer_text, 'published', 1, s.content_hash,
    s.source_ref, s.source_version_id, s.platform_scope, s.product_scope_type, s.product_scope_refs,
    s.campaign_tag, s.effective_from, s.effective_to,
    s.intent_taxonomy_version, s.intent_id, s.risk_level, s.risk_categories, s.has_conflict, s.review_mode,
    s.primary_reviewer_id, s.primary_reviewer_role, s.primary_review_evd,
    s.secondary_reviewer_id, s.secondary_reviewer_role, s.secondary_review_evd,
    s.placeholder_keys, s.questions_json,
    0, s.owner_role, s.review_due_at, now(), now(), now(), 'default'
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
    'published', v_source_hash, p_actor_user_id, p_actor_role, now(), 'default'
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
    intent_taxonomy_version, intent_id, risk_level, risk_categories, has_conflict, review_mode,
    primary_reviewer_id, primary_reviewer_role, primary_review_evd,
    secondary_reviewer_id, secondary_reviewer_role, secondary_review_evd,
    placeholder_keys, questions_json,
    search_document, search_fallback_text
  )
  SELECT
    v_release_id, x.script_id, x.script_version, x.content_hash, x.answer_text, x.title, x.category,
    x.source_ref, x.source_version_id, x.owner_role, x.review_due_at,
    x.effective_from, x.effective_to, x.platform_scope, x.product_scope_type, x.product_scope_refs,
    x.intent_taxonomy_version, x.intent_id, x.risk_level, x.risk_categories, x.has_conflict, x.review_mode,
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
      s.intent_taxonomy_version, s.intent_id, s.risk_level, s.risk_categories, s.has_conflict, s.review_mode,
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
      ri.intent_taxonomy_version, ri.intent_id, ri.risk_level, ri.risk_categories, ri.has_conflict, ri.review_mode,
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
REVOKE ALL ON FUNCTION publish_content_release(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

-- Rollback never rewrites history: replay a target snapshot into a new monotonic release.
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
    'default'
  );

  INSERT INTO public.release_source_bindings(release_id, domain, source_version_id, created_at)
  SELECT v_release_id, rsb.domain, rsb.source_version_id, now()
  FROM public.release_source_bindings rsb
  WHERE rsb.release_id = p_target_release_id;

  INSERT INTO public.release_items(
    release_id, script_id, script_version, content_hash, answer_text, title, category,
    source_ref, source_version_id, owner_role, review_due_at,
    effective_from, effective_to, platform_scope, product_scope_type, product_scope_refs,
    intent_taxonomy_version, intent_id, risk_level, risk_categories, has_conflict, review_mode,
    primary_reviewer_id, primary_reviewer_role, primary_review_evd,
    secondary_reviewer_id, secondary_reviewer_role, secondary_review_evd,
    placeholder_keys, questions_json,
    search_document, search_fallback_text
  )
  SELECT
    v_release_id, ri.script_id, ri.script_version, ri.content_hash, ri.answer_text,
    ri.title, ri.category, ri.source_ref, ri.source_version_id, ri.owner_role, ri.review_due_at,
    ri.effective_from, ri.effective_to, ri.platform_scope, ri.product_scope_type, ri.product_scope_refs,
    ri.intent_taxonomy_version, ri.intent_id, ri.risk_level, ri.risk_categories, ri.has_conflict, ri.review_mode,
    ri.primary_reviewer_id, ri.primary_reviewer_role, ri.primary_review_evd,
    ri.secondary_reviewer_id, ri.secondary_reviewer_role, ri.secondary_review_evd,
    ri.placeholder_keys,
    ri.questions_json, ri.search_document, ri.search_fallback_text
  FROM public.release_items ri
  WHERE ri.release_id = p_target_release_id;

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
REVOKE ALL ON FUNCTION rollback_content_release(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

-- Import 202 is legal only after this function atomically persists batch, requested source bindings and
-- outbox job. Rejected source attempts cannot be audited in this transaction because RAISE rolls it back:
-- the API MUST catch ZA001/ZA004, then write source_policy_rejected in a separate audit transaction/log
-- with only action, details.reason, diagnostic_id and safe source-version hashes (never URLs/tokens).
CREATE OR REPLACE FUNCTION enqueue_content_import(
  p_import_batch_id TEXT,
  p_source_type TEXT,
  p_source_ref TEXT,
  p_source_sha256 TEXT,
  p_source_size_bytes BIGINT,
  p_source_bindings JSONB,
  p_actor_user_id TEXT,
  p_actor_role TEXT
) RETURNS TABLE(import_batch_id TEXT, status TEXT, job_id TEXT, source_binding_hash TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_job_id TEXT;
  v_base_release_id TEXT;
  v_source_count INT;
  v_source_hash TEXT;
  v_source_noncanonical BOOLEAN;
  v_source_suspended BOOLEAN;
BEGIN
  IF p_actor_role IS NULL OR p_actor_role NOT IN ('coach','owner')
     OR p_actor_user_id IS NULL OR pg_catalog.btrim(p_actor_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'import requires coach or owner', DETAIL = 'FORBIDDEN';
  END IF;
  IF p_import_batch_id IS NULL OR pg_catalog.btrim(p_import_batch_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'import_batch_id is required', DETAIL = 'VALIDATION';
  END IF;
  IF p_source_type IS NULL OR p_source_type NOT IN ('excel','csv','feishu_api','seed','other') THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid import source_type', DETAIL = 'VALIDATION';
  END IF;
  IF p_source_ref IS NULL OR pg_catalog.btrim(p_source_ref) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'source_ref must identify an already-persisted upload object', DETAIL = 'VALIDATION';
  END IF;
  IF p_source_sha256 IS NULL OR p_source_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'source_sha256 must be lowercase sha256 hex', DETAIL = 'VALIDATION';
  END IF;
  IF p_source_size_bytes IS NULL OR p_source_size_bytes < 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'source_size_bytes must be nonnegative', DETAIL = 'VALIDATION';
  END IF;
  IF pg_catalog.jsonb_typeof(p_source_bindings) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(p_source_bindings) < 1
     OR pg_catalog.jsonb_array_length(p_source_bindings) > 4 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'source_bindings must contain one to four domains', DETAIL = 'SOURCE_SET_INCOMPLETE';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_source_bindings) item(value)
    WHERE pg_catalog.jsonb_typeof(item.value) IS DISTINCT FROM 'object'
       OR NOT item.value ?& ARRAY['domain','source_version_id']
       OR item.value - ARRAY['domain','source_version_id'] <> '{}'::jsonb
       OR coalesce(item.value ->> 'domain', '') NOT IN ('presale','campaign','aftersale','product')
       OR coalesce(item.value ->> 'source_version_id', '') !~ '^srcv_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'source binding shape is invalid', DETAIL = 'SOURCE_DOMAIN_MISMATCH';
  END IF;
  IF (
    SELECT pg_catalog.count(*) <> pg_catalog.count(DISTINCT item.value ->> 'domain')
    FROM pg_catalog.jsonb_array_elements(p_source_bindings) item(value)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'source binding domains must be unique', DETAIL = 'SOURCE_DOMAIN_MISMATCH';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(p_source_bindings) requested(domain TEXT, source_version_id TEXT)
    LEFT JOIN public.authoritative_source_versions asv
      ON asv.source_version_id = requested.source_version_id
    WHERE asv.source_version_id IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'source version is not registered for runtime use', DETAIL = 'SOURCE_NOT_ELIGIBLE';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(p_source_bindings) requested(domain TEXT, source_version_id TEXT)
    JOIN public.authoritative_source_versions asv
      ON asv.source_version_id = requested.source_version_id
    WHERE asv.domain IS DISTINCT FROM requested.domain
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'source version belongs to a different domain', DETAIL = 'SOURCE_DOMAIN_MISMATCH';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(p_source_bindings) requested(domain TEXT, source_version_id TEXT)
    JOIN public.authoritative_source_versions asv
      ON asv.source_version_id = requested.source_version_id
    WHERE asv.use_class <> 'canonical'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'reference-only source cannot enter runtime content', DETAIL = 'SOURCE_NOT_ELIGIBLE';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(p_source_bindings) requested(domain TEXT, source_version_id TEXT)
    JOIN public.authoritative_source_suspensions susp
      ON susp.source_version_id = requested.source_version_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'suspended source cannot enter runtime content', DETAIL = 'SOURCE_SUSPENDED';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(p_source_bindings) requested(domain TEXT, source_version_id TEXT)
    JOIN public.authoritative_source_versions asv
      ON asv.source_version_id = requested.source_version_id
    WHERE asv.snapshot_sha256 IS DISTINCT FROM p_source_sha256
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'uploaded snapshot does not match registered source version', DETAIL = 'SOURCE_SNAPSHOT_MISMATCH';
  END IF;

  SELECT cc.current_release_id INTO v_base_release_id
  FROM public.content_current cc WHERE cc.id = 1;
  WITH requested AS (
    SELECT x.domain, x.source_version_id
    FROM pg_catalog.jsonb_to_recordset(p_source_bindings) x(domain TEXT, source_version_id TEXT)
  ), prospective AS (
    SELECT requested.domain, requested.source_version_id FROM requested
    UNION ALL
    SELECT rb.domain, rb.source_version_id
    FROM public.release_source_bindings rb
    WHERE rb.release_id = v_base_release_id
      AND NOT EXISTS (SELECT 1 FROM requested WHERE requested.domain = rb.domain)
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
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'inherited source is not canonical', DETAIL = 'SOURCE_NOT_ELIGIBLE';
  END IF;
  IF v_source_suspended THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'inherited source is suspended and must be replaced', DETAIL = 'SOURCE_SUSPENDED';
  END IF;

  v_job_id := 'job_import_' || pg_catalog.gen_random_uuid()::text;
  INSERT INTO public.import_batches(
    import_batch_id, source_type, source_ref, source_sha256, source_size_bytes,
    base_release_id, source_binding_hash, status, actor_user_id, actor_role, created_at, tenant_id
  ) VALUES (
    p_import_batch_id, p_source_type, p_source_ref, p_source_sha256, p_source_size_bytes,
    v_base_release_id, v_source_hash, 'validating', p_actor_user_id, p_actor_role, now(), 'default'
  );
  PERFORM pg_catalog.set_config('app.import_binding_write', 'on', true);
  INSERT INTO public.import_batch_source_bindings(import_batch_id, domain, source_version_id, created_at)
  SELECT p_import_batch_id, x.domain, x.source_version_id, now()
  FROM pg_catalog.jsonb_to_recordset(p_source_bindings) x(domain TEXT, source_version_id TEXT);
  INSERT INTO public.outbox_jobs(job_id, job_type, payload, status, created_at, updated_at)
  VALUES (
    v_job_id,
    'import_validate',
    pg_catalog.jsonb_build_object(
      'import_batch_id', p_import_batch_id,
      'source_ref', p_source_ref,
      'source_sha256', p_source_sha256,
      'source_size_bytes', p_source_size_bytes,
      'base_release_id', v_base_release_id,
      'source_binding_hash', v_source_hash,
      'source_bindings', p_source_bindings
    ),
    'pending',
    now(),
    now()
  );

  INSERT INTO public.change_audits(
    change_id, action, actor_role, actor_user_id, source, metadata, created_at
  ) VALUES (
    'chg_' || pg_catalog.gen_random_uuid()::text,
    'content_import_enqueued', p_actor_role, p_actor_user_id, 'enqueue_content_import',
    pg_catalog.jsonb_build_object(
      'import_batch_id', p_import_batch_id,
      'base_release_id', v_base_release_id,
      'source_binding_hash', v_source_hash,
      'source_version_ids', (
        SELECT pg_catalog.jsonb_agg(x.source_version_id ORDER BY x.domain)
        FROM pg_catalog.jsonb_to_recordset(p_source_bindings) x(domain TEXT, source_version_id TEXT)
      )
    ),
    now()
  );

  import_batch_id := p_import_batch_id;
  status := 'validating';
  job_id := v_job_id;
  source_binding_hash := v_source_hash;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION enqueue_content_import(TEXT,TEXT,TEXT,TEXT,BIGINT,JSONB,TEXT,TEXT) FROM PUBLIC;

-- Work-order import uses a separate capability boundary and job type. The persisted source object
-- must already be durable and checksum-verified before this function is called.
CREATE OR REPLACE FUNCTION enqueue_work_order_import(
  p_import_batch_id TEXT,
  p_tenant_scope TEXT,
  p_source_system TEXT,
  p_source_ref TEXT,
  p_source_file_name_safe TEXT,
  p_source_sha256 TEXT,
  p_source_size_bytes BIGINT,
  p_mapping_version TEXT,
  p_data_from TIMESTAMPTZ,
  p_data_to TIMESTAMPTZ,
  p_actor_user_id TEXT,
  p_actor_role TEXT
) RETURNS TABLE(import_batch_id TEXT, status TEXT, job_id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_job_id TEXT;
BEGIN
  IF p_actor_role NOT IN ('coach','owner')
     OR p_actor_user_id IS NULL OR pg_catalog.btrim(p_actor_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'work-order import requires coach or owner', DETAIL = 'FORBIDDEN';
  END IF;
  IF p_import_batch_id IS NULL OR pg_catalog.btrim(p_import_batch_id) = ''
     OR p_tenant_scope IS NULL OR pg_catalog.btrim(p_tenant_scope) = ''
     OR p_source_system IS NULL OR pg_catalog.btrim(p_source_system) = ''
     OR p_source_ref IS NULL OR pg_catalog.btrim(p_source_ref) = ''
     OR p_mapping_version IS NULL OR pg_catalog.btrim(p_mapping_version) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'work-order import identity is incomplete', DETAIL = 'VALIDATION';
  END IF;
  IF p_source_file_name_safe IS NULL
     OR pg_catalog.length(p_source_file_name_safe) > 255
     OR pg_catalog.strpos(p_source_file_name_safe, '/') > 0
     OR pg_catalog.strpos(p_source_file_name_safe, pg_catalog.chr(92)) > 0
     OR pg_catalog.strpos(p_source_file_name_safe, '..') > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'unsafe work-order source filename', DETAIL = 'VALIDATION';
  END IF;
  IF p_source_sha256 IS NULL OR p_source_sha256 !~ '^[0-9a-f]{64}$'
     OR p_source_size_bytes IS NULL OR p_source_size_bytes < 0
     OR (p_data_from IS NOT NULL AND p_data_to IS NOT NULL AND p_data_to < p_data_from) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid work-order source metadata', DETAIL = 'VALIDATION';
  END IF;

  v_job_id := 'job_work_order_' || pg_catalog.gen_random_uuid()::text;
  INSERT INTO public.work_order_import_batches(
    import_batch_id, tenant_scope, source_system, source_ref, source_file_name_safe,
    source_sha256, source_size_bytes, mapping_version, status, data_from, data_to,
    actor_user_id, actor_role, created_at
  ) VALUES (
    p_import_batch_id, p_tenant_scope, p_source_system, p_source_ref, p_source_file_name_safe,
    p_source_sha256, p_source_size_bytes, p_mapping_version, 'validating', p_data_from, p_data_to,
    p_actor_user_id, p_actor_role, pg_catalog.clock_timestamp()
  );
  INSERT INTO public.outbox_jobs(job_id, job_type, payload, status, created_at, updated_at)
  VALUES (
    v_job_id,
    'work_order_import_validate',
    pg_catalog.jsonb_build_object(
      'import_batch_id', p_import_batch_id,
      'tenant_scope', p_tenant_scope,
      'source_ref', p_source_ref,
      'source_sha256', p_source_sha256,
      'source_size_bytes', p_source_size_bytes,
      'mapping_version', p_mapping_version
    ),
    'pending',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );

  import_batch_id := p_import_batch_id;
  status := 'validating';
  job_id := v_job_id;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION enqueue_work_order_import(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION cancel_content_import(
  p_import_batch_id TEXT,
  p_reason TEXT,
  p_actor_user_id TEXT,
  p_actor_role TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_batch public.import_batches%ROWTYPE;
  v_diagnostic_id TEXT;
  n INT;
BEGIN
  IF p_import_batch_id IS NULL OR pg_catalog.btrim(p_import_batch_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'import_batch_id is required', DETAIL = 'VALIDATION';
  END IF;
  IF p_actor_user_id IS NULL OR pg_catalog.btrim(p_actor_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'actor_user_id is required', DETAIL = 'VALIDATION';
  END IF;
  IF p_actor_role IS NULL OR pg_catalog.btrim(p_actor_role) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'actor_role is required', DETAIL = 'VALIDATION';
  END IF;
  SELECT * INTO v_batch
  FROM public.import_batches
  WHERE import_batch_id = p_import_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA002', MESSAGE = 'import batch does not exist', DETAIL = 'NOT_FOUND';
  END IF;
  IF p_actor_role IS DISTINCT FROM 'owner'
     AND (
       p_actor_role IS DISTINCT FROM 'coach'
       OR p_actor_user_id IS NULL
       OR v_batch.actor_user_id IS NULL
       OR v_batch.actor_user_id IS DISTINCT FROM p_actor_user_id
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'import cancel requires owner or originating coach', DETAIL = 'FORBIDDEN';
  END IF;
  v_diagnostic_id := 'diag_' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
  UPDATE public.import_batches
  SET status = 'failed',
      error_report = pg_catalog.jsonb_build_object(
        'code', 'CANCELLED',
        'diagnostic_id', v_diagnostic_id
      ),
      finished_at = now()
  WHERE import_batch_id = p_import_batch_id
    AND status IN ('validating', 'staged');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = pg_catalog.format('import batch cannot be cancelled from %s', v_batch.status), DETAIL = 'CONFLICT';
  END IF;

  UPDATE public.outbox_jobs
  SET status = 'dead',
      lease_owner = NULL,
      lease_version = lease_version + 1,
      lease_expires_at = NULL,
      completed_at = now(),
      updated_at = now(),
      last_error = 'CANCELLED'
  WHERE job_type = 'import_validate'
    AND payload ->> 'import_batch_id' = p_import_batch_id
    AND status IN ('pending','running');

  INSERT INTO public.change_audits(
    change_id, action, actor_role, actor_user_id, source, metadata, created_at
  ) VALUES (
    'chg_' || pg_catalog.gen_random_uuid()::text,
    'content_import_cancel', p_actor_role, p_actor_user_id, 'cancel_content_import',
    pg_catalog.jsonb_build_object(
      'import_batch_id', p_import_batch_id,
      'diagnostic_id', v_diagnostic_id,
      'reason', p_reason
    ),
    now()
  );
END;
$$;
REVOKE ALL ON FUNCTION cancel_content_import(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

-- Monotonic, user-bound client ACK. ACK proves use of an unexpired bound lease but never updates the
-- immutable lease row and therefore cannot renew offline authorization. Drop the unsafe legacy overload.
DROP FUNCTION IF EXISTS ack_client_release(TEXT,TEXT,TEXT,BIGINT);
CREATE OR REPLACE FUNCTION ack_client_release(
  p_client_id TEXT,
  p_user_id TEXT,
  p_release_id TEXT,
  p_release_seq BIGINT,
  p_offline_lease_token TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_existing_user_id TEXT;
  v_existing_seq BIGINT;
  v_lease_release_seq BIGINT;
  v_source_binding_hash TEXT;
  v_lease_token_hash TEXT;
BEGIN
  IF p_client_id IS NULL OR pg_catalog.btrim(p_client_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'client_id is required', DETAIL = 'VALIDATION';
  END IF;
  IF p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'user_id is required', DETAIL = 'VALIDATION';
  END IF;
  IF p_release_id IS NULL OR pg_catalog.btrim(p_release_id) = '' OR p_release_seq IS NULL OR p_release_seq < 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'release_id and positive release_seq are required', DETAIL = 'VALIDATION';
  END IF;
  SELECT lease.release_seq, lease.source_binding_hash
  INTO v_lease_release_seq, v_source_binding_hash
  FROM public.validate_snapshot_offline_lease(
    p_offline_lease_token, p_client_id, p_user_id, p_release_id
  ) AS lease;
  IF v_lease_release_seq IS DISTINCT FROM p_release_seq THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'offline lease release sequence mismatch', DETAIL = 'OFFLINE_LEASE_BINDING_MISMATCH';
  END IF;
  v_lease_token_hash := pg_catalog.encode(public.digest(
    pg_catalog.convert_to(p_offline_lease_token, 'UTF8'), 'sha256'
  ), 'hex');

  LOOP
    SELECT user_id, last_seen_release_seq
    INTO v_existing_user_id, v_existing_seq
    FROM public.client_sync_state
    WHERE client_id = p_client_id
    FOR UPDATE;

    IF FOUND THEN
      IF v_existing_user_id IS DISTINCT FROM p_user_id THEN
        RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'client_id belongs to another user', DETAIL = 'FORBIDDEN';
      END IF;
      IF v_existing_seq IS NULL OR p_release_seq >= v_existing_seq THEN
        UPDATE public.client_sync_state
        SET last_seen_release_id = p_release_id,
            last_seen_release_seq = p_release_seq,
            last_seen_source_binding_hash = v_source_binding_hash,
            last_ack_lease_token_hash = v_lease_token_hash,
            last_ack_at = pg_catalog.clock_timestamp(),
            updated_at = pg_catalog.clock_timestamp()
        WHERE client_id = p_client_id;
        RETURN TRUE;
      END IF;
      RETURN FALSE;
    END IF;

    BEGIN
      INSERT INTO public.client_sync_state(
        client_id, user_id, last_seen_release_id, last_seen_release_seq,
        last_seen_source_binding_hash, last_ack_lease_token_hash, last_ack_at, updated_at
      ) VALUES (
        p_client_id, p_user_id, p_release_id, p_release_seq,
        v_source_binding_hash, v_lease_token_hash,
        pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
      );
      RETURN TRUE;
    EXCEPTION WHEN unique_violation THEN
      -- A concurrent first ACK won the insert; loop, lock, then enforce owner + monotonicity.
    END;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION ack_client_release(TEXT,TEXT,TEXT,BIGINT,TEXT) FROM PUBLIC;

-- Durable outbox fencing. Claiming a pending or expired-running job always advances lease_version.
CREATE OR REPLACE FUNCTION outbox_claim(
  p_job_type TEXT,
  p_lease_owner TEXT,
  p_lease_seconds INT DEFAULT 60
) RETURNS TABLE(
  claimed_job_id TEXT,
  claimed_job_type TEXT,
  job_payload JSONB,
  claimed_lease_version BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_job_type IS NULL OR p_lease_owner IS NULL OR pg_catalog.btrim(p_lease_owner) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'outbox job_type and lease_owner are required', DETAIL = 'VALIDATION';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 5 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid outbox lease', DETAIL = 'VALIDATION';
  END IF;

  -- Expired poison jobs are terminalized before another claim; they remain auditable as dead rows.
  -- Both import domains are excluded: their dedicated reconcilers must close job + batch atomically.
  UPDATE public.outbox_jobs
  SET status = 'dead',
      lease_owner = NULL,
      lease_expires_at = NULL,
      completed_at = now(),
      last_error = coalesce(last_error, 'MAX_ATTEMPTS_EXHAUSTED'),
      updated_at = now()
  WHERE job_type = p_job_type
    AND p_job_type NOT IN ('import_validate','work_order_import_validate')
    AND status = 'running'
    AND (lease_expires_at IS NULL OR lease_expires_at <= pg_catalog.clock_timestamp())
    AND attempts >= max_attempts;

  RETURN QUERY
  WITH candidate AS (
    SELECT j.job_id
    FROM public.outbox_jobs j
    WHERE j.job_type = p_job_type
      AND (
        (j.status = 'pending' AND j.available_at <= pg_catalog.clock_timestamp())
        OR (
          j.status = 'running'
          AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= pg_catalog.clock_timestamp())
        )
      )
      AND j.attempts < j.max_attempts
    ORDER BY j.created_at, j.job_id
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.outbox_jobs j
  SET status = 'running',
      attempts = j.attempts + 1,
      lease_owner = p_lease_owner,
      lease_version = j.lease_version + 1,
      lease_expires_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
      completed_at = NULL,
      updated_at = now()
  FROM candidate c
  WHERE j.job_id = c.job_id
  RETURNING j.job_id, j.job_type, j.payload, j.lease_version;
END;
$$;
REVOKE ALL ON FUNCTION outbox_claim(TEXT,TEXT,INT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION outbox_heartbeat(
  p_job_id TEXT,
  p_lease_owner TEXT,
  p_lease_version BIGINT,
  p_extend_seconds INT DEFAULT 60
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n INT;
BEGIN
  IF p_extend_seconds IS NULL OR p_extend_seconds < 5 OR p_extend_seconds > 300 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid outbox heartbeat extension', DETAIL = 'VALIDATION';
  END IF;
  UPDATE public.outbox_jobs
  SET lease_expires_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_extend_seconds),
      updated_at = now()
  WHERE job_id = p_job_id
    AND status = 'running'
    AND lease_owner = p_lease_owner
    AND lease_version = p_lease_version
    AND lease_expires_at > pg_catalog.clock_timestamp();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA006', MESSAGE = 'outbox lease lost', DETAIL = 'OUTBOX_LEASE_LOST';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION outbox_heartbeat(TEXT,TEXT,BIGINT,INT) FROM PUBLIC;

-- Retry is fenced too. A claimed job either returns to pending with bounded backoff or becomes dead.
CREATE OR REPLACE FUNCTION outbox_retry(
  p_job_id TEXT,
  p_lease_owner TEXT,
  p_lease_version BIGINT,
  p_retry_after_seconds INT DEFAULT 5,
  p_last_error TEXT DEFAULT NULL
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF p_retry_after_seconds IS NULL OR p_retry_after_seconds < 1 OR p_retry_after_seconds > 300 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid outbox retry delay', DETAIL = 'VALIDATION';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.outbox_jobs
    WHERE job_id = p_job_id AND job_type IN ('import_validate','work_order_import_validate')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'import validation must use its domain batch-closing retry function', DETAIL = 'INV_BYPASS';
  END IF;

  UPDATE public.outbox_jobs
  SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
      available_at = CASE
        WHEN attempts >= max_attempts THEN available_at
        ELSE pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_retry_after_seconds)
      END,
      lease_owner = NULL,
      lease_expires_at = NULL,
      completed_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
      last_error = p_last_error,
      updated_at = now()
  WHERE job_id = p_job_id
    AND status = 'running'
    AND lease_owner = p_lease_owner
    AND lease_version = p_lease_version
    AND lease_expires_at > pg_catalog.clock_timestamp()
  RETURNING status INTO v_status;

  IF v_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA006', MESSAGE = 'outbox lease lost', DETAIL = 'OUTBOX_LEASE_LOST';
  END IF;
  RETURN v_status;
END;
$$;
REVOKE ALL ON FUNCTION outbox_retry(TEXT,TEXT,BIGINT,INT,TEXT) FROM PUBLIC;

-- Capability-scoped worker entrypoints. The import role never receives the generic outbox APIs,
-- so it cannot claim, extend or retry event_upload/rewrite/announce jobs.
-- Reaper boundary: an exhausted import job and its validating batch must become terminal together.
-- Lock order is always batch -> outbox, matching cancel/finalize/retry and preventing deadlock cycles.
CREATE OR REPLACE FUNCTION reconcile_exhausted_content_imports(
  p_limit INT DEFAULT 10
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r RECORD;
  v_attempts INT;
  v_max_attempts INT;
  v_diagnostic_id TEXT;
  n INT;
  v_reconciled INT := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid import reconcile limit', DETAIL = 'VALIDATION';
  END IF;

  FOR r IN
    SELECT
      j.job_id,
      j.payload ->> 'import_batch_id' AS import_batch_id
    FROM public.outbox_jobs j
    WHERE j.job_type = 'import_validate'
      AND j.status = 'running'
      AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= pg_catalog.clock_timestamp())
      AND j.attempts >= j.max_attempts
    ORDER BY j.updated_at, j.job_id
    LIMIT p_limit
  LOOP
    IF r.import_batch_id IS NOT NULL AND pg_catalog.btrim(r.import_batch_id) <> '' THEN
      PERFORM 1
      FROM public.import_batches b
      WHERE b.import_batch_id = r.import_batch_id
      FOR UPDATE;
    END IF;

    UPDATE public.outbox_jobs j
    SET status = 'dead',
        lease_owner = NULL,
        lease_version = j.lease_version + 1,
        lease_expires_at = NULL,
        completed_at = now(),
        last_error = 'MAX_ATTEMPTS_EXHAUSTED',
        updated_at = now()
    WHERE j.job_id = r.job_id
      AND j.job_type = 'import_validate'
      AND j.status = 'running'
      AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= pg_catalog.clock_timestamp())
      AND j.attempts >= j.max_attempts
    RETURNING
      j.attempts,
      j.max_attempts
    INTO v_attempts, v_max_attempts;

    IF FOUND THEN
      v_diagnostic_id := 'diag_' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
      UPDATE public.import_batches b
      SET status = 'failed',
          error_report = pg_catalog.jsonb_build_object(
            'code', 'MAX_ATTEMPTS_EXHAUSTED',
            'diagnostic_id', v_diagnostic_id,
            'attempts', v_attempts,
            'max_attempts', v_max_attempts
          ),
          finished_at = now()
      WHERE b.import_batch_id = r.import_batch_id
        AND b.status = 'validating';
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n = 1 THEN
        INSERT INTO public.change_audits(
          change_id, action, actor_role, source, metadata, created_at
        ) VALUES (
          'chg_' || pg_catalog.gen_random_uuid()::text,
          'content_import_exhausted', 'system', 'reconcile_exhausted_content_imports',
          pg_catalog.jsonb_build_object(
            'diagnostic_id', v_diagnostic_id,
            'job_id', r.job_id,
            'import_batch_id', r.import_batch_id,
            'error_code', 'MAX_ATTEMPTS_EXHAUSTED'
          ),
          now()
        );
        v_reconciled := v_reconciled + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN v_reconciled;
END;
$$;
REVOKE ALL ON FUNCTION reconcile_exhausted_content_imports(INT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION claim_content_import_validation(
  p_lease_owner TEXT,
  p_lease_seconds INT DEFAULT 60
) RETURNS TABLE(
  claimed_job_id TEXT,
  claimed_job_type TEXT,
  job_payload JSONB,
  claimed_lease_version BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Claim remains a bounded short transaction: reap at most one poison job here. A scheduler may
  -- call the reconciler separately in <=10-row transactions; bulk reaping is deliberately forbidden.
  PERFORM public.reconcile_exhausted_content_imports(1);
  RETURN QUERY
  SELECT * FROM public.outbox_claim('import_validate', p_lease_owner, p_lease_seconds);
END;
$$;
REVOKE ALL ON FUNCTION claim_content_import_validation(TEXT,INT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION heartbeat_content_import_validation(
  p_job_id TEXT,
  p_lease_owner TEXT,
  p_lease_version BIGINT,
  p_extend_seconds INT DEFAULT 60
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.outbox_jobs
    WHERE job_id = p_job_id AND job_type = 'import_validate'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'job is outside import worker capability', DETAIL = 'INV_BYPASS';
  END IF;
  PERFORM public.outbox_heartbeat(p_job_id, p_lease_owner, p_lease_version, p_extend_seconds);
END;
$$;
REVOKE ALL ON FUNCTION heartbeat_content_import_validation(TEXT,TEXT,BIGINT,INT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION reconcile_exhausted_work_order_imports(
  p_limit INT DEFAULT 10
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r RECORD;
  v_attempts INT;
  v_max_attempts INT;
  v_diagnostic_id TEXT;
  n INT;
  v_reconciled INT := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid work-order reconcile limit', DETAIL = 'VALIDATION';
  END IF;

  FOR r IN
    SELECT
      j.job_id,
      j.payload ->> 'import_batch_id' AS import_batch_id
    FROM public.outbox_jobs j
    WHERE j.job_type = 'work_order_import_validate'
      AND j.status = 'running'
      AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= pg_catalog.clock_timestamp())
      AND j.attempts >= j.max_attempts
    ORDER BY j.updated_at, j.job_id
    LIMIT p_limit
  LOOP
    IF r.import_batch_id IS NOT NULL AND pg_catalog.btrim(r.import_batch_id) <> '' THEN
      PERFORM 1
      FROM public.work_order_import_batches b
      WHERE b.import_batch_id = r.import_batch_id
      FOR UPDATE;
    END IF;

    UPDATE public.outbox_jobs j
    SET status = 'dead',
        lease_owner = NULL,
        lease_version = j.lease_version + 1,
        lease_expires_at = NULL,
        completed_at = now(),
        last_error = 'MAX_ATTEMPTS_EXHAUSTED',
        updated_at = now()
    WHERE j.job_id = r.job_id
      AND j.job_type = 'work_order_import_validate'
      AND j.status = 'running'
      AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= pg_catalog.clock_timestamp())
      AND j.attempts >= j.max_attempts
    RETURNING j.attempts, j.max_attempts
    INTO v_attempts, v_max_attempts;

    IF FOUND THEN
      v_diagnostic_id := 'diag_' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
      UPDATE public.work_order_import_batches b
      SET status = 'failed',
          record_count = 0,
          accepted_count = 0,
          rejected_count = 0,
          error_report = pg_catalog.jsonb_build_object(
            'code', 'MAX_ATTEMPTS_EXHAUSTED',
            'diagnostic_id', v_diagnostic_id
          ),
          completed_at = now()
      WHERE b.import_batch_id = r.import_batch_id
        AND b.status = 'validating';
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n = 1 THEN
        INSERT INTO public.change_audits(
          change_id, action, actor_role, source, metadata, created_at
        ) VALUES (
          'chg_' || pg_catalog.gen_random_uuid()::text,
          'work_order_import_exhausted', 'system', 'reconcile_exhausted_work_order_imports',
          pg_catalog.jsonb_build_object(
            'diagnostic_id', v_diagnostic_id,
            'job_id', r.job_id,
            'import_batch_id', r.import_batch_id,
            'attempts', v_attempts,
            'max_attempts', v_max_attempts,
            'error_code', 'MAX_ATTEMPTS_EXHAUSTED'
          ),
          now()
        );
        v_reconciled := v_reconciled + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN v_reconciled;
END;
$$;
REVOKE ALL ON FUNCTION reconcile_exhausted_work_order_imports(INT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION claim_work_order_import_validation(
  p_lease_owner TEXT,
  p_lease_seconds INT DEFAULT 60
) RETURNS TABLE(
  claimed_job_id TEXT,
  claimed_job_type TEXT,
  job_payload JSONB,
  claimed_lease_version BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Keep poison-job closure bounded; scheduled reconciliation may call the same function in <=10 rows.
  PERFORM public.reconcile_exhausted_work_order_imports(1);
  RETURN QUERY
  SELECT * FROM public.outbox_claim('work_order_import_validate', p_lease_owner, p_lease_seconds);
END;
$$;
REVOKE ALL ON FUNCTION claim_work_order_import_validation(TEXT,INT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION heartbeat_work_order_import_validation(
  p_job_id TEXT,
  p_lease_owner TEXT,
  p_lease_version BIGINT,
  p_extend_seconds INT DEFAULT 60
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.outbox_jobs
    WHERE job_id = p_job_id AND job_type = 'work_order_import_validate'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'job is outside work-order worker capability', DETAIL = 'INV_BYPASS';
  END IF;
  PERFORM public.outbox_heartbeat(p_job_id, p_lease_owner, p_lease_version, p_extend_seconds);
END;
$$;
REVOKE ALL ON FUNCTION heartbeat_work_order_import_validation(TEXT,TEXT,BIGINT,INT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION retry_work_order_import_validation(
  p_job_id TEXT,
  p_lease_owner TEXT,
  p_lease_version BIGINT,
  p_retry_after_seconds INT DEFAULT 5,
  p_last_error TEXT DEFAULT NULL
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_import_batch_id TEXT;
  v_batch_status TEXT;
  v_status TEXT;
  v_attempts INT;
  v_max_attempts INT;
  v_safe_error_code TEXT;
  v_diagnostic_id TEXT;
BEGIN
  IF p_retry_after_seconds IS NULL OR p_retry_after_seconds < 1 OR p_retry_after_seconds > 300 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid work-order retry delay', DETAIL = 'VALIDATION';
  END IF;
  v_safe_error_code := CASE pg_catalog.upper(pg_catalog.btrim(p_last_error))
    WHEN 'VALIDATION_FAILED' THEN 'VALIDATION_FAILED'
    WHEN 'SOURCE_UNREADABLE' THEN 'SOURCE_UNREADABLE'
    WHEN 'HASH_MISMATCH' THEN 'HASH_MISMATCH'
    WHEN 'UNSUPPORTED_FORMAT' THEN 'UNSUPPORTED_FORMAT'
    WHEN 'STORAGE_UNAVAILABLE' THEN 'STORAGE_UNAVAILABLE'
    ELSE 'WORK_ORDER_IMPORT_RETRY'
  END;

  SELECT j.payload ->> 'import_batch_id'
  INTO v_import_batch_id
  FROM public.outbox_jobs j
  WHERE j.job_id = p_job_id
    AND j.job_type = 'work_order_import_validate';
  IF NOT FOUND OR v_import_batch_id IS NULL OR pg_catalog.btrim(v_import_batch_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'job is outside work-order worker capability', DETAIL = 'INV_BYPASS';
  END IF;

  SELECT b.status
  INTO v_batch_status
  FROM public.work_order_import_batches b
  WHERE b.import_batch_id = v_import_batch_id
  FOR UPDATE;
  IF NOT FOUND OR v_batch_status IS DISTINCT FROM 'validating' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA006', MESSAGE = 'work-order batch is no longer owned by this worker', DETAIL = 'OUTBOX_LEASE_LOST';
  END IF;

  UPDATE public.outbox_jobs j
  SET status = CASE WHEN j.attempts >= j.max_attempts THEN 'dead' ELSE 'pending' END,
      available_at = CASE
        WHEN j.attempts >= j.max_attempts THEN j.available_at
        ELSE pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_retry_after_seconds)
      END,
      lease_owner = NULL,
      lease_version = CASE WHEN j.attempts >= j.max_attempts THEN j.lease_version + 1 ELSE j.lease_version END,
      lease_expires_at = NULL,
      completed_at = CASE WHEN j.attempts >= j.max_attempts THEN now() ELSE NULL END,
      last_error = v_safe_error_code,
      updated_at = now()
  WHERE j.job_id = p_job_id
    AND j.job_type = 'work_order_import_validate'
    AND j.status = 'running'
    AND j.lease_owner = p_lease_owner
    AND j.lease_version = p_lease_version
    AND j.lease_expires_at > pg_catalog.clock_timestamp()
  RETURNING j.status, j.attempts, j.max_attempts
  INTO v_status, v_attempts, v_max_attempts;

  IF v_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA006', MESSAGE = 'work-order outbox lease lost', DETAIL = 'OUTBOX_LEASE_LOST';
  END IF;
  IF v_status = 'dead' THEN
    v_diagnostic_id := 'diag_' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
    UPDATE public.work_order_import_batches b
    SET status = 'failed',
        record_count = 0,
        accepted_count = 0,
        rejected_count = 0,
        error_report = pg_catalog.jsonb_build_object(
          'code', 'MAX_ATTEMPTS_EXHAUSTED',
          'diagnostic_id', v_diagnostic_id
        ),
        completed_at = now()
    WHERE b.import_batch_id = v_import_batch_id
      AND b.status = 'validating';
    INSERT INTO public.change_audits(
      change_id, action, actor_role, source, metadata, created_at
    ) VALUES (
      'chg_' || pg_catalog.gen_random_uuid()::text,
      'work_order_import_exhausted', 'system', 'retry_work_order_import_validation',
      pg_catalog.jsonb_build_object(
        'diagnostic_id', v_diagnostic_id,
        'job_id', p_job_id,
        'import_batch_id', v_import_batch_id,
        'attempts', v_attempts,
        'max_attempts', v_max_attempts,
        'error_code', v_safe_error_code
      ),
      now()
    );
  END IF;
  RETURN v_status;
END;
$$;
REVOKE ALL ON FUNCTION retry_work_order_import_validation(TEXT,TEXT,BIGINT,INT,TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION retry_content_import_validation(
  p_job_id TEXT,
  p_lease_owner TEXT,
  p_lease_version BIGINT,
  p_retry_after_seconds INT DEFAULT 5,
  p_last_error TEXT DEFAULT NULL
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_import_batch_id TEXT;
  v_batch_status TEXT;
  v_status TEXT;
  v_attempts INT;
  v_max_attempts INT;
  v_safe_error_code TEXT;
  v_diagnostic_id TEXT;
BEGIN
  IF p_retry_after_seconds IS NULL OR p_retry_after_seconds < 1 OR p_retry_after_seconds > 300 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid import retry delay', DETAIL = 'VALIDATION';
  END IF;
  -- p_last_error is a legacy parameter name. Only an allowlisted, non-sensitive token is persisted;
  -- raw parser/storage diagnostics belong in a restricted log keyed by diagnostic_id.
  v_safe_error_code := CASE pg_catalog.upper(pg_catalog.btrim(p_last_error))
    WHEN 'VALIDATION_FAILED' THEN 'VALIDATION_FAILED'
    WHEN 'SOURCE_UNREADABLE' THEN 'SOURCE_UNREADABLE'
    WHEN 'HASH_MISMATCH' THEN 'HASH_MISMATCH'
    WHEN 'UNSUPPORTED_FORMAT' THEN 'UNSUPPORTED_FORMAT'
    WHEN 'STORAGE_UNAVAILABLE' THEN 'STORAGE_UNAVAILABLE'
    ELSE 'IMPORT_VALIDATION_RETRY'
  END;
  SELECT j.payload ->> 'import_batch_id'
  INTO v_import_batch_id
  FROM public.outbox_jobs j
  WHERE j.job_id = p_job_id
    AND j.job_type = 'import_validate';
  IF NOT FOUND OR v_import_batch_id IS NULL OR pg_catalog.btrim(v_import_batch_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'job is outside import worker capability', DETAIL = 'INV_BYPASS';
  END IF;

  SELECT b.status
  INTO v_batch_status
  FROM public.import_batches b
  WHERE b.import_batch_id = v_import_batch_id
  FOR UPDATE;
  IF NOT FOUND OR v_batch_status IS DISTINCT FROM 'validating' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA006', MESSAGE = 'import batch is no longer owned by this worker', DETAIL = 'OUTBOX_LEASE_LOST';
  END IF;

  UPDATE public.outbox_jobs j
  SET status = CASE WHEN j.attempts >= j.max_attempts THEN 'dead' ELSE 'pending' END,
      available_at = CASE
        WHEN j.attempts >= j.max_attempts THEN j.available_at
        ELSE pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_retry_after_seconds)
      END,
      lease_owner = NULL,
      lease_version = CASE WHEN j.attempts >= j.max_attempts THEN j.lease_version + 1 ELSE j.lease_version END,
      lease_expires_at = NULL,
      completed_at = CASE WHEN j.attempts >= j.max_attempts THEN now() ELSE NULL END,
      last_error = v_safe_error_code,
      updated_at = now()
  WHERE j.job_id = p_job_id
    AND j.job_type = 'import_validate'
    AND j.status = 'running'
    AND j.lease_owner = p_lease_owner
    AND j.lease_version = p_lease_version
    AND j.lease_expires_at > pg_catalog.clock_timestamp()
  RETURNING j.status, j.attempts, j.max_attempts
  INTO v_status, v_attempts, v_max_attempts;

  IF v_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA006', MESSAGE = 'outbox lease lost', DETAIL = 'OUTBOX_LEASE_LOST';
  END IF;
  IF v_status = 'dead' THEN
    v_diagnostic_id := 'diag_' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
    UPDATE public.import_batches b
    SET status = 'failed',
        error_report = pg_catalog.jsonb_build_object(
          'code', 'MAX_ATTEMPTS_EXHAUSTED',
          'diagnostic_id', v_diagnostic_id,
          'attempts', v_attempts,
          'max_attempts', v_max_attempts
        ),
        finished_at = now()
    WHERE b.import_batch_id = v_import_batch_id
      AND b.status = 'validating';
    INSERT INTO public.change_audits(
      change_id, action, actor_role, source, metadata, created_at
    ) VALUES (
      'chg_' || pg_catalog.gen_random_uuid()::text,
      'content_import_exhausted', 'system', 'retry_content_import_validation',
      pg_catalog.jsonb_build_object(
        'diagnostic_id', v_diagnostic_id,
        'job_id', p_job_id,
        'import_batch_id', v_import_batch_id,
        'error_code', v_safe_error_code
      ),
      now()
    );
  END IF;
  RETURN v_status;
END;
$$;
REVOKE ALL ON FUNCTION retry_content_import_validation(TEXT,TEXT,BIGINT,INT,TEXT) FROM PUBLIC;

-- Record one server-authorized human decision. Normal import workers have no EXECUTE or table INSERT;
-- the caller capability must match the immutable reviewer role encoded by this row.
CREATE OR REPLACE FUNCTION record_content_review_decision(
  p_decision_id TEXT,
  p_script_id TEXT,
  p_content_hash TEXT,
  p_reviewer_role TEXT,
  p_reviewer_subject_hash TEXT,
  p_reviewer_subject_key_version TEXT,
  p_evidence_ref TEXT,
  p_decision TEXT,
  p_decided_at TIMESTAMPTZ,
  p_actor_capability TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_existing public.content_review_decisions%ROWTYPE;
BEGIN
  IF p_decision_id IS NULL OR p_decision_id !~ '^crd_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'
     OR p_script_id IS NULL OR pg_catalog.btrim(p_script_id) = ''
     OR p_content_hash IS NULL OR p_content_hash !~ '^[0-9a-f]{64}$'
     OR p_reviewer_role NOT IN ('ROLE-CONTENT-LEAD','ROLE-CS-MANAGER')
     OR p_reviewer_subject_hash IS NULL OR p_reviewer_subject_hash !~ '^[0-9a-f]{64}$'
     OR p_reviewer_subject_key_version IS NULL
     OR p_reviewer_subject_key_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
     OR p_evidence_ref IS NULL OR pg_catalog.btrim(p_evidence_ref) = ''
     OR p_decision NOT IN ('approved','rejected')
     OR p_decided_at IS NULL OR p_decided_at > pg_catalog.clock_timestamp()
     OR (p_reviewer_role = 'ROLE-CONTENT-LEAD' AND p_actor_capability IS DISTINCT FROM 'content_review_lead')
     OR (p_reviewer_role = 'ROLE-CS-MANAGER' AND p_actor_capability IS DISTINCT FROM 'content_review_manager') THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'review decision capability or payload is invalid', DETAIL = 'FORBIDDEN';
  END IF;

  INSERT INTO public.content_review_decisions(
    decision_id, script_id, content_hash, reviewer_role,
    reviewer_subject_hash, reviewer_subject_key_version,
    evidence_ref, decision, decided_at, recorded_at
  ) VALUES (
    p_decision_id, p_script_id, p_content_hash, p_reviewer_role,
    p_reviewer_subject_hash, p_reviewer_subject_key_version,
    p_evidence_ref, p_decision, p_decided_at, pg_catalog.clock_timestamp()
  ) ON CONFLICT DO NOTHING;

  SELECT review.* INTO v_existing
  FROM public.content_review_decisions review
  WHERE review.decision_id = p_decision_id;
  IF NOT FOUND
     OR v_existing.script_id IS DISTINCT FROM p_script_id
     OR v_existing.content_hash IS DISTINCT FROM p_content_hash
     OR v_existing.reviewer_role IS DISTINCT FROM p_reviewer_role
     OR v_existing.reviewer_subject_hash IS DISTINCT FROM p_reviewer_subject_hash
     OR v_existing.reviewer_subject_key_version IS DISTINCT FROM p_reviewer_subject_key_version
     OR v_existing.evidence_ref IS DISTINCT FROM p_evidence_ref
     OR v_existing.decision IS DISTINCT FROM p_decision
     OR v_existing.decided_at IS DISTINCT FROM p_decided_at THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'review decision was replayed with different inputs', DETAIL = 'IDEMPOTENCY_BODY_MISMATCH';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION record_content_review_decision(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT
) FROM PUBLIC;

-- Freeze the replayable quality sample before any result evidence is accepted. Plan freeze is an
-- import-worker capability; evidence recording is restricted to app_content_admin. Neither is a
-- public HTTP route, and both share the import job fencing token.
DROP FUNCTION IF EXISTS freeze_content_quality_review_plan(
  TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TIMESTAMPTZ,INTEGER,INTEGER,INTEGER,TEXT,TEXT,TEXT
);
CREATE OR REPLACE FUNCTION freeze_content_quality_review_plan(
  p_job_id TEXT,
  p_lease_owner TEXT,
  p_lease_version BIGINT,
  p_import_batch_id TEXT,
  p_plan_id TEXT,
  p_sampling_policy_version TEXT,
  p_cutoff_at TIMESTAMPTZ,
  p_clean_population_count INTEGER,
  p_ordinary_population_count INTEGER,
  p_mandatory_full_review_count INTEGER,
  p_selection_seed_hash TEXT,
  p_selection_manifest_hash TEXT,
  p_selection_algorithm TEXT,
  p_population_rows JSONB
) RETURNS TABLE(
  frozen_plan_id TEXT,
  initial_sample_target INTEGER,
  expanded_sample_target INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_initial_target INTEGER;
  v_expanded_target INTEGER;
  v_population_manifest_hash TEXT;
  v_derived_population_count INTEGER;
  v_derived_ordinary_count INTEGER;
  v_derived_mandatory_count INTEGER;
  v_existing public.content_quality_review_plans%ROWTYPE;
BEGIN
  IF p_plan_id IS NULL OR p_plan_id !~ '^qplan_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'
     OR p_sampling_policy_version IS NULL OR pg_catalog.btrim(p_sampling_policy_version) = ''
     OR p_cutoff_at IS NULL OR p_cutoff_at > pg_catalog.clock_timestamp()
     OR p_clean_population_count IS NULL OR p_clean_population_count < 0 OR p_clean_population_count > 5000
     OR p_ordinary_population_count IS NULL OR p_ordinary_population_count < 0
     OR p_mandatory_full_review_count IS NULL OR p_mandatory_full_review_count < 0
     OR p_clean_population_count <> p_ordinary_population_count + p_mandatory_full_review_count
     OR p_selection_seed_hash IS NULL OR p_selection_seed_hash !~ '^[0-9a-f]{64}$'
     OR p_selection_manifest_hash IS NULL OR p_selection_manifest_hash !~ '^[0-9a-f]{64}$'
     OR p_selection_algorithm IS DISTINCT FROM 'sha256-ranked-v1'
     OR pg_catalog.jsonb_typeof(p_population_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'quality review plan is invalid', DETAIL = 'QUALITY_PLAN_INVALID';
  END IF;

  v_population_manifest_hash := public.content_quality_population_manifest_hash(p_population_rows);
  SELECT
    pg_catalog.count(*) FILTER (
      WHERE coalesce(row_item.value ->> 'operation', 'upsert') = 'upsert'
    )::INTEGER,
    pg_catalog.count(*) FILTER (
      WHERE coalesce(row_item.value ->> 'operation', 'upsert') = 'upsert'
        AND row_item.value ->> 'risk_level' IN ('low','medium')
        AND row_item.value ->> 'has_conflict' = 'false'
    )::INTEGER,
    pg_catalog.count(*) FILTER (
      WHERE coalesce(row_item.value ->> 'operation', 'upsert') = 'upsert'
        AND (
          row_item.value ->> 'risk_level' = 'high'
          OR row_item.value ->> 'has_conflict' = 'true'
        )
    )::INTEGER
  INTO v_derived_population_count, v_derived_ordinary_count, v_derived_mandatory_count
  FROM pg_catalog.jsonb_array_elements(p_population_rows) AS row_item(value);
  IF p_clean_population_count IS DISTINCT FROM v_derived_population_count
     OR p_ordinary_population_count IS DISTINCT FROM v_derived_ordinary_count
     OR p_mandatory_full_review_count IS DISTINCT FROM v_derived_mandatory_count THEN
    RAISE EXCEPTION USING
      ERRCODE = 'ZA001',
      MESSAGE = 'quality counts do not match the DB-computed population manifest',
      DETAIL = 'QUALITY_POPULATION_MISMATCH';
  END IF;

  PERFORM 1
  FROM public.outbox_jobs job
  WHERE job.job_id = p_job_id
    AND job.job_type = 'import_validate'
    AND job.status = 'running'
    AND job.lease_owner = p_lease_owner
    AND job.lease_version = p_lease_version
    AND job.lease_expires_at > pg_catalog.clock_timestamp()
    AND job.payload ->> 'import_batch_id' = p_import_batch_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA006', MESSAGE = 'outbox lease lost before quality plan freeze', DETAIL = 'OUTBOX_LEASE_LOST';
  END IF;

  v_initial_target := CASE
    WHEN p_ordinary_population_count <= 500 THEN p_ordinary_population_count
    ELSE LEAST(
      300,
      GREATEST(100, pg_catalog.ceil(p_ordinary_population_count * 0.10)::INTEGER)
    )
  END;
  v_expanded_target := CASE
    WHEN p_ordinary_population_count <= 500 THEN p_ordinary_population_count
    ELSE pg_catalog.ceil(p_ordinary_population_count * 0.30)::INTEGER
  END;

  INSERT INTO public.content_quality_review_plans(
    plan_id, import_batch_id, sampling_policy_version, cutoff_at,
    clean_population_count, ordinary_population_count, mandatory_full_review_count,
    initial_sample_target, expanded_sample_target, selection_seed_hash,
    selection_manifest_hash, population_manifest_hash, selection_algorithm, frozen_at
  ) VALUES (
    p_plan_id, p_import_batch_id, p_sampling_policy_version, p_cutoff_at,
    p_clean_population_count, p_ordinary_population_count, p_mandatory_full_review_count,
    v_initial_target, v_expanded_target, p_selection_seed_hash,
    p_selection_manifest_hash, v_population_manifest_hash, p_selection_algorithm,
    pg_catalog.clock_timestamp()
  ) ON CONFLICT DO NOTHING;

  SELECT plan.* INTO v_existing
  FROM public.content_quality_review_plans plan
  WHERE plan.plan_id = p_plan_id;
  IF NOT FOUND
     OR v_existing.import_batch_id IS DISTINCT FROM p_import_batch_id
     OR v_existing.sampling_policy_version IS DISTINCT FROM p_sampling_policy_version
     OR v_existing.cutoff_at IS DISTINCT FROM p_cutoff_at
     OR v_existing.clean_population_count IS DISTINCT FROM p_clean_population_count
     OR v_existing.ordinary_population_count IS DISTINCT FROM p_ordinary_population_count
     OR v_existing.mandatory_full_review_count IS DISTINCT FROM p_mandatory_full_review_count
     OR v_existing.selection_seed_hash IS DISTINCT FROM p_selection_seed_hash
     OR v_existing.selection_manifest_hash IS DISTINCT FROM p_selection_manifest_hash
     OR v_existing.population_manifest_hash IS DISTINCT FROM v_population_manifest_hash
     OR v_existing.selection_algorithm IS DISTINCT FROM p_selection_algorithm THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'quality review plan id was reused with different inputs', DETAIL = 'IDEMPOTENCY_BODY_MISMATCH';
  END IF;

  frozen_plan_id := v_existing.plan_id;
  initial_sample_target := v_existing.initial_sample_target;
  expanded_sample_target := v_existing.expanded_sample_target;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION freeze_content_quality_review_plan(
  TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TIMESTAMPTZ,INTEGER,INTEGER,INTEGER,TEXT,TEXT,TEXT,JSONB
) FROM PUBLIC;

DROP FUNCTION IF EXISTS record_content_quality_review_evidence(
  TEXT,TEXT,BIGINT,TEXT,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,TEXT,TEXT
);
CREATE OR REPLACE FUNCTION record_content_quality_review_evidence(
  p_plan_id TEXT,
  p_initial_sample_reviewed_count INTEGER,
  p_initial_defect_count INTEGER,
  p_expanded_sample_reviewed_count INTEGER,
  p_expanded_defect_count INTEGER,
  p_mandatory_reviewed_count INTEGER,
  p_mandatory_defect_count INTEGER,
  p_publishable_clean_count INTEGER,
  p_review_quarantined_count INTEGER,
  p_conclusion TEXT,
  p_evidence_ref TEXT,
  p_actor_capability TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_plan public.content_quality_review_plans%ROWTYPE;
  v_existing public.content_quality_review_evidence%ROWTYPE;
  v_initial_rate NUMERIC;
  v_expanded_rate NUMERIC;
  v_expected_conclusion TEXT;
  v_final_ordinary_defects INTEGER;
BEGIN
  SELECT plan.* INTO v_plan
  FROM public.content_quality_review_plans plan
  WHERE plan.plan_id = p_plan_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA002', MESSAGE = 'quality review plan not found', DETAIL = 'NOT_FOUND';
  END IF;

  -- Quality evidence is durable plan evidence, not a worker-lease heartbeat. The isolated admin
  -- workload must present its server-side capability and the frozen plan/batch must still be open.
  IF p_actor_capability IS DISTINCT FROM 'content_quality_reviewer' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'quality reviewer capability is required', DETAIL = 'FORBIDDEN';
  END IF;
  PERFORM 1
  FROM public.import_batches batch
  WHERE batch.import_batch_id = v_plan.import_batch_id
    AND batch.status = 'validating'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'quality plan batch is no longer validating', DETAIL = 'CONFLICT';
  END IF;

  IF p_initial_sample_reviewed_count IS DISTINCT FROM v_plan.initial_sample_target
     OR p_initial_defect_count IS NULL OR p_initial_defect_count < 0
     OR p_initial_defect_count > p_initial_sample_reviewed_count
     OR p_mandatory_reviewed_count IS DISTINCT FROM v_plan.mandatory_full_review_count
     OR p_mandatory_defect_count IS NULL OR p_mandatory_defect_count < 0
     OR p_mandatory_defect_count > p_mandatory_reviewed_count
     OR p_publishable_clean_count IS NULL OR p_publishable_clean_count < 0
     OR p_review_quarantined_count IS NULL OR p_review_quarantined_count < 0
     OR p_publishable_clean_count + p_review_quarantined_count <> v_plan.clean_population_count
     OR p_conclusion IS NULL OR p_conclusion NOT IN ('passed','blocked')
     OR p_evidence_ref IS NULL OR pg_catalog.btrim(p_evidence_ref) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'quality review evidence shape is invalid', DETAIL = 'QUALITY_EVIDENCE_INVALID';
  END IF;

  v_initial_rate := CASE
    WHEN p_initial_sample_reviewed_count = 0 THEN 0
    ELSE p_initial_defect_count::NUMERIC / p_initial_sample_reviewed_count::NUMERIC
  END;
  IF v_plan.ordinary_population_count <= 500 OR v_initial_rate <= 0.02 OR v_initial_rate > 0.05 THEN
    IF p_expanded_sample_reviewed_count IS NOT NULL OR p_expanded_defect_count IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'quality expansion is not permitted for this initial result', DETAIL = 'QUALITY_EVIDENCE_INVALID';
    END IF;
    v_final_ordinary_defects := p_initial_defect_count;
    v_expected_conclusion := CASE WHEN v_initial_rate > 0.05 THEN 'blocked' ELSE 'passed' END;
  ELSE
    IF p_expanded_sample_reviewed_count IS DISTINCT FROM v_plan.expanded_sample_target
       OR p_expanded_defect_count IS NULL OR p_expanded_defect_count < 0
       OR p_expanded_defect_count > p_expanded_sample_reviewed_count THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = '30 percent expanded quality sample is required', DETAIL = 'QUALITY_EXPANSION_REQUIRED';
    END IF;
    v_expanded_rate := CASE
      WHEN p_expanded_sample_reviewed_count = 0 THEN 0
      ELSE p_expanded_defect_count::NUMERIC / p_expanded_sample_reviewed_count::NUMERIC
    END;
    v_final_ordinary_defects := p_expanded_defect_count;
    v_expected_conclusion := CASE WHEN v_expanded_rate > 0.05 THEN 'blocked' ELSE 'passed' END;
  END IF;

  IF p_conclusion IS DISTINCT FROM v_expected_conclusion
     OR p_review_quarantined_count < v_final_ordinary_defects + p_mandatory_defect_count THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'quality conclusion does not match frozen thresholds', DETAIL = 'QUALITY_THRESHOLD_MISMATCH';
  END IF;

  INSERT INTO public.content_quality_review_evidence(
    plan_id, import_batch_id, population_manifest_hash,
    initial_sample_reviewed_count, initial_defect_count,
    expanded_sample_reviewed_count, expanded_defect_count,
    mandatory_reviewed_count, mandatory_defect_count,
    publishable_clean_count, review_quarantined_count,
    conclusion, evidence_ref, recorded_at
  ) VALUES (
    p_plan_id, v_plan.import_batch_id, v_plan.population_manifest_hash,
    p_initial_sample_reviewed_count, p_initial_defect_count,
    p_expanded_sample_reviewed_count, p_expanded_defect_count,
    p_mandatory_reviewed_count, p_mandatory_defect_count,
    p_publishable_clean_count, p_review_quarantined_count,
    p_conclusion, p_evidence_ref, pg_catalog.clock_timestamp()
  ) ON CONFLICT DO NOTHING;

  SELECT evidence.* INTO v_existing
  FROM public.content_quality_review_evidence evidence
  WHERE evidence.plan_id = p_plan_id;
  IF NOT FOUND
     OR v_existing.import_batch_id IS DISTINCT FROM v_plan.import_batch_id
     OR v_existing.population_manifest_hash IS DISTINCT FROM v_plan.population_manifest_hash
     OR v_existing.initial_sample_reviewed_count IS DISTINCT FROM p_initial_sample_reviewed_count
     OR v_existing.initial_defect_count IS DISTINCT FROM p_initial_defect_count
     OR v_existing.expanded_sample_reviewed_count IS DISTINCT FROM p_expanded_sample_reviewed_count
     OR v_existing.expanded_defect_count IS DISTINCT FROM p_expanded_defect_count
     OR v_existing.mandatory_reviewed_count IS DISTINCT FROM p_mandatory_reviewed_count
     OR v_existing.mandatory_defect_count IS DISTINCT FROM p_mandatory_defect_count
     OR v_existing.publishable_clean_count IS DISTINCT FROM p_publishable_clean_count
     OR v_existing.review_quarantined_count IS DISTINCT FROM p_review_quarantined_count
     OR v_existing.conclusion IS DISTINCT FROM p_conclusion
     OR v_existing.evidence_ref IS DISTINCT FROM p_evidence_ref THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'quality evidence was replayed with different inputs', DETAIL = 'IDEMPOTENCY_BODY_MISMATCH';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION record_content_quality_review_evidence(
  TEXT,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,TEXT,TEXT,TEXT
) FROM PUBLIC;

-- Worker completion boundary: staging rows, batch terminal state and outbox completion are one fenced
-- transaction. app_runtime/app_import_worker receive no direct table write privilege for these states.
CREATE OR REPLACE FUNCTION finalize_content_import_validation(
  p_job_id TEXT,
  p_lease_owner TEXT,
  p_lease_version BIGINT,
  p_import_batch_id TEXT,
  p_final_status TEXT,
  p_staging_rows JSONB DEFAULT '[]'::jsonb,
  p_error_report JSONB DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n INT;
  v_public_error_report JSONB;
  v_diagnostic_id TEXT;
  v_population_manifest_hash TEXT;
  v_persisted_population_manifest_hash TEXT;
BEGIN
  IF p_final_status IS NULL OR p_final_status NOT IN ('staged', 'failed') THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'import validation final status must be staged or failed', DETAIL = 'VALIDATION';
  END IF;
  IF pg_catalog.jsonb_typeof(p_staging_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'staging_rows must be a JSON array', DETAIL = 'VALIDATION';
  END IF;
  v_population_manifest_hash := public.content_quality_population_manifest_hash(p_staging_rows);
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_staging_rows) AS item(value)
    WHERE item.value ?| ARRAY[
      'review_mode','primary_reviewer_id','primary_reviewer_role','primary_review_evd',
      'secondary_reviewer_id','secondary_reviewer_role','secondary_review_evd',
      'quality_gate_passed'
    ]
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'worker payload cannot self-assert review or quality decisions', DETAIL = 'REVIEW_EVIDENCE_TRUST_BOUNDARY';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_staging_rows) AS item(value)
    WHERE coalesce(item.value ->> 'operation', 'upsert') = 'upsert'
      AND public.content_questions_align_intent(
        item.value -> 'questions_json',
        item.value ->> 'intent_taxonomy_version',
        item.value ->> 'intent_id'
      ) IS DISTINCT FROM TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'question identity or lineage contract is invalid', DETAIL = 'CONTENT_CONTRACT_INVALID';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_staging_rows) AS item(value)
    WHERE coalesce(item.value ->> 'operation', 'upsert') NOT IN ('upsert','withdraw')
       OR coalesce(item.value ->> 'category', '') NOT IN ('presale','campaign','aftersale','product')
       OR coalesce(item.value ->> 'source_version_id', '') !~ '^srcv_[A-Za-z0-9][A-Za-z0-9._-]{0,126}$'
       OR (
        coalesce(item.value ->> 'operation', 'upsert') = 'upsert'
        AND (
        coalesce(pg_catalog.btrim(item.value ->> 'owner_role'), '') = ''
        OR coalesce(pg_catalog.btrim(item.value ->> 'review_due_at'), '') = ''
        OR coalesce(pg_catalog.btrim(item.value ->> 'effective_from'), '') = ''
        OR coalesce(pg_catalog.btrim(item.value ->> 'intent_taxonomy_version'), '') = ''
        OR coalesce(pg_catalog.btrim(item.value ->> 'intent_id'), '') = ''
        OR item.value -> 'risk_categories' IS NULL
        OR coalesce(pg_catalog.btrim(item.value ->> 'quality_status'), '') = ''
        OR item.value -> 'quality_issue_codes' IS NULL
        OR coalesce(pg_catalog.btrim(item.value ->> 'questions_grams_text'), '') = ''
        OR
        coalesce(pg_catalog.btrim(item.value ->> 'title_grams_text'), '') = ''
        OR coalesce(pg_catalog.btrim(item.value ->> 'answer_grams_text'), '') = ''
        OR coalesce(pg_catalog.btrim(item.value ->> 'search_fallback_text'), '') = ''
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'staging row requires a bound source and complete DEC-042 upsert fields', DETAIL = 'CONTENT_CONTRACT_INVALID';
  END IF;

  IF p_final_status = 'failed' AND pg_catalog.jsonb_array_length(p_staging_rows) <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'batch-fatal validation must not persist staging rows', DETAIL = 'CONTENT_CONTRACT_INVALID';
  END IF;

  -- Lock order is batch -> outbox, matching cancel_content_import, to avoid a deadlock cycle.
  PERFORM 1
  FROM public.import_batches b
  WHERE b.import_batch_id = p_import_batch_id
    AND b.status = 'validating'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'import batch is not validating', DETAIL = 'CONFLICT';
  END IF;

  PERFORM 1
  FROM public.outbox_jobs j
  WHERE j.job_id = p_job_id
    AND j.job_type = 'import_validate'
    AND j.status = 'running'
    AND j.lease_owner = p_lease_owner
    AND j.lease_version = p_lease_version
    AND j.lease_expires_at > pg_catalog.clock_timestamp()
    AND j.payload ->> 'import_batch_id' = p_import_batch_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA006', MESSAGE = 'outbox lease lost', DETAIL = 'OUTBOX_LEASE_LOST';
  END IF;

  IF p_final_status = 'staged' AND EXISTS (
    SELECT 1
    FROM public.import_batch_source_bindings ib
    JOIN public.authoritative_source_versions asv
      ON asv.source_version_id = ib.source_version_id AND asv.domain = ib.domain
    LEFT JOIN public.authoritative_source_suspensions susp
      ON susp.source_version_id = ib.source_version_id
    WHERE ib.import_batch_id = p_import_batch_id
      AND (asv.use_class <> 'canonical' OR susp.source_version_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'import source became ineligible during validation', DETAIL = 'SOURCE_SUSPENDED';
  END IF;
  IF p_final_status = 'staged' AND EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(p_staging_rows) r(category TEXT, source_version_id TEXT)
    LEFT JOIN public.import_batch_source_bindings ib
      ON ib.import_batch_id = p_import_batch_id
     AND ib.domain = r.category
     AND ib.source_version_id = r.source_version_id
    WHERE ib.import_batch_id IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'staging row source does not match its import binding', DETAIL = 'SOURCE_DOMAIN_MISMATCH';
  END IF;
  IF p_final_status = 'staged' AND EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(p_staging_rows) r(
      operation TEXT,
      quality_status TEXT,
      intent_taxonomy_version TEXT,
      intent_id TEXT
    )
    LEFT JOIN public.intent_taxonomy_entries entry
      ON entry.intent_taxonomy_version = r.intent_taxonomy_version
     AND entry.intent_id = r.intent_id
    WHERE coalesce(r.operation, 'upsert') = 'upsert'
      AND r.quality_status = 'clean'
      AND (entry.intent_id IS NULL OR entry.lifecycle <> 'active')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'clean row must bind an active taxonomy entry', DETAIL = 'CONTENT_CONTRACT_INVALID';
  END IF;
  IF p_final_status = 'staged' AND NOT EXISTS (
    SELECT 1
    FROM public.content_quality_review_plans plan
    JOIN public.content_quality_review_evidence evidence ON evidence.plan_id = plan.plan_id
    WHERE plan.import_batch_id = p_import_batch_id
      AND evidence.import_batch_id = p_import_batch_id
      AND evidence.conclusion = 'passed'
      AND plan.population_manifest_hash = v_population_manifest_hash
      AND evidence.population_manifest_hash = v_population_manifest_hash
      AND plan.clean_population_count = (
        SELECT pg_catalog.count(*)::INTEGER
        FROM pg_catalog.jsonb_array_elements(p_staging_rows) item(value)
        WHERE coalesce(item.value ->> 'operation', 'upsert') = 'upsert'
      )
      AND plan.mandatory_full_review_count = (
        SELECT pg_catalog.count(*)::INTEGER
        FROM pg_catalog.jsonb_array_elements(p_staging_rows) item(value)
        WHERE coalesce(item.value ->> 'operation', 'upsert') = 'upsert'
          AND (
            item.value ->> 'risk_level' = 'high'
            OR item.value ->> 'has_conflict' = 'true'
          )
      )
      AND evidence.publishable_clean_count = (
        SELECT pg_catalog.count(*)::INTEGER
        FROM pg_catalog.jsonb_array_elements(p_staging_rows) item(value)
        WHERE coalesce(item.value ->> 'operation', 'upsert') = 'upsert'
          AND item.value ->> 'quality_status' = 'clean'
      )
      AND evidence.review_quarantined_count = (
        SELECT pg_catalog.count(*)::INTEGER
        FROM pg_catalog.jsonb_array_elements(p_staging_rows) item(value)
        WHERE coalesce(item.value ->> 'operation', 'upsert') = 'upsert'
          AND item.value ->> 'quality_status' = 'quarantined'
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'frozen quality plan/evidence is missing, blocked or stale', DETAIL = 'QUALITY_GATE_NOT_PASSED';
  END IF;

  DELETE FROM public.staging_scripts WHERE import_batch_id = p_import_batch_id;

  IF p_final_status = 'staged' THEN
    IF pg_catalog.jsonb_array_length(p_staging_rows) < 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'staged import must contain at least one row', DETAIL = 'VALIDATION';
    END IF;

    -- The validator sends normalized 2-gram token streams separately so the database, rather than
    -- an untyped prebuilt tsvector, deterministically applies the frozen A/B/C field weights.
    BEGIN
      INSERT INTO public.staging_scripts(
        staging_id, import_batch_id, script_id, operation, category, title, answer_text,
        content_hash, source_ref, source_version_id, owner_role, review_due_at,
        platform_scope, product_scope_type, product_scope_refs, campaign_tag, effective_from, effective_to,
        intent_taxonomy_version, intent_id, risk_level, risk_categories, has_conflict, review_mode,
        primary_reviewer_id, primary_reviewer_role, primary_review_evd,
        secondary_reviewer_id, secondary_reviewer_role, secondary_review_evd, placeholder_keys,
        questions_json, search_document, search_fallback_text, validation_ok, validation_errors,
        quality_status, quality_issue_codes, quality_gate_passed
      )
      SELECT
        r.staging_id,
        p_import_batch_id,
        r.script_id,
        coalesce(r.operation, 'upsert'),
        r.category,
        r.title,
        r.answer_text,
        r.content_hash,
        asv.source_ref,
        r.source_version_id,
        r.owner_role,
        r.review_due_at,
        r.platform_scope,
        r.product_scope_type,
        r.product_scope_refs,
        r.campaign_tag,
        r.effective_from,
        r.effective_to,
        r.intent_taxonomy_version,
        r.intent_id,
        r.risk_level,
        r.risk_categories,
        r.has_conflict,
        CASE
          WHEN coalesce(r.operation, 'upsert') = 'withdraw' THEN NULL
          WHEN r.risk_level = 'high' OR r.has_conflict THEN 'dual'
          ELSE 'single'
        END,
        lead.reviewer_subject_hash,
        lead.reviewer_role,
        lead.evidence_ref,
        CASE WHEN r.risk_level = 'high' OR r.has_conflict THEN manager.reviewer_subject_hash ELSE NULL END,
        CASE WHEN r.risk_level = 'high' OR r.has_conflict THEN manager.reviewer_role ELSE NULL END,
        CASE WHEN r.risk_level = 'high' OR r.has_conflict THEN manager.evidence_ref ELSE NULL END,
        r.placeholder_keys,
        coalesce(r.questions_json, '[]'::jsonb),
        CASE
          WHEN coalesce(r.operation, 'upsert') = 'withdraw' THEN NULL
          ELSE
            pg_catalog.setweight(
              pg_catalog.to_tsvector('simple'::pg_catalog.regconfig, coalesce(r.questions_grams_text, '')),
              'A'
            )
            || pg_catalog.setweight(
              pg_catalog.to_tsvector('simple'::pg_catalog.regconfig, coalesce(r.title_grams_text, '')),
              'B'
            )
            || pg_catalog.setweight(
              pg_catalog.to_tsvector('simple'::pg_catalog.regconfig, coalesce(r.answer_grams_text, '')),
              'C'
            )
        END,
        r.search_fallback_text,
        TRUE,
        NULL,
        coalesce(r.quality_status, CASE WHEN coalesce(r.operation, 'upsert') = 'withdraw' THEN 'clean' ELSE 'quarantined' END),
        coalesce(r.quality_issue_codes, CASE WHEN coalesce(r.operation, 'upsert') = 'withdraw' THEN '[]'::jsonb ELSE '["CONTENT_NEEDS_REVIEW"]'::jsonb END),
        CASE
          WHEN coalesce(r.operation, 'upsert') = 'withdraw' THEN TRUE
          ELSE r.quality_status = 'clean'
        END
      FROM pg_catalog.jsonb_to_recordset(p_staging_rows) AS r(
        staging_id TEXT,
        script_id TEXT,
        operation TEXT,
        category TEXT,
        title TEXT,
        answer_text TEXT,
        content_hash TEXT,
        source_version_id TEXT,
        owner_role TEXT,
        review_due_at TIMESTAMPTZ,
        platform_scope TEXT[],
        product_scope_type TEXT,
        product_scope_refs TEXT[],
        campaign_tag TEXT,
        effective_from TIMESTAMPTZ,
        effective_to TIMESTAMPTZ,
        intent_taxonomy_version TEXT,
        intent_id TEXT,
        risk_level TEXT,
        risk_categories TEXT[],
        has_conflict BOOLEAN,
        placeholder_keys TEXT[],
        questions_json JSONB,
        questions_grams_text TEXT,
        title_grams_text TEXT,
        answer_grams_text TEXT,
        search_fallback_text TEXT,
        quality_status TEXT,
        quality_issue_codes JSONB
      )
      JOIN public.import_batch_source_bindings ib
        ON ib.import_batch_id = p_import_batch_id
       AND ib.domain = r.category
       AND ib.source_version_id = r.source_version_id
      JOIN public.authoritative_source_versions asv
        ON asv.source_version_id = ib.source_version_id
       AND asv.domain = ib.domain
      LEFT JOIN public.content_review_decisions lead
        ON coalesce(r.operation, 'upsert') = 'upsert'
       AND lead.script_id = r.script_id
       AND lead.content_hash = r.content_hash
       AND lead.reviewer_role = 'ROLE-CONTENT-LEAD'
       AND lead.decision = 'approved'
      LEFT JOIN public.content_review_decisions manager
        ON coalesce(r.operation, 'upsert') = 'upsert'
       AND manager.script_id = r.script_id
       AND manager.content_hash = r.content_hash
       AND manager.reviewer_role = 'ROLE-CS-MANAGER'
       AND manager.decision = 'approved'
      WHERE coalesce(r.operation, 'upsert') = 'withdraw'
         OR (
           lead.decision_id IS NOT NULL
           AND (
             (r.risk_level IN ('low','medium') AND NOT r.has_conflict)
             OR (
               (r.risk_level = 'high' OR r.has_conflict)
               AND manager.decision_id IS NOT NULL
               AND manager.reviewer_subject_key_version = lead.reviewer_subject_key_version
               AND manager.reviewer_subject_hash <> lead.reviewer_subject_hash
             )
           )
         );
      GET DIAGNOSTICS n = ROW_COUNT;
    EXCEPTION
      WHEN data_exception OR integrity_constraint_violation THEN
        RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid staging row payload', DETAIL = 'VALIDATION';
    END;
    IF n <> pg_catalog.jsonb_array_length(p_staging_rows) THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'staging row count mismatch', DETAIL = 'VALIDATION';
    END IF;
    v_persisted_population_manifest_hash :=
      public.content_quality_staging_population_manifest_hash(p_import_batch_id);
    IF v_persisted_population_manifest_hash IS DISTINCT FROM v_population_manifest_hash THEN
      RAISE EXCEPTION USING
        ERRCODE = 'ZA001',
        MESSAGE = 'persisted staging population differs from the frozen quality population',
        DETAIL = 'QUALITY_POPULATION_MISMATCH';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.staging_scripts s
      WHERE s.import_batch_id = p_import_batch_id
        AND s.operation = 'upsert'
        AND s.content_hash IS DISTINCT FROM public.content_governance_hash(
          s.script_id, s.category, s.title, s.answer_text, s.source_ref, s.source_version_id,
          s.owner_role, s.review_due_at, s.platform_scope, s.product_scope_type,
          s.product_scope_refs, s.effective_from, s.effective_to,
          s.intent_taxonomy_version, s.intent_id, s.risk_level, s.risk_categories, s.has_conflict,
          s.review_mode, s.primary_reviewer_id, s.primary_reviewer_role, s.primary_review_evd,
          s.secondary_reviewer_id, s.secondary_reviewer_role, s.secondary_review_evd,
          s.placeholder_keys, s.questions_json
        )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'staging governance snapshot hash mismatch', DETAIL = 'GOVERNANCE_HASH_MISMATCH';
    END IF;
    IF p_error_report IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'staged import must not include error_report', DETAIL = 'VALIDATION';
    END IF;
  ELSE
    IF p_error_report IS NULL OR pg_catalog.jsonb_typeof(p_error_report) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'failed import requires an object error_report', DETAIL = 'VALIDATION';
    END IF;
    IF p_error_report - ARRAY['code','row','column','error_count','issue_codes'] <> '{}'::jsonb THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'error_report contains non-public fields', DETAIL = 'VALIDATION';
    END IF;
    IF coalesce(p_error_report ->> 'code', '') NOT IN (
      'VALIDATION_FAILED', 'SOURCE_UNREADABLE', 'HASH_MISMATCH',
      'UNSUPPORTED_FORMAT', 'STORAGE_UNAVAILABLE', 'SOURCE_NOT_ELIGIBLE',
      'SOURCE_SUSPENDED', 'SOURCE_DOMAIN_MISMATCH', 'SOURCE_SNAPSHOT_MISMATCH',
      'SOURCE_SET_INCOMPLETE', 'CONTENT_CONTRACT_INVALID', 'GOVERNANCE_HASH_MISMATCH'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'error_report code is not allowlisted', DETAIL = 'VALIDATION';
    END IF;
    IF p_error_report ? 'row'
       AND (
         pg_catalog.jsonb_typeof(p_error_report -> 'row') IS DISTINCT FROM 'number'
         OR p_error_report ->> 'row' !~ '^[1-9][0-9]{0,8}$'
       ) THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'error_report row is invalid', DETAIL = 'VALIDATION';
    END IF;
    IF p_error_report ? 'column'
       AND (
         pg_catalog.jsonb_typeof(p_error_report -> 'column') IS DISTINCT FROM 'number'
         OR p_error_report ->> 'column' !~ '^[1-9][0-9]{0,8}$'
       ) THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'error_report column is invalid', DETAIL = 'VALIDATION';
    END IF;
    IF p_error_report ? 'error_count'
       AND (
         pg_catalog.jsonb_typeof(p_error_report -> 'error_count') IS DISTINCT FROM 'number'
         OR p_error_report ->> 'error_count' !~ '^[1-9][0-9]{0,8}$'
       ) THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'error_report error_count is invalid', DETAIL = 'VALIDATION';
    END IF;
    IF p_error_report ? 'issue_codes' THEN
      IF pg_catalog.jsonb_typeof(p_error_report -> 'issue_codes') IS DISTINCT FROM 'array'
         OR pg_catalog.jsonb_array_length(p_error_report -> 'issue_codes') > 26 THEN
        RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'error_report issue_codes is invalid', DETAIL = 'VALIDATION';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements_text(p_error_report -> 'issue_codes') AS issue(code)
        WHERE issue.code NOT IN (
          'MISSING_REQUIRED_FIELD', 'INVALID_FIELD_TYPE', 'INVALID_VALUE',
          'DUPLICATE_SCRIPT_ID', 'UNKNOWN_SCRIPT_ID', 'INVALID_EFFECTIVE_WINDOW',
          'MISSING_EFFECTIVE_WINDOW', 'HASH_MISMATCH', 'UNSUPPORTED_FORMAT',
          'MACRO_DETECTED', 'EXTERNAL_LINK_DETECTED', 'ROW_LIMIT_EXCEEDED',
          'CONTENT_TOO_LARGE', 'SOURCE_NOT_REGISTERED', 'SOURCE_NOT_CANONICAL',
          'SOURCE_SUSPENDED', 'SOURCE_DOMAIN_MISMATCH', 'SOURCE_SNAPSHOT_MISMATCH',
          'SOURCE_SET_INCOMPLETE', 'MISSING_PLATFORM_SCOPE', 'INVALID_PRODUCT_SCOPE',
          'INVALID_TAXONOMY_REF', 'INVALID_QUESTION_IDENTITY',
          'INVALID_REVIEW_EVIDENCE', 'INVALID_PLACEHOLDER_TEMPLATE',
          'GOVERNANCE_HASH_MISMATCH'
        )
      ) THEN
        RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'error_report issue code is not allowlisted', DETAIL = 'VALIDATION';
      END IF;
      IF (
        SELECT pg_catalog.count(*) <> pg_catalog.count(DISTINCT issue.code)
        FROM pg_catalog.jsonb_array_elements_text(p_error_report -> 'issue_codes') AS issue(code)
      ) THEN
        RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'error_report issue codes must be unique', DETAIL = 'VALIDATION';
      END IF;
    END IF;
    -- The database, not the worker payload, creates the public correlation token. This makes the
    -- value opaque and prevents encoded file content, paths or exception text from entering it.
    v_diagnostic_id := 'diag_' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
    v_public_error_report := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'code', p_error_report ->> 'code',
      'diagnostic_id', v_diagnostic_id,
      'row', CASE WHEN p_error_report ? 'row' THEN (p_error_report ->> 'row')::INT ELSE NULL END,
      'column', CASE WHEN p_error_report ? 'column' THEN (p_error_report ->> 'column')::INT ELSE NULL END,
      'error_count', CASE WHEN p_error_report ? 'error_count' THEN (p_error_report ->> 'error_count')::INT ELSE NULL END,
      'issue_codes', CASE WHEN p_error_report ? 'issue_codes' THEN p_error_report -> 'issue_codes' ELSE NULL END
    ));
  END IF;

  UPDATE public.import_batches
  SET status = p_final_status,
      quality_gate_passed = CASE
        WHEN p_final_status = 'staged' THEN EXISTS (
          SELECT 1 FROM public.staging_scripts s
          WHERE s.import_batch_id = p_import_batch_id
            AND s.quality_status = 'clean' AND s.quality_gate_passed
        )
        ELSE FALSE
      END,
      clean_count = CASE WHEN p_final_status = 'staged' THEN (
        SELECT pg_catalog.count(*)::INTEGER FROM public.staging_scripts s
        WHERE s.import_batch_id = p_import_batch_id AND s.quality_status = 'clean'
      ) ELSE 0 END,
      quarantined_count = CASE WHEN p_final_status = 'staged' THEN (
        SELECT pg_catalog.count(*)::INTEGER FROM public.staging_scripts s
        WHERE s.import_batch_id = p_import_batch_id AND s.quality_status = 'quarantined'
      ) ELSE 0 END,
      error_report = CASE WHEN p_final_status = 'failed' THEN v_public_error_report ELSE NULL END,
      finished_at = now()
  WHERE import_batch_id = p_import_batch_id;

  IF p_final_status = 'failed' THEN
    INSERT INTO public.change_audits(
      change_id, action, actor_role, source, metadata, created_at
    ) VALUES (
      'chg_' || pg_catalog.gen_random_uuid()::text,
      'content_import_validation_failed', 'system', 'finalize_content_import_validation',
      pg_catalog.jsonb_build_object(
        'diagnostic_id', v_diagnostic_id,
        'job_id', p_job_id,
        'import_batch_id', p_import_batch_id,
        'error_code', p_error_report ->> 'code'
      ),
      now()
    );
  END IF;

  UPDATE public.outbox_jobs
  SET status = 'done',
      lease_owner = NULL,
      lease_expires_at = NULL,
      completed_at = now(),
      last_error = NULL,
      updated_at = now()
  WHERE job_id = p_job_id
    AND status = 'running'
    AND lease_owner = p_lease_owner
    AND lease_version = p_lease_version
    AND lease_expires_at > pg_catalog.clock_timestamp();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA006', MESSAGE = 'outbox lease lost before atomic finalize', DETAIL = 'OUTBOX_LEASE_LOST';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION finalize_content_import_validation(TEXT,TEXT,BIGINT,TEXT,TEXT,JSONB,JSONB) FROM PUBLIC;

CREATE OR REPLACE FUNCTION finalize_work_order_import_validation(
  p_job_id TEXT,
  p_lease_owner TEXT,
  p_lease_version BIGINT,
  p_import_batch_id TEXT,
  p_final_status TEXT,
  p_records JSONB DEFAULT '[]'::jsonb,
  p_rejected_count INTEGER DEFAULT 0,
  p_error_report JSONB DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n INTEGER;
  v_tenant_scope TEXT;
  v_accepted_count INTEGER;
  v_public_error_report JSONB;
  v_diagnostic_id TEXT;
BEGIN
  IF p_final_status NOT IN ('ready','failed')
     OR pg_catalog.jsonb_typeof(p_records) IS DISTINCT FROM 'array'
     OR p_rejected_count IS NULL OR p_rejected_count < 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid work-order finalization envelope', DETAIL = 'VALIDATION';
  END IF;

  SELECT tenant_scope INTO v_tenant_scope
  FROM public.work_order_import_batches
  WHERE import_batch_id = p_import_batch_id
    AND status = 'validating'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA003', MESSAGE = 'work-order import batch is not validating', DETAIL = 'CONFLICT';
  END IF;

  PERFORM 1
  FROM public.outbox_jobs
  WHERE job_id = p_job_id
    AND job_type = 'work_order_import_validate'
    AND status = 'running'
    AND lease_owner = p_lease_owner
    AND lease_version = p_lease_version
    AND lease_expires_at > pg_catalog.clock_timestamp()
    AND payload ->> 'import_batch_id' = p_import_batch_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA006', MESSAGE = 'work-order outbox lease lost', DETAIL = 'OUTBOX_LEASE_LOST';
  END IF;

  IF p_final_status = 'ready' THEN
    IF p_error_report IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'ready work-order import cannot include error_report', DETAIL = 'VALIDATION';
    END IF;
    IF pg_catalog.jsonb_array_length(p_records) < 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'ready work-order import must contain at least one accepted record', DETAIL = 'VALIDATION';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(p_records) AS item(value)
      WHERE pg_catalog.jsonb_typeof(item.value) IS DISTINCT FROM 'object'
         OR coalesce(item.value ->> 'source_record_hash', '') !~ '^[0-9a-f]{64}$'
         OR coalesce(pg_catalog.btrim(item.value ->> 'normalization_version'), '') = ''
         OR (
           item.value ? 'product_ref_hash'
           AND item.value ->> 'product_ref_hash' IS NOT NULL
           AND item.value ->> 'product_ref_hash' !~ '^[0-9a-f]{64}$'
         )
         OR (
           item.value ? 'quality_tags'
           AND pg_catalog.jsonb_typeof(item.value -> 'quality_tags') IS DISTINCT FROM 'array'
         )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid normalized work-order record', DETAIL = 'VALIDATION';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(p_records) AS item(value)
      CROSS JOIN LATERAL pg_catalog.jsonb_object_keys(item.value) AS field(key)
      WHERE field.key NOT IN (
        'source_record_hash','category','issue_type','product_ref_hash','channel',
        'record_status','opened_at','closed_at','handling_seconds','error_type',
        'escalated','quality_tags','normalization_version'
      )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'work-order record contains a non-allowlisted field', DETAIL = 'UNKNOWN_COLUMN';
    END IF;

    INSERT INTO public.work_order_records(
      record_id, import_batch_id, tenant_scope, source_record_hash, category,
      issue_type, product_ref_hash, channel, record_status, opened_at, closed_at,
      handling_seconds, error_type, escalated, quality_tags, normalization_version
    )
    SELECT
      'wor_' || pg_catalog.gen_random_uuid()::text,
      p_import_batch_id,
      v_tenant_scope,
      item.value ->> 'source_record_hash',
      NULLIF(item.value ->> 'category', ''),
      NULLIF(item.value ->> 'issue_type', ''),
      NULLIF(item.value ->> 'product_ref_hash', ''),
      NULLIF(item.value ->> 'channel', ''),
      NULLIF(item.value ->> 'record_status', ''),
      NULLIF(item.value ->> 'opened_at', '')::TIMESTAMPTZ,
      NULLIF(item.value ->> 'closed_at', '')::TIMESTAMPTZ,
      NULLIF(item.value ->> 'handling_seconds', '')::INTEGER,
      NULLIF(item.value ->> 'error_type', ''),
      coalesce((item.value ->> 'escalated')::BOOLEAN, FALSE),
      ARRAY(
        SELECT pg_catalog.jsonb_array_elements_text(
          coalesce(item.value -> 'quality_tags', '[]'::jsonb)
        )
      ),
      item.value ->> 'normalization_version'
    FROM pg_catalog.jsonb_array_elements(p_records) AS item(value);

    v_accepted_count := pg_catalog.jsonb_array_length(p_records);
  ELSE
    IF pg_catalog.jsonb_array_length(p_records) <> 0
       OR p_error_report IS NULL
       OR pg_catalog.jsonb_typeof(p_error_report) IS DISTINCT FROM 'object'
       OR p_error_report ->> 'code' NOT IN (
         'VALIDATION_FAILED','SOURCE_UNREADABLE','HASH_MISMATCH',
         'UNSUPPORTED_FORMAT','STORAGE_UNAVAILABLE','MAX_ATTEMPTS_EXHAUSTED'
       )
       OR NOT public.work_order_issue_codes_are_public(p_error_report -> 'issue_codes') THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid work-order public error report', DETAIL = 'VALIDATION';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_object_keys(p_error_report) AS field(key)
      WHERE field.key NOT IN ('code','row','column','error_count','issue_codes')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'work-order error report contains unsafe fields', DETAIL = 'VALIDATION';
    END IF;
    v_diagnostic_id := 'diag_' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
    v_public_error_report := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'code', p_error_report ->> 'code',
      'diagnostic_id', v_diagnostic_id,
      'row', CASE WHEN p_error_report ? 'row' THEN (p_error_report ->> 'row')::INTEGER ELSE NULL END,
      'column', CASE WHEN p_error_report ? 'column' THEN (p_error_report ->> 'column')::INTEGER ELSE NULL END,
      'error_count', CASE WHEN p_error_report ? 'error_count' THEN (p_error_report ->> 'error_count')::INTEGER ELSE NULL END,
      'issue_codes', CASE WHEN p_error_report ? 'issue_codes' THEN p_error_report -> 'issue_codes' ELSE NULL END
    ));
    v_accepted_count := 0;
  END IF;

  UPDATE public.work_order_import_batches
  SET status = p_final_status,
      record_count = v_accepted_count + p_rejected_count,
      accepted_count = v_accepted_count,
      rejected_count = p_rejected_count,
      error_report = CASE WHEN p_final_status = 'failed' THEN v_public_error_report ELSE NULL END,
      completed_at = pg_catalog.clock_timestamp()
  WHERE import_batch_id = p_import_batch_id;

  UPDATE public.outbox_jobs
  SET status = 'done',
      lease_owner = NULL,
      lease_expires_at = NULL,
      completed_at = pg_catalog.clock_timestamp(),
      last_error = NULL,
      updated_at = pg_catalog.clock_timestamp()
  WHERE job_id = p_job_id
    AND status = 'running'
    AND lease_owner = p_lease_owner
    AND lease_version = p_lease_version
    AND lease_expires_at > pg_catalog.clock_timestamp();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA006', MESSAGE = 'work-order outbox lease lost before finalization', DETAIL = 'OUTBOX_LEASE_LOST';
  END IF;

  INSERT INTO public.change_audits(
    change_id, action, actor_role, source, metadata, created_at
  ) VALUES (
    'chg_' || pg_catalog.gen_random_uuid()::text,
    CASE WHEN p_final_status = 'ready' THEN 'work_order_import_ready' ELSE 'work_order_import_failed' END,
    'system',
    'finalize_work_order_import_validation',
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'import_batch_id', p_import_batch_id,
      'accepted_count', v_accepted_count,
      'rejected_count', p_rejected_count,
      'diagnostic_id', v_diagnostic_id
    )),
    pg_catalog.clock_timestamp()
  );
END;
$$;
REVOKE ALL ON FUNCTION finalize_work_order_import_validation(TEXT,TEXT,BIGINT,TEXT,TEXT,JSONB,INTEGER,JSONB) FROM PUBLIC;

CREATE OR REPLACE FUNCTION outbox_complete(
  p_job_id TEXT,
  p_lease_owner TEXT,
  p_lease_version BIGINT,
  p_final_status TEXT,
  p_last_error TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n INT;
BEGIN
  IF p_final_status IS NULL OR p_final_status NOT IN ('done','failed','dead') THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid outbox final status', DETAIL = 'VALIDATION';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.outbox_jobs
    WHERE job_id = p_job_id AND job_type IN ('import_validate','work_order_import_validate')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'import validation must use its domain atomic finalizer', DETAIL = 'INV_BYPASS';
  END IF;
  UPDATE public.outbox_jobs
  SET status = p_final_status,
      lease_owner = NULL,
      lease_expires_at = NULL,
      completed_at = now(),
      last_error = CASE WHEN p_final_status = 'done' THEN NULL ELSE p_last_error END,
      updated_at = now()
  WHERE job_id = p_job_id
    AND status = 'running'
    AND lease_owner = p_lease_owner
    AND lease_version = p_lease_version
    AND lease_expires_at > pg_catalog.clock_timestamp();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA006', MESSAGE = 'outbox lease lost', DETAIL = 'OUTBOX_LEASE_LOST';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION outbox_complete(TEXT,TEXT,BIGINT,TEXT,TEXT) FROM PUBLIC;

-- Token bucket: returns allowed + retry_after_sec (0 if allowed)
CREATE OR REPLACE FUNCTION rate_limit_take(
  p_bucket_key TEXT,
  p_capacity DOUBLE PRECISION,
  p_refill_per_sec DOUBLE PRECISION,
  p_cost DOUBLE PRECISION DEFAULT 1
) RETURNS TABLE(allowed BOOLEAN, retry_after_sec INT, tokens_left DOUBLE PRECISION)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r public.rate_limit_buckets%ROWTYPE;
  elapsed DOUBLE PRECISION;
  new_tokens DOUBLE PRECISION;
  need DOUBLE PRECISION;
  v_now TIMESTAMPTZ;
BEGIN
  IF p_bucket_key IS NULL OR pg_catalog.btrim(p_bucket_key) = ''
     OR p_capacity IS NULL OR p_refill_per_sec IS NULL OR p_cost IS NULL
     OR p_capacity <= 0 OR p_refill_per_sec <= 0 OR p_cost <= 0 OR p_cost > p_capacity THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid token bucket parameters', DETAIL = 'VALIDATION';
  END IF;
  INSERT INTO public.rate_limit_buckets(bucket_key, tokens, capacity, refill_per_sec, updated_at)
  VALUES (p_bucket_key, p_capacity, p_capacity, p_refill_per_sec, pg_catalog.clock_timestamp())
  ON CONFLICT (bucket_key) DO NOTHING;

  SELECT * INTO r FROM public.rate_limit_buckets WHERE bucket_key = p_bucket_key FOR UPDATE;
  v_now := pg_catalog.clock_timestamp();
  elapsed := greatest(0, EXTRACT(EPOCH FROM (v_now - r.updated_at)));
  new_tokens := LEAST(p_capacity, r.tokens + elapsed * p_refill_per_sec);
  IF new_tokens < p_cost THEN
    UPDATE public.rate_limit_buckets
      SET tokens = new_tokens, updated_at = v_now, capacity = p_capacity, refill_per_sec = p_refill_per_sec
      WHERE bucket_key = p_bucket_key;
    need := p_cost - new_tokens;
    allowed := FALSE;
    retry_after_sec := GREATEST(1, CEIL(need / NULLIF(p_refill_per_sec, 0))::INT);
    tokens_left := new_tokens;
    RETURN NEXT;
    RETURN;
  END IF;
  UPDATE public.rate_limit_buckets
    SET tokens = new_tokens - p_cost, updated_at = v_now, capacity = p_capacity, refill_per_sec = p_refill_per_sec
    WHERE bucket_key = p_bucket_key;
  allowed := TRUE;
  retry_after_sec := 0;
  tokens_left := new_tokens - p_cost;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION rate_limit_take(TEXT,DOUBLE PRECISION,DOUBLE PRECISION,DOUBLE PRECISION) FROM PUBLIC;

-- Read-only fast path used before rate limiting. A miss does not reserve the key; claim remains authoritative.
CREATE OR REPLACE FUNCTION idempotency_lookup(
  p_scope TEXT,
  p_idem_key TEXT,
  p_user_id TEXT,
  p_request_hash TEXT,
  p_request_hash_key_version TEXT
) RETURNS TABLE(action TEXT, status_code INT, response_body JSONB, detail TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r public.idempotency_keys%ROWTYPE;
BEGIN
  IF p_scope IS NULL OR pg_catalog.btrim(p_scope) = ''
     OR p_idem_key IS NULL OR pg_catalog.btrim(p_idem_key) = ''
     OR p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = ''
     OR p_request_hash IS NULL OR pg_catalog.btrim(p_request_hash) = ''
     OR p_request_hash_key_version IS NULL OR pg_catalog.btrim(p_request_hash_key_version) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'idempotency lookup inputs are required', DETAIL = 'VALIDATION';
  END IF;
  SELECT * INTO r
  FROM public.idempotency_keys
  WHERE scope = p_scope AND idem_key = p_idem_key;

  IF NOT FOUND OR r.expires_at <= pg_catalog.clock_timestamp() THEN
    action := 'miss'; status_code := NULL; response_body := NULL; detail := 'not_terminal';
  ELSIF r.user_id IS DISTINCT FROM p_user_id
        OR r.request_hash IS DISTINCT FROM p_request_hash
        OR r.request_hash_key_version IS DISTINCT FROM p_request_hash_key_version THEN
    action := 'conflict'; status_code := 409; response_body := NULL; detail := 'IDEMPOTENCY_BODY_MISMATCH';
  ELSIF r.status IN ('completed','failed') THEN
    action := 'replay'; status_code := r.status_code; response_body := r.response_body; detail := r.status;
  ELSIF r.status = 'pending'
        AND (r.lease_expires_at IS NULL OR r.lease_expires_at <= pg_catalog.clock_timestamp()) THEN
    action := 'miss'; status_code := NULL; response_body := NULL; detail := 'lease_reclaimable';
  ELSE
    action := 'conflict'; status_code := 409; response_body := NULL; detail := 'IDEMPOTENCY_IN_FLIGHT';
  END IF;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION idempotency_lookup(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

-- Allows the API to retain/reselect the correct HMAC key during the 24h idempotency TTL without
-- exposing the stored digest or allowing a different user to probe an existing key.
CREATE OR REPLACE FUNCTION idempotency_request_hash_version(
  p_scope TEXT,
  p_idem_key TEXT,
  p_user_id TEXT
) RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT request_hash_key_version
  FROM public.idempotency_keys
  WHERE scope = p_scope
    AND idem_key = p_idem_key
    AND user_id IS NOT DISTINCT FROM p_user_id
    AND expires_at > pg_catalog.clock_timestamp()
$$;
REVOKE ALL ON FUNCTION idempotency_request_hash_version(TEXT,TEXT,TEXT) FROM PUBLIC;

-- Idempotency atomic claim. Returns action: proceed | replay | conflict plus fencing version.
CREATE OR REPLACE FUNCTION idempotency_claim(
  p_scope TEXT,
  p_idem_key TEXT,
  p_user_id TEXT,
  p_request_hash TEXT,
  p_request_hash_key_version TEXT,
  p_lease_owner TEXT,
  p_lease_seconds INT DEFAULT 60
) RETURNS TABLE(
  action TEXT,           -- proceed | replay | conflict
  status_code INT,
  response_body JSONB,
  detail TEXT,
  lease_version BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r public.idempotency_keys%ROWTYPE;
  n INT;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 5 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid idempotency lease', DETAIL = 'VALIDATION';
  END IF;
  IF p_request_hash IS NULL OR pg_catalog.btrim(p_request_hash) = ''
     OR p_request_hash_key_version IS NULL OR pg_catalog.btrim(p_request_hash_key_version) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'request hash and version are required', DETAIL = 'VALIDATION';
  END IF;
  IF p_scope IS NULL OR pg_catalog.btrim(p_scope) = ''
     OR p_idem_key IS NULL OR pg_catalog.btrim(p_idem_key) = ''
     OR p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = ''
     OR p_lease_owner IS NULL OR pg_catalog.btrim(p_lease_owner) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'idempotency claim identity is required', DETAIL = 'VALIDATION';
  END IF;
  INSERT INTO public.idempotency_keys(
    scope, idem_key, user_id, request_hash, request_hash_key_version, status, lease_owner, lease_version,
    lease_expires_at, created_at, updated_at, expires_at
  ) VALUES (
    p_scope, p_idem_key, p_user_id, p_request_hash, p_request_hash_key_version, 'pending', p_lease_owner, 1,
    pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp() + interval '24 hours'
  )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 1 THEN
    action := 'proceed'; status_code := NULL; response_body := NULL; detail := 'claimed'; lease_version := 1;
    RETURN NEXT; RETURN;
  END IF;

  SELECT * INTO r FROM public.idempotency_keys
  WHERE scope = p_scope AND idem_key = p_idem_key FOR UPDATE;

  -- TTL expiry permits key reuse; lease expiry alone never permits a different body/user.
  IF r.expires_at <= pg_catalog.clock_timestamp() THEN
    UPDATE public.idempotency_keys
    SET user_id = p_user_id,
        request_hash = p_request_hash,
        request_hash_key_version = p_request_hash_key_version,
        status = 'pending',
        status_code = NULL,
        response_body = NULL,
        lease_owner = p_lease_owner,
        lease_version = r.lease_version + 1,
        lease_expires_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
        created_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp(),
        expires_at = pg_catalog.clock_timestamp() + interval '24 hours'
    WHERE scope = p_scope AND idem_key = p_idem_key;
    action := 'proceed'; status_code := NULL; response_body := NULL; detail := 'ttl_reclaimed';
    lease_version := r.lease_version + 1;
    RETURN NEXT; RETURN;
  END IF;

  IF r.user_id IS DISTINCT FROM p_user_id
     OR r.request_hash IS DISTINCT FROM p_request_hash
     OR r.request_hash_key_version IS DISTINCT FROM p_request_hash_key_version THEN
    action := 'conflict'; status_code := 409; response_body := NULL;
    detail := 'IDEMPOTENCY_BODY_MISMATCH'; lease_version := r.lease_version;
    RETURN NEXT; RETURN;
  END IF;
  IF r.status IN ('completed','failed') THEN
    action := 'replay'; status_code := r.status_code; response_body := r.response_body;
    detail := r.status; lease_version := r.lease_version;
    RETURN NEXT; RETURN;
  END IF;
  IF r.status = 'pending' AND r.lease_expires_at IS NOT NULL
     AND r.lease_expires_at > pg_catalog.clock_timestamp() THEN
    action := 'conflict'; status_code := 409; response_body := NULL;
    detail := 'IDEMPOTENCY_IN_FLIGHT'; lease_version := r.lease_version;
    RETURN NEXT; RETURN;
  END IF;
  -- Steal only an expired pending lease and increment the fencing token.
  UPDATE public.idempotency_keys
    SET status = 'pending',
        lease_owner = p_lease_owner,
        lease_version = r.lease_version + 1,
        lease_expires_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
        updated_at = pg_catalog.clock_timestamp()
    WHERE scope = p_scope AND idem_key = p_idem_key;
  action := 'proceed'; status_code := NULL; response_body := NULL;
  detail := 'lease_reclaimed'; lease_version := r.lease_version + 1;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION idempotency_claim(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION idempotency_complete(
  p_scope TEXT,
  p_idem_key TEXT,
  p_lease_owner TEXT,
  p_lease_version BIGINT,
  p_status_code INT,
  p_response_body JSONB,
  p_ok BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n INT;
BEGIN
  IF p_scope IS NULL OR pg_catalog.btrim(p_scope) = ''
     OR p_idem_key IS NULL OR pg_catalog.btrim(p_idem_key) = ''
     OR p_lease_owner IS NULL OR pg_catalog.btrim(p_lease_owner) = ''
     OR p_lease_version IS NULL OR p_status_code IS NULL OR p_status_code < 100 OR p_status_code > 599
     OR p_response_body IS NULL OR p_ok IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid idempotency completion', DETAIL = 'VALIDATION';
  END IF;
  UPDATE public.idempotency_keys
    SET status = CASE WHEN p_ok THEN 'completed' ELSE 'failed' END,
        status_code = p_status_code,
        response_body = p_response_body,
        lease_expires_at = NULL,
        updated_at = pg_catalog.clock_timestamp()
  WHERE scope = p_scope
    AND idem_key = p_idem_key
    AND status = 'pending'
    AND lease_owner = p_lease_owner
    AND lease_version = p_lease_version
    AND lease_expires_at > pg_catalog.clock_timestamp();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA006', MESSAGE = 'idempotency lease lost', DETAIL = 'IDEMPOTENCY_LEASE_LOST';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION idempotency_complete(TEXT,TEXT,TEXT,BIGINT,INT,JSONB,BOOLEAN) FROM PUBLIC;

CREATE OR REPLACE FUNCTION idempotency_heartbeat(
  p_scope TEXT,
  p_idem_key TEXT,
  p_lease_owner TEXT,
  p_lease_version BIGINT,
  p_extend_seconds INT DEFAULT 60
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n INT;
BEGIN
  IF p_extend_seconds IS NULL OR p_extend_seconds < 5 OR p_extend_seconds > 300 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid heartbeat extension', DETAIL = 'VALIDATION';
  END IF;
  IF p_scope IS NULL OR pg_catalog.btrim(p_scope) = ''
     OR p_idem_key IS NULL OR pg_catalog.btrim(p_idem_key) = ''
     OR p_lease_owner IS NULL OR pg_catalog.btrim(p_lease_owner) = ''
     OR p_lease_version IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'invalid idempotency heartbeat identity', DETAIL = 'VALIDATION';
  END IF;
  UPDATE public.idempotency_keys
  SET lease_expires_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_extend_seconds),
      updated_at = pg_catalog.clock_timestamp()
  WHERE scope = p_scope
    AND idem_key = p_idem_key
    AND status = 'pending'
    AND lease_owner = p_lease_owner
    AND lease_version = p_lease_version
    AND lease_expires_at > pg_catalog.clock_timestamp();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA006', MESSAGE = 'idempotency lease lost', DETAIL = 'IDEMPOTENCY_LEASE_LOST';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION idempotency_heartbeat(TEXT,TEXT,TEXT,BIGINT,INT) FROM PUBLIC;

-- Runtime gate for current and historical snapshot reads. Services MUST check this view before search,
-- announcement or snapshot output; a false gate means fail closed, never return the remaining domains.
CREATE OR REPLACE VIEW v_release_source_gate AS
SELECT
  cr.release_id,
  cr.release_seq,
  cr.source_binding_hash,
  (
    stats.source_count = 4
    AND NOT stats.has_noncanonical
    AND NOT stats.has_suspension
    AND stats.computed_hash IS NOT DISTINCT FROM cr.source_binding_hash
  ) AS source_gate_ready,
  CASE
    WHEN stats.source_count <> 4 THEN 'SOURCE_SET_INCOMPLETE'
    WHEN stats.has_noncanonical THEN 'SOURCE_NOT_ELIGIBLE'
    WHEN stats.has_suspension THEN 'SOURCE_SUSPENDED'
    WHEN stats.computed_hash IS DISTINCT FROM cr.source_binding_hash THEN 'SOURCE_BINDING_HASH_MISMATCH'
    ELSE NULL
  END AS source_gate_reason,
  CASE
    WHEN stats.source_count = 4
      AND NOT stats.has_noncanonical
      AND NOT stats.has_suspension
      AND stats.computed_hash IS NOT DISTINCT FROM cr.source_binding_hash
    THEN NULL
    ELSE 'SOURCE_GATE_NOT_READY'
  END AS runtime_error_reason
FROM public.content_releases cr
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

-- Recommendable view: ONLY a source-gated current release (INV-NR). Created after base tables exist.
CREATE OR REPLACE VIEW v_scripts_recommendable AS
SELECT
  ri.script_id,
  ri.category,
  ri.title,
  ri.answer_text,
  ri.script_version AS version,
  ri.content_hash,
  ri.source_ref,
  ri.source_version_id,
  ri.owner_role,
  ri.review_due_at,
  ri.platform_scope,
  ri.product_scope_type,
  ri.product_scope_refs,
  ri.effective_from,
  ri.effective_to,
  ri.intent_taxonomy_version,
  ri.intent_id,
  ri.risk_level,
  ri.risk_categories,
  ri.has_conflict,
  ri.review_mode,
  ri.primary_reviewer_role,
  ri.primary_review_evd,
  ri.secondary_reviewer_role,
  ri.secondary_review_evd,
  ri.placeholder_keys,
  ri.questions_json,
  ri.search_document,
  ri.search_fallback_text,
  cc.current_release_id AS release_id,
  gate.source_binding_hash
FROM content_current cc
JOIN v_release_source_gate gate
  ON gate.release_id = cc.current_release_id AND gate.source_gate_ready
JOIN release_items ri ON ri.release_id = cc.current_release_id
WHERE ri.effective_from <= now()
  AND (ri.effective_to IS NULL OR now() < ri.effective_to)
  AND public.content_questions_source_assets_are_active(ri.questions_json);

-- The only app_runtime-readable search boundary. Scope is a mandatory function argument, so a caller
-- cannot accidentally omit a WHERE clause and broaden platform/category/SKU visibility. app_runtime
-- has neither SELECT on this backing view nor on release_items/content_current. The function exposes
-- only the public question projection plus precomputed search evidence required by SearchBackend;
-- reviewer/source lineage and the original questions_json remain behind the DEFINER boundary.
DROP FUNCTION IF EXISTS search_recommendable_scripts(TEXT,TEXT,TEXT);
CREATE OR REPLACE FUNCTION search_recommendable_scripts(
  p_platform TEXT,
  p_product_context_type TEXT DEFAULT NULL,
  p_product_context_ref TEXT DEFAULT NULL
) RETURNS TABLE(
  script_id TEXT,
  script_version INTEGER,
  content_hash TEXT,
  title TEXT,
  category TEXT,
  answer_text TEXT,
  platform_scope TEXT[],
  product_scope_type TEXT,
  product_scope_refs TEXT[],
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  intent_taxonomy_version TEXT,
  intent_id TEXT,
  risk_level TEXT,
  risk_categories TEXT[],
  has_conflict BOOLEAN,
  placeholder_keys TEXT[],
  questions JSONB,
  search_document TSVECTOR,
  search_fallback_text TEXT,
  release_id TEXT,
  source_binding_hash TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_platform IS NULL OR p_platform NOT IN ('qianniu','douyin') THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'a confirmed platform is required for search', DETAIL = 'SEARCH_SCOPE_INVALID';
  END IF;
  IF NOT (
    (p_product_context_type IS NULL AND p_product_context_ref IS NULL)
    OR (
      p_product_context_type IN ('category','sku')
      AND p_product_context_ref IS NOT NULL
      AND pg_catalog.btrim(p_product_context_ref) <> ''
      AND pg_catalog.length(p_product_context_ref) <= 128
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'product context type and ref must be supplied together', DETAIL = 'SEARCH_SCOPE_INVALID';
  END IF;

  RETURN QUERY
  SELECT
    candidate.script_id,
    candidate.version,
    candidate.content_hash,
    candidate.title,
    candidate.category,
    candidate.answer_text,
    candidate.platform_scope,
    candidate.product_scope_type,
    candidate.product_scope_refs,
    candidate.effective_from,
    candidate.effective_to,
    candidate.intent_taxonomy_version,
    candidate.intent_id,
    candidate.risk_level,
    candidate.risk_categories,
    candidate.has_conflict,
    candidate.placeholder_keys,
    public.content_public_questions(candidate.questions_json),
    candidate.search_document,
    candidate.search_fallback_text,
    candidate.release_id,
    candidate.source_binding_hash
  FROM public.v_scripts_recommendable candidate
  WHERE public.content_scope_matches(
    candidate.platform_scope,
    candidate.product_scope_type,
    candidate.product_scope_refs,
    p_platform,
    p_product_context_type,
    p_product_context_ref
  );
END;
$$;
REVOKE ALL ON FUNCTION search_recommendable_scripts(TEXT,TEXT,TEXT) FROM PUBLIC;

-- Issue one opaque short lease for the source-gated current release. The shared advisory lock is
-- acquired first, matching publish/rollback/suspend lock order, so issuance cannot bind a half-switched
-- release. Only the token hash is persisted; the plaintext token is returned once to the caller.
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
  lease_expires_at := v_issued_at + pg_catalog.make_interval(secs => p_ttl_seconds);
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
REVOKE ALL ON FUNCTION issue_snapshot_offline_lease(TEXT,TEXT,INTEGER) FROM PUBLIC;

-- Every snapshot page and ACK validates the immutable token binding. Validation never extends expiry.
CREATE OR REPLACE FUNCTION validate_snapshot_offline_lease(
  p_offline_lease_token TEXT,
  p_client_id TEXT,
  p_user_id TEXT,
  p_release_id TEXT
) RETURNS TABLE(
  release_id TEXT,
  release_seq BIGINT,
  source_binding_hash TEXT,
  lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_token_hash TEXT;
  v_lease public.snapshot_offline_leases%ROWTYPE;
  v_release_seq BIGINT;
  v_gate_ready BOOLEAN;
BEGIN
  IF p_offline_lease_token IS NULL OR p_offline_lease_token !~ '^osl_[0-9a-f]{64}$'
     OR p_client_id IS NULL OR pg_catalog.btrim(p_client_id) = ''
     OR p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = ''
     OR p_release_id IS NULL OR pg_catalog.btrim(p_release_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'offline lease token is invalid', DETAIL = 'OFFLINE_LEASE_INVALID';
  END IF;
  v_token_hash := pg_catalog.encode(public.digest(
    pg_catalog.convert_to(p_offline_lease_token, 'UTF8'), 'sha256'
  ), 'hex');
  SELECT sol.* INTO v_lease
  FROM public.snapshot_offline_leases sol
  WHERE sol.lease_token_hash = v_token_hash;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'offline lease token is invalid', DETAIL = 'OFFLINE_LEASE_INVALID';
  END IF;
  IF v_lease.client_id IS DISTINCT FROM p_client_id
     OR v_lease.user_id IS DISTINCT FROM p_user_id
     OR v_lease.release_id IS DISTINCT FROM p_release_id THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'offline lease binding does not match request', DETAIL = 'OFFLINE_LEASE_BINDING_MISMATCH';
  END IF;
  IF v_lease.expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'offline lease has expired', DETAIL = 'OFFLINE_LEASE_EXPIRED';
  END IF;

  SELECT cr.release_seq, gate.source_gate_ready
  INTO v_release_seq, v_gate_ready
  FROM public.content_releases cr
  JOIN public.v_release_source_gate gate ON gate.release_id = cr.release_id
  WHERE cr.release_id = v_lease.release_id
    AND cr.source_binding_hash = v_lease.source_binding_hash;
  IF NOT FOUND OR v_gate_ready IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'leased source set is no longer ready', DETAIL = 'SOURCE_GATE_NOT_READY';
  END IF;

  release_id := v_lease.release_id;
  release_seq := v_release_seq;
  source_binding_hash := v_lease.source_binding_hash;
  lease_expires_at := v_lease.expires_at;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION validate_snapshot_offline_lease(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

-- Controlled announce/current read. The lease issuance, current/source-gate validation and minimum
-- announcement projection execute behind one DEFINER boundary; app_runtime never reads SoR tables.
CREATE OR REPLACE FUNCTION read_current_announcement_with_lease(
  p_client_id TEXT,
  p_user_id TEXT,
  p_ttl_seconds INTEGER DEFAULT 600
) RETURNS TABLE(
  current_release_id TEXT,
  release_seq BIGINT,
  source_binding_hash TEXT,
  offline_lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  announcement_id TEXT,
  announcement_title TEXT,
  announcement_summary TEXT,
  announcement_created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH authorized AS MATERIALIZED (
    SELECT lease.offline_lease_token, lease.lease_expires_at,
           lease.release_id, lease.source_binding_hash
    FROM public.issue_snapshot_offline_lease(p_client_id, p_user_id, p_ttl_seconds) lease
  )
  SELECT
    authorized.release_id,
    cr.release_seq,
    authorized.source_binding_hash,
    authorized.offline_lease_token,
    authorized.lease_expires_at,
    ann.announcement_id,
    ann.title,
    ann.summary,
    ann.created_at
  FROM authorized
  JOIN public.content_releases cr
    ON cr.release_id = authorized.release_id
   AND cr.source_binding_hash = authorized.source_binding_hash
  LEFT JOIN LATERAL (
    SELECT a.announcement_id, a.title, a.summary, a.created_at
    FROM public.announcements a
    WHERE a.release_id = authorized.release_id
    ORDER BY a.created_at DESC, a.announcement_id DESC
    LIMIT 1
  ) ann ON TRUE;
END;
$$;
REVOKE ALL ON FUNCTION read_current_announcement_with_lease(TEXT,TEXT,INTEGER) FROM PUBLIC;

-- Controlled snapshot page read. `authorized` and release_items are consumed by the same RETURN QUERY
-- statement and therefore the same PostgreSQL statement snapshot. The API receives one row even for an
-- empty page; only the wire-approved SnapshotItem fields are projected into items_json.
CREATE OR REPLACE FUNCTION read_snapshot_page(
  p_offline_lease_token TEXT,
  p_client_id TEXT,
  p_user_id TEXT,
  p_release_id TEXT,
  p_cursor TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 200
) RETURNS TABLE(
  release_id TEXT,
  release_seq BIGINT,
  source_binding_hash TEXT,
  lease_expires_at TIMESTAMPTZ,
  items_json JSONB,
  next_cursor TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500
     OR (p_cursor IS NOT NULL AND pg_catalog.btrim(p_cursor) = '') THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'snapshot cursor or limit is invalid', DETAIL = 'VALIDATION';
  END IF;

  RETURN QUERY
  WITH authorized AS MATERIALIZED (
    SELECT lease.release_id, lease.release_seq, lease.source_binding_hash, lease.lease_expires_at
    FROM public.validate_snapshot_offline_lease(
      p_offline_lease_token, p_client_id, p_user_id, p_release_id
    ) lease
  ), ordered AS MATERIALIZED (
    SELECT
      ri.script_id,
      ri.script_version,
      ri.content_hash,
      ri.title,
      ri.category,
      ri.answer_text,
      ri.platform_scope,
      ri.product_scope_type,
      ri.product_scope_refs,
      ri.effective_from,
      ri.effective_to,
      ri.intent_taxonomy_version,
      ri.intent_id,
      ri.risk_level,
      ri.risk_categories,
      ri.has_conflict,
      ri.placeholder_keys,
      ri.questions_json
    FROM authorized
    JOIN public.release_items ri ON ri.release_id = authorized.release_id
    WHERE p_cursor IS NULL OR ri.script_id > p_cursor
    ORDER BY ri.script_id
    LIMIT p_limit + 1
  ), page AS MATERIALIZED (
    SELECT * FROM ordered ORDER BY script_id LIMIT p_limit
  )
  SELECT
    authorized.release_id,
    authorized.release_seq,
    authorized.source_binding_hash,
    authorized.lease_expires_at,
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'script_id', page.script_id,
          'script_version', page.script_version,
          'content_hash', page.content_hash,
          'title', page.title,
          'category', page.category,
          'answer_text', page.answer_text,
          'platform_scope', pg_catalog.to_jsonb(page.platform_scope),
          'product_scope_type', page.product_scope_type,
          'product_scope_refs', pg_catalog.to_jsonb(page.product_scope_refs),
          'effective_from', page.effective_from,
          'effective_to', page.effective_to,
          'intent_taxonomy_version', page.intent_taxonomy_version,
          'intent_id', page.intent_id,
          'risk_level', page.risk_level,
          'risk_categories', pg_catalog.to_jsonb(page.risk_categories),
          'has_conflict', page.has_conflict,
          'placeholder_keys', pg_catalog.to_jsonb(page.placeholder_keys),
          'questions', public.content_public_questions(page.questions_json)
        ) ORDER BY page.script_id
      ) FILTER (WHERE page.script_id IS NOT NULL),
      '[]'::jsonb
    ),
    CASE
      WHEN (SELECT pg_catalog.count(*) FROM ordered) > p_limit
      THEN (SELECT p.script_id FROM page p ORDER BY p.script_id DESC LIMIT 1)
      ELSE NULL
    END
  FROM authorized
  LEFT JOIN page ON TRUE
  GROUP BY authorized.release_id, authorized.release_seq,
           authorized.source_binding_hash, authorized.lease_expires_at;
END;
$$;
REVOKE ALL ON FUNCTION read_snapshot_page(TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER) FROM PUBLIC;

-- app_runtime receives no raw import/staging SELECT. These actor-gated, closed projections expose
-- status and review preview only, never upload locators, reviewer subjects/EVD or search vectors.
CREATE OR REPLACE FUNCTION read_content_import_status(
  p_import_batch_id TEXT,
  p_actor_user_id TEXT,
  p_actor_role TEXT
) RETURNS TABLE(
  import_batch_id TEXT,
  status TEXT,
  quality_gate_passed BOOLEAN,
  clean_count INTEGER,
  quarantined_count INTEGER,
  error_report JSONB,
  created_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_actor_role NOT IN ('coach','owner')
     OR p_actor_user_id IS NULL OR pg_catalog.btrim(p_actor_user_id) = ''
     OR p_import_batch_id IS NULL OR pg_catalog.btrim(p_import_batch_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'content import status requires coach or owner', DETAIL = 'FORBIDDEN';
  END IF;
  RETURN QUERY
  SELECT
    batch.import_batch_id,
    batch.status,
    batch.quality_gate_passed,
    batch.clean_count,
    batch.quarantined_count,
    batch.error_report,
    batch.created_at,
    batch.finished_at
  FROM public.import_batches batch
  WHERE batch.import_batch_id = p_import_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA002', MESSAGE = 'content import batch not found', DETAIL = 'NOT_FOUND';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION read_content_import_status(TEXT,TEXT,TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION read_content_import_preview(
  p_import_batch_id TEXT,
  p_actor_user_id TEXT,
  p_actor_role TEXT,
  p_cursor TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 100
) RETURNS TABLE(rows_json JSONB, next_cursor TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_actor_role NOT IN ('coach','owner')
     OR p_actor_user_id IS NULL OR pg_catalog.btrim(p_actor_user_id) = ''
     OR p_import_batch_id IS NULL OR pg_catalog.btrim(p_import_batch_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA005', MESSAGE = 'content import preview requires coach or owner', DETAIL = 'FORBIDDEN';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200
     OR (p_cursor IS NOT NULL AND pg_catalog.btrim(p_cursor) = '') THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'content import preview cursor or limit is invalid', DETAIL = 'VALIDATION';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.import_batches batch
    WHERE batch.import_batch_id = p_import_batch_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA002', MESSAGE = 'content import batch not found', DETAIL = 'NOT_FOUND';
  END IF;

  RETURN QUERY
  WITH ordered AS MATERIALIZED (
    SELECT staged.*
    FROM public.staging_scripts staged
    WHERE staged.import_batch_id = p_import_batch_id
      AND (p_cursor IS NULL OR staged.staging_id > p_cursor)
    ORDER BY staged.staging_id
    LIMIT p_limit + 1
  ), page AS MATERIALIZED (
    SELECT * FROM ordered ORDER BY staging_id LIMIT p_limit
  )
  SELECT
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'staging_id', page.staging_id,
          'script_id', page.script_id,
          'operation', page.operation,
          'category', page.category,
          'title', page.title,
          'answer_text', page.answer_text,
          'content_hash', page.content_hash,
          'platform_scope', pg_catalog.to_jsonb(page.platform_scope),
          'product_scope_type', page.product_scope_type,
          'product_scope_refs', pg_catalog.to_jsonb(page.product_scope_refs),
          'effective_from', page.effective_from,
          'effective_to', page.effective_to,
          'intent_taxonomy_version', page.intent_taxonomy_version,
          'intent_id', page.intent_id,
          'risk_level', page.risk_level,
          'risk_categories', pg_catalog.to_jsonb(page.risk_categories),
          'has_conflict', page.has_conflict,
          'placeholder_keys', pg_catalog.to_jsonb(page.placeholder_keys),
          'questions', public.content_public_questions(page.questions_json),
          'quality_status', page.quality_status,
          'quality_issue_codes', page.quality_issue_codes
        ) ORDER BY page.staging_id
      ) FILTER (WHERE page.staging_id IS NOT NULL),
      '[]'::jsonb
    ),
    CASE
      WHEN (SELECT pg_catalog.count(*) FROM ordered) > p_limit
      THEN (SELECT staged_page.staging_id FROM page staged_page ORDER BY staged_page.staging_id DESC LIMIT 1)
      ELSE NULL
    END
  FROM page;
END;
$$;
REVOKE ALL ON FUNCTION read_content_import_preview(TEXT,TEXT,TEXT,TEXT,INTEGER) FROM PUBLIC;

-- Defense in depth for the search route: an application bug cannot turn a broken source gate into a
-- recorded no-hit. query_events and impressions must be written in one request transaction; either
-- trigger aborts that transaction before any search telemetry can commit.
CREATE OR REPLACE FUNCTION trg_source_gate_search_telemetry_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.content_current cc
    JOIN public.v_release_source_gate gate
      ON gate.release_id = cc.current_release_id
     AND gate.source_gate_ready
    WHERE cc.id = 1
      AND cc.current_release_id = NEW.release_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'ZA004',
      MESSAGE = 'search telemetry requires a ready current authoritative source set',
      DETAIL = 'SOURCE_GATE_NOT_READY';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION trg_source_gate_search_telemetry_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS query_source_gate_telemetry_guard ON query_events;
CREATE TRIGGER query_source_gate_telemetry_guard
  BEFORE INSERT ON query_events
  FOR EACH ROW EXECUTE FUNCTION trg_source_gate_search_telemetry_guard();
DROP TRIGGER IF EXISTS impression_source_gate_telemetry_guard ON candidate_impressions;
CREATE TRIGGER impression_source_gate_telemetry_guard
  BEFORE INSERT ON candidate_impressions
  FOR EACH ROW EXECUTE FUNCTION trg_source_gate_search_telemetry_guard();

-- ─── Executable fail-closed ACL ───
-- Login identities are deployment-managed members of exactly one workload capability role per pool.
-- These roles prove service workload identity; p_actor_* values remain server-verified claims, not
-- independent DB auth. app_content_admin credentials must never be loaded by agent/search workers.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM cs_ai_definer, app_runtime, app_content_admin, app_import_worker, app_work_order_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM cs_ai_definer, app_runtime, app_content_admin, app_import_worker, app_work_order_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM cs_ai_definer, app_runtime, app_content_admin, app_import_worker, app_work_order_worker;

-- PostgreSQL requires the target owner to have CREATE on the containing schema while ownership is
-- transferred. This grant exists only inside this transaction and is revoked immediately after the
-- functions/views have moved; the committed owner role cannot create arbitrary public objects.
GRANT CREATE ON SCHEMA public TO cs_ai_definer;

ALTER FUNCTION public.set_policy_flag(TEXT,BOOLEAN,TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.suspend_authoritative_source(TEXT,TEXT,TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.record_source_denial_audit(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.record_runtime_source_denial_audit(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.record_admin_source_denial_audit(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.retire_semantic_source_asset(TEXT,TEXT,TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.publish_content_release(TEXT,TEXT,TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.rollback_content_release(TEXT,TEXT,TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.enqueue_content_import(TEXT,TEXT,TEXT,TEXT,BIGINT,JSONB,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.enqueue_work_order_import(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.cancel_content_import(TEXT,TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.issue_snapshot_offline_lease(TEXT,TEXT,INTEGER) OWNER TO cs_ai_definer;
ALTER FUNCTION public.validate_snapshot_offline_lease(TEXT,TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.read_current_announcement_with_lease(TEXT,TEXT,INTEGER) OWNER TO cs_ai_definer;
ALTER FUNCTION public.read_snapshot_page(TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER) OWNER TO cs_ai_definer;
ALTER FUNCTION public.read_content_import_status(TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.read_content_import_preview(TEXT,TEXT,TEXT,TEXT,INTEGER) OWNER TO cs_ai_definer;
ALTER FUNCTION public.ack_client_release(TEXT,TEXT,TEXT,BIGINT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.import_issue_codes_are_public(JSONB) OWNER TO cs_ai_definer;
ALTER FUNCTION public.content_quality_issue_codes_are_public(JSONB) OWNER TO cs_ai_definer;
ALTER FUNCTION public.work_order_issue_codes_are_public(JSONB) OWNER TO cs_ai_definer;
ALTER FUNCTION public.content_text_array_is_nonblank_unique(TEXT[]) OWNER TO cs_ai_definer;
ALTER FUNCTION public.content_template_placeholders_are_valid(TEXT,TEXT[]) OWNER TO cs_ai_definer;
ALTER FUNCTION public.content_scope_matches(TEXT[],TEXT,TEXT[],TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.content_questions_are_valid(JSONB) OWNER TO cs_ai_definer;
ALTER FUNCTION public.jsonb_jcs(JSONB) OWNER TO cs_ai_definer;
ALTER FUNCTION public.content_utc_timestamp_text(TIMESTAMPTZ) OWNER TO cs_ai_definer;
ALTER FUNCTION public.content_question_hash(JSONB) OWNER TO cs_ai_definer;
ALTER FUNCTION public.content_questions_align_intent(JSONB,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.content_risk_categories_are_valid(TEXT,TEXT[]) OWNER TO cs_ai_definer;
ALTER FUNCTION public.content_quality_population_manifest_hash(JSONB) OWNER TO cs_ai_definer;
ALTER FUNCTION public.content_quality_staging_population_manifest_hash(TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.content_questions_source_assets_are_active(JSONB) OWNER TO cs_ai_definer;
ALTER FUNCTION public.content_public_questions(JSONB) OWNER TO cs_ai_definer;
ALTER FUNCTION public.content_governance_snapshot(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT[],TEXT,TEXT[],TIMESTAMPTZ,TIMESTAMPTZ,
  TEXT,TEXT,TEXT,TEXT[],BOOLEAN,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT[],JSONB
) OWNER TO cs_ai_definer;
ALTER FUNCTION public.content_governance_hash(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT[],TEXT,TEXT[],TIMESTAMPTZ,TIMESTAMPTZ,
  TEXT,TEXT,TEXT,TEXT[],BOOLEAN,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT[],JSONB
) OWNER TO cs_ai_definer;
ALTER FUNCTION public.outbox_claim(TEXT,TEXT,INT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.outbox_heartbeat(TEXT,TEXT,BIGINT,INT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.outbox_retry(TEXT,TEXT,BIGINT,INT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.reconcile_exhausted_content_imports(INT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.claim_content_import_validation(TEXT,INT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.heartbeat_content_import_validation(TEXT,TEXT,BIGINT,INT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.retry_content_import_validation(TEXT,TEXT,BIGINT,INT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.record_content_review_decision(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT
) OWNER TO cs_ai_definer;
ALTER FUNCTION public.freeze_content_quality_review_plan(
  TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TIMESTAMPTZ,INTEGER,INTEGER,INTEGER,TEXT,TEXT,TEXT,JSONB
) OWNER TO cs_ai_definer;
ALTER FUNCTION public.record_content_quality_review_evidence(
  TEXT,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,TEXT,TEXT,TEXT
) OWNER TO cs_ai_definer;
ALTER FUNCTION public.finalize_content_import_validation(TEXT,TEXT,BIGINT,TEXT,TEXT,JSONB,JSONB) OWNER TO cs_ai_definer;
ALTER FUNCTION public.reconcile_exhausted_work_order_imports(INT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.claim_work_order_import_validation(TEXT,INT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.heartbeat_work_order_import_validation(TEXT,TEXT,BIGINT,INT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.retry_work_order_import_validation(TEXT,TEXT,BIGINT,INT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.finalize_work_order_import_validation(TEXT,TEXT,BIGINT,TEXT,TEXT,JSONB,INTEGER,JSONB) OWNER TO cs_ai_definer;
ALTER FUNCTION public.outbox_complete(TEXT,TEXT,BIGINT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.rate_limit_take(TEXT,DOUBLE PRECISION,DOUBLE PRECISION,DOUBLE PRECISION) OWNER TO cs_ai_definer;
ALTER FUNCTION public.idempotency_lookup(TEXT,TEXT,TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.idempotency_request_hash_version(TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.idempotency_claim(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.idempotency_complete(TEXT,TEXT,TEXT,BIGINT,INT,JSONB,BOOLEAN) OWNER TO cs_ai_definer;
ALTER FUNCTION public.idempotency_heartbeat(TEXT,TEXT,TEXT,BIGINT,INT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.trg_iteration_task_guard() OWNER TO cs_ai_definer;
ALTER FUNCTION public.trg_iteration_task_audit() OWNER TO cs_ai_definer;
ALTER FUNCTION public.trg_query_lineage_guard() OWNER TO cs_ai_definer;
ALTER FUNCTION public.trg_semantic_source_asset_guard() OWNER TO cs_ai_definer;
ALTER FUNCTION public.start_iteration_task(TEXT,INTEGER,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.close_iteration_task(TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.record_work_order_export(TEXT,TEXT,TEXT,TEXT,TEXT[],INTEGER,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.search_recommendable_scripts(TEXT,TEXT,TEXT) OWNER TO cs_ai_definer;
ALTER FUNCTION public.trg_source_gate_search_telemetry_guard() OWNER TO cs_ai_definer;
ALTER VIEW public.v_release_source_gate OWNER TO cs_ai_definer;
ALTER VIEW public.v_scripts_recommendable OWNER TO cs_ai_definer;
REVOKE CREATE ON SCHEMA public FROM cs_ai_definer;

GRANT USAGE ON SCHEMA public TO cs_ai_definer, app_runtime, app_content_admin, app_import_worker, app_work_order_worker;
-- Union of the read/write sets used by the SECURITY DEFINER entry points above. Immutable history is
-- INSERT-only; only mutable state machines receive UPDATE, and no telemetry base-table write is added.
GRANT SELECT ON
  query_events, adoption_events,
  policy_flags, import_batches, staging_scripts, outbox_jobs, scripts, script_questions,
  semantic_source_assets,
  content_releases, release_items, content_current, announcements, client_sync_state,
  rate_limit_buckets, idempotency_keys, iteration_tasks,
  work_order_import_batches, work_order_records,
  authoritative_source_versions, authoritative_source_suspensions,
  intent_taxonomy_versions, intent_taxonomy_entries, intent_taxonomy_mappings,
  import_batch_source_bindings, release_source_bindings,
  snapshot_offline_leases, source_denial_audits,
  content_quality_review_plans, content_quality_review_evidence, content_review_decisions,
  v_release_source_gate, v_scripts_recommendable
TO cs_ai_definer;
GRANT INSERT ON
  policy_flags, change_audits, import_batches, staging_scripts, outbox_jobs, scripts,
  script_questions, semantic_source_assets, content_releases, release_items, content_current, announcements,
  client_sync_state, rate_limit_buckets, idempotency_keys, iteration_task_status_audits,
  work_order_import_batches, work_order_records, work_order_export_audits,
  authoritative_source_suspensions, import_batch_source_bindings, release_source_bindings,
  snapshot_offline_leases, source_denial_audits,
  content_quality_review_plans, content_quality_review_evidence, content_review_decisions
TO cs_ai_definer;
GRANT UPDATE ON
  policy_flags, import_batches, outbox_jobs, scripts, content_releases, content_current,
  client_sync_state, rate_limit_buckets, idempotency_keys, iteration_tasks,
  work_order_import_batches
TO cs_ai_definer;
GRANT UPDATE (
  source_query_id, lifecycle, retirement_evd, retired_by_subject_hash,
  retired_by_subject_key_version, retired_at
) ON semantic_source_assets TO cs_ai_definer;
GRANT DELETE ON staging_scripts, work_order_records TO cs_ai_definer;
GRANT USAGE, SELECT ON SEQUENCE content_release_seq TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.digest(BYTEA,TEXT) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.gen_random_bytes(INTEGER) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.import_issue_codes_are_public(JSONB) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.content_quality_issue_codes_are_public(JSONB) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.work_order_issue_codes_are_public(JSONB) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.content_text_array_is_nonblank_unique(TEXT[]) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.content_template_placeholders_are_valid(TEXT,TEXT[]) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.content_scope_matches(TEXT[],TEXT,TEXT[],TEXT,TEXT,TEXT) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.content_questions_are_valid(JSONB) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.jsonb_jcs(JSONB) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.content_utc_timestamp_text(TIMESTAMPTZ) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.content_question_hash(JSONB) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.content_questions_align_intent(JSONB,TEXT,TEXT) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.content_risk_categories_are_valid(TEXT,TEXT[]) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.content_quality_population_manifest_hash(JSONB) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.content_quality_staging_population_manifest_hash(TEXT) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.content_questions_source_assets_are_active(JSONB) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.content_public_questions(JSONB) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.content_governance_snapshot(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT[],TEXT,TEXT[],TIMESTAMPTZ,TIMESTAMPTZ,
  TEXT,TEXT,TEXT,TEXT[],BOOLEAN,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT[],JSONB
) TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION public.content_governance_hash(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT[],TEXT,TEXT[],TIMESTAMPTZ,TIMESTAMPTZ,
  TEXT,TEXT,TEXT,TEXT[],BOOLEAN,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT[],JSONB
) TO cs_ai_definer;

-- Read paths and ordinary event writes. Sensitive/admin/worker state is writeable only via DEFINER APIs.
GRANT SELECT ON
  app_users, query_events, candidate_impressions, adoption_events,
  escalate_actions, privacy_notices, notice_decisions,
  iteration_tasks, iteration_task_status_audits,
  work_order_import_batches, work_order_records, work_order_export_audits,
  client_sync_state, policy_flags
TO app_runtime;
GRANT SELECT (tenant_id, source_version_id, source_ref, domain, snapshot_sha256, use_class)
  ON authoritative_source_versions TO app_runtime;
GRANT SELECT (source_version_id, reason_code, suspended_at)
  ON authoritative_source_suspensions TO app_runtime;
GRANT INSERT ON query_events, candidate_impressions, adoption_events, escalate_actions,
  notice_decisions TO app_runtime;
GRANT INSERT ON iteration_tasks TO app_runtime;

GRANT SELECT ON import_batches, staging_scripts TO app_import_worker;
GRANT SELECT ON work_order_import_batches TO app_work_order_worker;

REVOKE INSERT, UPDATE, DELETE ON
  scripts, script_questions, semantic_source_assets,
  content_releases, release_items, content_current, announcements,
  policy_flags, change_audits, idempotency_keys, rate_limit_buckets, outbox_jobs,
  import_batches, staging_scripts, client_sync_state, iteration_task_status_audits,
  work_order_import_batches, work_order_records, work_order_export_audits,
  authoritative_source_versions, authoritative_source_suspensions,
  intent_taxonomy_versions, intent_taxonomy_entries, intent_taxonomy_mappings,
  import_batch_source_bindings, release_source_bindings,
  snapshot_offline_leases, source_denial_audits
FROM app_runtime, app_content_admin, app_import_worker, app_work_order_worker;
REVOKE UPDATE, DELETE ON iteration_tasks FROM app_runtime, app_content_admin, app_import_worker, app_work_order_worker;
REVOKE USAGE, UPDATE ON SEQUENCE content_release_seq FROM app_runtime, app_content_admin, app_import_worker, app_work_order_worker;

GRANT EXECUTE ON FUNCTION public.enqueue_content_import(TEXT,TEXT,TEXT,TEXT,BIGINT,JSONB,TEXT,TEXT) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.enqueue_work_order_import(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.cancel_content_import(TEXT,TEXT,TEXT,TEXT) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.start_iteration_task(TEXT,INTEGER,TEXT,TEXT) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.close_iteration_task(TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.record_work_order_export(TEXT,TEXT,TEXT,TEXT,TEXT[],INTEGER,TEXT,TEXT) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.record_runtime_source_denial_audit(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.issue_snapshot_offline_lease(TEXT,TEXT,INTEGER) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.validate_snapshot_offline_lease(TEXT,TEXT,TEXT,TEXT) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.read_current_announcement_with_lease(TEXT,TEXT,INTEGER) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.read_snapshot_page(TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.read_content_import_status(TEXT,TEXT,TEXT) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.read_content_import_preview(TEXT,TEXT,TEXT,TEXT,INTEGER) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.search_recommendable_scripts(TEXT,TEXT,TEXT) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.ack_client_release(TEXT,TEXT,TEXT,BIGINT,TEXT) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.rate_limit_take(TEXT,DOUBLE PRECISION,DOUBLE PRECISION,DOUBLE PRECISION) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.idempotency_lookup(TEXT,TEXT,TEXT,TEXT,TEXT) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.idempotency_request_hash_version(TEXT,TEXT,TEXT) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.idempotency_claim(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INT) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.idempotency_complete(TEXT,TEXT,TEXT,BIGINT,INT,JSONB,BOOLEAN) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.idempotency_heartbeat(TEXT,TEXT,TEXT,BIGINT,INT) TO app_runtime;

-- A separately provisioned admin pool is selected only after server-verified coach/owner authorization.
GRANT EXECUTE ON FUNCTION public.set_policy_flag(TEXT,BOOLEAN,TEXT,TEXT,TEXT) TO app_content_admin;
GRANT EXECUTE ON FUNCTION public.suspend_authoritative_source(TEXT,TEXT,TEXT,TEXT,TEXT) TO app_content_admin;
GRANT EXECUTE ON FUNCTION public.record_admin_source_denial_audit(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO app_content_admin;
GRANT EXECUTE ON FUNCTION public.retire_semantic_source_asset(TEXT,TEXT,TEXT,TEXT,TEXT) TO app_content_admin;
GRANT EXECUTE ON FUNCTION public.publish_content_release(TEXT,TEXT,TEXT,TEXT,TEXT) TO app_content_admin;
GRANT EXECUTE ON FUNCTION public.rollback_content_release(TEXT,TEXT,TEXT,TEXT,TEXT) TO app_content_admin;
GRANT EXECUTE ON FUNCTION public.record_content_review_decision(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT
) TO app_content_admin;
GRANT EXECUTE ON FUNCTION public.record_content_quality_review_evidence(
  TEXT,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,TEXT,TEXT,TEXT
) TO app_content_admin;
GRANT EXECUTE ON FUNCTION public.rate_limit_take(TEXT,DOUBLE PRECISION,DOUBLE PRECISION,DOUBLE PRECISION) TO app_content_admin;
GRANT EXECUTE ON FUNCTION public.idempotency_lookup(TEXT,TEXT,TEXT,TEXT,TEXT) TO app_content_admin;
GRANT EXECUTE ON FUNCTION public.idempotency_request_hash_version(TEXT,TEXT,TEXT) TO app_content_admin;
GRANT EXECUTE ON FUNCTION public.idempotency_claim(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INT) TO app_content_admin;
GRANT EXECUTE ON FUNCTION public.idempotency_complete(TEXT,TEXT,TEXT,BIGINT,INT,JSONB,BOOLEAN) TO app_content_admin;
GRANT EXECUTE ON FUNCTION public.idempotency_heartbeat(TEXT,TEXT,TEXT,BIGINT,INT) TO app_content_admin;

GRANT EXECUTE ON FUNCTION public.claim_content_import_validation(TEXT,INT) TO app_import_worker;
GRANT EXECUTE ON FUNCTION public.heartbeat_content_import_validation(TEXT,TEXT,BIGINT,INT) TO app_import_worker;
GRANT EXECUTE ON FUNCTION public.retry_content_import_validation(TEXT,TEXT,BIGINT,INT,TEXT) TO app_import_worker;
GRANT EXECUTE ON FUNCTION public.freeze_content_quality_review_plan(
  TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TIMESTAMPTZ,INTEGER,INTEGER,INTEGER,TEXT,TEXT,TEXT,JSONB
) TO app_import_worker;
GRANT EXECUTE ON FUNCTION public.finalize_content_import_validation(TEXT,TEXT,BIGINT,TEXT,TEXT,JSONB,JSONB) TO app_import_worker;

GRANT EXECUTE ON FUNCTION public.claim_work_order_import_validation(TEXT,INT) TO app_work_order_worker;
GRANT EXECUTE ON FUNCTION public.heartbeat_work_order_import_validation(TEXT,TEXT,BIGINT,INT) TO app_work_order_worker;
GRANT EXECUTE ON FUNCTION public.retry_work_order_import_validation(TEXT,TEXT,BIGINT,INT,TEXT) TO app_work_order_worker;
GRANT EXECUTE ON FUNCTION public.finalize_work_order_import_validation(TEXT,TEXT,BIGINT,TEXT,TEXT,JSONB,INTEGER,JSONB) TO app_work_order_worker;

COMMENT ON SCHEMA public IS
  'CS-AI-C11 schema.v1.13; CR-004 immutable four-domain authoritative-source gate; DEC-042 search-runtime projection closure for scoped reads, public questions, precomputed ranking evidence, question identity/tombstone, dual review and population-bound quality evidence; reference DDL local-preflight status is recorded only by external EVD (not this DDL); immutable migration/N/N-1/application runtime/managed PostgreSQL/backup-restore/concurrency/production remain NOT_CERTIFIED; Phase1 rewrite/auto_send/training hard-off';

COMMIT;
