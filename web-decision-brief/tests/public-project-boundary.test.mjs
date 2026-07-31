import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");
const projectRoot = path.join(repoRoot, "business-docs/01-客服Agent项目");
const currentFiles = [
  "00-项目章程.md",
  "01-总排期与阶段门禁.md",
  "02-G0责任与证据台账.md",
  "03-Scope与验收.md",
  "04-费用与成本控制.md",
  "05-全栈交付计划.md",
  "06-启动会与周推进.md",
  "README.md",
];

test("公开仓客服真源只使用代号和证据 ID，不诱导提交原始敏感资料", async () => {
  const entries = await Promise.all(currentFiles.map(async (file) => ({
    file,
    text: await readFile(path.join(projectRoot, file), "utf8"),
  })));
  const joined = entries.map(({ file, text }) => `\n# ${file}\n${text}`).join("\n");
  assert.match(joined, /公共仓安全边界/);
  assert.match(joined, /ROLE-\*/);
  assert.match(joined, /EVD-\*/);
  assert.doesNotMatch(joined, /https?:\/\/[^\s)]*feishu\.cn|tenant_access_token|open_id/i);
  assert.doesNotMatch(joined, /\b1[3-9]\d{9}\b/);
  assert.doesNotMatch(joined, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  assert.doesNotMatch(joined, /天元（AI 组 FDE）|\| 角色 \| 姓名 \||外部证据链接 \/ 备注/);
});

test("公开副本不得落正式 A 金额，真实 cap 只能进入私有副本", async () => {
  const cost = await readFile(path.join(projectRoot, "04-费用与成本控制.md"), "utf8");
  assert.doesNotMatch(cost, /^- \[[xX]\] \*\*A 费用可用/m);
  assert.match(cost, /\| 客服项目月 cap \|\s*\|/);
  assert.match(cost, /\| 客服项目全期 cap \|\s*\|/);
  assert.match(cost, /必须先把 00–06 迁到私有仓/);
});

test("公共 CI 不上传客服 PRD 或执行中心浏览器证据", async () => {
  const [quality, pages] = await Promise.all([
    readFile(path.join(repoRoot, ".github/workflows/quality.yml"), "utf8"),
    readFile(path.join(repoRoot, ".github/workflows/pages.yml"), "utf8"),
  ]);
  for (const workflow of [quality, pages]) {
    assert.doesNotMatch(workflow, /output\/customer-agent-(?:prd|hub)-qa/);
  }
  assert.doesNotMatch(pages, /business-docs\/01-客服Agent项目/);
});

test("真实状态可迁到仓外私有工作区，工具链拒绝覆盖并完整切换", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "customer-private-workspace-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "customer-agent");
  const prepare = path.join(repoRoot, "business-docs/08-工具/prepare_private_customer_project.mjs");
  const checker = path.join(repoRoot, "business-docs/08-工具/check_customer_agent_prd_sources.mjs");
  const generator = path.join(repoRoot, "business-docs/08-工具/generate_customer_agent_hub.mjs");
  const first = spawnSync(process.execPath, [prepare, `--target=${target}`], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  const marker = JSON.parse(await readFile(path.join(target, ".customer-project-private.json"), "utf8"));
  assert.deepEqual({ schemaVersion: marker.schemaVersion, visibility: marker.visibility }, { schemaVersion: 1, visibility: "private" });
  assert.match(await readFile(path.join(target, "README.md"), "utf8"), /私有现行工作区/);

  const env = { ...process.env, CUSTOMER_PROJECT_MODE: "private", CUSTOMER_PROJECT_ROOT: target };
  const update = spawnSync(process.execPath, [checker, "--update"], { cwd: repoRoot, env, encoding: "utf8" });
  assert.equal(update.status, 0, `${update.stderr}\n${update.stdout}`);
  const generate = spawnSync(process.execPath, [generator], { cwd: repoRoot, env, encoding: "utf8" });
  assert.equal(generate.status, 0, `${generate.stderr}\n${generate.stdout}`);
  await stat(path.join(target, "07-客服Agent立项PRD.sources.json"));
  await stat(path.join(target, "08-客服Agent立项执行中心.html"));

  const second = spawnSync(process.execPath, [prepare, `--target=${target}`], { cwd: repoRoot, encoding: "utf8" });
  assert.notEqual(second.status, 0, "迁移脚本不得覆盖既有私有工作区");
  assert.match(`${second.stderr}\n${second.stdout}`, /目标已存在，拒绝覆盖/);
});
