function stripMarkdown(value) {
  return String(value ?? "")
    .trim()
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function getSection(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) throw new Error(`缺少章节：${heading}`);
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#+)\s/);
    if (match && match[1].length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

function parseTable(sectionText, label) {
  const lines = sectionText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));
  if (lines.length < 2) throw new Error(`章节没有可解析表格：${label}`);
  const rows = lines.map((line) =>
    line
      .slice(1, -1)
      .split("|")
      .map(stripMarkdown)
  );
  const header = rows[0];
  return rows
    .slice(1)
    .filter((row) => !row.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, ""))))
    .map((row) => Object.fromEntries(header.map((key, index) => [key, row[index] ?? ""])));
}

function required(value, label) {
  if (!value) throw new Error(`无法从真源解析：${label}`);
  return value;
}

function isValidIsoDate(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

function parseCount(value, label) {
  const match = String(value || "").match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) throw new Error(`无法从真源解析：${label}`);
  return { pass: Number(match[1]), total: Number(match[2]) };
}

const PERSON_CODE_PATTERN = /^(?:USR|ROLE)-[A-Za-z0-9_-]+$/;
const EVIDENCE_ID_PATTERN = /^EVD-[A-Za-z0-9_-]+$/;

function splitControlledIds(value) {
  return String(value || "")
    .trim()
    .split(/\s*(?:\/|[，,;；])\s*/)
    .filter(Boolean);
}

function isPersonCode(value) {
  return PERSON_CODE_PATTERN.test(String(value || "").trim());
}

function isEvidenceIdList(value) {
  const ids = splitControlledIds(value);
  return ids.length > 0 && ids.every((id) => EVIDENCE_ID_PATTERN.test(id));
}

function parsePersonWithEvidence(value, label) {
  const parts = splitControlledIds(value);
  if (
    parts.length < 2 ||
    !isPersonCode(parts[0]) ||
    !parts.slice(1).every((item) => EVIDENCE_ID_PATTERN.test(item))
  ) {
    throw new Error(`${label} 必须严格使用人员 / 角色代号加 EVD-* ID，不得夹带姓名或链接`);
  }
  return parts[0];
}

function hasTraceableEvidence(value, { allowRelativeDocument = true } = {}) {
  const text = String(value || "").trim();
  if (!text || /_{2,}|待补|待填|https?:\/\//i.test(text)) return false;
  if (isEvidenceIdList(text)) return true;
  return (
    allowRelativeDocument &&
    /(?:^|[\s(])(?:\.{0,2}\/)?[^\s()]+\.(?:md|pdf|json)(?:\)|$|[;；])/i.test(text)
  );
}

function parseMoney(value, label) {
  const normalized = String(value || "").trim().replace(/,/g, "");
  const match = normalized.match(/^(?:(?:CNY|RMB)\s*|[¥￥]\s*)?(\d+(?:\.\d{1,2})?)\s*(元|万元)?$/i);
  const hasCurrencyOrUnit = /^(?:CNY|RMB)|^[¥￥]|(?:元|万元)$/i.test(normalized);
  if (!match || !hasCurrencyOrUnit) throw new Error(`${label} 必须是带币种或单位的正数金额`);
  const amount = Number(match[1]) * (match[2] === "万元" ? 10000 : 1);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`${label} 必须大于 0`);
  return amount;
}

function requireEvidenceId(value, label) {
  if (!isEvidenceIdList(value)) {
    throw new Error(`${label} 必须填写 EVD-* 证据 ID；原始链接只存受控系统`);
  }
}

const G009_CLOSURE_HEADING = "### G0-09 机器可核验关闭收据（公开安全投影）";
const G009_CLOSURE_DOMAINS = ["presale", "campaign", "aftersale", "product"];
const G009_CLOSURE_FIELDS = [
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
const G009_CLOSURE_EVIDENCE_PATTERN = /^EVD-G0-09-AUTHORITY-SOURCES-(\d{8})$/;

function isG009ClosureEvidenceId(value) {
  const match = String(value || "").trim().match(G009_CLOSURE_EVIDENCE_PATTERN);
  if (!match) return false;
  const compactDate = match[1];
  return isValidIsoDate(
    `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`
  );
}

function parseG009Count(value, label, { positive = false } = {}) {
  const text = String(value || "").trim();
  if (!/^(?:0|[1-9]\d*)$/.test(text)) {
    throw new Error(`G0-09 关闭收据 ${label} 必须是非负整数`);
  }
  const count = Number(text);
  if (!Number.isSafeInteger(count) || (positive && count === 0)) {
    throw new Error(`G0-09 关闭收据 ${label} 必须是${positive ? "正" : "非负"}安全整数`);
  }
  return count;
}

function validateG009ClosureReceipt({ ledger, gateEvidence, scopeEvidence, passed }) {
  const rows = parseTable(getSection(ledger, G009_CLOSURE_HEADING), "G0-09 机器可核验关闭收据");
  if (rows.length !== G009_CLOSURE_DOMAINS.length) {
    throw new Error(`G0-09 关闭收据必须恰好包含四个内容域，当前 ${rows.length} 行`);
  }
  for (const field of G009_CLOSURE_FIELDS) {
    if (rows.some((row) => !Object.hasOwn(row, field))) {
      throw new Error(`G0-09 关闭收据缺少必填列：${field}`);
    }
  }
  const domains = rows.map((row) => row.domain);
  if (
    new Set(domains).size !== G009_CLOSURE_DOMAINS.length ||
    G009_CLOSURE_DOMAINS.some((domain) => !domains.includes(domain))
  ) {
    throw new Error("G0-09 关闭收据必须恰好包含 presale / campaign / aftersale / product 且各一行");
  }
  if (passed && !isG009ClosureEvidenceId(gateEvidence)) {
    throw new Error("G0-09 Pass 时必须使用单一 EVD-G0-09-AUTHORITY-SOURCES-YYYYMMDD 证据");
  }
  if (passed && scopeEvidence !== gateEvidence) {
    throw new Error("G0-09 与 Scope #9 Pass 时必须使用同一精确关闭证据");
  }
  for (const row of rows) {
    if (!["INCOMPLETE", "READY"].includes(row.readiness)) {
      throw new Error(`G0-09 关闭收据 ${row.domain} readiness 必须是 INCOMPLETE 或 READY`);
    }
    if (row.readiness !== "READY") continue;
    if (!/^SRC-[A-Z0-9]{12,32}$/.test(row.source_ref)) {
      throw new Error(`G0-09 关闭收据 ${row.domain} source_ref 必须是公开安全的 SRC-* 代号`);
    }
    if (/^(?:SRC|srcv)-(?:TODO|PENDING|INCOMPLETE|READY)$/i.test(row.source_ref)) {
      throw new Error(`G0-09 关闭收据 ${row.domain} source_ref 不得使用状态占位符`);
    }
    if (!/^srcv_[a-z0-9]{16,32}$/.test(row.source_version_id)) {
      throw new Error(`G0-09 关闭收据 ${row.domain} source_version_id 必须是公开安全的 srcv_* 代号`);
    }
    if (/^srcv_(?:TODO|PENDING|INCOMPLETE|READY)$/i.test(row.source_version_id)) {
      throw new Error(`G0-09 关闭收据 ${row.domain} source_version_id 不得使用状态占位符`);
    }
    for (const field of ["snapshot_evd", "acl_evd", "quality_evd"]) {
      if (!isEvidenceIdList(row[field]) || splitControlledIds(row[field]).length !== 1) {
        throw new Error(`G0-09 关闭收据 ${row.domain} ${field} 必须是单一 EVD-* ID`);
      }
    }
    const totalRows = parseG009Count(row.total_rows, `${row.domain}.total_rows`, { positive: true });
    const importableRows = parseG009Count(row.importable_rows, `${row.domain}.importable_rows`);
    const quarantinedRows = parseG009Count(row.quarantined_rows, `${row.domain}.quarantined_rows`);
    if (totalRows !== importableRows + quarantinedRows) {
      throw new Error(`G0-09 关闭收据 ${row.domain} 计数必须满足 total_rows = importable_rows + quarantined_rows`);
    }
    if (row.final_approver_role !== "ROLE-CONTENT-LEAD") {
      throw new Error(`G0-09 关闭收据 ${row.domain} final_approver_role 必须是 ROLE-CONTENT-LEAD`);
    }
    if (passed) {
      if (!isG009ClosureEvidenceId(row.overall_approval_evd)) {
        throw new Error(`G0-09 关闭收据 ${row.domain} overall_approval_evd 格式无效`);
      }
      if (row.overall_approval_evd !== gateEvidence) {
        throw new Error(`G0-09 关闭收据 ${row.domain} overall_approval_evd 必须与 G0-09 门证据一致`);
      }
    }
  }
  if (!passed) return;
  const incomplete = rows.find((row) => row.readiness !== "READY");
  if (incomplete) {
    throw new Error(`G0-09 Pass 时四域关闭收据必须全部 READY；${incomplete.domain} 仍为 ${incomplete.readiness}`);
  }
}

function parseSignedCount(value, label) {
  const match = String(value || "").match(/Pass\s*(\d+)\s*\/\s*(\d+)\s*[；;]\s*Fail\s*(\d+)\s*\/\s*(\d+)/i);
  if (!match) throw new Error(`G0 签发记录 ${label} 计数格式无效`);
  return { pass: Number(match[1]), passTotal: Number(match[2]), fail: Number(match[3]), failTotal: Number(match[4]) };
}

function sourceVersion(text, label, field = "版本") {
  const value = String(text || "").match(new RegExp(`\\*\\*${field}：\\*\\*\\s*(v\\d+(?:\\.\\d+)*)`, "i"))?.[1];
  if (!value) throw new Error(`无法从真源解析：${label}版本`);
  return value;
}

function uniqueSourceVersion(text, label, pattern) {
  const matches = [...String(text || "").matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`无法从真源唯一解析：${label}版本`);
  }
  return matches[0][1];
}

function architectureSourceVersion(text) {
  return uniqueSourceVersion(
    text,
    "37 架构",
    /^>\s*\*\*状态：\*\*[^\n]*?（当前\s+(v\d+(?:\.\d+)*)(?=[；）])/gmi
  );
}

function implementationSourceVersion(text) {
  return uniqueSourceVersion(
    text,
    "46 实现设计",
    /^>\s*\*\*日期：\*\*[^\n]*?·\s*(v\d+(?:\.\d+)*)(?=[（\s\\]|$)/gmi
  );
}

function outcome(value, passValues) {
  if (passValues.includes(value)) return "pass";
  if (["Fail", "未通过", "已否决"].includes(value)) return "fail";
  return "pending";
}

function statusAxisDirection(priority, direction) {
  if (direction === "已记录") return `${priority} · 工作方向已登记`;
  return `${priority} · 工作方向${direction}`;
}

function deriveFeeStatus(cost) {
  const section = getSection(cost, "## 6. 执行路径（G0 补正式留痕）");
  const selected = [...section.matchAll(/^- \[[xX]\]\s+\*\*([ABC])\b[^\n]*$/gm)].map((match) => ({
    path: match[1],
    line: match[0],
  }));
  if (selected.length > 1) throw new Error("费用路径只能勾选一个执行项");
  const path = selected[0]?.path || "";
  const line = selected[0]?.line || "";
  const approvalRows = parseTable(section, "费用路径批准项");
  const approvalMap = Object.fromEntries(approvalRows.map((row) => [row["必填批准项"], row["结果"]]));
  let feeDecisionDate = "";
  let feePauseReason = "";
  const filled = (label) => {
    const value = String(approvalMap[label] || "").trim();
    if (!value || /_{2,}|待填|待具名|待批准/.test(value)) throw new Error(`${path} 路径缺少必填批准项：${label}`);
    return value;
  };
  if (path === "A") {
    const budgetOwner = filled("预算 / 费用责任人（仅 1 人）");
    parsePersonWithEvidence(budgetOwner, "A 路径预算 / 费用责任人");
    const monthlyCap = parseMoney(filled("客服项目月 cap"), "客服项目月 cap");
    const totalCap = parseMoney(filled("客服项目全期 cap"), "客服项目全期 cap");
    if (monthlyCap > totalCap) throw new Error("客服项目月 cap 不得高于全期 cap");
    filled("费用科目 / 采购路径");
    const warning = filled("预警阈值与通知人");
    const warningParts = String(warning).split(/\s*\/\s*/);
    if (warningParts.length !== 2 || !/^\d+(?:\.\d+)?%$/.test(warningParts[0]) || !isPersonCode(warningParts[1])) {
      throw new Error("A 路径预警阈值与通知人必须使用“百分比 / 人员或角色代号”");
    }
    requireEvidenceId(filled("超线停扩授权"), "超线停扩授权");
    const approval = filled("批准人代号 / 日期 / 决定摘要 / 证据 ID");
    const approvalParts = String(approval).split(/\s*\/\s*/);
    if (approvalParts.length !== 4 || !isPersonCode(approvalParts[0])) {
      throw new Error("A 路径批准记录必须以唯一批准人代号开头，不得夹带姓名或链接");
    }
    const approvalDate = approvalParts[1];
    if (!approvalDate || !isValidIsoDate(approvalDate)) throw new Error("A 路径批准记录必须含有效批准日期");
    if (!/^(?:批准|同意|Pass)$/i.test(approvalParts[2])) {
      throw new Error("A 路径批准记录必须含受控决定摘要");
    }
    requireEvidenceId(approvalParts[3], "A 路径批准记录");
  }
  if (path === "B") {
    if (/_+/.test(line)) throw new Error("B 路径必须选定具体预算科目或采购路径");
    parsePersonWithEvidence(filled("预算 / 费用责任人（仅 1 人）"), "B 路径预算 / 费用责任人");
    filled("费用科目 / 采购路径");
    const nextDate = filled("B 下次费用决策日");
    if (!isValidIsoDate(nextDate)) throw new Error("B 下次费用决策日必须是有效 YYYY-MM-DD");
    feeDecisionDate = nextDate;
  }
  if (path === "C") {
    if (/_+/.test(line)) throw new Error("C 路径必须填写暂停原因与复审日期");
    const pause = line.match(/原因\s+(.+?)；下次复核日期\s+(\d{4}-\d{2}-\d{2})/);
    feePauseReason = pause?.[1]?.trim() || "";
    const reviewDate = pause?.[2] || "";
    if (!feePauseReason) throw new Error("C 路径必须填写暂停原因");
    if (!reviewDate || !isValidIsoDate(reviewDate)) throw new Error("C 路径复审日期必须是有效 YYYY-MM-DD");
    feeDecisionDate = reviewDate;
  }
  if (path === "A") return { feePathCode: "A", feePath: "A · 费用可用", paidSpend: "按已批准 cap 执行", feeSelected: true, feeDecisionDate, feePauseReason };
  if (path === "B") return { feePathCode: "B", feePath: "B · 费用后置", paidSpend: "新增付费授权 = 0", feeSelected: true, feeDecisionDate, feePauseReason };
  if (path === "C") return { feePathCode: "C", feePath: "C · 暂停", paidSpend: "新增付费授权 = 0", feeSelected: true, feeDecisionDate, feePauseReason };
  if (!/临时按\s*\*\*B（钱后置）\*\*/.test(cost)) {
    throw new Error("费用路径未选择且缺少临时 B 管控声明");
  }
  return { feePathCode: "B", feePath: "B · 临时管控，未签", paidSpend: "新增付费授权 = 0", feeSelected: false, feeDecisionDate, feePauseReason };
}

export function isChecked(value) {
  return /\[[xX]\]/.test(String(value || ""));
}

const MEETING_OPEN_PROBLEM_STATES = new Set([
  "待核验",
  "PRECONFIRM · 待核验",
  "进行中",
]);

const MEETING_CLOSED_DEVELOPMENT_STATES = new Set([
  "暂停",
  "已暂停",
  "停止",
  "已停止",
]);

export function meetingLifecycleState(projectStatus) {
  if (!projectStatus || typeof projectStatus !== "object") {
    throw new Error("启动会生命周期判断缺少项目状态");
  }
  if (projectStatus.approvalReady !== true) return "not-eligible";
  const closed =
    projectStatus.d0Completed === true ||
    !MEETING_OPEN_PROBLEM_STATES.has(projectStatus.problemFit) ||
    projectStatus.g0 === "Fail" ||
    projectStatus.feePathCode === "C" ||
    MEETING_CLOSED_DEVELOPMENT_STATES.has(projectStatus.development) ||
    projectStatus.ddevReady === true;
  return closed ? "closed" : "open";
}

export function isMeetingLifecycleClosed(projectStatus) {
  return meetingLifecycleState(projectStatus) === "closed";
}

export function deriveProjectStatus({
  charter,
  schedule,
  ledger,
  scope,
  cost,
  architecture,
  implementation,
}) {
  const architectureVersion = architectureSourceVersion(architecture);
  const implementationVersion = implementationSourceVersion(implementation);
  const statusRows = parseTable(getSection(ledger, "## 1. 当前状态"), "当前状态");
  const statusMap = Object.fromEntries(statusRows.map((row) => [row["项目项"], row["状态"]]));
  const allowedSummary = {
    "工作方向登记": ["已记录", "未记录", "Fail"],
    "公司正式批准": ["未完成", "进行中", "已完成", "已批准", "Pass", "Fail"],
    "D0 启动会": ["未完成", "进行中", "已完成", "Pass", "Fail"],
    "业务问题优先级": [
      "待核验",
      "PRECONFIRM · 待核验",
      "进行中",
      "已核验",
      "已确认",
      "Pass",
      "Fail",
      "未通过",
    ],
    "G0 签发": ["未签发", "待签发", "已签发", "Pass", "Fail"],
    "产品开发": ["未开始", "未开发", "暂停", "已暂停", "停止", "已停止", "开发中", "已开始", "进行中", "已完成"],
    "资源基线": ["未选择", "最小跨职能小队", "单人全栈 / FDE"],
    "健康度": ["绿", "黄", "红"],
  };
  for (const [label, allowed] of Object.entries(allowedSummary)) {
    if (!allowed.includes(statusMap[label])) throw new Error(`${label} 不是受控状态：${statusMap[label]}`);
  }
  const gates = parseTable(getSection(ledger, "## 2. G0 硬门禁"), "G0 硬门禁");
  const controlledGates = gates.filter((row) => /^G0-\d{2}$/.test(row.ID));
  const expectedGateIds = Array.from({ length: 15 }, (_, index) => `G0-${String(index + 1).padStart(2, "0")}`);
  if (controlledGates.length !== 15 || new Set(controlledGates.map((row) => row.ID)).size !== 15 || expectedGateIds.some((id) => !controlledGates.some((row) => row.ID === id))) {
    throw new Error("G0-01～G0-15 必须完整且 ID 唯一");
  }
  const allowedGateStatuses = new Set(["Pass", "待办", "逾期 · 待办", "进行中", "阻塞", "Fail"]);
  for (const gate of controlledGates) {
    if (!allowedGateStatuses.has(gate["状态"])) throw new Error(`${gate.ID} 不是受控门禁状态：${gate["状态"]}`);
    if (gate["状态"] === "Pass" && !hasTraceableEvidence(gate["完成证据"], { allowRelativeDocument: gate.ID === "G0-01" })) {
      throw new Error(`${gate.ID} 标记 Pass 时必须填写可追溯实际证据`);
    }
  }
  const externalRows = gates.filter((row) => /^G0-(?:0[2-9]|1[0-5])$/.test(row.ID));
  if (externalRows.length !== 14) throw new Error(`外部责任包应为 14 项，当前 ${externalRows.length} 项`);
  const external = parseCount(statusMap["外部责任包"], "外部责任包计数");
  const computedExternalPass = externalRows.filter((row) => row["状态"] === "Pass").length;
  if (external.total !== externalRows.length || external.pass !== computedExternalPass) {
    throw new Error(`外部责任包汇总与明细冲突：汇总 ${external.pass}/${external.total}，明细 ${computedExternalPass}/${externalRows.length}`);
  }

  const scopeRows = parseTable(
    getSection(scope, "## A. 进入 Scope 冻结（③）检查表"),
    "Scope 冻结检查"
  );
  if (scopeRows.length !== 15) throw new Error(`Scope 检查应为 15 项，当前 ${scopeRows.length} 项`);
  const expectedScopeIds = Array.from({ length: 15 }, (_, index) => String(index + 1));
  if (new Set(scopeRows.map((row) => row["#"])).size !== 15 || expectedScopeIds.some((id) => !scopeRows.some((row) => row["#"] === id))) {
    throw new Error("Scope #1～#15 必须完整且 ID 唯一");
  }
  for (const row of scopeRows) {
    if (!/^\[(?: |x|X)\]$/.test(row["完成"])) throw new Error(`Scope #${row["#"]} 完成状态无效：${row["完成"]}`);
    if (isChecked(row["完成"]) && !hasTraceableEvidence(row["外部证据 ID / 备注"], { allowRelativeDocument: false })) {
      throw new Error(`Scope #${row["#"]} 勾选时必须填写可追溯外部证据`);
    }
  }
  const scopeCount = parseCount(statusMap["Scope 检查"], "Scope 检查计数");
  const computedScopePass = scopeRows.filter((row) => isChecked(row["完成"])).length;
  if (scopeCount.total !== scopeRows.length || scopeCount.pass !== computedScopePass) {
    throw new Error(`Scope 汇总与明细冲突：汇总 ${scopeCount.pass}/${scopeCount.total}，明细 ${computedScopePass}/${scopeRows.length}`);
  }

  const raciRows = parseTable(getSection(ledger, "## 5. RACI 具名区"), "RACI 具名区");
  const requiredRoles = ["项目负责人", "客服业务 Owner", "内容 / 话术 Owner", "预算责任人", "IT / 安全责任人", "IT 服务 / 运维责任人", "设计负责人", "前端负责人", "后端负责人", "AI / RAG 负责人", "QA 负责人", "数据 / 内容接口人", "业务验收人"];
  if (raciRows.length !== requiredRoles.length || new Set(raciRows.map((row) => row["角色"])).size !== raciRows.length || requiredRoles.some((role) => !raciRows.some((row) => row["角色"] === role))) {
    throw new Error("RACI 13 个必需角色必须完整且唯一");
  }
  const allowedRaciStatuses = new Set(["待填", "候选", "已接受", "Pass"]);
  for (const row of raciRows) {
    if (!allowedRaciStatuses.has(row["状态"])) throw new Error(`RACI ${row["角色"]} 状态不受控：${row["状态"]}`);
    for (const field of ["人员代号", "代理人代号"]) {
      if (row[field] && !isPersonCode(row[field])) throw new Error(`RACI ${row["角色"]} ${field} 格式无效`);
    }
    if (row["接受职责证据 ID"] && !isEvidenceIdList(row["接受职责证据 ID"])) {
      throw new Error(`RACI ${row["角色"]} 接受职责证据必须是 EVD-* ID`);
    }
    if (row["人员代号"] && row["代理人代号"] && row["人员代号"] === row["代理人代号"]) {
      throw new Error(`RACI ${row["角色"]} 人员代号不得与代理人代号相同`);
    }
    if (!row["固定职责"] || !row["职责分离"]) {
      throw new Error(`RACI ${row["角色"]} 必须保留固定职责与职责分离说明`);
    }
    if (new Set(["已接受", "Pass"]).has(row["状态"])) {
      if (!isPersonCode(row["人员代号"]) || !isPersonCode(row["代理人代号"])) {
        throw new Error(`RACI ${row["角色"]} 已接受时必须填写人员与代理人代号`);
      }
      requireEvidenceId(row["接受职责证据 ID"], `RACI ${row["角色"]} 接受职责`);
      if (!isValidIsoDate(row["生效日期"])) throw new Error(`RACI ${row["角色"]} 已接受时必须填写有效生效日期`);
    } else if (row["生效日期"]) {
      throw new Error(`RACI ${row["角色"]} 未接受前不得填写生效日期`);
    }
  }
  const acceptedRaciStatuses = new Set(["已接受", "Pass"]);
  const isAcceptedRaciRole = (role) => {
    const row = raciRows.find((item) => item["角色"] === role);
    return Boolean(
      row &&
      isPersonCode(row["人员代号"]) &&
      isPersonCode(row["代理人代号"]) &&
      isEvidenceIdList(row["接受职责证据 ID"]) &&
      acceptedRaciStatuses.has(row["状态"]) &&
      isValidIsoDate(row["生效日期"])
    );
  };
  const requireRaciRole = (role) => {
    const row = raciRows.find((item) => item["角色"] === role);
    if (!isPersonCode(row?.["人员代号"] || "") || !isPersonCode(row?.["代理人代号"] || "")) {
      throw new Error(`G0 角色 ${role} 必须填写人员与代理人代号`);
    }
    requireEvidenceId(row["接受职责证据 ID"], `G0 角色 ${role} 接受职责`);
    if (!acceptedRaciStatuses.has(row["状态"])) throw new Error(`G0 角色 ${role} 必须明确接受职责`);
  };

  const priority = required(charter.match(/\*\*组合优先级：\*\*\s*([^；\n]+)/)?.[1]?.trim(), "组合优先级");
  const earliestDdev = required(
    charter.match(/\| Ddev \| 最早 (\d{4}-\d{2}-\d{2}) \|/)?.[1],
    "Ddev 最早日期"
  );
  if (!isValidIsoDate(earliestDdev)) throw new Error(`章程 Ddev 最早日期不是有效日历日期：${earliestDdev}`);
  const feeStatus = deriveFeeStatus(cost);
  const ddev = statusMap.Ddev === "空" ? "未成立" : required(statusMap.Ddev, "Ddev 状态");
  const approvalReady = ["已完成", "已批准", "Pass"].includes(statusMap["公司正式批准"]);
  const d0Completed = ["已完成", "Pass"].includes(statusMap["D0 启动会"]);
  const problemFitReady = ["已核验", "已确认", "Pass"].includes(statusMap["业务问题优先级"]);
  const g0Ready = ["已签发", "Pass"].includes(statusMap["G0 签发"]);
  if (controlledGates.some((row) => row["状态"] === "Fail") && statusMap["G0 签发"] !== "Fail") {
    throw new Error("G0-01～G0-15 任一 Fail 时，G0 签发汇总必须为 Fail");
  }
  const ddevDateLike = /^\d{4}-\d{2}-\d{2}$/.test(ddev);
  if (ddevDateLike && !isValidIsoDate(ddev)) throw new Error(`Ddev 日期不是有效日历日期：${ddev}`);
  const ddevReady = isValidIsoDate(ddev);
  if (!ddevReady && !["未成立", "待签发"].includes(ddev)) {
    throw new Error(`Ddev 状态格式无效，必须是未成立、待签发或有效日期：${ddev}`);
  }
  const evidenceReady =
    controlledGates.every((row) => row["状态"] === "Pass") && scopeCount.pass === scopeCount.total;
  if (g0Ready && (!approvalReady || !problemFitReady || !evidenceReady)) {
    throw new Error("G0 不得在批准、问题适配、外部责任包或 Scope 未全量通过时签发");
  }
  if (ddevReady && !g0Ready) throw new Error("Ddev 不得在 G0 未正式签发时成立");
  if (isValidIsoDate(ddev) && ddev < earliestDdev) {
    throw new Error(`Ddev 日期不得早于章程最早日期 ${earliestDdev}`);
  }
  const stage = required(statusMap["项目阶段"], "项目阶段");
  const preDdevStages = new Set(["启动前 / G0", "G0", "设计阶段 / G0", "G0 中检", "G0 决策", "G0 已通过 / 待 Ddev"]);
  const postDdevStage = /^(?:Ddev \/ 开发期|开发期 \/ G1a|G1a|Pilot Ready|G1b|M4)$/;
  if (!preDdevStages.has(stage) && !postDdevStage.test(stage)) {
    throw new Error(`项目阶段不是受控状态：${stage}`);
  }
  if (ddevReady && !postDdevStage.test(stage)) throw new Error("Ddev 已成立时项目阶段必须同步进入开发期或后续门禁");
  if (!ddevReady && postDdevStage.test(stage)) throw new Error("项目阶段不得在 Ddev 未成立时进入开发期或后续门禁");
  if (g0Ready && !ddevReady && stage !== "G0 已通过 / 待 Ddev") {
    throw new Error("G0 已签发但 Ddev 未成立时，项目阶段必须是 G0 已通过 / 待 Ddev");
  }
  if (!g0Ready && stage === "G0 已通过 / 待 Ddev") {
    throw new Error("项目阶段不得在 G0 未签发时写为 G0 已通过 / 待 Ddev");
  }
  const development = required(statusMap["产品开发"], "产品开发");
  const inactiveDevelopment = new Set(["未开始", "未开发", "暂停", "已暂停", "停止", "已停止"]);
  const activeDevelopment = new Set(["开发中", "已开始", "进行中", "已完成"]);
  if (!inactiveDevelopment.has(development) && !activeDevelopment.has(development)) {
    throw new Error(`产品开发不是受控状态：${development}`);
  }
  if (activeDevelopment.has(development) && !ddevReady) {
    throw new Error("产品开发状态不得在 Ddev 未成立时向前推进");
  }
  const scopeFeeReady = isChecked(scopeRows.find((row) => row["#"] === "11")?.["完成"]);
  if (feeStatus.feePathCode === "C" && (scopeFeeReady || g0Ready || ddevReady)) {
    throw new Error("C 暂停路径不得通过 Scope #11、签发 G0 或成立 Ddev");
  }
  const gateById = Object.fromEntries(externalRows.map((row) => [row.ID, row["状态"]]));
  const scopeById = Object.fromEntries(scopeRows.map((row) => [row["#"], isChecked(row["完成"])]));
  const gateRowById = Object.fromEntries(externalRows.map((row) => [row.ID, row]));
  const scopeRowById = Object.fromEntries(scopeRows.map((row) => [row["#"], row]));
  if (outcome(statusMap["工作方向登记"], ["已记录"]) !== outcome(controlledGates.find((row) => row.ID === "G0-01")?.["状态"], ["Pass"])) {
    throw new Error("工作方向登记汇总必须与 G0-01 明细一致");
  }
  if (outcome(statusMap["公司正式批准"], ["已完成", "已批准", "Pass"]) !== outcome(gateById["G0-02"], ["Pass"])) {
    throw new Error("公司正式批准汇总必须与 G0-02 明细一致");
  }
  if (outcome(statusMap["业务问题优先级"], ["已核验", "已确认", "Pass"]) !== outcome(gateById["G0-03"], ["Pass"])) {
    throw new Error("业务问题优先级汇总必须与 G0-03 明细一致");
  }
  if (feeStatus.feeSelected !== (gateById["G0-07"] === "Pass")) {
    throw new Error("费用路径选择必须与 G0-07 明细一致");
  }
  const resourceBaseline = required(statusMap["资源基线"], "资源基线");
  if (gateById["G0-14"] === "Pass" && resourceBaseline === "未选择") {
    throw new Error("G0-14 Pass 时必须选择最小跨职能小队或单人全栈 / FDE 资源基线");
  }
  for (const [gateId, scopeIds] of [
    ["G0-02", ["1"]],
    ["G0-03", ["5", "6"]],
    ["G0-05", ["3"]],
    ["G0-06", ["7"]],
    ["G0-08", ["8"]],
    ["G0-09", ["9"]],
    ["G0-10", ["10"]],
    ["G0-11", ["12"]],
    ["G0-12", ["13"]],
    ["G0-13", ["14"]],
  ]) {
    const gatePassed = gateById[gateId] === "Pass";
    if (scopeIds.some((scopeId) => scopeById[scopeId] !== gatePassed)) {
      const scopeLabel = scopeIds.map((scopeId) => `#${scopeId}`).join("/");
      throw new Error(`${gateId} 与 Scope ${scopeLabel} 必须在同一证据变更中同步通过或保持未完成`);
    }
  }
  validateG009ClosureReceipt({
    ledger,
    gateEvidence: gateRowById["G0-09"]?.["完成证据"] || "",
    scopeEvidence: scopeRowById["9"]?.["外部证据 ID / 备注"] || "",
    passed: gateById["G0-09"] === "Pass",
  });
  for (const [gateId, scopeId, expectedEvidenceId] of [
    ["G0-03", "5", "EVD-G0-03-BUSINESS-BASELINE-20260812"],
    ["G0-03", "6", "EVD-G0-03-BUSINESS-BASELINE-20260812"],
    ["G0-12", "13", "EVD-G0-12-OPS-DEPLOYMENT-20260810"],
  ]) {
    if (gateById[gateId] !== "Pass") continue;
    const gateEvidence = gateRowById[gateId]?.["完成证据"] || "";
    const scopeEvidence = scopeRowById[scopeId]?.["外部证据 ID / 备注"] || "";
    if (gateEvidence !== expectedEvidenceId || scopeEvidence !== expectedEvidenceId) {
      throw new Error(`${gateId} 与 Scope #${scopeId} 必须使用同一精确证据 ${expectedEvidenceId}`);
    }
  }
  const feeScopeExpected =
    feeStatus.feeSelected &&
    ["A", "B"].includes(feeStatus.feePathCode) &&
    gateById["G0-07"] === "Pass";
  if (scopeFeeReady !== feeScopeExpected) {
    throw new Error("Scope #11 只有在 G0-07 与正式 A / B 费用路径同步通过时才能完成；C 暂停必须保持未完成");
  }
  const deliveryPlanReady = gateById["G0-14"] === "Pass" && gateById["G0-15"] === "Pass";
  if (deliveryPlanReady !== scopeById["15"]) {
    throw new Error("Scope #15 只有在 G0-14 与 G0-15 均 Pass 时才能同步通过");
  }
  if ((gateById["G0-04"] === "Pass") !== scopeById["2"]) {
    throw new Error("G0-04 与 Scope #2 必须在同一职责接受证据中同步通过或保持未完成");
  }
  const accountabilityRolesReady = [
    "预算责任人",
    "IT / 安全责任人",
    "IT 服务 / 运维责任人",
  ].every(isAcceptedRaciRole);
  if (accountabilityRolesReady !== scopeById["4"]) {
    throw new Error("Scope #4 必须与预算、IT / 安全、IT 服务 / 运维三类责任人的职责接受状态同步");
  }
  const roleGateMap = {
    "G0-03": ["客服业务 Owner"],
    "G0-04": ["客服业务 Owner"],
    "G0-05": ["内容 / 话术 Owner"],
    "G0-06": ["内容 / 话术 Owner"],
    "G0-07": ["预算责任人"],
    "G0-08": ["项目负责人"],
    "G0-09": ["内容 / 话术 Owner"],
    "G0-10": ["项目负责人"],
    "G0-11": ["IT / 安全责任人"],
    "G0-12": ["IT 服务 / 运维责任人"],
    "G0-13": ["客服业务 Owner", "QA 负责人"],
    "G0-14": ["项目负责人"],
    "G0-15": ["项目负责人", "客服业务 Owner", "QA 负责人", "IT 服务 / 运维责任人"],
  };
  for (const [gateId, roles] of Object.entries(roleGateMap)) {
    if (gateById[gateId] === "Pass") roles.forEach(requireRaciRole);
  }
  const independentRoles = ["项目负责人", "客服业务 Owner", "预算责任人", "IT / 安全责任人"];
  const independentRows = independentRoles.map((role) => raciRows.find((row) => row["角色"] === role));
  if (independentRoles.every(isAcceptedRaciRole)) {
    const responsibilityCodes = independentRows.flatMap((row) => [row["人员代号"], row["代理人代号"]]);
    if (new Set(responsibilityCodes).size !== responsibilityCodes.length) {
      throw new Error("项目、业务、预算与 IT / 安全的主责及代理 8 个代号必须全局职责分离");
    }
  }
  if (g0Ready) {
    for (const role of requiredRoles) requireRaciRole(role);
  }
  const g0Failed = statusMap["G0 签发"] === "Fail";
  let g0ReviewDate = "";
  let g0EvidencePackage = "";
  if (g0Ready || g0Failed) {
    const signRows = parseTable(getSection(ledger, "### G0 签发记录"), "G0 签发记录");
    const signMap = Object.fromEntries(signRows.map((row) => [row["字段"], row["填写"]]));
    const reviewDate = String(signMap["评审时间"] || "").match(/\d{4}-\d{2}-\d{2}/)?.[0];
    if (!reviewDate || !isValidIsoDate(reviewDate)) throw new Error("G0 已签发时必须填写有效评审时间");
    g0ReviewDate = reviewDate;
    if (g0Ready) {
      for (const row of raciRows) {
        if (row["生效日期"] > reviewDate) {
          throw new Error(`G0 评审日期不得早于 RACI ${row["角色"]} 生效日期`);
        }
      }
    }
    const inputVersions = String(signMap["评审输入版本"] || "");
    if (/_+/.test(inputVersions) || !/章程\s*v\d/i.test(inputVersions) || !/台账\s*v\d/i.test(inputVersions) || !/Scope\s*v\d/i.test(inputVersions) || !/排期\s*v\d/i.test(inputVersions)) {
      throw new Error("G0 已签发时必须冻结章程、台账、Scope 与排期版本");
    }
    const signedVersions = Object.fromEntries(
      ["章程", "台账", "Scope", "排期"].map((label) => [
        label,
        inputVersions.match(new RegExp(`${label}\\s*(v\\d+(?:\\.\\d+)*)`, "i"))?.[1] || "",
      ])
    );
    const currentVersions = {
      章程: sourceVersion(charter, "章程"),
      台账: sourceVersion(ledger, "台账"),
      Scope: sourceVersion(scope, "Scope", "状态"),
      排期: sourceVersion(schedule, "排期", "排期版本"),
    };
    for (const [label, current] of Object.entries(currentVersions)) {
      if (signedVersions[label] !== current) {
        throw new Error(`G0 签发输入 ${label} 版本 ${signedVersions[label] || "缺失"} 与当前真源 ${current} 不一致`);
      }
    }
    const externalSigned = parseSignedCount(signMap["G0-02～15"], "G0-02～15");
    const externalFail = externalRows.filter((row) => row["状态"] === "Fail").length;
    if (externalSigned.pass !== computedExternalPass || externalSigned.passTotal !== 14 || externalSigned.fail !== externalFail || externalSigned.failTotal !== 14) {
      throw new Error("G0 签发记录的 G0-02～15 计数与明细不一致");
    }
    const scopeSigned = parseSignedCount(signMap["Scope 检查"], "Scope 检查");
    if (scopeSigned.pass !== computedScopePass || scopeSigned.passTotal !== 15 || scopeSigned.fail !== 15 - computedScopePass || scopeSigned.failTotal !== 15) {
      throw new Error("G0 签发记录的 Scope 计数与明细不一致");
    }
    const reviewerCodes = [];
    for (const field of ["业务审核人", "IT / 安全审核人", "预算审核人", "项目审核人"]) {
      const reviewer = String(signMap[field] || "");
      reviewerCodes.push(parsePersonWithEvidence(reviewer, `G0 已签发时 ${field}`));
    }
    if (new Set(reviewerCodes).size !== reviewerCodes.length) throw new Error("G0 四类审核人必须职责分离");
    const conclusion = String(signMap["结论"] || "");
    const passChecked = /\[[xX]\]\s*Pass/.test(conclusion);
    const failChecked = /\[[xX]\]\s*Fail/.test(conclusion);
    if ((g0Ready && (!passChecked || failChecked)) || (g0Failed && (passChecked || !failChecked))) {
      throw new Error(`G0 ${g0Ready ? "已签发" : "Fail"} 时签发记录必须唯一勾选对应结论`);
    }
    const blockers = String(signMap["阻塞行动项"] || "").trim();
    if (g0Ready && blockers !== "无") throw new Error("G0 Pass 时阻塞行动项必须明确填写“无”");
    if (g0Failed && (!blockers || /_{2,}|待填/.test(blockers))) throw new Error("G0 Fail 时必须填写阻塞行动项");
    requireEvidenceId(signMap["证据包 ID"], "G0 证据包");
    g0EvidencePackage = String(signMap["证据包 ID"] || "").trim();
    const signedDdev = String(signMap.Ddev || "").trim();
    if (ddevReady && signedDdev !== ddev) throw new Error("G0 签发记录 Ddev 必须与当前状态一致");
    if (!ddevReady && signedDdev && !/^(?:待签发|未成立)$/.test(signedDdev)) throw new Error("Ddev 未成立时签发记录不得填写其他值");
    if (g0Failed && signedDdev && signedDdev !== "未成立") throw new Error("G0 Fail 时签发记录 Ddev 必须为空或未成立");
    if (isValidIsoDate(ddev) && ddev < reviewDate) throw new Error("Ddev 日期不得早于 G0 评审签发日期");
  }

  const ddevSection = getSection(ledger, "### DEC-DDEV-01 · 一期开发授权记录");
  const ddevDecisionState = ddevSection.match(/^>\s*\*\*当前状态：\*\*\s*`(PREPARED|PASS|HOLD|FAIL)`(?:\s*·[^\n]*)?$/mi)?.[1]?.toUpperCase();
  if (!ddevDecisionState) throw new Error("DEC-DDEV-01 当前状态必须是 PREPARED、PASS、HOLD 或 FAIL");
  const ddevDecisionRows = parseTable(ddevSection, "DEC-DDEV-01 开发授权记录");
  const ddevDecisionMap = Object.fromEntries(ddevDecisionRows.map((row) => [row["字段"], row["签发值"]]));
  if (ddevDecisionMap["决策 ID"] !== "DEC-DDEV-01") throw new Error("开发授权记录必须使用 DEC-DDEV-01");
  const rawDdevConclusion = String(ddevDecisionMap["结论"] || "").trim();
  const ddevConclusion = /^(?:PASS|HOLD|FAIL)$/i.test(rawDdevConclusion) ? rawDdevConclusion.toUpperCase() : "";
  if (ddevDecisionState === "PASS" && !ddevReady) throw new Error("DEC-DDEV-01=PASS 时必须同步填写有效 Ddev 日期");
  if (ddevReady && ddevDecisionState !== "PASS") throw new Error("Ddev 日期不得在 DEC-DDEV-01 未 PASS 时成立");
  if (new Set(["PREPARED", "HOLD", "FAIL"]).has(ddevDecisionState) && ddevReady) {
    throw new Error(`DEC-DDEV-01=${ddevDecisionState} 时 Ddev 必须保持未成立`);
  }
  if (new Set(["PASS", "HOLD", "FAIL"]).has(ddevDecisionState) && ddevConclusion !== ddevDecisionState) {
    throw new Error(`DEC-DDEV-01=${ddevDecisionState} 时结论必须同步为 ${ddevDecisionState}`);
  }
  if (ddevDecisionState === "PREPARED" && ddevConclusion) {
    throw new Error("DEC-DDEV-01=PREPARED 时结论必须保持未填写");
  }
  if (ddevReady) {
    const g0Basis = String(ddevDecisionMap["G0 依据"] || "");
    if (!/G0-02～15[:：]\s*Pass\s*14\s*\/\s*14/.test(g0Basis) || !/Scope[:：]\s*Pass\s*15\s*\/\s*15/.test(g0Basis)) {
      throw new Error("DEC-DDEV-01 PASS 时 G0 依据必须明确 14/14 与 Scope 15/15");
    }
    const g0Evidence = g0Basis.match(/EVD-G0-[A-Za-z0-9_-]+/)?.[0] || "";
    requireEvidenceId(g0Evidence, "DEC-DDEV-01 G0 依据");
    if (!g0EvidencePackage || g0Evidence !== g0EvidencePackage) {
      throw new Error("DEC-DDEV-01 G0 证据包必须与 G0 签发记录一致");
    }

    const frozenInputs = String(ddevDecisionMap["冻结输入清单"] || "");
    if (/_+|待填/.test(frozenInputs)) {
      throw new Error("DEC-DDEV-01 PASS 时必须冻结 01、03、04、37、46 的精确版本");
    }
    const frozenEvidence = frozenInputs.match(/EVD-[A-Za-z0-9_-]+/)?.[0] || "";
    requireEvidenceId(frozenEvidence, "DEC-DDEV-01 冻结输入清单");
    const currentFrozenVersions = {
      "01": { label: "排期", version: sourceVersion(schedule, "排期", "排期版本") },
      "03": { label: "Scope", version: sourceVersion(scope, "Scope", "状态") },
      "04": { label: "费用", version: cost.match(/费用与成本控制\s+(v\d+(?:\.\d+)*)/i)?.[1] || "" },
      "37": { label: "架构", version: architectureVersion },
      "46": { label: "实现设计", version: implementationVersion },
    };
    for (const [documentId, { label, version: currentVersion }] of Object.entries(currentFrozenVersions)) {
      const signedMatches = [
        ...frozenInputs.matchAll(
          new RegExp(
            `(?:^|[/；;])\\s*${documentId}(?!\\d)\\s+${label}\\s+(v\\d+(?:\\.\\d+)*)`,
            "gi"
          )
        ),
      ];
      const signedVersion = signedMatches.length === 1 ? signedMatches[0][1] : "";
      if (!currentVersion || signedVersion !== currentVersion) {
        throw new Error(`DEC-DDEV-01 冻结输入 ${documentId} 版本 ${signedVersion || "缺失"} 与当前真源 ${currentVersion || "缺失"} 不一致`);
      }
    }

    const environmentAndData = String(ddevDecisionMap["允许环境与数据"] || "");
    if (!/\bdevelopment\b/i.test(environmentAndData) || !/\btest\b/i.test(environmentAndData) || /production/i.test(environmentAndData)) {
      throw new Error("DEC-DDEV-01 只允许 development / test 环境");
    }
    const dataEvidence = environmentAndData.match(/EVD-[A-Za-z0-9_-]+/)?.[0] || "";
    requireEvidenceId(dataEvidence, "DEC-DDEV-01 数据批准");

    const feeBoundary = String(ddevDecisionMap["费用边界"] || "");
    if (!new RegExp(`^${feeStatus.feePathCode}\\b`).test(feeBoundary)) {
      throw new Error(`DEC-DDEV-01 费用边界必须与已签费用路径 ${feeStatus.feePathCode} 一致`);
    }
    const feeEvidence = feeBoundary.match(/EVD-[A-Za-z0-9_-]+/)?.[0] || "";
    requireEvidenceId(feeEvidence, "DEC-DDEV-01 费用边界");
    if (feeStatus.feePathCode === "B" && (!/0\s*(?:新增付费|支出|元)/.test(feeBoundary) || !feeStatus.feeDecisionDate || !feeBoundary.includes(feeStatus.feeDecisionDate))) {
      throw new Error("DEC-DDEV-01 B 费用边界必须写明 0 新增付费和已批准的下次决策日");
    }

    const lifecycleDates = String(ddevDecisionMap["生效时间 / 复核日"] || "").match(/\d{4}-\d{2}-\d{2}/g) || [];
    if (lifecycleDates.length !== 2 || !lifecycleDates.every(isValidIsoDate)) {
      throw new Error("DEC-DDEV-01 PASS 时必须填写有效生效日与复核日");
    }
    const [effectiveDate, reviewDate] = lifecycleDates;
    if (effectiveDate !== ddev) throw new Error("DEC-DDEV-01 生效日必须与 Ddev 日期一致");
    if (reviewDate < effectiveDate) throw new Error("DEC-DDEV-01 复核日不得早于生效日");
    if (!g0ReviewDate || effectiveDate < g0ReviewDate) throw new Error("DEC-DDEV-01 生效日不得早于 G0 评审日");

    const signers = String(ddevDecisionMap["最终签发角色"] || "");
    const signerPatterns = [
      ["业务", "客服业务 Owner", /业务[:：]\s*((?:USR|ROLE)-[A-Za-z0-9_-]+)\s*\/\s*(EVD-[A-Za-z0-9_-]+)/],
      ["IT / 安全", "IT / 安全责任人", /IT\s*\/\s*安全[:：]\s*((?:USR|ROLE)-[A-Za-z0-9_-]+)\s*\/\s*(EVD-[A-Za-z0-9_-]+)/],
      ["预算", "预算责任人", /预算[:：]\s*((?:USR|ROLE)-[A-Za-z0-9_-]+)\s*\/\s*(EVD-[A-Za-z0-9_-]+)/],
      ["项目", "项目负责人", /项目[:：]\s*((?:USR|ROLE)-[A-Za-z0-9_-]+)\s*\/\s*(EVD-[A-Za-z0-9_-]+)/],
    ];
    const signerCodes = signerPatterns.map(([label, raciRole, pattern]) => {
      const match = signers.match(pattern);
      if (!match) throw new Error(`DEC-DDEV-01 缺少${label}签发人代号与 EVD-*`);
      const raciRow = raciRows.find((row) => row["角色"] === raciRole);
      if (![raciRow?.["人员代号"], raciRow?.["代理人代号"]].includes(match[1])) {
        throw new Error(`DEC-DDEV-01 ${label}签发人必须来自 RACI ${raciRole} 的主责或代理`);
      }
      return match[1];
    });
    if (new Set(signerCodes).size !== signerCodes.length) throw new Error("DEC-DDEV-01 四类最终签发人必须职责分离");
    const authorizationEvidence = String(ddevDecisionMap["授权证据"] || "").trim();
    if (!/^EVD-DDEV-[A-Za-z0-9_-]+$/.test(authorizationEvidence)) {
      throw new Error("DEC-DDEV-01 PASS 时必须填写 EVD-DDEV-* 授权证据");
    }
  }
  const status = {
    priority,
    earliestDdev,
    direction: required(statusMap["工作方向登记"], "工作方向登记"),
    approval: required(statusMap["公司正式批准"], "公司正式批准"),
    problemFit: required(statusMap["业务问题优先级"], "业务问题优先级"),
    stage,
    externalPass: external.pass,
    externalTotal: external.total,
    scopePass: scopeCount.pass,
    scopeTotal: scopeCount.total,
    g0: required(statusMap["G0 签发"], "G0 签发"),
    ddev,
    development,
    resourceBaseline,
    health: required(statusMap["健康度"], "健康度"),
    ...feeStatus,
  };
  return {
    ...status,
    approvalReady,
    d0Completed,
    problemFitReady,
    g0Ready,
    ddevReady,
    statusAxes: {
      direction: statusAxisDirection(priority, status.direction),
      approval: `公司批准 · ${status.approval}`,
      "problem-fit": `问题适配 · ${status.problemFit}`,
      external: `外部责任包 · ${status.externalPass} / ${status.externalTotal}`,
      scope: `Scope · ${status.scopePass} / ${status.scopeTotal}`,
      resource: `资源基线 · ${status.resourceBaseline}`,
      ddev: `Ddev · ${status.ddev}`,
    },
  };
}

export function latestSourceDate(entries) {
  const dates = entries.flatMap(({ text }) =>
    [...text.matchAll(/v\d+(?:\.\d+)*\s*·\s*(\d{4}-\d{2}-\d{2})/g)].map((match) => match[1])
  );
  if (!dates.length) throw new Error("无法从真源版本行解析发布日期");
  return dates.sort().at(-1);
}
