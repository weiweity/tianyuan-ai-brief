import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveProjectStatus } from "./customer_project_status.mjs";
import { assertMeetingAgendaConsistency } from "./customer_project_meeting.mjs";
import { readAcceptanceContract } from "./customer_project_surface_model.mjs";
import { resolveCustomerProjectWorkspace } from "./project_workspace.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const { projectDir } = await resolveCustomerProjectWorkspace(import.meta.url);
const prdFile = "07-客服Agent立项PRD.html";
const prdPath = path.join(projectDir, prdFile);
const manifestPath = path.join(projectDir, "07-客服Agent立项PRD.sources.json");
const hubFile = "08-客服Agent立项执行中心.html";
const hubPath = path.join(projectDir, hubFile);
const canonicalProjectDir = await realpath(projectDir);

const sourceDefinitions = [
  { id: "charter", file: "00-项目章程.md", label: "项目章程" },
  { id: "schedule", file: "01-总排期与阶段门禁.md", label: "总排期与阶段门禁" },
  { id: "ledger", file: "02-G0责任与证据台账.md", label: "G0 责任与证据台账" },
  { id: "scope", file: "03-Scope与验收.md", label: "Scope 与验收" },
  { id: "cost", file: "04-费用与成本控制.md", label: "费用与成本控制" },
  { id: "delivery", file: "05-全栈交付计划.md", label: "全栈交付计划" },
  { id: "cadence", file: "06-启动会与周推进.md", label: "启动会与周推进" },
];

const demandMeetingDirections = Object.freeze([
  "证据型客服助理",
  "商品话术",
  "活动话术",
  "灰度前影子回放",
]);
const demandMeetingRules = Object.freeze([
  "真实客服任务",
  "一期主问题",
  "主用户",
  "In Scope",
  "Out of Scope",
  "成功",
  "停止",
  "权威来源",
  "3–5 名试点",
  "预计使用人数",
  "最终负责人",
  "OPEN",
  "不做功能投票",
  "不让客服人员选择技术框架",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function portableDataMatch(html) {
  return html.match(
    /(<script\b[^>]*\bid=["']portable-project-data["'][^>]*>)([\s\S]*?)(<\/script>)/i
  );
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

async function readWorkspaceFile(filePath, label, { optional = false } = {}) {
  let fileStat;
  try {
    fileStat = await lstat(filePath);
  } catch (error) {
    if (optional && error?.code === "ENOENT") {
      return { text: null, mode: 0o644 };
    }
    throw error;
  }
  if (fileStat.isSymbolicLink()) {
    throw new Error(`${label}文件不能是符号链接：${filePath}`);
  }
  if (!fileStat.isFile()) throw new Error(`${label}必须是普通文件：${filePath}`);

  const canonicalFile = await realpath(filePath);
  if (!isWithin(canonicalProjectDir, canonicalFile)) {
    throw new Error(`${label}真实路径越出客服项目根目录：${canonicalFile}`);
  }

  // O_NOFOLLOW 关闭 lstat/realpath 与 open 之间的最终路径分量竞态窗口。
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(filePath, flags);
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new Error(`${label}必须是普通文件：${filePath}`);
    return {
      text: await handle.readFile("utf8"),
      mode: Number(openedStat.mode & 0o777),
    };
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error(`${label}文件不能是符号链接：${filePath}`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function removeExactTemporary(filePath) {
  if (!filePath) return;
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function stageAtomicFile(targetPath, content, mode, purpose) {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${purpose}-${process.pid}-${randomUUID()}.tmp`
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", mode || 0o644);
    await handle.chmod(mode || 0o644);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    return temporaryPath;
  } catch (error) {
    await handle?.close().catch(() => {});
    await removeExactTemporary(temporaryPath).catch(() => {});
    throw error;
  }
}

async function writeTransaction(changes, guards) {
  const pending = changes.filter(({ before, after }) => before !== after);
  if (pending.length === 0) return 0;

  const staged = [];
  try {
    for (const change of pending) {
      let updatePath;
      let rollbackPath;
      try {
        updatePath = await stageAtomicFile(
          change.targetPath,
          change.after,
          change.mode,
          "update"
        );
        rollbackPath =
          change.before === null
            ? null
            : await stageAtomicFile(
                change.targetPath,
                change.before,
                change.mode,
                "rollback"
              );
        staged.push({ ...change, updatePath, rollbackPath });
      } catch (error) {
        await removeExactTemporary(updatePath).catch(() => {});
        await removeExactTemporary(rollbackPath).catch(() => {});
        throw error;
      }
    }

    // 真正 rename 前再比对全部输入，避免并发修改被静默覆盖。
    for (const guard of guards) {
      const current = await readWorkspaceFile(guard.filePath, guard.label, {
        optional: guard.before === null,
      });
      if (current.text !== guard.before) {
        throw new Error(`${guard.label}在同步期间发生变化，已拒绝覆盖`);
      }
    }

    const committed = [];
    try {
      for (const item of staged) {
        await rename(item.updatePath, item.targetPath);
        item.updatePath = null;
        committed.push(item);
      }
    } catch (commitError) {
      const rollbackErrors = [];
      for (const item of committed.reverse()) {
        try {
          if (item.before === null) {
            await removeExactTemporary(item.targetPath);
          } else {
            await rename(item.rollbackPath, item.targetPath);
            item.rollbackPath = null;
          }
        } catch (rollbackError) {
          rollbackErrors.push(`${item.targetPath}: ${rollbackError.message}`);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [commitError],
          `原子写入失败，且回滚未完成：${rollbackErrors.join("; ")}`
        );
      }
      throw commitError;
    }
  } finally {
    for (const item of staged) {
      await removeExactTemporary(item.updatePath).catch(() => {});
      await removeExactTemporary(item.rollbackPath).catch(() => {});
    }
  }
  return pending.length;
}

function buildPortableData(sources, hubHtml) {
  return {
    schemaVersion: 1,
    sources: sources.map((source) => ({
      id: source.id,
      label: source.label,
      file: source.file,
      sha256: source.sha256,
      content: source.text,
    })),
    hub: {
      file: hubFile,
      sha256: sha256(hubHtml),
      htmlBase64: Buffer.from(hubHtml, "utf8").toString("base64"),
    },
  };
}

function computePortableHtml(html, hubHtml, sources) {
  const match = portableDataMatch(html);
  if (!match) throw new Error("PRD 缺少 portable-project-data 单文件交付容器");
  const expected = safeJson(buildPortableData(sources, hubHtml));
  return {
    current: match[2].trim(),
    expected,
    html: html.replace(
      match[0],
      `${match[1]}\n${expected}\n${match[3]}`
    ),
  };
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
  const scheduleDdev = schedule.match(/最早于\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日签发开发(?:开工许可|日)\s*\(?Ddev\)?/);
  if (!scheduleDdev) throw new Error("无法从真源解析：排期 Ddev 最早日");
  const scheduleDdevIso = `${d0.slice(0, 4)}-${String(scheduleDdev[1]).padStart(2, "0")}-${String(scheduleDdev[2]).padStart(2, "0")}`;
  assertSame("Ddev 最早日", ddevEarliest, scheduleDdevIso);

  const {
    overallTop3,
    stratumTop3,
    stratumMinHits,
    citationCorrect,
    negativeMinCases,
    negativeMaxWrongAnswers,
  } = readAcceptanceContract(charter, scope);
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
    resourceBaseline: projectStatus.resourceBaseline,
    feePathCode: projectStatus.feePathCode,
    feePath: projectStatus.feePath,
    feeSelected: projectStatus.feeSelected,
    paidAuthorization,
    paidSpend: projectStatus.paidSpend,
  };
}

function validatePrdContract(html, projectStatus, demandMeetingDate, facts) {
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
    /data-evidence-grade=["']fact["'][^>]*>[\s\S]{0,300}项目已批准/,
    "项目批准必须标为 fact"
  );
  requirePattern(
    html,
    /data-evidence-grade=["']hypothesis["'][^>]*>[\s\S]{0,300}项目侧建议待客服确认/,
    "项目侧建议待客服确认必须标为 hypothesis"
  );
  requireText(html, "项目已批准", "已批准事实");
  requireText(html, "不等于一期功能或开发已经批准", "批准边界");
  if (projectStatus.approvalReady) {
    requirePattern(html, /批准凭证已归档|EVD-CUSTOMER-APPROVAL-20260801/, "已批准状态必须展示归档证据语义");
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
    new RegExp(`data-demand-meeting=["']${escapeRegExp(demandMeetingDate)}["']`),
    `${demandMeetingDate} 启动会项目侧建议`
  );
  requirePattern(html, /data-demand-meeting-rule(?:\s|>)/, "需求会规则段");
  for (const direction of demandMeetingDirections) requireText(html, direction, `项目侧建议 ${direction}`);
  for (const rule of demandMeetingRules) requireText(html, rule, `需求会规则 ${rule}`);
  if (/data-force-rank/.test(html) || /独立预评分|强制排序/.test(visibleText(html))) {
    throw new Error("PRD 不得继续使用旧的强制排序 / 独立预评分叙事");
  }

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
    "resource-baseline",
    { "data-value": facts.resourceBaseline },
    [`资源基线 · ${facts.resourceBaseline}`]
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

function buildManifest(html, sources) {
  const sourceById = Object.fromEntries(sources.map((source) => [source.id, source.text]));
  const meetingAgenda = assertMeetingAgendaConsistency(sourceById.ledger, sourceById.cadence);
  const projectStatus = deriveProjectStatus({
    charter: sourceById.charter,
    schedule: sourceById.schedule,
    ledger: sourceById.ledger,
    scope: sourceById.scope,
    cost: sourceById.cost,
  });
  const facts = derivePrdFacts(sourceById, projectStatus);
  const demandMeetingDate = facts.d0;
  validatePrdContract(html, projectStatus, demandMeetingDate, facts);
  const manifestSources = sources.map(
    ({ text: _text, sourcePath: _sourcePath, mode: _mode, ...source }) => source
  );
  return {
    schemaVersion: 3,
    prd: { file: prdFile, sha256: sha256(html) },
    sources: manifestSources,
    sourceHash: sha256(manifestSources.map((source) => source.sha256).join("\n")),
    contracts: {
      statusAxes: projectStatus.statusAxes,
      evidenceGrades: ["fact", "hypothesis"],
      demandMeeting: {
        date: demandMeetingDate,
        directions: demandMeetingDirections,
        decisionRule: "客服负责人根据真实工作、业务影响、数据条件和可验证性作出决定；不做功能投票",
        agendaSha256: sha256(JSON.stringify(meetingAgenda)),
      },
      milestones: {
        d0: facts.d0,
        g0Date: facts.g0Date,
        g0State: facts.g0State,
        ddevEarliest: facts.ddevEarliest,
        ddevState: facts.ddevState,
      },
      resourceBaseline: facts.resourceBaseline,
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
  const prdSnapshot = await readWorkspaceFile(prdPath, "PRD ");
  const hubSnapshot = await readWorkspaceFile(hubPath, "Hub ");
  const manifestSnapshot = await readWorkspaceFile(manifestPath, "PRD 真源清单 ", {
    optional: true,
  });
  const sourceSnapshots = await Promise.all(
    sourceDefinitions.map(async (source) => {
      const sourcePath = path.join(projectDir, source.file);
      const snapshot = await readWorkspaceFile(sourcePath, `真源 ${source.file} `);
      return {
        ...source,
        sourcePath,
        text: snapshot.text,
        mode: snapshot.mode,
        sha256: sha256(snapshot.text),
      };
    })
  );
  const portable = computePortableHtml(
    prdSnapshot.text,
    hubSnapshot.text,
    sourceSnapshots
  );
  const manifestHtml = checkOnly ? prdSnapshot.text : portable.html;

  // buildManifest 包含所有真源推导和 PRD 内容契约验证；它完成前不会写文件。
  const expected = `${JSON.stringify(buildManifest(manifestHtml, sourceSnapshots), null, 2)}\n`;
  if (checkOnly) {
    if (portable.current !== portable.expected) {
      throw new Error(
        "PRD 单文件交付包已过期：请先生成执行中心，再运行 check_customer_agent_prd_sources.mjs --update"
      );
    }
    if (manifestSnapshot.text !== expected) {
      console.error(
        "客服 Agent PRD 真源清单已过期：请核对口径后运行 node business-docs/08-工具/check_customer_agent_prd_sources.mjs --update"
      );
      process.exitCode = 1;
    } else {
      console.log("PRD 真源与内容契约已同步 · 7/7 真源");
    }
  } else {
    const guards = [
      { filePath: prdPath, label: "PRD ", before: prdSnapshot.text },
      { filePath: hubPath, label: "Hub ", before: hubSnapshot.text },
      ...sourceSnapshots.map((source) => ({
        filePath: source.sourcePath,
        label: `真源 ${source.file} `,
        before: source.text,
      })),
      { filePath: manifestPath, label: "PRD 真源清单 ", before: manifestSnapshot.text },
    ];
    const written = await writeTransaction(
      [
        {
          targetPath: prdPath,
          before: prdSnapshot.text,
          after: portable.html,
          mode: prdSnapshot.mode,
        },
        {
          targetPath: manifestPath,
          before: manifestSnapshot.text,
          after: expected,
          mode: manifestSnapshot.mode,
        },
      ],
      guards
    );
    console.log(
      written === 0
        ? `PRD 真源清单已稳定，未重写 · ${manifestPath}`
        : `已原子更新 PRD 真源清单 · ${manifestPath}`
    );
  }
}
