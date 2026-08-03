import { assertMeetingAgendaConsistency } from "./customer_project_meeting.mjs";
import { deriveProjectStatus } from "./customer_project_status.mjs";

export function stripMarkdown(value) {
  return String(value ?? "")
    .trim()
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/<br\s*\/?>/gi, " / ")
    .replace(/\s+/g, " ")
    .trim();
}

export function humanizeMeetingText(value) {
  return stripMarkdown(value)
    .replace(/DEC-REQ-01～09\s*/g, "九项决定")
    .replace(/工程答疑人（FDE）/g, "工程答疑人")
    .replace(/DEC（已决定）/g, "__MEETING_DEC__")
    .replace(/PRECONFIRM（会前已填、现场待确认）/g, "__MEETING_PRECONFIRM__")
    .replace(/OPEN（待补证）/g, "__MEETING_OPEN__")
    .replace(/PARKING（不在本会决定）/g, "__MEETING_PARKING__")
    .replace(/\s*\bDEC\b/g, "已决定（DEC）")
    .replace(/\s*\bPRECONFIRM\b/g, "待确认（PRECONFIRM）")
    .replace(/\s*\bOPEN\b/g, "待补证（OPEN）")
    .replace(/\s*\bPARKING\b/g, "会后处理（PARKING）")
    .replace(/\s*\bOwner\b\s*/g, "负责人")
    .replace(/\s*\bFDE\b\s*/g, "工程答疑人")
    .replace(/\s*\bADR\b\s*/g, "技术记录")
    .replace(/\bIn\s*\/\s*Out\b/g, "做什么 / 不做什么")
    .replace(/__MEETING_DEC__/g, "已决定（DEC）")
    .replace(/__MEETING_PRECONFIRM__/g, "待确认（PRECONFIRM，会前已填）")
    .replace(/__MEETING_OPEN__/g, "待补证（OPEN）")
    .replace(/__MEETING_PARKING__/g, "会后处理（PARKING）")
    .replace(/\s*\/\s*/g, " / ");
}

export function requiredMatch(text, pattern, label) {
  const match = text.match(pattern);
  if (!match) throw new Error(`无法从真源解析：${label}`);
  return stripMarkdown(match[1]);
}

export function getSection(text, heading) {
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

export function parseTable(sectionText, label) {
  const sectionLines = sectionText.split(/\r?\n/).map((line) => line.trim());
  const tableStart = sectionLines.findIndex(
    (line) => line.startsWith("|") && line.endsWith("|")
  );
  const lines = [];
  if (tableStart >= 0) {
    for (let index = tableStart; index < sectionLines.length; index += 1) {
      const line = sectionLines[index];
      if (!line.startsWith("|") || !line.endsWith("|")) break;
      lines.push(line);
    }
  }
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

export function parseChecklist(sectionText) {
  return [...sectionText.matchAll(/^- \[ \]\s+(.+)$/gm)].map((match) =>
    stripMarkdown(match[1])
  );
}

export function parseBullets(sectionText) {
  return [...sectionText.matchAll(/^-\s+(.+)$/gm)].map((match) => stripMarkdown(match[1]));
}

function parseNumberedList(sectionText) {
  return [...sectionText.matchAll(/^\d+\.\s+(.+)$/gm)].map((match) => stripMarkdown(match[1]));
}

export function assertIncludes(text, value, label) {
  if (!text.includes(value)) {
    throw new Error(`真源一致性失败：${label} 缺少“${value}”`);
  }
}

function requiredInteger(text, pattern, label) {
  const value = requiredMatch(text, pattern, label);
  if (!/^\d+$/.test(value)) throw new Error(`无法从真源解析：${label}`);
  return Number(value);
}

function assertContractSame(label, left, right) {
  if (left !== right) {
    throw new Error(`真源一致性失败：${label}（${left} != ${right}）`);
  }
}

export function readAcceptanceContract(charter, scope) {
  const overallTop3 = requiredInteger(
    scope,
    /总体正例 Top3 ≥\s*\*\*(\d+)%\*\*/,
    "总体 Top3 门槛"
  );
  const stratumTop3 = requiredInteger(
    scope,
    /每个已冻结分层 Top3 ≥\s*\*\*(\d+)%\*\*/,
    "分层 Top3 门槛"
  );
  const stratumMinHits = requiredInteger(
    scope,
    /每个已冻结分层 Top3[^\n]*且至少命中 (\d+) 条/,
    "分层 Top3 最小命中数"
  );
  const citationCorrect = requiredInteger(
    scope,
    /总体及各分层(?:来源|引用)\s*\/\s*版本(?:\s*\/\s*适用范围)?正确率\s*=\s*\*\*(\d+)%\*\*/,
    "来源 / 版本正确率"
  );
  const negativeMaxWrongAnswers = requiredInteger(
    scope,
    /负例错误直答 =\s*\*\*(\d+)\*\*/,
    "负例错误直答门槛"
  );
  const riskMatch = scope.match(/六类风险负例为([^；\n]+)；每类至少\s*(\d+)\s*条/);
  if (!riskMatch) throw new Error("无法从真源解析：六类风险负例门槛");
  const riskTypes = riskMatch[1].split("、").map(stripMarkdown).filter(Boolean);
  if (riskTypes.length !== 6) {
    throw new Error(`六类风险负例必须恰好解析为 6 类，当前为 ${riskTypes.length} 类`);
  }
  const negativeCasesPerType = Number(riskMatch[2]);
  const negativeMinCases = riskTypes.length * negativeCasesPerType;

  const charterOverallTop3 = requiredInteger(
    charter,
    /Top3 命中率(?:暂定)?\s*≥(\d+)%/,
    "章程总体 Top3 门槛"
  );
  const charterCitation = requiredInteger(
    charter,
    /引用\s*\/\s*版本正确率\s*=\s*(\d+)%/,
    "章程来源 / 版本正确率"
  );
  const charterNegativePerType = requiredInteger(
    charter,
    /六类风险各不少于\s*(\d+)\s*条/,
    "章程六类风险负例门槛"
  );
  assertContractSame("总体 Top3 门槛", overallTop3, charterOverallTop3);
  assertContractSame("来源 / 版本正确率", citationCorrect, charterCitation);
  assertContractSame("每类负例最小数", negativeCasesPerType, charterNegativePerType);

  return {
    overallTop3,
    stratumTop3,
    stratumMinHits,
    citationCorrect,
    riskTypes,
    negativeCasesPerType,
    negativeMinCases,
    negativeMaxWrongAnswers,
  };
}

const SENSITIVE_FACT_PATTERN = new RegExp(
  [
    "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}",
    "(?:\\+?86[- ]?)?1[3-9](?:[- ]?\\d){9}",
    "(?:https?:\\/\\/|www\\.)",
    "[A-Z0-9-]+\\.(?:com|cn|net|org)(?:\\/|\\s|$)",
    "\\b(?:EVD|ROLE|USR)[-_][A-Z0-9-]+\\b",
    "\\b\\d{8,}\\b",
    "\\b(?=[A-Z0-9-]{12,}\\b)(?=[A-Z0-9-]*\\d)[A-Z0-9-]+\\b",
  ].join("|"),
  "i"
);

export const FACT_CARD_FIELD_LIMITS = Object.freeze({
  userType: 16,
  platform: 20,
  task: 36,
  frequency: 24,
  currentFlow: 60,
  impact: 48,
  status: 10,
});

const FACT_CARD_FIELD_LABELS = Object.freeze({
  userType: "主用户类别",
  platform: "平台",
  task: "任务",
  frequency: "频次 / 样本",
  currentFlow: "当前流程与问题",
  impact: "业务影响",
  status: "状态",
});

export const MEETING_PROPOSAL_FIELD_LIMITS = Object.freeze({
  name: 24,
  phaseOneFocus: 40,
  workingBoundary: 96,
  shadowGate: 64,
  meetingAction: 28,
});

const MEETING_PROPOSAL_FIELDS = Object.freeze([
  { label: "建议名称", key: "name" },
  { label: "一期切口", key: "phaseOneFocus" },
  { label: "工作边界", key: "workingBoundary" },
  { label: "灰度前门", key: "shadowGate" },
  { label: "会中动作", key: "meetingAction" },
]);

const MEETING_INTERNAL_TERM_PATTERN =
  /\b(?:DEC|PRECONFIRM|OPEN|PARKING|FDE|G0|Ddev|RACI|EVD|ROLE|USR)\b|技术栈|技术框架|内部台账|证据代号/i;

const MARKDOWN_SYNTAX_PATTERN =
  /(?:^|\s)#{1,6}\s|(?:^|\s)(?:[-*+]\s|\d+\.\s)|[`*_~]|\[[^\]]*\]\([^)]*\)|<\/?[a-z][^>]*>/i;

function readFactCards(ledger) {
  const rows = parseTable(
    getSection(ledger, "## 4C. 可投影脱敏事实卡"),
    "可投影脱敏事实卡"
  );
  if (rows.length > 2) throw new Error(`可投影脱敏事实卡最多 2 张，当前为 ${rows.length} 张`);
  const expectedIds = ["FACT-01", "FACT-02"];
  return rows.map((row, index) => {
    if (row["事实卡"] !== expectedIds[index]) {
      throw new Error(`脱敏事实卡必须按 ${expectedIds.join(" / ")} 排列`);
    }
    const card = {
      userType: row["主用户类别"] || "OPEN",
      platform: row["平台"] || "OPEN",
      task: row["任务"] || "OPEN",
      frequency: row["频次 / 样本"] || "OPEN",
      currentFlow: row["当前流程与问题"] || "OPEN",
      impact: row["业务影响"] || "OPEN",
      status: row["状态"] || "OPEN",
    };
    if (!["OPEN", "PRECONFIRM", "READY"].includes(card.status)) {
      throw new Error(`事实卡 ${expectedIds[index]} 状态只允许 OPEN / PRECONFIRM / READY`);
    }
    for (const [field, value] of Object.entries(card)) {
      const limit = FACT_CARD_FIELD_LIMITS[field];
      if (Number.isInteger(limit) && Array.from(value).length > limit) {
        throw new Error(
          `事实卡 ${expectedIds[index]} 的 ${FACT_CARD_FIELD_LABELS[field] || field} 最多 ${limit} 个字符，已拒绝生成`
        );
      }
      if (SENSITIVE_FACT_PATTERN.test(value)) {
        throw new Error(`事实卡 ${expectedIds[index]} 的 ${field} 包含明显敏感信息，已拒绝生成`);
      }
    }
    return card;
  });
}

export function readMeetingProposal(ledger) {
  const rows = parseTable(
    getSection(ledger, "## 4P. 项目侧推荐方案（PRECONFIRM）"),
    "项目侧推荐方案"
  );
  if (rows.length !== MEETING_PROPOSAL_FIELDS.length) {
    throw new Error(
      `项目侧推荐方案必须且只能有 ${MEETING_PROPOSAL_FIELDS.length} 个可投影字段`
    );
  }

  const proposal = {};
  rows.forEach((row, index) => {
    const expected = MEETING_PROPOSAL_FIELDS[index];
    if (row["字段"] !== expected.label) {
      throw new Error(
        `项目侧推荐方案第 ${index + 1} 行必须是“${expected.label}”，当前为“${row["字段"] || "空"}”`
      );
    }
    const value = String(row["可投影内容"] || "").trim();
    if (!value) throw new Error(`项目侧推荐方案的“${expected.label}”不能为空`);
    const limit = MEETING_PROPOSAL_FIELD_LIMITS[expected.key];
    if (Array.from(value).length > limit) {
      throw new Error(
        `项目侧推荐方案的“${expected.label}”最多 ${limit} 个字符，已拒绝生成`
      );
    }
    if (SENSITIVE_FACT_PATTERN.test(value)) {
      throw new Error(`项目侧推荐方案的“${expected.label}”包含明显敏感信息`);
    }
    if (MEETING_INTERNAL_TERM_PATTERN.test(value)) {
      throw new Error(`项目侧推荐方案的“${expected.label}”包含内部状态码或技术术语`);
    }
    if (MARKDOWN_SYNTAX_PATTERN.test(value)) {
      throw new Error(`项目侧推荐方案的“${expected.label}”必须是纯文本，不能包含 Markdown 或 HTML`);
    }
    proposal[expected.key] = value;
  });
  return proposal;
}

export function buildCustomerProjectSurfaceModel(sourceById) {
  for (const sourceId of ["charter", "schedule", "ledger", "scope", "cost"]) {
    assertIncludes(sourceById[sourceId], "2026-08-04", sourceId);
  }
  for (const sourceId of ["charter", "schedule", "ledger", "scope", "cost", "delivery"]) {
    assertIncludes(sourceById[sourceId], "Ddev", sourceId);
  }
  assertIncludes(sourceById.charter, "禁止自动代发", "charter");
  assertIncludes(sourceById.schedule, "供应链是独立 P1", "schedule");
  assertIncludes(sourceById.cost, "B（钱后置）", "cost");
  assertIncludes(sourceById.cost, "保持 0 支出", "cost");

  const projectStatus = deriveProjectStatus({
    charter: sourceById.charter,
    schedule: sourceById.schedule,
    ledger: sourceById.ledger,
    scope: sourceById.scope,
    cost: sourceById.cost,
  });
  const agenda = assertMeetingAgendaConsistency(sourceById.ledger, sourceById.cadence).map(
    (row) => ({
      time: row.time,
      topic: humanizeMeetingText(row.topic),
      decision: humanizeMeetingText(row.decision),
    })
  );
  const decisions = parseTable(
    getSection(sourceById.ledger, "## 4A. 九项决定在 60 分钟内怎样处理"),
    "九项决定"
  ).map((row) => {
    const match = row["决策 ID"]?.match(/^(DEC-REQ-\d{2})\s*·\s*(.+)$/);
    if (!match) throw new Error(`九项决定标题格式无效：${row["决策 ID"] || "空"}`);
    return { id: match[1], title: match[2] };
  });
  if (
    decisions.length !== 9 ||
    decisions.some((item, index) => item.id !== `DEC-REQ-${String(index + 1).padStart(2, "0")}`)
  ) {
    throw new Error("九项决定必须按 DEC-REQ-01～09 连续排列");
  }
  const facilitation = parseBullets(
    getSection(sourceById.cadence, "## 2. 60 分钟启动会怎么开")
  ).map(humanizeMeetingText);
  if (facilitation.length < 6) {
    throw new Error(`60 分钟主持规则至少应有 6 条，当前解析到 ${facilitation.length} 条`);
  }
  const coreQuestions = parseNumberedList(
    getSection(sourceById.cadence, "### 会中直接使用的提问")
  );
  if (coreQuestions.length !== 9) {
    throw new Error(`会中核心提问应为 9 条，当前解析到 ${coreQuestions.length} 条`);
  }

  return {
    project: {
      name: requiredMatch(
        sourceById.charter,
        /\*\*项目正式名称：\*\*\s*([^\n]+)/,
        "项目名称"
      ),
      delivery: requiredMatch(
        sourceById.charter,
        /\*\*首期交付名称：\*\*\s*([^\n]+)/,
        "首期交付"
      ),
      code: requiredMatch(
        sourceById.charter,
        /\*\*项目代号：\*\*\s*([^\n]+)/,
        "项目代号"
      ),
      date: requiredMatch(
        sourceById.charter,
        /\*\*项目启动日 D0：\*\*\s*([^\n]+)/,
        "D0"
      ),
    },
    projectStatus,
    meeting: {
      agenda,
      decisions,
      facilitation,
      coreQuestions,
      factCards: readFactCards(sourceById.ledger),
      proposal: readMeetingProposal(sourceById.ledger),
    },
  };
}
