import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";


const sitesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(sitesRoot, "..");


test("release 与 Pages CI 必须执行客服 Python 工具合同", async () => {
  const packageJson = JSON.parse(await readFile(path.join(sitesRoot, "package.json"), "utf8"));
  const scripts = packageJson.scripts;
  assert.match(scripts["test:all"], /test:customer-agent-python-tools/);
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

  for (const workflowName of ["quality.yml", "pages.yml"]) {
    const workflow = await readFile(path.join(repoRoot, ".github/workflows", workflowName), "utf8");
    assert.match(workflow, /actions\/setup-python@[0-9a-f]{40}/);
    assert.match(workflow, /requirements-customer-agent-tools\.txt/);
    assert.match(workflow, /npm run test:release/);
    assert.doesNotMatch(workflow, /npm run test:all/);
  }
});
