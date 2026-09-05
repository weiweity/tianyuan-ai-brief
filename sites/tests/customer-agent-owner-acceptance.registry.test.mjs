import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const parser = createRequire(import.meta.url)('@libpg-query/parser');
const root = new URL('../../business-docs/01-客服Agent项目/', import.meta.url);
const sql = await readFile(new URL('30-开发-进行中/owner-acceptance.registry.v1.sql', root), 'utf8');
const schema = JSON.parse(await readFile(new URL('30-开发-进行中/owner-acceptance.v1.schema.json', root), 'utf8'));
const api = await readFile(new URL('20-设计-进行中/openapi.v1.yaml', root), 'utf8');
const apiExtension = JSON.parse(await readFile(new URL('30-开发-进行中/owner-acceptance.registry.v1.openapi-extension.json', root), 'utf8'));
await parser.loadModule();

test('candidate SQL grammar and PL/pgSQL bodies parse without modifying frozen v1.14', () => {
  const statements = parser.parseSync(sql); const functions = parser.parsePlPgSQLSync(sql);
  assert.ok(statements.stmts.length > 30);
  assert.equal(functions.plpgsql_funcs.length, 10); // nine functions plus install DO block
  assert.doesNotMatch(sql, /ALTER TABLE (?:public\.)?(?:scripts|staging_scripts|release_items)\b/);
  assert.doesNotMatch(sql, /CREATE (?:OR REPLACE )?(?:VIEW|FUNCTION) (?:public\.)?(?:publish_content_release|rollback_content_release|search_recommendable_scripts|v_release_source_gate)\b/);
});
test('schema domains, risk categories and closed object keys are represented in DB validation', () => {
  for (const value of [...schema.$defs.domain.enum, ...schema.$defs.item.properties.risk_categories.items.enum]) assert.ok(sql.includes(`'${value}'`));
  for (const shape of [schema, schema.$defs.scope, schema.$defs.item, schema.$defs.sourceBinding]) {
    assert.equal(shape.additionalProperties, false);
    for (const key of shape.required) assert.ok(sql.includes(`'${key}'`), key);
  }
  assert.match(sql, /octet_length\(p_raw_record\) > 2097152/);
  assert.match(sql, /NOT BETWEEN 1 AND 5000/);
  assert.match(sql, /public\.jsonb_jcs\(v_record\) \|\| E'\\n' <> p_raw_record/);
});
test('record and revocation are immutable, tenant-bound and have no app data-plane grant', () => {
  assert.equal((sql.match(/BEFORE UPDATE OR DELETE OR TRUNCATE/g) ?? []).length, 2);
  assert.equal((sql.match(/PRIMARY KEY \(tenant_id, record_sha256\)/g) ?? []).length, 2);
  assert.match(sql, /CREATE ROLE app_owner_acceptance_registrar NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  assert.doesNotMatch(sql, /GRANT .* TO (?:app_runtime|app_import_worker|app_content_admin|app_work_order_worker);/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.register_owner_acceptance\(TEXT,TEXT,TEXT,TEXT\),\s+public\.revoke_owner_acceptance\(TEXT,TEXT,TEXT\) TO app_owner_acceptance_registrar;/);
});
test('source and revocation fence are transaction-scoped and cannot be self-asserted by payload', () => {
  assert.equal((sql.match(/pg_advisory_xact_lock_shared\(hashtext\('cs_ai_content_publish'\)\)/g) ?? []).length, 2);
  assert.match(sql, /pg_advisory_xact_lock_shared\(hashtextextended\(p_tenant \|\| ':' \|\| p_sha256, 0\)\)/);
  assert.match(sql, /s\.tenant_id = p_tenant/);
  assert.match(sql, /s\.snapshot_sha256 = b ->> 'snapshot_sha256'/);
  assert.match(sql, /authoritative_source_suspensions/);
  assert.match(sql, /v_record -> 'scope' IS DISTINCT FROM p_observed_scope/);
  assert.match(sql, /OWNER_ACCEPTANCE_REVOCATION_CONFLICT/);
});
test('OpenAPI extension is an unapplied candidate; no new route or public review mode', () => {
  assert.deepEqual(Object.keys(apiExtension), ['x-owner-acceptance-registry-candidate']);
  const contract = apiExtension['x-owner-acceptance-registry-candidate'];
  assert.equal(contract.status, 'LOCAL_CANDIDATE_NOT_ACTIVATED');
  assert.equal(contract.recordSchema, schema.properties.schema.const);
  assert.deepEqual(contract.publicHttpRoutes, []);
  assert.equal(contract.runtimeActivated, false); assert.equal(contract.changesExistingReviewMode, false);
  assert.equal(contract.transactionIsolation, 'read committed');
  for (const name of ['registerFunction','revokeFunction','internalAssertionFunction','reviewInputHashFunction']) {
    assert.ok(sql.includes(`CREATE FUNCTION public.${contract[name]}(`));
  }
  assert.equal(api.includes('x-owner-acceptance-registry-candidate'), false);
  assert.match(api, /ReviewMode:\n\s+type: string\n\s+enum: \[single, dual\]/);
});

test('final hash candidate is additive, parseable and does not replace legacy governance semantics', async () => {
  const hashSql = await readFile(new URL('30-开发-进行中/owner-acceptance.content-hash.v1.sql', root), 'utf8');
  assert.ok(parser.parseSync(hashSql).stmts.length > 0);
  assert.equal(parser.parsePlPgSQLSync(hashSql).plpgsql_funcs.length, 1);
  assert.doesNotMatch(hashSql, /CREATE OR REPLACE|ALTER TABLE|GRANT EXECUTE/);
  assert.match(hashSql, /IMMUTABLE SECURITY INVOKER/);
  assert.match(hashSql, /REVOKE ALL ON FUNCTION public\.owner_acceptance_content_hash\(JSONB,INTEGER,TEXT\) FROM PUBLIC/);
});

test('content scope candidate parses as a private definer without replacing runtime gates', async () => {
  const scopeSql = await readFile(new URL('30-开发-进行中/owner-acceptance.content-scope.v1.sql', root), 'utf8');
  assert.ok(parser.parseSync(scopeSql).stmts.length > 0);
  assert.equal(parser.parsePlPgSQLSync(scopeSql).plpgsql_funcs.length, 1);
  assert.doesNotMatch(scopeSql, /CREATE OR REPLACE|ALTER TABLE|GRANT EXECUTE/);
  assert.match(scopeSql, /SECURITY DEFINER/);
  assert.match(scopeSql, /REVOKE ALL ON FUNCTION public\.assert_owner_acceptance_content\(TEXT,TEXT,TEXT,TEXT\[\],JSONB\) FROM PUBLIC/);
});
