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
    getSection(cadence, "## 2. 60 分钟会议怎么开"),
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
