import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isChecked, latestSourceDate } from "./customer_project_status.mjs";
import {
  buildCustomerProjectSurfaceModel,
  assertIncludes,
  getSection,
  humanizeMeetingText,
  parseBullets,
  parseChecklist,
  parseTable,
  readAcceptanceContract,
  requiredMatch,
} from "./customer_project_surface_model.mjs";
import {
  extractPretextVendor,
  loadCustomerProjectSources,
  safeJson,
  sha256,
} from "./customer_project_surface_io.mjs";
import { resolveCustomerProjectWorkspace } from "./project_workspace.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const { projectDir } = await resolveCustomerProjectWorkspace(import.meta.url);
const canonicalProjectDir = await realpath(projectDir);
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

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

async function readProjectInput(filePath, label) {
  const fileStat = await lstat(filePath);
  if (fileStat.isSymbolicLink()) throw new Error(`${label}文件不能是符号链接：${filePath}`);
  if (!fileStat.isFile()) throw new Error(`${label}必须是普通文件：${filePath}`);
  const canonicalFile = await realpath(filePath);
  if (!isWithin(canonicalProjectDir, canonicalFile)) {
    throw new Error(`${label}真实路径越出客服项目根目录：${canonicalFile}`);
  }

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(filePath, flags);
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new Error(`${label}必须是普通文件：${filePath}`);
    return await handle.readFile("utf8");
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error(`${label}文件不能是符号链接：${filePath}`);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readCanonicalOutput(outputPath, { optional = false } = {}) {
  let outputStat;
  try {
    outputStat = await lstat(outputPath);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return { text: null, mode: 0o644 };
    throw error;
  }
  if (outputStat.isSymbolicLink()) throw new Error("Hub 输出文件不能是符号链接");
  if (!outputStat.isFile()) throw new Error(`Hub 输出必须是普通文件：${outputPath}`);
  const canonicalOutput = await realpath(outputPath);
  if (!isWithin(canonicalProjectDir, canonicalOutput)) {
    throw new Error(`Hub 输出真实路径越出客服项目根目录：${canonicalOutput}`);
  }

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(outputPath, flags);
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new Error(`Hub 输出必须是普通文件：${outputPath}`);
    return {
      text: await handle.readFile("utf8"),
      mode: Number(openedStat.mode & 0o777),
    };
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error("Hub 输出文件不能是符号链接");
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

async function writeCanonicalOutputIfChanged(outputPath, generated) {
  const before = await readCanonicalOutput(outputPath, { optional: true });
  if (before.text === generated) return false;

  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.update-${process.pid}-${randomUUID()}.tmp`
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", before.mode || 0o644);
    await handle.chmod(before.mode || 0o644);
    await handle.writeFile(generated, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    const current = await readCanonicalOutput(outputPath, { optional: true });
    if (current.text !== before.text) {
      throw new Error("Hub 输出在生成期间发生变化，已拒绝覆盖");
    }
    await rename(temporaryPath, outputPath);
    return true;
  } finally {
    await handle?.close().catch(() => {});
    await removeExactTemporary(temporaryPath).catch(() => {});
  }
}

function resolveProjectHtmlOutput(value) {
  const candidate = path.resolve(value);
  if (candidate !== canonicalOutputPath) {
    throw new Error(`Hub 输出只允许 canonical 文件：${canonicalOutputPath}`);
  }
  return candidate;
}

async function loadPortablePrd() {
  const prdHtml = await readProjectInput(prdPath, "PRD ");
  const match = prdHtml.match(
    /(<script\b[^>]*\bid=["']portable-project-data["'][^>]*>)([\s\S]*?)(<\/script>)/i
  );
  if (!match) {
    throw new Error(`PRD 缺少 portable-project-data 单文件交付容器：${prdPath}`);
  }

  let portableData;
  try {
    portableData = JSON.parse(match[2].trim());
  } catch (error) {
    throw new Error(`PRD portable-project-data 不是有效 JSON：${error.message}`);
  }
  if (portableData?.schemaVersion !== 1 || !Array.isArray(portableData.sources)) {
    throw new Error("PRD portable-project-data 契约无效");
  }

  const nonRecursiveData = { ...portableData, hub: null };
  const portablePrdHtml = prdHtml.replace(
    match[0],
    `${match[1]}\n${safeJson(nonRecursiveData)}\n${match[3]}`
  );
  return {
    file: path.basename(prdPath),
    sha256: sha256(portablePrdHtml),
    htmlBase64: Buffer.from(portablePrdHtml, "utf8").toString("base64"),
    html: portablePrdHtml,
  };
}

async function loadPretextVendor() {
  if (process.env.PRETEXT_VENDOR) {
    return (await readFile(path.resolve(process.env.PRETEXT_VENDOR), "utf8")).trim();
  }
  const prdHtml = await readProjectInput(prdPath, "PRD ");
  return extractPretextVendor(prdHtml, `PRD：${prdPath}`);
}

const outputPath = resolveProjectHtmlOutput(requestedOutput);

function locationFingerprint(value) {
  const input = String(value);
  let primary = 0x811c9dc5;
  let secondary = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    primary = Math.imul(primary ^ code, 0x01000193);
    secondary = Math.imul(secondary ^ code, 0x85ebca6b);
  }
  return `${(primary >>> 0).toString(16).padStart(8, "0")}${(secondary >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function locationTail(value) {
  return String(value)
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .slice(-3)
    .join("/");
}

// 只写入稳定的“工作区类别 / 项目目录 / 文件名”短指纹，不把开发机绝对路径带入生成物。
const canonicalLocationFingerprint = locationFingerprint(
  locationTail(pathToFileURL(outputPath).pathname)
);

function shortDate(value) {
  const match = String(value).match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`日期格式不是 YYYY-MM-DD：${value}`);
  return `${match[1]}-${match[2]}`;
}

const { entries: sourceEntries, byId: sourceById } = await loadCustomerProjectSources({
  projectDir,
  canonicalProjectDir,
});
const [
  template,
  pretextVendor,
  portablePrd,
  generatorSource,
  statusModuleSource,
  surfaceModelSource,
  surfaceIoSource,
  meetingModuleSource,
] = await Promise.all([
  readFile(templatePath, "utf8"),
  loadPretextVendor(),
  loadPortablePrd(),
  readFile(scriptPath, "utf8"),
  readFile(path.join(scriptDir, "customer_project_status.mjs"), "utf8"),
  readFile(path.join(scriptDir, "customer_project_surface_model.mjs"), "utf8"),
  readFile(path.join(scriptDir, "customer_project_surface_io.mjs"), "utf8"),
  readFile(path.join(scriptDir, "customer_project_meeting.mjs"), "utf8"),
]);

const sharedSurface = buildCustomerProjectSurfaceModel(sourceById);
const projectStatus = sharedSurface.projectStatus;
const projectName = sharedSurface.project.name;
const deliveryName = sharedSurface.project.delivery;
const projectCode = sharedSurface.project.code;
const d0 = sharedSurface.project.date;
const g0Target = requiredMatch(
  sourceById.ledger,
  /\*\*G0 决策日：\*\*\s*(?:原)?目标\s*(\d{4}-\d{2}-\d{2})/,
  "G0 历史目标日"
);
const meetingPackDeadline = requiredMatch(
  sourceById.cadence,
  /在\s*(\d{2}-\d{2}\s+\d{2}:\d{2})\s*前完成会前资料包/,
  "会前资料包截止"
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
  getSection(sourceById.schedule, "### 4.1 备选 · 最小跨职能小队（当前未选）"),
  "Ddev 后交付基线"
);
const soloDeliveryScheduleRows = parseTable(
  getSection(sourceById.schedule, "### 4.2 已选 · 单人全栈 / FDE 基线"),
  "单人全栈 / FDE 基线"
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
if (roleRows.length !== 13) {
  throw new Error(`RACI 具名区应为 13 个角色，当前解析到 ${roleRows.length} 个`);
}
const roleIsAccepted = (row) =>
  Boolean(
    row["人员代号"] &&
      row["代理人代号"] &&
      row["接受职责证据 ID"] &&
      row["生效日期"] &&
      ["已接受", "Pass"].includes(row["状态"])
  );
const acceptedRoleCount = roleRows.filter(roleIsAccepted).length;
const roleAcceptanceSummary =
  acceptedRoleCount === roleRows.length
    ? `${roleRows.length} 个角色的职责接受已归档`
    : `${acceptedRoleCount}/${roleRows.length} 个角色已接受职责，其余仍待受控确认`;
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

const acceptanceContract = readAcceptanceContract(sourceById.charter, sourceById.scope);
const top3Target = `${acceptanceContract.overallTop3}%`;
const citationTarget = `${acceptanceContract.citationCorrect}%`;
const negativeTarget = String(acceptanceContract.negativeMaxWrongAnswers);
const scopePilotMatch = sourceById.scope.match(
  /\*\*暂定门槛：\*\*\s*≥(\d+) 人 × 连续 (\d+) 周 × 每人每周 ≥(\d+) 个去重真实任务/
);
const charterPilotMatch = sourceById.charter.match(
  /\|\s*真实采用\s*\|\s*(\d+)[～–-](\d+) 名内部坐席连续([一二两三四五六七八九十\d]+)周，每人每周 ≥(\d+) 个去重真实任务\s*\|/
);
const schedulePilotMatch = sourceById.schedule.match(
  /正式内部试点\s*\|\s*(\d+)[～–-](\d+) 名坐席连续([一二两三四五六七八九十\d]+)周，每人每周 ≥(\d+) 个去重真实任务/
);
if (!scopePilotMatch || !charterPilotMatch || !schedulePilotMatch) {
  throw new Error("无法从 Scope、章程与排期同时解析内部试点门槛");
}
const chineseNumber = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const parseNaturalNumber = (value) => Number(value) || chineseNumber[value] || 0;
const pilotThreshold = {
  minimumSeats: Number(scopePilotMatch[1]),
  weeks: Number(scopePilotMatch[2]),
  weeklyTasks: Number(scopePilotMatch[3]),
  lowerSeats: Number(charterPilotMatch[1]),
  upperSeats: Number(charterPilotMatch[2]),
};
const charterWeeks = parseNaturalNumber(charterPilotMatch[3]);
const charterWeeklyTasks = Number(charterPilotMatch[4]);
const scheduleThreshold = {
  lowerSeats: Number(schedulePilotMatch[1]),
  upperSeats: Number(schedulePilotMatch[2]),
  weeks: parseNaturalNumber(schedulePilotMatch[3]),
  weeklyTasks: Number(schedulePilotMatch[4]),
};
if (
  pilotThreshold.minimumSeats !== pilotThreshold.lowerSeats ||
  pilotThreshold.weeks !== charterWeeks ||
  pilotThreshold.weeklyTasks !== charterWeeklyTasks ||
  scheduleThreshold.lowerSeats !== pilotThreshold.lowerSeats ||
  scheduleThreshold.upperSeats !== pilotThreshold.upperSeats ||
  scheduleThreshold.weeks !== pilotThreshold.weeks ||
  scheduleThreshold.weeklyTasks !== pilotThreshold.weeklyTasks
) {
  throw new Error("内部试点门槛在 Scope、章程与排期之间发生漂移");
}
const pilotDisplay = `${pilotThreshold.lowerSeats}–${pilotThreshold.upperSeats} 人 × ${pilotThreshold.weeks} 周`;
const pilotTarget = `≥${pilotThreshold.minimumSeats} 人 × 连续 ${pilotThreshold.weeks} 周`;
const allEvidenceReady =
  projectStatus.externalPass === projectStatus.externalTotal &&
  projectStatus.scopePass === projectStatus.scopeTotal;
const ddevReady = projectStatus.ddevReady;
const developmentProgress = projectStatus.developmentProgress;
const developmentActive = developmentProgress.category === "active";
const developmentPaused = developmentProgress.category === "paused";
const developmentStopped = developmentProgress.category === "stopped";
const developmentCompleted = developmentProgress.category === "completed";
const developmentInterrupted = developmentPaused || developmentStopped;
const completedSlicesLabel = developmentProgress.completedSlices.join("、");
const hasNumberedNextSlice = Boolean(developmentProgress.nextSlice);
const nextActionLabel = hasNumberedNextSlice
  ? `${developmentProgress.nextSlice} ${developmentProgress.nextSliceName}`
  : developmentProgress.nextAction;
const activeProgressSummary = developmentActive
  ? hasNumberedNextSlice
    ? `${developmentProgress.milestone} 正在进行，${completedSlicesLabel} 已完成；下一切片为 ${nextActionLabel}。`
    : `${developmentProgress.milestone} 正在进行，${completedSlicesLabel} 已完成；下一动作：${nextActionLabel}。`
  : "";
const awaitingDdev = projectStatus.g0Ready && !ddevReady;
const awaitingG0Signature = allEvidenceReady && !projectStatus.g0Ready;
const designStage = projectStatus.stage === "设计阶段 / G0";
const currentFeePath = projectStatus.feePathCode;
const approvalFailed = projectStatus.approval === "Fail";
const problemFitFailed = ["Fail", "未通过"].includes(projectStatus.problemFit);
const g0Failed = projectStatus.g0 === "Fail";
const projectPaused = currentFeePath === "C" || approvalFailed || problemFitFailed || g0Failed || developmentInterrupted;
const governanceBoundaries = developmentInterrupted
  ? [
      { allowed: "只做暂停 / 停止原因复核、修复验证与恢复决定准备", forbidden: "继续 WBS、扩大范围、接入真实数据或恢复开发" },
      { allowed: "保留现状、证据与回退入口", forbidden: "用仍有效的历史 Ddev 绕过当前暂停 / 停止决定" },
    ]
  : ddevReady
  ? [
      { allowed: "只做已签 Ddev、Scope、费用与环境边界内的 WBS", forbidden: "自动代发、越权访问或未经 CR / DEC 的新增范围" },
      { allowed: "按测试、审计、监控与回退门禁迭代", forbidden: "未留测试证据、未演练回退或未授权的生产发布" },
      { allowed: "使用批准的数据、模型和账号", forbidden: "PII 越界、未批准出域、跨项目取数或绕过最小权限" },
    ]
  : allowedRows.map((row) => ({
      allowed: row["08-04 起可以做"],
      forbidden: row["Ddev 前禁止"],
    }));
const openGates = externalGates
  .filter((row) => row["状态"] !== "Pass")
  .sort((left, right) => left["截止"].localeCompare(right["截止"]));
const nextOpenGate = openGates[0];
const nextOpenGateDate = nextOpenGate
  ? nextOpenGate["截止"]
  : shortDate(g0Target);
const openGateSummary = openGates.length > 0
  ? `当前未关闭的 G0 责任包共 ${openGates.length} 项：${openGates.map((gate) => `${gate.ID}「${gate["责任包"]}」`).join("、")}`
  : "当前无未关闭的 G0 责任包";
const openGateAction = openGates.length > 0
  ? openGates.map((gate) => `${gate.ID}「${gate["责任包"]}」`).join("、")
  : "未关闭的 G0 责任包";
let headline;
if (ddevReady && developmentInterrupted) {
  headline = {
    title: `产品开发${developmentProgress.state}，不得按历史 Ddev 自动恢复。`,
    summary: developmentProgress.detail || `当前产品开发为${developmentProgress.state}；只允许处理恢复条件与复核证据。`,
    nextDate: "待复核",
    nextTitle: `${developmentProgress.state}复核`,
    nextOutput: "原因 · 修复证据 · 恢复 / 终止决定",
  };
} else if (ddevReady && developmentActive) {
  headline = {
      title: `${developmentProgress.milestone} 已开工，${completedSlicesLabel} 已完成。`,
      summary: `${activeProgressSummary}${developmentProgress.milestone} 退出证据未齐不得进入下一里程碑。`,
      nextDate: hasNumberedNextSlice ? projectStatus.ddev : "待授权",
      nextTitle: hasNumberedNextSlice
        ? `${developmentProgress.milestone}-${developmentProgress.nextSlice} · ${developmentProgress.nextSliceName}`
        : "下一 DEV-M0 能力授权",
      nextOutput: hasNumberedNextSlice
        ? `${developmentProgress.nextSlice} 行为等价证据 · 不跨入下一里程碑`
        : `${nextActionLabel} · 授权前不实施`,
    };
} else if (ddevReady && developmentCompleted) {
  headline = {
    title: "当前产品开发切片已完成，等待退出证据与下一门决定。",
    summary: developmentProgress.detail || "开发已完成；在退出证据和下一里程碑授权形成前不得扩大范围。",
    nextDate: "待复核",
    nextTitle: "退出证据复核",
    nextOutput: "测试 · 回退 · 决定证据",
  };
} else if (ddevReady) {
  headline = {
    title: "Ddev 已成立，产品开发尚未开始。",
    summary: developmentProgress.detail || `公司批准、问题适配、${projectStatus.externalTotal} 项外部责任包与 ${projectStatus.scopeTotal} 项 Scope 已按真源更新；只可按已签 Ddev 与费用路径启动首个切片。`,
    nextDate: projectStatus.ddev,
    nextTitle: "DEV-M0 首个切片",
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
    nextDate: nextOpenGateDate,
    nextTitle: "批准条件复审",
    nextOutput: "失败原因 · 补证 Owner · 复审日期",
  };
} else if (problemFitFailed) {
  headline = {
    title: "问题适配未通过，必须重定首期范围。",
    summary: "回到真实客服任务重新确认一期主问题，不为匹配现有页面保留任何预设功能。",
    nextDate: nextOpenGateDate,
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
} else if (designStage && !allEvidenceReady) {
  headline = {
    title: "需求分析关已通过；架构设计关 PASS-WITH-CONDITIONS，实现设计关 Pass · 文档包 Ready。",
    summary: `技术设计第 1～3 关已收口；${roleAcceptanceSummary}。当前仍停在独立的第 3→4 关组织授权门，G0 / Ddev 均未授权，正式 DEV-M0 代码开发未开始；按现行批准，PILOT-S0 合成阶段可分账继续。${openGateSummary}；当前只推进 ${openGateAction}，真实数据逐批审核和运行负例仍走后续独立门。跨团队责任 ${projectStatus.externalPass}/${projectStatus.externalTotal}、范围检查 ${projectStatus.scopePass}/${projectStatus.scopeTotal} 未全部通过前，Ddev 不成立。`,
    nextDate: nextOpenGateDate,
    nextTitle: nextOpenGate?.["责任包"] || "组织授权门 / G0 补证",
    nextOutput: nextOpenGate?.["完成证据"] || "未关闭 G0 责任包与 Scope 检查证据",
  };
} else if (!projectStatus.problemFitReady) {
  headline = {
        title: "项目侧已有一期建议，8 月 4 日由客服校准并处理未决项。",
        summary: `项目已批准，批准凭证已归档。${meetingPackDeadline} 前准备真实任务、当前指标、权威来源、试点人员和预计使用人数；${shortDate(d0)} 有证据就决定，缺证据就明确负责人和日期，不宣布开发开工。跨团队责任 ${projectStatus.externalPass}/${projectStatus.externalTotal}、范围检查 ${projectStatus.scopePass}/${projectStatus.scopeTotal} 未全部通过前，开发开工许可仍不成立。`,
        nextDate: meetingPackDeadline,
        nextTitle: "会前资料包",
        nextOutput: "真实任务 · 指标基线 · 权威来源 · 试点与人数",
      };
} else if (!allEvidenceReady) {
  headline = {
          title: "问题适配已核验，继续补齐 G0 证据。",
          summary: `当前外部责任包 ${projectStatus.externalPass}/${projectStatus.externalTotal}、Scope ${projectStatus.scopePass}/${projectStatus.scopeTotal}；任一未全量通过，Ddev 均不成立。`,
          nextDate: nextOpenGateDate,
          nextTitle: nextOpenGate?.["责任包"] || "G0 证据补齐",
          nextOutput: nextOpenGate?.["完成证据"] || "可核验外部证据",
        };
} else if (!projectStatus.g0Ready) {
  headline = {
          title: "G0 证据已齐，等待正式签发。",
          summary: `外部责任包 ${projectStatus.externalPass}/${projectStatus.externalTotal}、Scope ${projectStatus.scopePass}/${projectStatus.scopeTotal} 已通过；仍须先正式签发 G0，再单独签发 Ddev，不能由计数自动放行。`,
          nextDate: "待签",
          nextTitle: "G0 正式签发",
          nextOutput: "项目负责人 · 签发结论 · EVD-G0-* 证据包",
        };
} else {
  headline = {
    title: "G0 已签发，等待 Ddev 正式签发。",
    summary: `G0 已正式签发；${projectStatus.earliestDdev} 只是历史日期下限，不是当前开工预测。Ddev 未填写并签发前仍不得进入正式 DEV-M0。`,
    nextDate: "待签",
    nextTitle: "Ddev 正式签发",
    nextOutput: "Ddev 日期 · 授权证据 ID · 授权范围 · 费用路径",
  };
}

const displaySchedule = developmentInterrupted
  ? [{ date: headline.nextDate, title: headline.nextTitle, action: headline.summary, output: headline.nextOutput }]
  : ddevReady
  ? projectStatus.resourceBaseline === "单人全栈 / FDE"
    ? soloDeliveryScheduleRows.map((row, index) =>
        developmentActive && index === 0
          ? {
              date: projectStatus.ddev,
              title: `${developmentProgress.milestone} · ${completedSlicesLabel} 已完成`,
              action: hasNumberedNextSlice
                ? `下一切片 ${nextActionLabel}；严格按台账与实施计划推进`
                : `下一动作 ${nextActionLabel}；未授权前不实施`,
              output: hasNumberedNextSlice
                ? "行为等价证据 · 不跨入下一里程碑"
                : "授权决定与实施证据 · 不跨入下一里程碑",
            }
          : {
              date: `相对 Ddev 顺延 · 原基线 ${row["保守日期"]}`,
              title: row["里程碑"],
              action: "单人串行交付；不承诺最小小队日期",
              output: "按实际容量更新 DEC / CR",
            }
      )
    : deliveryScheduleRows.map((row) => ({
        date: `相对 Ddev 顺延 · 原基线 ${row["日期"]}`,
        title: row["阶段"],
        action: row["交付物"],
        output: row["出口"],
      }))
  : awaitingDdev
    ? [{ date: "待签", title: "Ddev 正式签发", action: "核对签发日期、授权证据 ID、范围、环境和费用路径", output: "Ddev · 授权边界 · 开发起始条件" }]
  : projectPaused
    ? [{ date: headline.nextDate, title: headline.nextTitle, action: headline.summary, output: headline.nextOutput }]
    : awaitingG0Signature
      ? [{ date: "待签", title: "G0 正式签发", action: "由项目负责人填写评审时间、唯一结论与证据包", output: "EVD-G0-* · Pass / Fail" }]
    : scheduleRows.map((row) => ({
        date: row["日期"],
        title: row["主题"],
        action: humanizeMeetingText(row["主要动作"]),
        output: humanizeMeetingText(row["当日输出"]),
      }));
const ddevNowTitle = developmentInterrupted
  ? `产品开发${developmentProgress.state}；等待恢复 / 终止复核。`
  : developmentActive
    ? hasNumberedNextSlice
      ? `${developmentProgress.milestone} 进行中；当前推进 ${developmentProgress.nextSlice}。`
      : `${developmentProgress.milestone} 进行中；等待下一动作授权。`
    : developmentCompleted
      ? "当前开发切片已完成；等待退出证据复核。"
      : "Ddev 已签；产品开发尚未开始。";
const ddevNowSummary = developmentInterrupted
  ? "当前暂停 / 停止决定优先于历史 Ddev；只处理原因、修复证据和恢复条件。"
  : developmentActive
    ? hasNumberedNextSlice
      ? `${completedSlicesLabel} 已完成；${nextActionLabel} 只按冻结计划执行，不激活未授权 runtime。`
      : `${completedSlicesLabel} 已完成；${nextActionLabel} 待单独授权，不激活未授权 runtime。`
    : developmentCompleted
      ? "退出证据和下一门决定未形成前，不进入后续里程碑。"
      : "只可启动 Ddev 已授权的首个切片；每次变更保留测试、回退与决定证据。";
const ddevScheduleTitle = developmentInterrupted
  ? `产品开发${developmentProgress.state}；当前不执行 WBS。`
  : developmentActive
    ? `${developmentProgress.milestone} 已开始；${completedSlicesLabel} 已完成，后续按${projectStatus.resourceBaseline}基线串行推进。`
    : developmentCompleted
      ? "当前开发切片已完成；等待退出证据和下一门决定。"
      : `Ddev 已签；按${projectStatus.resourceBaseline}基线启动首个切片。`;
const ddevChecklist = developmentInterrupted
  ? [
      `确认产品开发${developmentProgress.state}的原因与影响范围`,
      "保留当前证据、回退入口和未完成工作清单",
      "完成修复验证并形成明确恢复 / 终止决定",
      "决定生效前不得继续 WBS、真实接入、部署或下一里程碑",
    ]
  : developmentActive
    ? [
        `保持 ${completedSlicesLabel} 基线与既有行为不漂移`,
        hasNumberedNextSlice
          ? `执行 ${nextActionLabel}，只做冻结计划内工作`
          : `只准备${nextActionLabel}的范围、验收与授权输入；授权前不实施`,
        "获批后复跑受影响测试、构建、workspace 与 E2E，保留实施证据",
        "保持 development / test + 合成数据；不启用真实数据、运行接入、部署或下一里程碑",
      ]
    : developmentCompleted
      ? ["汇总退出证据", "复核测试与回退结果", "形成下一里程碑决定", "决定前不扩大范围"]
      : ["确认首个切片输入与边界", "建立最小 WBS", "保留测试与回退证据", "不提前进入后续里程碑"];
const payload = {
  schemaVersion: 1,
  runtime: {
    canonicalLocationFingerprint,
  },
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
    feeSelected: projectStatus.feeSelected,
    paidSpend: projectStatus.paidSpend,
  },
  headline: {
    ...headline,
    principle: "系统辅助 → 坐席核对 → 人工处理 → 记录结果",
    nowTitle: ddevReady
      ? ddevNowTitle
      : awaitingDdev
        ? "G0 已签，等待 Ddev 正式授权。"
      : projectPaused
        ? "按暂停或整改条件行动，不越过门禁。"
        : awaitingG0Signature
          ? "只签 G0；不要把 Ddev 合并代签。"
        : designStage
          ? "继续 PILOT-S0 合成实现，并推进可执行 G0 缺口。"
          : "先把启动会资料和责任清单准备好。",
    nowSummary: ddevReady
      ? ddevNowSummary
      : awaitingDdev
        ? `不得早于 ${projectStatus.earliestDdev} 开发；Ddev 日期与授权证据 ID 未填写前继续保持未开发。`
      : projectPaused
        ? "只补解除阻塞所需证据；不得开发、付费调用、部署或承诺试点。"
        : awaitingG0Signature
          ? "开发前证据已 29/29；只准备并完成 G0 正式签发，不提前签 Ddev 或进入 DEV-M0。"
        : designStage
          ? "PILOT-S0 合成工作可按批准边界继续；正式 DEV-M0、真实数据、飞书运行接入与部署仍未授权。"
          : "只做能帮助需求确认和开发前总检查的工作，不提前创建产品代码。",
    actionLabel: ddevReady || projectPaused || designStage ? "当前行动" : awaitingDdev ? "Ddev 签发前" : "8 月 4 日前",
    scheduleTitle: ddevReady
      ? ddevScheduleTitle
      : awaitingDdev
        ? "G0 已签，Ddev 未成立；不提前开工。"
      : projectPaused
        ? "当前处于暂停 / 整改，不进入 Ddev。"
        : awaitingG0Signature
          ? "G0 证据已齐，等待项目负责人单独签发；签发后再处理另一条 DEC-DDEV-01 记录。"
        : designStage
          ? `实现设计关已通过；原 G0 目标 ${shortDate(g0Target)} 已逾期，当前按 PILOT-S0 合成实现与可执行未闭合责任包分账推进，不用过期日期倒推正式开工。`
          : `${shortDate(d0)} 到 ${shortDate(g0Target)}，先完成需求确认和开发前总检查。`,
  },
  prelaunchChecklist: ddevReady
    ? ddevChecklist
    : awaitingDdev
      ? ["核对 G0 签发结论与证据包哈希", "确认 Ddev 最早日期与授权证据 ID", "冻结授权 Scope、费用路径、环境和负责人", "Ddev 未填写前保持产品开发未开始"]
    : projectPaused
      ? ["记录失败或暂停原因", "具名补证 Owner 与截止日", "冻结开发、付费调用、部署和试点承诺", "达到解除条件后重新评审"]
    : awaitingG0Signature
      ? [
          "冻结章程、台账、Scope 与排期当前版本",
          "由项目负责人填写 G0 评审时间、唯一结论与 EVD-G0-* 证据包",
          "G0 通过后再单独填写 DEC-DDEV-01；当前不得合并代签",
          "Ddev 未成立前保持正式 DEV-M0、真实数据、飞书运行接入与部署未授权",
        ]
    : designStage
      ? [
          "维持实现设计基线与 CR 变更链无漂移",
          "继续 PILOT-S0 · SYNTHETIC，只做本地合成 UI、交互、状态、测试与构建",
          `补齐 ${openGateAction} 与对应未关闭 Scope 检查的完成证据`,
          "G0-09 当前只补来源映射、版本快照、逐域质量与整体批准；真实数据或生产接入前另过 PROD-ACL-01",
          "Ddev 未成立前保持正式 DEV-M0、真实数据、飞书运行接入与部署未授权",
        ]
      : prelaunchChecklist.map(humanizeMeetingText).slice(0, 8),
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
      detail: row["一期最小范围"],
    })),
    out: outOfScope,
  },
  metrics: [
    { value: "OPEN", label: "一期主业务指标", note: "08-04 确认指标名称、基线来源和数据负责人；无基线不填目标值" },
    { value: pilotDisplay, label: "内部真实试点", note: `${pilotTarget}；每人每周 ≥${pilotThreshold.weeklyTasks} 个去重任务` },
    { value: "0", label: "自动代发", note: "人在环硬门槛" },
    { value: `≥${top3Target}`, label: "证据型助理 Top3（建议）", note: "项目侧一期建议：20 条正例；分层 ≥50% 且至少命中 1 条" },
    { value: citationTarget, label: "知识来源正确（建议）", note: "项目侧一期建议；每条候选必须可追溯" },
    { value: negativeTarget, label: "风险错误直答（建议）", note: `项目侧一期建议；不少于 ${acceptanceContract.negativeMinCases} 条负例` },
  ],
  meeting: {
    title: ddevReady
      ? developmentInterrupted
        ? `产品开发${developmentProgress.state}，先复核再决定是否恢复。`
        : developmentActive
          ? hasNumberedNextSlice
            ? `${developmentProgress.milestone} 已开始，下一步只推进 ${developmentProgress.nextSlice}。`
            : `${developmentProgress.milestone} 已开始，${completedSlicesLabel} 已完成；下一动作待授权。`
          : developmentCompleted
            ? "当前开发切片已完成，先复核退出证据。"
            : "Ddev 已签，先确认首个切片再开工。"
      : awaitingDdev
        ? "可以准备 Ddev，不能提前开工。"
      : projectPaused
        ? "可以开复审会，不能绕过暂停结论。"
        : awaitingG0Signature
          ? "可以签发 G0，不能把 29/29 计数当成自动开发授权。"
        : designStage
          ? "可以推进 PILOT-S0 合成实现与可执行组织授权补证，不能宣布正式 DEV-M0 开工。"
          : "可以开启动会，不能宣布开工。",
    positioning: ddevReady
      ? developmentInterrupted
        ? `这是产品开发${developmentProgress.state}复核会；历史 Ddev 不自动恢复开发，必须形成恢复或终止决定。`
        : developmentActive
          ? hasNumberedNextSlice
            ? `这是 ${developmentProgress.milestone} 实施与证据复核会；${completedSlicesLabel} 已完成，${nextActionLabel} 只按冻结计划执行，任何新增范围、付费或部署边界仍须走 CR / DEC。`
            : `这是 ${developmentProgress.milestone} 实施与证据复核会；${completedSlicesLabel} 已完成，${nextActionLabel} 尚未授权，任何新增范围、付费或部署边界仍须走 CR / DEC。`
          : developmentCompleted
            ? "这是退出证据复核会；下一里程碑仍须按既有门禁形成独立决定。"
            : "这是 Ddev 后首个切片准备会；任何新增范围、付费或部署边界仍须走 CR / DEC。"
      : awaitingDdev
        ? "这是 G0 已签后的 Ddev 授权会；签发日期、授权证据 ID、范围与费用边界未落档前不得开发。"
      : projectPaused
        ? "这是失败 / 暂停后的复审准备会；只确认解除条件，不默认恢复 G0 或开发。"
        : awaitingG0Signature
          ? "这是 G0 正式签发会：开发前证据已 14/14 + 15/15；由项目负责人单独填写时间、结论和证据包。G0 通过后仍需另签 DEC-DDEV-01。"
        : designStage
          ? `技术设计第 1～3 关已收口；${roleAcceptanceSummary}，当前仍是独立的第 3→4 关组织授权门。${openGateSummary}；当前只处理 ${openGateAction} 与对应 Scope，PILOT-S0 继续保持纯合成。真实数据逐批审核和运行负例按后续门取证，不以职责接受或文档通过代替开发授权。`
          : "这是项目启动与建议校准会：有证据就决定，缺证据就明确负责人和日期；不是需求文档终审、开发前总检查通过或开发开工会。",
    controlsLabel: ddevReady || awaitingDdev || projectPaused || designStage ? "当前行动角色筛选" : "会前准备角色筛选",
    copyTitle: ddevReady
      ? "客服 Agent 当前推进清单"
      : awaitingDdev
        ? "客服 Agent Ddev 签发清单"
      : projectPaused
        ? "客服 Agent 暂停 / 整改复审清单"
        : awaitingG0Signature
          ? "客服 Agent G0 正式签发清单"
        : designStage
          ? "客服 Agent 组织授权门清单"
          : "客服 Agent 一期启动会会前准备",
    copyButton: ddevReady || awaitingDdev || projectPaused || designStage ? "复制当前清单" : "复制会前清单",
    director: [
      "本期必须先解决的一个真实客服问题",
      "业务目标、当前基线、成功与停止条件",
      "最终负责人、验收人、预算路径与试点资源",
      "哪些内容明确不进入一期",
    ],
    manager: [
      "高频场景、平台分布、真实任务量与脱敏案例",
      "权威文档 / 数据来源、权限、更新时间和维护人",
      "当前耗时、返工、错误、升级和客户影响",
      "坐席怎样核对、修改、拒绝或转人工",
      "3–5 名试点坐席、投入时间与反馈安排",
      "预计后续使用人数、并发高峰、设备与网络",
    ],
    coreQuestions: sharedSurface.meeting.coreQuestions,
  },
  governance: {
    fee: [
      {
        id: "A",
        title: `费用可用${currentFeePath === "A" ? " · 当前路径" : ""}`,
        detail: "月 cap、全期 cap、科目与预算责任人正式批准后执行。",
        current: currentFeePath === "A",
        selected: currentFeePath === "A" && projectStatus.feeSelected,
      },
      {
        id: "B",
        title: `钱后置${
          currentFeePath === "B"
            ? projectStatus.feeSelected
              ? " · 当前路径"
              : " · 临时管控（未签）"
            : ""
        }`,
        detail: "保持 0 新增付费，并写明下次费用决策日。",
        current: currentFeePath === "B",
        selected: currentFeePath === "B" && projectStatus.feeSelected,
      },
      {
        id: "C",
        title: `暂停${currentFeePath === "C" ? " · 当前路径" : ""}`,
        detail: "记录原因、复审条件与日期；本项 Fail。",
        current: currentFeePath === "C",
        selected: currentFeePath === "C" && projectStatus.feeSelected,
      },
    ],
    roles: roleRows.map((row) => ({
      role: row["角色"],
      name: row["人员代号"] || "待具名",
      proxy: row["代理人代号"] || "待分配",
      status: row["状态"],
      needsNaming: !row["人员代号"],
      needsAcceptance: !roleIsAccepted(row),
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
    forbiddenTitle: ddevReady ? "持续禁止" : "开发开工许可前禁止",
    allowed: governanceBoundaries,
  },
  sources: sourceEntries.map((source) => ({
    id: source.id,
    label: source.label,
    file: source.file,
    sha256: source.hash,
    content: source.text,
  })),
  portablePrd: {
    file: portablePrd.file,
    sha256: portablePrd.sha256,
    htmlBase64: portablePrd.htmlBase64,
  },
};

for (const metric of [
  `总体正例 Top3 ≥ **${acceptanceContract.overallTop3}%**`,
  `总体及各分层来源 / 版本 / 适用范围正确率 = **${acceptanceContract.citationCorrect}%**`,
  `负例错误直答 = **${acceptanceContract.negativeMaxWrongAnswers}**`,
]) {
  assertIncludes(sourceById.scope, metric, "scope");
}

const releaseHash = sha256(
  [
    ...sourceEntries.map((source) => source.text),
    template,
    pretextVendor,
    portablePrd.html,
    generatorSource,
    statusModuleSource,
    surfaceModelSource,
    surfaceIoSource,
    meetingModuleSource,
    canonicalLocationFingerprint,
  ].join("\n/* source-boundary */\n")
);
const releaseId = `hub-v1-${releaseHash.slice(0, 12)}`;
payload.release = {
  id: releaseId,
  sourceHash: sha256(sourceEntries.map((source) => source.hash).join("\n")),
  sourceDate: latestSourceDate(sourceEntries),
  lifecycle: "00–06 Markdown 的只读生成视图，不替代真源或正式审批记录",
};

const safePayload = safeJson(payload);
const generated = template
  .replaceAll("__RELEASE_ID__", releaseId)
  .replace("__HUB_DATA__", () => safePayload)
  .replace("__PRETEXT_VENDOR__", () => pretextVendor.trim());

if (generated.includes("__HUB_DATA__") || generated.includes("__PRETEXT_VENDOR__")) {
  throw new Error("模板占位符替换不完整");
}

if (checkOnly) {
  const current = await readCanonicalOutput(outputPath, { optional: true });
  if (current.text !== generated) {
    console.error(
      `客服 Agent 立项执行中心已过期：请运行 node business-docs/08-工具/generate_customer_agent_hub.mjs`
    );
    process.exitCode = 1;
  } else {
    console.log(`执行中心已同步 · ${releaseId} · 7/7 真源`);
  }
} else {
  const written = await writeCanonicalOutputIfChanged(outputPath, generated);
  console.log(
    written
      ? `已原子生成执行中心 · ${releaseId} · ${generated.length} bytes · ${outputPath}`
      : `执行中心已稳定，未重写 · ${releaseId} · ${outputPath}`
  );
}
