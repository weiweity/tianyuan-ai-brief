// Opt-in synthetic contract test. Never connects to an existing DB or reads real packages.
import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyOwnerAcceptance } from '../scripts/customer-agent-owner-acceptance.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v);
const encode = (r) => `${stable(r)}\n`;
const quote = (v) => `'${v.replaceAll("'", "''")}'`;
const pgBin = process.env.CUSTOMER_AGENT_PG_BIN;
assert.ok(pgBin && path.isAbsolute(pgBin), 'Set CUSTOMER_AGENT_PG_BIN to an existing PostgreSQL 15 bin directory');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
env.PGCONNECT_TIMEOUT = '5';
const run = (name, args, input) => {
  const result = spawnSync(path.join(pgBin, name), args, { env, input, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  return result;
};
const ok = (result) => { assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
const design = new URL('../../business-docs/01-客服Agent项目/20-设计-进行中/', import.meta.url);
const candidate = new URL('../../business-docs/01-客服Agent项目/30-开发-进行中/', import.meta.url);
const signalProbe = process.env.CUSTOMER_AGENT_PG_SIGNAL_PROBE;
if (signalProbe) assert.ok(signalProbe === 'ready' && typeof process.send === 'function', 'Signal probe requires a supervised IPC child');

// Synchronous teardown cannot race pending awaits or another signal handler.
// Never remove PGDATA unless pg_ctl succeeded and its live-cluster marker is gone.
function cleanupSyntheticCluster(root) {
  assert.equal(path.dirname(root), tmpdir());
  assert.match(path.basename(root), /^csai-owner-pg15-[A-Za-z0-9]{6}$/);
  if (!existsSync(root)) return; // Both the normal path and its supervisor may call us.
  const data = path.join(root, 'data');
  if (existsSync(path.join(data, 'postmaster.pid'))) {
    ok(run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', '-t', '20', 'stop']));
  }
  assert.equal(existsSync(path.join(data, 'postmaster.pid')), false, 'Cannot remove a cluster whose shutdown is not verified');
  rmSync(root, { recursive: true, force: false });
  assert.equal(existsSync(root), false);
}

test('owner acceptance registry: isolated PG15 synthetic capability and lifecycle checks', async (t) => {
  assert.match(ok(run('postgres', ['--version'])), /PostgreSQL\) 15\./);
  const root = mkdtempSync(path.join(tmpdir(), 'csai-owner-pg15-'));
  const data = path.join(root, 'data'); const socket = path.join(root, 'socket');
  const port = randomInt(49152, 65535);
  const psqlArgs = ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
    '-h', socket, '-p', String(port), '-U', 'synthetic_owner', '-d', 'postgres'];
  const sql = (input) => run('psql', psqlArgs, input);
  const check = (label, fn) => t.test(label, fn);
  const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal, () => {
    try {
      cleanupSyntheticCluster(root);
    } catch {
      console.error(`Synthetic PG15 interruption cleanup failed; inspect retained workspace: ${root}`);
      process.exit(1);
    }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  }]));
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  try {
    if (signalProbe) process.send({ phase: 'allocated', root });
    mkdirSync(socket, { mode: 0o700 });
    ok(run('initdb', ['-D', data, '--username=synthetic_owner', '--auth-local=trust', '--auth-host=reject', '--encoding=UTF8', '--locale=C', '--no-sync']));
    assert.ok(!socket.includes("'") && !socket.includes(' '), 'Unix socket path must be safe for pg_ctl options');
    ok(run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-w', '-t', '20', '-o',
      `-c listen_addresses='' -c unix_socket_directories=${socket} -c unix_socket_permissions=0700 -p ${port}`, 'start']));
    assert.equal(ok(sql('SHOW listen_addresses')), '');
    assert.equal(ok(sql('SHOW unix_socket_directories')), socket);
    if (signalProbe) {
      // This supervised test-only mode pauses before any schema/package reads.
      const pid = Number(readFileSync(path.join(data, 'postmaster.pid'), 'utf8').split('\n')[0]);
      const hold = setInterval(() => {}, 1000);
      try {
        await new Promise((resolve, reject) => {
          process.once('disconnect', () => reject(new Error('Signal probe supervisor disconnected')));
          process.send({ phase: 'ready', root, pid }, (error) => { if (error) reject(error); });
        });
      } finally { clearInterval(hold); }
      return;
    }
    const baseSql = await readFile(new URL('33-schema-v1-草案.sql', design), 'utf8');
    assert.equal(sha(baseSql), 'edf909bf9450b5745a85ced4a75a2e2de3e5b061847562cd3a68c9c7c226da99');
    ok(sql(baseSql));
    const extensionSql = await readFile(new URL('owner-acceptance.registry.v1.sql', candidate), 'utf8');
    ok(sql(extensionSql));
    const contentHashSql = await readFile(new URL('owner-acceptance.content-hash.v1.sql', candidate), 'utf8');
    ok(sql(contentHashSql));
    const now = new Date();
    const sources = ['aftersale','campaign','presale','product'].map((domain) => ({
      domain, source_version_id: `srcv_synthetic_${domain}`, snapshot_sha256: sha(`source-${domain}`),
      review_due_at: new Date(now.valueOf() + 86400_000).toISOString(),
    }));
    const record = {
      schema: 'customer-agent/owner-acceptance/v1', review_mode: 'owner_acceptance', purpose: 'g1a_offline_only',
      owner_subject_hash: sha('synthetic-owner-only'), approval_evidence_id: 'EVD-SYNTHETIC-OWNER-ACCEPTANCE',
      accepted_at: new Date(now.valueOf() - 60_000).toISOString(), expires_at: new Date(now.valueOf() + 3600_000).toISOString(),
      scope: { source_bindings: sources, items: sources.map((s) => ({
        script_id: `synthetic_${s.domain}`, script_version: 1, domain: s.domain, source_version_id: s.source_version_id,
        review_input_sha256: sha(`input-${s.domain}`), risk_level: s.domain === 'campaign' ? 'high' : 'medium',
        risk_categories: s.domain === 'campaign' ? ['campaign_rules'] : [], has_conflict: false,
      })) },
    };
    for (const s of sources) ok(sql(`INSERT INTO public.authoritative_source_versions
      (tenant_id,source_version_id,source_ref,domain,upstream_version,snapshot_sha256,use_class,owner_role,approval_evd,approved_by,approved_at,review_due_at)
      VALUES ('synthetic_tenant',${quote(s.source_version_id)},'SRC-SYNTHETIC',${quote(s.domain)},${quote(s.domain)},${quote(s.snapshot_sha256)},'canonical','ROLE-CONTENT-LEAD','EVD-SYNTHETIC-SOURCE','synthetic-owner',${quote(record.accepted_at)},${quote(s.review_due_at)});`));
    const register = (r = record, { role = 'app_owner_acceptance_registrar', tenant = 'synthetic_tenant', raw = encode(r), anchor = sha(raw), owner = record.owner_subject_hash } = {}) =>
      sql(`SET ROLE ${role}; SELECT public.register_owner_acceptance(${quote(tenant)},${quote(raw)},${quote(anchor)},${quote(owner)});`);
    const bound = (r = record, { tenant = 'synthetic_tenant', owner = r.owner_subject_hash, purpose = 'g1a_offline_only', scope = r.scope } = {}) =>
      sql(`SELECT public.assert_owner_acceptance(${quote(tenant)},${quote(sha(encode(r)))},${quote(owner)},${quote(purpose)},${quote(JSON.stringify(scope))}::jsonb);`);
    const denied = (result, code = 'OWNER_ACCEPTANCE_') => {
      assert.notEqual(result.status, 0); assert.match(result.stderr, new RegExp(code));
    };
    const governanceArguments = (mode = 'single') => `
      'synthetic_presale','presale','合成标题','合成话术','SRC-SYNTHETIC','srcv_synthetic_presale',
      'ROLE-CONTENT-LEAD','2026-09-30T00:00:00.000Z',ARRAY['douyin','qianniu'],'storewide',ARRAY[]::text[],
      '2026-09-01T00:00:00.000Z',NULL,'synthetic_taxonomy','synthetic_intent','medium',ARRAY[]::text[],false,
      ${quote(mode)},'synthetic-reviewer','ROLE-CONTENT-LEAD','EVD-SYNTHETIC-REVIEW',
      ${mode === 'dual' ? "'synthetic-secondary','ROLE-CS-MANAGER','EVD-SYNTHETIC-SECONDARY'" : 'NULL,NULL,NULL'},ARRAY[]::text[],
      '[{"question_id":"synthetic_question","question_text":"合成问题"}]'::jsonb`;
    const normalizedSnapshot = (mode) => JSON.parse(ok(sql(`SELECT public.content_governance_snapshot(${governanceArguments(mode)})`)));
    await check('one genuine owner can register exactly anchored metadata; JS and SQL agree', () => {
      assert.equal(verifyOwnerAcceptance(encode(record), { approvedRecordSha256: sha(encode(record)), expectedOwnerSubjectHash: record.owner_subject_hash, observedScope: record.scope, now }).runtime_activated, false);
      assert.equal(ok(register()), sha(encode(record))); ok(bound());
    });
    await check('same registration is idempotent and does not append another record', () => {
      ok(register()); assert.equal(ok(sql('SELECT count(*) FROM public.owner_acceptance_records')), '1');
    });
    await check('registration is atomic with caller rollback', () => {
      const r = structuredClone(record); r.approval_evidence_id = 'EVD-SYNTHETIC-ROLLED-BACK';
      ok(sql(`BEGIN; SET LOCAL ROLE app_owner_acceptance_registrar; SELECT public.register_owner_acceptance(
        'synthetic_tenant',${quote(encode(r))},'${sha(encode(r))}','${r.owner_subject_hash}'); ROLLBACK;`));
      denied(bound(r)); assert.equal(ok(sql('SELECT count(*) FROM public.owner_acceptance_records')), '1');
    });
    for (const isolation of ['repeatable read','serializable']) await check(`${isolation} cannot reuse a stale approval snapshot`, () => {
      const args = `'synthetic_tenant','${sha(encode(record))}','${record.owner_subject_hash}','g1a_offline_only',${quote(JSON.stringify(record.scope))}::jsonb`;
      denied(sql(`BEGIN ISOLATION LEVEL ${isolation}; SELECT public.assert_owner_acceptance(${args})`), 'ISOLATION_DENIED');
      denied(sql(`BEGIN ISOLATION LEVEL ${isolation}; SET LOCAL ROLE app_owner_acceptance_registrar;
        SELECT public.register_owner_acceptance('synthetic_tenant',${quote(encode(record))},'${sha(encode(record))}','${record.owner_subject_hash}')`), 'ISOLATION_DENIED');
      denied(sql(`BEGIN ISOLATION LEVEL ${isolation}; SET LOCAL ROLE app_owner_acceptance_registrar;
        SELECT public.revoke_owner_acceptance('synthetic_tenant','${sha(encode(record))}','EVD-SYNTHETIC-STALE')`), 'ISOLATION_DENIED');
    });
    await check('SQL normalized business projection matches Node canonical hash and binds every business field', () => {
      const snapshot = normalizedSnapshot();
      const omitted = ['review_mode','primary_reviewer_id','primary_reviewer_role','primary_review_evd','secondary_reviewer_id','secondary_reviewer_role','secondary_review_evd'];
      const projection = Object.fromEntries(Object.entries(snapshot).filter(([key]) => !omitted.includes(key)));
      const expected = sha(stable({ ...projection, projection_version: 'customer-agent/owner-acceptance-input/v1', script_version: 1 }));
      const digest = (s, version = 1) => sql(`SELECT public.owner_acceptance_review_input_sha256(${quote(JSON.stringify(s))}::jsonb,${version})`);
      assert.equal(ok(digest(snapshot)), expected);
      for (const key of Object.keys(projection)) {
        const changed = { ...snapshot, [key]: snapshot[key] === null ? 'synthetic-change' : null };
        assert.notEqual(ok(digest(changed)), expected, key);
      }
      for (const key of omitted) assert.equal(ok(digest({ ...snapshot, [key]: 'synthetic-other-review' })), expected);
      assert.notEqual(ok(digest(snapshot, 2)), expected);
      denied(digest(snapshot, 0), 'INPUT_INVALID');
      denied(digest({ ...snapshot, unknown_business_field: 'synthetic' }), 'INPUT_INVALID');
      const incomplete = { ...snapshot }; delete incomplete.questions; denied(digest(incomplete), 'INPUT_INVALID');
    });
    await check('final content identity binds the normalized content, version, real owner, evidence and record anchor', () => {
      const snapshot = { ...normalizedSnapshot(), review_mode: 'owner_acceptance',
        primary_reviewer_id: record.owner_subject_hash, primary_review_evd: record.approval_evidence_id };
      const anchor = sha(encode(record));
      const digest = (value = snapshot, version = 1, recordSha = anchor) => sql(`SELECT public.owner_acceptance_content_hash(
        ${quote(JSON.stringify(value))}::jsonb,${version},
        ${recordSha === null ? 'NULL' : quote(recordSha)})`);
      const expected = sha(stable({ hash_version: 'customer-agent/owner-acceptance-content/v1',
        script_version: 1, owner_acceptance_record_sha256: anchor, content: snapshot }));
      assert.equal(ok(digest()), expected);
      assert.equal(ok(digest(Object.fromEntries(Object.entries(snapshot).reverse()))), expected, 'JSON object order is not content');
      for (const key of Object.keys(snapshot).filter((k) => !k.startsWith('secondary_') && !['review_mode','has_conflict','primary_reviewer_role'].includes(k))) {
        const changed = { ...snapshot, [key]: key === 'primary_reviewer_id' ? sha('another-real-owner')
          : key === 'primary_review_evd' ? 'EVD-SYNTHETIC-OTHER-APPROVAL'
          : snapshot[key] === null ? 'synthetic-change' : null };
        // This pure identity function binds business fields; business validators
        // remain responsible for their values before normalized input is supplied.
        assert.notEqual(ok(digest(changed)), expected, key);
      }
      assert.notEqual(ok(digest(snapshot, 2)), expected);
      assert.notEqual(ok(digest(snapshot, 1, sha('another-approved-record'))), expected);
      for (const mode of ['single', 'dual']) {
        const oldHash = ok(sql(`SELECT public.content_governance_hash(${governanceArguments(mode)})`));
        assert.equal(oldHash, sha(stable(normalizedSnapshot(mode))), `old ${mode} preimage has no new envelope`);
      }
      for (const value of [null, [], 'synthetic', 1]) denied(digest(value));
      denied(sql(`SELECT public.owner_acceptance_content_hash(NULL,1,'${anchor}')`));
      for (const version of [0, -1, 'NULL']) denied(digest(snapshot, version));
      for (const invalid of [null, '', 'wrong-anchor', anchor.toUpperCase()]) denied(digest(snapshot, 1, invalid));
      const missing = { ...snapshot }; delete missing.questions; denied(digest(missing));
      denied(digest({ ...snapshot, extra: 'synthetic' }));
      for (const [key, values] of Object.entries({
        review_mode: [null, 'single', 'dual', 'other'], has_conflict: [null, true, 'false'],
        primary_reviewer_id: [null, '', 'not-a-hash', 1], primary_reviewer_role: [null, 'ROLE-CS-MANAGER'],
        primary_review_evd: [null, '', 'bad-evidence', 1],
        secondary_reviewer_id: ['synthetic-reviewer'], secondary_reviewer_role: ['ROLE-CS-MANAGER'],
        secondary_review_evd: ['EVD-SYNTHETIC-FAKE-SECONDARY'],
      })) for (const value of values) denied(digest({ ...snapshot, [key]: value }));
      for (const role of ['app_runtime','app_import_worker','app_content_admin','app_work_order_worker','app_owner_acceptance_registrar']) {
        denied(sql(`SET ROLE ${role}; SELECT public.owner_acceptance_content_hash(
          ${quote(JSON.stringify(snapshot))}::jsonb,1,'${anchor}')`), '42501');
      }
      assert.equal(ok(sql(`SELECT p.provolatile = 'i' AND NOT p.prosecdef AND NOT p.proisstrict
        AND pg_get_userbyid(p.proowner) = 'cs_ai_definer'
        FROM pg_proc p WHERE p.oid = 'public.owner_acceptance_content_hash(jsonb,integer,text)'::regprocedure`)), 't');
    });
    for (const role of ['app_runtime','app_import_worker','app_content_admin','app_work_order_worker']) {
      await check(`${role} cannot register acceptance or call internal assertion`, () => {
        denied(register(record, { role }), '42501');
        denied(sql(`SET ROLE ${role}; SELECT public.assert_owner_acceptance('synthetic_tenant','${sha(encode(record))}','${record.owner_subject_hash}','g1a_offline_only','{}');`), '42501');
      });
    }
    await check('registrar is NOLOGIN, has no memberships and no raw table access', () => {
      assert.equal(ok(sql("SELECT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname='app_owner_acceptance_registrar'")), 'f');
      assert.equal(ok(sql("SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member OR r.oid=m.roleid WHERE r.rolname='app_owner_acceptance_registrar'")), '0');
      denied(sql('SET ROLE app_owner_acceptance_registrar; SELECT * FROM public.owner_acceptance_records'), '42501');
      denied(sql("SET ROLE app_owner_acceptance_registrar; INSERT INTO public.owner_acceptance_records VALUES ('fake','fake','fake','{}',now())"), '42501');
    });
    await check('wrong external anchor and owner fail independently', () => {
      denied(register(record, { anchor: sha('different') }), 'ANCHOR_MISMATCH');
      denied(register(record, { owner: sha('another-owner') }), 'OWNER_MISMATCH');
    });
    for (const [label, mutate] of [
      ['unknown field', (r) => { r.answer_text = 'SYNTHETIC-NOT-ALLOWED'; }],
      ['unknown mode', (r) => { r.review_mode = 'dual'; }],
      ['runtime purpose', (r) => { r.purpose = 'production'; }],
      ['null purpose', (r) => { r.purpose = null; }],
      ['unknown source key', (r) => { r.scope.source_bindings[0].extra = true; }],
      ['repeated domain', (r) => { r.scope.source_bindings[1] = r.scope.source_bindings[0]; }],
      ['missing domain', (r) => { r.scope.source_bindings.pop(); }],
      ['null domain', (r) => { r.scope.items[0].domain = null; }],
      ['wrong item version binding', (r) => { r.scope.items[0].source_version_id = 'srcv_synthetic_absent'; }],
      ['numeric string', (r) => { r.scope.items[0].script_version = '1'; }],
      ['int overflow', (r) => { r.scope.items[0].script_version = 2147483648; }],
      ['duplicate identity', (r) => { r.scope.items[1].script_id = r.scope.items[0].script_id; }],
      ['scope reorder', (r) => { r.scope.items.reverse(); }],
      ['risk downgrade', (r) => { r.scope.items[1].risk_level = 'medium'; }],
      ['unknown risk category', (r) => { r.scope.items[1].risk_categories = ['unknown']; }],
      ['duplicate risk category', (r) => { r.scope.items[1].risk_categories.push('campaign_rules'); }],
      ['conflict', (r) => { r.scope.items[0].has_conflict = true; }],
      ['fake secondary reviewer', (r) => { r.secondary_reviewer_id = null; }],
      ['source expiry extension', (r) => { r.expires_at = new Date(now.valueOf() + 2 * 86400_000).toISOString(); }],
      ['impossible date', (r) => { r.accepted_at = '2026-02-30T00:00:00.000Z'; }],
    ]) await check(`${label}: JS and SQL both reject without changing business facts`, () => {
      const r = structuredClone(record); mutate(r);
      assert.throws(() => verifyOwnerAcceptance(encode(r), { approvedRecordSha256: sha(encode(r)), expectedOwnerSubjectHash: record.owner_subject_hash, observedScope: r.scope, now }));
      denied(register(r));
    });
    for (const raw of ['{', JSON.stringify(record, null, 2), encode(record).replace(/\n$/, '\r\n'), encode(record).replace('"review_mode":', '"review_mode":"owner_acceptance","review_mode":')]) {
      await check('malformed or noncanonical approved bytes reject', () => denied(register(record, { raw })));
    }
    await check('cross-tenant registration and use cannot borrow another tenant source versions', () => {
      denied(register(record, { tenant: 'other_tenant' })); denied(bound(record, { tenant: 'other_tenant' }));
    });
    await check('oversized metadata and item count fail closed before registration', () => {
      denied(register(record, { raw: 'x'.repeat(2 * 1024 * 1024 + 1) }));
      const r = structuredClone(record);
      r.scope.items = Array.from({ length: 5000 }, (_, i) => ({ ...record.scope.items[0], script_id: `synthetic_${String(i).padStart(6, '0')}` }));
      ok(register(r)); ok(bound(r));
      r.scope.items.push({ ...record.scope.items[0], script_id: 'synthetic_999999' }); denied(register(r));
    });
    await check('actual source hash and cutoff must equal immutable DB source facts', () => {
      for (const field of ['snapshot_sha256','review_due_at']) {
        const r = structuredClone(record); r.scope.source_bindings[0][field] = field === 'snapshot_sha256' ? sha('changed-source') : new Date(now.valueOf() + 3 * 86400_000).toISOString();
        denied(register(r), 'NOT_ACTIVE');
      }
    });
    await check('scope changes, wrong owner, online purpose and unknown record deny use', () => {
      const scope = structuredClone(record.scope); scope.items.pop();
      denied(bound(record, { scope })); denied(bound(record, { owner: sha('wrong') })); denied(bound(record, { purpose: 'production' }));
      const r = structuredClone(record); r.approval_evidence_id = 'EVD-SYNTHETIC-NOT-REGISTERED'; denied(bound(r));
    });
    await check('future and expired records reject on DB time', () => {
      const future = structuredClone(record); future.accepted_at = new Date(Date.now() + 60_000).toISOString(); denied(register(future), 'NOT_ACTIVE');
      const expired = structuredClone(record); expired.expires_at = new Date(now.valueOf() - 1).toISOString(); denied(register(expired));
    });
    await check('immutable records reject even direct privileged update/delete/truncate', () => {
      for (const command of ["UPDATE public.owner_acceptance_records SET record=record", 'DELETE FROM public.owner_acceptance_records', 'TRUNCATE public.owner_acceptance_records CASCADE']) denied(sql(command), 'IMMUTABLE');
    });
    await check('active use fences concurrent revocation and source suspension until transaction end', async () => {
      const client = spawn(path.join(pgBin, 'psql'), psqlArgs, { env, stdio: ['pipe','pipe','pipe'] });
      let output = ''; let errors = '';
      client.stderr.on('data', (chunk) => { errors += chunk; });
      const finished = new Promise((resolve) => client.once('close', resolve));
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('synthetic transaction readiness timed out')), 5000);
          client.once('error', (error) => { clearTimeout(timer); reject(error); });
          client.once('close', () => { clearTimeout(timer); reject(new Error(errors)); });
          client.stdout.on('data', (chunk) => {
            output += chunk; if (output.includes('SYNTHETIC_LOCK_READY')) { clearTimeout(timer); resolve(); }
          });
          client.stdin.write(`BEGIN; SELECT public.assert_owner_acceptance('synthetic_tenant','${sha(encode(record))}','${record.owner_subject_hash}','g1a_offline_only',${quote(JSON.stringify(record.scope))}::jsonb); SELECT 'SYNTHETIC_LOCK_READY';\n`);
        });
        denied(sql(`SET lock_timeout='150ms'; SET ROLE app_owner_acceptance_registrar;
          SELECT public.revoke_owner_acceptance('synthetic_tenant','${sha(encode(record))}','EVD-SYNTHETIC-RACE')`), '55P03');
        denied(sql(`SELECT public.suspend_authoritative_source('${sources[0].source_version_id}','SOURCE_REVOKED','EVD-SYNTHETIC-RACE','synthetic-owner','owner')`), 'CONFLICT');
      } finally {
        client.stdin.end('ROLLBACK;\n\\q\n');
        const timer = setTimeout(() => client.kill('SIGKILL'), 3000);
        const code = await finished; clearTimeout(timer); assert.equal(code, 0, errors);
      }
      ok(bound());
    });
    await check('revocation is append-only, idempotent and prevents replay resurrection', () => {
      const revoke = (evidence) => sql(`SET ROLE app_owner_acceptance_registrar; SELECT public.revoke_owner_acceptance('synthetic_tenant','${sha(encode(record))}',${quote(evidence)})`);
      ok(revoke('EVD-SYNTHETIC-REVOKED')); ok(revoke('EVD-SYNTHETIC-REVOKED'));
      denied(revoke('EVD-SYNTHETIC-DIFFERENT'), 'REVOCATION_CONFLICT');
      denied(bound()); denied(register());
      denied(sql('DELETE FROM public.owner_acceptance_revocations'), 'IMMUTABLE');
    });
    await check('permanent source suspension invalidates an otherwise registered record', () => {
      const r = structuredClone(record); r.approval_evidence_id = 'EVD-SYNTHETIC-SECOND-APPROVAL'; ok(register(r)); ok(bound(r));
      ok(sql(`SELECT public.suspend_authoritative_source('${sources[0].source_version_id}','SOURCE_REVOKED','EVD-SYNTHETIC-SUSPENDED','synthetic-owner','owner')`));
      denied(bound(r)); denied(register(r));
    });
    await check('existing single/dual constraints and all runtime function definitions remain unchanged', () => {
      assert.equal(ok(sql("SELECT count(*) FROM pg_constraint WHERE conrelid IN ('scripts'::regclass,'staging_scripts'::regclass,'release_items'::regclass) AND pg_get_constraintdef(oid) LIKE '%owner_acceptance%'")), '0');
      assert.equal(ok(sql("SELECT count(*) FROM pg_proc WHERE proname IN ('publish_content_release','rollback_content_release','search_recommendable_scripts') AND prosrc LIKE '%owner_acceptance%'")), '0');
    });
  } finally {
    try { cleanupSyntheticCluster(root); }
    finally { for (const [signal, handler] of signalHandlers) process.off(signal, handler); }
    console.log('Synthetic PG15 cluster stopped; temporary PGDATA/WAL removed; no real packages read.');
  }
});

// No sleeps to guess server readiness: the child reports its own live PID over IPC.
// The supervisor also reclaims its child's workspace if a regression breaks cleanup.
if (!signalProbe) for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} reclaims a live synthetic cluster and exits as interrupted`, async () => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...env, CUSTOMER_AGENT_PG_SIGNAL_PROBE: 'ready' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let root; let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.resume();
    const finished = new Promise((resolve) => child.once('close', (code, receivedSignal) => resolve({ code, receivedSignal })));
    let killDeadline;
    const requestStop = () => {
      child.kill('SIGTERM');
      killDeadline ??= setTimeout(() => child.kill('SIGKILL'), 30_000);
    };
    const deadline = setTimeout(requestStop, 30_000);
    try {
      const ready = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', () => reject(new Error(`Signal probe exited before readiness: ${stderr}`)));
        child.on('message', (message) => {
          try {
            assert.equal(path.dirname(message.root), tmpdir());
            assert.match(path.basename(message.root), /^csai-owner-pg15-[A-Za-z0-9]{6}$/);
            if (message.phase === 'allocated') {
              assert.equal(root, undefined);
              root = message.root; // Known before initdb/start, including startup failures.
            } else {
              assert.equal(message.phase, 'ready');
              assert.equal(message.root, root);
              resolve(message);
            }
          } catch (error) { reject(error); }
        });
      });
      assert.equal(ready.phase, 'ready');
      root = ready.root;
      assert.equal(path.dirname(root), tmpdir());
      assert.match(path.basename(root), /^csai-owner-pg15-[A-Za-z0-9]{6}$/);
      assert.equal(statSync(root).mode & 0o777, 0o700);
      assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 1);
      process.kill(ready.pid, 0);
      assert.equal(child.kill(signal), true);
      assert.deepEqual(await finished, { code: signal === 'SIGINT' ? 130 : 143, receivedSignal: null }, stderr);
      assert.equal(existsSync(root), false, 'Interrupted child left PGDATA/WAL behind');
      assert.throws(() => process.kill(ready.pid, 0), { code: 'ESRCH' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) requestStop();
      await finished;
      clearTimeout(deadline);
      clearTimeout(killDeadline);
      if (root) cleanupSyntheticCluster(root);
    }
  });
}
