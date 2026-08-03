import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertMeetingAgendaConsistency } from "../../business-docs/08-工具/customer_project_meeting.mjs";
import { deriveProjectStatus } from "../../business-docs/08-工具/customer_project_status.mjs";
import { readMeetingProposal } from "../../business-docs/08-工具/customer_project_surface_model.mjs";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(siteRoot, "..");
const projectRoot = path.join(repoRoot, "business-docs/01-客服Agent项目");

const readProject = (file) => readFile(path.join(projectRoot, file), "utf8");
const readRepo = (file) => readFile(path.join(repoRoot, file), "utf8");

function assertFinalReviewEvidence(evidence, status, report) {
  const expectedExternal = `${status.externalPass}/${status.externalTotal}`;
  const expectedScope = `${status.scopePass}/${status.scopeTotal}`;
  const expectedTotal = `${status.externalPass + status.scopePass}/${status.externalTotal + status.scopeTotal}`;
  assert.equal(evidence.evidenceVersion, "2.0", "终审证据版本必须显式升级");
  assert.equal(evidence.scope, "repository-static-doc-code-and-automated-browser-evidence");
  assert.equal(evidence.result, "PASS");
  assert.deepEqual(evidence.score, {
    dimensions: 9,
    minimum: 10,
    mean: 10,
    openP0: 0,
    openP1: 0,
  });
  assert.equal(
    evidence.businessState.externalResponsibilityPass,
    expectedExternal,
    `终审 evidence 外部责任包必须等于真源 ${expectedExternal}`
  );
  assert.equal(
    evidence.businessState.scopePass,
    expectedScope,
    `终审 evidence Scope 必须等于真源 ${expectedScope}`
  );
  assert.equal(
    evidence.businessState.totalGatePass,
    expectedTotal,
    `终审 evidence 总门禁必须等于真源 ${expectedTotal}`
  );
  assert.equal(evidence.businessState.g0Signed, status.g0Ready);
  assert.equal(evidence.businessState.ddevEstablished, status.ddevReady);
  const inactiveDevelopment = new Set(["未开始", "未开发", "暂停", "已暂停", "停止", "已停止"]);
  assert.equal(evidence.businessState.developmentStarted, !inactiveDevelopment.has(status.development));
  assert.equal(evidence.businessState.productCodeCreated, false);
  assert.equal(evidence.businessState.feePath, status.feePath);
  assert.equal(evidence.businessState.paidSpend, status.paidSpend);
  assert.match(report, /评分边界：[\s\S]+不替代会前业务资料、现场真机、G0、Ddev、灰度或经营结果验收/);
  assert.match(report, /仍为 OPEN 的真实业务与现场事项/);
  assert.match(report, /静态 P0 = 0，P1 = 0/);
}

async function artifactState(paths) {
  return Promise.all(
    paths.map(async (filePath) => ({
      filePath,
      bytes: await readFile(filePath),
      mtimeNs: (await stat(filePath, { bigint: true })).mtimeNs,
    }))
  );
}

test("启动会校准项目侧建议，不冒充客服决定且双议程同构", async () => {
  const [charter, cadence, ledger, onePager] = await Promise.all([
    readProject("00-项目章程.md"),
    readProject("06-启动会与周推进.md"),
    readProject("02-G0责任与证据台账.md"),
    readProject("80-参考/客服Agent一页立项卡.md"),
  ]);
  assert.match(charter, /项目侧推荐“证据型客服助理 \+ 灰度前影子回放”/);
  assert.match(charter, /08-04 由客服确认、修正或否决/);
  assert.match(cadence, /项目侧推荐方案不是客服既定答案/);
  assert.match(cadence, /不在本会与推荐方案做功能投票/);
  assert.match(cadence, /不让客服人员选择编程语言、数据库或 AI 框架/);
  assert.match(cadence, /OPEN（待补证）/);
  assert.match(cadence, /08-03 18:00 前完成会前资料包（按 T-24 入口门管理）/);
  assert.match(cadence, /DEC（已决定）/);
  assert.match(cadence, /PRECONFIRM（会前已填、现场待确认）/);
  assert.match(cadence, /PARKING（不在本会决定）/);
  assert.match(cadence, /最后 8 分钟不得挪用/);
  assert.doesNotMatch(cadence, /## 2\. 120 分钟会议怎么开/);
  assert.match(ledger, /DEC-003[^\n]+已废止/);
  assert.match(ledger, /DEC-009[^\n]+不预设一期答案、不做功能投票/);
  assert.match(ledger, /DEC-011[^\n]+总时长硬限制为 60 分钟/);
  assert.match(ledger, /DEC-012[^\n]+证据型客服助理 \+ 灰度前影子回放[^\n]+PRECONFIRM/);
  assert.match(ledger, /DEC-014[^\n]+2 新手 \+ 2 老手为候选[^\n]+不做显著性主张/);
  for (const [id, title] of [
    ["01", "一期主问题"],
    ["02", "主用户与场景"],
    ["03", "最小闭环"],
    ["04", "做什么 / 不做什么"],
    ["05", "成功 / 停止"],
    ["06", "权威来源"],
    ["07", "试点人口"],
    ["08", "系统约束"],
    ["09", "后续责任"],
  ]) {
    const label = `DEC-REQ-${id} · ${title}`;
    assert.ok(ledger.includes(label), `02 台账缺少统一决定名称：${label}`);
    assert.ok(cadence.includes(label), `06 主持版缺少统一决定名称：${label}`);
  }
  assert.equal(
    (ledger.match(/^\| DEC-REQ-(?:0[1-9]) \| (?:DEC|PRECONFIRM|OPEN|PARKING) \|/gm) || [])
      .length,
    9
  );
  assert.match(onePager, /0～5 边界与分工[\s\S]+52～60 决定回读/);
  for (const text of [charter, cadence, onePager]) {
    assert.doesNotMatch(text, /话术库 MVP-A|独立预评分|强制排序/);
  }
  const agenda = assertMeetingAgendaConsistency(ledger, cadence);
  assert.equal(agenda.length, 8);
  assert.equal(agenda[0].time, "0～5");
  assert.equal(agenda.at(-1).time, "52～60");
  const driftedCadence = cadence.replace("| 0～5 |", "| 0～4 |");
  assert.notEqual(driftedCadence, cadence, "漂移夹具必须实际改动主持版议程");
  assert.throws(
    () => assertMeetingAgendaConsistency(ledger, driftedCadence),
    /需求会议程真源漂移/
  );
  const brokenCoverage = ledger.replace("| 52～60 |", "| 52～59 |");
  const matchingBrokenCadence = cadence.replace("| 52～60 |", "| 52～59 |");
  assert.throws(
    () => assertMeetingAgendaConsistency(brokenCoverage, matchingBrokenCadence),
    /必须完整覆盖 0～60 分钟/
  );
});

test("项目侧建议只从 4P 五个纯文本字段进入会议模型", async () => {
  const ledger = await readProject("02-G0责任与证据台账.md");
  assert.deepEqual(readMeetingProposal(ledger), {
    name: "证据型客服助理",
    phaseOneFocus: "商品话术与活动话术",
    workingBoundary:
      "展示证据，信息不足时澄清，有冲突、过期或无依据时升级；坐席人工确认，不自动发送",
    shadowGate: "冻结历史问题影子回放通过后，再开放 3～5 名坐席",
    meetingAction: "客服确认、修正或否决",
  });

  const markdownProposal = ledger.replace(
    "| 建议名称 | 证据型客服助理 |",
    "| 建议名称 | **证据型客服助理** |"
  );
  assert.equal(readMeetingProposal(markdownProposal).name, "证据型客服助理");
  assert.doesNotMatch(readMeetingProposal(markdownProposal).name, /[*_`\[\]]/);

  const internalTerm = ledger.replace(
    "| 会中动作 | 客服确认、修正或否决 |",
    "| 会中动作 | PRECONFIRM |"
  );
  assert.throws(() => readMeetingProposal(internalTerm), /包含内部状态码或技术术语/);

  const sensitiveLink = ledger.replace(
    "| 会中动作 | 客服确认、修正或否决 |",
    "| 会中动作 | https://internal.example.com |"
  );
  assert.throws(() => readMeetingProposal(sensitiveLink), /包含明显敏感信息/);

  const extraRow = ledger.replace(
    "| 会中动作 | 客服确认、修正或否决 |",
    "| 会中动作 | 客服确认、修正或否决 |\n| 内部备注 | 不得投影 |"
  );
  assert.throws(() => readMeetingProposal(extraRow), /必须且只能有 5 个可投影字段/);
});

test("终审机读证据必须与现行 2/29 真源同源，旧 0/29 不能再次冒充 10.0", async () => {
  const [charter, schedule, ledger, scope, cost, evidenceText, report] = await Promise.all([
    readProject("00-项目章程.md"),
    readProject("01-总排期与阶段门禁.md"),
    readProject("02-G0责任与证据台账.md"),
    readProject("03-Scope与验收.md"),
    readProject("04-费用与成本控制.md"),
    readProject("90-评审/2026-08-01_10.0全链路交叉验收.evidence.json"),
    readProject("90-评审/2026-08-01_10.0全链路交叉验收.md"),
  ]);
  const status = deriveProjectStatus({ charter, schedule, ledger, scope, cost });
  const evidence = JSON.parse(evidenceText);
  assertFinalReviewEvidence(evidence, status, report);

  for (const [field, staleValue, expectedError] of [
    ["externalResponsibilityPass", "0/14", /终审 evidence 外部责任包必须等于真源 1\/14/],
    ["scopePass", "0/15", /终审 evidence Scope 必须等于真源 1\/15/],
    ["totalGatePass", "0/29", /终审 evidence 总门禁必须等于真源 2\/29/],
  ]) {
    const staleEvidence = structuredClone(evidence);
    staleEvidence.businessState[field] = staleValue;
    assert.throws(() => assertFinalReviewEvidence(staleEvidence, status, report), expectedError);
  }
});

test("内容真源与业务验收拆成唯一 A，不再互相覆盖", async () => {
  const [charter, ledger, scope] = await Promise.all([
    readProject("00-项目章程.md"),
    readProject("02-G0责任与证据台账.md"),
    readProject("03-Scope与验收.md"),
  ]);
  assert.match(charter, /业务优先级、业务覆盖与验收 \| 客服业务 Owner/);
  assert.match(charter, /权威内容、字段、版本与发布 \| 内容 \/ 话术 Owner/);
  assert.match(ledger, /G0-06[^\n]+\| 内容 \/ 话术 Owner（待具名）/);
  assert.match(ledger, /G0-09[^\n]+\| 内容 \/ 话术 Owner（待具名）/);
  assert.match(scope, /\| 7 [^\n]+\| 内容 \/ 话术 Owner \|/);
  assert.match(scope, /\| 9 [^\n]+\| 内容 \/ 话术 Owner \|/);
});

test("公开材料不得写入臆测的 HR / 金主身份", async () => {
  const files = await Promise.all([
    readProject("02-G0责任与证据台账.md"),
    readProject("03-Scope与验收.md"),
    readProject("04-费用与成本控制.md"),
    readProject("80-参考/客服Agent一页立项卡.md"),
  ]);
  for (const text of files) {
    assert.doesNotMatch(text, /HR 人事总经理|HR 总经理/);
    assert.doesNotMatch(text, /公司批准人\s*=\s*HR|金主\s*=\s*HR/);
  }
});

test("评测按平台场景分层，单一简单场景不能包办总分", async () => {
  const scope = await readProject("03-Scope与验收.md");
  assert.match(scope, /平台 × 核心意图至少 2 条/);
  assert.match(scope, /单一分层不得超过 40%/);
  assert.match(scope, /六类风险负例为信息不足、内容冲突 \/ 过期、跨平台、错 SKU、越权承诺、敏感信息/);
  assert.match(scope, /缺分层或只报总分不得验收/);
  assert.match(scope, /任一分层未达线即失败，不能用总体均值抵扣/);
  assert.match(scope, /Scope 与验收 v3\.3/);
});

test("执行中心回归内部推进，只向 canonical 09 提供会场入口", async () => {
  const [generator, template, statusModule] = await Promise.all([
    readRepo("business-docs/08-工具/generate_customer_agent_hub.mjs"),
    readRepo("business-docs/08-工具/templates/customer-agent-hub.template.html"),
    readRepo("business-docs/08-工具/customer_project_status.mjs"),
  ]);
  assert.match(generator, /项目侧已有一期建议，8 月 4 日由客服校准并处理未决项/);
  assert.match(generator, /真实任务 · 指标基线 · 权威来源 · 试点与人数/);
  assert.match(statusModule, /新增付费授权 = 0/);
  assert.doesNotMatch(generator, /外包推进节奏/);
  assert.doesNotMatch(template, /data\.prelaunchChecklist\.slice\(/);
  assert.match(template, /document\.querySelector\("#prelaunch-list"\),\s*data\.prelaunchChecklist/);
  assert.match(generator, /prelaunchChecklist\.map\(humanizeMeetingText\)\.slice\(0, 8\)/);
  assert.match(generator, /客服 Agent 一期启动会会前准备/);
  assert.match(generator, /不是需求文档终审、开发前总检查通过或开发开工会/);
  assert.match(template, /项目批准/);
  assert.match(template, /data-meeting-link href="\.\/09-客服Agent需求会汇报\.html"/);
  assert.match(template, /会前准备和内部推进/);
  assert.doesNotMatch(template, /id="agenda"|data\.meeting\.agenda|进入投影主持|52～60 决定回读/);
});

test("三视图导航只把 09 定义为会场主屏", async () => {
  const [rootReadme, dashboard, map, projectReadme, inventory, toolReadme, packageText, historicalIndex] = await Promise.all([
    readRepo("README.md"),
    readRepo("business-docs/00-项目驾驶舱.md"),
    readRepo("business-docs/README.md"),
    readProject("README.md"),
    readRepo("business-docs/分类汇总.md"),
    readRepo("business-docs/08-工具/README.md"),
    readRepo("sites/package.json"),
    readRepo("archive/2026-07-31-ai-project-brief/index.html"),
  ]);
  for (const document of [map, projectReadme, inventory]) {
    assert.match(document, /09-客服Agent需求会汇报\.html/);
    assert.match(document, /08[^\n]*(?:内部推进|内部执行)/);
    assert.doesNotMatch(document, /08[^\n]*(?:生成视图（会场主屏）|当天唯一主屏|点进投影主持)/);
  }
  for (const document of [rootReadme, dashboard]) {
    assert.match(document, /开 08-04 启动会（唯一主屏）[^\n]*09-客服Agent需求会汇报\.html/);
    assert.match(document, /被追问背景时快速过 PRD（备用）[^\n]*07-客服Agent立项PRD\.html/);
    assert.doesNotMatch(document, /开立项会[^\n]*07-客服Agent立项PRD\.html/);
  }
  assert.match(toolReadme, /现行三视图/);
  assert.match(toolReadme, /test_customer_agent_meeting\.mjs --round=ci/);
  const packageJson = JSON.parse(packageText);
  assert.match(packageJson.scripts["test:business"], /test_customer_agent_meeting\.mjs --round=ci/);
  assert.match(historicalIndex, /09-客服Agent需求会汇报\.html">启动会主屏</);
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
    "08-客服Agent立项执行中心.html",
    "09-客服Agent需求会汇报.html",
  ];
  await Promise.all(
    projectFiles.map((file) => copyFile(path.join(projectRoot, file), path.join(fixtureProject, file)))
  );
  for (const file of [
    "check_customer_agent_prd_sources.mjs",
    "customer_project_status.mjs",
    "customer_project_meeting.mjs",
    "customer_project_surface_model.mjs",
    "project_workspace.mjs",
  ]) {
    await copyFile(path.join(repoRoot, "business-docs/08-工具", file), path.join(fixtureTools, file));
  }

  const checker = path.join(fixtureTools, "check_customer_agent_prd_sources.mjs");
  const runUpdate = () => spawnSync(process.execPath, [checker, "--update"], { cwd: fixtureRoot, encoding: "utf8" });
  const initial = runUpdate();
  assert.equal(initial.status, 0, `${initial.stderr}\n${initial.stdout}`);
  const manifestPath = path.join(fixtureProject, "07-客服Agent立项PRD.sources.json");
  const fixturePrdPath = path.join(fixtureProject, "07-客服Agent立项PRD.html");
  const fixtureHubPath = path.join(fixtureProject, "08-客服Agent立项执行中心.html");
  const fixtureMeetingPath = path.join(fixtureProject, "09-客服Agent需求会汇报.html");
  const protectedArtifacts = [fixturePrdPath, manifestPath, fixtureHubPath, fixtureMeetingPath];
  const manifestBeforeDrift = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestBeforeDrift);
  assert.equal(manifest.schemaVersion, 3);
  assert.deepEqual(manifest.contracts.milestones, {
    d0: "2026-08-04",
    g0Date: "2026-08-14",
    g0State: "未签发",
    ddevEarliest: "2026-08-14",
    ddevState: "未成立",
  });
  assert.equal(manifest.contracts.demandMeeting.date, "2026-08-04");
  assert.equal(manifest.contracts.demandMeeting.agendaSha256.length, 64);
  assert.equal(manifest.contracts.resourceBaseline, "未选择");
  assert.deepEqual(manifest.contracts.acceptance, {
    top3OverallMinPercent: 70,
    top3StratumMinPercent: 50,
    top3StratumMinHits: 1,
    citationCorrectPercent: 100,
    negativeMinCases: 12,
    negativeMaxWrongAnswers: 0,
    pilotMinPeople: 3,
    pilotMaxPeople: 5,
    pilotWeeks: 2,
    pilotTasksPerPersonWeek: 5,
    scopePass: 1,
    scopeTotal: 15,
  });
  assert.deepEqual(manifest.contracts.fee, {
    pathCode: "B",
    selected: false,
    paidAuthorization: "0",
  });

  const fixtureLedgerPath = path.join(fixtureProject, "02-G0责任与证据台账.md");
  const ledger = await readFile(fixtureLedgerPath, "utf8");
  const resourceDrift = ledger.replace(
    "| 资源基线 | **未选择** |",
    "| 资源基线 | **最小跨职能小队** |"
  );
  assert.notEqual(resourceDrift, ledger, "fixture 必须实际修改资源基线");
  await writeFile(fixtureLedgerPath, resourceDrift, "utf8");
  const beforeRejectedResource = await artifactState(protectedArtifacts);
  const rejectedResource = runUpdate();
  assert.notEqual(rejectedResource.status, 0, "资源基线变化但 PRD 未更新时不得重签");
  assert.match(`${rejectedResource.stderr}\n${rejectedResource.stdout}`, /资源基线.*最小跨职能小队|resource-baseline/);
  assert.equal(await readFile(manifestPath, "utf8"), manifestBeforeDrift, "资源漂移失败时不得重写清单");
  assert.deepEqual(
    await artifactState(protectedArtifacts),
    beforeRejectedResource,
    "资源契约失败时 PRD / manifest / Hub / Meeting 的字节和 mtime 必须全部不变"
  );
  await writeFile(fixtureLedgerPath, ledger, "utf8");

  const fixtureScopePath = path.join(fixtureProject, "03-Scope与验收.md");
  const scope = await readFile(fixtureScopePath, "utf8");
  const driftedScope = scope.replace(
    "每个已冻结分层 Top3 ≥ **50%**",
    "每个已冻结分层 Top3 ≥ **55%**"
  );
  assert.notEqual(driftedScope, scope, "fixture 必须实际修改分层 Top3 真源");
  await writeFile(fixtureScopePath, driftedScope, "utf8");

  const beforeRejectedContract = await artifactState(protectedArtifacts);
  const rejected = runUpdate();
  assert.notEqual(rejected.status, 0, "只改真源不改 PRD 时 --update 不得成功");
  assert.match(`${rejected.stderr}\n${rejected.stdout}`, /top3\.data-stratum-min-percent 应为 55/);
  assert.equal(await readFile(manifestPath, "utf8"), manifestBeforeDrift, "失败时不得重写清单");
  assert.deepEqual(
    await artifactState(protectedArtifacts),
    beforeRejectedContract,
    "PRD 内容契约失败时四件交付物必须完全不变"
  );

  await writeFile(fixtureScopePath, scope, "utf8");
  const invalidScope = scope.replace(
    "总体正例 Top3 ≥ **70%**",
    "总体正例 Top3 = **待定**"
  );
  assert.notEqual(invalidScope, scope, "fixture 必须实际破坏总体 Top3 真源");
  await writeFile(fixtureScopePath, invalidScope, "utf8");
  const beforeRejectedSource = await artifactState(protectedArtifacts);
  const rejectedSource = runUpdate();
  assert.notEqual(rejectedSource.status, 0, "无法解析的真源必须失败关闭");
  assert.match(`${rejectedSource.stderr}\n${rejectedSource.stdout}`, /无法从真源解析：总体 Top3 门槛/);
  assert.deepEqual(
    await artifactState(protectedArtifacts),
    beforeRejectedSource,
    "非法真源失败时 PRD / manifest / Hub / Meeting 的字节和 mtime 必须全部不变"
  );

  await writeFile(fixtureScopePath, scope, "utf8");
  const fixedTime = new Date("2001-01-01T00:00:00.000Z");
  await Promise.all(protectedArtifacts.map((filePath) => utimes(filePath, fixedTime, fixedTime)));
  const stableBefore = await artifactState(protectedArtifacts);
  const stableUpdate = runUpdate();
  assert.equal(stableUpdate.status, 0, `${stableUpdate.stderr}\n${stableUpdate.stdout}`);
  assert.match(stableUpdate.stdout, /已稳定，未重写/);
  assert.deepEqual(
    await artifactState(protectedArtifacts),
    stableBefore,
    "checker 在内容相同时必须保持 PRD / manifest / Hub / Meeting bytes + mtime 幂等"
  );
});

test("私有根内 PRD 符号链接指向根外时检查器拒绝跟随和写入", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "customer-prd-symlink-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const privateRoot = path.join(fixtureRoot, "private-customer-agent");
  await mkdir(privateRoot, { recursive: true });

  const projectFiles = [
    "00-项目章程.md",
    "01-总排期与阶段门禁.md",
    "02-G0责任与证据台账.md",
    "03-Scope与验收.md",
    "04-费用与成本控制.md",
    "05-全栈交付计划.md",
    "06-启动会与周推进.md",
    "07-客服Agent立项PRD.sources.json",
    "08-客服Agent立项执行中心.html",
    "09-客服Agent需求会汇报.html",
  ];
  await Promise.all(
    projectFiles.map((file) => copyFile(path.join(projectRoot, file), path.join(privateRoot, file)))
  );
  await writeFile(
    path.join(privateRoot, ".customer-project-private.json"),
    `${JSON.stringify({ schemaVersion: 1, visibility: "private" }, null, 2)}\n`,
    "utf8"
  );

  const outsidePrd = path.join(fixtureRoot, "outside-prd.html");
  const linkedPrd = path.join(privateRoot, "07-客服Agent立项PRD.html");
  await copyFile(path.join(projectRoot, "07-客服Agent立项PRD.html"), outsidePrd);
  await symlink(outsidePrd, linkedPrd, "file");
  const protectedArtifacts = [
    outsidePrd,
    path.join(privateRoot, "07-客服Agent立项PRD.sources.json"),
    path.join(privateRoot, "08-客服Agent立项执行中心.html"),
    path.join(privateRoot, "09-客服Agent需求会汇报.html"),
  ];
  const fixedTime = new Date("2001-01-01T00:00:00.000Z");
  await Promise.all(protectedArtifacts.map((filePath) => utimes(filePath, fixedTime, fixedTime)));
  const before = await artifactState(protectedArtifacts);
  const sharedEnv = {
    ...process.env,
    CUSTOMER_PROJECT_MODE: "private",
    CUSTOMER_PROJECT_ROOT: privateRoot,
  };
  const generator = path.join(repoRoot, "business-docs/08-工具/generate_customer_agent_hub.mjs");
  const generated = spawnSync(process.execPath, [generator], {
    cwd: repoRoot,
    env: sharedEnv,
    encoding: "utf8",
  });
  assert.notEqual(generated.status, 0, "Hub 生成器不得跟随 PRD 符号链接");
  assert.match(`${generated.stderr}\n${generated.stdout}`, /PRD 文件不能是符号链接/);
  assert.deepEqual(
    await artifactState(protectedArtifacts),
    before,
    "生成器拒绝符号链接时不得改动根外 PRD、manifest、Hub 或 Meeting"
  );

  const checker = path.join(repoRoot, "business-docs/08-工具/check_customer_agent_prd_sources.mjs");
  const run = spawnSync(process.execPath, [checker, "--update"], {
    cwd: repoRoot,
    env: sharedEnv,
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0, "PRD 符号链接必须失败关闭");
  assert.match(`${run.stderr}\n${run.stdout}`, /PRD 文件不能是符号链接/);
  assert.equal((await lstat(linkedPrd)).isSymbolicLink(), true, "失败后 PRD 链接本身不得被替换");
  assert.deepEqual(
    await artifactState(protectedArtifacts),
    before,
    "符号链接拒绝时根外 PRD 目标、manifest、Hub 和 Meeting 均不得变化"
  );
  assert.deepEqual(
    (await readdir(privateRoot)).filter((name) => name.endsWith(".tmp")),
    [],
    "失败不得残留临时文件"
  );
});

test("驾驶舱不静态声称 Git 是否已提交或被忽略", async () => {
  const dashboard = await readRepo("business-docs/00-项目驾驶舱.md");
  assert.doesNotMatch(dashboard, /尚未提交或推送|仍受本仓库本地排除规则影响/);
  assert.match(dashboard, /git check-ignore/);
  assert.match(dashboard, /git log -1 --oneline/);
});
