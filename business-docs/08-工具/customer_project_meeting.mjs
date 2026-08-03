function stripMarkdown(value) {
  return String(value ?? "")
    .trim()
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/<br\s*\/?>/gi, " / ")
    .replace(/\s+/g, " ")
    .trim();
}

export const MEETING_SENSITIVE_TEXT_PATTERN = new RegExp(
  [
    "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}",
    "(?:\\+?86[- ]?)?1[3-9](?:[- ]?\\d){9}",
    "(?:https?:\\/\\/|www\\.)",
    "[A-Z0-9-]+\\.(?:com|cn|net|org)(?=[^A-Z0-9-]|$)",
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

export const MEETING_PROPOSAL_FIELD_LIMITS = Object.freeze({
  name: 24,
  phaseOneFocus: 40,
  workingBoundary: 96,
  shadowGate: 64,
  meetingAction: 28,
});

function getSection(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) throw new Error(`需求会议程缺少章节：${heading}`);
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
  if (lines.length < 3) throw new Error(`${label}没有可解析表格`);
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

export function readCanonicalMeetingAgenda(ledger) {
  return parseTable(
    getSection(ledger, "## 4. 8 月 4 日启动会议程"),
    "G0 台账第 4 节议程"
  ).map((row) => ({
    time: row["分钟"],
    topic: row["议题"],
    decision: row["必须形成的结论"],
  }));
}

export function readFacilitatorMeetingAgenda(cadence) {
  return parseTable(
    getSection(cadence, "## 2. 60 分钟启动会怎么开"),
    "启动会手册第 2 节议程"
  ).map((row) => ({
    time: row["时间"],
    topic: row["讲什么"],
    decision: row["必须得到的结果"],
  }));
}

export function assertMeetingAgendaConsistency(ledger, cadence) {
  const canonical = readCanonicalMeetingAgenda(ledger);
  const facilitator = readFacilitatorMeetingAgenda(cadence);
  if (canonical.length !== 8) {
    throw new Error(`需求会议程必须为 8 段，当前唯一真源为 ${canonical.length} 段`);
  }
  if (JSON.stringify(canonical) !== JSON.stringify(facilitator)) {
    const mismatch = canonical.findIndex((row, index) =>
      JSON.stringify(row) !== JSON.stringify(facilitator[index])
    );
    throw new Error(
      `需求会议程真源漂移：02 台账与 06 主持版第 ${mismatch + 1} 段不一致`
    );
  }
  let expectedStart = 0;
  canonical.forEach((row, index) => {
    const match = row.time.match(/^(\d+)～(\d+)$/);
    if (!match) {
      throw new Error(`需求会议程第 ${index + 1} 段时间格式错误：${row.time}`);
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start !== expectedStart || end <= start) {
      throw new Error(
        `需求会议程必须连续且不重叠：第 ${index + 1} 段应从 ${expectedStart} 分钟开始，当前为 ${row.time}`
      );
    }
    expectedStart = end;
  });
  if (expectedStart !== 60) {
    throw new Error(`需求会议程必须完整覆盖 0～60 分钟，当前结束于 ${expectedStart} 分钟`);
  }
  return canonical;
}

const FROZEN_MEETING_FORBIDDEN_PATTERNS = Object.freeze([
  /\bsources\b/i,
  /portablePrd/i,
  /\bG0(?:-|\b)/i,
  /\bDdev\b/i,
  /\bFDE\b/i,
  /\bDEC\b/i,
  /\bRACI\b/i,
  /\bEVD[-_]/i,
  /\bROLE[-_]/i,
  /\bUSR[-_]/i,
  /费用|风险/,
  /<a\b[^>]*href=["']https?:/i,
  /<script\b[^>]*src=/i,
  /<link\b[^>]*href=["']https?:/i,
  /\.md(?:["'#?\s<]|$)/i,
]);

const FROZEN_MEETING_STRING_FORBIDDEN_PATTERN =
  /\b(?:DEC|PARKING|FDE|G0|Ddev|RACI|EVD|ROLE|USR)\b|\b(?:EVD|ROLE|USR)[-_]|技术栈|技术框架|内部台账|证据代号|费用|风险/i;
const FROZEN_MEETING_MARKUP_PATTERN =
  /(?:^|\s)#{1,6}\s|(?:^|\s)(?:[-*+]\s|\d+\.\s)|[`*_~]|\[[^\]]*\]\([^)]*\)|<\/?[a-z][^>]*>/i;

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`启动会冻结快照 ${label} 不是对象`);
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`启动会冻结快照 ${label} 字段越界：${actualKeys.join(", ")}`);
  }
}

function assertSafePayloadStrings(value, trail = "payload") {
  if (typeof value === "string") {
    if (Array.from(value).length > 180) {
      throw new Error(`启动会冻结快照 ${trail} 超出 180 字符上限`);
    }
    if (FROZEN_MEETING_STRING_FORBIDDEN_PATTERN.test(value)) {
      throw new Error(`启动会冻结快照 ${trail} 包含内部状态码、治理术语或禁区内容`);
    }
    if (trail !== "payload.release.id" && MEETING_SENSITIVE_TEXT_PATTERN.test(value)) {
      throw new Error(`启动会冻结快照 ${trail} 包含联系方式、外部地址或长资源标识`);
    }
    if (FROZEN_MEETING_MARKUP_PATTERN.test(value)) {
      throw new Error(`启动会冻结快照 ${trail} 包含 Markdown 或 HTML`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafePayloadStrings(item, `${trail}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) =>
      assertSafePayloadStrings(item, `${trail}.${key}`)
    );
  }
}

function assertMeetingPayloadSchema(payload) {
  assertExactKeys(payload, ["project", "state", "meeting", "release"], "payload");
  assertExactKeys(payload.project, ["name", "code"], "project");
  assertExactKeys(payload.state, ["approval", "direction", "development"], "state");
  assertExactKeys(
    payload.meeting,
    ["agenda", "decisions", "decisionOptions", "proposal", "coreQuestions", "factCards"],
    "meeting"
  );
  assertExactKeys(payload.release, ["id"], "release");
  if (
    !Array.isArray(payload.meeting.agenda) ||
    !Array.isArray(payload.meeting.decisions) ||
    payload.meeting.agenda.length !== 8 ||
    payload.meeting.decisions.length !== 9
  ) {
    throw new Error("启动会冻结快照必须保留 8 段议程与 9 项结果");
  }
  if (
    !Array.isArray(payload.meeting.decisionOptions) ||
    !Array.isArray(payload.meeting.coreQuestions) ||
    payload.meeting.decisionOptions.length !== 4 ||
    payload.meeting.coreQuestions.length !== 3
  ) {
    throw new Error("启动会冻结快照必须保留 4 种结果状态与 3 个核心问题");
  }
  if (!Array.isArray(payload.meeting.factCards) || payload.meeting.factCards.length > 2) {
    throw new Error("启动会冻结快照事实卡最多 2 张");
  }
  payload.meeting.agenda.forEach((item, index) =>
    assertExactKeys(item, ["topic", "decision"], `agenda[${index}]`)
  );
  payload.meeting.decisions.forEach((item, index) =>
    assertExactKeys(item, ["title"], `decisions[${index}]`)
  );
  payload.meeting.decisionOptions.forEach((item, index) =>
    assertExactKeys(item, ["value", "label"], `decisionOptions[${index}]`)
  );
  const expectedDecisionOptions = [
    { value: "confirmed", label: "已确认" },
    { value: "confirm-on-site", label: "待共同确认" },
    { value: "needs-evidence", label: "待补材料" },
    { value: "not-in-this-meeting", label: "本次暂不决定" },
  ];
  if (JSON.stringify(payload.meeting.decisionOptions) !== JSON.stringify(expectedDecisionOptions)) {
    throw new Error("启动会冻结快照 4 种结果状态语义发生漂移");
  }
  if (!payload.meeting.coreQuestions.every((item) => typeof item === "string")) {
    throw new Error("启动会冻结快照核心问题必须为 3 个字符串");
  }
  assertExactKeys(
    payload.meeting.proposal,
    ["name", "phaseOneFocus", "workingBoundary", "shadowGate", "meetingAction"],
    "proposal"
  );
  for (const [field, limit] of Object.entries(MEETING_PROPOSAL_FIELD_LIMITS)) {
    const value = payload.meeting.proposal[field];
    if (typeof value !== "string" || Array.from(value).length > limit) {
      throw new Error(`启动会冻结快照 proposal.${field} 必须为不超过 ${limit} 字符的字符串`);
    }
  }
  payload.meeting.factCards.forEach((item, index) => {
    assertExactKeys(
      item,
      ["userType", "platform", "task", "frequency", "currentFlow", "impact", "status"],
      `factCards[${index}]`
    );
    for (const [field, limit] of Object.entries(FACT_CARD_FIELD_LIMITS)) {
      const value = item[field];
      if (typeof value !== "string" || Array.from(value).length > limit) {
        throw new Error(`启动会冻结快照 factCards[${index}].${field} 必须为不超过 ${limit} 字符的字符串`);
      }
    }
  });
  assertSafePayloadStrings(payload);
}

export function assertSafeMeetingArtifact(html) {
  if (typeof html !== "string" || !html.trim()) {
    throw new Error("启动会冻结快照不存在或为空");
  }
  if (!html.includes("GENERATED FILE — safe meeting view; DO NOT EDIT")) {
    throw new Error("启动会冻结快照缺少受控生成标记");
  }
  const releaseId = html.match(/<html\b[^>]*\bdata-release="([^"]+)"/)?.[1] || "";
  if (!/^meeting-v1-[a-f0-9]{12}$/.test(releaseId)) {
    throw new Error("启动会冻结快照 release ID 无效");
  }
  const bodyRelease = html.match(/<body\b[^>]*\bdata-release="([^"]+)"/)?.[1] || "";
  if (bodyRelease !== releaseId) {
    throw new Error("启动会冻结快照 html / body release ID 不一致");
  }
  const payloadText = html.match(
    /<script id="meeting-data" type="application\/json">([\s\S]*?)<\/script>/
  )?.[1];
  if (!payloadText) throw new Error("启动会冻结快照缺少 meeting-data");
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw new Error("启动会冻结快照 meeting-data 不是有效 JSON");
  }
  if (payload?.release?.id !== releaseId) {
    throw new Error("启动会冻结快照 payload / 页面 release ID 不一致");
  }
  assertMeetingPayloadSchema(payload);
  const forbiddenHits = FROZEN_MEETING_FORBIDDEN_PATTERNS.filter((pattern) =>
    pattern.test(html)
  );
  if (forbiddenHits.length) {
    throw new Error(`启动会冻结快照包含禁区内容：${forbiddenHits.map(String).join("、")}`);
  }
  const htmlWithoutVendorOrImages = html
    .replace(
      /(<script id="pretext-source" type="text\/plain">)[\s\S]*?(<\/script>)/i,
      "$1$2"
    )
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "data:image;base64,REMOVED")
    .replaceAll(releaseId, "meeting-release-removed");
  if (MEETING_SENSITIVE_TEXT_PATTERN.test(htmlWithoutVendorOrImages)) {
    throw new Error("启动会冻结快照页面静态内容包含联系方式、外部地址或长资源标识");
  }
  if (
    /__MEETING_DATA__|__PRETEXT_VENDOR__|__RELEASE_ID__|__BRAND_LOGO_DATA_URI__|__FAVICON_DATA_URI__|__APPLE_TOUCH_ICON_DATA_URI__/.test(
      html
    )
  ) {
    throw new Error("启动会冻结快照仍包含模板占位符");
  }
  return { releaseId, payload };
}
