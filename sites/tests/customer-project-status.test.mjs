import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  authorizationProjectionDigests,
  deriveProjectStatus,
  isChecked,
  isMeetingLifecycleClosed,
  meetingLifecycleState,
} from "../../business-docs/08-工具/customer_project_status.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const projectRoot = path.join(repoRoot, "business-docs/01-客服Agent项目");
const g003MenokinEvidence = "EVD-G0-03-MENOKIN-APPLICABILITY-20260830";
const g009ClosureEvidence = "EVD-G0-09-AUTHORITY-SOURCES-20260830";
const g013MenokinEvidence = "EVD-G0-13-MENOKIN-EVALUATION-FREEZE-20260830";
const g009ClosureHeading = "### G0-09 机器可核验关闭收据（公开安全投影）";
const g009ClosureColumns = [
  "domain",
  "source_ref",
  "source_version_id",
  "snapshot_evd",
  "acl_evd",
  "total_rows",
  "importable_rows",
  "quarantined_rows",
  "quality_evd",
  "final_approver_role",
  "overall_approval_evd",
  "readiness",
];
const readyG009ClosureRows = [
  ["presale", "SRC-A1B2C3D4E5F60101", "srcv_a1b2c3d4e5f60101", "EVD-G0-09-WORKBOOK-CLOSURE-20260830", "EVD-G0-09-ACL-OWNER-BASELINE-20260830", "81", "79", "2", "EVD-G0-09-WORKBOOK-CLOSURE-20260830", "ROLE-CONTENT-LEAD", g009ClosureEvidence, "READY"],
  ["campaign", "SRC-A1B2C3D4E5F60101", "srcv_b1b2c3d4e5f60101", "EVD-G0-09-WORKBOOK-CLOSURE-20260830", "EVD-G0-09-ACL-OWNER-BASELINE-20260830", "4", "4", "0", "EVD-G0-09-WORKBOOK-CLOSURE-20260830", "ROLE-CONTENT-LEAD", g009ClosureEvidence, "READY"],
  ["aftersale", "SRC-A1B2C3D4E5F60101", "srcv_c1c2c3d4e5f60101", "EVD-G0-09-WORKBOOK-CLOSURE-20260830", "EVD-G0-09-ACL-OWNER-BASELINE-20260830", "223", "223", "0", "EVD-G0-09-WORKBOOK-CLOSURE-20260830", "ROLE-CONTENT-LEAD", g009ClosureEvidence, "READY"],
  ["product", "SRC-A1B2C3D4E5F60101", "srcv_d1d2d3d4e5f60101", "EVD-G0-09-WORKBOOK-CLOSURE-20260830", "EVD-G0-09-ACL-OWNER-BASELINE-20260830", "106", "106", "0", "EVD-G0-09-WORKBOOK-CLOSURE-20260830", "ROLE-CONTENT-LEAD", g009ClosureEvidence, "READY"],
].map((values) => Object.fromEntries(g009ClosureColumns.map((column, index) => [column, values[index]])));

async function currentSources({ g0 = "unsigned", ddev = "prepared" } = {}) {
  const [
    charter,
    schedule,
    ledger,
    scope,
    cost,
    architecture,
    implementation,
    g0Authorization,
    ddevAuthorization,
  ] = await Promise.all(
    [
      "00-项目章程.md",
      "01-总排期与阶段门禁.md",
      "02-G0责任与证据台账.md",
      "03-Scope与验收.md",
      "04-费用与成本控制.md",
      "20-设计-进行中/37-架构SSOT-v1.md",
      "20-设计-进行中/46-实现设计-开工包.md",
      "90-评审/2026-08-31_G0正式签发记录.md",
      "90-评审/2026-08-31_Ddev正式签发记录.md",
    ].map(
      (file) => readFile(path.join(projectRoot, file), "utf8")
    )
  );
  const sources = {
    charter,
    schedule,
    ledger,
    scope,
    cost,
    architecture,
    implementation,
    g0Authorization,
    ddevAuthorization,
  };
  if (ddev === "prepared") {
    sources.ledger = resetDdevDecision(sources.ledger);
    sources.ledger = replaceStatus(sources.ledger, "产品开发", "未开始");
  } else {
    assert.equal(ddev, "signed", `未知 Ddev 测试夹具状态：${ddev}`);
    assert.equal(g0, "signed", "Ddev 已签测试夹具必须同时保持 G0 已签");
  }
  if (g0 === "signed") return sources;
  assert.equal(g0, "unsigned", `未知 G0 测试夹具状态：${g0}`);

  sources.ledger = replaceStatus(sources.ledger, "项目阶段", "设计阶段 / G0");
  sources.ledger = replaceStatus(sources.ledger, "G0 签发", "待签发");
  sources.ledger = sources.ledger.replace(
    /^> \*\*当前状态：\*\* `PREPARED`[^\n]*$/m,
    "> **当前状态：** `PREPARED` · **EVIDENCE READY / G0 NOT SIGNED / NOT AUTHORIZED**。"
  );
  for (const [label, value] of [
    ["评审时间", ""],
    ["评审输入版本", "章程 v____ / 台账 v____ / Scope v____ / 排期 v____"],
    ["G0-02～15", "Pass ____ / 14；Fail ____ / 14"],
    ["Scope 检查", "Pass ____ / 15；Fail ____ / 15"],
    ["签发 Owner", ""],
    ["结论", "[ ] Pass　[ ] Fail"],
    ["阻塞行动项", ""],
    ["证据包 ID", ""],
    ["Ddev", "仅 Pass 时填写：____；否则必须为空"],
  ]) sources.ledger = replaceSignRow(sources.ledger, label, value);
  return sources;
}

function requiredVersion(text, pattern, label) {
  const version = text.match(pattern)?.[1];
  assert.ok(version, `测试夹具无法解析${label}版本`);
  return version;
}

function currentSourceVersions(sources) {
  return {
    charter: requiredVersion(sources.charter, /^> \*\*版本：\*\*\s*(v\d+(?:\.\d+)*)/m, "章程"),
    schedule: requiredVersion(sources.schedule, /^> \*\*排期版本：\*\*\s*(v\d+(?:\.\d+)*)/m, "排期"),
    ledger: requiredVersion(sources.ledger, /^> \*\*版本：\*\*\s*(v\d+(?:\.\d+)*)/m, "台账"),
    scope: requiredVersion(sources.scope, /^> \*\*状态：\*\*\s*(v\d+(?:\.\d+)*)/m, "Scope"),
    cost: requiredVersion(sources.cost, /^> \*\*版本：\*\*\s*(v\d+(?:\.\d+)*)/m, "费用"),
    architecture: requiredVersion(sources.architecture, /（当前\s+(v\d+(?:\.\d+)*)(?=[；）])/, "37 架构"),
    implementation: requiredVersion(sources.implementation, /^> \*\*日期：\*\*[^\n]*?·\s*(v\d+(?:\.\d+)*)/m, "46 实现设计"),
  };
}

function authorizationSourceVersions(sources) {
  return {
    charter: requiredVersion(sources.g0Authorization, /^\| 项目章程 \| (v\d+(?:\.\d+)*) \|$/m, "G0 签发章程"),
    ledger: requiredVersion(sources.g0Authorization, /^\| G0 责任与证据台账 \| (v\d+(?:\.\d+)*) \|$/m, "G0 签发台账"),
    scope: requiredVersion(sources.g0Authorization, /^\| Scope 与验收 \| (v\d+(?:\.\d+)*) \|$/m, "G0 签发 Scope"),
    schedule: requiredVersion(sources.g0Authorization, /^\| 总排期与阶段门禁 \| (v\d+(?:\.\d+)*) \|$/m, "G0 签发排期"),
    cost: requiredVersion(sources.ddevAuthorization, /`04` 费用 (v\d+(?:\.\d+)*)/, "Ddev 签发费用"),
    architecture: requiredVersion(sources.ddevAuthorization, /`37` 架构 (v\d+(?:\.\d+)*)/, "Ddev 签发架构"),
    implementation: requiredVersion(sources.ddevAuthorization, /`46` 实现设计 (v\d+(?:\.\d+)*)/, "Ddev 签发实现设计"),
  };
}

function currentFeeDecisionDate(cost) {
  const date = cost.match(/^\| B 下次费用决策日 \| (\d{4}-\d{2}-\d{2}) \|$/m)?.[1];
  assert.ok(date, "测试夹具无法解析 B 下次费用决策日");
  return date;
}

function g0InputVersionText(versions) {
  return `章程 ${versions.charter} / 台账 ${versions.ledger} / Scope ${versions.scope} / 排期 ${versions.schedule}`;
}

function ddevInputVersionText(versions, overrides = {}) {
  const value = { ...versions, ...overrides };
  return `01 排期 ${value.schedule} / 03 Scope ${value.scope} / 04 费用 ${value.cost} / 37 架构 ${value.architecture} / 46 实现设计 ${value.implementation}；EVD-DDEV-AUTH-20260814`;
}

function replaceStatus(ledger, label, value) {
  return ledger.replace(
    new RegExp(`^(\\| ${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")} \\|) [^|]+(\\|)`, "m"),
    `$1 **${value}** $2`
  );
}

function replaceStatusDetail(ledger, label, detail) {
  return ledger
    .split("\n")
    .map((line) => {
      if (!line.startsWith(`| ${label} |`)) return line;
      const cells = line.split("|");
      cells[3] = ` ${detail} `;
      return cells.join("|");
    })
    .join("\n");
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

function replaceAuthorizationField(record, label, value) {
  const pattern = new RegExp(
    `^(> \\*\\*${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}：\\*\\*)[^\\n]*$`,
    "m"
  );
  assert.match(record, pattern, `测试夹具缺少正式签发字段：${label}`);
  return record.replace(pattern, `$1 ${value}`);
}

function refreshFormalAuthorizations(sources, { authorizeDdev }) {
  for (const [label, value] of [
    ["证据 ID", "`EVD-G0-PACK-20260814`"],
    ["签发时间", "2026-08-14 15:00:00 +0800"],
    ["签发 Owner", "`ROLE-R01`"],
  ]) sources.g0Authorization = replaceAuthorizationField(sources.g0Authorization, label, value);

  if (authorizeDdev) {
    for (const [label, value] of [
      ["授权证据", "`EVD-DDEV-AUTH-20260814`"],
      ["签发时间", "2026-08-14 16:00:00 +0800"],
      ["签发 Owner", "`ROLE-R01`"],
    ]) sources.ddevAuthorization = replaceAuthorizationField(sources.ddevAuthorization, label, value);
  }

  const projection = authorizationProjectionDigests(sources);
  sources.g0Authorization = replaceAuthorizationField(
    sources.g0Authorization,
    "授权投影 SHA-256",
    `\`${projection.g0}\``
  );
  if (authorizeDdev) {
    sources.ddevAuthorization = replaceAuthorizationField(
      sources.ddevAuthorization,
      "授权投影 SHA-256",
      `\`${projection.ddev}\``
    );
  }
  return sources;
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
      cells[7] = cells[1].trim() === "G0-03"
        ? ` ${g003MenokinEvidence} `
        : cells[1].trim() === "G0-09"
          ? ` ${g009ClosureEvidence} `
          : cells[1].trim() === "G0-13"
            ? ` ${g013MenokinEvidence} `
          : cells[1].trim() === "G0-12"
            ? " EVD-G0-12-OPS-DEPLOYMENT-20260810 "
            : ` EVD-${cells[1].trim()} `;
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
      cells[5] = ["5", "6"].includes(cells[1].trim())
        ? ` ${g003MenokinEvidence} `
        : cells[1].trim() === "9"
          ? ` ${g009ClosureEvidence} `
          : cells[1].trim() === "14"
            ? ` ${g013MenokinEvidence} `
          : cells[1].trim() === "13"
            ? " EVD-G0-12-OPS-DEPLOYMENT-20260810 "
            : ` EVD-SCOPE-${cells[1].trim().padStart(2, "0")} `;
      return cells.join("|");
    })
    .join("\n");
}

function replaceScopeCheck(scope, scopeId, checked, evidence = "") {
  return scope
    .split("\n")
    .map((line) => {
      if (!line.startsWith(`| ${scopeId} |`)) return line;
      const cells = line.split("|");
      cells[4] = checked ? " [X] " : " [ ] ";
      if (evidence) cells[5] = ` ${evidence} `;
      return cells.join("|");
    })
    .join("\n");
}

function replaceG009ClosureRows(ledger, rows) {
  const lines = ledger.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === g009ClosureHeading);
  assert.ok(headingIndex >= 0, "测试夹具缺少 G0-09 机器可核验关闭收据");
  const tableStart = lines.findIndex((line, index) => index > headingIndex && line.trim().startsWith("|"));
  assert.ok(tableStart > headingIndex, "G0-09 关闭收据缺少表格");
  let tableEnd = tableStart;
  while (tableEnd < lines.length && lines[tableEnd].trim().startsWith("|")) tableEnd += 1;
  const table = [
    `| ${g009ClosureColumns.join(" | ")} |`,
    `| ${g009ClosureColumns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${g009ClosureColumns.map((column) => row[column]).join(" | ")} |`),
  ];
  return [...lines.slice(0, tableStart), ...table, ...lines.slice(tableEnd)].join("\n");
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
    cells[6] = " 2026-08-10 ";
    return cells.join("|");
  }).join("\n");
  return before + section;
}

function replaceRaciFields(ledger, role, updates) {
  const columnIndex = {
    "人员代号": 2,
    "代理人代号": 3,
    "接受职责证据 ID": 4,
    "状态": 5,
    "生效日期": 6,
    "固定职责": 7,
    "职责分离": 8,
  };
  const marker = "## 5. RACI 具名区";
  const start = ledger.indexOf(marker);
  assert.ok(start >= 0, "测试夹具缺少 RACI 具名区");
  const before = ledger.slice(0, start);
  const section = ledger.slice(start).split("\n").map((line) => {
    const cells = line.split("|");
    if (cells[1]?.trim() !== role) return line;
    for (const [field, value] of Object.entries(updates)) {
      assert.ok(field in columnIndex, `未知 RACI 字段：${field}`);
      cells[columnIndex[field]] = ` ${value} `;
    }
    return cells.join("|");
  }).join("\n");
  return before + section;
}

function replaceDdevDecisionRow(ledger, label, value) {
  const marker = "### DEC-DDEV-01 · 一期开发授权记录";
  const start = ledger.indexOf(marker);
  assert.ok(start >= 0, "测试夹具缺少 DEC-DDEV-01 开发授权记录");
  return ledger.slice(0, start) + ledger.slice(start).replace(
    new RegExp(`^(\\| ${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")} \\|) [^|]*(\\|)`, "m"),
    `$1 ${value} $2`
  );
}

function resetDdevDecision(ledger) {
  ledger = replaceStatus(ledger, "项目阶段", "G0 已通过 / 待 Ddev");
  ledger = replaceStatus(ledger, "Ddev", "空");
  ledger = replaceSignRow(ledger, "Ddev", "未成立");
  const marker = "### DEC-DDEV-01 · 一期开发授权记录";
  const start = ledger.indexOf(marker);
  assert.ok(start >= 0, "测试夹具缺少 DEC-DDEV-01 开发授权记录");
  ledger = ledger.slice(0, start) + ledger.slice(start).replace(
    /^> \*\*当前状态：\*\*[^\n]*$/m,
    "> **当前状态：** `PREPARED` · **G0 SIGNED / DDEV NOT AUTHORIZED**。"
  );
  for (const [label, value] of [
    ["结论", ""],
    ["签发时间", ""],
    ["G0 依据", ""],
    ["冻结输入清单", ""],
    ["允许环境与数据", ""],
    ["费用边界", ""],
    ["生效时间 / 复核日", ""],
    ["最终签发 Owner", ""],
    ["授权证据", ""],
  ]) ledger = replaceDdevDecisionRow(ledger, label, value);
  return ledger;
}

function selectOnlyFeePath(cost, path) {
  return cost.replace(
    /^- \[[ xX]\] \*\*([ABC])\b/gm,
    (_, candidate) => `- [${candidate === path ? "X" : " "}] **${candidate}`
  );
}

function signDdev(ledger, ddev, versions, feeDecisionDate) {
  const marker = "### DEC-DDEV-01 · 一期开发授权记录";
  const start = ledger.indexOf(marker);
  assert.ok(start >= 0, "测试夹具缺少 DEC-DDEV-01 开发授权记录");
  ledger = ledger.slice(0, start) + ledger.slice(start).replace(
    /^> \*\*当前状态：\*\*[^\n]*$/m,
    "> **当前状态：** `PASS` · **AUTHORIZED**。"
  );
  for (const [label, value] of [
    ["结论", "PASS"],
    ["签发时间", "2026-08-14 16:00:00 +0800"],
    ["G0 依据", "G0-02～15：Pass 14 / 14；Scope：Pass 15 / 15；证据包 EVD-G0-PACK-20260814"],
    ["冻结输入清单", ddevInputVersionText(versions)],
    ["允许环境与数据", "development / test；合成数据或经批准的脱敏数据；EVD-DDEV-DATA-20260814"],
    ["费用边界", `B；0 新增付费；下次决策日 ${feeDecisionDate}；EVD-DDEV-FEE-20260814`],
    ["生效时间 / 复核日", `${ddev} / 2026-08-20`],
    ["最终签发 Owner", "ROLE-R01 / EVD-DDEV-SIGN-OWNER"],
    ["授权证据", "EVD-DDEV-AUTH-20260814"],
  ]) ledger = replaceDdevDecisionRow(ledger, label, value);
  return ledger;
}

function fullyAdvance(sources, ddev = "2026-08-14", { authorizeDdev = true } = {}) {
  const versions = authorizationSourceVersions(sources);
  const feeDecisionDate = currentFeeDecisionDate(sources.cost);
  sources.ledger = passAllExternal(sources.ledger);
  sources.ledger = replaceG009ClosureRows(sources.ledger, readyG009ClosureRows);
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
    ["评审时间", "2026-08-14 15:00:00 +0800"],
    ["评审输入版本", g0InputVersionText(versions)],
    ["G0-02～15", "Pass 14 / 14；Fail 0 / 14"],
    ["Scope 检查", "Pass 15 / 15；Fail 0 / 15"],
    ["签发 Owner", "ROLE-R01 / EVD-SIGN-OWNER"],
    ["结论", "[X] Pass　[ ] Fail"],
    ["阻塞行动项", "无"],
    ["证据包 ID", "EVD-G0-PACK-20260814"],
    ["Ddev", ddev],
  ]) sources.ledger = replaceSignRow(sources.ledger, label, value);
  if (authorizeDdev) sources.ledger = signDdev(sources.ledger, ddev, versions, feeDecisionDate);
  sources.scope = passAllScope(sources.scope);
  return refreshFormalAuthorizations(sources, { authorizeDdev });
}

test("当前 29/29 Menokin 真源动态导出七条状态轴、正式 B 与已签 Ddev", async () => {
  const sources = await currentSources({ g0: "signed", ddev: "signed" });
  const status = deriveProjectStatus(sources);
  const currentVersions = currentSourceVersions(sources);
  const signedVersions = authorizationSourceVersions(sources);
  assert.equal(currentVersions.charter, "v3.37");
  assert.equal(signedVersions.charter, "v3.35");
  assert.equal(currentVersions.schedule, "v3.30");
  assert.equal(signedVersions.schedule, "v3.28");
  assert.equal(currentVersions.ledger, "v3.75");
  assert.equal(signedVersions.ledger, "v3.72");
  assert.deepEqual(status.statusAxes, {
    direction: "P0 · 工作方向已登记",
    approval: "公司批准 · 已批准",
    "problem-fit": "问题适配 · 已确认",
    external: "外部责任包 · 14 / 14",
    scope: "Scope · 15 / 15",
    resource: "资源基线 · 单人全栈 / FDE",
    ddev: "Ddev · 2026-08-31",
  });
  assert.equal(status.feePath, "B · 费用后置");
  assert.equal(status.g0, "Pass");
  assert.equal(status.g0Ready, true);
  assert.equal(status.ddevReady, true);
  assert.equal(status.projectCode, "CS-AI-C11");
  assert.equal(status.g0Evidence, "EVD-G0-SIGN-20260831");
  assert.equal(status.ddevEvidence, "EVD-DDEV-AUTH-20260831");
  assert.deepEqual(status.developmentProgress, {
    category: "active",
    state: "开发中",
    detail: "产品实施仓处于 DEV-M0 · IN_PROGRESS；W0 workspace scaffold 与迁移前基线已完成，证据 EVD-DEV-M0-W0-20260831；W1 desktop mechanical move 已完成并通过 PR #9 合并，证据 EVD-DEV-M0-W1-20260831；下一动作：合同开发授权与 codegen / runtime validation（待单独授权）。DEV-M0 退出证据未齐，不表示 DEV-M0 已完成",
    milestone: "DEV-M0",
    completedSlices: ["W0", "W1"],
    nextSlice: "",
    nextSliceName: "",
    nextAction: "合同开发授权与 codegen / runtime validation（待单独授权）",
    evidenceIds: ["EVD-DEV-M0-W0-20260831", "EVD-DEV-M0-W1-20260831"],
  });
  assert.equal(isChecked("[X]"), true);
  assert.equal(status.d0Completed, true);
  assert.equal(isMeetingLifecycleClosed(status), true);
});

test("正式 G0 / Ddev 记录绑定项目、证据、Owner 与带时区签发时间", async () => {
  for (const [label, value] of [
    ["项目", "客服 Agent（`CS-AI-C12`）"],
    ["证据 ID", "`EVD-G0-OTHER-20260831`"],
    ["签发 Owner", "`ROLE-OTHER-OWNER`"],
    ["签发时间", "2026-08-31 00:56:35 +0800"],
  ]) {
    const sources = await currentSources({ g0: "signed", ddev: "signed" });
    sources.g0Authorization = replaceAuthorizationField(sources.g0Authorization, label, value);
    assert.throws(
      () => deriveProjectStatus(sources),
      /G0 正式签发记录必须与项目、证据包、签发 Owner 和评审时间一致/,
      `G0 ${label}`
    );
  }

  for (const [label, value] of [
    ["项目", "`CS-AI-C12` · 客服 Agent 一期"],
    ["授权证据", "`EVD-DDEV-OTHER-20260831`"],
    ["签发 Owner", "`ROLE-OTHER-OWNER`"],
    ["签发时间", "2026-08-31 01:44:58 +0800"],
  ]) {
    const sources = await currentSources({ g0: "signed", ddev: "signed" });
    sources.ddevAuthorization = replaceAuthorizationField(sources.ddevAuthorization, label, value);
    assert.throws(
      () => deriveProjectStatus(sources),
      /Ddev 正式签发记录必须与项目、授权证据、签发 Owner 和签发时间一致/,
      `Ddev ${label}`
    );
  }
});

test("授权敏感投影漂移必须重新签发，动态开发状态可以独立推进", async () => {
  const g0Drift = await currentSources({ g0: "signed", ddev: "signed" });
  g0Drift.ledger = replaceRaciFields(g0Drift.ledger, "项目负责人", {
    固定职责: "故意改变签发后的授权职责投影",
  });
  assert.throws(() => deriveProjectStatus(g0Drift), /G0 授权投影已漂移，必须重新签发/);

  const ddevDrift = await currentSources({ g0: "signed", ddev: "signed" });
  ddevDrift.implementation += "\n签发后未重新批准的实现设计边界变更。\n";
  assert.throws(() => deriveProjectStatus(ddevDrift), /Ddev 授权投影已漂移，必须重新签发/);

  for (const [state, detail, category] of [
    ["暂停", "等待外部依赖复核；历史 Ddev 不自动恢复开发。", "paused"],
    ["停止", "项目 Owner 已停止当前开发，等待终止决定。", "stopped"],
    ["已完成", "DEV-M0 已完成；下一里程碑仍须独立授权。", "completed"],
  ]) {
    const sources = await currentSources({ g0: "signed", ddev: "signed" });
    sources.ledger = replaceStatus(sources.ledger, "产品开发", state);
    sources.ledger = replaceStatusDetail(sources.ledger, "产品开发", detail);
    const status = deriveProjectStatus(sources);
    assert.equal(status.developmentProgress.category, category, state);
    assert.equal(status.developmentProgress.detail, detail, state);
  }
});

test("RACI 职责接受、G0 与 Scope 必须按对应证据原子推进", async () => {
  const approvalScopeBehind = await currentSources();
  approvalScopeBehind.scope = replaceScopeCheck(approvalScopeBehind.scope, "1", false);
  approvalScopeBehind.ledger = replaceStatus(approvalScopeBehind.ledger, "Scope 检查", "14/15 Pass");
  assert.throws(
    () => deriveProjectStatus(approvalScopeBehind),
    /G0-02 与 Scope #1 必须在同一证据变更中同步通过/
  );

  const businessScopeBehind = await currentSources();
  businessScopeBehind.scope = replaceScopeCheck(businessScopeBehind.scope, "2", false);
  businessScopeBehind.ledger = replaceStatus(businessScopeBehind.ledger, "Scope 检查", "14/15 Pass");
  assert.throws(
    () => deriveProjectStatus(businessScopeBehind),
    /G0-04 与 Scope #2 必须在同一职责接受证据中同步通过/
  );

  const businessGateBehind = await currentSources();
  businessGateBehind.ledger = replaceGateStatus(businessGateBehind.ledger, "G0-04", "待办");
  businessGateBehind.ledger = replaceStatus(businessGateBehind.ledger, "外部责任包", "13/14 Pass");
  assert.throws(
    () => deriveProjectStatus(businessGateBehind),
    /G0-04 与 Scope #2 必须在同一职责接受证据中同步通过/
  );

  const accountabilityScopeBehind = await currentSources();
  accountabilityScopeBehind.scope = replaceScopeCheck(accountabilityScopeBehind.scope, "4", false);
  accountabilityScopeBehind.ledger = replaceStatus(accountabilityScopeBehind.ledger, "Scope 检查", "14/15 Pass");
  assert.throws(
    () => deriveProjectStatus(accountabilityScopeBehind),
    /Scope #4 必须与预算、IT \/ 安全、IT 服务 \/ 运维三类责任人的职责接受状态同步/
  );

  const contentGateBehind = await currentSources();
  contentGateBehind.ledger = replaceGateStatus(contentGateBehind.ledger, "G0-05", "待办");
  contentGateBehind.ledger = replaceStatus(contentGateBehind.ledger, "外部责任包", "13/14 Pass");
  assert.throws(
    () => deriveProjectStatus(contentGateBehind),
    /G0-05 与 Scope #3 必须在同一证据变更中同步通过/
  );

  const governanceScopeBehind = await currentSources();
  governanceScopeBehind.scope = replaceScopeCheck(governanceScopeBehind.scope, "7", false);
  governanceScopeBehind.ledger = replaceStatus(governanceScopeBehind.ledger, "Scope 检查", "14/15 Pass");
  assert.throws(
    () => deriveProjectStatus(governanceScopeBehind),
    /G0-06 与 Scope #7 必须在同一证据变更中同步通过/
  );

  const accountabilityRoleBehind = await currentSources();
  accountabilityRoleBehind.ledger = replaceRaciFields(accountabilityRoleBehind.ledger, "IT 服务 / 运维责任人", {
    "人员代号": "",
    "代理人代号": "",
    "接受职责证据 ID": "",
    "状态": "待填",
    "生效日期": "",
  });
  assert.throws(
    () => deriveProjectStatus(accountabilityRoleBehind),
    /Scope #4 必须与预算、IT \/ 安全、IT 服务 \/ 运维三类责任人的职责接受状态同步/
  );

  const baselineGateAhead = await currentSources();
  baselineGateAhead.ledger = replaceGateStatus(baselineGateAhead.ledger, "G0-03", "进行中", "");
  baselineGateAhead.ledger = replaceStatus(baselineGateAhead.ledger, "业务问题优先级", "进行中");
  baselineGateAhead.ledger = replaceStatus(baselineGateAhead.ledger, "外部责任包", "13/14 Pass");
  assert.throws(
    () => deriveProjectStatus(baselineGateAhead),
    /G0-03 与 Scope #5\/#6 必须在同一证据变更中同步通过/
  );

  const baselineScopeAhead = await currentSources();
  baselineScopeAhead.scope = replaceScopeCheck(baselineScopeAhead.scope, "5", false, "");
  baselineScopeAhead.scope = replaceScopeCheck(baselineScopeAhead.scope, "6", false, "");
  baselineScopeAhead.ledger = replaceStatus(baselineScopeAhead.ledger, "Scope 检查", "13/15 Pass");
  assert.throws(
    () => deriveProjectStatus(baselineScopeAhead),
    /G0-03 与 Scope #5\/#6 必须在同一证据变更中同步通过/
  );

  const feeScopeAhead = await currentSources();
  feeScopeAhead.scope = replaceScopeCheck(feeScopeAhead.scope, "11", false, "");
  feeScopeAhead.ledger = replaceStatus(feeScopeAhead.ledger, "Scope 检查", "14/15 Pass");
  assert.throws(
    () => deriveProjectStatus(feeScopeAhead),
    /Scope #11 只有在 G0-07 与正式 A \/ B 费用路径同步通过/
  );

  const greenfieldScopeBehind = await currentSources();
  greenfieldScopeBehind.scope = replaceScopeCheck(greenfieldScopeBehind.scope, "8", false);
  greenfieldScopeBehind.ledger = replaceStatus(greenfieldScopeBehind.ledger, "Scope 检查", "14/15 Pass");
  assert.throws(
    () => deriveProjectStatus(greenfieldScopeBehind),
    /G0-08 与 Scope #8 必须在同一证据变更中同步通过/
  );

  const sourcesGateAhead = await currentSources();
  sourcesGateAhead.scope = replaceScopeCheck(sourcesGateAhead.scope, "9", false, "");
  sourcesGateAhead.ledger = replaceStatus(sourcesGateAhead.ledger, "Scope 检查", "14/15 Pass");
  assert.throws(
    () => deriveProjectStatus(sourcesGateAhead),
    /G0-09 与 Scope #9 必须在同一证据变更中同步通过/
  );

  const sourcesScopeAhead = await currentSources();
  sourcesScopeAhead.ledger = replaceGateStatus(sourcesScopeAhead.ledger, "G0-09", "进行中", "");
  sourcesScopeAhead.ledger = replaceStatus(sourcesScopeAhead.ledger, "外部责任包", "13/14 Pass");
  assert.throws(
    () => deriveProjectStatus(sourcesScopeAhead),
    /G0-09 与 Scope #9 必须在同一证据变更中同步通过/
  );

  const mismatchedSourceEvidence = await currentSources();
  mismatchedSourceEvidence.ledger = replaceG009ClosureRows(
    mismatchedSourceEvidence.ledger,
    readyG009ClosureRows
  );
  mismatchedSourceEvidence.ledger = replaceGateStatus(
    mismatchedSourceEvidence.ledger,
    "G0-09",
    "Pass",
    g009ClosureEvidence
  );
  mismatchedSourceEvidence.scope = replaceScopeCheck(
    mismatchedSourceEvidence.scope,
    "9",
    true,
    "EVD-G0-09-AUTHORITY-SOURCES-20260815"
  );
  mismatchedSourceEvidence.ledger = replaceStatus(mismatchedSourceEvidence.ledger, "外部责任包", "14/14 Pass");
  mismatchedSourceEvidence.ledger = replaceStatus(mismatchedSourceEvidence.ledger, "Scope 检查", "15/15 Pass");
  assert.throws(
    () => deriveProjectStatus(mismatchedSourceEvidence),
    /G0-09 与 Scope #9 Pass 时必须使用同一精确关闭证据/
  );

  const genericSourceEvidence = await currentSources();
  genericSourceEvidence.ledger = replaceG009ClosureRows(
    genericSourceEvidence.ledger,
    readyG009ClosureRows.map((row) => ({ ...row, overall_approval_evd: "EVD-G0-09-GENERIC" }))
  );
  genericSourceEvidence.ledger = replaceGateStatus(
    genericSourceEvidence.ledger,
    "G0-09",
    "Pass",
    "EVD-G0-09-GENERIC"
  );
  genericSourceEvidence.scope = replaceScopeCheck(
    genericSourceEvidence.scope,
    "9",
    true,
    "EVD-G0-09-GENERIC"
  );
  genericSourceEvidence.ledger = replaceStatus(genericSourceEvidence.ledger, "外部责任包", "14/14 Pass");
  genericSourceEvidence.ledger = replaceStatus(genericSourceEvidence.ledger, "Scope 检查", "15/15 Pass");
  assert.throws(
    () => deriveProjectStatus(genericSourceEvidence),
    /G0-09 Pass 时必须使用单一 EVD-G0-09-AUTHORITY-SOURCES-YYYYMMDD 证据/
  );

  const invalidSourceEvidenceDate = await currentSources();
  invalidSourceEvidenceDate.ledger = replaceG009ClosureRows(
    invalidSourceEvidenceDate.ledger,
    readyG009ClosureRows.map((row) => ({
      ...row,
      overall_approval_evd: "EVD-G0-09-AUTHORITY-SOURCES-20260231",
    }))
  );
  invalidSourceEvidenceDate.ledger = replaceGateStatus(
    invalidSourceEvidenceDate.ledger,
    "G0-09",
    "Pass",
    "EVD-G0-09-AUTHORITY-SOURCES-20260231"
  );
  invalidSourceEvidenceDate.scope = replaceScopeCheck(
    invalidSourceEvidenceDate.scope,
    "9",
    true,
    "EVD-G0-09-AUTHORITY-SOURCES-20260231"
  );
  invalidSourceEvidenceDate.ledger = replaceStatus(invalidSourceEvidenceDate.ledger, "外部责任包", "14/14 Pass");
  invalidSourceEvidenceDate.ledger = replaceStatus(invalidSourceEvidenceDate.ledger, "Scope 检查", "15/15 Pass");
  assert.throws(
    () => deriveProjectStatus(invalidSourceEvidenceDate),
    /G0-09 Pass 时必须使用单一 EVD-G0-09-AUTHORITY-SOURCES-YYYYMMDD 证据/
  );

  const missingSourceDomain = await currentSources();
  missingSourceDomain.ledger = replaceG009ClosureRows(
    missingSourceDomain.ledger,
    readyG009ClosureRows.slice(0, 3)
  );
  assert.throws(
    () => deriveProjectStatus(missingSourceDomain),
    /G0-09 关闭收据必须恰好包含四个内容域/
  );

  const missingReadyField = fullyAdvance(await currentSources());
  missingReadyField.ledger = replaceG009ClosureRows(
    missingReadyField.ledger,
    readyG009ClosureRows.map((row) => row.domain === "campaign" ? { ...row, snapshot_evd: "待补" } : row)
  );
  assert.throws(
    () => deriveProjectStatus(missingReadyField),
    /campaign snapshot_evd 必须是单一 EVD-\* ID/
  );

  const inconsistentSourceCounts = fullyAdvance(await currentSources());
  inconsistentSourceCounts.ledger = replaceG009ClosureRows(
    inconsistentSourceCounts.ledger,
    readyG009ClosureRows.map((row) => row.domain === "presale" ? { ...row, total_rows: "101" } : row)
  );
  assert.throws(
    () => deriveProjectStatus(inconsistentSourceCounts),
    /presale 计数必须满足 total_rows = importable_rows \+ quarantined_rows/
  );

  const incompleteSourceReceipt = fullyAdvance(await currentSources());
  incompleteSourceReceipt.ledger = replaceG009ClosureRows(
    incompleteSourceReceipt.ledger,
    readyG009ClosureRows.map((row) => row.domain === "aftersale" ? { ...row, readiness: "INCOMPLETE" } : row)
  );
  assert.throws(
    () => deriveProjectStatus(incompleteSourceReceipt),
    /G0-09 Pass 时四域关闭收据必须全部 READY；aftersale 仍为 INCOMPLETE/
  );

  const duplicateLogicalVersion = fullyAdvance(await currentSources());
  duplicateLogicalVersion.ledger = replaceG009ClosureRows(
    duplicateLogicalVersion.ledger,
    readyG009ClosureRows.map((row) => row.domain === "product"
      ? { ...row, source_version_id: readyG009ClosureRows[0].source_version_id }
      : row)
  );
  assert.throws(
    () => deriveProjectStatus(duplicateLogicalVersion),
    /DEC-058 单工作簿的四个逻辑域必须使用四个独立 source_version_id/
  );

  const preconfirmSourceReceipt = await currentSources();
  preconfirmSourceReceipt.ledger = replaceG009ClosureRows(
    preconfirmSourceReceipt.ledger,
    readyG009ClosureRows.map((row) => row.domain === "product" ? { ...row, readiness: "PRECONFIRM" } : row)
  );
  assert.throws(
    () => deriveProjectStatus(preconfirmSourceReceipt),
    /product readiness 必须是 INCOMPLETE 或 READY/
  );

  const gateBehind = await currentSources();
  gateBehind.ledger = replaceGateStatus(gateBehind.ledger, "G0-10", "进行中");
  gateBehind.ledger = replaceStatus(gateBehind.ledger, "外部责任包", "13/14 Pass");
  assert.throws(
    () => deriveProjectStatus(gateBehind),
    /G0-10 与 Scope #10 必须在同一证据变更中同步通过/
  );

  const securityGateBehind = await currentSources();
  securityGateBehind.ledger = replaceGateStatus(
    securityGateBehind.ledger,
    "G0-11",
    "进行中",
    "安全边界已批准但本夹具故意撤销门禁状态"
  );
  securityGateBehind.ledger = replaceStatus(securityGateBehind.ledger, "外部责任包", "13/14 Pass");
  assert.throws(
    () => deriveProjectStatus(securityGateBehind),
    /G0-11 与 Scope #12 必须在同一证据变更中同步通过/
  );

  const securityScopeBehind = await currentSources();
  securityScopeBehind.scope = replaceScopeCheck(
    securityScopeBehind.scope,
    "12",
    false,
    ""
  );
  securityScopeBehind.ledger = replaceStatus(securityScopeBehind.ledger, "Scope 检查", "14/15 Pass");
  assert.throws(
    () => deriveProjectStatus(securityScopeBehind),
    /G0-11 与 Scope #12 必须在同一证据变更中同步通过/
  );

  const operationsGateEvidenceDrift = await currentSources();
  operationsGateEvidenceDrift.ledger = replaceGateStatus(
    operationsGateEvidenceDrift.ledger,
    "G0-12",
    "Pass",
    "EVD-G0-12-OTHER"
  );
  assert.throws(
    () => deriveProjectStatus(operationsGateEvidenceDrift),
    /G0-12 与 Scope #13 必须使用同一精确证据/
  );

  const operationsScopeEvidenceDrift = await currentSources();
  operationsScopeEvidenceDrift.scope = replaceScopeCheck(
    operationsScopeEvidenceDrift.scope,
    "13",
    true,
    "EVD-G0-12-OTHER"
  );
  assert.throws(
    () => deriveProjectStatus(operationsScopeEvidenceDrift),
    /G0-12 与 Scope #13 必须使用同一精确证据/
  );

  const evaluationGateAhead = await currentSources();
  evaluationGateAhead.scope = replaceScopeCheck(evaluationGateAhead.scope, "14", false);
  evaluationGateAhead.ledger = replaceStatus(evaluationGateAhead.ledger, "Scope 检查", "14/15 Pass");
  assert.throws(
    () => deriveProjectStatus(evaluationGateAhead),
    /G0-13 与 Scope #14 必须在同一证据变更中同步通过/
  );

  const evaluationScopeAhead = await currentSources();
  evaluationScopeAhead.ledger = replaceGateStatus(evaluationScopeAhead.ledger, "G0-13", "待办", "");
  evaluationScopeAhead.ledger = replaceStatus(evaluationScopeAhead.ledger, "外部责任包", "13/14 Pass");
  assert.throws(
    () => deriveProjectStatus(evaluationScopeAhead),
    /G0-13 与 Scope #14 必须在同一证据变更中同步通过/
  );

  const historicalEvaluationEvidence = await currentSources();
  historicalEvaluationEvidence.ledger = replaceGateStatus(
    historicalEvaluationEvidence.ledger,
    "G0-13",
    "Pass",
    "EVD-G0-13-EVALUATION-FREEZE-20260812"
  );
  historicalEvaluationEvidence.ledger = replaceStatus(
    historicalEvaluationEvidence.ledger,
    "外部责任包",
    "14/14 Pass"
  );
  historicalEvaluationEvidence.scope = replaceScopeCheck(
    historicalEvaluationEvidence.scope,
    "14",
    true,
    "EVD-G0-13-EVALUATION-FREEZE-20260812"
  );
  historicalEvaluationEvidence.ledger = replaceStatus(
    historicalEvaluationEvidence.ledger,
    "Scope 检查",
    "15/15 Pass"
  );
  assert.throws(
    () => deriveProjectStatus(historicalEvaluationEvidence),
    /G0-13 与 Scope #14 必须使用同一 Menokin 评测冻结证据/
  );

  const mismatchedMenokinEvaluationEvidence = await currentSources();
  mismatchedMenokinEvaluationEvidence.ledger = replaceGateStatus(
    mismatchedMenokinEvaluationEvidence.ledger,
    "G0-13",
    "Pass",
    g013MenokinEvidence
  );
  mismatchedMenokinEvaluationEvidence.ledger = replaceStatus(
    mismatchedMenokinEvaluationEvidence.ledger,
    "外部责任包",
    "14/14 Pass"
  );
  mismatchedMenokinEvaluationEvidence.scope = replaceScopeCheck(
    mismatchedMenokinEvaluationEvidence.scope,
    "14",
    true,
    "EVD-G0-13-MENOKIN-EVALUATION-FREEZE-20260829"
  );
  mismatchedMenokinEvaluationEvidence.ledger = replaceStatus(
    mismatchedMenokinEvaluationEvidence.ledger,
    "Scope 检查",
    "15/15 Pass"
  );
  assert.throws(
    () => deriveProjectStatus(mismatchedMenokinEvaluationEvidence),
    /G0-13 与 Scope #14 必须使用同一 Menokin 评测冻结证据/
  );

  const deliveryScopeAhead = await currentSources();
  deliveryScopeAhead.ledger = replaceGateStatus(deliveryScopeAhead.ledger, "G0-14", "进行中", "EVD-G0-14-PENDING");
  deliveryScopeAhead.ledger = replaceStatus(deliveryScopeAhead.ledger, "外部责任包", "13/14 Pass");
  assert.throws(
    () => deriveProjectStatus(deliveryScopeAhead),
    /Scope #15 只有在 G0-14 与 G0-15 均 Pass 时才能同步通过/
  );
});

test("G0-14/15 即使方案齐全，也必须由项目负责人接受职责后才能 Pass", async () => {
  const sources = await currentSources();
  sources.ledger = replaceRaciFields(sources.ledger, "项目负责人", {
    "人员代号": "",
    "代理人代号": "",
    "接受职责证据 ID": "",
    "状态": "待填",
    "生效日期": "",
  });
  sources.ledger = replaceGateStatus(sources.ledger, "G0-14", "Pass", "EVD-G0-14");
  sources.ledger = replaceGateStatus(sources.ledger, "G0-15", "Pass", "EVD-G0-15");
  sources.ledger = replaceStatus(sources.ledger, "外部责任包", "14/14 Pass");
  sources.scope = replaceScopeCheck(sources.scope, "15", true, "EVD-SCOPE-15");
  sources.ledger = replaceStatus(sources.ledger, "Scope 检查", "15/15 Pass");
  assert.throws(
    () => deriveProjectStatus(sources),
    /G0 角色 项目负责人 必须填写人员与代理人代号/
  );

  const missingQa = await currentSources();
  missingQa.ledger = replaceRaciFields(missingQa.ledger, "QA 负责人", {
    "人员代号": "",
    "代理人代号": "",
    "接受职责证据 ID": "",
    "状态": "待填",
    "生效日期": "",
  });
  missingQa.ledger = replaceGateStatus(missingQa.ledger, "G0-14", "Pass", "EVD-G0-14-WBS");
  missingQa.ledger = replaceGateStatus(missingQa.ledger, "G0-15", "Pass", "EVD-G0-15-HANDOFF");
  missingQa.ledger = replaceStatus(missingQa.ledger, "外部责任包", "14/14 Pass");
  missingQa.scope = replaceScopeCheck(missingQa.scope, "15", true, "EVD-G0-14-WBS / EVD-G0-15-HANDOFF");
  missingQa.ledger = replaceStatus(missingQa.ledger, "Scope 检查", "15/15 Pass");
  assert.throws(
    () => deriveProjectStatus(missingQa),
    /G0 角色 QA 负责人 必须填写人员与代理人代号/
  );
});

test("启动会生命周期对正向、否决、暂停和开发授权结论统一关闭", () => {
  const openStatus = {
    approvalReady: true,
    d0Completed: false,
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
  assert.equal(isMeetingLifecycleClosed({ ...openStatus, d0Completed: true }), true);
});

test("批准汇总与 G0-02 明细不一致时拒绝构建", async () => {
  const sources = await currentSources();
  sources.ledger = replaceGateStatus(sources.ledger, "G0-02", "待办");
  sources.ledger = replaceStatus(sources.ledger, "外部责任包", "13/14 Pass");
  assert.throws(() => deriveProjectStatus(sources), /G0-02/);
});

test("G0 已 Pass 时仅填写 Ddev 日期仍不得制造开发授权", async () => {
  const sources = await currentSources({ g0: "signed" });
  sources.ledger = replaceStatus(sources.ledger, "项目阶段", "Ddev / 开发期");
  sources.ledger = replaceStatus(sources.ledger, "Ddev", "2026-08-31");
  sources.ledger = replaceSignRow(sources.ledger, "Ddev", "2026-08-31");
  assert.throws(() => deriveProjectStatus(sources), /Ddev 日期不得在 DEC-DDEV-01 未 PASS 时成立/);
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

test("G0 全绿且填写 Ddev 日期仍不能绕过 DEC-DDEV-01 授权", async () => {
  const unsigned = fullyAdvance(await currentSources(), "2026-08-14", { authorizeDdev: false });
  assert.throws(
    () => deriveProjectStatus(unsigned),
    /Ddev 日期不得在 DEC-DDEV-01 未 PASS 时成立/
  );
});

test("DEC-DDEV-01 仍为 PREPARED 时不得在表内偷填 PASS 结论", async () => {
  const misleading = await currentSources();
  misleading.ledger = replaceDdevDecisionRow(misleading.ledger, "结论", "PASS");
  assert.throws(
    () => deriveProjectStatus(misleading),
    /DEC-DDEV-01=PREPARED 时结论必须保持未填写/
  );
});

test("DEC-DDEV-01 状态必须整词匹配，近似词不得被当作授权", async () => {
  for (const token of ["PASSING", "HOLDING", "FAILURE", "PREPAREDNESS"]) {
    const sources = await currentSources();
    sources.ledger = sources.ledger.replace(
      /^> \*\*当前状态：\*\*[^\n]*$/m,
      `> **当前状态：** \`${token}\` · 非受控状态`
    );
    assert.throws(
      () => deriveProjectStatus(sources),
      /DEC-DDEV-01 当前状态必须是 PREPARED、PASS、HOLD 或 FAIL/,
      token
    );
  }
});

test("DEC-DDEV-01 PASS 签发包必须与 G0、真源版本、费用和 RACI 交叉一致", async () => {
  const versions = authorizationSourceVersions(await currentSources());
  const cases = [
    [
      "G0 依据",
      "G0-02～15：Pass 14 / 14；Scope：Pass 15 / 15；证据包 EVD-G0-OTHER",
      /DEC-DDEV-01 G0 证据包必须与 G0 签发记录一致/,
    ],
    [
      "冻结输入清单",
      ddevInputVersionText(versions, { scope: "v4.19" }),
      /DEC-DDEV-01 冻结输入 03 版本 v4\.19 与当前真源 v4\.43 不一致/,
    ],
    [
      "冻结输入清单",
      ddevInputVersionText(versions, { schedule: "v3.16" }),
      /DEC-DDEV-01 冻结输入 01 版本 v3\.16 与当前真源 v3\.30 不一致（正式签发基线 v3\.28）/,
    ],
    [
      "冻结输入清单",
      ddevInputVersionText(versions, { cost: "v3.6" }),
      /DEC-DDEV-01 冻结输入 04 版本 v3\.6 与当前真源 v3\.13 不一致/,
    ],
    [
      "冻结输入清单",
      ddevInputVersionText(versions, { architecture: "v1.15" }),
      /DEC-DDEV-01 冻结输入 37 版本 v1\.15 与当前真源 v1\.16 不一致/,
    ],
    [
      "冻结输入清单",
      ddevInputVersionText(versions, { implementation: "v1.20" }),
      /DEC-DDEV-01 冻结输入 46 版本 v1\.20 与当前真源 v1\.22 不一致/,
    ],
    [
      "冻结输入清单",
      ddevInputVersionText(versions).replace(/^01 /, "010 "),
      /DEC-DDEV-01 冻结输入 01 版本 缺失 与当前真源 v3\.30 不一致（正式签发基线 v3\.28）/,
    ],
    [
      "允许环境与数据",
      "development / test / production；EVD-DDEV-DATA-20260814",
      /DEC-DDEV-01 只允许 development \/ test 环境/,
    ],
    [
      "费用边界",
      "B；EVD-DDEV-FEE-20260814",
      /DEC-DDEV-01 B 费用边界必须写明 0 新增付费和已批准的下次决策日/,
    ],
    [
      "生效时间 / 复核日",
      "2026-08-15 / 2026-08-20",
      /DEC-DDEV-01 生效日必须与 Ddev 日期一致/,
    ],
    [
      "最终签发 Owner",
      "ROLE-OUTSIDER / EVD-DDEV-SIGN-OWNER",
      /DEC-DDEV-01 最终签发 Owner 必须来自 RACI 项目负责人的主责或代理/,
    ],
    [
      "授权证据",
      "EVD-NOT-DDEV",
      /DEC-DDEV-01 PASS 时必须填写 EVD-DDEV-\* 授权证据/,
    ],
  ];
  for (const [field, value, expected] of cases) {
    const drifted = fullyAdvance(await currentSources());
    drifted.ledger = replaceDdevDecisionRow(drifted.ledger, field, value);
    assert.throws(() => deriveProjectStatus(drifted), expected, field);
  }
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
  beforeReview.ledger = replaceSignRow(
    beforeReview.ledger,
    "评审时间",
    "2026-08-20 15:00:00 +0800"
  );
  beforeReview.g0Authorization = replaceAuthorizationField(
    beforeReview.g0Authorization,
    "签发时间",
    "2026-08-20 15:00:00 +0800"
  );
  assert.throws(() => deriveProjectStatus(beforeReview), /不得早于 G0 评审/);
});

test("C 暂停可保持未开发，但不得通过 Scope #11 或签发 Ddev", async () => {
  const sources = await currentSources();
  sources.cost = selectOnlyFeePath(sources.cost, "C").replace(
    /^- \[X\] \*\*C 暂停执行：\*\*.*$/m,
    "- [X] **C 暂停执行：** 原因 业务证据不足；下次复核日期 2026-08-20"
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
  sources.ledger = replaceStatus(sources.ledger, "外部责任包", "14/14 Pass");
  sources.ledger = replaceStatus(sources.ledger, "产品开发", "已暂停");
  sources.scope = replaceScopeCheck(sources.scope, "11", false, "");
  sources.ledger = replaceStatus(sources.ledger, "Scope 检查", "14/15 Pass");
  const paused = deriveProjectStatus(sources);
  assert.equal(paused.feePathCode, "C");
  assert.equal(paused.feePauseReason, "业务证据不足");
  assert.equal(paused.feeDecisionDate, "2026-08-20");
  assert.equal(paused.ddevReady, false);

  sources.scope = replaceScopeCheck(sources.scope, "11", true, "EVD-SCOPE-11");
  sources.ledger = replaceStatus(sources.ledger, "Scope 检查", "15/15 Pass");
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
  checkedWithoutEvidence.scope = replaceScopeCheck(checkedWithoutEvidence.scope, "5", true, "批准记录 EVD-* ID：____");
  assert.throws(() => deriveProjectStatus(checkedWithoutEvidence), /Scope #5.*可追溯外部证据/);

  const rawUrlOnly = await currentSources();
  rawUrlOnly.scope = replaceScopeCheck(rawUrlOnly.scope, "5", true, "https://example.invalid/approval");
  assert.throws(() => deriveProjectStatus(rawUrlOnly), /Scope #5.*可追溯/);

  const duplicateScope = await currentSources();
  duplicateScope.scope = duplicateScope.scope.replace(/^\| 15 \|/m, "| 14 |");
  assert.throws(() => deriveProjectStatus(duplicateScope), /Scope #1～#15/);

  const smuggledEvidence = await currentSources();
  smuggledEvidence.scope = replaceScopeCheck(smuggledEvidence.scope, "5", true, "原始链接 https://example.invalid EVD-SCOPE-01");
  assert.throws(() => deriveProjectStatus(smuggledEvidence), /Scope #5.*可追溯/);
});

test("RACI 人员代号与签发证据不得夹带姓名或原始链接", async () => {
  const namedRaci = fullyAdvance(await currentSources());
  namedRaci.ledger = replaceRaciFields(namedRaci.ledger, "项目负责人", {
    "人员代号": "张三 ROLE-R01",
  });
  assert.throws(() => deriveProjectStatus(namedRaci), /RACI 项目负责人 人员代号\s*格式无效/);

  const feishuToken = fullyAdvance(await currentSources());
  feishuToken.ledger = replaceRaciFields(feishuToken.ledger, "项目负责人", {
    "人员代号": "doccnSensitiveToken",
  });
  assert.throws(
    () => deriveProjectStatus(feishuToken),
    /RACI 项目负责人 人员代号\s*格式无效/
  );

  const linkedReviewer = fullyAdvance(await currentSources());
  linkedReviewer.ledger = replaceSignRow(
    linkedReviewer.ledger,
    "签发 Owner",
    "ROLE-R01 / https://example.invalid / EVD-SIGN-OWNER"
  );
  assert.throws(
    () => deriveProjectStatus(linkedReviewer),
    /签发 Owner.*不得夹带姓名或链接/
  );
});

test("RACI 接受状态与生效日期必须双向一致", async () => {
  const missingDate = fullyAdvance(await currentSources());
  missingDate.ledger = replaceRaciFields(missingDate.ledger, "项目负责人", { "生效日期": "" });
  assert.throws(
    () => deriveProjectStatus(missingDate),
    /RACI 项目负责人 已接受时必须填写有效生效日期/
  );

  const invalidDate = fullyAdvance(await currentSources());
  invalidDate.ledger = replaceRaciFields(invalidDate.ledger, "项目负责人", {
    "生效日期": "2026-02-31",
  });
  assert.throws(
    () => deriveProjectStatus(invalidDate),
    /RACI 项目负责人 已接受时必须填写有效生效日期/
  );

  const prematureDate = await currentSources();
  prematureDate.ledger = replaceRaciFields(prematureDate.ledger, "QA 负责人", {
    "状态": "待填",
    "生效日期": "2026-08-10",
  });
  assert.throws(
    () => deriveProjectStatus(prematureDate),
    /RACI QA 负责人 未接受前不得填写生效日期/
  );
});

test("RACI 主代理代号不得相同，固定职责与分离说明不得删除", async () => {
  const selfProxy = fullyAdvance(await currentSources());
  selfProxy.ledger = replaceRaciFields(selfProxy.ledger, "项目负责人", {
    "代理人代号": "ROLE-R01",
  });
  assert.throws(
    () => deriveProjectStatus(selfProxy),
    /RACI 项目负责人 人员代号不得与代理人代号相同/
  );

  for (const field of ["固定职责", "职责分离"]) {
    const missingContract = fullyAdvance(await currentSources());
    missingContract.ledger = replaceRaciFields(missingContract.ledger, "项目负责人", { [field]: "" });
    assert.throws(
      () => deriveProjectStatus(missingContract),
      /RACI 项目负责人 必须保留固定职责与职责分离说明/
    );
  }
});

test("A 费用路径未填写责任人、cap 与批准证据时不得显示费用可用", async () => {
  const sources = await currentSources();
  sources.cost = selectOnlyFeePath(sources.cost, "A");
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
  sources.ledger = replaceStatus(sources.ledger, "外部责任包", "14/14 Pass");
  assert.throws(() => deriveProjectStatus(sources), /A 路径缺少必填批准项/);
});

test("A 费用路径拒绝伪金额与伪批准，合法 cap 必须月不高于全期", async () => {
  const prepareA = async () => {
    const sources = await currentSources();
    sources.cost = selectOnlyFeePath(sources.cost, "A")
      .replace(/^\| 预算 \/ 费用责任人（仅 1 人） \|.*$/m, "| 预算 / 费用责任人（仅 1 人） | ROLE-BUDGET-OWNER / EVD-BUDGET |")
      .replace(/^\| 客服项目月 cap \|.*$/m, "| 客服项目月 cap | CNY 1000 |")
      .replace(/^\| 客服项目全期 cap \|.*$/m, "| 客服项目全期 cap | CNY 5000 |")
      .replace(/^\| 费用科目 \/ 采购路径 \|.*$/m, "| 费用科目 / 采购路径 | COST-CENTER-01 |")
      .replace(/^\| 预警阈值与通知人 \|.*$/m, "| 预警阈值与通知人 | 80% / ROLE-BUDGET-OWNER |")
      .replace(/^\| 超线停扩授权 \|.*$/m, "| 超线停扩授权 | EVD-STOP-AUTH |")
      .replace(/^\| 批准人代号 \/ 日期 \/ 决定摘要 \/ 证据 ID \|.*$/m, "| 批准人代号 / 日期 / 决定摘要 / 证据 ID | ROLE-CAP-APPROVER / 2026-08-05 / 同意 / EVD-CAP-APPROVAL |");
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
    sources.ledger = replaceStatus(sources.ledger, "外部责任包", "14/14 Pass");
    sources.scope = replaceScopeCheck(sources.scope, "11", true, "EVD-G0-07");
    sources.ledger = replaceStatus(sources.ledger, "Scope 检查", "15/15 Pass");
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
  for (const label of ["评审时间", "签发 Owner", "证据包 ID"]) {
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
  missingOwner.ledger = replaceRaciFields(missingOwner.ledger, "客服业务 Owner", {
    "人员代号": "",
    "代理人代号": "",
    "接受职责证据 ID": "",
    "状态": "待填",
    "生效日期": "",
  });
  assert.throws(() => deriveProjectStatus(missingOwner), /客服业务 Owner.*人员与代理人代号/);

  const missingQa = fullyAdvance(await currentSources());
  missingQa.ledger = replaceRaciFields(missingQa.ledger, "QA 负责人", {
    "人员代号": "",
    "代理人代号": "",
    "接受职责证据 ID": "",
    "状态": "待填",
    "生效日期": "",
  });
  assert.throws(() => deriveProjectStatus(missingQa), /QA 负责人.*人员与代理人代号/);

  const selfApproved = fullyAdvance(await currentSources());
  selfApproved.ledger = selfApproved.ledger.replace(/^\| 预算责任人 \| ROLE-R04 /m, "| 预算责任人 | ROLE-R01 ");
  assert.throws(() => deriveProjectStatus(selfApproved), /职责分离/);

  const proxyOverlap = fullyAdvance(await currentSources());
  proxyOverlap.ledger = replaceRaciFields(proxyOverlap.ledger, "预算责任人", {
    "代理人代号": "ROLE-R01",
  });
  assert.throws(
    () => deriveProjectStatus(proxyOverlap),
    /项目、业务、预算与 IT \/ 安全的主责及代理 8 个代号必须全局职责分离/
  );

  const preG0ProxyOverlap = await currentSources();
  preG0ProxyOverlap.ledger = replaceRaciFields(preG0ProxyOverlap.ledger, "预算责任人", {
    "代理人代号": "USR-ZIWEI-001",
  });
  assert.throws(
    () => deriveProjectStatus(preG0ProxyOverlap),
    /项目、业务、预算与 IT \/ 安全的主责及代理 8 个代号必须全局职责分离/,
    "四类职责均接受后应立即检查 8 代号唯一性，不得等到 G0Ready"
  );

  const staleVersions = fullyAdvance(await currentSources());
  staleVersions.ledger = replaceSignRow(
    staleVersions.ledger,
    "评审输入版本",
    "章程 v1.0 / 台账 v1.0 / Scope v1.0 / 排期 v1.0"
  );
  assert.throws(() => deriveProjectStatus(staleVersions), /签发输入.*版本.*与当前真源/);

  const futureRaci = fullyAdvance(await currentSources());
  futureRaci.ledger = replaceRaciFields(futureRaci.ledger, "项目负责人", {
    "生效日期": "2026-08-15",
  });
  assert.throws(
    () => deriveProjectStatus(futureRaci),
    /G0 评审日期不得早于 RACI 项目负责人\s*生效日期/
  );
});

test("阶段与 G0 状态必须双向一致，Fail 也必须由明细驱动", async () => {
  const awaitingWithoutG0 = await currentSources();
  awaitingWithoutG0.ledger = replaceStatus(awaitingWithoutG0.ledger, "项目阶段", "G0 已通过 / 待 Ddev");
  assert.throws(() => deriveProjectStatus(awaitingWithoutG0), /G0 未签发/);

  const gateFail = await currentSources();
  gateFail.ledger = replaceGateStatus(gateFail.ledger, "G0-02", "Fail");
  gateFail.ledger = replaceStatus(gateFail.ledger, "公司正式批准", "Fail");
  gateFail.ledger = replaceStatus(gateFail.ledger, "外部责任包", "13/14 Pass");
  assert.throws(() => deriveProjectStatus(gateFail), /G0 签发汇总必须为 Fail/);
});

test("正式 G0 Fail 也必须有完整签发记录，不能用空表制造结论", async () => {
  const sources = await currentSources();
  const versions = currentSourceVersions(sources);
  sources.ledger = replaceGateStatus(sources.ledger, "G0-02", "Fail");
  sources.scope = replaceScopeCheck(sources.scope, "1", false);
  for (const [label, value] of [
    ["公司正式批准", "Fail"],
    ["外部责任包", "13/14 Pass"],
    ["G0 签发", "Fail"],
  ]) sources.ledger = replaceStatus(sources.ledger, label, value);
  for (const [label, value] of [
    ["评审时间", "2026-08-14 15:00"],
    ["评审输入版本", g0InputVersionText(versions)],
    ["G0-02～15", "Pass 13 / 14；Fail 1 / 14"],
    ["Scope 检查", "Pass 14 / 15；Fail 1 / 15"],
    ["签发 Owner", "USR-TIANYUAN-001 / EVD-SIGN-OWNER"],
    ["结论", "[ ] Pass　[X] Fail"],
    ["阻塞行动项", "补公司批准证据后复审"],
    ["证据包 ID", "EVD-G0-FAIL-20260814"],
    ["Ddev", "未成立"],
  ]) sources.ledger = replaceSignRow(sources.ledger, label, value);
  sources.ledger = replaceStatus(sources.ledger, "Scope 检查", "14/15 Pass");
  assert.equal(deriveProjectStatus(sources).g0, "Fail");

  sources.ledger = replaceSignRow(sources.ledger, "签发 Owner", "");
  assert.throws(() => deriveProjectStatus(sources), /签发 Owner/);
});
