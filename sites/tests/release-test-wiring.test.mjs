import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { releaseSteps, stepsForFiles } from '../scripts/quality-plan.mjs';


const sitesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(sitesRoot, "..");


test("release 与 Pages CI 必须执行客服 Python 工具合同", async () => {
  const packageJson = JSON.parse(await readFile(path.join(sitesRoot, "package.json"), "utf8"));
  const scripts = packageJson.scripts;
  assert.match(scripts["test:all"], /quality-plan\.mjs --release --run/);
  for (const step of ['test:customer-agent-python-tools', 'test:boundary-integration', 'test:layout-ui', 'test:backend-candidate']) assert.ok(releaseSteps.includes(step));
  assert.match(scripts["test:customer-agent-python-tools"], /test:customer-agent-g009-tools/);
  assert.match(scripts["test:customer-agent-python-tools"], /test:customer-agent-staging-tools/);
  assert.match(scripts["test:customer-agent-staging-tools"], /test_customer_service_staging_pipeline\.py/);
  assert.match(scripts["test:customer-agent-staging-tools"], /test_customer_service_staging_api\.py/);

  const requirements = await readFile(
    path.join(repoRoot, "business-docs/08-工具/requirements-customer-agent-tools.txt"),
    "utf8"
  );
  assert.match(requirements, /^openpyxl==3\.1\.5$/m);
  assert.match(requirements, /^et-xmlfile==2\.0\.0$/m);

  for (const workflowName of ["quality.yml"]) {
    const workflow = await readFile(path.join(repoRoot, ".github/workflows", workflowName), "utf8");
    assert.match(workflow, /actions\/setup-python@[0-9a-f]{40}/);
    assert.match(workflow, /requirements-customer-agent-tools\.txt/);
    assert.match(workflow, /npm run test:release/);
    assert.doesNotMatch(workflow, /npm run test:all/);
  }
});

test('Pages consumes only the successful same-run main candidate', async () => {
  const quality = await readFile(path.join(repoRoot, '.github/workflows/quality.yml'), 'utf8');
  const pages = await readFile(path.join(repoRoot, '.github/workflows/pages.yml'), 'utf8');
  assert.equal((quality.match(/run: npm run test:release/g) || []).length, 1);
  assert.match(quality, /needs: test/);
  assert.match(quality, /github.ref == 'refs\/heads\/main'/);
  assert.match(quality, /github.event_name == 'push'/);
  assert.match(quality, /uses: \.\/\.github\/workflows\/pages.yml/);
  assert.match(quality, /path: sites\/dist\/pages/);
  assert.match(pages, /workflow_call:/);
  assert.doesNotMatch(pages, /test:release|actions\/checkout|workflow_run|download-artifact/);
  assert.doesNotMatch(quality, /workflow_run|pull_request_target/);
});

test('explicit task paths select iteration gates; unknown code falls back to release', () => {
  assert.throws(() => stepsForFiles([]));
  assert.throws(() => stepsForFiles(['../other.md']));
  assert.deepEqual(stepsForFiles(['README.md']), ['test:docs:fast']);
  assert.ok(stepsForFiles(['business-docs/01-客服Agent项目/02-G0责任与证据台账.md']).includes('test:customer-contracts'));
  assert.deepEqual(stepsForFiles(['sites/package.json']), releaseSteps);
  assert.deepEqual(stepsForFiles(['new-script.js']), releaseSteps);
  assert.equal(new Set(releaseSteps).size, releaseSteps.length);
});

test('every standalone test has a release route or explicit isolated PG route', async () => {
  const { scripts } = JSON.parse(await readFile(path.join(sitesRoot, 'package.json'), 'utf8'));
  const direct = releaseSteps.map(step => scripts[step]).join('\n');
  for (const file of await readdir(path.join(sitesRoot, 'tests'))) {
    if (!file.endsWith('.mjs') || file.endsWith('.test.mjs')) continue;
    if (file === 'customer-agent-owner-acceptance.pg15.mjs') {
      assert.ok(scripts['test:owner-acceptance:pg15'].includes(file));
    } else if (file === 'backend-runtime-candidate.pg.mjs') {
      assert.ok(scripts['test:backend-candidate:pg'].includes(file));
    } else assert.ok(direct.includes(file), `${file} has no release gate`);
  }
});
