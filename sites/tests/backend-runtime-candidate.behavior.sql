\set ON_ERROR_STOP on
-- Synthetic-only transaction smoke. Caller creates a disposable database with both candidate deltas.
INSERT INTO backend_identity.subject_bindings(binding_id,provider,tenant,subject,user_id,enabled,role,authorization_version,subject_hash) VALUES
 ('synthetic-binding','synthetic','synthetic-tenant','synthetic-subject','synthetic-user',true,'owner',1,repeat('c',64)),
 ('manager-binding','synthetic','synthetic-tenant','manager-subject','manager-user',true,'owner',1,repeat('e',64)),
 ('quality-binding','synthetic','synthetic-tenant','quality-subject','quality-user',true,'owner',1,repeat('f',64)),
 ('nocap-binding','synthetic','synthetic-tenant','nocap-subject','nocap-user',true,'owner',1,repeat('d',64));
INSERT INTO backend_identity.capability_bindings(user_id,capability,enabled,version,evidence_id) VALUES
 ('synthetic-user','content_review_lead',true,1,'EVD-SYNTHETIC-01'),
 ('manager-user','content_review_manager',true,1,'EVD-SYNTHETIC-01'),
 ('quality-user','content_quality_reviewer',true,1,'EVD-SYNTHETIC-01');
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('app_backend_auth','app_backend_review','app_backend_worker') AND rolcanlogin) THEN
  RAISE EXCEPTION 'Capability roles must be NOLOGIN';
 END IF;
END $$;
SET ROLE app_backend_auth;
SELECT backend_identity.create_login('synthetic-login',encode(sha256(convert_to(repeat('s',43),'UTF8')),'hex'),rtrim(translate(encode(sha256(convert_to(repeat('v',43),'UTF8')),'base64'),'+/','-_'),'='));
SELECT backend_identity.begin_callback(repeat('s',43));
SELECT backend_identity.complete_callback('synthetic-login','synthetic-binding');
SELECT backend_identity.exchange('synthetic-login',repeat('v',43),repeat('t',43));
SELECT backend_identity.create_login('manager-login',encode(sha256(convert_to(repeat('m',43),'UTF8')),'hex'),rtrim(translate(encode(sha256(convert_to(repeat('w',43),'UTF8')),'base64'),'+/','-_'),'='));
SELECT backend_identity.begin_callback(repeat('m',43));
SELECT backend_identity.complete_callback('manager-login','manager-binding');
SELECT backend_identity.exchange('manager-login',repeat('w',43),repeat('k',43));
SELECT backend_identity.create_login('quality-login',encode(sha256(convert_to(repeat('q',43),'UTF8')),'hex'),rtrim(translate(encode(sha256(convert_to(repeat('y',43),'UTF8')),'base64'),'+/','-_'),'='));
SELECT backend_identity.begin_callback(repeat('q',43));
SELECT backend_identity.complete_callback('quality-login','quality-binding');
SELECT backend_identity.exchange('quality-login',repeat('y',43),repeat('g',43));
SELECT backend_identity.create_login('nocap-login',encode(sha256(convert_to(repeat('n',43),'UTF8')),'hex'),rtrim(translate(encode(sha256(convert_to(repeat('z',43),'UTF8')),'base64'),'+/','-_'),'='));
SELECT backend_identity.begin_callback(repeat('n',43));
SELECT backend_identity.complete_callback('nocap-login','nocap-binding');
SELECT backend_identity.exchange('nocap-login',repeat('z',43),repeat('p',43));
SELECT backend_identity.create_login('pkce-login',encode(sha256(convert_to(repeat('1',43),'UTF8')),'hex'),rtrim(translate(encode(sha256(convert_to(repeat('2',43),'UTF8')),'base64'),'+/','-_'),'='));
SELECT backend_identity.begin_callback(repeat('1',43));
SELECT backend_identity.complete_callback('pkce-login','synthetic-binding');
DO $$ BEGIN
 BEGIN PERFORM backend_identity.exchange('synthetic-login',repeat('v',43),repeat('u',43)); RAISE EXCEPTION 'Replay accepted';
 EXCEPTION WHEN SQLSTATE 'ZA003' THEN IF SQLERRM<>'LOGIN_CONSUMED' THEN RAISE; END IF; END;
 BEGIN PERFORM backend_identity.exchange('pkce-login',repeat('9',43),repeat('7',43)); RAISE EXCEPTION 'Bad PKCE accepted';
 EXCEPTION WHEN SQLSTATE 'ZA001' THEN IF SQLERRM<>'LOGIN_INVALID' THEN RAISE; END IF; END;
 BEGIN PERFORM backend_identity.begin_callback(repeat('1',43)); RAISE EXCEPTION 'Callback replay accepted';
 EXCEPTION WHEN SQLSTATE 'ZA003' THEN IF SQLERRM<>'LOGIN_INVALID' THEN RAISE; END IF; END;
END $$;
SELECT backend_identity.exchange('pkce-login',repeat('2',43),repeat('7',43));
DO $$ BEGIN
 BEGIN PERFORM backend_identity.exchange('pkce-login',repeat('2',43),repeat('6',43)); RAISE EXCEPTION 'PKCE replay accepted';
 EXCEPTION WHEN SQLSTATE 'ZA003' THEN IF SQLERRM<>'LOGIN_CONSUMED' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF (SELECT count(*) FROM backend_identity.sessions)<>5 THEN RAISE EXCEPTION 'Duplicate session'; END IF;
END $$;
INSERT INTO public.import_batches(import_batch_id,source_type,source_binding_hash,status,actor_user_id,actor_role) VALUES('synthetic-batch','seed',repeat('a',64),'validating','synthetic-user','owner');
INSERT INTO public.outbox_jobs(job_id,job_type,payload,status,lease_owner,lease_version,lease_expires_at) VALUES('synthetic-job','import_validate','{"import_batch_id":"synthetic-batch"}','running','synthetic-worker',1,clock_timestamp()+interval '60 seconds');
DO $$
DECLARE rows JSONB; revision TEXT; receipt JSONB; page JSONB; resumed TEXT; manifest TEXT; listed JSONB;
BEGIN
 rows:=jsonb_build_array(
  jsonb_build_object('staging_id','synthetic-staging','script_id','synthetic-script','operation','upsert','content_hash',repeat('b',64),'risk_level','low','has_conflict',false,'quality_status','clean','title','Synthetic title','answer_text','Synthetic answer'),
  jsonb_build_object('staging_id','synthetic-conflict','script_id','synthetic-conflict','operation','upsert','content_hash',repeat('c',64),'risk_level','high','has_conflict',true,'quality_status','clean','title','Conflict title','answer_text','Conflict answer')
 );
 manifest:=encode(sha256(convert_to(jsonb_build_array(backend_review.sample_ids(rows,repeat('a',64),1),backend_review.sample_ids(rows,repeat('a',64),1))::text,'UTF8')),'hex');
 SET ROLE app_backend_worker;
 PERFORM public.freeze_content_quality_review_plan('synthetic-job','synthetic-worker',1,'synthetic-batch','qplan_synthetic','synthetic-policy',clock_timestamp(),2,1,1,repeat('a',64),manifest,'sha256-ranked-v1',rows);
 BEGIN PERFORM backend_review.park('synthetic-job','synthetic-worker',99,'synthetic-batch','qplan_synthetic','review/synthetic',repeat('e',64),100,rows); RAISE EXCEPTION 'Stale lease parked'; EXCEPTION WHEN SQLSTATE 'ZA006' THEN IF SQLERRM<>'OUTBOX_LEASE_LOST' THEN RAISE; END IF; END;
 revision:=backend_review.park('synthetic-job','synthetic-worker',1,'synthetic-batch','qplan_synthetic','review/synthetic',repeat('e',64),100,rows);
 BEGIN PERFORM backend_review.park('synthetic-job','synthetic-worker',1,'synthetic-batch','qplan_synthetic','review/synthetic',repeat('e',64),100,rows); RAISE EXCEPTION 'Repark accepted'; EXCEPTION WHEN SQLSTATE 'ZA003' THEN IF SQLERRM<>'REVIEW_STALE' THEN RAISE; END IF; END;
 BEGIN PERFORM backend_review.decision(repeat('t',43),'synthetic-batch',revision,'denied','synthetic-script',repeat('b',64),'approved','EVD-SYNTHETIC-01'); RAISE EXCEPTION 'Worker review allowed'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
 BEGIN PERFORM backend_review.page(repeat('t',43),'synthetic-batch',revision,0,1); RAISE EXCEPTION 'Worker page allowed'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
 BEGIN PERFORM backend_review.list(repeat('t',43),NULL,20); RAISE EXCEPTION 'Worker list allowed'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
 SET ROLE app_backend_review;
 BEGIN PERFORM backend_identity.create_login('review-login',repeat('a',64),repeat('b',43)); RAISE EXCEPTION 'Review login allowed'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
 BEGIN PERFORM 1 FROM backend_identity.sessions; RAISE EXCEPTION 'Session table readable'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
 BEGIN PERFORM public.record_content_review_decision('crd_denied','s',repeat('b',64),'ROLE-CONTENT-LEAD',repeat('c',64),'v1','EVD-SYNTHETIC-01','approved',clock_timestamp(),'content_review_lead'); RAISE EXCEPTION 'Raw review allowed'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
 BEGIN PERFORM backend_review.page(repeat('p',43),'synthetic-batch',revision,0,1); RAISE EXCEPTION 'No-cap page allowed'; EXCEPTION WHEN SQLSTATE 'ZA005' THEN IF SQLERRM<>'CAPABILITY_DENIED' THEN RAISE; END IF; END;
 BEGIN PERFORM backend_review.decision(repeat('p',43),'synthetic-batch',revision,'nocap','synthetic-script',repeat('b',64),'approved','EVD-SYNTHETIC-01'); RAISE EXCEPTION 'No-cap decision allowed'; EXCEPTION WHEN SQLSTATE 'ZA005' THEN IF SQLERRM<>'CAPABILITY_DENIED' THEN RAISE; END IF; END;
 BEGIN PERFORM backend_review.quality(repeat('p',43),'synthetic-batch',revision,'nocap','initial','[]'::jsonb,'EVD-SYNTHETIC-01'); RAISE EXCEPTION 'No-cap quality allowed'; EXCEPTION WHEN SQLSTATE 'ZA005' THEN IF SQLERRM<>'CAPABILITY_DENIED' THEN RAISE; END IF; END;
 BEGIN PERFORM backend_review.resume(repeat('p',43),'synthetic-batch',revision); RAISE EXCEPTION 'No-cap resume allowed'; EXCEPTION WHEN SQLSTATE 'ZA005' THEN IF SQLERRM<>'CAPABILITY_DENIED' THEN RAISE; END IF; END;
 BEGIN PERFORM backend_review.decision(repeat('g',43),'synthetic-batch',revision,'quality-as-lead','synthetic-script',repeat('b',64),'approved','EVD-SYNTHETIC-01'); RAISE EXCEPTION 'Quality actor decision allowed'; EXCEPTION WHEN SQLSTATE 'ZA005' THEN IF SQLERRM<>'CAPABILITY_DENIED' THEN RAISE; END IF; END;
 BEGIN PERFORM backend_review.quality(repeat('t',43),'synthetic-batch',revision,'lead-as-quality','initial','[]'::jsonb,'EVD-SYNTHETIC-01'); RAISE EXCEPTION 'Lead quality allowed'; EXCEPTION WHEN SQLSTATE 'ZA005' THEN IF SQLERRM<>'CAPABILITY_DENIED' THEN RAISE; END IF; END;
 page:=backend_review.page(repeat('t',43),'synthetic-batch',revision,0,2);
 IF jsonb_array_length(page->'items')<>2 OR page->>'next_after' IS NOT NULL OR page ? 'object_key'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(page->'items') item WHERE item ? 'object_key' OR NOT item ?& ARRAY['initial_sample','expanded_sample','script_id','content_hash']) THEN RAISE EXCEPTION 'Page violation'; END IF;
 listed:=backend_review.list(repeat('t',43),NULL,20);
 IF jsonb_array_length(listed->'items')<>1 OR listed->'items'->0->>'state'<>'waiting' THEN RAISE EXCEPTION 'List violation'; END IF;
 BEGIN PERFORM backend_review.page(repeat('t',43),'synthetic-batch',repeat('z',64),0,1); RAISE EXCEPTION 'Stale accepted'; EXCEPTION WHEN SQLSTATE 'ZA003' THEN IF SQLERRM<>'REVIEW_STALE' THEN RAISE; END IF; END;
 receipt:=backend_review.decision(repeat('t',43),'synthetic-batch',revision,'synthetic-request','synthetic-script',repeat('b',64),'approved','EVD-SYNTHETIC-01');
 IF receipt IS DISTINCT FROM backend_review.decision(repeat('t',43),'synthetic-batch',revision,'synthetic-request','synthetic-script',repeat('b',64),'approved','EVD-SYNTHETIC-01') THEN RAISE EXCEPTION 'Idempotency violation'; END IF;
 BEGIN PERFORM backend_review.decision(repeat('t',43),'synthetic-batch',revision,'synthetic-request','synthetic-script',repeat('b',64),'rejected','EVD-SYNTHETIC-01'); RAISE EXCEPTION 'Mismatch accepted'; EXCEPTION WHEN SQLSTATE 'ZA003' THEN IF SQLERRM<>'IDEMPOTENCY_CONFLICT' THEN RAISE; END IF; END;
 PERFORM backend_review.decision(repeat('t',43),'synthetic-batch',revision,'lead-conflict','synthetic-conflict',repeat('c',64),'approved','EVD-SYNTHETIC-01');
 BEGIN PERFORM backend_review.resume(repeat('g',43),'synthetic-batch',revision); RAISE EXCEPTION 'Quality-less resume accepted'; EXCEPTION WHEN SQLSTATE 'ZA003' THEN IF SQLERRM<>'QUALITY_GATE_NOT_PASSED' THEN RAISE; END IF; END;
 BEGIN PERFORM backend_review.quality(repeat('g',43),'synthetic-batch',revision,'quality-short','initial',jsonb_build_array(jsonb_build_object('script_id','synthetic-script','content_hash',repeat('b',64),'defect',false)),'EVD-SYNTHETIC-01'); RAISE EXCEPTION 'Short sample accepted'; EXCEPTION WHEN SQLSTATE 'ZA001' THEN IF SQLERRM<>'QUALITY_SAMPLE_MISMATCH' THEN RAISE; END IF; END;
 receipt:=backend_review.quality(repeat('g',43),'synthetic-batch',revision,'quality-request','initial',jsonb_build_array(jsonb_build_object('script_id','synthetic-script','content_hash',repeat('b',64),'defect',false),jsonb_build_object('script_id','synthetic-conflict','content_hash',repeat('c',64),'defect',false)),'EVD-SYNTHETIC-01');
 IF receipt IS DISTINCT FROM backend_review.quality(repeat('g',43),'synthetic-batch',revision,'quality-request','initial',jsonb_build_array(jsonb_build_object('script_id','synthetic-script','content_hash',repeat('b',64),'defect',false),jsonb_build_object('script_id','synthetic-conflict','content_hash',repeat('c',64),'defect',false)),'EVD-SYNTHETIC-01') THEN RAISE EXCEPTION 'Quality idempotency violation'; END IF;
 BEGIN PERFORM backend_review.quality(repeat('g',43),'synthetic-batch',revision,'quality-request','initial',jsonb_build_array(jsonb_build_object('script_id','synthetic-script','content_hash',repeat('b',64),'defect',true),jsonb_build_object('script_id','synthetic-conflict','content_hash',repeat('c',64),'defect',false)),'EVD-SYNTHETIC-01'); RAISE EXCEPTION 'Quality mismatch accepted'; EXCEPTION WHEN SQLSTATE 'ZA003' THEN IF SQLERRM<>'IDEMPOTENCY_CONFLICT' THEN RAISE; END IF; END;
 IF receipt->>'quality_state'<>'passed' THEN RAISE EXCEPTION 'Quality failed'; END IF;
 BEGIN PERFORM backend_review.resume(repeat('g',43),'synthetic-batch',revision); RAISE EXCEPTION 'Missing dual-person resumed'; EXCEPTION WHEN SQLSTATE 'ZA003' THEN IF SQLERRM<>'REVIEW_EVIDENCE_MISSING' THEN RAISE; END IF; END;
 PERFORM backend_review.decision(repeat('k',43),'synthetic-batch',revision,'manager-conflict','synthetic-conflict',repeat('c',64),'approved','EVD-SYNTHETIC-01');
 resumed:=backend_review.resume(repeat('g',43),'synthetic-batch',revision);
 IF resumed IS DISTINCT FROM backend_review.resume(repeat('g',43),'synthetic-batch',revision) THEN RAISE EXCEPTION 'Duplicate resume'; END IF;
 PERFORM backend_review.cancel(repeat('t',43),'synthetic-batch');
 SET ROLE NONE;
 IF (SELECT status FROM public.outbox_jobs WHERE job_id=resumed)<>'dead' THEN RAISE EXCEPTION 'Cancelled job live'; END IF;
 IF (SELECT status FROM backend_review.waits WHERE import_batch_id='synthetic-batch')<>'cancelled' THEN RAISE EXCEPTION 'Wait not cancelled'; END IF;
 SET ROLE app_backend_review;
 BEGIN PERFORM backend_review.resume(repeat('g',43),'synthetic-batch',revision); RAISE EXCEPTION 'Cancelled resumed'; EXCEPTION WHEN SQLSTATE 'ZA003' THEN IF SQLERRM<>'REVIEW_CANCELLED' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
INSERT INTO public.import_batches(import_batch_id,source_type,source_binding_hash,status,actor_user_id,actor_role) VALUES('synthetic-batch-2','seed',repeat('a',64),'validating','synthetic-user','owner');
INSERT INTO public.outbox_jobs(job_id,job_type,payload,status,lease_owner,lease_version,lease_expires_at) VALUES('synthetic-job-2','import_validate','{"import_batch_id":"synthetic-batch-2"}','running','synthetic-worker',1,clock_timestamp()+interval '60 seconds');
DO $$
DECLARE rows JSONB; revision TEXT; manifest TEXT; receipt JSONB;
BEGIN
 rows:=jsonb_build_array(
  jsonb_build_object('staging_id','b2-staging','script_id','synthetic-script-2','operation','upsert','content_hash',repeat('b',64),'risk_level','low','has_conflict',false,'quality_status','clean','title','T2','answer_text','A2'),
  jsonb_build_object('staging_id','b2-conflict','script_id','synthetic-conflict-2','operation','upsert','content_hash',repeat('c',64),'risk_level','high','has_conflict',true,'quality_status','clean','title','C2','answer_text','A2')
 );
 manifest:=encode(sha256(convert_to(jsonb_build_array(backend_review.sample_ids(rows,repeat('a',64),1),backend_review.sample_ids(rows,repeat('a',64),1))::text,'UTF8')),'hex');
 SET ROLE app_backend_worker;
 PERFORM public.freeze_content_quality_review_plan('synthetic-job-2','synthetic-worker',1,'synthetic-batch-2','qplan_synthetic_2','synthetic-policy',clock_timestamp(),2,1,1,repeat('a',64),manifest,'sha256-ranked-v1',rows);
 revision:=backend_review.park('synthetic-job-2','synthetic-worker',1,'synthetic-batch-2','qplan_synthetic_2','review/synthetic-2',repeat('e',64),100,rows);
 SET ROLE app_backend_review;
 PERFORM backend_review.decision(repeat('t',43),'synthetic-batch-2',revision,'b2-lead','synthetic-script-2',repeat('b',64),'approved','EVD-SYNTHETIC-01');
 PERFORM backend_review.decision(repeat('t',43),'synthetic-batch-2',revision,'b2-lead-conflict','synthetic-conflict-2',repeat('c',64),'approved','EVD-SYNTHETIC-01');
 PERFORM backend_review.decision(repeat('k',43),'synthetic-batch-2',revision,'b2-manager-conflict','synthetic-conflict-2',repeat('c',64),'approved','EVD-SYNTHETIC-01');
 receipt:=backend_review.quality(repeat('g',43),'synthetic-batch-2',revision,'quality-block','initial',jsonb_build_array(jsonb_build_object('script_id','synthetic-script-2','content_hash',repeat('b',64),'defect',true),jsonb_build_object('script_id','synthetic-conflict-2','content_hash',repeat('c',64),'defect',false)),'EVD-SYNTHETIC-01');
 IF receipt->>'quality_state'<>'blocked' THEN RAISE EXCEPTION 'Defect did not block'; END IF;
 BEGIN PERFORM backend_review.resume(repeat('g',43),'synthetic-batch-2',revision); RAISE EXCEPTION 'Blocked quality resumed'; EXCEPTION WHEN SQLSTATE 'ZA003' THEN IF SQLERRM<>'QUALITY_GATE_NOT_PASSED' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
INSERT INTO public.import_batches(import_batch_id,source_type,source_binding_hash,status,actor_user_id,actor_role) VALUES('synthetic-batch-3','seed',repeat('a',64),'validating','synthetic-user','owner');
INSERT INTO public.outbox_jobs(job_id,job_type,payload,status,lease_owner,lease_version,lease_expires_at) VALUES('synthetic-job-3','import_validate','{"import_batch_id":"synthetic-batch-3"}','running','synthetic-worker',1,clock_timestamp()+interval '60 seconds');
DO $$
DECLARE rows JSONB; revision TEXT; manifest TEXT; receipt JSONB;
BEGIN
 rows:=jsonb_build_array(
  jsonb_build_object('staging_id','b3-staging','script_id','synthetic-script-3','operation','upsert','content_hash',repeat('b',64),'risk_level','low','has_conflict',false,'quality_status','clean','title','T3','answer_text','A3'),
  jsonb_build_object('staging_id','b3-conflict','script_id','synthetic-conflict-3','operation','upsert','content_hash',repeat('c',64),'risk_level','high','has_conflict',true,'quality_status','clean','title','C3','answer_text','A3')
 );
 manifest:=encode(sha256(convert_to(jsonb_build_array(backend_review.sample_ids(rows,repeat('a',64),1),backend_review.sample_ids(rows,repeat('a',64),1))::text,'UTF8')),'hex');
 SET ROLE app_backend_worker;
 PERFORM public.freeze_content_quality_review_plan('synthetic-job-3','synthetic-worker',1,'synthetic-batch-3','qplan_synthetic_3','synthetic-policy',clock_timestamp(),2,1,1,repeat('a',64),manifest,'sha256-ranked-v1',rows);
 revision:=backend_review.park('synthetic-job-3','synthetic-worker',1,'synthetic-batch-3','qplan_synthetic_3','review/synthetic-3',repeat('e',64),100,rows);
 SET ROLE app_backend_review;
 receipt:=backend_review.quality(repeat('g',43),'synthetic-batch-3',revision,'quality-revision','initial',jsonb_build_array(jsonb_build_object('script_id','synthetic-script-3','content_hash',repeat('b',64),'defect',false),jsonb_build_object('script_id','synthetic-conflict-3','content_hash',repeat('c',64),'defect',true)),'EVD-SYNTHETIC-01');
 IF receipt->>'quality_state'<>'revision_required' THEN RAISE EXCEPTION 'Sub-threshold defect blocked'; END IF;
 BEGIN PERFORM backend_review.resume(repeat('g',43),'synthetic-batch-3',revision); RAISE EXCEPTION 'Revision-required resumed'; EXCEPTION WHEN SQLSTATE 'ZA003' THEN IF SQLERRM<>'QUALITY_GATE_NOT_PASSED' THEN RAISE; END IF; END;
END $$;
SET ROLE app_backend_auth;
SELECT backend_identity.logout(repeat('t',43));
DO $$ BEGIN
 BEGIN PERFORM backend_identity.actor(repeat('t',43)); RAISE EXCEPTION 'Revoked accepted'; EXCEPTION WHEN SQLSTATE 'ZA005' THEN IF SQLERRM<>'SESSION_INVALID' THEN RAISE; END IF; END;
 PERFORM backend_identity.actor(repeat('k',43));
 PERFORM backend_identity.actor(repeat('g',43));
 BEGIN PERFORM backend_review.page(repeat('k',43),'synthetic-batch',repeat('b',64),0,1); RAISE EXCEPTION 'Auth page allowed'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
END $$;
RESET ROLE;
SET ROLE app_backend_review;
DO $$ BEGIN
 BEGIN PERFORM backend_review.page(repeat('t',43),'synthetic-batch',repeat('b',64),0,1); RAISE EXCEPTION 'Revoked page accepted'; EXCEPTION WHEN SQLSTATE 'ZA005' THEN IF SQLERRM<>'SESSION_INVALID' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
SELECT 'PASS auth replay/ACL/page/idempotency/quality/resume/cancel/logout' AS result;
