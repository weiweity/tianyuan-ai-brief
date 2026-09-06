-- A2b-4 ADDITIVE CANDIDATE: after owner-acceptance.storage.v1.
-- Full function definition preserves the frozen v1.14 source and avoids runtime
-- pg_proc text patching. Existing signature, owner and ACL remain unchanged.
BEGIN;
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
  -- Plans are append-only and cannot be updated/deleted. A row lock would require
  -- UPDATE privilege which this definer deliberately lacks on immutable evidence.
  SELECT plan.* INTO v_plan
  FROM public.content_quality_review_plans plan
  WHERE plan.plan_id = p_plan_id;
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
  v_tenant TEXT;
  v_owner_group RECORD;
  v_source_ids TEXT[];
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

  -- References may select an already registered approval; review metadata remains
  -- forbidden worker input and is derived exclusively from that immutable record.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_staging_rows) item
    WHERE (item ? 'owner_acceptance_record_sha256' OR item ? 'script_version') AND (
      coalesce(item ->> 'operation','upsert') <> 'upsert'
      OR jsonb_typeof(item -> 'owner_acceptance_record_sha256') IS DISTINCT FROM 'string'
      OR (item ->> 'owner_acceptance_record_sha256') !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(item -> 'script_version') IS DISTINCT FROM 'number'
      OR (item ->> 'script_version') !~ '^[1-9][0-9]{0,9}$'
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_IMPORT_INVALID';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_staging_rows) item
    WHERE item ? 'script_version' AND (item ->> 'script_version')::bigint > 2147483647) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA001', MESSAGE = 'OWNER_ACCEPTANCE_IMPORT_INVALID';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_staging_rows) item
    WHERE item ? 'owner_acceptance_record_sha256') THEN
    -- Match publish's source -> batch order before storage triggers acquire record
    -- fences. No source/record fence is acquired after waiting for a publish lock.
    PERFORM pg_advisory_xact_lock_shared(hashtext('cs_ai_content_publish'));
  END IF;

  -- Lock order is source (owner mode only) -> batch -> outbox.
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

  SELECT tenant_id INTO v_tenant FROM public.import_batches WHERE import_batch_id = p_import_batch_id;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_staging_rows) r(
      script_id TEXT,script_version INTEGER,owner_acceptance_record_sha256 TEXT)
    LEFT JOIN public.scripts existing ON existing.script_id = r.script_id
    WHERE r.owner_acceptance_record_sha256 IS NOT NULL
      AND (r.script_version::bigint IS DISTINCT FROM coalesce(existing.version::bigint + 1,1)
        OR (existing.script_id IS NOT NULL AND existing.tenant_id IS DISTINCT FROM v_tenant))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'ZA004', MESSAGE = 'OWNER_ACCEPTANCE_IMPORT_VERSION_MISMATCH';
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
        quality_status, quality_issue_codes, quality_gate_passed,
        owner_acceptance_record_sha256, script_version
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
          WHEN acceptance.record_sha256 IS NOT NULL THEN 'owner_acceptance'
          WHEN r.risk_level = 'high' OR r.has_conflict THEN 'dual'
          ELSE 'single'
        END,
        CASE WHEN acceptance.record_sha256 IS NOT NULL THEN acceptance.owner_subject_hash ELSE lead.reviewer_subject_hash END,
        CASE WHEN acceptance.record_sha256 IS NOT NULL THEN 'ROLE-CONTENT-LEAD' ELSE lead.reviewer_role END,
        CASE WHEN acceptance.record_sha256 IS NOT NULL THEN acceptance.record ->> 'approval_evidence_id' ELSE lead.evidence_ref END,
        CASE WHEN acceptance.record_sha256 IS NULL AND (r.risk_level = 'high' OR r.has_conflict) THEN manager.reviewer_subject_hash ELSE NULL END,
        CASE WHEN acceptance.record_sha256 IS NULL AND (r.risk_level = 'high' OR r.has_conflict) THEN manager.reviewer_role ELSE NULL END,
        CASE WHEN acceptance.record_sha256 IS NULL AND (r.risk_level = 'high' OR r.has_conflict) THEN manager.evidence_ref ELSE NULL END,
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
        END,
        r.owner_acceptance_record_sha256,
        r.script_version
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
        quality_issue_codes JSONB,
        owner_acceptance_record_sha256 TEXT,
        script_version INTEGER
      )
      JOIN public.import_batch_source_bindings ib
        ON ib.import_batch_id = p_import_batch_id
       AND ib.domain = r.category
       AND ib.source_version_id = r.source_version_id
      JOIN public.authoritative_source_versions asv
        ON asv.source_version_id = ib.source_version_id
       AND asv.domain = ib.domain
      LEFT JOIN public.owner_acceptance_records acceptance
        ON acceptance.tenant_id = v_tenant
       AND acceptance.record_sha256 = r.owner_acceptance_record_sha256
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
         OR acceptance.record_sha256 IS NOT NULL
         OR (
           r.owner_acceptance_record_sha256 IS NULL
           AND lead.decision_id IS NOT NULL
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
        AND s.review_mode <> 'owner_acceptance'
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
    -- Row triggers prove member integrity; this independently observes the complete
    -- persisted group and batch-selected source set so omissions cannot pass.
    SELECT array_agg(source_version_id ORDER BY domain COLLATE "C") INTO v_source_ids
      FROM public.import_batch_source_bindings WHERE import_batch_id = p_import_batch_id;
    FOR v_owner_group IN
      SELECT s.owner_acceptance_record_sha256 AS anchor,s.primary_reviewer_id AS owner_hash,
        jsonb_agg(jsonb_build_object('script_version',s.script_version,'content_hash',s.content_hash,
          'snapshot',public.content_governance_snapshot(
            s.script_id,s.category,s.title,s.answer_text,s.source_ref,s.source_version_id,
            s.owner_role,s.review_due_at,s.platform_scope,s.product_scope_type,s.product_scope_refs,
            s.effective_from,s.effective_to,s.intent_taxonomy_version,s.intent_id,
            s.risk_level,s.risk_categories,s.has_conflict,s.review_mode,
            s.primary_reviewer_id,s.primary_reviewer_role,s.primary_review_evd,
            s.secondary_reviewer_id,s.secondary_reviewer_role,s.secondary_review_evd,
            s.placeholder_keys,s.questions_json)) ORDER BY s.script_id COLLATE "C") AS content
      FROM public.staging_scripts s
      WHERE s.import_batch_id = p_import_batch_id AND s.review_mode = 'owner_acceptance'
      GROUP BY s.owner_acceptance_record_sha256,s.primary_reviewer_id
      ORDER BY s.owner_acceptance_record_sha256 COLLATE "C"
    LOOP
      PERFORM public.assert_owner_acceptance_content(v_tenant,v_owner_group.anchor,
        v_owner_group.owner_hash,v_source_ids,v_owner_group.content);
    END LOOP;
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

COMMIT;
