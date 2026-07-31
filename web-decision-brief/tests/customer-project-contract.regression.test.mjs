import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");
const projectRoot = path.join(repoRoot, "business-docs/01-客服Agent项目");

const readProject = (file) => readFile(path.join(projectRoot, file), "utf8");
const readRepo = (file) => readFile(path.join(repoRoot, file), "utf8");

test("四候选优先级有唯一可复核算法，缺证据或并列不得主观破平", async () => {
  const [cadence, ledger, scope] = await Promise.all([
    readProject("06-启动会与周推进.md"),
    readProject("02-G0责任与证据台账.md"),
    readProject("03-Scope与验收.md"),
  ]);
  assert.match(cadence, /0\s*=\s*必需证据缺失/);
  for (const text of [ledger, scope]) assert.match(text, /缺证据记 0/);
  for (const text of [cadence, ledger, scope]) assert.match(text, /中位数/);
  assert.match(cadence, /5 份独立/);
  assert.match(ledger, /5 份独立/);
  assert.match(scope, /独立预评分；每候选 ≥3 样本、5 份有效评分/);
  assert.match(cadence, /任务频次与痛点强度 \| 25%/);
  assert.match(cadence, /前两名差值 \*\*不超过 3 分\*\*/);
  assert.match(cadence, /不允许现场主观破平/);
  assert.match(scope, /前两名差 >3 分/);
  assert.match(cadence, /^\| 维度 \| 0 \| 1 \| 2 \| 3 \| 4 \| 5 \|$/m);
  const anchorStart = cadence.indexOf("| 维度 | 0 | 1 | 2 | 3 | 4 | 5 |");
  const anchorEnd = cadence.indexOf("- 每个维度先取", anchorStart);
  const anchorTable = cadence.slice(anchorStart, anchorEnd);
  assert.equal(
    (anchorTable.match(/^\| (?:任务频次与痛点强度|耗时、错误与经营影响基线|业务价值与风险降低|数据与责任可得性|两周可验证性) \|/gm) || []).length,
    5
  );
  assert.equal((cadence.match(/^\| S[1-5] \|/gm) || []).length, 20);
});

test("内容真源与业务验收拆成唯一 A，不再互相覆盖", async () => {
  const [charter, ledger, scope] = await Promise.all([
    readProject("00-项目章程.md"),
    readProject("02-G0责任与证据台账.md"),
    readProject("03-Scope与验收.md"),
  ]);
  assert.match(charter, /业务优先级、业务覆盖与验收 \| 客服业务 Owner/);
  assert.match(charter, /话术真源、字段、版本与发布 \| 话术真源 Owner/);
  assert.match(ledger, /G0-06[^\n]+\| 话术真源 Owner（待具名）/);
  assert.match(ledger, /G0-09[^\n]+\| 话术真源 Owner（待具名）/);
  assert.match(scope, /\| 7 [^\n]+\| 话术真源 Owner \|/);
  assert.match(scope, /\| 9 [^\n]+\| 话术真源 Owner \|/);
});

test("未核验审批角色不得写成既定 HR 或金主", async () => {
  const files = await Promise.all([
    readProject("02-G0责任与证据台账.md"),
    readProject("03-Scope与验收.md"),
    readProject("04-费用与成本控制.md"),
    readProject("80-参考/客服Agent一页立项卡.md"),
  ]);
  for (const text of files) {
    assert.doesNotMatch(text, /HR 人事总经理|HR 总经理/);
    assert.match(text, /待核验|待具名/);
  }
});

test("评测按平台场景分层，单一简单场景不能包办总分", async () => {
  const scope = await readProject("03-Scope与验收.md");
  assert.match(scope, /平台 × 核心场景至少 2 条/);
  assert.match(scope, /单一分层不得超过 40%/);
  assert.match(scope, /无依据、过期 \/ 冲突、无权限 \/ 敏感、意图模糊需追问、超范围需转人工/);
  assert.match(scope, /缺分层或只报总分不得验收/);
  assert.match(scope, /任一分层未达线即失败，不能用总体均值抵扣/);
  assert.match(scope, /Scope 与验收 v2\.2/);
});

test("执行中心首屏明确方向不等于批准，并展示评分准备", async () => {
  const [generator, template, statusModule] = await Promise.all([
    readRepo("business-docs/08-工具/generate_customer_agent_hub.mjs"),
    readRepo("business-docs/08-工具/templates/customer-agent-hub.template.html"),
    readRepo("business-docs/08-工具/customer_project_status.mjs"),
  ]);
  assert.match(generator, /工作方向已登记，不等于公司批准/);
  assert.match(generator, /5 份原始评分 · 每候选 ≥3 样本 · 异常分清单/);
  assert.match(statusModule, /新增付费授权 = 0/);
  assert.doesNotMatch(generator, /外包推进节奏/);
  assert.match(template, /data\.prelaunchChecklist\.slice\(0, 6\)/);
  assert.match(template, /公司正式批准/);
  assert.match(template, /60 分钟议程/);
});

test("PRD --update 必须先拒绝只改真源未改 PRD 的重签", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "customer-prd-contract-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const fixtureProject = path.join(fixtureRoot, "business-docs/01-客服Agent项目");
  const fixtureTools = path.join(fixtureRoot, "business-docs/08-工具");
  await Promise.all([
    mkdir(fixtureProject, { recursive: true }),
    mkdir(fixtureTools, { recursive: true }),
  ]);

  const projectFiles = [
    "00-项目章程.md",
    "01-总排期与阶段门禁.md",
    "02-G0责任与证据台账.md",
    "03-Scope与验收.md",
    "04-费用与成本控制.md",
    "05-全栈交付计划.md",
    "06-启动会与周推进.md",
    "07-客服Agent立项PRD.html",
  ];
  await Promise.all(
    projectFiles.map((file) => copyFile(path.join(projectRoot, file), path.join(fixtureProject, file)))
  );
  for (const file of ["check_customer_agent_prd_sources.mjs", "customer_project_status.mjs", "project_workspace.mjs"]) {
    await copyFile(path.join(repoRoot, "business-docs/08-工具", file), path.join(fixtureTools, file));
  }

  const checker = path.join(fixtureTools, "check_customer_agent_prd_sources.mjs");
  const runUpdate = () => spawnSync(process.execPath, [checker, "--update"], { cwd: fixtureRoot, encoding: "utf8" });
  const initial = runUpdate();
  assert.equal(initial.status, 0, `${initial.stderr}\n${initial.stdout}`);
  const manifestPath = path.join(fixtureProject, "07-客服Agent立项PRD.sources.json");
  const manifestBeforeDrift = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestBeforeDrift);
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.contracts.milestones, {
    d0: "2026-08-04",
    g0Date: "2026-08-14",
    g0State: "未签发",
    ddevEarliest: "2026-08-17",
    ddevState: "未成立",
  });
  assert.deepEqual(manifest.contracts.acceptance, {
    top3OverallMinPercent: 70,
    top3StratumMinPercent: 50,
    top3StratumMinHits: 1,
    citationCorrectPercent: 100,
    negativeMinCases: 5,
    negativeMaxWrongAnswers: 0,
    pilotMinPeople: 3,
    pilotMaxPeople: 5,
    pilotWeeks: 2,
    pilotTasksPerPersonWeek: 5,
    scopePass: 0,
    scopeTotal: 15,
  });
  assert.deepEqual(manifest.contracts.fee, {
    pathCode: "B",
    selected: false,
    paidAuthorization: "0",
  });

  const fixtureScopePath = path.join(fixtureProject, "03-Scope与验收.md");
  const scope = await readFile(fixtureScopePath, "utf8");
  const driftedScope = scope.replace(
    "每个已冻结分层 Top3 ≥ **50%**",
    "每个已冻结分层 Top3 ≥ **55%**"
  );
  assert.notEqual(driftedScope, scope, "fixture 必须实际修改分层 Top3 真源");
  await writeFile(fixtureScopePath, driftedScope, "utf8");

  const rejected = runUpdate();
  assert.notEqual(rejected.status, 0, "只改真源不改 PRD 时 --update 不得成功");
  assert.match(`${rejected.stderr}\n${rejected.stdout}`, /top3\.data-stratum-min-percent 应为 55/);
  assert.equal(await readFile(manifestPath, "utf8"), manifestBeforeDrift, "失败时不得重写清单");
});

test("驾驶舱不静态声称 Git 是否已提交或被忽略", async () => {
  const dashboard = await readRepo("business-docs/00-项目驾驶舱.md");
  assert.doesNotMatch(dashboard, /尚未提交或推送|仍受本仓库本地排除规则影响/);
  assert.match(dashboard, /git check-ignore/);
  assert.match(dashboard, /git log -1 --oneline/);
});
