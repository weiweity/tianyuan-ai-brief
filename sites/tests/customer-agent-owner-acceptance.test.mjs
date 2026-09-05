import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { verifyOwnerAcceptance } from '../scripts/customer-agent-owner-acceptance.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const encode = (value) => `${stable(value)}\n`;

function fixture() {
  const source_bindings = ['aftersale', 'campaign', 'presale', 'product'].map((domain) => ({
    domain, source_version_id: `srcv_synthetic_${domain}`, snapshot_sha256: hash(`synthetic-${domain}`),
    review_due_at: '2026-09-30T00:00:00.000Z',
  }));
  const items = source_bindings.map((binding) => ({
    script_id: `synthetic_${binding.domain}`, script_version: 2, domain: binding.domain,
    source_version_id: binding.source_version_id, review_input_sha256: hash(`input-${binding.domain}`),
    risk_level: binding.domain === 'campaign' ? 'high' : 'medium',
    risk_categories: binding.domain === 'campaign' ? ['campaign_rules'] : [], has_conflict: false,
  }));
  return {
    schema: 'customer-agent/owner-acceptance/v1', review_mode: 'owner_acceptance', purpose: 'g1a_offline_only',
    owner_subject_hash: hash('synthetic-owner'), approval_evidence_id: 'EVD-SYNTHETIC-OWNER-ONLY',
    accepted_at: '2026-09-05T00:00:00.000Z', expires_at: '2026-09-06T00:00:00.000Z',
    scope: { source_bindings, items },
  };
}
function options(record, overrides = {}) {
  return {
    approvedRecordSha256: hash(encode(record)), expectedOwnerSubjectHash: hash('synthetic-owner'),
    observedScope: structuredClone(record.scope), now: new Date('2026-09-05T12:00:00.000Z'), ...overrides,
  };
}
function rejects(record, code, overrides = {}) {
  assert.throws(() => verifyOwnerAcceptance(encode(record), options(record, overrides)), { message: code });
}

test('one owner binds four domains without fabricating a secondary reviewer or activating runtime', () => {
  const record = fixture(); const context = options(record); const before = structuredClone({ record, context });
  const result = verifyOwnerAcceptance(encode(record), context);
  assert.equal(result.status, 'OWNER_ACCEPTANCE_METADATA_VALID');
  assert.equal(result.runtime_activated, false);
  assert.equal(result.review_mode, 'owner_acceptance');
  assert.ok(Object.isFrozen(result));
  assert.deepEqual({ record, context }, before);
  assert.equal(JSON.stringify(result).includes('secondary'), false);
});

for (const key of ['approvedRecordSha256', 'expectedOwnerSubjectHash', 'now']) {
  test(`missing trusted ${key} refuses rather than deriving it from the record`, () => {
    rejects(fixture(), 'OWNER_ACCEPTANCE_TRUST_CONTEXT_REQUIRED', { [key]: undefined });
  });
}
test('invalid trusted clock and malformed trust hashes are refused', () => {
  rejects(fixture(), 'OWNER_ACCEPTANCE_TRUST_CONTEXT_REQUIRED', { now: new Date('bad') });
  rejects(fixture(), 'OWNER_ACCEPTANCE_TRUST_CONTEXT_REQUIRED', { approvedRecordSha256: 'short' });
});
test('changed approved bytes cannot reuse the external anchor', () => {
  rejects(fixture(), 'OWNER_ACCEPTANCE_ANCHOR_MISMATCH', { approvedRecordSha256: hash('different') });
});
test('a different owner cannot reuse approval metadata', () => {
  rejects(fixture(), 'OWNER_ACCEPTANCE_OWNER_MISMATCH', { expectedOwnerSubjectHash: hash('another-owner') });
});
for (const [label, mutate] of [
  ['unknown schema', (r) => { r.schema += '-unknown'; }],
  ['runtime purpose', (r) => { r.purpose = 'production'; }],
  ['pretend dual approval', (r) => { r.review_mode = 'dual'; }],
  ['second reviewer even null', (r) => { r.secondary_reviewer_id = null; }],
  ['embedded business text', (r) => { r.answer_text = 'synthetic forbidden field'; }],
  ['unresolved conflict', (r) => { r.scope.items[0].has_conflict = true; }],
  ['unknown risk category', (r) => { r.scope.items[1].risk_categories = ['unknown']; }],
  ['duplicate risk categories', (r) => { r.scope.items[1].risk_categories = ['campaign_rules', 'campaign_rules']; }],
  ['empty items', (r) => { r.scope.items = []; }],
  ['missing source domain', (r) => { r.scope.source_bindings.pop(); }],
]) {
  test(`${label} fails closed`, () => { const r = fixture(); mutate(r); rejects(r, 'OWNER_ACCEPTANCE_RECORD_INVALID'); });
}
for (const [label, mutate] of [
  ['repeated domain', (r) => { r.scope.source_bindings[1] = structuredClone(r.scope.source_bindings[0]); }],
  ['repeated source version', (r) => { r.scope.source_bindings[1].source_version_id = r.scope.source_bindings[0].source_version_id; }],
  ['wrong item domain binding', (r) => { r.scope.items[0].source_version_id = r.scope.source_bindings[1].source_version_id; }],
  ['duplicate script identity', (r) => { r.scope.items[1].script_id = r.scope.items[0].script_id; }],
  ['unordered source domains', (r) => { r.scope.source_bindings.reverse(); }],
  ['unordered items', (r) => { r.scope.items.reverse(); }],
]) {
  test(`${label} is not silently repaired`, () => { const r = fixture(); mutate(r); rejects(r, 'OWNER_ACCEPTANCE_SCOPE_INVALID'); });
}
test('risk labels cannot be cleared or downgraded to fit approval', () => {
  const r = fixture(); r.scope.items[1].risk_level = 'medium'; rejects(r, 'OWNER_ACCEPTANCE_RISK_INVALID');
  r.scope.items[1].risk_level = 'high'; r.scope.items[1].risk_categories = []; rejects(r, 'OWNER_ACCEPTANCE_RISK_INVALID');
});
test('risk categories must be ordered, while an explicitly bound low-risk item stays valid', () => {
  const r = fixture(); r.scope.items[0].risk_level = 'low';
  r.scope.items[1].risk_categories = ['campaign_rules', 'price_discount'];
  assert.equal(verifyOwnerAcceptance(encode(r), options(r)).status, 'OWNER_ACCEPTANCE_METADATA_VALID');
  r.scope.items[1].risk_categories.reverse(); rejects(r, 'OWNER_ACCEPTANCE_SCOPE_INVALID');
});
test('trusted acceptance boundary is inclusive, with an explicit host clock', () => {
  const r = fixture();
  assert.equal(verifyOwnerAcceptance(encode(r), options(r, { now: new Date(r.accepted_at) })).runtime_activated, false);
  assert.throws(() => verifyOwnerAcceptance(encode(r)), { message: 'OWNER_ACCEPTANCE_TRUST_CONTEXT_REQUIRED' });
});
test('bounded metadata supports 5000 synthetic identities and refuses 5001', () => {
  const r = fixture(); const item = r.scope.items[0];
  r.scope.items = Array.from({ length: 5000 }, (_, index) => ({ ...item, script_id: `synthetic_${String(index).padStart(6, '0')}` }));
  assert.equal(verifyOwnerAcceptance(encode(r), options(r)).status, 'OWNER_ACCEPTANCE_METADATA_VALID');
  r.scope.items.push({ ...item, script_id: 'synthetic_999999' });
  rejects(r, 'OWNER_ACCEPTANCE_RECORD_INVALID');
});
for (const [label, mutate] of [
  ['changed source snapshot', (s) => { s.source_bindings[0].snapshot_sha256 = hash('changed'); }],
  ['changed content digest', (s) => { s.items[0].review_input_sha256 = hash('changed'); }],
  ['changed script version', (s) => { s.items[0].script_version += 1; }],
  ['dropped item', (s) => { s.items.pop(); }],
  ['risk downshift with cleared labels', (s) => { s.items[1].risk_level = 'medium'; s.items[1].risk_categories = []; }],
]) {
  test(`${label} in actual candidate cannot borrow this record`, () => {
    const r = fixture(); const observedScope = structuredClone(r.scope); mutate(observedScope);
    rejects(r, 'OWNER_ACCEPTANCE_SCOPE_MISMATCH', { observedScope });
  });
}
test('missing or malformed observed candidate scope is refused', () => {
  rejects(fixture(), 'OWNER_ACCEPTANCE_SCOPE_INVALID', { observedScope: undefined });
  rejects(fixture(), 'OWNER_ACCEPTANCE_SCOPE_INVALID', { observedScope: { source_bindings: [], items: [] } });
});
test('expiry is exclusive; future acceptance and source-expiry extension are refused', () => {
  const r = fixture();
  rejects(r, 'OWNER_ACCEPTANCE_TIME_INVALID', { now: new Date(r.expires_at) });
  rejects(r, 'OWNER_ACCEPTANCE_TIME_INVALID', { now: new Date('2026-09-04T23:59:59.999Z') });
  r.expires_at = '2026-10-01T00:00:00.000Z'; rejects(r, 'OWNER_ACCEPTANCE_TIME_INVALID');
  r.expires_at = r.accepted_at; rejects(r, 'OWNER_ACCEPTANCE_TIME_INVALID');
});
test('real calendar validation rejects impossible normalized dates', () => {
  const r = fixture(); r.accepted_at = '2026-02-30T00:00:00.000Z'; rejects(r, 'OWNER_ACCEPTANCE_TIME_INVALID');
  r.accepted_at = '2026-09-05T00:00:00.000Z'; r.scope.source_bindings[0].review_due_at = '2026-13-01T00:00:00.000Z';
  rejects(r, 'OWNER_ACCEPTANCE_TIME_INVALID');
});
test('malformed, duplicate-key, noncanonical, oversized and non-string records leak no content', () => {
  const r = fixture();
  const bodies = ['{', `${encode(r).trimEnd().slice(0, -1)},"review_mode":"owner_acceptance"}\n`, JSON.stringify(r, null, 2), 'x'.repeat(2 * 1024 * 1024 + 1)];
  for (const body of bodies) {
    assert.throws(() => verifyOwnerAcceptance(body, options(r, { approvedRecordSha256: hash(body) })), { message: 'OWNER_ACCEPTANCE_RECORD_INVALID' });
  }
  assert.throws(() => verifyOwnerAcceptance(null, options(r)), { message: 'OWNER_ACCEPTANCE_RECORD_INVALID' });
});
test('schema and validator do not activate or rewrite the existing SQL/OpenAPI contract', () => {
  const root = new URL('../../business-docs/01-客服Agent项目/20-设计-进行中/', import.meta.url);
  const sql = readFileSync(new URL('33-schema-v1-草案.sql', root), 'utf8');
  const api = readFileSync(new URL('openapi.v1.yaml', root), 'utf8');
  assert.ok(sql.includes("review_mode IN ('single','dual')"));
  assert.ok(api.includes('enum: [single, dual]'));
  assert.equal(sql.includes("'owner_acceptance'"), false);
});
