-- Synthetic backend closure: deferred validation retains the definer boundary at COMMIT.
BEGIN;
ALTER FUNCTION public.trg_release_source_set_complete() OWNER TO cs_ai_definer;
ALTER FUNCTION public.trg_release_source_set_complete() SECURITY DEFINER;
ALTER FUNCTION public.trg_release_source_set_complete() SET search_path = pg_catalog, public, pg_temp;
REVOKE ALL ON FUNCTION public.trg_release_source_set_complete() FROM PUBLIC;
COMMENT ON SCHEMA public IS 'CS-AI-C11 schema.v1.17; synthetic backend development only; runtime activation and production NOT_CERTIFIED';
COMMIT;
