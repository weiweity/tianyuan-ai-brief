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

export function deriveProjectStatus({ charter, schedule, ledger, scope, cost }) {
  const statusRows = parseTable(getSection(ledger, "## 1. 当前状态"), "当前状态");
  const statusMap = Object.fromEntries(statusRows.map((row) => [row["项目项"], row["状态"]]));
  const allowedSummary = {
    "工作方向登记": ["已记录", "未记录", "Fail"],
    "公司正式批准": ["未完成", "进行中", "已完成", "已批准", "Pass", "Fail"],
    "业务问题优先级": ["待核验", "进行中", "已核验", "已确认", "Pass", "Fail", "未通过"],
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
  const allowedGateStatuses = new Set(["Pass", "待办", "进行中", "阻塞", "Fail"]);
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
  const requiredRoles = ["项目负责人", "客服业务 Owner", "话术真源 Owner", "预算责任人", "IT / 安全责任人", "IT 服务 / 运维责任人", "设计负责人", "前端负责人", "后端负责人", "AI / RAG 负责人", "QA 负责人", "数据 / 内容接口人", "业务验收人"];
  if (new Set(raciRows.map((row) => row["角色"])).size !== raciRows.length || requiredRoles.some((role) => !raciRows.some((row) => row["角色"] === role))) {
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
  }
  const requireRaciRole = (role) => {
    const row = raciRows.find((item) => item["角色"] === role);
    if (!isPersonCode(row?.["人员代号"] || "") || !isPersonCode(row?.["代理人代号"] || "")) {
      throw new Error(`G0 角色 ${role} 必须填写人员与代理人代号`);
    }
    requireEvidenceId(row["接受职责证据 ID"], `G0 角色 ${role} 接受职责`);
    if (!new Set(["已接受", "Pass"]).has(row["状态"])) throw new Error(`G0 角色 ${role} 必须明确接受职责`);
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
  const preDdevStages = new Set(["启动前 / G0", "G0", "G0 中检", "G0 决策", "G0 已通过 / 待 Ddev"]);
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
  const roleGateMap = {
    "G0-04": "客服业务 Owner",
    "G0-05": "话术真源 Owner",
    "G0-07": "预算责任人",
    "G0-11": "IT / 安全责任人",
    "G0-12": "IT 服务 / 运维责任人",
    "G0-14": "项目负责人",
  };
  for (const [gateId, role] of Object.entries(roleGateMap)) {
    if (gateById[gateId] === "Pass") requireRaciRole(role);
  }
  if (g0Ready) {
    for (const role of requiredRoles) requireRaciRole(role);
    const independentRoles = ["项目负责人", "客服业务 Owner", "预算责任人", "IT / 安全责任人"];
    const roleCodes = independentRoles.map((role) => raciRows.find((row) => row["角色"] === role)["人员代号"]);
    if (new Set(roleCodes).size !== roleCodes.length) throw new Error("G0 签发时项目、业务、预算与 IT / 安全责任人必须职责分离");
  }
  const g0Failed = statusMap["G0 签发"] === "Fail";
  if (g0Ready || g0Failed) {
    const signRows = parseTable(getSection(ledger, "### G0 签发记录"), "G0 签发记录");
    const signMap = Object.fromEntries(signRows.map((row) => [row["字段"], row["填写"]]));
    const reviewDate = String(signMap["评审时间"] || "").match(/\d{4}-\d{2}-\d{2}/)?.[0];
    if (!reviewDate || !isValidIsoDate(reviewDate)) throw new Error("G0 已签发时必须填写有效评审时间");
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
    const signedDdev = String(signMap.Ddev || "").trim();
    if (ddevReady && signedDdev !== ddev) throw new Error("G0 签发记录 Ddev 必须与当前状态一致");
    if (!ddevReady && signedDdev && !/^(?:待签发|未成立)$/.test(signedDdev)) throw new Error("Ddev 未成立时签发记录不得填写其他值");
    if (g0Failed && signedDdev && signedDdev !== "未成立") throw new Error("G0 Fail 时签发记录 Ddev 必须为空或未成立");
    if (isValidIsoDate(ddev) && ddev < reviewDate) throw new Error("Ddev 日期不得早于 G0 评审签发日期");
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
