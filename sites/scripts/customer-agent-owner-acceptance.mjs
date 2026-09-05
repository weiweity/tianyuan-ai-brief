import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

// Governance tooling only. No package reads, DB writes, identity lookup or signing.
const schema = JSON.parse(readFileSync(new URL(
  '../../business-docs/01-客服Agent项目/30-开发-进行中/owner-acceptance.v1.schema.json', import.meta.url,
), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: false, ownProperties: true });
const validateRecord = ajv.compile(schema);
const validateScope = ajv.compile({ $ref: `${schema.$id}#/$defs/scope` });
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

function fail(code) { throw new Error(code); }

function instant(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail('OWNER_ACCEPTANCE_TIME_INVALID');
  }
  return parsed.valueOf();
}

// Only validated, closed-shape JSON values with ASCII keys reach this function.
// Arrays retain their order: the contract requires explicit stable sorting below.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requireSortedUnique(values) {
  if (values.some((value, index) => index > 0 && values[index - 1] >= value)) {
    fail('OWNER_ACCEPTANCE_SCOPE_INVALID');
  }
}

function checkScope(scope) {
  if (!validateScope(scope)) fail('OWNER_ACCEPTANCE_SCOPE_INVALID');
  requireSortedUnique(scope.source_bindings.map((binding) => binding.domain));
  if (new Set(scope.source_bindings.map((binding) => binding.source_version_id)).size !== 4) {
    fail('OWNER_ACCEPTANCE_SCOPE_INVALID');
  }
  const versions = new Map(scope.source_bindings.map((binding) => [binding.domain, binding.source_version_id]));
  for (const binding of scope.source_bindings) instant(binding.review_due_at);
  requireSortedUnique(scope.items.map((item) => item.script_id));
  for (const item of scope.items) {
    if (versions.get(item.domain) !== item.source_version_id) fail('OWNER_ACCEPTANCE_SCOPE_INVALID');
    requireSortedUnique(item.risk_categories);
    if ((item.risk_level === 'high') !== (item.risk_categories.length > 0)) {
      fail('OWNER_ACCEPTANCE_RISK_INVALID');
    }
  }
}

/**
 * Check an opaque, externally approved record against an independently derived
 * candidate scope. The caller MUST obtain approvedRecordSha256 and
 * expectedOwnerSubjectHash from trusted evidence outside the candidate package.
 * A caller that copies them out of the input has not established authorization.
 * Raw record is stable-key JSON + one LF; digest binds its exact UTF-8 bytes.
 * now is mandatory trusted host time; no default, inferred owner, or auto-renewal.
 * Success proves metadata consistency only, NEVER approval authenticity, DLP,
 * successful evaluation, content conflict resolution, or runtime activation.
 */
export function verifyOwnerAcceptance(rawRecord, options) {
  const { approvedRecordSha256, expectedOwnerSubjectHash, observedScope, now } = options ?? {};
  if (typeof approvedRecordSha256 !== 'string' || !HASH.test(approvedRecordSha256)
    || typeof expectedOwnerSubjectHash !== 'string' || !HASH.test(expectedOwnerSubjectHash)
    || !(now instanceof Date) || !Number.isFinite(now.valueOf())) {
    fail('OWNER_ACCEPTANCE_TRUST_CONTEXT_REQUIRED');
  }
  if (typeof rawRecord !== 'string' || Buffer.byteLength(rawRecord) > MAX_RECORD_BYTES) {
    fail('OWNER_ACCEPTANCE_RECORD_INVALID');
  }
  if (sha256(rawRecord) !== approvedRecordSha256) fail('OWNER_ACCEPTANCE_ANCHOR_MISMATCH');
  let record;
  try { record = JSON.parse(rawRecord); } catch { fail('OWNER_ACCEPTANCE_RECORD_INVALID'); }
  if (!validateRecord(record)) fail('OWNER_ACCEPTANCE_RECORD_INVALID');
  // Reject duplicate keys, CRLF, extra whitespace, alternate numeric spellings,
  // and unknown fields; never normalize input into a different approved record.
  if (`${stableJson(record)}\n` !== rawRecord) fail('OWNER_ACCEPTANCE_RECORD_INVALID');
  if (record.owner_subject_hash !== expectedOwnerSubjectHash) fail('OWNER_ACCEPTANCE_OWNER_MISMATCH');
  checkScope(record.scope);
  checkScope(observedScope);
  const acceptedAt = instant(record.accepted_at);
  const expiresAt = instant(record.expires_at);
  if (acceptedAt > now.valueOf() || acceptedAt >= expiresAt || now.valueOf() >= expiresAt
    || record.scope.source_bindings.some((binding) => expiresAt > instant(binding.review_due_at))) {
    fail('OWNER_ACCEPTANCE_TIME_INVALID');
  }
  if (stableJson(record.scope) !== stableJson(observedScope)) fail('OWNER_ACCEPTANCE_SCOPE_MISMATCH');
  return Object.freeze({
    status: 'OWNER_ACCEPTANCE_METADATA_VALID',
    approved_record_sha256: approvedRecordSha256,
    owner_subject_hash: expectedOwnerSubjectHash,
    approval_evidence_id: record.approval_evidence_id,
    review_mode: 'owner_acceptance',
    runtime_activated: false,
  });
}
