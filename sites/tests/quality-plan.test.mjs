import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { shouldPublishPages, stepsForFiles } from '../scripts/quality-plan.mjs';

const sites = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(sites, 'scripts/quality-plan.mjs');
const invoke = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], {
  cwd: sites, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000,
});

test('trusted main event matrix fails closed; docs-only successor still publishes', () => {
  for (const ref of ['refs/heads/main', 'refs/heads/feature', 'refs/pull/1/merge', undefined]) {
    for (const event of ['push', 'workflow_dispatch', 'pull_request', 'pull_request_target', 'workflow_run', undefined]) {
      assert.equal(shouldPublishPages({ GITHUB_REF: ref, GITHUB_EVENT_NAME: event }),
        ref === 'refs/heads/main' && ['push', 'workflow_dispatch'].includes(event));
    }
  }
  // A is canceled before deployment. B includes A's tree plus only README
  // changes: it must publish regardless of B's changed-path list or before SHA.
  const pushes = [
    { changedFiles: ['sites/index.html'], canceled: true },
    { changedFiles: ['README.md'], canceled: false },
  ];
  assert.equal(pushes.filter(push => !push.canceled && shouldPublishPages({
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', ...push,
  })).length, 1);
});

test('actual workflow decision script executes without before SHA or changed paths', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quality-decision-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workflow = await readFile(path.join(sites, '../.github/workflows/quality.yml'), 'utf8');
  const script = workflow.match(/node --input-type=module <<'JS'\n([\s\S]*?)\n\s+JS/)[1]
    .split('\n').map(line => line.replace(/^          /, '')).join('\n');
  for (const [event, ref, expected] of [
    ['push', 'refs/heads/main', true], ['workflow_dispatch', 'refs/heads/main', true],
    ['pull_request', 'refs/heads/main', false], ['push', 'refs/heads/feature', false],
  ]) {
    const output = path.join(dir, `${event}-${expected}`);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: sites, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, GITHUB_REF: ref, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(output, 'utf8'), `publish=${expected}\n`);
  }
});

test('CLI rejects invalid input and plan-only never starts npm', () => {
  for (const args of [[], ['--bad'], ['../outside.md']]) assert.equal(invoke(args).status, 1);
  const result = invoke(['README.md'], { PATH: '/nonexistent' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, 'plan-only');
  assert.equal(invoke(['README.md', '--run'], { PATH: '/nonexistent' }).status, 1);
  assert.deepEqual(stepsForFiles(['a.sql']), ['test:docs:fast', 'test:machine-contracts']);
  assert.deepEqual(stepsForFiles(['business-docs/01-客服Agent项目/20-设计-进行中/example.md']), ['test:docs:fast', 'test:design-contracts']);
});

test('CLI propagates child failure and never runs later release steps', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quality-npm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls');
  await writeFile(path.join(dir, 'npm'), `#!${process.execPath}\n` +
    `require('node:fs').appendFileSync(process.env.QUALITY_CALL_LOG, process.argv[3]+'\\n');\n` +
    `process.exit(process.argv[3] === 'test:boundary-integration' ? 7 : 0);\n`, { mode: 0o700 });
  const result = invoke(['--release', '--run'], { PATH: dir, QUALITY_CALL_LOG: log });
  assert.equal(result.status, 7, result.stderr);
  assert.equal(await readFile(log, 'utf8'), 'test\ntest:boundary-integration\n');
});
