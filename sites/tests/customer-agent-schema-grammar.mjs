import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const parser = require("@libpg-query/parser");
const schemaUrl = new URL(
  "../../business-docs/01-客服Agent项目/20-设计-进行中/33-schema-v1-草案.sql",
  import.meta.url,
);
const openapiUrl = new URL(
  "../../business-docs/01-客服Agent项目/20-设计-进行中/openapi.v1.yaml",
  import.meta.url,
);
const sql = await readFile(schemaUrl, "utf8");
const openapi = await readFile(openapiUrl, "utf8");

await parser.loadModule();
const parsedSql = parser.parseSync(sql);
const parsedFunctions = parser.parsePlPgSQLSync(sql);

assert.equal(parsedSql.stmts.length, 513, "SQL statement count changed; review the frozen schema baseline");
assert.equal(
  parsedFunctions.plpgsql_funcs.length,
  89,
  "function-body count changed; review the frozen schema baseline",
);

for (const objectName of [
  "privacy_notices",
  "notice_decisions",
  "query_events",
  "candidate_impressions",
  "adoption_events",
  "escalate_actions",
  "iteration_tasks",
  "iteration_task_status_audits",
  "work_order_import_batches",
  "work_order_records",
  "work_order_export_audits",
  "authoritative_source_versions",
  "authoritative_source_suspensions",
  "import_batch_source_bindings",
  "release_source_bindings",
  "snapshot_offline_leases",
  "source_denial_audits",
  "intent_taxonomy_versions",
  "intent_taxonomy_entries",
  "intent_taxonomy_mappings",
  "content_quality_review_plans",
  "content_quality_review_evidence",
  "content_review_decisions",
  "semantic_source_assets",
]) {
  assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${objectName}\\b`));
}
assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS usage_outcome_events\b/);
assert.match(sql, /interaction_reason IN \('original','reselection'\)/);
assert.match(sql, /CONSTRAINT escalate_query_action_unique UNIQUE \(query_id, action\)/);
assert.match(sql, /CONSTRAINT candidate_release_item_provenance_fk/);
assert.match(sql, /FOREIGN KEY \(release_id, script_id, script_version, content_hash\)/);
for (const functionName of [
  "start_iteration_task",
  "close_iteration_task",
  "claim_work_order_import_validation",
  "heartbeat_work_order_import_validation",
  "retry_work_order_import_validation",
  "reconcile_exhausted_work_order_imports",
  "finalize_work_order_import_validation",
  "record_work_order_export",
  "record_source_denial_audit",
  "record_runtime_source_denial_audit",
  "record_admin_source_denial_audit",
  "retire_semantic_source_asset",
  "issue_snapshot_offline_lease",
  "validate_snapshot_offline_lease",
  "read_current_announcement_with_lease",
  "read_snapshot_page",
  "public.content_text_array_is_nonblank_unique",
  "public.content_template_placeholders_are_valid",
  "public.content_scope_matches",
  "public.content_questions_are_valid",
  "public.jsonb_jcs",
  "public.content_utc_timestamp_text",
  "public.content_question_hash",
  "public.content_questions_align_intent",
  "public.content_risk_categories_are_valid",
  "public.content_quality_population_manifest_hash",
  "public.content_quality_staging_population_manifest_hash",
  "public.content_questions_source_assets_are_active",
  "public.content_public_questions",
  "public.content_governance_snapshot",
  "public.content_governance_hash",
  "public.content_quality_issue_codes_are_public",
  "record_content_review_decision",
  "freeze_content_quality_review_plan",
  "record_content_quality_review_evidence",
  "search_recommendable_scripts",
  "read_content_import_status",
  "read_content_import_preview",
  "trg_source_gate_search_telemetry_guard",
]) {
  assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION ${functionName}\\b`));
}
assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS iteration_tickets\b/);
assert.match(sql, /p_job_type NOT IN \('import_validate','work_order_import_validate'\)/);

assert.match(sql, /^-- schema\.v1\.13\b/m);
const sourceRegistry = sql.match(
  /CREATE TABLE IF NOT EXISTS authoritative_source_versions \([\s\S]*?\n\);/,
)?.[0];
assert.ok(sourceRegistry, "authoritative source registry DDL missing");
assert.doesNotMatch(sourceRegistry, /\bis_current\b|\bcurrent_status\b/);
assert.match(sourceRegistry, /use_class\s+TEXT NOT NULL CHECK \(use_class IN \('canonical','reference'\)\)/);
assert.match(sourceRegistry, /approval_evd\s+TEXT NOT NULL/);
assert.match(sourceRegistry, /source_ref ~ '\^SRC-/);

assert.match(sql, /CREATE CONSTRAINT TRIGGER release_source_set_complete[\s\S]*?DEFERRABLE INITIALLY DEFERRED/);
assert.match(sql, /release requires exactly four authoritative source domains/);
assert.match(sql, /CREATE OR REPLACE VIEW v_release_source_gate AS/);
assert.match(sql, /JOIN v_release_source_gate gate[\s\S]*?gate\.source_gate_ready/);
assert.match(sql, /query_source_gate_telemetry_guard[\s\S]*?BEFORE INSERT ON query_events/);
assert.match(sql, /impression_source_gate_telemetry_guard[\s\S]*?BEFORE INSERT ON candidate_impressions/);
assert.match(sql, /ib\.domain = ri\.category/);
assert.match(sql, /DETAIL = 'SOURCE_BASE_RELEASE_STALE'/);
assert.match(sql, /DETAIL = 'SOURCE_BINDING_HASH_MISMATCH'/);
assert.match(sql, /source_gate_reason/);
assert.match(sql, /change_audits_immutable[\s\S]*?BEFORE UPDATE OR DELETE ON change_audits/);
assert.match(sql, /authoritative_source_versions_immutable[\s\S]*?BEFORE UPDATE OR DELETE ON authoritative_source_versions/);
assert.match(sql, /source_denial_audits_immutable[\s\S]*?BEFORE UPDATE OR DELETE ON source_denial_audits/);
assert.match(sql, /snapshot_offline_leases_immutable[\s\S]*?BEFORE UPDATE OR DELETE ON snapshot_offline_leases/);
assert.match(sql, /authoritative_source_suspension_insert_guard[\s\S]*?BEFORE INSERT ON authoritative_source_suspensions/);
assert.match(sql, /CREATE OR REPLACE FUNCTION suspend_authoritative_source\([\s\S]*?cs_ai_content_publish/);
assert.match(sql, /authoritative_source_suspended/);
assert.match(sql, /release_source_binding_guard[\s\S]*?BEFORE INSERT OR UPDATE OR DELETE ON release_source_bindings/);
const releaseItemsGuard = sql.match(
  /CREATE OR REPLACE FUNCTION trg_release_items_immutable\(\)[\s\S]*?\n\$\$;/,
)?.[0];
assert.ok(releaseItemsGuard, "release_items immutable trigger function missing");
assert.doesNotMatch(releaseItemsGuard, /app\.publishing/);
assert.match(sql, /separate audit transaction\/log/);
assert.match(sql, /enqueue_content_import\(TEXT,TEXT,TEXT,TEXT,BIGINT,JSONB,TEXT,TEXT\)/);

const denialAuditTable = sql.match(
  /CREATE TABLE IF NOT EXISTS source_denial_audits \([\s\S]*?\n\);/,
)?.[0];
const denialAuditFunction = sql.match(
  /CREATE OR REPLACE FUNCTION record_source_denial_audit\([\s\S]*?\n\$\$;/,
)?.[0];
assert.ok(denialAuditTable && denialAuditFunction, "independent source denial audit contract missing");
assert.match(denialAuditTable, /denial_key\s+TEXT PRIMARY KEY/);
assert.match(denialAuditTable, /actor_subject_hash/);
assert.match(denialAuditTable, /'announce_ack'/);
assert.doesNotMatch(denialAuditTable, /query_text|internal_url|stack_trace/);
assert.match(denialAuditFunction, /ON CONFLICT \(denial_key\) DO NOTHING/);
assert.match(denialAuditFunction, /IDEMPOTENCY_BODY_MISMATCH/);
assert.match(sql, /after the denied business transaction[\s\S]*?fresh transaction\/connection/);
assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION public\.record_source_denial_audit\([^;]*TO app_/);
assert.match(sql, /record_runtime_source_denial_audit\([\s\S]*?p_operation NOT IN \('content_import','search','announce_current','announce_snapshot','announce_ack'\)/);
assert.match(sql, /record_admin_source_denial_audit\([\s\S]*?p_operation NOT IN \('content_publish','content_rollback','source_suspend'\)/);
assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.record_runtime_source_denial_audit\([^;]*TO app_runtime/);
assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.record_admin_source_denial_audit\([^;]*TO app_content_admin/);

const offlineLeaseTable = sql.match(
  /CREATE TABLE IF NOT EXISTS snapshot_offline_leases \([\s\S]*?\n\);/,
)?.[0];
const ackFunction = sql.match(
  /CREATE OR REPLACE FUNCTION ack_client_release\([\s\S]*?\n\$\$;/,
)?.[0];
assert.ok(offlineLeaseTable && ackFunction, "offline snapshot lease contract missing");
assert.match(offlineLeaseTable, /lease_token_hash\s+TEXT PRIMARY KEY/);
assert.doesNotMatch(offlineLeaseTable, /offline_lease_token|bearer_token/);
assert.match(offlineLeaseTable, /expires_at <= issued_at \+ INTERVAL '15 minutes'/);
assert.match(sql, /CREATE OR REPLACE FUNCTION issue_snapshot_offline_lease\([\s\S]*?p_ttl_seconds < 60 OR p_ttl_seconds > 900/);
assert.match(sql, /CREATE OR REPLACE FUNCTION validate_snapshot_offline_lease\([\s\S]*?OFFLINE_LEASE_EXPIRED/);
assert.match(sql, /ack_client_release\(TEXT,TEXT,TEXT,BIGINT,TEXT\)/);
assert.match(ackFunction, /validate_snapshot_offline_lease/);
assert.match(ackFunction, /last_seen_source_binding_hash/);
assert.match(ackFunction, /last_ack_lease_token_hash/);
assert.doesNotMatch(ackFunction, /UPDATE public\.snapshot_offline_leases/);
assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*?snapshot_offline_leases, source_denial_audits[\s\S]*?FROM app_runtime/);

const currentAnnouncementReader = sql.match(
  /CREATE OR REPLACE FUNCTION read_current_announcement_with_lease\([\s\S]*?\n\$\$;/,
)?.[0];
const snapshotPageReader = sql.match(
  /CREATE OR REPLACE FUNCTION read_snapshot_page\([\s\S]*?\n\$\$;/,
)?.[0];
assert.ok(currentAnnouncementReader && snapshotPageReader, "controlled announce readers missing");
assert.match(currentAnnouncementReader, /issue_snapshot_offline_lease/);
assert.match(currentAnnouncementReader, /JOIN public\.content_releases/);
assert.match(currentAnnouncementReader, /LEFT JOIN LATERAL[\s\S]*?public\.announcements/);
assert.match(snapshotPageReader, /p_limit < 1 OR p_limit > 500/);
assert.match(snapshotPageReader, /WITH authorized AS MATERIALIZED[\s\S]*?validate_snapshot_offline_lease/);
assert.match(snapshotPageReader, /JOIN public\.release_items/);
assert.match(snapshotPageReader, /items_json JSONB/);
for (const publicSnapshotField of [
  "script_id",
  "script_version",
  "content_hash",
  "title",
  "category",
  "answer_text",
  "platform_scope",
  "product_scope_type",
  "product_scope_refs",
  "effective_from",
  "effective_to",
  "intent_taxonomy_version",
  "intent_id",
  "risk_level",
  "risk_categories",
  "has_conflict",
  "placeholder_keys",
]) {
  assert.match(snapshotPageReader, new RegExp(`'${publicSnapshotField}'`));
}
assert.match(snapshotPageReader, /'questions', public\.content_public_questions\(page\.questions_json\)/);
for (const forbiddenSnapshotKey of [
  "source_version_id",
  "source_ref",
  "owner_role",
  "review_due_at",
  "review_mode",
  "primary_review_evd",
  "secondary_review_evd",
]) {
  assert.doesNotMatch(snapshotPageReader, new RegExp(`'${forbiddenSnapshotKey}'`));
}
assert.doesNotMatch(snapshotPageReader, /search_document|search_fallback_text/);
assert.doesNotMatch(snapshotPageReader, /effective_from\s*<=\s*now\(\)|now\(\)\s*<\s*[^\n]*effective_to/);
assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.read_current_announcement_with_lease\([^;]*\) TO app_runtime/);
assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.read_snapshot_page\([^;]*\) TO app_runtime/);

const runtimeReadGrant = sql.match(
  /-- Read paths and ordinary event writes\.[\s\S]*?GRANT SELECT ON([\s\S]*?)TO app_runtime;/,
)?.[1];
assert.ok(runtimeReadGrant, "app_runtime read grant block missing");
assert.doesNotMatch(runtimeReadGrant, /v_scripts_recommendable|v_release_source_gate/);
assert.match(
  sql,
  /GRANT EXECUTE ON FUNCTION public\.search_recommendable_scripts\(TEXT,TEXT,TEXT\) TO app_runtime/,
);
for (const rawSorTable of [
  "scripts",
  "script_questions",
  "content_releases",
  "release_items",
  "content_current",
  "announcements",
  "release_source_bindings",
  "import_batches",
  "staging_scripts",
  "import_batch_source_bindings",
  "semantic_source_assets",
]) {
  assert.doesNotMatch(
    runtimeReadGrant,
    new RegExp(`(?:^|[,\\s])${rawSorTable}(?:[,\\s]|$)`),
    `app_runtime must not read raw CR-004 SoR table ${rawSorTable}`,
  );
}
assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.read_content_import_status\(TEXT,TEXT,TEXT\) TO app_runtime/);
assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.read_content_import_preview\(TEXT,TEXT,TEXT,TEXT,INTEGER\) TO app_runtime/);
const importPreviewReader = sql.match(
  /CREATE OR REPLACE FUNCTION read_content_import_preview\([\s\S]*?\n\$\$;/,
)?.[0];
assert.ok(importPreviewReader, "controlled import preview reader missing");
assert.doesNotMatch(
  importPreviewReader,
  /'primary_reviewer_id'|'secondary_reviewer_id'|'primary_review_evd'|'secondary_review_evd'|'search_document'|'search_fallback_text'/,
);

// DEC-042 machine contract: governance fields are executable constraints, not prose-only promises.
const scriptsTable = sql.match(/CREATE TABLE IF NOT EXISTS scripts \([\s\S]*?\n\);/)?.[0];
const questionsTable = sql.match(/CREATE TABLE IF NOT EXISTS script_questions \([\s\S]*?\n\);/)?.[0];
const semanticAssetsTable = sql.match(
  /CREATE TABLE IF NOT EXISTS semantic_source_assets \([\s\S]*?\n\);/,
)?.[0];
const stagingTable = sql.match(/CREATE TABLE IF NOT EXISTS staging_scripts \([\s\S]*?\n\);/)?.[0];
const releaseItemsTable = sql.match(/CREATE TABLE IF NOT EXISTS release_items \([\s\S]*?\n\);/)?.[0];
const queryEventsTable = sql.match(/CREATE TABLE IF NOT EXISTS query_events \([\s\S]*?\n\);/)?.[0];
const publishFunction = sql.match(
  /CREATE OR REPLACE FUNCTION publish_content_release\([\s\S]*?\n\$\$;/,
)?.[0];
const finalizerFunction = sql.match(
  /CREATE OR REPLACE FUNCTION finalize_content_import_validation\([\s\S]*?\n\$\$;/,
)?.[0];
assert.ok(
  scriptsTable && questionsTable && semanticAssetsTable && stagingTable && releaseItemsTable && queryEventsTable &&
    publishFunction && finalizerFunction,
  "DEC-042 governed SQL objects missing",
);

for (const governedTable of [scriptsTable, releaseItemsTable]) {
  assert.match(governedTable, /platform_scope\s+TEXT\[\] NOT NULL/);
  assert.match(governedTable, /product_scope_type\s+TEXT NOT NULL/);
  assert.match(governedTable, /product_scope_refs\s+TEXT\[\] NOT NULL/);
  assert.match(governedTable, /effective_from\s+TIMESTAMPTZ NOT NULL/);
  assert.match(governedTable, /intent_taxonomy_version\s+TEXT NOT NULL/);
  assert.match(governedTable, /intent_id\s+TEXT NOT NULL/);
  assert.match(governedTable, /risk_level\s+TEXT NOT NULL/);
  assert.match(governedTable, /risk_categories\s+TEXT\[\] NOT NULL/);
  assert.match(governedTable, /review_mode\s+TEXT NOT NULL/);
  assert.match(governedTable, /primary_reviewer_id\s+TEXT NOT NULL/);
  assert.match(governedTable, /primary_reviewer_role\s+TEXT NOT NULL/);
  assert.match(governedTable, /primary_review_evd\s+TEXT NOT NULL/);
  assert.match(governedTable, /placeholder_keys\s+TEXT\[\] NOT NULL/);
  assert.match(governedTable, /questions_json\s+JSONB NOT NULL/);
  assert.match(governedTable, /product_scope_type = 'storewide'[\s\S]*?cardinality\(product_scope_refs\) = 0/);
  assert.match(governedTable, /product_scope_type IN \('category','sku'\)[\s\S]*?cardinality\(product_scope_refs\) > 0/);
  assert.match(governedTable, /risk_level = 'high' OR has_conflict[\s\S]*?review_mode = 'dual'[\s\S]*?secondary_review_evd IS NOT NULL/);
  assert.match(governedTable, /secondary_reviewer_id <> primary_reviewer_id/);
  assert.match(governedTable, /primary_reviewer_role[^\n]*ROLE-CONTENT-LEAD/);
  assert.match(governedTable, /secondary_reviewer_role = 'ROLE-CS-MANAGER'/);
  assert.match(governedTable, /content_template_placeholders_are_valid\(answer_text, placeholder_keys\)/);
}
assert.doesNotMatch(sql, /\bsku_scope\b/);

for (const questionField of [
  "question_id",
  "question_version",
  "question_hash",
  "semantic_family_id",
  "origin_fingerprint",
  "origin_fingerprint_key_version",
  "source_asset_id",
  "intent_taxonomy_version",
  "intent_id",
]) {
  assert.match(questionsTable, new RegExp(`\\b${questionField}\\b`));
}
assert.match(questionsTable, /source\s+TEXT NOT NULL CHECK \(source IN \('manual','from_log','import'\)\)/);
assert.match(questionsTable, /source = 'from_log'[\s\S]*?promotion_review_ref IS NOT NULL[\s\S]*?promoted_at IS NOT NULL/);
assert.match(questionsTable, /PRIMARY KEY \(question_id, question_version\)/);
assert.match(sql, /DROP CONSTRAINT IF EXISTS script_question_source_query_fk/);
assert.match(sql, /CONSTRAINT script_question_source_asset_fk[\s\S]*?REFERENCES semantic_source_assets/);
assert.match(sql, /DROP TRIGGER IF EXISTS script_questions_immutable ON script_questions;[\s\S]*?UPDATE script_questions SET source_query_id = NULL/);
assert.match(sql, /UPDATE script_questions SET source_query_id = NULL/);
assert.match(semanticAssetsTable, /source_query_id TEXT REFERENCES query_events\(query_id\) ON DELETE RESTRICT/);
assert.match(semanticAssetsTable, /lifecycle TEXT NOT NULL DEFAULT 'active'/);
assert.match(semanticAssetsTable, /lifecycle = 'retired'[\s\S]*?source_query_id IS NULL/);
assert.match(semanticAssetsTable, /retirement_evd/);
const questionProjection = publishFunction.match(
  /INSERT INTO public\.script_questions[\s\S]*?ON CONFLICT \(question_id, question_version\) DO NOTHING;/,
)?.[0];
assert.ok(questionProjection, "stable question projection missing from publish");
assert.match(questionProjection, /payload\.question_id/);
assert.match(questionProjection, /payload\.intent_taxonomy_version, payload\.intent_id, NULL/);
assert.doesNotMatch(questionProjection, /row_number\s*\(|ordinality|generate_series/);
assert.doesNotMatch(questionProjection, /DO UPDATE/);
assert.match(sql, /question\.value ->> 'question_hash' IS DISTINCT FROM public\.content_question_hash\(question\.value\)/);
assert.match(sql, /'origin_fingerprint', p_question ->> 'origin_fingerprint'/);
assert.match(sql, /'origin_fingerprint_key_version', p_question ->> 'origin_fingerprint_key_version'/);
assert.match(sql, /'promoted_by_role', p_question ->> 'promoted_by_role'/);
assert.match(sql, /question version must start at one and advance without gaps/);
for (const canonicalQuestionField of [
  "question_text",
  "question_hash",
  "semantic_family_id",
  "origin_fingerprint",
  "origin_fingerprint_key_version",
  "source_asset_id",
  "source",
  "intent_taxonomy_version",
  "intent_id",
  "promotion_review_ref",
  "promoted_by_role",
  "promoted_at",
]) {
  assert.match(
    publishFunction,
    new RegExp(`existing\\.${canonicalQuestionField} IS DISTINCT FROM`),
    `same-version conflict must compare ${canonicalQuestionField}`,
  );
}
assert.match(sql, /script_questions_immutable[\s\S]*?BEFORE UPDATE OR DELETE ON script_questions/);
const questionValidators = [
  ...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.content_questions_are_valid\([\s\S]*?\n\$\$;/g),
];
const completeQuestionValidator = questionValidators.at(-1)?.[0];
assert.ok(completeQuestionValidator, "complete ContentQuestion validator missing");
for (const stringField of [
  "question_id",
  "question_text",
  "question_hash",
  "semantic_family_id",
  "origin_fingerprint",
  "origin_fingerprint_key_version",
  "source_asset_id",
  "source",
  "intent_taxonomy_version",
  "intent_id",
]) {
  assert.match(
    completeQuestionValidator,
    new RegExp(`jsonb_typeof\\(question\\.value -> '${stringField}'\\) IS DISTINCT FROM 'string'`),
  );
}
assert.match(completeQuestionValidator, /jsonb_typeof\(question\.value -> 'question_version'\) IS DISTINCT FROM 'number'/);

assert.match(sql, /CREATE TABLE IF NOT EXISTS intent_taxonomy_versions/);
assert.match(sql, /CREATE TABLE IF NOT EXISTS intent_taxonomy_entries/);
assert.match(sql, /CREATE TABLE IF NOT EXISTS intent_taxonomy_mappings/);
assert.match(stagingTable, /quality_status\s+TEXT NOT NULL CHECK \(quality_status IN \('clean','quarantined'\)\)/);
assert.match(stagingTable, /quality_issue_codes\s+JSONB NOT NULL/);
assert.match(stagingTable, /quality_gate_passed\s+BOOLEAN NOT NULL/);
assert.match(publishFunction, /s\.quality_status = 'clean'[\s\S]*?s\.quality_gate_passed/);
assert.match(publishFunction, /content_governance_hash\(/);
assert.match(finalizerFunction, /p_final_status = 'failed'[\s\S]*?jsonb_array_length\(p_staging_rows\) <> 0[\s\S]*?must not persist staging rows/);
assert.match(finalizerFunction, /quality_status = 'clean'[\s\S]*?entry\.lifecycle <> 'active'/);
assert.match(finalizerFunction, /quality_status = 'quarantined'/);
assert.match(finalizerFunction, /content_governance_hash\(/);
assert.doesNotMatch(sql, /digest\(pg_catalog\.convert_to\(s\.answer_text/);

assert.match(sql, /p_placeholder_keys <@ ARRAY\['order_id','date'\]::TEXT\[\]/);
assert.doesNotMatch(sql, /\bplaceholder_values\b|\brendered_answer\b/);
assert.match(queryEventsTable, /product_context_type\s+TEXT CHECK/);
assert.match(queryEventsTable, /product_context_ref_hash\s+TEXT CHECK/);
assert.match(sql, /CREATE OR REPLACE FUNCTION public\.content_scope_matches\([\s\S]*?p_product_context_type = p_product_scope_type/);
assert.match(sql, /p_product_scope_type = 'storewide'/);
const scopedSearchFunction = sql.match(
  /CREATE OR REPLACE FUNCTION search_recommendable_scripts\([\s\S]*?\n\$\$;/,
)?.[0];
assert.ok(scopedSearchFunction, "fail-closed scoped search reader missing");
assert.match(scopedSearchFunction, /SECURITY DEFINER/);
assert.match(scopedSearchFunction, /p_platform NOT IN \('qianniu','douyin'\)/);
assert.match(scopedSearchFunction, /WHERE public\.content_scope_matches\(/);
assert.match(scopedSearchFunction, /RETURNS TABLE\([\s\S]*?script_version INTEGER/);
assert.doesNotMatch(scopedSearchFunction, /RETURNS SETOF|SELECT candidate\.\*/);
for (const forbiddenSearchField of [
  "source_ref",
  "source_version_id",
  "owner_role",
  "review_due_at",
  "review_mode",
  "primary_reviewer_role",
  "primary_review_evd",
  "secondary_reviewer_role",
  "secondary_review_evd",
]) {
  assert.doesNotMatch(scopedSearchFunction, new RegExp(`candidate\\.${forbiddenSearchField}\\b`));
}
assert.match(scopedSearchFunction, /questions JSONB,[\s\S]*?search_document TSVECTOR,[\s\S]*?search_fallback_text TEXT/);
assert.match(scopedSearchFunction, /public\.content_public_questions\(candidate\.questions_json\)/);
assert.doesNotMatch(scopedSearchFunction, /^\s*candidate\.questions_json,?\s*$/m);
assert.match(scopedSearchFunction, /candidate\.search_document/);
assert.match(scopedSearchFunction, /candidate\.search_fallback_text/);
assert.match(sql, /WHERE ri\.effective_from <= now\(\)[\s\S]*?now\(\) < ri\.effective_to/);
assert.doesNotMatch(sql, /ri\.effective_to\s*>=\s*now\(\)|now\(\)\s*<=\s*ri\.effective_to/);
assert.match(sql, /v_scripts_recommendable[\s\S]*?content_questions_source_assets_are_active\(ri\.questions_json\)/);

const retireSemanticAssetFunction = sql.match(
  /CREATE OR REPLACE FUNCTION retire_semantic_source_asset\([\s\S]*?\n\$\$;/,
)?.[0];
const semanticAssetGuard = sql.match(
  /CREATE OR REPLACE FUNCTION trg_semantic_source_asset_guard\(\)[\s\S]*?\n\$\$;/,
)?.[0];
assert.ok(retireSemanticAssetFunction && semanticAssetGuard, "semantic asset retirement fence missing");
assert.match(retireSemanticAssetFunction, /hashtext\('cs_ai_content_publish'\)/);
assert.match(retireSemanticAssetFunction, /snapshot_offline_leases[\s\S]*?lease\.expires_at > pg_catalog\.clock_timestamp\(\)/);
assert.match(retireSemanticAssetFunction, /SET lifecycle = 'retired',[\s\S]*?source_query_id = NULL/);
assert.match(semanticAssetGuard, /OLD\.lifecycle IS DISTINCT FROM 'active'/);
assert.match(semanticAssetGuard, /NEW\.lifecycle IS DISTINCT FROM 'retired'/);
assert.match(semanticAssetGuard, /TG_OP = 'DELETE'/);
assert.match(publishFunction, /prospective release uses missing, mismatched or retired semantic source asset/);
assert.match(publishFunction, /prior\.release_id = v_prev[\s\S]*?content_questions_source_assets_are_active\(prior\.questions_json\)/);
const rollbackFunction = sql.match(
  /CREATE OR REPLACE FUNCTION rollback_content_release\([\s\S]*?\n\$\$;/,
)?.[0];
assert.match(rollbackFunction, /content_questions_source_assets_are_active\(item\.questions_json\)/);

const utcTimestampFunction = sql.match(
  /CREATE OR REPLACE FUNCTION public\.content_utc_timestamp_text\([\s\S]*?\n\$\$;/,
)?.[0];
assert.ok(utcTimestampFunction, "UTC timestamp canonicalizer missing");
assert.match(utcTimestampFunction, /AT TIME ZONE 'UTC'/);
assert.match(utcTimestampFunction, /YYYY-MM-DD"T"HH24:MI:SS\.US"Z"/);
assert.match(sql, /'effective_from', public\.content_utc_timestamp_text\(p_effective_from\)/);
assert.match(sql, /'review_due_at', public\.content_utc_timestamp_text\(p_review_due_at\)/);
const jcsFunction = sql.match(
  /CREATE OR REPLACE FUNCTION public\.jsonb_jcs\([\s\S]*?\n\$\$;/,
)?.[0];
assert.ok(jcsFunction, "DEC-042 fixed-key JCS helper missing");
assert.match(sql, /DEC-042 fixed ASCII-key JCS subset/);
assert.match(sql, /deliberately NOT a general Unicode RFC 8785/);
assert.match(jcsFunction, /ORDER BY member\.key COLLATE "C"/);
assert.match(jcsFunction, /octet_length\(member\.key\) <> pg_catalog\.length\(member\.key\)/);
assert.match(jcsFunction, /DEC042_JCS_SUBSET_INVALID/);

const importErrorConstraint = sql.match(
  /ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batch_error_report_shape;[\s\S]*?ADD CONSTRAINT import_batch_error_report_shape CHECK \([\s\S]*?\n\s*\);/,
)?.[0];
assert.ok(importErrorConstraint, "upgrade-safe import error constraint replacement missing");
assert.match(importErrorConstraint, /'CONTENT_CONTRACT_INVALID'/);
assert.match(importErrorConstraint, /'GOVERNANCE_HASH_MISMATCH'/);

const reviewDecisionTable = sql.match(
  /CREATE TABLE IF NOT EXISTS content_review_decisions \([\s\S]*?\n\);/,
)?.[0];
const qualityPlanTable = sql.match(
  /CREATE TABLE IF NOT EXISTS content_quality_review_plans \([\s\S]*?\n\);/,
)?.[0];
const qualityEvidenceTable = sql.match(
  /CREATE TABLE IF NOT EXISTS content_quality_review_evidence \([\s\S]*?\n\);/,
)?.[0];
const qualityEvidenceFunction = sql.match(
  /CREATE OR REPLACE FUNCTION record_content_quality_review_evidence\([\s\S]*?\n\$\$;/,
)?.[0];
const qualityPlanFunction = sql.match(
  /CREATE OR REPLACE FUNCTION freeze_content_quality_review_plan\([\s\S]*?\n\$\$;/,
)?.[0];
assert.ok(
  reviewDecisionTable && qualityPlanTable && qualityEvidenceTable &&
    qualityPlanFunction && qualityEvidenceFunction,
  "review/quality evidence machine structures missing",
);
for (const riskCode of [
  "refund_compensation",
  "price_discount",
  "campaign_rules",
  "efficacy_safety_claim",
  "account_privacy",
  "complaint_escalation",
  "legal_commitment",
]) {
  assert.match(sql, new RegExp(`'${riskCode}'`));
}
assert.match(reviewDecisionTable, /ROLE-CONTENT-LEAD/);
assert.match(reviewDecisionTable, /ROLE-CS-MANAGER/);
assert.match(reviewDecisionTable, /reviewer_subject_key_version/);
assert.match(reviewDecisionTable, /UNIQUE \(script_id, content_hash, reviewer_role\)/);
assert.match(finalizerFunction, /manager\.reviewer_subject_key_version = lead\.reviewer_subject_key_version/);
assert.match(finalizerFunction, /manager\.reviewer_subject_hash <> lead\.reviewer_subject_hash/);
assert.match(qualityPlanTable, /initial_sample_target/);
assert.match(qualityPlanTable, /expanded_sample_target/);
assert.match(qualityPlanTable, /population_manifest_hash/);
assert.match(qualityEvidenceTable, /publishable_clean_count/);
assert.match(qualityEvidenceTable, /review_quarantined_count/);
assert.match(qualityEvidenceTable, /import_batch_id\s+TEXT NOT NULL/);
assert.match(qualityEvidenceTable, /FOREIGN KEY \(plan_id, import_batch_id, population_manifest_hash\)/);
const populationHashFunction = sql.match(
  /CREATE OR REPLACE FUNCTION public\.content_quality_population_manifest_hash\([\s\S]*?\n\$\$;/,
)?.[0];
assert.ok(populationHashFunction, "quality population manifest helper missing");
for (const populationField of [
  "staging_id",
  "script_id",
  "content_hash",
  "risk_level",
  "has_conflict",
  "quality_status",
]) {
  assert.match(populationHashFunction, new RegExp(`'${populationField}'`));
}
assert.match(qualityPlanFunction, /p_ordinary_population_count <= 500/);
assert.match(qualityPlanFunction, /p_ordinary_population_count \* 0\.10/);
assert.match(qualityPlanFunction, /p_ordinary_population_count \* 0\.30/);
assert.match(qualityEvidenceFunction, /v_initial_rate <= 0\.02 OR v_initial_rate > 0\.05/);
assert.match(qualityEvidenceFunction, /30 percent expanded quality sample is required/);
assert.match(qualityEvidenceFunction, /QUALITY_THRESHOLD_MISMATCH/);
assert.match(qualityEvidenceFunction, /p_actor_capability IS DISTINCT FROM 'content_quality_reviewer'/);
assert.doesNotMatch(qualityEvidenceFunction, /lease_owner|lease_version|lease_expires_at|outbox_jobs/);
assert.match(publishFunction, /content_quality_review_plans[\s\S]*?content_quality_review_evidence[\s\S]*?evidence\.conclusion = 'passed'/);
assert.match(publishFunction, /content_quality_staging_population_manifest_hash\(p_import_batch_id\)/);
assert.match(finalizerFunction, /content_quality_population_manifest_hash\(p_staging_rows\)/);
assert.match(finalizerFunction, /content_quality_staging_population_manifest_hash\(p_import_batch_id\)/);
assert.match(finalizerFunction, /v_persisted_population_manifest_hash IS DISTINCT FROM v_population_manifest_hash/);
assert.match(finalizerFunction, /REVIEW_EVIDENCE_TRUST_BOUNDARY/);
for (const forbiddenWorkerAssertion of [
  "review_mode",
  "primary_reviewer_id",
  "secondary_reviewer_id",
  "quality_gate_passed",
]) {
  assert.match(finalizerFunction, new RegExp(`'${forbiddenWorkerAssertion}'`));
}

const dec042Acl = sql.match(/-- ─── Executable fail-closed ACL ───[\s\S]*?-- Read paths and ordinary event writes\./)?.[0];
assert.ok(dec042Acl, "DEC-042 function ownership block missing");
for (const helperName of [
  "content_text_array_is_nonblank_unique",
  "content_template_placeholders_are_valid",
  "content_scope_matches",
  "content_questions_are_valid",
  "jsonb_jcs",
  "content_utc_timestamp_text",
  "content_question_hash",
  "content_questions_align_intent",
  "content_risk_categories_are_valid",
  "content_quality_population_manifest_hash",
  "content_quality_staging_population_manifest_hash",
  "content_questions_source_assets_are_active",
  "content_public_questions",
  "content_governance_snapshot",
  "content_governance_hash",
  "content_quality_issue_codes_are_public",
]) {
  assert.match(dec042Acl, new RegExp(`ALTER FUNCTION public\\.${helperName}\\b`));
  assert.match(dec042Acl, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${helperName}\\b`));
}
const executableAcl = sql.match(/-- ─── Executable fail-closed ACL ───[\s\S]*?COMMENT ON SCHEMA public IS/)?.[0];
assert.ok(executableAcl, "complete executable ACL block missing");
assert.match(executableAcl, /ALTER FUNCTION public\.trg_query_lineage_guard\(\) OWNER TO cs_ai_definer/);
assert.match(executableAcl, /ALTER FUNCTION public\.trg_semantic_source_asset_guard\(\) OWNER TO cs_ai_definer/);
assert.match(executableAcl, /ALTER FUNCTION public\.retire_semantic_source_asset\(TEXT,TEXT,TEXT,TEXT,TEXT\) OWNER TO cs_ai_definer/);
assert.match(executableAcl, /ALTER FUNCTION public\.trg_source_gate_search_telemetry_guard\(\) OWNER TO cs_ai_definer/);
assert.match(executableAcl, /ALTER FUNCTION public\.search_recommendable_scripts\(TEXT,TEXT,TEXT\) OWNER TO cs_ai_definer/);
assert.match(executableAcl, /ALTER VIEW public\.v_release_source_gate OWNER TO cs_ai_definer/);
assert.match(executableAcl, /ALTER VIEW public\.v_scripts_recommendable OWNER TO cs_ai_definer/);
assert.match(executableAcl, /GRANT SELECT ON[\s\S]*?query_events, adoption_events,[\s\S]*?v_release_source_gate, v_scripts_recommendable[\s\S]*?TO cs_ai_definer/);
assert.match(executableAcl, /GRANT EXECUTE ON FUNCTION public\.record_content_review_decision\([\s\S]*?TO app_content_admin/);
assert.match(executableAcl, /GRANT EXECUTE ON FUNCTION public\.record_content_quality_review_evidence\([\s\S]*?TO app_content_admin/);
assert.match(executableAcl, /GRANT EXECUTE ON FUNCTION public\.freeze_content_quality_review_plan\([\s\S]*?TO app_import_worker/);
assert.match(executableAcl, /GRANT UPDATE \([\s\S]*?retired_at[\s\S]*?\) ON semantic_source_assets TO cs_ai_definer/);
assert.match(executableAcl, /GRANT EXECUTE ON FUNCTION public\.retire_semantic_source_asset\([^;]*\) TO app_content_admin/);
const workerGrants = executableAcl.match(
  /GRANT EXECUTE ON FUNCTION public\.claim_content_import_validation[\s\S]*?GRANT EXECUTE ON FUNCTION public\.finalize_content_import_validation[^;]*TO app_import_worker;/,
)?.[0];
assert.ok(workerGrants, "import worker execute allowlist missing");
assert.doesNotMatch(workerGrants, /record_content_review_decision|record_content_quality_review_evidence/);
assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*?intent_taxonomy_versions,[\s\S]*?intent_taxonomy_entries,[\s\S]*?intent_taxonomy_mappings[\s\S]*?FROM app_runtime/);

assert.match(openapi, /^\s*version: 1\.11\.0$/m);
assert.match(openapi, /product_context_type:[\s\S]*?enum: \[category, sku\]/);
assert.match(openapi, /product_context_ref:/);
assert.doesNotMatch(openapi, /\bsku_hint\b|\bsku_scope\b/);
assert.match(openapi, /QuestionSource:[\s\S]*?enum: \[manual, from_log, import\]/);
assert.match(openapi, /ContentQuestion:[\s\S]*?source:[\s\S]*?QuestionSource/);
const contentQuestionSchema = openapi.match(
  /\n    ContentQuestion:[\s\S]*?\n    SearchCandidate:/,
)?.[0];
const normalizedUpsertSchema = openapi.match(
  /\n    ContentImportUpsertRow:[\s\S]*?\n    ContentImportWithdrawRow:/,
)?.[0];
assert.ok(contentQuestionSchema && normalizedUpsertSchema, "DEC-042 OpenAPI schemas missing");
for (const requiredQuestionField of [
  "origin_fingerprint_key_version",
  "intent_taxonomy_version",
  "intent_id",
]) {
  assert.match(contentQuestionSchema, new RegExp(`- ${requiredQuestionField}\\b`));
}
assert.match(contentQuestionSchema, /title: from_log 获批晋级[\s\S]*?source_query_id: \{ type: string,[\s\S]*?promotion_review_ref: \{ type: string,[\s\S]*?promoted_by_role: \{ type: string,[\s\S]*?promoted_at:[\s\S]*?pattern: '[^']*Z\$'/);
assert.doesNotMatch(
  contentQuestionSchema.match(/title: from_log 获批晋级[\s\S]*?required:/)?.[0] ?? "",
  /type: \[[^\]]*'null'/,
);
assert.match(normalizedUpsertSchema, /questions_json:/);
assert.match(normalizedUpsertSchema, /questions_grams_text:/);
assert.match(normalizedUpsertSchema, /risk_categories:/);
assert.match(normalizedUpsertSchema, /quality_status:/);
assert.doesNotMatch(normalizedUpsertSchema, /review_mode:|primary_review_evd:|secondary_review_evd:|quality_gate_passed:/);
assert.match(openapi, /ContentQualityReviewSummary:[\s\S]*?mandatory_full_review_count:[\s\S]*?conclusion: \{ type: string, enum: \[passed, blocked\] \}/);
assert.match(openapi, /quality_review:[\s\S]*?ContentQualityReviewSummary/);
assert.match(openapi, /SnapshotItem:[\s\S]*?intent_taxonomy_version:[\s\S]*?questions:/);
assert.match(openapi, /SnapshotItem:[\s\S]*?risk_categories:[\s\S]*?RiskCategories/);
const publicSnapshotQuestionSchema = openapi.match(
  /\n    PublicSnapshotQuestion:[\s\S]*?\n    SnapshotItem:/,
)?.[0];
const snapshotItemSchema = openapi.match(
  /\n    SnapshotItem:[\s\S]*?\n    SnapshotResponse:/,
)?.[0];
const searchCandidateSchema = openapi.match(
  /\n    SearchCandidate:[\s\S]*?\n    TelemetryStatus:/,
)?.[0];
assert.ok(publicSnapshotQuestionSchema && snapshotItemSchema && searchCandidateSchema, "closed public wire schemas missing");
assert.match(
  publicSnapshotQuestionSchema,
  /required: \[question_id, question_version, question_text, question_hash, semantic_family_id\]/,
);
for (const forbiddenPublicQuestionField of [
  "origin_fingerprint",
  "origin_fingerprint_key_version",
  "source_asset_id",
  "source_query_id",
  "promotion_review_ref",
  "promoted_by_role",
  "promoted_at",
]) {
  assert.doesNotMatch(
    publicSnapshotQuestionSchema.match(/properties:[\s\S]*/)?.[0] ?? "",
    new RegExp(`^\\s+${forbiddenPublicQuestionField}:`, "m"),
  );
}
for (const forbiddenPublicItemField of [
  "source_version_id",
  "source_ref",
  "owner_role",
  "review_due_at",
  "review_mode",
  "primary_review_evd",
  "secondary_review_evd",
]) {
  assert.doesNotMatch(snapshotItemSchema, new RegExp(`^\\s+${forbiddenPublicItemField}:`, "m"));
  assert.doesNotMatch(searchCandidateSchema, new RegExp(`^\\s+${forbiddenPublicItemField}:`, "m"));
}
assert.match(openapi, /scopedSearchDbFunction: search_recommendable_scripts/);
assert.match(openapi, /normalImportWorkerMayAssertReviewDecision: false/);
assert.match(openapi, /normalImportWorkerMayAssertQualityConclusion: false/);
assert.doesNotMatch(openapi, /reviewer_subject_hash|primary_reviewer_id|secondary_reviewer_id/);
assert.doesNotMatch(openapi, /^\s{2}\/v1\/(?:training|train|reviews?|datasets?|teacher)(?:\/|:)/m);
assert.doesNotMatch(openapi, /^\s+placeholder_values:|^\s+rendered_answer:/m);
assert.doesNotMatch(openapi, /^\s{2}\/v1\/(?:sources|authoritative-sources)(?:\/|:)/m);
for (const reason of [
  "SOURCE_NOT_ELIGIBLE",
  "SOURCE_SUSPENDED",
  "SOURCE_DOMAIN_MISMATCH",
  "SOURCE_SNAPSHOT_MISMATCH",
  "SOURCE_SET_INCOMPLETE",
  "SOURCE_BASE_RELEASE_STALE",
  "SOURCE_BINDING_HASH_MISMATCH",
  "SOURCE_GATE_NOT_READY",
  "SOURCE_HISTORY_IMMUTABLE",
  "OFFLINE_LEASE_INVALID",
  "OFFLINE_LEASE_EXPIRED",
  "OFFLINE_LEASE_BINDING_MISMATCH",
]) {
  assert.match(sql, new RegExp(`\\b${reason}\\b`), `${reason} missing from SQL contract`);
  assert.match(openapi, new RegExp(`\\b${reason}\\b`), `${reason} missing from OpenAPI contract`);
}
for (const issueCode of [
  "SOURCE_NOT_REGISTERED",
  "SOURCE_NOT_CANONICAL",
  "SOURCE_SUSPENDED",
  "SOURCE_DOMAIN_MISMATCH",
  "SOURCE_SNAPSHOT_MISMATCH",
  "SOURCE_SET_INCOMPLETE",
]) {
  assert.match(sql, new RegExp(`"${issueCode}"|'${issueCode}'`));
  assert.match(openapi, new RegExp(`- ${issueCode}\\b`));
}
const fileImportSchema = openapi.match(/\n    FileImportRequest:[\s\S]*?\n    FeishuImportRequest:/)?.[0];
const feishuImportSchema = openapi.match(/\n    FeishuImportRequest:[\s\S]*?\n    ImportAcceptedResponse:/)?.[0];
assert.ok(fileImportSchema && feishuImportSchema, "content import request schemas missing");
assert.match(fileImportSchema, /required: \[file, source_bindings\]/);
assert.match(feishuImportSchema, /required: \[source_type, source_bindings\]/);
assert.match(fileImportSchema, /x-unique-by: domain/);
assert.match(feishuImportSchema, /x-unique-by: domain/);
assert.doesNotMatch(feishuImportSchema, /^\s+source_ref:/m);
assert.match(openapi, /transaction: independent-after-rollback/);
assert.match(openapi, /commitBeforeHttpResponse: true/);
assert.match(openapi, /coreStorageFunction: record_source_denial_audit/);
assert.match(openapi, /runtimeFunction: record_runtime_source_denial_audit/);
assert.match(openapi, /adminFunction: record_admin_source_denial_audit/);
assert.equal(
  (openapi.match(/function: record_runtime_source_denial_audit/g) ?? []).length,
  5,
  "runtime denial wrapper endpoint mapping drifted",
);
assert.equal(
  (openapi.match(/function: record_admin_source_denial_audit/g) ?? []).length,
  2,
  "admin denial wrapper endpoint mapping drifted",
);
assert.doesNotMatch(openapi, new RegExp("source_version_id" + "_hash"));
assert.match(openapi, /allowed-fields:[\s\S]*?- source_version_id[\s\S]*?- source_binding_hash/);
assert.match(openapi, /operationId: searchScripts[\s\S]*?x-source-denial-audit-required: true/);
assert.match(openapi, /\/v1\/announce\/ack:[\s\S]*?operation: announce_ack[\s\S]*?function: record_runtime_source_denial_audit[\s\S]*?x-source-denial-audit-required: true/);
assert.match(openapi, /source_binding_hash/);
assert.match(openapi, /source_version_id/);
assert.match(openapi, /x-search-telemetry-transaction:[\s\S]*?rollbackOn: \[SOURCE_GATE_NOT_READY\]/);
assert.match(openapi, /operationId: getCurrentAnnouncement[\s\S]*?503 `SOURCE_GATE_NOT_READY`/);
assert.match(openapi, /issueFunction: issue_snapshot_offline_lease/);
assert.match(openapi, /validateFunction: validate_snapshot_offline_lease/);
assert.match(openapi, /ackRenewsLease: false/);
assert.match(openapi, /required: \[current_release_id, release_seq, source_binding_hash, offline_lease, announcement\]/);
assert.match(openapi, /required: \[release_id, release_seq, source_binding_hash, offline_lease, items, next_cursor\]/);
assert.match(openapi, /required: \[client_id, release_id, release_seq, offline_lease_token\]/);
assert.match(openapi, /name: X-Snapshot-Lease[\s\S]*?required: true/);
assert.match(openapi, /ACK[\s\S]*?不得 UPDATE `snapshot_offline_leases`[\s\S]*?不得续期/);
assert.match(openapi, /reason: OFFLINE_LEASE_EXPIRED/);
assert.match(openapi, /never-write-reasons:[\s\S]*?- CONTENT_CONTRACT_INVALID[\s\S]*?- GOVERNANCE_HASH_MISMATCH[\s\S]*?- QUALITY_GATE_NOT_PASSED/);
assert.match(openapi, /source-denial-audits-write: required/);
assert.match(openapi, /x-source-denial-audit-required: true/);

// Mutation tests prove the guards reject concrete unsafe regressions, instead of only matching the
// current happy-path text. Keep mutations local and deterministic so a guard cannot pass vacuously.
const expectRejectedMutation = (name, original, mutated, predicate) => {
  assert.notEqual(mutated, original, `${name}: mutation fixture did not change the contract`);
  assert.equal(predicate(original), true, `${name}: current contract unexpectedly unsafe`);
  assert.equal(predicate(mutated), false, `${name}: unsafe mutation was not rejected`);
};

const hasFailClosedScopedSearch = (candidate) => {
  const reader = candidate.match(
    /CREATE OR REPLACE FUNCTION search_recommendable_scripts\([\s\S]*?\n\$\$;/,
  )?.[0];
  const runtimeGrant = candidate.match(
    /-- Read paths and ordinary event writes\.[\s\S]*?GRANT SELECT ON([\s\S]*?)TO app_runtime;/,
  )?.[1];
  return Boolean(
    reader &&
      /SECURITY DEFINER/.test(reader) &&
      /WHERE public\.content_scope_matches\(/.test(reader) &&
      runtimeGrant &&
      !/v_scripts_recommendable|v_release_source_gate/.test(runtimeGrant) &&
      /GRANT EXECUTE ON FUNCTION public\.search_recommendable_scripts\(TEXT,TEXT,TEXT\) TO app_runtime/.test(candidate),
  );
};
expectRejectedMutation(
  "scope predicate bypass",
  sql,
  sql.replace(
    "WHERE public.content_scope_matches(",
    "WHERE TRUE OR public.content_scope_matches(",
  ),
  hasFailClosedScopedSearch,
);
expectRejectedMutation(
  "runtime backing-view grant",
  sql,
  sql.replace(
    "  client_sync_state, policy_flags\nTO app_runtime;",
    "  client_sync_state, policy_flags, v_scripts_recommendable\nTO app_runtime;",
  ),
  hasFailClosedScopedSearch,
);

const hasImmutableQuestionHistory = (candidate) => {
  const publish = candidate.match(
    /CREATE OR REPLACE FUNCTION publish_content_release\([\s\S]*?\n\$\$;/,
  )?.[0];
  const projection = publish?.match(
    /INSERT INTO public\.script_questions[\s\S]*?ON CONFLICT \(question_id, question_version\)[^;]*;/,
  )?.[0];
  return Boolean(
    /PRIMARY KEY \(question_id, question_version\)/.test(candidate) &&
      projection &&
      /ON CONFLICT \(question_id, question_version\) DO NOTHING;/.test(projection) &&
      !/DO UPDATE/.test(projection),
  );
};
expectRejectedMutation(
  "question history overwrite",
  sql,
  sql.replace(
    "ON CONFLICT (question_id, question_version) DO NOTHING;",
    "ON CONFLICT (question_id, question_version) DO UPDATE SET question_text = EXCLUDED.question_text;",
  ),
  hasImmutableQuestionHistory,
);

const hasExclusiveEffectiveUpperBound = (candidate) =>
  /WHERE ri\.effective_from <= now\(\)[\s\S]*?now\(\) < ri\.effective_to/.test(candidate) &&
  !/now\(\) <= ri\.effective_to|ri\.effective_to >= now\(\)/.test(candidate);
expectRejectedMutation(
  "inclusive effective_to",
  sql,
  sql.replace("now() < ri.effective_to", "now() <= ri.effective_to"),
  hasExclusiveEffectiveUpperBound,
);

const hasWorkerEvidenceTrustBoundary = (candidate) => {
  const finalizer = candidate.match(
    /CREATE OR REPLACE FUNCTION finalize_content_import_validation\([\s\S]*?\n\$\$;/,
  )?.[0];
  const trustGuard = finalizer?.match(
    /IF EXISTS \([\s\S]*?REVIEW_EVIDENCE_TRUST_BOUNDARY';/,
  )?.[0];
  return Boolean(
    trustGuard &&
      ["review_mode", "primary_reviewer_id", "secondary_reviewer_id", "quality_gate_passed"]
        .every((field) => trustGuard.includes(`'${field}'`)) &&
      !/GRANT EXECUTE ON FUNCTION public\.record_content_review_decision\([^;]*\) TO app_import_worker;/.test(candidate) &&
      !/GRANT EXECUTE ON FUNCTION public\.record_content_quality_review_evidence\([^;]*\) TO app_import_worker;/.test(candidate),
  );
};
expectRejectedMutation(
  "worker quality assertion",
  sql,
  sql.replace("      'quality_gate_passed'\n", ""),
  hasWorkerEvidenceTrustBoundary,
);

const hasIndependentDualReview = (candidate) => {
  const finalizer = candidate.match(
    /CREATE OR REPLACE FUNCTION finalize_content_import_validation\([\s\S]*?\n\$\$;/,
  )?.[0];
  return Boolean(
    /ROLE-CONTENT-LEAD/.test(candidate) &&
      /ROLE-CS-MANAGER/.test(candidate) &&
      finalizer &&
      /manager\.reviewer_subject_key_version = lead\.reviewer_subject_key_version/.test(finalizer) &&
      /manager\.reviewer_subject_hash <> lead\.reviewer_subject_hash/.test(finalizer),
  );
};
expectRejectedMutation(
  "same reviewer dual approval",
  sql,
  sql.replace(
    "manager.reviewer_subject_hash <> lead.reviewer_subject_hash",
    "manager.reviewer_subject_hash = lead.reviewer_subject_hash",
  ),
  hasIndependentDualReview,
);

const hasFrozenQualityThresholds = (candidate) =>
  /CREATE TABLE IF NOT EXISTS content_quality_review_plans/.test(candidate) &&
  /CREATE TABLE IF NOT EXISTS content_quality_review_evidence/.test(candidate) &&
  /p_ordinary_population_count \* 0\.10/.test(candidate) &&
  /p_ordinary_population_count \* 0\.30/.test(candidate) &&
  /v_initial_rate > 0\.05/.test(candidate) &&
  /QUALITY_THRESHOLD_MISMATCH/.test(candidate);
expectRejectedMutation(
  "quality block threshold drift",
  sql,
  sql.replaceAll("v_initial_rate > 0.05", "v_initial_rate > 0.50"),
  hasFrozenQualityThresholds,
);

const hasNonNullFromLogEvidence = (candidate) => {
  const questionSchema = candidate.match(
    /\n    ContentQuestion:[\s\S]*?\n    SearchCandidate:/,
  )?.[0];
  const fromLog = questionSchema?.match(
    /title: from_log 获批晋级[\s\S]*?required: \[source_query_id, promotion_review_ref, promoted_by_role, promoted_at\]/,
  )?.[0];
  return Boolean(
    fromLog &&
      /source_query_id: \{ type: string,/.test(fromLog) &&
      /promotion_review_ref: \{ type: string,/.test(fromLog) &&
      /promoted_by_role: \{ type: string,/.test(fromLog) &&
      /pattern: '[^']*Z\$'/.test(fromLog) &&
      !/type: \[[^\]]*'null'/.test(fromLog),
  );
};
expectRejectedMutation(
  "nullable from_log evidence",
  openapi,
  openapi.replace(
    "source_query_id: { type: string, minLength: 1 }",
    "source_query_id: { type: [string, 'null'], minLength: 1 }",
  ),
  hasNonNullFromLogEvidence,
);

const hasUtcCanonicalHashTimestamps = (candidate) =>
  /CREATE OR REPLACE FUNCTION public\.content_utc_timestamp_text/.test(candidate) &&
  /AT TIME ZONE 'UTC'/.test(candidate) &&
  /'effective_from', public\.content_utc_timestamp_text\(p_effective_from\)/.test(candidate);
expectRejectedMutation(
  "session-timezone hash drift",
  sql,
  sql.replace("p_value AT TIME ZONE 'UTC'", "p_value::timestamp"),
  hasUtcCanonicalHashTimestamps,
);

const hasCompleteQuestionIdentityHash = (candidate) => {
  const hashFunction = candidate.match(
    /CREATE OR REPLACE FUNCTION public\.content_question_hash\([\s\S]*?\n\$\$;/,
  )?.[0];
  const publish = candidate.match(
    /CREATE OR REPLACE FUNCTION publish_content_release\([\s\S]*?\n\$\$;/,
  )?.[0];
  return Boolean(
    hashFunction &&
      /'promoted_by_role', p_question ->> 'promoted_by_role'/.test(hashFunction) &&
      publish &&
      /existing\.promoted_by_role IS DISTINCT FROM question\.value ->> 'promoted_by_role'/.test(publish),
  );
};
expectRejectedMutation(
  "promoted role omitted from question identity",
  sql,
  sql.replace("      'promoted_by_role', p_question ->> 'promoted_by_role',\n", ""),
  hasCompleteQuestionIdentityHash,
);

const hasFixedAsciiJcsSubset = (candidate) => {
  const helper = candidate.match(
    /CREATE OR REPLACE FUNCTION public\.jsonb_jcs\([\s\S]*?\n\$\$;/,
  )?.[0];
  return Boolean(
    helper &&
      /ORDER BY member\.key COLLATE "C"/.test(helper) &&
      /octet_length\(member\.key\) <> pg_catalog\.length\(member\.key\)/.test(helper) &&
      /DEC042_JCS_SUBSET_INVALID/.test(helper) &&
      /NOT a general Unicode RFC 8785/.test(candidate),
  );
};
expectRejectedMutation(
  "locale-dependent JCS member order",
  sql,
  sql.replace('ORDER BY member.key COLLATE "C"', "ORDER BY member.key"),
  hasFixedAsciiJcsSubset,
);

const hasUpgradeSafeImportErrorShape = (candidate) => {
  const replacement = candidate.match(
    /ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batch_error_report_shape;[\s\S]*?ADD CONSTRAINT import_batch_error_report_shape CHECK/,
  )?.[0];
  return Boolean(
    replacement &&
      /CONTENT_CONTRACT_INVALID/.test(candidate) &&
      /GOVERNANCE_HASH_MISMATCH/.test(candidate),
  );
};
expectRejectedMutation(
  "legacy import error constraint retained",
  sql,
  sql.replace(
    "ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batch_error_report_shape;",
    "-- unsafe: legacy import_batch_error_report_shape retained",
  ),
  hasUpgradeSafeImportErrorShape,
);

const hasPopulationIdentityClosure = (candidate) => {
  const helper = candidate.match(
    /CREATE OR REPLACE FUNCTION public\.content_quality_population_manifest_hash\([\s\S]*?\n\$\$;/,
  )?.[0];
  const finalizer = candidate.match(
    /CREATE OR REPLACE FUNCTION finalize_content_import_validation\([\s\S]*?\n\$\$;/,
  )?.[0];
  return Boolean(
    helper &&
      /'script_id', row_item\.value ->> 'script_id'/.test(helper) &&
      /'content_hash', row_item\.value ->> 'content_hash'/.test(helper) &&
      /'risk_level', row_item\.value ->> 'risk_level'/.test(helper) &&
      /'has_conflict', row_item\.value -> 'has_conflict'/.test(helper) &&
      /'quality_status', row_item\.value ->> 'quality_status'/.test(helper) &&
      finalizer &&
      /content_quality_population_manifest_hash\(p_staging_rows\)/.test(finalizer) &&
      /content_quality_staging_population_manifest_hash\(p_import_batch_id\)/.test(finalizer) &&
      /v_persisted_population_manifest_hash IS DISTINCT FROM v_population_manifest_hash/.test(finalizer),
  );
};
expectRejectedMutation(
  "equal-count quality population substitution",
  sql,
  sql.replace("        'content_hash', row_item.value ->> 'content_hash',\n", ""),
  hasPopulationIdentityClosure,
);

const hasIrreversibleSemanticRetirement = (candidate) => {
  const guard = candidate.match(
    /CREATE OR REPLACE FUNCTION trg_semantic_source_asset_guard\(\)[\s\S]*?\n\$\$;/,
  )?.[0];
  const retire = candidate.match(
    /CREATE OR REPLACE FUNCTION retire_semantic_source_asset\([\s\S]*?\n\$\$;/,
  )?.[0];
  return Boolean(
    guard &&
      /OLD\.lifecycle IS DISTINCT FROM 'active'/.test(guard) &&
      /NEW\.lifecycle IS DISTINCT FROM 'retired'/.test(guard) &&
      /TG_OP = 'DELETE'/.test(guard) &&
      retire &&
      /SET lifecycle = 'retired',[\s\S]*?source_query_id = NULL/.test(retire),
  );
};
expectRejectedMutation(
  "retired semantic asset resurrection",
  sql,
  sql.replace(
    "OR NEW.lifecycle IS DISTINCT FROM 'retired'",
    "OR NEW.lifecycle IS DISTINCT FROM 'active'",
  ),
  hasIrreversibleSemanticRetirement,
);

const hasClosedSnapshotQuestionProjection = (candidate) => {
  const reader = candidate.match(
    /CREATE OR REPLACE FUNCTION read_snapshot_page\([\s\S]*?\n\$\$;/,
  )?.[0];
  return Boolean(
    reader &&
      /'questions', public\.content_public_questions\(page\.questions_json\)/.test(reader) &&
      !/'questions', page\.questions_json/.test(reader),
  );
};
expectRejectedMutation(
  "raw snapshot questions leak",
  sql,
  sql.replace(
    "'questions', public.content_public_questions(page.questions_json)",
    "'questions', page.questions_json",
  ),
  hasClosedSnapshotQuestionProjection,
);

const hasExplicitSearchProjection = (candidate) => {
  const reader = candidate.match(
    /CREATE OR REPLACE FUNCTION search_recommendable_scripts\([\s\S]*?\n\$\$;/,
  )?.[0];
  return Boolean(
    reader &&
      /RETURNS TABLE\(/.test(reader) &&
      !/RETURNS SETOF|candidate\.\*/.test(reader) &&
      !/candidate\.(?:primary_reviewer_id|secondary_reviewer_id)/.test(reader) &&
      /public\.content_public_questions\(candidate\.questions_json\)/.test(reader) &&
      /candidate\.search_document/.test(reader) &&
      /candidate\.search_fallback_text/.test(reader),
  );
};
expectRejectedMutation(
  "search backing row spread",
  sql,
  sql.replace("    candidate.script_id,\n", "    candidate.*,\n"),
  hasExplicitSearchProjection,
);

const hasControlledRuntimeImportReads = (candidate) => {
  const grant = candidate.match(
    /-- Read paths and ordinary event writes\.[\s\S]*?GRANT SELECT ON([\s\S]*?)TO app_runtime;/,
  )?.[1];
  return Boolean(
    grant &&
      !/(?:^|[,\s])(?:import_batches|staging_scripts|import_batch_source_bindings)(?:[,\s]|$)/.test(grant) &&
      /read_content_import_status\(TEXT,TEXT,TEXT\) TO app_runtime/.test(candidate) &&
      /read_content_import_preview\(TEXT,TEXT,TEXT,TEXT,INTEGER\) TO app_runtime/.test(candidate),
  );
};
expectRejectedMutation(
  "runtime raw import table read",
  sql,
  sql.replace(
    "  client_sync_state, policy_flags\nTO app_runtime;",
    "  client_sync_state, policy_flags, import_batches\nTO app_runtime;",
  ),
  hasControlledRuntimeImportReads,
);

const hasWorkloadBoundDenialAudit = (candidate) =>
  /record_runtime_source_denial_audit\([\s\S]*?p_operation NOT IN \('content_import','search','announce_current','announce_snapshot','announce_ack'\)/.test(candidate) &&
  /record_admin_source_denial_audit\([\s\S]*?p_operation NOT IN \('content_publish','content_rollback','source_suspend'\)/.test(candidate) &&
  !/GRANT EXECUTE ON FUNCTION public\.record_source_denial_audit\([^;]*TO app_/.test(candidate);
expectRejectedMutation(
  "runtime claims publish denial",
  sql,
  sql.replace(
    "('content_import','search','announce_current','announce_snapshot','announce_ack')",
    "('content_import','content_publish','search','announce_current','announce_snapshot','announce_ack')",
  ),
  hasWorkloadBoundDenialAudit,
);

const hasCompleteImmutableSnapshotReader = (candidate) => {
  const reader = candidate.match(
    /CREATE OR REPLACE FUNCTION read_snapshot_page\([\s\S]*?\n\$\$;/,
  )?.[0];
  return Boolean(
    reader &&
      /JOIN public\.release_items ri ON ri\.release_id = authorized\.release_id/.test(reader) &&
      !/ri\.effective_from <= now\(\)|now\(\) < ri\.effective_to/.test(reader),
  );
};
expectRejectedMutation(
  "server filters immutable snapshot by current time",
  sql,
  sql.replace(
    "WHERE p_cursor IS NULL OR ri.script_id > p_cursor",
    "WHERE (p_cursor IS NULL OR ri.script_id > p_cursor) AND ri.effective_from <= now()",
  ),
  hasCompleteImmutableSnapshotReader,
);

const hasRawContentQuestionTypes = (candidate) => {
  const validators = [
    ...candidate.matchAll(/CREATE OR REPLACE FUNCTION public\.content_questions_are_valid\([\s\S]*?\n\$\$;/g),
  ];
  const validator = validators.at(-1)?.[0];
  return Boolean(
    validator &&
      /jsonb_typeof\(question\.value -> 'question_version'\) IS DISTINCT FROM 'number'/.test(validator) &&
      /jsonb_typeof\(question\.value -> 'question_id'\) IS DISTINCT FROM 'string'/.test(validator) &&
      /jsonb_typeof\(question\.value -> 'source_query_id'\) NOT IN \('string','null'\)/.test(validator),
  );
};
expectRejectedMutation(
  "ContentQuestion numeric string coercion",
  sql,
  sql.replace(
    "         OR pg_catalog.jsonb_typeof(question.value -> 'question_version') IS DISTINCT FROM 'number'\n",
    "",
  ),
  hasRawContentQuestionTypes,
);

console.log(
  JSON.stringify({
    ok: true,
    parser: "@libpg-query/parser@17.6.10",
    schema: "business-docs/01-客服Agent项目/20-设计-进行中/33-schema-v1-草案.sql",
    sqlStatements: parsedSql.stmts.length,
    functionBodies: parsedFunctions.plpgsql_funcs.length,
    apiVersion: "1.11.0",
    dec042NegativeGuards: 20,
  }),
);
