import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { buildOwnerContractFiles, OWNER_CONTRACT_PATHS, OWNER_SQL_SOURCES } from '../../business-docs/08-工具/build_customer_agent_owner_contract.mjs';

const read = (source) => readFileSync(new URL(`../../${source}`, import.meta.url));
const generated = buildOwnerContractFiles(read);
const parser = createRequire(import.meta.url)('@libpg-query/parser');
await parser.loadModule();

test('integrated DDL is deterministic, complete, and parses as SQL and PL/pgSQL', () => {
  for (const key of ['database', 'openapi']) assert.ok(read(OWNER_CONTRACT_PATHS[key]).equals(generated[key]), `${key} drift`);
  const sql = generated.database.toString();
  for (const source of OWNER_SQL_SOURCES) assert.ok(sql.includes(read(source).toString()), source);
  assert.ok(parser.parseSync(sql).stmts.length > 513);
  assert.ok(parser.parsePlPgSQLSync(sql).plpgsql_funcs.length > 89);
});

test('integrated API preserves HTTP paths and self-contained record validation', () => {
  const api = generated.openapi.toString();
  const old = read('business-docs/01-客服Agent项目/20-设计-进行中/openapi.v1.yaml').toString();
  assert.equal(api.slice(api.indexOf('\npaths:'), api.indexOf('\ncomponents:')),
    old.slice(old.indexOf('\npaths:'), old.indexOf('\ncomponents:')));
  const inlined = JSON.parse(api.match(/^    OwnerAcceptanceRecord: (.+)$/m)[1]);
  assert.doesNotMatch(JSON.stringify(inlined), /\$ref|\$defs/);
  const canonical = JSON.parse(read('business-docs/01-客服Agent项目/30-开发-进行中/owner-acceptance.v1.schema.json'));
  const ajv = new Ajv2020({ strict: false });
  const original = ajv.compile(canonical), exported = ajv.compile(inlined);
  const source = (domain) => ({ domain, source_version_id: `srcv_synthetic_${domain}`,
    snapshot_sha256: 'a'.repeat(64), review_due_at: '2026-09-07T00:00:00.000Z' });
  const record = { schema: 'customer-agent/owner-acceptance/v1', review_mode: 'owner_acceptance',
    purpose: 'g1a_offline_only', owner_subject_hash: 'b'.repeat(64), approval_evidence_id: 'EVD-SYNTHETIC-001',
    accepted_at: '2026-09-06T00:00:00.000Z', expires_at: '2026-09-07T00:00:00.000Z',
    scope: { source_bindings: ['aftersale','campaign','presale','product'].map(source), items: [
      { script_id: 'synthetic_script_001', script_version: 1, domain: 'product', source_version_id: 'srcv_synthetic_product',
        review_input_sha256: 'c'.repeat(64), risk_level: 'low', risk_categories: [], has_conflict: false },
    ] } };
  assert.equal(original(record), true, JSON.stringify(original.errors));
  assert.equal(exported(record), true, JSON.stringify(exported.errors));
  for (const mutate of [
    (value) => { value.unexpected = true; },
    (value) => { value.purpose = 'runtime'; },
    (value) => { value.scope.items[0].script_version = 2147483648; },
    (value) => { value.scope.items[0].has_conflict = true; },
    (value) => { value.scope.source_bindings.pop(); },
  ]) {
    const invalid = structuredClone(record); mutate(invalid);
    assert.equal(original(invalid), false); assert.equal(exported(invalid), false);
  }
  const extension = JSON.parse(api.match(/^x-owner-acceptance-registry: (.+)$/m)[1]);
  assert.equal(extension.runtimeActivated, false);
  assert.deepEqual(extension.publicHttpRoutes, []);
  assert.equal(extension.purpose, 'g1a_offline_only');
});
