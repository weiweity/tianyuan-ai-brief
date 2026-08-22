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
import {
  readAcceptanceContract,
  readMeetingProposal,
} from "../../business-docs/08-工具/customer_project_surface_model.mjs";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(siteRoot, "..");
const projectRoot = path.join(repoRoot, "business-docs/01-客服Agent项目");

const readProject = (file) => readFile(path.join(projectRoot, file), "utf8");
const readRepo = (file) => readFile(path.join(repoRoot, file), "utf8");

function assertHistoricalFinalReviewEvidence(evidence, report) {
  assert.equal(evidence.evidenceVersion, "2.0", "终审证据版本必须显式升级");
  assert.equal(evidence.verifiedAt, "2026-08-01", "历史 evidence 必须保留原始验收日期");
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
    "1/14",
    "2026-08-01 历史 evidence 外部责任包必须保留 1/14"
  );
  assert.equal(
    evidence.businessState.scopePass,
    "1/15",
    "2026-08-01 历史 evidence Scope 必须保留 1/15"
  );
  assert.equal(
    evidence.businessState.totalGatePass,
    "2/29",
    "2026-08-01 历史 evidence 总门禁必须保留 2/29"
  );
  assert.equal(evidence.businessState.g0Signed, false);
  assert.equal(evidence.businessState.ddevEstablished, false);
  assert.equal(evidence.businessState.developmentStarted, false);
  assert.equal(evidence.businessState.productCodeCreated, false);
  assert.equal(evidence.businessState.feePath, "B · 临时管控，未签");
  assert.equal(evidence.businessState.paidSpend, "新增付费授权 = 0");
  assert.match(report, /历史快照 \/ 已被替代/);
  assert.match(report, /当前业务状态仍以 00–06 真源为准/);
  assert.match(report, /外部责任包 \| \*\*1 \/ 14 Pass\*\*/);
  assert.match(report, /Scope \| \*\*1 \/ 15 Pass\*\*/);
  assert.match(report, /当前回归结果只能形成新的证据，不能反写成 2026-08-01 的原始证据/);
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
  assert.match(onePager, /0～5 启动目标[\s\S]+52～60 结果 \/ 下一步/);
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

test("章程与 Scope 必须共同保持风险错误直答为零", async () => {
  const [charter, scope] = await Promise.all([
    readProject("00-项目章程.md"),
    readProject("03-Scope与验收.md"),
  ]);
  assert.equal(readAcceptanceContract(charter, scope).negativeMaxWrongAnswers, 0);
  const weakenedScope = scope.replace("负例错误直答 = **0**", "负例错误直答 = **1**");
  assert.notEqual(weakenedScope, scope, "夹具必须实际放宽错误直答门槛");
  assert.throws(
    () => readAcceptanceContract(charter, weakenedScope),
    /负例错误直答门槛（1 != 0）/
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

test("2026-08-01 终审机读证据保持历史快照自洽，且明确不冒充当前状态", async () => {
  const [evidenceText, report] = await Promise.all([
    readProject("90-评审/2026-08-01_10.0全链路交叉验收.evidence.json"),
    readProject("90-评审/2026-08-01_10.0全链路交叉验收.md"),
  ]);
  const evidence = JSON.parse(evidenceText);
  assertHistoricalFinalReviewEvidence(evidence, report);

  for (const [field, staleValue, expectedError] of [
    ["externalResponsibilityPass", "0/14", /历史 evidence 外部责任包必须保留 1\/14/],
    ["scopePass", "0/15", /历史 evidence Scope 必须保留 1\/15/],
    ["totalGatePass", "0/29", /历史 evidence 总门禁必须保留 2\/29/],
  ]) {
    const staleEvidence = structuredClone(evidence);
    staleEvidence.businessState[field] = staleValue;
    assert.throws(() => assertHistoricalFinalReviewEvidence(staleEvidence, report), expectedError);
  }
});

test("02 §5 是 13 角色与七类 Owner 的唯一回填入口，固定职责不漂移", async () => {
  const [ledger, scope, implementation] = await Promise.all([
    readProject("02-G0责任与证据台账.md"),
    readProject("03-Scope与验收.md"),
    readProject("20-设计-进行中/46-实现设计-开工包.md"),
  ]);
  const marker = "## 5. RACI 具名区";
  assert.equal((ledger.match(/^## 5\. RACI 具名区$/gm) ?? []).length, 1);
  const section = ledger.split(marker)[1]?.split("### 5.1")[0] ?? "";
  assert.ok(section, "02 §5 RACI 段落缺失");
  const tableLines = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));
  assert.deepEqual(
    tableLines[0].slice(1, -1).split("|").map((cell) => cell.trim()),
    ["角色", "人员代号", "代理人代号", "接受职责证据 ID", "状态", "生效日期", "固定职责", "职责分离"]
  );
  const rows = tableLines
    .slice(2)
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));
  assert.equal(rows.length, 13);
  const byRole = new Map(rows.map((row) => [row[0], row]));
  const fixedResponsibilities = new Map([
    ["项目负责人", "项目边界、门禁、排期、资源、CR、Ddev 组织与停启；作为 Tech Owner 最终签发技术基线、OpenAPI、目录、迁移、容量与版本锁"],
    ["客服业务 Owner", "作为 Product Owner 决定业务 Scope、优先级、hit@3 / no-hit、指标与验收阈值、工单分析口径、话术优化待办三态、试点停启与业务升级"],
    ["内容 / 话术 Owner", "权威内容正确性、有效期、复核、发布、下架与回退"],
    ["预算责任人", "费用路径、预算 cap、0 支出、下次决策日与止损"],
    ["IT / 安全责任人", "PII、出域、RBAC、留存删除、DLP、日志与模型许可"],
    ["IT 服务 / 运维责任人", "环境、账号、部署、监控、备份恢复、RPO / RTO 与交接"],
    ["设计负责人", "用户流程、交互、可访问性与 Windows 桌面体验"],
    ["前端负责人", "Electron、飞书登录、UI、升级回退与客户端安全"],
    ["后端负责人", "API、Auth / RBAC、PostgreSQL 事务、worker、outbox 与审计"],
    ["AI / RAG 负责人", "检索、排序、评测、版本与外部模型 / 训练边界"],
    ["QA 负责人", "测试策略、回归、E2E、性能与独立质量门证据"],
    ["数据 / 内容接口人", "四域来源映射、字段、ACL、版本、质量与 EVD 交接"],
    ["业务验收人", "按冻结样本、阈值与 Scope 出具业务 Pass / Fail"],
  ]);
  assert.deepEqual([...byRole.keys()], [...fixedResponsibilities.keys()]);
  for (const [role, responsibility] of fixedResponsibilities) {
    const row = byRole.get(role);
    assert.equal(row[6], responsibility, `${role} 固定职责漂移`);
    assert.ok(row[7], `${role} 职责分离为空`);
  }
  assert.equal(byRole.get("内容 / 话术 Owner")[5], "2026-08-09");
  assert.equal(rows.filter((row) => row[4] === "已接受" || row[4] === "Pass").length, 13);
  assert.match(byRole.get("内容 / 话术 Owner")[3], /EVD-CONTENT-OWNER-ACCEPT-20260809/);
  assert.match(byRole.get("内容 / 话术 Owner")[3], /EVD-RACI-ACCEPTANCE-PACK-20260810/);
  for (const row of rows.filter((entry) => entry[0] !== "内容 / 话术 Owner")) {
    assert.equal(row[3], "EVD-RACI-ACCEPTANCE-PACK-20260810", `${row[0]} 职责接受包漂移`);
  }
  const separatedCodes = ["项目负责人", "客服业务 Owner", "预算责任人", "IT / 安全责任人"]
    .flatMap((role) => byRole.get(role).slice(1, 3));
  assert.equal(new Set(separatedCodes).size, 8, "项目、业务、预算、安全的主责与代理必须是 8 个唯一代号");
  for (const row of rows.filter((entry) => ["待填", "候选"].includes(entry[4]))) {
    assert.equal(row[5], "", `${row[0]} 未接受前不得有生效日期`);
  }

  const ownerProjection = "Product→客服业务 Owner，Tech→项目负责人，Security→IT / 安全责任人，Content→内容 / 话术 Owner，QA→QA 负责人，Ops→IT 服务 / 运维责任人，Cost→预算责任人";
  assert.ok(ledger.includes(ownerProjection));
  const ddevOwnerRow = ledger.split("\n").find((line) => line.startsWith("| 七类 Owner 映射 |")) ?? "";
  for (const mapping of [
    "Product=客服业务 Owner",
    "Tech=项目负责人",
    "Security=IT / 安全责任人",
    "Content=内容 / 话术 Owner",
    "QA=QA 负责人",
    "Ops=IT 服务 / 运维责任人",
    "Cost=预算责任人",
  ]) assert.ok(ddevOwnerRow.includes(mapping), `Ddev 七类 Owner 投影缺少 ${mapping}`);
  assert.match(ddevOwnerRow, /固定从 §5 唯一 RACI 表投影/);
  assert.match(ddevOwnerRow, /不重复填写/);

  const intakeHeader = /^\| 角色 \| 人员代号 \| 代理人代号 \| 接受职责证据 ID \| 状态 \| 生效日期 \| 固定职责 \| 职责分离 \|$/gm;
  assert.equal(
    [ledger, scope, implementation].reduce(
      (total, text) => total + (text.match(intakeHeader) ?? []).length,
      0
    ),
    1
  );
  assert.match(scope, /\| 2 \| 客服业务 Owner \*\*具名\*\*并接受验收责任[^\n]+\[x\][^\n]+EVD-RACI-ACCEPTANCE-PACK-20260810/);
  assert.match(scope, /\| 4 \| 预算责任人、IT \/ 安全责任人、IT 服务 \/ 运维责任人具名[^\n]+\[x\][^\n]+EVD-RACI-ACCEPTANCE-PACK-20260810/);
  assert.match(ledger, /\| 外部责任包 \| \*\*13\/14 Pass\*\* \|/);
  assert.match(ledger, /\| Scope 检查 \| \*\*14\/15 Pass\*\* \|/);
  assert.match(ledger, /\| Ddev \| \*\*空\*\* \|/);
});

test("内容真源与业务验收拆成唯一 A，Owner 与内容治理 SOP 均有受控证据", async () => {
  const [charter, ledger, scope] = await Promise.all([
    readProject("00-项目章程.md"),
    readProject("02-G0责任与证据台账.md"),
    readProject("03-Scope与验收.md"),
  ]);
  assert.match(charter, /业务优先级、业务覆盖与验收 \| USR-CS-OWNER-001/);
  assert.match(
    charter,
    /权威内容、字段、版本与发布 \| USR-CONTENT-001 \/ ROLE-CONTENT-LEAD \|/
  );
  assert.match(
    charter,
    /内容 \/ 话术 Owner \| USR-CONTENT-001 已接受 ROLE-CONTENT-LEAD[^\n]+`EVD-CONTENT-OWNER-ACCEPT-20260809`/
  );
  assert.match(ledger, /> \*\*版本：\*\* v3\.63 · 2026-08-21/);
  assert.match(
    ledger,
    /G0-05[^\n]+\| USR-CONTENT-001 \/ ROLE-CONTENT-LEAD [^\n]+\| \*\*Pass\*\* \| `EVD-CONTENT-OWNER-ACCEPT-20260809`/
  );
  assert.match(
    ledger,
    /G0-06[^\n]+\| USR-CONTENT-001 \/ ROLE-CONTENT-LEAD [^\n]+\| \*\*Pass\*\* \| `EVD-CONTENT-GOVERNANCE-APPROVAL-20260809`/
  );
  const g009Line = ledger.split("\n").find((line) => line.startsWith("| G0-09 |")) ?? "";
  for (const token of [
    "USR-CONTENT-001 / ROLE-CONTENT-LEAD",
    "**进行中**",
    "EVD-G0-09-PRODUCT-CAMPAIGN-SOURCES-20260812",
    "DEC-050",
    "纠正旧事实",
    "NOT_CREATED / UPSTREAM_AUTHORING",
    "Content Lead 指定各域唯一主源",
    "DEC-DDEV-01",
    "不得 Pass",
    "不得开始产品功能代码",
    "本行不计 Pass",
  ]) assert.ok(g009Line.includes(token), `G0-09 事实纠偏行缺少：${token}`);
  assert.match(ledger, /DEC-037[^\n]+Ddev 前补齐[^\n]+不等于 G0-09 \/ Scope #9 Pass/);
  assert.match(
    ledger,
    /DEC-038[^\n]+售前、活动、售后、产品各指定 1 个唯一主表 \/ 主源[^\n]+`reference \/ superseded`[^\n]+暂停状态作为独立业务盘点信息[^\n]+不得与主源并列发布/
  );
  assert.match(
    ledger,
    /DEC-039[^\n]+系统硬拦截[^\n]+`content_current → current release → 四域不可变 source-version bindings`[^\n]+fail-closed[^\n]+迁移、生成类型、运行代码和动态证据尚未实现[^\n]+不构成 G0-09 \/ Scope #9 Pass 或 EVD/
  );
  assert.match(
    ledger,
    /DEC-040[^\n]+正式内容发布[^\n]+飞书 `revision \/ version`[^\n]+受控系统保存导出快照与 SHA-256[^\n]+新的不可变 `srcv_\*`[^\n]+不改变 G0-09、Scope #9、3\/14、3\/15、6\/29 或 Ddev/
  );
  assert.match(
    ledger,
    /DEC-041[^\n]+客服只读已批准 current release[^\n]+D1 \/ D2 \/ D3 仅编辑各自域[^\n]+Content Lead 复核并发布[^\n]+只有独立受控管理员可以修改成员、共享和所有权[^\n]+匿名、全员及持链接可编辑均禁止[^\n]+实际有效 ACL[^\n]+EVD 仍待核验[^\n]+不改变 G0-09、Scope #9、3\/14、3\/15、6\/29 或 Ddev/
  );
  assert.match(
    ledger,
    /DEC-042[^\n]+稳定 Question 身份与版本[^\n]+显式平台\/商品\/有效期范围[^\n]+intent taxonomy[^\n]+风险分级审核[^\n]+受控占位符[^\n]+JCS 治理快照 hash[^\n]+分层质量门[^\n]+不改变 G0-09、Scope #9、3\/14、3\/15、6\/29 或 Ddev/
  );
  assert.match(
    ledger,
    /DEC-048[^\n]+事实前提已由 DEC-050 纠正[^\n]+当前文档已存在[^\n]+不再作为现行依据/
  );
  assert.match(
    ledger,
    /DEC-050[^\n]+售前、售后[^\n]+文档尚未创建[^\n]+上游人员[^\n]+NOT_CREATED \/ UPSTREAM_AUTHORING[^\n]+Content Lead[^\n]+canonical \/ current[^\n]+纠正 DEC-048[^\n]+旧售后 ACL[^\n]+产品 1\/4[^\n]+13\/14、14\/15[^\n]+G0、Ddev 与代码状态均不变/
  );
  assert.match(
    ledger,
    /DEC-049[^\n]+fail-closed 收据门[^\n]+两处必须引用同一整体 EVD[^\n]+四域版本快照、ACL、带分母质量计数和 Content Lead 最终签发均齐全[^\n]+当前四域表仍为 `INCOMPLETE`[^\n]+保持 13\/14、14\/15[^\n]+G0 未签[^\n]+Ddev 为空/
  );
  assert.match(
    ledger,
    /CR-004[^\n]+权威来源发布与检索硬门[^\n]+每个 release 恰好绑定售前 \/ 活动 \/ 售后 \/ 产品四个不可变来源版本[^\n]+永久暂停整步 fail-closed[^\n]+静态机器合同已同批对齐，运行能力尚未实现[^\n]+Ddev 后迁移、代码、真 PG \/ API \/ 客户端实现与测试任务/
  );
  assert.match(ledger, /\| 外部责任包 \| \*\*13\/14 Pass\*\* \|/);
  assert.match(ledger, /\| Scope 检查 \| \*\*14\/15 Pass\*\* \|/);
  assert.match(ledger, /\| Ddev \| \*\*空\*\* \|/);
  assert.match(ledger, /合计 27\/29/);
  assert.match(ledger, /## G0-09 权威来源登记（上游编写与来源创建待补 · 未签发）/);
  assert.match(ledger, /DEC-045[^\n]+资料整理阶段收尾[^\n]+DEV-M0 开工准备窗口[^\n]+DEC-DDEV-01[^\n]+产品功能代码不得开始/);
  assert.match(ledger, /售前、活动、售后、产品每类必须恰好 1 个 `canonical`/);
  assert.match(
    ledger,
    /\| 售前 `presale` \|[^\n]+NOT_CREATED \/ UPSTREAM_AUTHORING[^\n]+上游人员[^\n]+文档尚未创建[^\n]+尚无 `SRC-\* \/ srcv_\*`[^\n]+\|/
  );
  assert.match(
    ledger,
    /\| 售后 `aftersale` \|[^\n]+NOT_CREATED \/ UPSTREAM_AUTHORING[^\n]+上游人员[^\n]+文档尚未创建[^\n]+尚无 `SRC-\* \/ srcv_\*`[^\n]+\|/
  );
  const sourceAclEvidence = new Map([
    ["售前 `presale`", /尚无可核验的现行文档或 ACL EVD/],
    ["活动 `campaign`", /独立 ACL EVD 仍待补/],
    ["售后 `aftersale`", /旧售后 ACL 收据[^|]+历史 \/ 不匹配[^|]+不计当前覆盖/],
    ["产品 `product`", /ACL 4\/4 已核验：`EVD-FEISHU-ACL-PRODUCT-20260810`/],
  ]);
  for (const [domain, aclEvidence] of sourceAclEvidence) {
    const line = ledger.split("\n").find((entry) => entry.includes(`| ${domain} |`));
    assert.ok(line, `missing G0-09 source row: ${domain}`);
    assert.match(line, aclEvidence);
    assert.doesNotMatch(line, /https?:\/\//);
  }
  assert.match(ledger, /SRC-60D6B23861F4FBF5[^\n]+srcv_88af65aa70c894aa[^\n]+632 源行、631 条规范化/);
  assert.match(ledger, /SRC-04A9A86874258A6A[^\n]+srcv_76b9165b2fe31908[^\n]+67 源行、66 条规范化、1 条跳过/);
  const receiptHeading = "### G0-09 机器可核验关闭收据（公开安全投影）";
  const receiptHeader = "| domain | source_ref | source_version_id | snapshot_evd | acl_evd | total_rows | importable_rows | quarantined_rows | quality_evd | final_approver_role | overall_approval_evd | readiness |";
  const receiptLines = ledger.split("\n");
  const receiptHeadingIndex = receiptLines.indexOf(receiptHeading);
  assert.notEqual(receiptHeadingIndex, -1, "G0-09 四域关闭收据 H3 缺失");
  const receiptHeaderIndex = receiptLines.indexOf(receiptHeader, receiptHeadingIndex + 1);
  assert.equal(receiptHeaderIndex, receiptHeadingIndex + 2, "G0-09 关闭收据必须紧跟 H3 且使用精确表头");
  const receiptRows = receiptLines.slice(receiptHeaderIndex + 2, receiptHeaderIndex + 6).map((line) =>
    line.slice(1, -1).split("|").map((cell) => cell.trim())
  );
  assert.deepEqual(receiptRows.map((row) => row[0]), ["presale", "campaign", "aftersale", "product"]);
  assert.equal(receiptRows.every((row) => row.length === 12), true, "四域关闭收据每行必须对齐 12 列");
  assert.equal(receiptRows.every((row) => row[10] === "待补"), true, "整体签发 EVD 不得提前伪造");
  assert.equal(receiptRows.every((row) => row[11] === "INCOMPLETE"), true, "当前四域收据必须全部 fail-closed");
  assert.match(
    ledger,
    /只有四行都变为 `READY`[^\n]+每域 `total_rows = importable_rows \+ quarantined_rows`[^\n]+G0-09、Scope #9 与四行 `overall_approval_evd` 使用同一个形如 `EVD-G0-09-AUTHORITY-SOURCES-YYYYMMDD` 的整体签发收据[^\n]+机器状态才允许关闭/
  );
  assert.equal((ledger.match(/EVD-G0-09-PRODUCT-CAMPAIGN-SOURCES-20260812/g) ?? []).length >= 4, true);
  assert.match(ledger, /EVD-FEISHU-ACL-AFTERSALE-20260810[^\n]+历史 \/ 不匹配[^\n]+不进入当前关闭收据/);
  assert.equal((ledger.match(/EVD-FEISHU-ACL-PRODUCT-20260810/g) ?? []).length >= 1, true);
  assert.match(ledger, /飞书 URL、doc \/ wiki \/ file token、真实标题.*不得进入 Git/);
  assert.match(ledger, /真实 `revision \/ last_modified_at`、导出快照、原始快照 SHA-256.*不得进入 Git/);
  assert.match(ledger, /飞书版本冻结规则（DEC-040）/);
  assert.match(ledger, /`srcv_\*` 复用现有机器合同格式[^\n]+随机生成[^\n]+不能由内容域、日期、标题、URL 或 token 推导/);
  assert.match(ledger, /上游版本缺失、导出失败、快照 hash 不匹配[^\n]+整次发布 fail-closed/);
  assert.match(ledger, /飞书权限基线（DEC-041）/);
  assert.match(ledger, /内容资产与质量基线（DEC-042）/);
  assert.match(ledger, /Question 使用随机稳定 ID 与不可变版本\/hash[^\n]+禁止按导入行序生成/);
  assert.match(ledger, /高风险或冲突内容须 Content Lead 与 `ROLE-CS-MANAGER` 双审/);
  assert.match(ledger, /仅允许 `\{订单号\}` \/ `\{日期\}`[^\n]+缺值禁止复制并二次确认/);
  assert.match(ledger, /501～5000 条抽 10%[^\n]+大于 2% 扩至 30%[^\n]+大于 5% 阻断/);
  assert.match(
    ledger,
    /客服只读的对象是“已批准 current release”，不是飞书起草主源[^\n]+禁止坐席看到 `draft \/ in_review`/
  );
  assert.match(
    ledger,
    /`ROLE-CONTENT-D1 \/ D2 \/ D3`[^\n]+编辑各自登记内容域[^\n]+不得修改成员、共享范围或所有者/
  );
  assert.match(
    ledger,
    /`USR-CONTENT-001 \/ ROLE-CONTENT-LEAD`[^\n]+复核和产品发布[^\n]+拥有飞书编辑权不自动获得产品发布权/
  );
  assert.match(
    ledger,
    /只有独立受控的飞书文档管理员[^\n]+修改共享[^\n]+禁止匿名、全员或“持链接可编辑”[^\n]+机器人 \/ API 默认只读四个登记来源/
  );
  assert.match(
    ledger,
    /售前、售后文档尚未创建[^\n]+原售后 ACL 收据[^\n]+历史 \/ 不匹配证据[^\n]+不计覆盖[^\n]+当前只有产品 1\/4 来源具备可归属的 ACL EVD[^\n]+不把 G0-09 改为 Pass[^\n]+不改变 Scope #9、计数或 Ddev/
  );
  assert.match(
    ledger,
    /`EVD-FEISHU-ACL-AFTERSALE-20260810`[^\n]+历史 \/ 不匹配收据[^\n]+不进入当前关闭收据[^\n]+不能替代售前、活动、售后现行来源缺失的 ACL EVD/
  );
  assert.match(ledger, /`lifecycle_status`：`current \/ suspended`[^\n]+暂停是生命周期，不得混作权威等级/);
  assert.equal((ledger.match(/已定：本类恰好 1 个 `canonical`/g) ?? []).length, 2);
  assert.match(ledger, /最终售前、活动、售后、产品每类必须恰好 1 个 `canonical`/);
  for (const field of [
    "source_ref",
    "authority_status",
    "snapshot_sha256",
    "platform_scope",
    "effective_from / effective_to / review_due_at",
    "quality_counts",
    "approval_evd",
  ]) {
    assert.match(ledger, new RegExp(field.replaceAll("/", "\\/")));
  }
  assert.match(
    scope,
    /\| 3 \| 内容 \/ 话术 Owner \*\*具名\*\* \| USR-CONTENT-001 \/ ROLE-CONTENT-LEAD \| \[x\] \| `EVD-CONTENT-OWNER-ACCEPT-20260809` \|/
  );
  assert.match(
    scope,
    /\| 7 [^\n]+\| USR-CONTENT-001 \/ ROLE-CONTENT-LEAD \| \[x\] \| `EVD-CONTENT-GOVERNANCE-APPROVAL-20260809`[^\n]*\|/
  );
  assert.match(scope, /> \*\*状态：\*\* v4\.36 /);
  const scope9Line = scope.split("\n").find((line) => line.startsWith("| 9 |")) ?? "";
  for (const token of [
    "内容 / 话术 Owner",
    "[ ]",
    "EVD-G0-09-PRODUCT-CAMPAIGN-SOURCES-20260812",
    "DEC-050",
    "DEC-049",
    "NOT_CREATED",
    "UPSTREAM_AUTHORING",
    "创建后须由 Content Lead 指定各域唯一主源",
    "同一个整体 `EVD-G0-09-AUTHORITY-SOURCES-YYYYMMDD`",
    "四域公开安全收据必须全部为 `READY`",
    "两域文档创建与主源指定",
    "售前 / 活动 / 售后现行 ACL EVD",
    "四域质量分母",
    "整体最终签发",
    "不计完成",
    "DEC-DDEV-01",
    "不得 Pass",
    "产品功能代码不得开始",
  ]) {
    assert.ok(scope9Line.includes(token), `Scope #9 缺少收尾边界：${token}`);
  }
  assert.match(
    scope,
    /\| 飞书上游文档实际权限核验 \|[^\n]+\| \[ \] \|[^\n]+产品：`EVD-FEISHU-ACL-PRODUCT-20260810`[^\n]+售前 \/ 售后文档尚未创建[^\n]+旧售后 ACL 收据[^\n]+历史 \/ 不匹配[^\n]+当前有效覆盖仅 1\/4 \|/
  );
  assert.match(
    scope,
    /\| 非当前权威来源尝试进入发布或检索 \|[^\n]+`content_current → current release → 四域不可变 source-version bindings`[^\n]+整步硬拦截并独立留痕[^\n]+自报 `canonical\/current` 无效 \| \[ \] \| \|/
  );
  assert.match(scope, /\| DEC-042 内容资产与质量门 \|[^\n]+稳定 Question 版本[^\n]+高风险\/冲突全审[^\n]+\| \[ \] \| \|/);
  assert.match(scope, /\| 占位符复制 \|[^\n]+`\{订单号\}\/\{日期\}`[^\n]+缺值禁止复制并二次确认[^\n]+\| \[ \] \| \|/);
  assert.match(ledger, /\*\*起草：\*\*[^\n]*`ROLE-CONTENT-D1 \/ D2 \/ D3`[^\n]*不得自审/);
  assert.match(ledger, /\*\*复核：\*\*[^\n]*`USR-CONTENT-001 \/ ROLE-CONTENT-LEAD`[^\n]*批准或驳回/);
  assert.match(ledger, /\*\*发布：\*\*[^\n]*`USR-CONTENT-001 \/ ROLE-CONTENT-LEAD`[^\n]*只发布已批准版本/);
  assert.match(ledger, /\*\*下架：\*\*[^\n]*`USR-CONTENT-001 \/ ROLE-CONTENT-LEAD`[^\n]*不删除旧 release/);
  assert.match(ledger, /\*\*高风险 \/ 冲突裁决：\*\*[^\n]*`ROLE-CS-MANAGER`[^\n]*fail-closed/);
  assert.match(ledger, /\*\*紧急回退：\*\*[^\n]*回退到上一个仍合规的已批准快照/);
  assert.match(ledger, /全程记录必须只追加、不得修改或删除/);
});

test("Ddev 为空时双仓职责保持隔离，绿地签发不冒充其他 G0 Pass", async () => {
  const [ledger, scope, delivery, implementation] = await Promise.all([
    readProject("02-G0责任与证据台账.md"),
    readProject("03-Scope与验收.md"),
    readProject("05-全栈交付计划.md"),
    readProject("20-设计-进行中/46-实现设计-开工包.md"),
  ]);

  assert.match(
    ledger,
    /\| G0-08 \|[^\n]+\| \*\*Pass\*\* \| `EVD-G0-08-GREENFIELD-ISOLATION-20260810` \|/
  );
  assert.match(
    ledger,
    /\| G0-10 \|[^\n]+\| \*\*Pass\*\* \| `EVD-G0-10-PRD-SCOPE-FREEZE-20260810` \|/
  );
  assert.match(
    ledger,
    /\| G0-11 \|[^\n]+\| USR-SECURITY-OWNER-001 \|[^\n]+\| \*\*Pass\*\* \| `EVD-G0-11-SECURITY-BOUNDARY-20260810` \|/
  );
  assert.match(ledger, /### 8\.1 G0-11 安全边界（已批准）/);
  assert.match(
    ledger,
    /> \*\*状态：\*\* `APPROVED \/ SIGNED`[^\n]+`EVD-G0-11-SECURITY-BOUNDARY-20260810`[^\n]+关闭 G0-11 \/ Scope #12[^\n]+不替代真实数据逐批审核、运行负例、备份恢复、训练、Pilot 或 Ddev 授权/
  );
  assert.match(ledger, /一期默认拒绝[^\n]+外部 LLM \/ teacher \/ student[^\n]+客户原文持久化[^\n]+通用底表直读/);
  assert.match(ledger, /\| 客户原文 \| 否 \| 否 \|[^\n]+默认拒绝持久化[^\n]+\*\*0 天\*\*/);
  assert.match(ledger, /\| 订单 \/ 支付信息 \| 否 \| 否 \|[^\n]+原始文件校验 \/ 导入完成即删除[^\n]+0 天/);
  assert.match(ledger, /\| 健康 \/ 过敏等敏感信息 \| 否 \| 否 \|[^\n]+一律拒绝[^\n]+\*\*0 天\*\*/);
  assert.match(ledger, /\[x\] 安全 Owner 已在受控系统留下确认原文、日期与 `EVD-G0-11-SECURITY-BOUNDARY-20260810`/);
  assert.match(ledger, /必须验证（运行取证）：\n\n- \[ \] 未授权和越权访问被拒绝/);
  assert.match(
    ledger,
    /\| G0-12 \|[^\n]+\| USR-OPS-OWNER-001 \|[^\n]+\| \*\*Pass\*\* \| `EVD-G0-12-OPS-DEPLOYMENT-20260810` \|/
  );
  assert.match(ledger, /## 8A\. G0-12 部署与运维签发包（已签）/);
  assert.match(
    ledger,
    /> \*\*状态：\*\* `APPROVED \/ SIGNED`[^\n]+`EVD-G0-12-OPS-DEPLOYMENT-20260810`[^\n]+只关闭 G0-12 \/ Scope #13[^\n]+不授权 G0、Ddev、真实数据或 Pilot/
  );
  assert.match(
    ledger,
    /已签方案基线[^\n]+未来受控测试 profile[^\n]+`single_host`[^\n]+1×API[^\n]+1×TypeScript worker[^\n]+PostgreSQL \*\*15\.18\*\*[^\n]+`multi_instance`[^\n]+另行批准/
  );
  assert.match(
    ledger,
    /\| RPO \/ RTO \|[^\n]+`RPO ≤ 24h \/ RTO ≤ 4h`[^\n]+真 PG 备份[^\n]+演练前只写“目标”/
  );
  assert.match(ledger, /Ddev 与 Pilot Ready 前不得创建产品环境或账号、导入真实数据、邀请坐席、执行外部调用或承诺试点/);
  assert.match(
    ledger,
    /\| G0-14 \|[^\n]+\| \*\*Pass\*\* \| `EVD-G0-14-WBS-CAPACITY-20260813` \/ `EVD-G0-07-FEE-PATH-20260813` \|/
  );
  const g015Row = ledger.split("\n").find((line) => line.startsWith("| G0-15 |"));
  assert.ok(g015Row, "缺少 G0-15 门禁行");
  assert.match(g015Row, /\| \*\*Pass\*\* \| `EVD-G0-15-RUN-HANDOVER-20260812` \|/);
  assert.match(
    ledger,
    /阶段边界[^\n]+Ddev 后 \/ Pilot Ready 前[^\n]+不计入 G0-11 \/ G0-15[^\n]+G0 前只签策略、方案、Owner、目标与证据入口/
  );
  assert.match(ledger, /\| 最终结论 \| \[x\] 绿地隔离通过[^\n]+`EVD-G0-08-GREENFIELD-ISOLATION-20260810`[^\n]+只关闭 G0-08 \/ Scope #8/);
  assert.match(ledger, /已指定独立 Git 仓 `customer-agent-prototype` 为产品实施仓[^\n]+现有 v3 合成原型[^\n]+不计正式 DEV-M0/);
  assert.match(ledger, /\| 外部责任包 \| \*\*13\/14 Pass\*\* \|/);
  assert.match(ledger, /\| Scope 检查 \| \*\*14\/15 Pass\*\* \|/);
  assert.match(ledger, /\| Ddev \| \*\*空\*\* \|/);

  assert.match(scope, /\| 8 \|[^\n]+\| \[x\] \| `EVD-G0-08-GREENFIELD-ISOLATION-20260810` \|/);
  assert.match(scope, /\| 10 \|[^\n]+\| \[x\] \| `EVD-G0-10-PRD-SCOPE-FREEZE-20260810` \|/);
  assert.match(
    scope,
    /\| 12 \|[^\n]+\| USR-SECURITY-OWNER-001 \| \[x\] \| `EVD-G0-11-SECURITY-BOUNDARY-20260810` \|/
  );
  assert.match(
    scope,
    /\| 13 \|[^\n]+\| USR-OPS-OWNER-001 \| \[x\] \| `EVD-G0-12-OPS-DEPLOYMENT-20260810` \|/
  );
  assert.match(
    scope,
    /\| 15 \|[^\n]+Ddev 方案\/授权边界\/签发格式[^\n]+\| \[x\] \| `EVD-G0-14-WBS-CAPACITY-20260813` \/ `EVD-G0-07-FEE-PATH-20260813` \/ `EVD-G0-15-RUN-HANDOVER-20260812` \|/
  );

  assert.match(delivery, /G0-15 · 已批准的运行交接方案/);
  assert.match(delivery, /EVD-G0-15-RUN-HANDOVER-20260812/);
  assert.match(delivery, /项目负责人 \/ Tech Owner[\s\S]+客服业务 Owner \/ Product Owner[\s\S]+IT \/ 安全责任人[\s\S]+IT 服务 \/ 运维责任人[\s\S]+QA 负责人/);
  assert.match(delivery, /真实告警接入、备份恢复、回退和试点演练属于 Ddev 后退出证据/);

  assert.match(delivery, /独立产品实施仓已经存在[\s\S]+customer-agent-prototype\/[\s\S]+不是本项目记录仓的子目录/);
  await assert.rejects(
    lstat(path.join(repoRoot, "customer-service-agent")),
    (error) => error?.code === "ENOENT",
    "项目记录仓不得创建旧 customer-service-agent 产品 runtime 目录"
  );

  const ready = implementation.split("### Ready for DEV-M0")[1]?.split("### Done for DEV-M0")[0] ?? "";
  const doneM0 = implementation.split("### Done for DEV-M0")[1]?.split("### Done for each DEV milestone")[0] ?? "";
  assert.match(implementation, /2026-08-21 · v1\.21/);
  assert.match(implementation, /两个独立 Git 仓不存在“跨仓原子提交”/);
  assert.match(implementation, /contract_set_id[\s\S]+source_git_sha[\s\S]+openapi[\s\S]+database/);
  assert.match(implementation, /export_customer_agent_contract_set\.mjs[\s\S]+完整 40 位[\s\S]+不读当前工作树[\s\S]+拒绝覆盖/);
  for (const anchor of ["机器合同已锁定为", "实际产物必须精确匹配"]) {
    const lines = implementation.split(/\r?\n/).filter((line) => line.includes(anchor));
    assert.ok(lines.length > 0, `missing implementation hash anchor: ${anchor}`);
    for (const line of lines) {
      assert.match(line, /47b667958e522a28df1c04d7c79a56c930bfe0ac04598321824b55744ac4a801/);
      assert.match(line, /06698f233702591c8f981c7b08ebac4b7d5bc5cc2d69d36014ef2a9f5a6802e4/);
    }
  }
  const contractSetTool = await readRepo("business-docs/08-工具/export_customer_agent_contract_set.mjs");
  assert.match(contractSetTool, /完整 40 位 commit SHA/);
  assert.match(contractSetTool, /O_NOFOLLOW/);
  assert.match(contractSetTool, /check-ignore/);
  assert.match(contractSetTool, /ddev_authorized: false/);
  assert.match(contractSetTool, /product_consumed: false/);
  const packageJson = JSON.parse(await readRepo("sites/package.json"));
  assert.match(packageJson.scripts["export:customer-agent-contract-set"], /export_customer_agent_contract_set\.mjs/);
  assert.match(packageJson.scripts["test:customer-agent-contract-set"], /customer-agent-contract-set\.test\.mjs/);
  assert.match(ready, /\[x\] OpenAPI 路径与单向生成方向已冻结/);
  assert.match(ready, /\[x\] CR-004[^\n]+静态机器合同已[^\n]+对齐/);
  assert.match(ready, /Ddev 前[^\n]+reference DDL[^\n]+静态设计预检/);
  assert.match(
    ready,
    /\[x\] Ddev 前\*\*静态安全启动矩阵\*\*[^\n]+EVD-G0-11-SECURITY-BOUNDARY-20260810[^\n]+EVD-G0-12-OPS-DEPLOYMENT-20260810[^\n]+EVD-G0-07-FEE-PATH-20260813/
  );
  assert.match(ready, /\[ \] Ddev 证据存在/);
  assert.match(ready, /不证明 runtime[^\n]+真 OAuth[^\n]+备份恢复[^\n]+Pilot/);
  assert.doesNotMatch(ready, /DEC-042 的迁移\/生成类型\/服务端\/客户端与动态负例/);
  assert.match(doneM0, /Ddev 通过后[^\n]+独立产品仓 `customer-agent-prototype`[^\n]+保留 Git 历史/);
  assert.match(doneM0, /contract_set_id[^\n]+来源 Git SHA[^\n]+OpenAPI \/ DDL 双哈希/);
  assert.match(doneM0, /不可变 migration[^\n]+TypeScript 类型/);
  assert.match(doneM0, /N-only[^\n]+N-1 → N/);
  assert.match(doneM0, /DEC-042[^\n]+runtime[^\n]+动态负例/);
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
  assert.match(scope, /Scope 与验收 v4\.36/);
});

test("一期 Dashboard 明确区分业务工单分析与内部话术优化待办", async () => {
  const [ledger, scope, prd, dashboard, productContract, script, onePager] = await Promise.all([
    readProject("02-G0责任与证据台账.md"),
    readProject("03-Scope与验收.md"),
    readProject("20-设计-进行中/25-PRD草案-客服Agent一期.md"),
    readProject("20-设计-进行中/29-Dashboard产品说明.md"),
    readProject("20-设计-进行中/31-产品契约-v1.md"),
    readProject("99-历史/2026-08-04_客服Agent启动会逐字稿.md"),
    readProject("80-参考/客服Agent一页立项卡.md"),
  ]);

  for (const text of [ledger, scope, prd, dashboard, productContract]) {
    assert.match(text, /工单分析/);
    assert.match(text, /话术优化待办/);
  }
  assert.match(ledger, /DEC-WORKORDER-01[^\n]+一期 Dashboard[^\n]+不接实时写回/);
  assert.match(ledger, /DEC-ITERATION-TASK-01[^\n]+iteration_task[^\n]+不承载业务工单原始明细/);
  assert.match(scope, /20 条正常正例[^\n]+12 条安全负例[^\n]+18 条长尾/);
  assert.match(prd, /50 条且与开发 \/ 调参集不重叠/);
  assert.match(productContract, /工单分析[^\n]+work_order_\*/);
  assert.match(productContract, /话术优化待办[^\n]+iteration_task\*/);

  for (const item of [
    "概览与工具指标",
    "检索 / 复制自动事实流水",
    "工单分析",
    "话术优化待办",
    "内容导入、四域来源绑定与发布",
    "公告、同步与离线租约状态",
  ]) {
    assert.ok(dashboard.includes(item), `Dashboard 信息架构缺少：${item}`);
  }
  assert.match(dashboard, /不写回班牛/);
  assert.match(dashboard, /试点和生产必须使用真实飞书 OAuth、服务端会话与 RBAC/);
  assert.match(prd, /一期 \*\*Windows Electron\*\*；macOS 后续评估；iOS \/ Android 不进一期/);

  for (const historical of [script, onePager]) {
    assert.match(historical, /HISTORICAL \/ PRE-D0 SNAPSHOT/);
    assert.match(historical, /03-Scope与验收\.md/);
  }
  assert.match(script, /25-PRD草案-客服Agent一期\.md/);
  assert.match(onePager, /20-设计-进行中\/README\.md/);
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

test("生命周期导航将 09 保留为需求阶段快照，并把设计目录设为现行主线", async () => {
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
  for (const document of [projectReadme, inventory]) {
    assert.match(document, /09-客服Agent需求会汇报\.html/);
    assert.match(document, /(?:需求|启动会)[^\n]*(?:已完成|快照)|(?:已完成|快照)[^\n]*(?:需求|启动会)/);
  }
  for (const document of [rootReadme, dashboard, map, projectReadme, inventory]) {
    assert.match(document, /设计(?:阶段|进行中|主线)/);
    assert.doesNotMatch(document, /开 08-04 启动会（唯一主屏）/);
  }
  assert.match(toolReadme, /`07\/08` 现行生成视图/);
  assert.match(toolReadme, /`09` D0 冻结快照/);
  assert.match(toolReadme, /D0 生命周期开放[\s\S]*D0 已结束后拒绝直接重写/);
  assert.match(toolReadme, /test_customer_agent_meeting\.mjs --round=ci/);
  const packageJson = JSON.parse(packageText);
  assert.match(packageJson.scripts["test:business"], /test_customer_agent_meeting\.mjs --round=ci/);
  assert.match(historicalIndex, /09-客服Agent需求会汇报\.html">启动会主屏</);
});

test("PRD --update 拒绝可见契约破坏，并自动同步受控状态轴", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "customer-prd-contract-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const fixtureProject = path.join(fixtureRoot, "business-docs/01-客服Agent项目");
  const fixtureTools = path.join(fixtureRoot, "business-docs/08-工具");
  await Promise.all([
    mkdir(fixtureProject, { recursive: true }),
    mkdir(path.join(fixtureProject, "20-设计-进行中"), { recursive: true }),
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
    "20-设计-进行中/37-架构SSOT-v1.md",
    "20-设计-进行中/46-实现设计-开工包.md",
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
  assert.equal(manifest.contracts.resourceBaseline, "单人全栈 / FDE");
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
    scopePass: 14,
    scopeTotal: 15,
  });
  assert.deepEqual(manifest.contracts.fee, {
    pathCode: "B",
    selected: true,
    paidAuthorization: "0",
  });

  const pristinePrd = await readFile(fixturePrdPath, "utf8");
  const missingVisibleDirection = pristinePrd.replace(
    "<span>商品话术</span>",
    "<span>其他话术</span>"
  );
  assert.notEqual(missingVisibleDirection, pristinePrd, "夹具必须实际移除启动会区块中的商品话术");
  assert.match(missingVisibleDirection, /商品话术/, "词语应仍存在于区块外，验证检查范围没有退化为全页搜索");
  await writeFile(fixturePrdPath, missingVisibleDirection, "utf8");
  const rejectedVisibleDirection = runUpdate();
  assert.notEqual(rejectedVisibleDirection.status, 0, "可见启动会建议缺项时不得依赖内嵌真源重签");
  assert.match(
    `${rejectedVisibleDirection.stderr}\n${rejectedVisibleDirection.stdout}`,
    /项目侧建议 商品话术/
  );
  assert.equal(await readFile(manifestPath, "utf8"), manifestBeforeDrift, "可见建议缺项不得重写清单");
  await writeFile(fixturePrdPath, pristinePrd, "utf8");

  const fixtureLedgerPath = path.join(fixtureProject, "02-G0责任与证据台账.md");
  const ledger = await readFile(fixtureLedgerPath, "utf8");
  const resourceDrift = ledger.replace(
    "| 资源基线 | **单人全栈 / FDE** |",
    "| 资源基线 | **最小跨职能小队** |"
  );
  assert.notEqual(resourceDrift, ledger, "fixture 必须实际修改资源基线");
  await writeFile(fixtureLedgerPath, resourceDrift, "utf8");
  const synchronizedResource = runUpdate();
  assert.equal(synchronizedResource.status, 0, `${synchronizedResource.stderr}\n${synchronizedResource.stdout}`);
  const resourceManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(resourceManifest.contracts.resourceBaseline, "最小跨职能小队");
  assert.match(
    await readFile(fixturePrdPath, "utf8"),
    /data-status-axis="resource"[^>]*data-value="最小跨职能小队"[^>]*>资源基线 · 最小跨职能小队/
  );
  await writeFile(fixtureLedgerPath, ledger, "utf8");
  const restoredResource = runUpdate();
  assert.equal(restoredResource.status, 0, `${restoredResource.stderr}\n${restoredResource.stdout}`);
  assert.equal(await readFile(manifestPath, "utf8"), manifestBeforeDrift, "恢复真源后应回到原始稳定清单");

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
  await mkdir(path.join(privateRoot, "20-设计-进行中"), { recursive: true });

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
    "20-设计-进行中/37-架构SSOT-v1.md",
    "20-设计-进行中/46-实现设计-开工包.md",
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
