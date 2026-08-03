import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deriveProjectStatus,
  isChecked,
  isMeetingLifecycleClosed,
  meetingLifecycleState,
} from "../../business-docs/08-工具/customer_project_status.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const projectRoot = path.join(repoRoot, "business-docs/01-客服Agent项目");

async function currentSources() {
  const [charter, schedule, ledger, scope, cost] = await Promise.all(
    ["00-项目章程.md", "01-总排期与阶段门禁.md", "02-G0责任与证据台账.md", "03-Scope与验收.md", "04-费用与成本控制.md"].map(
      (file) => readFile(path.join(projectRoot, file), "utf8")
    )
  );
  return { charter, schedule, ledger, scope, cost };
}

function replaceStatus(ledger, label, value) {
  return ledger.replace(
    new RegExp(`^(\\| ${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")} \\|) [^|]+(\\|)`, "m"),
    `$1 **${value}** $2`
  );
}

function replaceSignRow(ledger, label, value) {
  const marker = "### G0 签发记录";
  const start = ledger.indexOf(marker);
  assert.ok(start >= 0, "测试夹具缺少 G0 签发记录");
  return ledger.slice(0, start) + ledger.slice(start).replace(
    new RegExp(`^(\\| ${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")} \\|) [^|]*(\\|)`, "m"),
    `$1 ${value} $2`
  );
}

function replaceGateStatus(ledger, gateId, status, evidence = "") {
  return ledger
    .split("\n")
    .map((line) => {
      if (!line.startsWith(`| ${gateId} |`)) return line;
      const cells = line.split("|");
      cells[6] = ` ${status} `;
      if (evidence) cells[7] = ` ${evidence} `;
      return cells.join("|");
    })
    .join("\n");
}

function passAllExternal(ledger) {
  return ledger
    .split("\n")
    .map((line) => {
      if (!/^\| G0-(?:0[2-9]|1[0-5]) \|/.test(line)) return line;
      const cells = line.split("|");
      cells[6] = " **Pass** ";
      cells[7] = ` EVD-${cells[1].trim()} `;
      return cells.join("|");
    })
    .join("\n");
}

function passAllScope(scope) {
  return scope
    .split("\n")
    .map((line) => {
      if (!/^\| (?:[1-9]|1[0-5]) \|/.test(line)) return line;
      const cells = line.split("|");
      cells[4] = " [X] ";
      cells[5] = ` EVD-SCOPE-${cells[1].trim().padStart(2, "0")} `;
      return cells.join("|");
    })
    .join("\n");
}

function fillCoreRaci(ledger) {
  const roles = new Set(["项目负责人", "客服业务 Owner", "内容 / 话术 Owner", "预算责任人", "IT / 安全责任人", "IT 服务 / 运维责任人", "设计负责人", "前端负责人", "后端负责人", "AI / RAG 负责人", "QA 负责人", "数据 / 内容接口人", "业务验收人"]);
  const roleTokens = new Map([...roles].map((role, index) => [role, `R${String(index + 1).padStart(2, "0")}`]));
  const marker = "## 5. RACI 具名区";
  const start = ledger.indexOf(marker);
  assert.ok(start >= 0, "测试夹具缺少 RACI 具名区");
  const before = ledger.slice(0, start);
  const section = ledger.slice(start).split("\n").map((line) => {
    const cells = line.split("|");
    const role = cells[1]?.trim();
    if (!roles.has(role)) return line;
    const token = roleTokens.get(role);
    cells[2] = ` ROLE-${token} `;
    cells[3] = ` ROLE-${token}-PROXY `;
    cells[4] = ` EVD-RACI-${token} `;
    cells[5] = " 已接受 ";
    return cells.join("|");
  }).join("\n");
  return before + section;
}

function fullyAdvance(sources, ddev = "2026-08-14") {
  sources.ledger = passAllExternal(sources.ledger);
  sources.ledger = fillCoreRaci(sources.ledger);
  for (const [label, value] of [
    ["公司正式批准", "已完成"],
    ["业务问题优先级", "已核验"],
    ["项目阶段", "Ddev / 开发期"],
    ["外部责任包", "14/14 Pass"],
    ["Scope 检查", "15/15 Pass"],
    ["G0 签发", "已签发"],
    ["Ddev", ddev],
    ["资源基线", "最小跨职能小队"],
  ]) sources.ledger = replaceStatus(sources.ledger, label, value);
  for (const [label, value] of [
    ["评审时间", "2026-08-14 15:00"],
    ["评审输入版本", "章程 v3.2 / 台账 v3.3 / Scope v3.3 / 排期 v3.2"],
    ["G0-02～15", "Pass 14 / 14；Fail 0 / 14"],
    ["Scope 检查", "Pass 15 / 15；Fail 0 / 15"],
    ["业务审核人", "ROLE-BUSINESS-APPROVER / EVD-SIGN-BUSINESS"],
    ["IT / 安全审核人", "ROLE-SECURITY-APPROVER / EVD-SIGN-SECURITY"],
    ["预算审核人", "ROLE-BUDGET-APPROVER / EVD-SIGN-BUDGET"],
    ["项目审核人", "ROLE-PROJECT-APPROVER / EVD-SIGN-PROJECT"],
    ["结论", "[X] Pass　[ ] Fail"],
    ["阻塞行动项", "无"],
    ["证据包 ID", "EVD-G0-PACK-20260814"],
    ["Ddev", ddev],
  ]) sources.ledger = replaceSignRow(sources.ledger, label, value);
  sources.scope = passAllScope(sources.scope);
  sources.cost = sources.cost
    .replace("- [ ] **B 费用后置：** 走公司 IT / 数字化统一采购", "- [X] **B 费用后置：** 走公司 IT / 数字化统一采购")
    .replace("| 预算 / 费用责任人（仅 1 人） | |", "| 预算 / 费用责任人（仅 1 人） | ROLE-BUDGET-OWNER / EVD-BUDGET |")
    .replace("| 费用科目 / 采购路径 | |", "| 费用科目 / 采购路径 | IT 统一采购 / EVD-PROCUREMENT |")
    .replace("| B 下次费用决策日 | |", "| B 下次费用决策日 | 2026-08-20 |");
  return sources;
}

test("当前 2/29 真源动态导出七条状态轴与临时 B", async () => {
  const status = deriveProjectStatus(await currentSources());
  assert.deepEqual(status.statusAxes, {
    direction: "P0 · 工作方向已登记",
    approval: "公司批准 · 已批准",
    "problem-fit": "问题适配 · PRECONFIRM · 待核验",
    external: "外部责任包 · 1 / 14",
    scope: "Scope · 1 / 15",
    resource: "资源基线 · 未选择",
    ddev: "Ddev · 未成立",
  });
  assert.equal(status.feePath, "B · 临时管控，未签");
  assert.equal(status.ddevReady, false);
  assert.equal(isChecked("[X]"), true);
  assert.equal(isMeetingLifecycleClosed(status), false);
});

test("启动会生命周期对正向、否决、暂停和开发授权结论统一关闭", () => {
  const openStatus = {
    approvalReady: true,
    problemFit: "PRECONFIRM · 待核验",
    g0: "未签发",
    feePathCode: "B",
    development: "未开发",
    ddevReady: false,
  };
  assert.equal(isMeetingLifecycleClosed(openStatus), false);
  assert.equal(meetingLifecycleState(openStatus), "open");
  assert.equal(
    meetingLifecycleState({ ...openStatus, approvalReady: false }),
    "not-eligible"
  );
  assert.equal(isMeetingLifecycleClosed({ ...openStatus, approvalReady: false }), false);
  for (const problemFit of ["已核验", "已确认", "Pass", "Fail", "未通过"]) {
    assert.equal(isMeetingLifecycleClosed({ ...openStatus, problemFit }), true, problemFit);
    assert.equal(meetingLifecycleState({ ...openStatus, problemFit }), "closed", problemFit);
  }
  assert.equal(isMeetingLifecycleClosed({ ...openStatus, g0: "Fail" }), true);
  assert.equal(isMeetingLifecycleClosed({ ...openStatus, feePathCode: "C" }), true);
  assert.equal(isMeetingLifecycleClosed({ ...openStatus, development: "已暂停" }), true);
  assert.equal(isMeetingLifecycleClosed({ ...openStatus, ddevReady: true }), true);
});

test("批准汇总与 G0-02 明细不一致时拒绝构建", async () => {
  const sources = await currentSources();
  sources.ledger = replaceGateStatus(sources.ledger, "G0-02", "待办");
  sources.ledger = replaceStatus(sources.ledger, "外部责任包", "0/14 Pass");
  assert.throws(() => deriveProjectStatus(sources), /G0-02/);
});

test("2/29 时仅填写 Ddev 日期不得制造开发授权", async () => {
  const sources = await currentSources();
  sources.ledger = replaceStatus(sources.ledger, "Ddev", "2026-08-14");
  assert.throws(() => deriveProjectStatus(sources), /G0 未正式签发/);
});

test("全部证据与 G0 一致通过后，合法日期 Ddev 和正式 B 可成立", async () => {
  const sources = fullyAdvance(await currentSources());
  const status = deriveProjectStatus(sources);
  assert.equal(status.externalPass, 14);
  assert.equal(status.scopePass, 15);
  assert.equal(status.g0Ready, true);
  assert.equal(status.ddevReady, true);
  assert.equal(status.feePathCode, "B");
});

test("Ddev 日期早于章程下限、未知阶段或伪装的未开始文案均拒绝", async () => {
  const early = fullyAdvance(await currentSources(), "2020-01-01");
  assert.throws(() => deriveProjectStatus(early), /不得早于/);

  const unknownStage = await currentSources();
  unknownStage.ledger = replaceStatus(unknownStage.ledger, "项目阶段", "banana");
  assert.throws(() => deriveProjectStatus(unknownStage), /项目阶段不是受控状态/);

  const deceptive = await currentSources();
  deceptive.ledger = replaceStatus(deceptive.ledger, "产品开发", "已开始（不是未开始）");
  assert.throws(() => deriveProjectStatus(deceptive), /产品开发.*不是受控状态/);

  const invalidCalendar = fullyAdvance(await currentSources(), "2026-02-31");
  assert.throws(() => deriveProjectStatus(invalidCalendar), /有效日历日期/);

  const identifierOnly = await currentSources();
  identifierOnly.ledger = replaceStatus(identifierOnly.ledger, "Ddev", "DDEV-001");
  assert.throws(() => deriveProjectStatus(identifierOnly), /Ddev 状态格式无效/);

  const beforeReview = fullyAdvance(await currentSources(), "2026-08-14");
  beforeReview.ledger = replaceSignRow(beforeReview.ledger, "评审时间", "2026-08-20 15:00");
  assert.throws(() => deriveProjectStatus(beforeReview), /不得早于 G0 评审/);
});

test("C 暂停可保持未开发，但不得通过 Scope #11 或签发 Ddev", async () => {
  const sources = await currentSources();
  sources.cost = sources.cost.replace(
    "- [ ] **C 暂停执行：** 原因 ________；下次复核日期 ________",
    "- [x] **C 暂停执行：** 原因 业务证据不足；下次复核日期 2026-08-20"
  );
  sources.ledger = sources.ledger
    .split("\n")
    .map((line) => {
      if (!/^\| G0-07 \|/.test(line)) return line;
      const cells = line.split("|");
      cells[6] = " **Pass** ";
      cells[7] = " EVD-G0-07 ";
      return cells.join("|");
    })
    .join("\n");
  sources.ledger = fillCoreRaci(sources.ledger);
  sources.ledger = replaceStatus(sources.ledger, "外部责任包", "2/14 Pass");
  sources.ledger = replaceStatus(sources.ledger, "产品开发", "已暂停");
  const paused = deriveProjectStatus(sources);
  assert.equal(paused.feePathCode, "C");
  assert.equal(paused.feePauseReason, "业务证据不足");
  assert.equal(paused.feeDecisionDate, "2026-08-20");
  assert.equal(paused.ddevReady, false);

  sources.scope = sources.scope.replace(
    /^(\| 11 \|[^\n]+\|) \[ \] \|[^\n]+$/m,
    "$1 [x] | EVD-SCOPE-11 |"
  );
  sources.ledger = replaceStatus(sources.ledger, "Scope 检查", "2/15 Pass");
  assert.throws(() => deriveProjectStatus(sources), /C 暂停路径/);
});

test("门禁 ID、状态和已勾 Scope 的证据必须可追溯", async () => {
  const badGate = await currentSources();
  badGate.ledger = badGate.ledger.replace("| G0-15 |", "| G0-99 |");
  assert.throws(() => deriveProjectStatus(badGate), /G0-01～G0-15/);

  const notPass = await currentSources();
  notPass.ledger = notPass.ledger.replace(/^(\| G0-02 \|(?:[^|]*\|){4}) [^|]+/m, "$1 Not Pass");
  assert.throws(() => deriveProjectStatus(notPass), /不是受控门禁状态/);

  const checkedWithoutEvidence = await currentSources();
  checkedWithoutEvidence.scope = checkedWithoutEvidence.scope.replace(
    /^(\| 2 \|[^\n]+\|) \[ \] \|[^\n]+$/m,
    "$1 [x] | 批准记录 EVD-* ID：____ |"
  );
  checkedWithoutEvidence.ledger = replaceStatus(checkedWithoutEvidence.ledger, "Scope 检查", "2/15 Pass");
  assert.throws(() => deriveProjectStatus(checkedWithoutEvidence), /Scope #2.*可追溯外部证据/);

  const rawUrlOnly = await currentSources();
  rawUrlOnly.scope = rawUrlOnly.scope.replace(
    /^(\| 2 \|[^\n]+\|) \[ \] \|[^\n]+$/m,
    "$1 [x] | https://example.invalid/approval |"
  );
  rawUrlOnly.ledger = replaceStatus(rawUrlOnly.ledger, "Scope 检查", "2/15 Pass");
  assert.throws(() => deriveProjectStatus(rawUrlOnly), /Scope #2.*可追溯/);

  const duplicateScope = await currentSources();
  duplicateScope.scope = duplicateScope.scope.replace(/^\| 15 \|/m, "| 14 |");
  assert.throws(() => deriveProjectStatus(duplicateScope), /Scope #1～#15/);

  const smuggledEvidence = await currentSources();
  smuggledEvidence.scope = smuggledEvidence.scope.replace(
    /^(\| 2 \|[^\n]+\|) \[ \] \|[^\n]+$/m,
    "$1 [x] | 原始链接 https://example.invalid EVD-SCOPE-01 |"
  );
  smuggledEvidence.ledger = replaceStatus(smuggledEvidence.ledger, "Scope 检查", "2/15 Pass");
  assert.throws(() => deriveProjectStatus(smuggledEvidence), /Scope #2.*可追溯/);
});

test("RACI 人员代号与签发证据不得夹带姓名或原始链接", async () => {
  const namedRaci = fullyAdvance(await currentSources());
  namedRaci.ledger = namedRaci.ledger.replace(
    /^\| 项目负责人 \| ROLE-R01 /m,
    "| 项目负责人 | 张三 ROLE-R01 "
  );
  assert.throws(() => deriveProjectStatus(namedRaci), /RACI 项目负责人 人员代号\s*格式无效/);

  const linkedReviewer = fullyAdvance(await currentSources());
  linkedReviewer.ledger = replaceSignRow(
    linkedReviewer.ledger,
    "业务审核人",
    "ROLE-BUSINESS-APPROVER / https://example.invalid / EVD-SIGN-BUSINESS"
  );
  assert.throws(
    () => deriveProjectStatus(linkedReviewer),
    /业务审核人.*不得夹带姓名或链接/
  );
});

test("A 费用路径未填写责任人、cap 与批准证据时不得显示费用可用", async () => {
  const sources = await currentSources();
  sources.cost = sources.cost.replace("- [ ] **A 费用可用：**", "- [x] **A 费用可用：**");
  sources.ledger = sources.ledger
    .split("\n")
    .map((line) => {
      if (!/^\| G0-07 \|/.test(line)) return line;
      const cells = line.split("|");
      cells[6] = " **Pass** ";
      cells[7] = " EVD-G0-07 ";
      return cells.join("|");
    })
    .join("\n");
  sources.ledger = fillCoreRaci(sources.ledger);
  sources.ledger = replaceStatus(sources.ledger, "外部责任包", "2/14 Pass");
  assert.throws(() => deriveProjectStatus(sources), /A 路径缺少必填批准项/);
});

test("A 费用路径拒绝伪金额与伪批准，合法 cap 必须月不高于全期", async () => {
  const prepareA = async () => {
    const sources = await currentSources();
    sources.cost = sources.cost
      .replace("- [ ] **A 费用可用：**", "- [x] **A 费用可用：**")
      .replace("| 预算 / 费用责任人（仅 1 人） | |", "| 预算 / 费用责任人（仅 1 人） | ROLE-BUDGET-OWNER / EVD-BUDGET |")
      .replace("| 客服项目月 cap | |", "| 客服项目月 cap | CNY 1000 |")
      .replace("| 客服项目全期 cap | |", "| 客服项目全期 cap | CNY 5000 |")
      .replace("| 费用科目 / 采购路径 | |", "| 费用科目 / 采购路径 | COST-CENTER-01 |")
      .replace("| 预警阈值与通知人 | |", "| 预警阈值与通知人 | 80% / ROLE-BUDGET-OWNER |")
      .replace("| 超线停扩授权 | |", "| 超线停扩授权 | EVD-STOP-AUTH |")
      .replace("| 批准人代号 / 日期 / 决定摘要 / 证据 ID | |", "| 批准人代号 / 日期 / 决定摘要 / 证据 ID | ROLE-CAP-APPROVER / 2026-08-05 / 同意 / EVD-CAP-APPROVAL |");
    sources.ledger = sources.ledger
      .split("\n")
      .map((line) => {
        if (!/^\| G0-07 \|/.test(line)) return line;
        const cells = line.split("|");
        cells[6] = " **Pass** ";
        cells[7] = " EVD-G0-07 ";
        return cells.join("|");
      })
      .join("\n");
    sources.ledger = fillCoreRaci(sources.ledger);
    sources.ledger = replaceStatus(sources.ledger, "外部责任包", "2/14 Pass");
    return sources;
  };

  const valid = await prepareA();
  assert.equal(deriveProjectStatus(valid).feePathCode, "A");

  const badAmount = await prepareA();
  badAmount.cost = badAmount.cost.replace("CNY 1000", "banana");
  assert.throws(() => deriveProjectStatus(badAmount), /正数金额/);

  const inverted = await prepareA();
  inverted.cost = inverted.cost.replace("CNY 1000", "CNY 6000");
  assert.throws(() => deriveProjectStatus(inverted), /月 cap 不得高于全期 cap/);

  const fakeApproval = await prepareA();
  fakeApproval.cost = fakeApproval.cost.replace("ROLE-CAP-APPROVER / 2026-08-05 / 同意 / EVD-CAP-APPROVAL", "banana");
  assert.throws(() => deriveProjectStatus(fakeApproval), /批准人代号/);

  const namedOwner = await prepareA();
  namedOwner.cost = namedOwner.cost.replace(
    "ROLE-BUDGET-OWNER / EVD-BUDGET",
    "张三 ROLE-BUDGET-OWNER / EVD-BUDGET"
  );
  assert.throws(() => deriveProjectStatus(namedOwner), /预算 \/ 费用责任人.*不得夹带姓名或链接/);

  const linkedStopAuthority = await prepareA();
  linkedStopAuthority.cost = linkedStopAuthority.cost.replace(
    "EVD-STOP-AUTH",
    "https://example.invalid EVD-STOP-AUTH"
  );
  assert.throws(() => deriveProjectStatus(linkedStopAuthority), /超线停扩授权.*EVD/);
});

test("G0 必须由全部 15 项门禁和完整签发记录共同授权", async () => {
  const emptySignature = fullyAdvance(await currentSources());
  for (const label of ["评审时间", "业务审核人", "证据包 ID"]) {
    emptySignature.ledger = replaceSignRow(emptySignature.ledger, label, "");
  }
  assert.throws(() => deriveProjectStatus(emptySignature), /G0 已签发|G0 证据包/);

  const missingG001 = fullyAdvance(await currentSources());
  missingG001.ledger = replaceGateStatus(missingG001.ledger, "G0-01", "待办");
  assert.throws(() => deriveProjectStatus(missingG001), /G0 不得|G0-01/);

  const missingResourceBaseline = fullyAdvance(await currentSources());
  missingResourceBaseline.ledger = replaceStatus(missingResourceBaseline.ledger, "资源基线", "未选择");
  assert.throws(() => deriveProjectStatus(missingResourceBaseline), /G0-14 Pass.*资源基线/);

  const missingOwner = fullyAdvance(await currentSources());
  missingOwner.ledger = missingOwner.ledger.replace(/^\| 客服业务 Owner \|[^\n]+$/m, "| 客服业务 Owner | | | | 待填 |");
  assert.throws(() => deriveProjectStatus(missingOwner), /客服业务 Owner.*人员与代理人代号/);

  const missingQa = fullyAdvance(await currentSources());
  missingQa.ledger = missingQa.ledger.replace(/^\| QA 负责人 \|[^\n]+$/m, "| QA 负责人 | | | | 待填 |");
  assert.throws(() => deriveProjectStatus(missingQa), /QA 负责人.*人员与代理人代号/);

  const selfApproved = fullyAdvance(await currentSources());
  selfApproved.ledger = selfApproved.ledger.replace(/^\| 预算责任人 \| ROLE-R04 /m, "| 预算责任人 | ROLE-R01 ");
  assert.throws(() => deriveProjectStatus(selfApproved), /职责分离/);

  const staleVersions = fullyAdvance(await currentSources());
  staleVersions.ledger = replaceSignRow(
    staleVersions.ledger,
    "评审输入版本",
    "章程 v1.0 / 台账 v1.0 / Scope v1.0 / 排期 v1.0"
  );
  assert.throws(() => deriveProjectStatus(staleVersions), /签发输入.*版本.*与当前真源/);
});

test("阶段与 G0 状态必须双向一致，Fail 也必须由明细驱动", async () => {
  const awaitingWithoutG0 = await currentSources();
  awaitingWithoutG0.ledger = replaceStatus(awaitingWithoutG0.ledger, "项目阶段", "G0 已通过 / 待 Ddev");
  assert.throws(() => deriveProjectStatus(awaitingWithoutG0), /G0 未签发/);

  const gateFail = await currentSources();
  gateFail.ledger = replaceGateStatus(gateFail.ledger, "G0-02", "Fail");
  gateFail.ledger = replaceStatus(gateFail.ledger, "公司正式批准", "Fail");
  gateFail.ledger = replaceStatus(gateFail.ledger, "外部责任包", "0/14 Pass");
  assert.throws(() => deriveProjectStatus(gateFail), /G0 签发汇总必须为 Fail/);
});

test("正式 G0 Fail 也必须有完整签发记录，不能用空表制造结论", async () => {
  const sources = await currentSources();
  sources.ledger = replaceGateStatus(sources.ledger, "G0-02", "Fail");
  for (const [label, value] of [
    ["公司正式批准", "Fail"],
    ["外部责任包", "0/14 Pass"],
    ["G0 签发", "Fail"],
  ]) sources.ledger = replaceStatus(sources.ledger, label, value);
  for (const [label, value] of [
    ["评审时间", "2026-08-14 15:00"],
    ["评审输入版本", "章程 v3.2 / 台账 v3.3 / Scope v3.3 / 排期 v3.2"],
    ["G0-02～15", "Pass 0 / 14；Fail 1 / 14"],
    ["Scope 检查", "Pass 1 / 15；Fail 14 / 15"],
    ["业务审核人", "ROLE-BUSINESS-APPROVER / EVD-SIGN-BUSINESS"],
    ["IT / 安全审核人", "ROLE-SECURITY-APPROVER / EVD-SIGN-SECURITY"],
    ["预算审核人", "ROLE-BUDGET-APPROVER / EVD-SIGN-BUDGET"],
    ["项目审核人", "ROLE-PROJECT-APPROVER / EVD-SIGN-PROJECT"],
    ["结论", "[ ] Pass　[X] Fail"],
    ["阻塞行动项", "补公司批准证据后复审"],
    ["证据包 ID", "EVD-G0-FAIL-20260814"],
    ["Ddev", "未成立"],
  ]) sources.ledger = replaceSignRow(sources.ledger, label, value);
  assert.equal(deriveProjectStatus(sources).g0, "Fail");

  sources.ledger = replaceSignRow(sources.ledger, "业务审核人", "");
  assert.throws(() => deriveProjectStatus(sources), /业务审核人/);
});
