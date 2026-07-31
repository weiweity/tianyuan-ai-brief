import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveProjectStatus } from "./customer_project_status.mjs";
import { resolveCustomerProjectWorkspace } from "./project_workspace.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const { projectDir } = await resolveCustomerProjectWorkspace(import.meta.url);
const prdFile = "07-客服Agent立项PRD.html";
const prdPath = path.join(projectDir, prdFile);
const manifestPath = path.join(projectDir, "07-客服Agent立项PRD.sources.json");

const sourceDefinitions = [
  { id: "charter", file: "00-项目章程.md", label: "项目章程" },
  { id: "schedule", file: "01-总排期与阶段门禁.md", label: "总排期与阶段门禁" },
  { id: "ledger", file: "02-G0责任与证据台账.md", label: "G0 责任与证据台账" },
  { id: "scope", file: "03-Scope与验收.md", label: "Scope 与验收" },
  { id: "cost", file: "04-费用与成本控制.md", label: "费用与成本控制" },
  { id: "delivery", file: "05-全栈交付计划.md", label: "全栈交付计划" },
  { id: "cadence", file: "06-启动会与周推进.md", label: "启动会与周推进" },
];

const forceRankCandidates = Object.freeze([
  "话术库 / 检索推荐",
  "智能质检",
  "评价分析报告",
  "聊天分析",
]);
const forceRankRules = Object.freeze([
  "独立预评分",
  "频次与痛点 25%",
  "耗时 / 错误基线 25%",
  "价值 20%",
  "数据与责任可得性 15%",
  "两周可验证性 15%",
  "缺证据记 0",
  "中位数",
  "领先超过 3 分",
  "CR / DEC",
  "重新冻结 Scope",
  "不得为了匹配现有页面强行保留",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requirePattern(text, pattern, label) {
  if (!pattern.test(text)) throw new Error(`PRD 契约缺失：${label}`);
}

function requireText(text, value, label = value) {
  if (!text.includes(value)) throw new Error(`PRD 契约缺失：${label}`);
}

function required(value, label) {
  if (!value) throw new Error(`无法从真源解析：${label}`);
  return value;
}

function parseAttributes(source) {
  return Object.fromEntries(
    [...source.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gs)].map((match) => [match[1], match[3]])
  );
}

function visibleText(source) {
  return source
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDataContracts(html) {
  const contracts = new Map();
  const openingTag = /<([a-z][\w:-]*)\b([^>]*\bdata-contract\s*=\s*(["'])([^"']+)\3[^>]*)>/gi;
  for (const match of html.matchAll(openingTag)) {
    const [, tag, rawAttributes, , id] = match;
    if (contracts.has(id)) throw new Error(`PRD 契约重复：${id}`);
    const closeTag = `</${tag}>`;
    const contentStart = (match.index ?? 0) + match[0].length;
    const contentEnd = html.indexOf(closeTag, contentStart);
    if (contentEnd < 0) throw new Error(`PRD 契约标记未闭合：${id}`);
    const block = html.slice(match.index, contentEnd + closeTag.length);
    contracts.set(id, {
      attributes: parseAttributes(rawAttributes),
      text: visibleText(block),
    });
  }
  return contracts;
}

function requireDataContract(contracts, id, expectedAttributes, visibleValues) {
  const contract = contracts.get(id);
  if (!contract) throw new Error(`PRD 契约缺失：data-contract=${id}`);
  for (const [name, expected] of Object.entries(expectedAttributes)) {
    if (contract.attributes[name] !== String(expected)) {
      throw new Error(
        `PRD 契约不一致：${id}.${name} 应为 ${expected}，实际为 ${contract.attributes[name] ?? "缺失"}`
      );
    }
  }
  for (const expected of visibleValues) {
    if (!contract.text.includes(String(expected))) {
      throw new Error(`PRD 契约显示不一致：${id} 缺少「${expected}」`);
    }
  }
}

function parseInteger(text, pattern, label) {
  const value = required(text.match(pattern)?.[1], label);
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`无法从真源解析：${label}`);
  return parsed;
}

function assertSame(label, left, right) {
  if (left !== right) throw new Error(`真源口径冲突：${label} ${left} ≠ ${right}`);
}

function derivePrdFacts(sourceById, projectStatus) {
  const { charter, schedule, ledger, scope } = sourceById;
  const d0 = required(charter.match(/\*\*项目启动日 D0：\*\*\s*(\d{4}-\d{2}-\d{2})/)?.[1], "D0");
  const scheduleD0 = required(schedule.match(/\*\*项目启动日 D0：\*\*\s*(\d{4}-\d{2}-\d{2})/)?.[1], "排期 D0");
  assertSame("D0", d0, scheduleD0);

  const g0Date = required(ledger.match(/\*\*G0 决策日：\*\*\s*目标\s*(\d{4}-\d{2}-\d{2})/)?.[1], "G0 决策日");
  const charterG0Date = required(
    charter.match(/\| G0 决策 \| \*\*目标 (\d{4}-\d{2}-\d{2})\*\* \|/)?.[1],
    "章程 G0 决策日"
  );
  assertSame("G0 决策日", g0Date, charterG0Date);

  const ddevEarliest = projectStatus.earliestDdev;
  const scheduleDdev = schedule.match(/G0 决策会；全部门禁 Pass 时，最早于 (\d{1,2}) 月 (\d{1,2}) 日签发开发日 Ddev/);
  if (!scheduleDdev) throw new Error("无法从真源解析：排期 Ddev 最早日");
  const scheduleDdevIso = `${d0.slice(0, 4)}-${String(scheduleDdev[1]).padStart(2, "0")}-${String(scheduleDdev[2]).padStart(2, "0")}`;
  assertSame("Ddev 最早日", ddevEarliest, scheduleDdevIso);

  const overallTop3 = parseInteger(scope, /总体正例 Top3 ≥\s*\*\*(\d+)%\*\*/, "总体 Top3 门槛");
  const stratumTop3 = parseInteger(scope, /每个已冻结分层 Top3 ≥\s*\*\*(\d+)%\*\*/, "分层 Top3 门槛");
  const stratumMinHits = parseInteger(scope, /每个已冻结分层 Top3[^\n]*且至少命中 (\d+) 条/, "分层 Top3 最小命中数");
  const citationCorrect = parseInteger(scope, /总体及各分层引用 \/ 版本正确率 =\s*\*\*(\d+)%\*\*/, "引用正确率");
  const negativeMinCases = parseInteger(scope, /至少 (\d+) 条负例必须覆盖/, "负例最小数");
  const negativeMaxWrongAnswers = parseInteger(scope, /负例错误直答 =\s*\*\*(\d+)\*\*/, "负例错误直答门槛");
  const pilotMatch = scope.match(/≥(\d+) 人 × 连续 (\d+) 周 × 每人每周 ≥(\d+) 个去重真实任务/);
  if (!pilotMatch) throw new Error("无法从真源解析：试点人数 / 周期 / 任务数");
  const pilotMinPeople = Number(pilotMatch[1]);
  const pilotWeeks = Number(pilotMatch[2]);
  const pilotTasksPerPersonWeek = Number(pilotMatch[3]);
  const charterPilot = charter.match(/(\d+)～(\d+) 名内部坐席连续两周，每人每周 ≥(\d+) 个去重真实任务/);
  if (!charterPilot) throw new Error("无法从真源解析：章程试点口径");
  assertSame("试点最小人数", pilotMinPeople, Number(charterPilot[1]));
  assertSame("试点周期", pilotWeeks, 2);
  assertSame("试点每人每周任务数", pilotTasksPerPersonWeek, Number(charterPilot[3]));

  const charterOverallTop3 = parseInteger(charter, /Top3 命中率 ≥(\d+)%/, "章程总体 Top3 门槛");
  const charterCitation = parseInteger(charter, /引用 \/ 版本正确率 = (\d+)%/, "章程引用正确率");
  const charterNegative = charter.match(/不少于 (\d+) 条负例，错误直答 = (\d+)/);
  if (!charterNegative) throw new Error("无法从真源解析：章程负例门槛");
  assertSame("总体 Top3 门槛", overallTop3, charterOverallTop3);
  assertSame("引用正确率", citationCorrect, charterCitation);
  assertSame("负例最小数", negativeMinCases, Number(charterNegative[1]));
  assertSame("负例错误直答门槛", negativeMaxWrongAnswers, Number(charterNegative[2]));

  const paidAuthorization = projectStatus.paidSpend === "新增付费授权 = 0" ? "0" : "approved-cap";
  return {
    d0,
    g0Date,
    g0State: projectStatus.g0,
    ddevEarliest,
    ddevState: projectStatus.ddev,
    overallTop3,
    stratumTop3,
    stratumMinHits,
    citationCorrect,
    negativeMinCases,
    negativeMaxWrongAnswers,
    pilotMinPeople,
    pilotMaxPeople: Number(charterPilot[2]),
    pilotWeeks,
    pilotTasksPerPersonWeek,
    scopePass: projectStatus.scopePass,
    scopeTotal: projectStatus.scopeTotal,
    feePathCode: projectStatus.feePathCode,
    feePath: projectStatus.feePath,
    feeSelected: projectStatus.feeSelected,
    paidAuthorization,
    paidSpend: projectStatus.paidSpend,
  };
}

function validatePrdContract(html, projectStatus, forceRankDate, facts) {
  const { statusAxes } = projectStatus;
  for (const [axis, copy] of Object.entries(statusAxes)) {
    requirePattern(
      html,
      new RegExp(
        `data-status-axis=["']${escapeRegExp(axis)}["'][^>]*>\\s*${escapeRegExp(copy)}`
      ),
      `状态轴 ${axis} = ${copy}`
    );
  }

  requirePattern(
    html,
    /data-evidence-grade=["']fact["'][^>]*>[\s\S]{0,300}智能质检、评价分析报告与聊天分析/,
    "已核实主诉必须标为 fact"
  );
  requirePattern(
    html,
    /data-evidence-grade=["']hypothesis["'][^>]*>[\s\S]{0,300}待验证假设/,
    "方案前提必须标为 hypothesis"
  );
  requireText(html, "这不等于公司正式批准", "工作方向不等于公司批准");
  if (projectStatus.approvalReady) {
    requirePattern(html, /已归档[\s\S]{0,160}正式批准凭证|正式批准凭证[\s\S]{0,160}已归档/, "已批准状态必须展示归档证据语义");
  } else if (projectStatus.approval === "Fail") {
    requirePattern(
      html,
      /(?:未通过|Fail)[\s\S]{0,160}正式批准|正式批准[\s\S]{0,160}(?:未通过|Fail)/,
      "公司正式批准 Fail 必须展示未通过语义"
    );
  } else {
    requirePattern(
      html,
      /待归档[\s\S]{0,160}正式批准证据 ID 与决定摘要/,
      "公司正式批准凭证仍待归档"
    );
  }
  requirePattern(
    html,
    new RegExp(`data-force-rank=["']${escapeRegExp(forceRankDate)}["'][^>]*>[\\s\\S]{0,500}话术库[\\s\\S]{0,120}智能质检[\\s\\S]{0,120}评价分析[\\s\\S]{0,120}聊天分析`),
    `${forceRankDate} 四候选强制排序容器`
  );
  requirePattern(html, /data-force-rank-rule(?:\s|>)/, "强制排序规则段");
  for (const candidate of forceRankCandidates) requireText(html, candidate, `排序候选 ${candidate}`);
  for (const rule of forceRankRules) requireText(html, rule, `排序规则 ${rule}`);

  const contracts = parseDataContracts(html);
  requireDataContract(contracts, "d0", { "data-date": facts.d0 }, [facts.d0.slice(5)]);
  requireDataContract(
    contracts,
    "g0",
    { "data-date": facts.g0Date, "data-state": facts.g0State },
    [facts.g0Date.slice(5), "G0 决策", `当前${facts.g0State}`]
  );
  requireDataContract(
    contracts,
    "ddev",
    { "data-earliest": facts.ddevEarliest, "data-state": facts.ddevState },
    [`最早 ${facts.ddevEarliest.slice(5)}`, `Ddev ${facts.ddevState}`]
  );
  requireDataContract(
    contracts,
    "top3",
    {
      "data-overall-min-percent": facts.overallTop3,
      "data-stratum-min-percent": facts.stratumTop3,
      "data-stratum-min-hits": facts.stratumMinHits,
    },
    [`≥${facts.overallTop3}%`, `分层 ≥${facts.stratumTop3}%`, `至少命中 ${facts.stratumMinHits} 条`]
  );
  requireDataContract(
    contracts,
    "negative",
    {
      "data-min-cases": facts.negativeMinCases,
      "data-max-wrong-answers": facts.negativeMaxWrongAnswers,
    },
    [String(facts.negativeMaxWrongAnswers), `不少于 ${facts.negativeMinCases} 条负例`]
  );
  requireDataContract(
    contracts,
    "citation",
    { "data-correct-percent": facts.citationCorrect },
    [`${facts.citationCorrect}%`, "引用 / 版本正确"]
  );
  requireDataContract(
    contracts,
    "pilot",
    {
      "data-min-people": facts.pilotMinPeople,
      "data-max-people": facts.pilotMaxPeople,
      "data-weeks": facts.pilotWeeks,
      "data-tasks-per-person-week": facts.pilotTasksPerPersonWeek,
    },
    [
      `${facts.pilotMinPeople}–${facts.pilotMaxPeople} × ${facts.pilotWeeks}周`,
      `每人每周 ≥${facts.pilotTasksPerPersonWeek} 个去重任务`,
    ]
  );
  requireDataContract(
    contracts,
    "scope-count",
    { "data-pass": facts.scopePass, "data-total": facts.scopeTotal },
    [`Scope · ${facts.scopePass} / ${facts.scopeTotal}`]
  );
  requireDataContract(
    contracts,
    "fee",
    {
      "data-path-code": facts.feePathCode,
      "data-selected": facts.feeSelected,
      "data-paid-authorization": facts.paidAuthorization,
    },
    [facts.feePath, facts.paidSpend]
  );
}

async function buildManifest() {
  const [html, sources] = await Promise.all([
    readFile(prdPath, "utf8"),
    Promise.all(
      sourceDefinitions.map(async (source) => {
        const text = await readFile(path.join(projectDir, source.file), "utf8");
        return { ...source, text, sha256: sha256(text) };
      })
    ),
  ]);
  const sourceById = Object.fromEntries(sources.map((source) => [source.id, source.text]));
  const projectStatus = deriveProjectStatus({
    charter: sourceById.charter,
    ledger: sourceById.ledger,
    scope: sourceById.scope,
    cost: sourceById.cost,
  });
  const facts = derivePrdFacts(sourceById, projectStatus);
  const forceRankDate = facts.d0;
  validatePrdContract(html, projectStatus, forceRankDate, facts);
  const manifestSources = sources.map(({ text: _text, ...source }) => source);
  return {
    schemaVersion: 2,
    prd: { file: prdFile, sha256: sha256(html) },
    sources: manifestSources,
    sourceHash: sha256(manifestSources.map((source) => source.sha256).join("\n")),
    contracts: {
      statusAxes: projectStatus.statusAxes,
      evidenceGrades: ["fact", "hypothesis"],
      forceRank: {
        date: forceRankDate,
        candidates: forceRankCandidates,
        nonFirstAction: "记录 CR / DEC 并重新冻结 Scope",
      },
      milestones: {
        d0: facts.d0,
        g0Date: facts.g0Date,
        g0State: facts.g0State,
        ddevEarliest: facts.ddevEarliest,
        ddevState: facts.ddevState,
      },
      acceptance: {
        top3OverallMinPercent: facts.overallTop3,
        top3StratumMinPercent: facts.stratumTop3,
        top3StratumMinHits: facts.stratumMinHits,
        citationCorrectPercent: facts.citationCorrect,
        negativeMinCases: facts.negativeMinCases,
        negativeMaxWrongAnswers: facts.negativeMaxWrongAnswers,
        pilotMinPeople: facts.pilotMinPeople,
        pilotMaxPeople: facts.pilotMaxPeople,
        pilotWeeks: facts.pilotWeeks,
        pilotTasksPerPersonWeek: facts.pilotTasksPerPersonWeek,
        scopePass: facts.scopePass,
        scopeTotal: facts.scopeTotal,
      },
      fee: {
        pathCode: facts.feePathCode,
        selected: facts.feeSelected,
        paidAuthorization: facts.paidAuthorization,
      },
    },
  };
}

const checkOnly = process.argv.includes("--check");
const update = process.argv.includes("--update");
if (checkOnly === update) {
  console.error("用法：node check_customer_agent_prd_sources.mjs --check | --update");
  process.exitCode = 2;
} else {
  const expected = `${JSON.stringify(await buildManifest(), null, 2)}\n`;
  if (checkOnly) {
    let current = "";
    try {
      current = await readFile(manifestPath, "utf8");
    } catch {}
    if (current !== expected) {
      console.error(
        "客服 Agent PRD 真源清单已过期：请核对口径后运行 node business-docs/08-工具/check_customer_agent_prd_sources.mjs --update"
      );
      process.exitCode = 1;
    } else {
      console.log("PRD 真源与内容契约已同步 · 7/7 真源");
    }
  } else {
    await writeFile(manifestPath, expected, "utf8");
    console.log(`已更新 PRD 真源清单 · ${manifestPath}`);
  }
}
