-- Candidate additive transaction contract after storage.delta.sql and schema.v1.15.
-- Synthetic design validation only; not a published migration.
BEGIN;
ALTER TABLE backend_review.waits ADD COLUMN rows JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE backend_review.waits ADD CHECK (jsonb_typeof(rows)='array');
CREATE TABLE backend_review.receipts (
 actor_user_id TEXT NOT NULL, operation TEXT NOT NULL, request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 request_hash TEXT NOT NULL, response JSONB NOT NULL, PRIMARY KEY(actor_user_id,operation,request_key)
);
CREATE FUNCTION backend_review.lock_content() RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS $$
BEGIN
 IF current_setting('transaction_isolation') <> 'read committed' THEN
  RAISE EXCEPTION USING ERRCODE='ZA003', MESSAGE='READ_COMMITTED_REQUIRED';
 END IF;
 PERFORM pg_advisory_xact_lock(724019,1);
END $$;
-- Patch fixed canonical entry points, preserving their current body, signature and ACL.
-- Re-entrant calls take the same xact lock; no session locks or changed business gates.
DO $guard$
DECLARE f RECORD; definition TEXT; patched INTEGER:=0;
BEGIN
 FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname=ANY(ARRAY[
 'enqueue_content_import','claim_content_import_validation','heartbeat_content_import_validation',
 'retry_content_import_validation','reconcile_exhausted_content_imports','cancel_content_import',
 'freeze_content_quality_review_plan','record_content_review_decision','record_content_quality_review_evidence',
 'finalize_content_import_validation','publish_content_release','rollback_content_release']) LOOP
  definition:=pg_get_functiondef(f.oid);
  IF position('BEGIN' IN definition)=0 THEN RAISE EXCEPTION 'Unsupported canonical function'; END IF;
  IF position('PERFORM backend_review.lock_content();' IN definition)=0 THEN
   definition:=regexp_replace(definition,'BEGIN','BEGIN' || chr(10) || '  PERFORM backend_review.lock_content();');
  END IF;
  EXECUTE definition; patched:=patched+1;
 END LOOP;
 IF patched<>12 THEN RAISE EXCEPTION 'Canonical content entry point set changed'; END IF;
END $guard$;
CREATE FUNCTION backend_identity.actor(p_token TEXT) RETURNS TABLE(user_id TEXT,role TEXT,subject_hash TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS $$
BEGIN
 IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN RAISE EXCEPTION USING ERRCODE='ZA005',MESSAGE='SESSION_INVALID'; END IF;
 RETURN QUERY SELECT b.user_id,b.role,b.subject_hash FROM backend_identity.sessions s
 JOIN backend_identity.subject_bindings b ON b.binding_id=s.binding_id
 WHERE s.token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') AND s.revoked_at IS NULL
 AND s.expires_at>clock_timestamp() AND b.enabled AND b.subject_hash IS NOT NULL FOR SHARE OF b,s;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ZA005',MESSAGE='SESSION_INVALID'; END IF;
END $$;
CREATE FUNCTION backend_identity.create_login(p_id TEXT,p_state_hash TEXT,p_challenge TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS $$
DECLARE t TIMESTAMPTZ:=clock_timestamp();
BEGIN
 PERFORM pg_advisory_xact_lock(724019,2);
 INSERT INTO backend_identity.login_requests(login_id,state_hash,client_challenge,status,issued_at,expires_at)
 VALUES(p_id,p_state_hash,p_challenge,'pending',t,t+interval '5 minutes');
END $$;
CREATE FUNCTION backend_identity.begin_callback(p_state TEXT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS $$
DECLARE id TEXT;
BEGIN
 PERFORM pg_advisory_xact_lock(724019,2);
 UPDATE backend_identity.login_requests SET status='exchanging',exchange_started_at=clock_timestamp()
 WHERE state_hash=encode(sha256(convert_to(p_state,'UTF8')),'hex') AND status='pending' AND expires_at>clock_timestamp()
 RETURNING login_id INTO id;
 IF id IS NULL THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='LOGIN_INVALID'; END IF;
 RETURN id;
END $$;
CREATE FUNCTION backend_identity.complete_callback(p_id TEXT,p_binding TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(724019,2);
 IF p_binding IS NOT NULL THEN
  PERFORM 1 FROM backend_identity.subject_bindings WHERE binding_id=p_binding AND enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ZA005',MESSAGE='CAPABILITY_DENIED'; END IF;
 END IF;
 UPDATE backend_identity.login_requests SET status=CASE WHEN p_binding IS NULL THEN 'failed' ELSE 'ready' END,binding_id=p_binding
 WHERE login_id=p_id AND status='exchanging' AND expires_at>clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='LOGIN_INVALID'; END IF;
END $$;
CREATE FUNCTION backend_identity.exchange(p_id TEXT,p_verifier TEXT,p_new_token TEXT) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS $$
DECLARE q backend_identity.login_requests%ROWTYPE; t TIMESTAMPTZ:=clock_timestamp();
BEGIN
 PERFORM pg_advisory_xact_lock(724019,2);
 IF p_verifier IS NULL OR p_verifier !~ '^[A-Za-z0-9._~-]{43,128}$'
 OR p_new_token IS NULL OR p_new_token !~ '^[A-Za-z0-9_-]{43}$' THEN RAISE EXCEPTION USING ERRCODE='ZA001',MESSAGE='LOGIN_INVALID'; END IF;
 SELECT * INTO q FROM backend_identity.login_requests WHERE login_id=p_id FOR UPDATE;
 IF NOT FOUND OR q.client_challenge IS DISTINCT FROM rtrim(translate(encode(sha256(convert_to(p_verifier,'UTF8')),'base64'),'+/','-_'),'=')
 THEN RAISE EXCEPTION USING ERRCODE='ZA001',MESSAGE='LOGIN_INVALID'; END IF;
 IF q.expires_at<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='LOGIN_EXPIRED'; END IF;
 IF q.status IN ('pending','exchanging') THEN RETURN NULL; END IF;
 IF q.status='consumed' THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='LOGIN_CONSUMED'; END IF;
 IF q.status<>'ready' THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='LOGIN_INVALID'; END IF;
 PERFORM 1 FROM backend_identity.subject_bindings WHERE binding_id=q.binding_id AND enabled FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ZA005',MESSAGE='CAPABILITY_DENIED'; END IF;
 t:=clock_timestamp();
 INSERT INTO backend_identity.sessions(token_hash,login_id,binding_id,issued_at,expires_at)
 VALUES(encode(sha256(convert_to(p_new_token,'UTF8')),'hex'),p_id,q.binding_id,t,t+interval '15 minutes');
 UPDATE backend_identity.login_requests SET status='consumed',consumed_at=t WHERE login_id=p_id;
 RETURN t+interval '15 minutes';
END $$;
CREATE FUNCTION backend_identity.logout(p_token TEXT) RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS $$
 UPDATE backend_identity.sessions SET revoked_at=coalesce(revoked_at,clock_timestamp())
 WHERE token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
$$;
CREATE FUNCTION backend_review.require_capability(p_user TEXT,p_cap TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS $$
BEGIN
 PERFORM 1 FROM backend_identity.capability_bindings WHERE user_id=p_user AND capability=p_cap AND enabled FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ZA005',MESSAGE='CAPABILITY_DENIED'; END IF;
END $$;
CREATE FUNCTION backend_review.assert_wait(p_batch TEXT,p_revision TEXT) RETURNS backend_review.waits
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS $$
DECLARE w backend_review.waits%ROWTYPE;
BEGIN
 PERFORM 1 FROM public.import_batches WHERE import_batch_id=p_batch AND status='validating' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='REVIEW_STALE'; END IF;
 SELECT * INTO w FROM backend_review.waits WHERE import_batch_id=p_batch AND review_revision=p_revision AND status='waiting' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='REVIEW_STALE'; END IF;
 RETURN w;
END $$;
CREATE FUNCTION backend_review.park(p_job TEXT,p_owner TEXT,p_lease BIGINT,p_batch TEXT,p_plan TEXT,p_key TEXT,p_digest TEXT,p_bytes BIGINT,p_rows JSONB) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS $$
DECLARE population TEXT; revision TEXT;
BEGIN
 PERFORM backend_review.lock_content();
 PERFORM 1 FROM public.import_batches WHERE import_batch_id=p_batch AND status='validating' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='REVIEW_STALE'; END IF;
 PERFORM 1 FROM backend_review.waits WHERE import_batch_id=p_batch;
 IF FOUND THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='REVIEW_STALE'; END IF;
 PERFORM 1 FROM public.outbox_jobs job WHERE job.job_id=p_job AND job.job_type='import_validate' AND job.status='running'
 AND job.payload->>'import_batch_id'=p_batch AND job.lease_owner=p_owner AND job.lease_version=p_lease AND job.lease_expires_at>clock_timestamp() FOR UPDATE OF job;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ZA006',MESSAGE='OUTBOX_LEASE_LOST'; END IF;
 IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION USING ERRCODE='ZA001',MESSAGE='VALIDATION'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(p_rows))<>(SELECT count(DISTINCT x->>'script_id') FROM jsonb_array_elements(p_rows) x) THEN RAISE EXCEPTION USING ERRCODE='ZA001',MESSAGE='DUPLICATE_SCRIPT'; END IF;
 population:=public.content_quality_population_manifest_hash(p_rows);
 PERFORM 1 FROM public.content_quality_review_plans WHERE plan_id=p_plan AND import_batch_id=p_batch AND population_manifest_hash=population
 AND selection_manifest_hash=encode(sha256(convert_to(jsonb_build_array(backend_review.sample_ids(p_rows,selection_seed_hash,initial_sample_target),backend_review.sample_ids(p_rows,selection_seed_hash,expanded_sample_target))::text,'UTF8')),'hex') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='QUALITY_POPULATION_MISMATCH'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) x WHERE x ?| ARRAY['review_mode','primary_reviewer_id','primary_reviewer_role','primary_review_evd','secondary_reviewer_id','secondary_reviewer_role','secondary_review_evd','quality_gate_passed'])
 THEN RAISE EXCEPTION USING ERRCODE='ZA005',MESSAGE='REVIEW_EVIDENCE_TRUST_BOUNDARY'; END IF;
 revision:=encode(sha256(convert_to(p_rows::text,'UTF8')),'hex');
 INSERT INTO backend_review.waits(import_batch_id,review_revision,plan_id,population_manifest_hash,object_key,object_sha256,object_bytes,parked_job_id,status,created_at,rows)
 VALUES(p_batch,revision,p_plan,population,p_key,p_digest,p_bytes,p_job,'waiting',clock_timestamp(),p_rows);
 UPDATE public.outbox_jobs SET status='done',lease_owner=NULL,lease_expires_at=NULL,lease_version=lease_version+1,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE job_id=p_job;
 RETURN revision;
END $$;
CREATE FUNCTION backend_review.decision(p_token TEXT,p_batch TEXT,p_revision TEXT,p_key TEXT,p_script TEXT,p_hash TEXT,p_decision TEXT,p_evidence TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS $$
DECLARE a RECORD; w backend_review.waits%ROWTYPE; cap TEXT; role_name TEXT; digest TEXT; receipt backend_review.receipts%ROWTYPE; response JSONB; decision_id TEXT;
BEGIN
 PERFORM backend_review.lock_content();
 SELECT * INTO a FROM backend_identity.actor(p_token);
 SELECT capability INTO cap FROM backend_identity.capability_bindings WHERE user_id=a.user_id AND enabled
 AND capability IN ('content_review_lead','content_review_manager') ORDER BY capability LIMIT 1 FOR SHARE;
 IF cap IS NULL OR a.subject_hash IS NULL THEN RAISE EXCEPTION USING ERRCODE='ZA005',MESSAGE='CAPABILITY_DENIED'; END IF;
 digest:=encode(sha256(convert_to(jsonb_build_array(p_batch,p_revision,p_script,p_hash,p_decision,p_evidence)::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM backend_review.receipts WHERE actor_user_id=a.user_id AND operation='decision' AND request_key=p_key;
 IF FOUND THEN
  IF receipt.request_hash<>digest THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='IDEMPOTENCY_CONFLICT'; END IF;
  RETURN receipt.response;
 END IF;
 w:=backend_review.assert_wait(p_batch,p_revision);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(w.rows) x WHERE x->>'script_id'=p_script AND x->>'content_hash'=p_hash)
 THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='REVIEW_STALE'; END IF;
 role_name:=CASE cap WHEN 'content_review_lead' THEN 'ROLE-CONTENT-LEAD' ELSE 'ROLE-CS-MANAGER' END;
 decision_id:='crd_'||replace(gen_random_uuid()::text,'-','');
 PERFORM public.record_content_review_decision(decision_id,p_script,p_hash,role_name,a.subject_hash,'registry-v1',p_evidence,p_decision,clock_timestamp(),cap);
 response:=jsonb_build_object('receipt_id',decision_id,'batch_id',p_batch,'review_revision',p_revision,'recorded_at',clock_timestamp());
 INSERT INTO backend_review.receipts VALUES(a.user_id,'decision',p_key,digest,response);
 RETURN response;
END $$;
CREATE FUNCTION backend_review.resume(p_token TEXT,p_batch TEXT,p_revision TEXT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS $$
DECLARE a RECORD; w backend_review.waits%ROWTYPE; id TEXT;
BEGIN
 PERFORM backend_review.lock_content();
 SELECT * INTO a FROM backend_identity.actor(p_token);
 PERFORM backend_review.require_capability(a.user_id,'content_quality_reviewer');
 PERFORM 1 FROM public.import_batches WHERE import_batch_id=p_batch FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='REVIEW_STALE'; END IF;
 SELECT * INTO w FROM backend_review.waits WHERE import_batch_id=p_batch AND review_revision=p_revision FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='REVIEW_STALE'; END IF;
 IF w.status='cancelled' THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='REVIEW_CANCELLED'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.import_batches WHERE import_batch_id=p_batch AND status='validating') THEN
  RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='REVIEW_STALE';
 END IF;
 IF w.status='resumed' THEN RETURN w.resumed_job_id; END IF;
 PERFORM 1 FROM public.content_quality_review_evidence WHERE plan_id=w.plan_id AND population_manifest_hash=w.population_manifest_hash AND conclusion='passed';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='QUALITY_GATE_NOT_PASSED'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(w.rows) x WHERE coalesce(x->>'operation','upsert')='upsert' AND NOT EXISTS(
 SELECT 1 FROM public.content_review_decisions lead WHERE lead.script_id=x->>'script_id' AND lead.content_hash=x->>'content_hash' AND lead.reviewer_role='ROLE-CONTENT-LEAD' AND lead.decision='approved'
 AND (x->>'risk_level' IN ('low','medium') AND x->>'has_conflict'='false' OR EXISTS(
 SELECT 1 FROM public.content_review_decisions manager WHERE manager.script_id=lead.script_id AND manager.content_hash=lead.content_hash AND manager.reviewer_role='ROLE-CS-MANAGER' AND manager.decision='approved' AND manager.reviewer_subject_hash<>lead.reviewer_subject_hash))))
 THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='REVIEW_EVIDENCE_MISSING'; END IF;
 -- The canonical finalizer remains the authoritative dual-person and source gate.
 -- Resume schedules a revalidation, never grants publishability.
 id:='job_'||replace(gen_random_uuid()::text,'-','');
 INSERT INTO public.outbox_jobs(job_id,job_type,payload,status) VALUES(id,'import_validate',jsonb_build_object('import_batch_id',p_batch,'review_revision',p_revision),'pending');
 UPDATE backend_review.waits SET status='resumed',resumed_job_id=id,resumed_at=clock_timestamp()
 WHERE import_batch_id=p_batch AND review_revision=p_revision AND status='waiting';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='REVIEW_STALE'; END IF;
 RETURN id;
END $$;
CREATE FUNCTION backend_review.cancel(p_token TEXT,p_batch TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS $$
DECLARE a RECORD;
BEGIN
 PERFORM backend_review.lock_content();
 SELECT * INTO a FROM backend_identity.actor(p_token);
 PERFORM public.cancel_content_import(p_batch,'CANCELLED',a.user_id,a.role);
 UPDATE backend_review.waits
 SET status='cancelled', cancelled_at=coalesce(cancelled_at,clock_timestamp())
 WHERE import_batch_id=p_batch AND status IS DISTINCT FROM 'cancelled';
END $$;
CREATE FUNCTION backend_review.finish(p_job TEXT,p_owner TEXT,p_lease BIGINT,p_batch TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS $$
DECLARE w backend_review.waits%ROWTYPE;
BEGIN
 PERFORM backend_review.lock_content();
 SELECT * INTO w FROM backend_review.waits WHERE import_batch_id=p_batch AND resumed_job_id=p_job AND status='resumed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='REVIEW_STALE'; END IF;
 IF encode(sha256(convert_to(w.rows::text,'UTF8')),'hex')<>w.review_revision OR public.content_quality_population_manifest_hash(w.rows)<>w.population_manifest_hash
 THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='QUALITY_POPULATION_MISMATCH'; END IF;
 PERFORM public.finalize_content_import_validation(p_job,p_owner,p_lease,p_batch,'staged',w.rows,NULL);
END $$;
CREATE FUNCTION backend_review.sample_ids(p_rows JSONB,p_seed TEXT,p_target INTEGER) RETURNS TEXT[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog, public, pg_temp AS $$
 WITH ranked AS (SELECT x,row_number() OVER(ORDER BY encode(sha256(convert_to(p_seed||':'||(x->>'script_id')||':'||(x->>'content_hash'),'UTF8')),'hex'),x->>'script_id' COLLATE "C") n
 FROM jsonb_array_elements(p_rows) x WHERE coalesce(x->>'operation','upsert')='upsert' AND x->>'risk_level' IN ('low','medium') AND x->>'has_conflict'='false'),
 expected AS (SELECT x->>'script_id' id FROM ranked WHERE n<=p_target UNION SELECT x->>'script_id' FROM jsonb_array_elements(p_rows) x WHERE coalesce(x->>'operation','upsert')='upsert' AND (x->>'risk_level'='high' OR x->>'has_conflict'='true'))
 SELECT coalesce(array_agg(id ORDER BY id COLLATE "C"),ARRAY[]::TEXT[]) FROM expected;
$$;
CREATE FUNCTION backend_review.page(p_token TEXT,p_batch TEXT,p_revision TEXT,p_after INTEGER DEFAULT 0,p_limit INTEGER DEFAULT 20) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS $$
DECLARE a RECORD; w backend_review.waits%ROWTYPE; items JSONB; total INTEGER; initial_ids TEXT[]; expanded_ids TEXT[]; plan public.content_quality_review_plans%ROWTYPE;
BEGIN
 SELECT * INTO a FROM backend_identity.actor(p_token);
 IF NOT EXISTS(SELECT 1 FROM backend_identity.capability_bindings WHERE user_id=a.user_id AND enabled AND capability IN ('content_review_lead','content_review_manager','content_quality_reviewer'))
 THEN RAISE EXCEPTION USING ERRCODE='ZA005',MESSAGE='CAPABILITY_DENIED'; END IF;
 IF p_after IS NULL OR p_after<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION USING ERRCODE='ZA001',MESSAGE='VALIDATION'; END IF;
 SELECT * INTO w FROM backend_review.waits WHERE import_batch_id=p_batch AND review_revision=p_revision AND status<>'cancelled';
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.import_batches WHERE import_batch_id=p_batch AND status IN ('validating','staged'))
 THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='REVIEW_STALE'; END IF;
 SELECT * INTO plan FROM public.content_quality_review_plans WHERE plan_id=w.plan_id;
 initial_ids:=backend_review.sample_ids(w.rows,plan.selection_seed_hash,plan.initial_sample_target);
 expanded_ids:=backend_review.sample_ids(w.rows,plan.selection_seed_hash,plan.expanded_sample_target);
 total:=jsonb_array_length(w.rows);
 IF p_after>total THEN RAISE EXCEPTION USING ERRCODE='ZA001',MESSAGE='VALIDATION'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
 'initial_sample',(x->>'script_id')=ANY(initial_ids),'expanded_sample',(x->>'script_id')=ANY(expanded_ids),'position',ordinality,'script_id',x->>'script_id','operation',coalesce(x->>'operation','upsert'),
 'content_hash',x->>'content_hash','title',x->>'title','answer_text',x->>'answer_text',
 'source_version_id',x->>'source_version_id','owner_role',x->>'owner_role','review_due_at',x->>'review_due_at','intent_id',x->>'intent_id','intent_taxonomy_version',x->>'intent_taxonomy_version','questions',(SELECT coalesce(jsonb_agg(jsonb_build_object('question_id',q->>'question_id','question_version',q->'question_version','question_text',q->>'question_text','question_hash',q->>'question_hash','semantic_family_id',q->>'semantic_family_id')),'[]'::jsonb) FROM jsonb_array_elements(coalesce(x->'questions_json','[]'::jsonb)) q),'category',x->>'category','platform_scope',x->'platform_scope','product_scope_type',x->>'product_scope_type','product_scope_refs',x->'product_scope_refs','effective_from',x->>'effective_from','effective_to',x->>'effective_to','placeholder_keys',x->'placeholder_keys','risk_categories',x->'risk_categories','risk_level',x->>'risk_level','has_conflict',x->'has_conflict','quality_status',x->>'quality_status') ORDER BY ordinality),'[]'::jsonb)
 INTO items FROM jsonb_array_elements(w.rows) WITH ORDINALITY t(x,ordinality) WHERE ordinality>p_after AND ordinality<=p_after+p_limit;
 RETURN jsonb_build_object('batch_id',p_batch,'review_revision',p_revision,'items',items,'next_after',CASE WHEN p_after+p_limit<total THEN p_after+p_limit ELSE NULL END,'total',total);
END $$;
CREATE FUNCTION backend_review.quality(p_token TEXT,p_batch TEXT,p_revision TEXT,p_key TEXT,p_phase TEXT,p_checks JSONB,p_evidence TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS $$
DECLARE a RECORD; w backend_review.waits%ROWTYPE; plan public.content_quality_review_plans%ROWTYPE;
 c JSONB; digest TEXT; prior backend_review.receipts%ROWTYPE; response JSONB;
 ni INTEGER; di INTEGER; ne INTEGER; de INTEGER; nm INTEGER; dm INTEGER; defects INTEGER;
 initial_rate NUMERIC; conclusion TEXT; target INTEGER;
BEGIN
 PERFORM backend_review.lock_content();
 SELECT * INTO a FROM backend_identity.actor(p_token);
 PERFORM backend_review.require_capability(a.user_id,'content_quality_reviewer');
 IF p_phase IS NULL OR p_phase NOT IN ('initial','expanded') OR jsonb_typeof(p_checks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_checks)>5000 OR p_evidence IS NULL OR p_evidence !~ '^EVD-[A-Z0-9-]{6,127}$'
 THEN RAISE EXCEPTION USING ERRCODE='ZA001',MESSAGE='VALIDATION'; END IF;
 digest:=encode(sha256(convert_to(jsonb_build_array(p_batch,p_revision,p_phase,p_checks,p_evidence)::text,'UTF8')),'hex');
 SELECT * INTO prior FROM backend_review.receipts WHERE actor_user_id=a.user_id AND operation='quality' AND request_key=p_key;
 IF FOUND THEN
  IF prior.request_hash<>digest THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='IDEMPOTENCY_CONFLICT'; END IF;
  RETURN prior.response;
 END IF;
 w:=backend_review.assert_wait(p_batch,p_revision);
 SELECT * INTO plan FROM public.content_quality_review_plans WHERE plan_id=w.plan_id;
 IF EXISTS(SELECT 1 FROM public.content_quality_review_evidence WHERE plan_id=w.plan_id) THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='REVIEW_STALE'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(p_checks))<>(SELECT count(DISTINCT x->>'script_id') FROM jsonb_array_elements(p_checks) x)
 THEN RAISE EXCEPTION USING ERRCODE='ZA001',MESSAGE='DUPLICATE_CHECK'; END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(p_checks) LOOP
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR c-ARRAY['script_id','content_hash','defect']<>'{}'::jsonb
  OR NOT(c ?& ARRAY['script_id','content_hash','defect']) OR jsonb_typeof(c->'defect') IS DISTINCT FROM 'boolean'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(w.rows) x WHERE x->>'script_id'=c->>'script_id' AND x->>'content_hash'=c->>'content_hash' AND coalesce(x->>'operation','upsert')='upsert')
  THEN RAISE EXCEPTION USING ERRCODE='ZA001',MESSAGE='QUALITY_EVIDENCE_INVALID'; END IF;
  -- Existing checks are immutable across phases, including initial items in expanded sampling.
  IF EXISTS(SELECT 1 FROM backend_review.quality_checks q WHERE q.plan_id=w.plan_id AND q.script_id=c->>'script_id' AND q.defect IS DISTINCT FROM (c->>'defect')::BOOLEAN)
  THEN RAISE EXCEPTION USING ERRCODE='ZA003',MESSAGE='QUALITY_EVIDENCE_INVALID'; END IF;
  INSERT INTO backend_review.quality_checks(plan_id,review_revision,phase,script_id,content_hash,defect,actor_user_id,evidence_id,recorded_at)
  VALUES(w.plan_id,w.review_revision,p_phase,c->>'script_id',c->>'content_hash',(c->>'defect')::BOOLEAN,a.user_id,p_evidence,clock_timestamp());
 END LOOP;
 -- Deterministic rank: seeded SHA256, then stable script key. Mandatory rows are never sampled.
 target:=CASE p_phase WHEN 'initial' THEN plan.initial_sample_target ELSE plan.expanded_sample_target END;
 IF EXISTS(
 SELECT 1 FROM unnest(backend_review.sample_ids(w.rows,plan.selection_seed_hash,target)) expected(id) FULL JOIN (SELECT x->>'script_id' id FROM jsonb_array_elements(p_checks) x) actual USING(id) WHERE expected.id IS NULL OR actual.id IS NULL)
 THEN RAISE EXCEPTION USING ERRCODE='ZA001',MESSAGE='QUALITY_SAMPLE_MISMATCH'; END IF;
 SELECT count(*) FILTER(WHERE q.phase='initial' AND x->>'risk_level'<>'high' AND x->>'has_conflict'='false'),
 count(*) FILTER(WHERE q.phase='initial' AND q.defect AND x->>'risk_level'<>'high' AND x->>'has_conflict'='false'),
 count(*) FILTER(WHERE q.phase='expanded' AND x->>'risk_level'<>'high' AND x->>'has_conflict'='false'),
 count(*) FILTER(WHERE q.phase='expanded' AND q.defect AND x->>'risk_level'<>'high' AND x->>'has_conflict'='false'),
 count(*) FILTER(WHERE q.phase=p_phase AND (x->>'risk_level'='high' OR x->>'has_conflict'='true')),
 count(*) FILTER(WHERE q.phase=p_phase AND q.defect AND (x->>'risk_level'='high' OR x->>'has_conflict'='true'))
 INTO ni,di,ne,de,nm,dm FROM backend_review.quality_checks q JOIN jsonb_array_elements(w.rows) x ON q.script_id=x->>'script_id' WHERE q.plan_id=w.plan_id;
 IF ni<>plan.initial_sample_target THEN RAISE EXCEPTION USING ERRCODE='ZA001',MESSAGE='QUALITY_INITIAL_REQUIRED'; END IF;
 initial_rate:=CASE WHEN ni=0 THEN 0 ELSE di::NUMERIC/ni END;
 IF p_phase='initial' AND plan.ordinary_population_count>500 AND initial_rate>0.02 AND initial_rate<=0.05 THEN
  conclusion:='expansion_required';
 ELSE
  IF p_phase='expanded' AND NOT(plan.ordinary_population_count>500 AND initial_rate>0.02 AND initial_rate<=0.05)
  THEN RAISE EXCEPTION USING ERRCODE='ZA001',MESSAGE='QUALITY_EXPANSION_DENIED'; END IF;
  defects:=CASE p_phase WHEN 'initial' THEN di ELSE de END+dm;
  conclusion:=CASE WHEN (CASE WHEN p_phase='initial' THEN initial_rate ELSE de::NUMERIC/greatest(ne,1) END)>0.05 THEN 'blocked' ELSE 'passed' END;
  -- Defective rows cannot be changed under a frozen revision: force a new import instead.
  IF defects>0 AND conclusion='passed' THEN conclusion:='revision_required'; END IF;
  -- Canonical threshold function owns the result; a stricter defect rejection stays in wait state.
  IF defects=0 OR conclusion='blocked' AND (CASE WHEN p_phase='initial' THEN initial_rate ELSE de::NUMERIC/greatest(ne,1) END)>0.05 THEN
   PERFORM public.record_content_quality_review_evidence(w.plan_id,ni,di,CASE WHEN p_phase='expanded' THEN ne END,CASE WHEN p_phase='expanded' THEN de END,nm,dm,plan.clean_population_count-defects,defects,conclusion,p_evidence,'content_quality_reviewer');
  END IF;
 END IF;
 response:=jsonb_build_object('receipt_id','quality_'||replace(gen_random_uuid()::text,'-',''),'batch_id',p_batch,'review_revision',p_revision,'recorded_at',clock_timestamp(),'quality_state',conclusion);
 INSERT INTO backend_review.receipts VALUES(a.user_id,'quality',p_key,digest,response);
 RETURN response;
END $$;
CREATE FUNCTION backend_review.list(p_token TEXT, p_cursor TEXT DEFAULT NULL, p_limit INTEGER DEFAULT 20) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS $$
DECLARE a RECORD; items JSONB; next_cursor TEXT;
BEGIN
 SELECT * INTO a FROM backend_identity.actor(p_token);
 IF NOT EXISTS(SELECT 1 FROM backend_identity.capability_bindings WHERE user_id=a.user_id AND enabled AND capability IN ('content_review_lead','content_review_manager','content_quality_reviewer'))
 THEN RAISE EXCEPTION USING ERRCODE='ZA005',MESSAGE='CAPABILITY_DENIED'; END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION USING ERRCODE='ZA001',MESSAGE='VALIDATION'; END IF;
 IF p_cursor IS NOT NULL AND (length(p_cursor) NOT BETWEEN 1 AND 512 OR NOT EXISTS (SELECT 1 FROM backend_review.waits WHERE import_batch_id=p_cursor))
 THEN RAISE EXCEPTION USING ERRCODE='ZA001',MESSAGE='VALIDATION'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('batch_id',w.import_batch_id,'review_revision',w.review_revision,'state',w.status,'candidate_count',jsonb_array_length(w.rows)) ORDER BY w.created_at,w.import_batch_id),'[]'::jsonb)
 INTO items
 FROM (
  SELECT * FROM backend_review.waits w
  WHERE p_cursor IS NULL OR (w.created_at,w.import_batch_id)>(SELECT created_at,import_batch_id FROM backend_review.waits WHERE import_batch_id=p_cursor)
  ORDER BY created_at, import_batch_id
  LIMIT p_limit
 ) w;
 SELECT w.import_batch_id INTO next_cursor FROM jsonb_array_elements(items) WITH ORDINALITY t(x,n)
 JOIN backend_review.waits w ON w.import_batch_id=x->>'batch_id'
 ORDER BY n DESC LIMIT 1;
 IF items IS NULL OR jsonb_array_length(items)<p_limit THEN next_cursor:=NULL; END IF;
 RETURN jsonb_build_object('items',coalesce(items,'[]'::jsonb),'next_cursor',next_cursor);
END $$;
CREATE FUNCTION backend_review.sync_wait_on_batch_failed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public, pg_temp AS $$
BEGIN
 IF NEW.status='failed' AND OLD.status IS DISTINCT FROM 'failed' THEN
  UPDATE backend_review.waits
  SET status='cancelled', cancelled_at=coalesce(cancelled_at,clock_timestamp())
  WHERE import_batch_id=NEW.import_batch_id AND status IS DISTINCT FROM 'cancelled';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS backend_review_sync_wait_on_batch_failed ON public.import_batches;
CREATE TRIGGER backend_review_sync_wait_on_batch_failed
 AFTER UPDATE ON public.import_batches
 FOR EACH ROW EXECUTE FUNCTION backend_review.sync_wait_on_batch_failed();
REVOKE ALL ON FUNCTION backend_review.sync_wait_on_batch_failed() FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA backend_identity,backend_review FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA backend_identity,backend_review FROM PUBLIC;
DO $roles$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_backend_auth') THEN CREATE ROLE app_backend_auth NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_backend_review') THEN CREATE ROLE app_backend_review NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_backend_worker') THEN CREATE ROLE app_backend_worker NOLOGIN; END IF;
END $roles$;
GRANT USAGE ON SCHEMA backend_identity TO app_backend_auth;
GRANT EXECUTE ON FUNCTION backend_identity.create_login(TEXT,TEXT,TEXT),backend_identity.begin_callback(TEXT),backend_identity.complete_callback(TEXT,TEXT),backend_identity.exchange(TEXT,TEXT,TEXT),backend_identity.actor(TEXT),backend_identity.logout(TEXT) TO app_backend_auth;
GRANT USAGE ON SCHEMA backend_review TO app_backend_review,app_backend_worker;
GRANT EXECUTE ON FUNCTION backend_review.page(TEXT,TEXT,TEXT,INTEGER,INTEGER),backend_review.decision(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT),backend_review.quality(TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,TEXT),backend_review.resume(TEXT,TEXT,TEXT),backend_review.cancel(TEXT,TEXT),backend_review.list(TEXT,TEXT,INTEGER) TO app_backend_review;
GRANT EXECUTE ON FUNCTION backend_review.park(TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TEXT,BIGINT,JSONB),backend_review.finish(TEXT,TEXT,BIGINT,TEXT) TO app_backend_worker;
GRANT EXECUTE ON FUNCTION public.claim_content_import_validation(TEXT,INTEGER),public.heartbeat_content_import_validation(TEXT,TEXT,BIGINT,INTEGER),public.retry_content_import_validation(TEXT,TEXT,BIGINT,INTEGER,TEXT),public.freeze_content_quality_review_plan(TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TIMESTAMPTZ,INTEGER,INTEGER,INTEGER,TEXT,TEXT,TEXT,JSONB) TO app_backend_worker;
GRANT USAGE ON SCHEMA backend_review TO cs_ai_definer;
GRANT EXECUTE ON FUNCTION backend_review.lock_content() TO cs_ai_definer;
COMMIT;
