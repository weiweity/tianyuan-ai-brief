-- DRAFT storage contract only. Not a migration, not intake-ready.
-- Apply only after schema.v1.15 in a disposable synthetic design database.
-- No application grants: transaction functions/ACL and concurrency validation are pending.
BEGIN;
CREATE SCHEMA backend_identity;
REVOKE ALL ON SCHEMA backend_identity FROM PUBLIC;
CREATE TABLE backend_identity.subject_bindings (
  binding_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('synthetic','feishu')),
  tenant TEXT NOT NULL CHECK (length(tenant) BETWEEN 1 AND 128),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 256),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 128),
  subject_hash TEXT NOT NULL CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  role TEXT NOT NULL CHECK (role IN ('agent','coach','owner')),
  authorization_version BIGINT NOT NULL DEFAULT 1 CHECK (authorization_version > 0),
  UNIQUE (provider,tenant,subject),
  UNIQUE (user_id)
);
CREATE TABLE backend_identity.login_requests (
  login_id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  client_challenge TEXT NOT NULL CHECK (client_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  status TEXT NOT NULL CHECK (status IN ('pending','exchanging','ready','consumed','failed','expired')),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '5 minutes'),
  exchange_started_at TIMESTAMPTZ,
  binding_id TEXT REFERENCES backend_identity.subject_bindings(binding_id),
  consumed_at TIMESTAMPTZ,
  UNIQUE (login_id, binding_id),
  CHECK ((status IN ('ready','consumed') AND binding_id IS NOT NULL)
    OR (status NOT IN ('ready','consumed') AND binding_id IS NULL)),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK (consumed_at IS NULL OR (consumed_at >= issued_at AND consumed_at < expires_at)),
  CHECK (status <> 'exchanging' OR exchange_started_at IS NOT NULL)
);
CREATE TABLE backend_identity.sessions (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  login_id TEXT NOT NULL UNIQUE,
  binding_id TEXT NOT NULL REFERENCES backend_identity.subject_bindings(binding_id),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes'),
  revoked_at TIMESTAMPTZ CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  FOREIGN KEY (login_id, binding_id) REFERENCES backend_identity.login_requests(login_id, binding_id)
);
CREATE INDEX sessions_expiry ON backend_identity.sessions(expires_at);
CREATE TABLE backend_identity.capability_bindings (
  user_id TEXT NOT NULL REFERENCES backend_identity.subject_bindings(user_id),
  capability TEXT NOT NULL CHECK (capability IN ('content_review_lead','content_review_manager','content_quality_reviewer')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  evidence_id TEXT NOT NULL CHECK (evidence_id ~ '^EVD-[A-Z0-9-]{6,127}$'),
  PRIMARY KEY (user_id,capability)
);
CREATE SCHEMA backend_review;
REVOKE ALL ON SCHEMA backend_review FROM PUBLIC;
CREATE TABLE backend_review.waits (
  import_batch_id TEXT PRIMARY KEY REFERENCES public.import_batches(import_batch_id),
  review_revision TEXT NOT NULL CHECK (review_revision ~ '^[0-9a-f]{64}$'),
  plan_id TEXT NOT NULL UNIQUE,
  population_manifest_hash TEXT NOT NULL CHECK (population_manifest_hash ~ '^[0-9a-f]{64}$'),
  object_key TEXT NOT NULL CHECK (object_key ~ '^review/[A-Za-z0-9_-]{1,128}$'),
  object_sha256 TEXT NOT NULL CHECK (object_sha256 ~ '^[0-9a-f]{64}$'),
  object_bytes BIGINT NOT NULL CHECK (object_bytes BETWEEN 1 AND 52428800),
  parked_job_id TEXT NOT NULL UNIQUE REFERENCES public.outbox_jobs(job_id),
  resumed_job_id TEXT UNIQUE REFERENCES public.outbox_jobs(job_id),
  status TEXT NOT NULL CHECK (status IN ('waiting','resumed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL,
  resumed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  UNIQUE (import_batch_id, review_revision),
  UNIQUE (plan_id, review_revision),
  FOREIGN KEY (plan_id, import_batch_id, population_manifest_hash)
    REFERENCES public.content_quality_review_plans(plan_id, import_batch_id, population_manifest_hash),
  CHECK (parked_job_id IS DISTINCT FROM resumed_job_id),
  CHECK (
    (status = 'waiting' AND resumed_job_id IS NULL AND resumed_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'resumed' AND resumed_job_id IS NOT NULL AND resumed_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL)
  ),
  CHECK (resumed_at IS NULL OR resumed_at >= created_at),
  CHECK (cancelled_at IS NULL OR cancelled_at >= created_at)
);
-- Immutable submitted checks are the inputs to server-derived quality counts.
CREATE TABLE backend_review.quality_checks (
  plan_id TEXT NOT NULL REFERENCES backend_review.waits(plan_id),
  review_revision TEXT NOT NULL CHECK (review_revision ~ '^[0-9a-f]{64}$'),
  phase TEXT NOT NULL CHECK (phase IN ('initial','expanded')),
  script_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  defect BOOLEAN NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES backend_identity.subject_bindings(user_id),
  evidence_id TEXT NOT NULL CHECK (evidence_id ~ '^EVD-[A-Z0-9-]{6,127}$'),
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (plan_id,review_revision,phase,script_id,content_hash),
  FOREIGN KEY (plan_id, review_revision) REFERENCES backend_review.waits(plan_id, review_revision)
);
CREATE FUNCTION backend_review.quality_checks_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    RAISE EXCEPTION USING ERRCODE='ZA003', MESSAGE='QUALITY_EVIDENCE_IMMUTABLE';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM backend_review.waits w
    WHERE w.plan_id=NEW.plan_id AND w.review_revision=NEW.review_revision AND w.status='waiting'
  ) THEN
    RAISE EXCEPTION USING ERRCODE='ZA003', MESSAGE='REVIEW_STALE';
  END IF;
  IF EXISTS (
    SELECT 1 FROM backend_review.quality_checks q
    WHERE q.plan_id=NEW.plan_id AND q.script_id=NEW.script_id AND q.content_hash=NEW.content_hash
      AND q.defect IS DISTINCT FROM NEW.defect
  ) THEN
    RAISE EXCEPTION USING ERRCODE='ZA003', MESSAGE='QUALITY_EVIDENCE_INVALID';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quality_checks_guard
  BEFORE INSERT OR UPDATE OR DELETE ON backend_review.quality_checks
  FOR EACH ROW EXECUTE FUNCTION backend_review.quality_checks_guard();
REVOKE ALL ON FUNCTION backend_review.quality_checks_guard() FROM PUBLIC;
CREATE FUNCTION backend_identity.sessions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM backend_identity.login_requests r
    WHERE r.login_id=NEW.login_id AND r.binding_id=NEW.binding_id
      AND r.status='ready' AND r.expires_at>clock_timestamp()
  ) THEN
    RAISE EXCEPTION USING ERRCODE='ZA003', MESSAGE='LOGIN_INVALID';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sessions_guard BEFORE INSERT ON backend_identity.sessions
  FOR EACH ROW EXECUTE FUNCTION backend_identity.sessions_guard();
REVOKE ALL ON FUNCTION backend_identity.sessions_guard() FROM PUBLIC;
CREATE FUNCTION backend_review.waits_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.status='cancelled' AND NEW.status IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION USING ERRCODE='ZA003', MESSAGE='REVIEW_STALE';
    END IF;
    IF OLD.status='resumed' AND NEW.status='waiting' THEN
      RAISE EXCEPTION USING ERRCODE='ZA003', MESSAGE='REVIEW_STALE';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER waits_guard BEFORE UPDATE ON backend_review.waits
  FOR EACH ROW EXECUTE FUNCTION backend_review.waits_guard();
REVOKE ALL ON FUNCTION backend_review.waits_guard() FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA backend_identity,backend_review FROM PUBLIC;
COMMENT ON SCHEMA backend_identity IS 'DRAFT: no application access; auth functions and grants pending';
COMMENT ON SCHEMA backend_review IS 'DRAFT: no application access; park/resume/cancel locking and finalizer integration pending';
COMMIT;
