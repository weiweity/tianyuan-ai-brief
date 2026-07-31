import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveProjectStatus, isChecked, latestSourceDate } from "./customer_project_status.mjs";
import { resolveCustomerProjectWorkspace } from "./project_workspace.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const { projectDir } = await resolveCustomerProjectWorkspace(import.meta.url);
const prdPath = path.join(projectDir, "07-客服Agent立项PRD.html");
const canonicalOutputPath = path.join(projectDir, "08-客服Agent立项执行中心.html");
const templatePath = path.join(
  scriptDir,
  "templates/customer-agent-hub.template.html"
);
const outputArg = process.argv.find((value) => value.startsWith("--output="));
const requestedOutput = outputArg
  ? outputArg.slice("--output=".length)
  : process.env.HUB_OUTPUT || canonicalOutputPath;
const checkOnly = process.argv.includes("--check");

function resolveProjectHtmlOutput(value) {
  const candidate = path.resolve(value);
  if (candidate !== canonicalOutputPath) {
    throw new Error(`Hub 输出只允许 canonical 文件：${canonicalOutputPath}`);
  }
  return candidate;
}

async function loadPretextVendor() {
  if (process.env.PRETEXT_VENDOR) {
    return (await readFile(path.resolve(process.env.PRETEXT_VENDOR), "utf8")).trim();
  }
  const prdHtml = await readFile(prdPath, "utf8");
  const match = [...prdHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].find(
    ([, attributes]) =>
      /\bid=["']pretext-source["']/i.test(attributes) &&
      /\btype=["']text\/plain["']/i.test(attributes)
  );
  if (!match || match[2].trim().length < 1000) {
    throw new Error(`无法从已跟踪 PRD 提取 Pretext：${prdPath}`);
  }
  const source = match[2].trim();
  if (!source.includes("export{") || !source.includes("prepare")) {
    throw new Error("PRD 中的 pretext-source 不是预期的模块源码");
  }
  return source;
}

const outputPath = resolveProjectHtmlOutput(requestedOutput);
try {
  const outputStat = await lstat(outputPath);
  if (outputStat.isSymbolicLink()) throw new Error("Hub 输出文件不能是符号链接");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const sourceDefinitions = [
  { id: "charter", file: "00-项目章程.md", label: "项目章程" },
  { id: "schedule", file: "01-总排期与阶段门禁.md", label: "总排期与阶段门禁" },
  { id: "ledger", file: "02-G0责任与证据台账.md", label: "G0 责任与证据台账" },
  { id: "scope", file: "03-Scope与验收.md", label: "Scope 与验收" },
  { id: "cost", file: "04-费用与成本控制.md", label: "费用与成本控制" },
  { id: "delivery", file: "05-全栈交付计划.md", label: "全栈交付计划" },
  { id: "cadence", file: "06-启动会与周推进.md", label: "启动会与周推进" },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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

function requiredMatch(text, pattern, label) {
  const match = text.match(pattern);
  if (!match) throw new Error(`无法从真源解析：${label}`);
  return stripMarkdown(match[1]);
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
  const contentRows = rows
    .slice(1)
    .filter(
      (row) =>
        !row.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))
    );
  return contentRows.map((row) =>
    Object.fromEntries(header.map((key, index) => [key, row[index] ?? ""]))
  );
}

function parseChecklist(sectionText) {
  return [...sectionText.matchAll(/^- \[ \]\s+(.+)$/gm)].map((match) =>
    stripMarkdown(match[1])
  );
}

function parseBullets(sectionText) {
  return [...sectionText.matchAll(/^-\s+(.+)$/gm)].map((match) =>
    stripMarkdown(match[1])
  );
}

function assertIncludes(text, value, label) {
  if (!text.includes(value)) {
    throw new Error(`真源一致性失败：${label} 缺少“${value}”`);
  }
}

function shortDate(value) {
  const match = String(value).match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`日期格式不是 YYYY-MM-DD：${value}`);
  return `${match[1]}-${match[2]}`;
}

const sourceEntries = await Promise.all(
  sourceDefinitions.map(async (source) => {
    const sourcePath = path.join(projectDir, source.file);
    const text = await readFile(sourcePath, "utf8");
    return {
      ...source,
      sourcePath,
      text,
      hash: sha256(text),
    };
  })
);
const sourceById = Object.fromEntries(
  sourceEntries.map((source) => [source.id, source.text])
);
const [template, pretextVendor, generatorSource, statusModuleSource] = await Promise.all([
  readFile(templatePath, "utf8"),
  loadPretextVendor(),
  readFile(scriptPath, "utf8"),
  readFile(path.join(scriptDir, "customer_project_status.mjs"), "utf8"),
]);

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
  ledger: sourceById.ledger,
  scope: sourceById.scope,
  cost: sourceById.cost,
});

const projectName = requiredMatch(
  sourceById.charter,
  /\*\*项目正式名称：\*\*\s*([^\n]+)/,
  "项目名称"
);
const deliveryName = requiredMatch(
  sourceById.charter,
  /\*\*首期交付名称：\*\*\s*([^\n]+)/,
  "首期交付"
);
const projectCode = requiredMatch(
  sourceById.charter,
  /\*\*项目代号：\*\*\s*([^\n]+)/,
  "项目代号"
);
const d0 = requiredMatch(
  sourceById.charter,
  /\*\*项目启动日 D0：\*\*\s*([^\n]+)/,
  "D0"
);
const g0Target = requiredMatch(
  sourceById.ledger,
  /\*\*G0 决策日：\*\*\s*目标\s*([^\n]+)/,
  "G0 目标日"
);
const preScoreDeadline = requiredMatch(
  sourceById.cadence,
  /在\s*(\d{2}-\d{2}\s+\d{2}:\d{2})\s*前完成统一评分卡/,
  "独立预评分截止"
);

const gateRows = parseTable(
  getSection(sourceById.ledger, "## 2. G0 硬门禁"),
  "G0 硬门禁"
);
if (gateRows.length !== 15) {
  throw new Error(`G0 门禁应为 15 项，当前解析到 ${gateRows.length} 项`);
}
const gateIds = gateRows.map((row) => row.ID);
if (new Set(gateIds).size !== gateIds.length) {
  throw new Error("G0 门禁 ID 重复");
}

const scopeRows = parseTable(
  getSection(sourceById.scope, "## A. 进入 Scope 冻结（③）检查表"),
  "Scope 冻结检查"
);
if (scopeRows.length !== 15) {
  throw new Error(`Scope 检查应为 15 项，当前解析到 ${scopeRows.length} 项`);
}

const externalGates = gateRows.filter((row) => row.ID !== "G0-01");
const scheduleRows = parseTable(
  getSection(sourceById.schedule, "## 3. 8 月 4 日启动与 G0 日历"),
  "G0 日历"
);
const deliveryScheduleRows = parseTable(
  getSection(sourceById.schedule, "### 4.1 最小跨职能小队"),
  "Ddev 后交付基线"
);
const soloDeliveryScheduleRows = parseTable(
  getSection(sourceById.schedule, "### 4.2 单人全栈 / FDE 基线"),
  "单人全栈 / FDE 基线"
);
const meetingAgenda = parseTable(
  getSection(sourceById.ledger, "## 4. 8 月 4 日启动会议程"),
  "启动会议程"
);
const prelaunchChecklist = parseChecklist(
  getSection(sourceById.cadence, "## 1. 8 月 4 日前准备")
);
const risks = parseTable(
  getSection(sourceById.ledger, "## 9. RAID"),
  "RAID"
).filter((row) => row.ID?.startsWith("R-") && row["状态"].includes("开放"));
const roleRows = parseTable(
  getSection(sourceById.ledger, "## 5. RACI 具名区"),
  "RACI 具名区"
);
const functionRows = parseTable(
  getSection(sourceById.delivery, "## 3. 各职能交付物"),
  "各职能交付物"
);
const allowedRows = parseTable(
  getSection(sourceById.schedule, "## 6. 当前允许与禁止"),
  "当前允许与禁止"
);
const inScope = parseTable(
  getSection(sourceById.charter, "### 4.1 In Scope"),
  "In Scope"
);
const outOfScope = parseBullets(
  getSection(sourceById.charter, "### 4.2 Out of Scope")
);

function gateGroup(id) {
  const number = Number(id.split("-")[1]);
  if ([2, 4, 5, 7].includes(number)) return "approval";
  if ([3, 6, 9, 10].includes(number)) return "business";
  if ([11, 12, 13].includes(number)) return "safety";
  return "delivery";
}

const top3Target = requiredMatch(
  sourceById.scope,
  /总体正例 Top3 ≥\s*\*\*([^*]+)\*\*/,
  "Top3 门槛"
);
const citationTarget = requiredMatch(
  sourceById.scope,
  /总体及各分层引用 \/ 版本正确率 =\s*\*\*([^*]+)\*\*/,
  "引用正确率门槛"
);
const negativeTarget = requiredMatch(
  sourceById.scope,
  /负例错误直答 =\s*\*\*([^*]+)\*\*/,
  "负例门槛"
);
const pilotTarget = requiredMatch(
  sourceById.scope,
  /\*\*暂定门槛：\*\*\s*(≥\d+ 人 × 连续 \d+ 周)/,
  "内部试点门槛"
);
const allEvidenceReady =
  projectStatus.externalPass === projectStatus.externalTotal &&
  projectStatus.scopePass === projectStatus.scopeTotal;
const ddevReady = projectStatus.ddevReady;
const awaitingDdev = projectStatus.g0Ready && !ddevReady;
const currentFeePath = projectStatus.feePathCode;
const approvalFailed = projectStatus.approval === "Fail";
const problemFitFailed = ["Fail", "未通过"].includes(projectStatus.problemFit);
const g0Failed = projectStatus.g0 === "Fail";
const projectPaused = currentFeePath === "C" || approvalFailed || problemFitFailed || g0Failed;
const governanceBoundaries = ddevReady
  ? [
      { allowed: "只做已签 Ddev、Scope、费用与环境边界内的 WBS", forbidden: "自动代发、越权访问或未经 CR / DEC 的新增范围" },
      { allowed: "按测试、审计、监控与回退门禁迭代", forbidden: "未留测试证据、未演练回退或未授权的生产发布" },
      { allowed: "使用批准的数据、模型和账号", forbidden: "PII 越界、未批准出域、跨项目取数或绕过最小权限" },
    ]
  : allowedRows.map((row) => ({
      allowed: row["08-04 起可以做"],
      forbidden: row["Ddev 前禁止"],
    }));
const nextOpenGate = externalGates
  .filter((row) => row["状态"] !== "Pass")
  .sort((left, right) => left["截止"].localeCompare(right["截止"]))[0];
let headline;
if (ddevReady) {
  headline = {
      title: "Ddev 已成立，按授权边界推进。",
      summary: `公司批准、问题适配、${projectStatus.externalTotal} 项外部责任包与 ${projectStatus.scopeTotal} 项 Scope 已按真源更新；后续只按已签 Ddev 与费用路径执行。`,
      nextDate: projectStatus.ddev,
      nextTitle: "按 Ddev 推进",
      nextOutput: "WBS · 测试证据 · 回退记录",
    };
} else if (currentFeePath === "C") {
  headline = {
    title: "C 暂停路径已记录，不进入开发。",
    summary: `暂停原因：${projectStatus.feePauseReason}。复审前 Scope #11、G0 与 Ddev 必须保持未通过。`,
    nextDate: projectStatus.feeDecisionDate,
    nextTitle: "暂停复审",
    nextOutput: "暂停原因 · 解除条件 · 复审日期",
  };
} else if (approvalFailed) {
  headline = {
    title: "公司批准未通过，停止进入开发门禁。",
    summary: "可整理失败原因与补证行动，不得继续声称已立项、已批准或已授权开发。",
    nextDate: nextOpenGate?.["截止"] || shortDate(g0Target),
    nextTitle: "批准条件复审",
    nextOutput: "失败原因 · 补证 Owner · 复审日期",
  };
} else if (problemFitFailed) {
  headline = {
    title: "问题适配未通过，必须重定首期范围。",
    summary: "不得为匹配现有页面强留话术库 MVP-A；先登记 CR / DEC，再重新冻结 Scope。",
    nextDate: nextOpenGate?.["截止"] || shortDate(g0Target),
    nextTitle: "范围重定向",
    nextOutput: "CR / DEC · 新优先级 · 新 Scope",
  };
} else if (g0Failed) {
  headline = {
    title: "G0 已判 Fail，按阻塞行动项整改。",
    summary: "正式 Fail 结论优先于完成计数；完成整改、复审并重新签发前，Ddev 保持未成立。",
    nextDate: shortDate(g0Target),
    nextTitle: "G0 整改复审",
    nextOutput: "阻塞行动项 · 复审证据 · 新结论",
  };
} else if (!projectStatus.problemFitReady) {
  headline = {
        title: "现在不是开工，是把 G0 证据补齐。",
        summary: `工作方向已登记，不等于公司批准或问题适配；${preScoreDeadline} 前先交独立评分，${shortDate(d0)} 只做评分与证据复核。${projectStatus.externalTotal} 项外部责任包与 ${projectStatus.scopeTotal} 项 Scope 检查全部通过后，才可签发 Ddev。`,
        nextDate: preScoreDeadline,
        nextTitle: "独立预评分提交",
        nextOutput: "5 份原始评分 · 每候选 ≥3 样本 · 异常分清单",
      };
} else if (!allEvidenceReady) {
  headline = {
          title: "问题适配已核验，继续补齐 G0 证据。",
          summary: `当前外部责任包 ${projectStatus.externalPass}/${projectStatus.externalTotal}、Scope ${projectStatus.scopePass}/${projectStatus.scopeTotal}；任一未全量通过，Ddev 均不成立。`,
          nextDate: nextOpenGate?.["截止"] || shortDate(g0Target),
          nextTitle: nextOpenGate?.["责任包"] || "G0 证据补齐",
          nextOutput: nextOpenGate?.["完成证据"] || "可核验外部证据",
        };
} else if (!projectStatus.g0Ready) {
  headline = {
          title: "G0 证据已齐，等待正式签发。",
          summary: `外部责任包 ${projectStatus.externalPass}/${projectStatus.externalTotal}、Scope ${projectStatus.scopePass}/${projectStatus.scopeTotal} 已通过；仍须正式签发 G0 与 Ddev，不能由计数自动放行。`,
          nextDate: shortDate(g0Target),
          nextTitle: "G0 正式签发",
          nextOutput: "签发结论 · 审核人 · 证据包哈希 · Ddev",
        };
} else {
  headline = {
    title: "G0 已签发，等待 Ddev 到达可执行日期。",
    summary: `G0 已正式签发，但开发授权不能早于 ${projectStatus.earliestDdev}；Ddev 未填写前仍不得开发。`,
    nextDate: shortDate(projectStatus.earliestDdev),
    nextTitle: "Ddev 正式签发",
    nextOutput: "Ddev 日期 · 授权证据 ID · 授权范围 · 费用路径",
  };
}

const displaySchedule = ddevReady
  ? projectStatus.resourceBaseline === "单人全栈 / FDE"
    ? soloDeliveryScheduleRows.map((row) => ({
        date: `相对 Ddev 顺延 · 原基线 ${row["保守日期"]}`,
        title: row["里程碑"],
        action: "单人串行交付；不承诺最小小队日期",
        output: "按实际容量更新 DEC / CR",
      }))
    : deliveryScheduleRows.map((row) => ({
        date: `相对 Ddev 顺延 · 原基线 ${row["日期"]}`,
        title: row["阶段"],
        action: row["交付物"],
        output: row["出口"],
      }))
  : awaitingDdev
    ? [{ date: shortDate(projectStatus.earliestDdev), title: "Ddev 正式签发", action: "核对签发日期、授权证据 ID、范围、环境和费用路径", output: "Ddev · 授权边界 · 开发起始条件" }]
  : projectPaused
    ? [{ date: headline.nextDate, title: headline.nextTitle, action: headline.summary, output: headline.nextOutput }]
    : scheduleRows.map((row) => ({
        date: row["日期"],
        title: row["主题"],
        action: row["主要动作"],
        output: row["当日输出"],
      }));
const displayAgenda = ddevReady
  ? [
      { time: "0～10", topic: "Ddev 与变更边界", decision: "确认本次工作仍在已签授权、费用和 Scope 内" },
      { time: "10～35", topic: "WBS、质量与风险", decision: "核对完成证据、测试、阻塞、成本与回退" },
      { time: "35～50", topic: "业务与内容验收", decision: "确认内容版本、引用、人在环与业务验收差距" },
      { time: "50～60", topic: "下一门禁", decision: "具名 Owner、截止、证据与 CR / DEC" },
    ]
  : awaitingDdev
    ? [
        { time: "0～20", topic: "G0 签发复核", decision: "确认 G0 结论、证据包哈希与未决项" },
        { time: "20～40", topic: "Ddev 授权边界", decision: "确认日期、授权证据 ID、Scope、费用、环境与负责人" },
        { time: "40～60", topic: "开工条件", decision: "Ddev 未填写前不得开发；签发后按 WBS 启动" },
      ]
  : projectPaused
    ? [
        { time: "0～15", topic: "失败 / 暂停原因", decision: "冻结事实、影响与不可继续事项" },
        { time: "15～40", topic: "解除条件", decision: "逐项具名 Owner、证据和截止日" },
        { time: "40～60", topic: "复审安排", decision: "确认复审日期；此前 Ddev 保持未成立" },
      ]
    : meetingAgenda.map((row) => ({
        time: row["分钟"],
        topic: row["议题"],
        decision: row["必须形成的结论"],
      }));

const payload = {
  schemaVersion: 1,
  project: {
    name: projectName,
    delivery: deliveryName,
    code: projectCode,
    priority: projectStatus.priority,
    d0,
    g0Target,
  },
  status: {
    direction: projectStatus.direction,
    approval: projectStatus.approval,
    problemFit: projectStatus.problemFit,
    stage: projectStatus.stage,
    externalPass: projectStatus.externalPass,
    externalTotal: projectStatus.externalTotal,
    scopePass: projectStatus.scopePass,
    scopeTotal: projectStatus.scopeTotal,
    g0: projectStatus.g0,
    ddev: projectStatus.ddev,
    development: projectStatus.development,
    resourceBaseline: projectStatus.resourceBaseline,
    health: projectStatus.health,
    feePath: projectStatus.feePath,
    paidSpend: projectStatus.paidSpend,
  },
  headline: {
    ...headline,
    principle: "系统推荐 → 坐席确认 → 人工发送",
    nowTitle: ddevReady
      ? "按 Ddev、WBS 和证据链推进。"
      : awaitingDdev
        ? "G0 已签，等待 Ddev 正式授权。"
      : projectPaused
        ? "按暂停或整改条件行动，不越过门禁。"
        : "先把启动会和证据目录准备好。",
    nowSummary: ddevReady
      ? "只做 Ddev 已授权范围；每次变更保留测试、回退与决定证据。"
      : awaitingDdev
        ? `不得早于 ${projectStatus.earliestDdev} 开发；Ddev 日期与授权证据 ID 未填写前继续保持未开发。`
      : projectPaused
        ? "只补解除阻塞所需证据；不得开发、付费调用、部署或承诺试点。"
        : "只做能帮助 G0 决策的工作，不用代码提交制造“已经开工”的错觉。",
    actionLabel: ddevReady || projectPaused ? "当前行动" : awaitingDdev ? "Ddev 签发前" : "8 月 4 日前",
    scheduleTitle: ddevReady
      ? `Ddev 已签；按${projectStatus.resourceBaseline}基线相对顺延，不把原日期当最新承诺。`
      : awaitingDdev
        ? "G0 已签，Ddev 未成立；不提前开工。"
      : projectPaused
        ? "当前处于暂停 / 整改，不进入 Ddev。"
        : `${shortDate(d0)} 到 ${shortDate(g0Target)}，只承诺 G0。`,
  },
  prelaunchChecklist: ddevReady
    ? allowedRows.map((row) => row["08-04 起可以做"]).filter(Boolean).slice(0, 8)
    : awaitingDdev
      ? ["核对 G0 签发结论与证据包哈希", "确认 Ddev 最早日期与授权证据 ID", "冻结授权 Scope、费用路径、环境和负责人", "Ddev 未填写前保持产品开发未开始"]
    : projectPaused
      ? ["记录失败或暂停原因", "具名补证 Owner 与截止日", "冻结开发、付费调用、部署和试点承诺", "达到解除条件后重新评审"]
    : prelaunchChecklist.slice(0, 8),
  schedule: displaySchedule,
  gates: externalGates.map((row) => ({
    id: row.ID,
    title: row["责任包"],
    accountable: row["A（唯一）"],
    responsible: row["R / 牵头"],
    due: row["截止"],
    status: row["状态"],
    evidence: row["完成证据"],
    group: gateGroup(row.ID),
  })),
  scopeChecks: scopeRows.map((row) => ({
    id: row["#"],
    title: row["条件"],
    accountable: row["A 最终负责（仅 1 人）"],
    status: isChecked(row["完成"]) ? "Pass" : "待办",
    evidence: row["外部证据 ID / 备注"],
  })),
  scope: {
    in: inScope.map((row) => ({
      title: row["能力"],
      detail: row["MVP-A 最小范围"],
    })),
    out: outOfScope,
  },
  metrics: [
    { value: `≥${top3Target}`, label: "Top3 命中", note: "20 条正例全量盲测" },
    { value: citationTarget, label: "引用 / 版本正确", note: "每条建议可追溯" },
    { value: negativeTarget, label: "错误直答", note: "不少于 5 条负例" },
    { value: pilotTarget.replace("连续 ", ""), label: "内部真实试点", note: "每人每周 ≥5 个去重任务" },
    { value: "0", label: "自动代发", note: "人在环硬门槛" },
  ],
  meeting: {
    title: ddevReady
      ? "按授权推进，也不能越过门禁。"
      : awaitingDdev
        ? "可以准备 Ddev，不能提前开工。"
      : projectPaused
        ? "可以开复审会，不能绕过暂停结论。"
        : "可以开需求会，不能宣布开工。",
    positioning: ddevReady
      ? "这是 Ddev 后推进与证据复核会；任何新增范围、付费或部署边界仍须走 CR / DEC。"
      : awaitingDdev
        ? "这是 G0 已签后的 Ddev 授权会；签发日期、授权证据 ID、范围与费用边界未落档前不得开发。"
      : projectPaused
        ? "这是失败 / 暂停后的复审准备会；只确认解除条件，不默认恢复 G0 或开发。"
        : "可召开需求澄清与范围冻结准备会；不是 PRD 终审、G0 通过或开发开工会。",
    controlsLabel: ddevReady || awaitingDdev || projectPaused ? "当前行动角色筛选" : "会前准备角色筛选",
    copyTitle: ddevReady
      ? "客服 Agent 当前推进清单"
      : awaitingDdev
        ? "客服 Agent Ddev 签发清单"
      : projectPaused
        ? "客服 Agent 暂停 / 整改复审清单"
        : "客服 Agent PRD 需求会会前准备",
    copyButton: ddevReady || awaitingDdev || projectPaused ? "复制当前清单" : "复制会前清单",
    agenda: displayAgenda,
    director: [
      "业务目标、优先级及本期必须解决的问题",
      "四候选的经营影响、主要风险与不可突破边界",
      "可拍板的业务 Owner、验收人、预算路径与试点资源",
      "成功、止损、暂停条件与范围取舍",
    ],
    manager: [
      "Top 场景、平台分布、真实任务量与脱敏案例",
      "话术真源清单、版本状态及维护 SLA",
      "查找时长、错答 / 冲突、未命中与新人学习基线",
      "20 条正例、至少 5 条负例与转人工 SOP",
      "3–5 名试点坐席、投入时间与反馈安排",
    ],
    coreQuestions: [
      "首期最值得解决的 3–5 个真实任务是什么？",
      "哪个来源才是正确答案，谁最终负责？",
      "系统何时必须拒答、追问或转人工？",
      "什么指标算成功，什么情况必须停止？",
    ],
  },
  governance: {
    fee: [
      {
        id: "A",
        title: `费用可用${currentFeePath === "A" ? " · 当前路径" : ""}`,
        detail: "月 cap、全期 cap、科目与预算责任人正式批准后执行。",
        current: currentFeePath === "A",
      },
      {
        id: "B",
        title: `钱后置${currentFeePath === "B" ? " · 当前路径" : ""}`,
        detail: "保持 0 新增付费，并写明下次费用决策日。",
        current: currentFeePath === "B",
      },
      {
        id: "C",
        title: `暂停${currentFeePath === "C" ? " · 当前路径" : ""}`,
        detail: "记录原因、复审条件与日期；本项 Fail。",
        current: currentFeePath === "C",
      },
    ],
    roles: roleRows.map((row) => ({
      role: row["角色"],
      name: row["人员代号"] || "待分配",
      proxy: row["代理人代号"] || "待分配",
      status: row["状态"],
    })),
    functions: functionRows.map((row) => ({
      name: row["职能"],
      g0: row["G0 必交付"],
    })),
    risks: risks.map((row) => ({
      id: row.ID,
      title: row["描述"],
      impact: row["影响"],
      accountable: row.A,
      due: row["截止"],
    })),
    boundaryTitle: ddevReady ? "持续边界" : "允许 / 禁止",
    allowedTitle: ddevReady ? "当前可做" : "可以做",
    forbiddenTitle: ddevReady ? "持续禁止" : "Ddev 前禁止",
    allowed: governanceBoundaries,
  },
  sources: sourceEntries.map((source) => ({
    id: source.id,
    label: source.label,
    file: source.file,
    href: `./${source.file}`,
    sha256: source.hash,
  })),
};

for (const metric of ["Top3 ≥ **70%**", "引用 / 版本正确率 = **100%**", "错误直答 = **0**"]) {
  assertIncludes(sourceById.scope, metric, "scope");
}

const releaseHash = sha256(
  [
    ...sourceEntries.map((source) => source.text),
    template,
    pretextVendor,
    generatorSource,
    statusModuleSource,
  ].join("\n/* source-boundary */\n")
);
const releaseId = `hub-v1-${releaseHash.slice(0, 12)}`;
payload.release = {
  id: releaseId,
  sourceHash: sha256(sourceEntries.map((source) => source.hash).join("\n")),
  sourceDate: latestSourceDate(sourceEntries),
  lifecycle: "00–06 Markdown 的只读生成视图，不替代真源或正式审批记录",
};

const safePayload = JSON.stringify(payload).replace(/</g, "\\u003c");
const generated = template
  .replaceAll("__RELEASE_ID__", releaseId)
  .replace("__HUB_DATA__", () => safePayload)
  .replace("__PRETEXT_VENDOR__", () => pretextVendor.trim());

if (generated.includes("__HUB_DATA__") || generated.includes("__PRETEXT_VENDOR__")) {
  throw new Error("模板占位符替换不完整");
}

if (checkOnly) {
  let current = "";
  try {
    current = await readFile(outputPath, "utf8");
  } catch {}
  if (current !== generated) {
    console.error(
      `客服 Agent 立项执行中心已过期：请运行 node business-docs/08-工具/generate_customer_agent_hub.mjs`
    );
    process.exitCode = 1;
  } else {
    console.log(`执行中心已同步 · ${releaseId} · 7/7 真源`);
  }
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, generated, "utf8");
  console.log(
    `已生成执行中心 · ${releaseId} · ${generated.length} bytes · ${outputPath}`
  );
}
