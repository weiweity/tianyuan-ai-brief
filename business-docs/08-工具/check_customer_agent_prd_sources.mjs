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

const statusSourceDefinitions = [
  {
    id: "architecture",
    file: "20-设计-进行中/37-架构SSOT-v1.md",
    label: "37 架构 SSOT",
  },
  {
    id: "implementation",
    file: "20-设计-进行中/46-实现设计-开工包.md",
    label: "46 实现设计开工包",
  },
  {
    id: "g0Authorization",
    file: "90-评审/2026-08-31_G0正式签发记录.md",
    label: "G0 正式签发记录",
  },
  {
    id: "ddevAuthorization",
    file: "90-评审/2026-08-31_Ddev正式签发记录.md",
    label: "Ddev 正式签发记录",
  },
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

function escapeHtmlText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value) {
  return escapeHtmlText(value).replace(/"/g, "&quot;");
}

function setHtmlAttribute(openTag, name, value) {
  const encoded = escapeHtmlAttribute(value);
  const pattern = new RegExp(`\\s${escapeRegExp(name)}=(["'])[^"']*\\1`, "i");
  if (pattern.test(openTag)) return openTag.replace(pattern, ` ${name}="${encoded}"`);
  return openTag.replace(/>$/, ` ${name}="${encoded}">`);
}

function deriveStatusAxisClasses(projectStatus) {
  const confirmedByAxis = {
    direction: projectStatus.direction === "已记录",
    approval: projectStatus.approvalReady === true,
    "problem-fit": projectStatus.problemFitReady === true,
    external: projectStatus.externalPass === projectStatus.externalTotal,
    scope: projectStatus.scopePass === projectStatus.scopeTotal,
    resource: projectStatus.resourceBaseline !== "未选择",
    ddev: projectStatus.ddevReady === true,
  };
  return Object.fromEntries(
    Object.keys(projectStatus.statusAxes).map((axis) => {
      if (!(axis in confirmedByAxis)) throw new Error(`PRD 状态轴缺少视觉规则：${axis}`);
      return [axis, confirmedByAxis[axis] ? "confirmed" : "pending"];
    })
  );
}

function setStatusAxisClass(openTag, expectedClass) {
  const classMatch = openTag.match(/\sclass=(["'])([^"']*)\1/i);
  const classes = String(classMatch?.[2] || "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((className) => !["confirmed", "pending"].includes(className));
  classes.push(expectedClass);
  return setHtmlAttribute(openTag, "class", classes.join(" "));
}

function synchronizeStatusAxes(html, projectStatus) {
  let synchronized = html;
  const statusAxisClasses = deriveStatusAxisClasses(projectStatus);
  for (const [axis, copy] of Object.entries(projectStatus.statusAxes)) {
    const pattern = new RegExp(
      `(<([a-z][\\w:-]*)\\b[^>]*\\bdata-status-axis=["']${escapeRegExp(axis)}["'][^>]*>)([^<]*)(</\\2>)`,
      "i"
    );
    const match = synchronized.match(pattern);
    if (!match) throw new Error(`PRD 缺少状态轴：${axis}`);
    let openTag = setStatusAxisClass(match[1], statusAxisClasses[axis]);
    if (axis === "resource") {
      openTag = setHtmlAttribute(openTag, "data-value", projectStatus.resourceBaseline);
    } else if (axis === "scope") {
      openTag = setHtmlAttribute(openTag, "data-pass", projectStatus.scopePass);
      openTag = setHtmlAttribute(openTag, "data-total", projectStatus.scopeTotal);
    }
    synchronized = synchronized.replace(pattern, `${openTag}${escapeHtmlText(copy)}${match[4]}`);
  }
  return synchronized;
}

function deriveDevelopmentProjection(projectStatus) {
  const activeStates = new Set(["开发中", "已开始", "进行中"]);
  if (activeStates.has(projectStatus.development)) {
    const progress = projectStatus.developmentProgress;
    const milestone = progress.milestone;
    const milestoneState = progress.milestoneState;
    const completedSlicesLabel = progress.completedSlices.join("、");
    const nextActionLabel = progress.nextSlice
      ? `${progress.nextSlice} ${progress.nextSliceName}`
      : progress.nextAction;
    if (!milestone || !["IN_PROGRESS", "COMPLETE"].includes(milestoneState)) {
      throw new Error("PRD 产品开发状态行缺少 DEV-M* · IN_PROGRESS/COMPLETE");
    }
    if (!completedSlicesLabel) throw new Error("PRD 产品开发状态行缺少已完成的 W* 切片");
    if (!nextActionLabel) throw new Error("PRD 产品开发状态行缺少下一切片或下一动作");
    return {
      active: true,
      milestone,
      milestoneState,
      completedSlicesLabel,
      nextActionLabel,
    };
  }

  if (projectStatus.development === "已完成") {
    throw new Error("PRD 尚未定义产品开发已完成后的阶段投影；请先更新阶段合同");
  }

  return {
    active: false,
    milestone: "DEV-M0",
    state: projectStatus.development,
  };
}

function synchronizeDevelopmentSummary(html, projectStatus) {
  const development = deriveDevelopmentProjection(projectStatus);
  let eyebrow;
  let heroNote;
  let confirmedFact;

  if (development.active) {
    const milestoneCompleted = development.milestoneState === "COMPLETE";
    eyebrow = `项目已批准 · G0 / Ddev 已签发 · ${development.milestone} ${milestoneCompleted ? "已完成" : "进行中"}`;
    heroNote = milestoneCompleted
      ? `项目最初获批进入需求与方案阶段，批准凭证已归档；这项初始批准不等于一期功能或开发已经批准。G0 与 Ddev 后续已分别签发，当前 ${development.milestone} 产品实施已完成，${development.completedSlicesLabel} 已收口，下一动作是 ${development.nextActionLabel}，仍须单独授权；仍未部署、未接真实数据、未进入真实试点。`
      : `项目最初获批进入需求与方案阶段，批准凭证已归档；这项初始批准不等于一期功能或开发已经批准。G0 与 Ddev 后续已分别签发，当前 ${development.milestone} 已进入开发中，${development.completedSlicesLabel} 已完成，下一动作是 ${development.nextActionLabel}；仍未部署、未接真实数据、未进入真实试点。`;
    confirmedFact = milestoneCompleted
      ? `项目已批准，2026-08-04 召开一期启动会；G0 / Ddev 已签发，${development.milestone} 产品实施与退出证据已完成。`
      : `项目已批准，2026-08-04 召开一期启动会；G0 / Ddev 已签发，${development.milestone} 已开始，${development.completedSlicesLabel} 已完成。`;
  } else if (projectStatus.ddevReady) {
    eyebrow = `项目已批准 · G0 / Ddev 已签发 · ${development.milestone} 待开工`;
    heroNote = `项目最初获批进入需求与方案阶段，批准凭证已归档；这项初始批准不等于一期功能或开发已经批准。G0 与 Ddev 后续已分别签发，当前 ${development.milestone} 已放行但产品开发仍为${development.state}；软件未部署、未接真实数据、未试点。`;
    confirmedFact = `项目已批准，2026-08-04 召开一期启动会；G0 / Ddev 已签发，${development.milestone} 仍为${development.state}。`;
  } else {
    eyebrow = "项目已批准 · 一期建议待客服校准 · 尚未开发";
    heroNote = "项目已批准进入需求与方案阶段，批准凭证已归档；这不等于一期功能或开发已经批准。项目侧推荐“证据型客服助理 + 灰度前影子回放”，仍须客服确认、修正或否决；软件未开发、未部署、未试点。";
    confirmedFact = "项目已批准，2026-08-04 召开一期启动会；软件尚未开发。";
  }

  let synchronized = replaceUnique(
    html,
    /<p\b(?=[^>]*\bclass=["'][^"']*\beyebrow\b[^"']*["'])[^>]*>[\s\S]*?<\/p>/i,
    `<p class="eyebrow" data-current-development="eyebrow">${escapeHtmlText(eyebrow)}</p>`,
    "当前开发状态眉标"
  );
  synchronized = replaceUnique(
    synchronized,
    /<p\b(?=[^>]*\bclass=["'][^"']*\bhero-note\b[^"']*["'])[^>]*>[\s\S]*?<\/p>/i,
    `<p class="hero-note" data-current-development="summary">\n          ${escapeHtmlText(heroNote)}\n        </p>`,
    "当前开发状态说明"
  );
  return replaceUnique(
    synchronized,
    /<li\b(?=[^>]*\bdata-evidence-grade=["']fact["'])[^>]*>[\s\S]*?<span\b[^>]*\bclass=["']index["'][^>]*>\s*已确认\s*<\/span>\s*<span\b[^>]*>[\s\S]*?项目已批准[\s\S]*?<\/span>\s*<\/li>/i,
    `<li data-evidence-grade="fact" data-current-development="fact"><span class="index">已确认</span><span>${escapeHtmlText(confirmedFact)}</span></li>`,
    "当前开发状态事实"
  );
}

function replaceUnique(source, pattern, replacement, label) {
  if (pattern.global) throw new Error(`内部错误：${label} 的替换规则不得预设 global`);
  const matches = [...source.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
  if (matches.length !== 1) {
    throw new Error(`PRD ${label}必须唯一，实际 ${matches.length} 处`);
  }
  return source.replace(pattern, replacement);
}

function synchronizeG0Summary(html, projectStatus) {
  const g0Pattern =
    /(<([a-z][\w:-]*)\b[^>]*\bdata-contract\s*=\s*(["'])g0\3[^>]*>)([\s\S]*?)(<\/\2>)/gi;
  const matches = [...html.matchAll(g0Pattern)];
  if (matches.length !== 1) {
    throw new Error(`PRD data-contract=g0 必须唯一，实际 ${matches.length} 处`);
  }
  const [current, currentOpenTag, , , currentContent, closeTag] = matches[0];
  const openTag = setHtmlAttribute(currentOpenTag, "data-state", projectStatus.g0);
  const content = replaceUnique(
    currentContent,
    /当前(?:未签发|待签发|已签发|Pass|Fail)/i,
    `当前${escapeHtmlText(projectStatus.g0)}`,
    "G0 当前状态"
  );
  return html.replace(current, `${openTag}${content}${closeTag}`);
}

function synchronizeDdevSummary(html, projectStatus) {
  const ddevPattern =
    /(<([a-z][\w:-]*)\b[^>]*\bdata-contract\s*=\s*(["'])ddev\3[^>]*>)([\s\S]*?)(<\/\2>)/gi;
  const ddevMatches = [...html.matchAll(ddevPattern)];
  if (ddevMatches.length !== 1) {
    throw new Error(`PRD data-contract=ddev 必须唯一，实际 ${ddevMatches.length} 处`);
  }

  const [current, currentOpenTag, , , currentContent, closeTag] = ddevMatches[0];
  const completed = projectStatus.externalPass + projectStatus.scopePass;
  const total = projectStatus.externalTotal + projectStatus.scopeTotal;
  let openTag = setHtmlAttribute(currentOpenTag, "data-state", projectStatus.ddev);
  for (const [name, value] of [
    ["data-external-pass", projectStatus.externalPass],
    ["data-external-total", projectStatus.externalTotal],
    ["data-scope-pass", projectStatus.scopePass],
    ["data-scope-total", projectStatus.scopeTotal],
    ["data-pass", completed],
    ["data-total", total],
  ]) {
    openTag = setHtmlAttribute(openTag, name, value);
  }

  let content = replaceUnique(
    currentContent,
    /外部责任包\s*\d+\s*\/\s*\d+/i,
    `外部责任包 ${projectStatus.externalPass} / ${projectStatus.externalTotal}`,
    "Ddev 外部责任包摘要"
  );
  content = replaceUnique(
    content,
    /Scope 检查\s*\d+\s*\/\s*\d+/i,
    `Scope 检查 ${projectStatus.scopePass} / ${projectStatus.scopeTotal}`,
    "Ddev Scope 检查摘要"
  );
  content = replaceUnique(
    content,
    /G0\s+(?:未签发|待签发|已签发|Pass|Fail)/i,
    `G0 ${escapeHtmlText(projectStatus.g0)}`,
    "Ddev 摘要中的 G0 状态"
  );
  content = replaceUnique(
    content,
    /Ddev\s+(?:未成立|待签发|\d{4}-\d{2}-\d{2})/i,
    `Ddev ${escapeHtmlText(projectStatus.ddev)}`,
    "Ddev 摘要中的 Ddev 状态"
  );
  const authorizationCopy = projectStatus.ddevReady
    ? "G0 与 DEC-DDEV-01 已分别签发；当前只放行 DEV-M0，后续里程碑仍按退出证据推进"
    : "全部通过并分别签发 G0 与 DEC-DDEV-01 后方可建立 Ddev";
  content = replaceUnique(
    content,
    /(?:全部通过并分别签发 G0 与 DEC-DDEV-01 后方可建立 Ddev|G0 与 DEC-DDEV-01 已分别签发；当前只放行 DEV-M0，后续里程碑仍按退出证据推进)/i,
    authorizationCopy,
    "Ddev 授权状态说明"
  );
  if (/编码从下一个可用工作日开始。?/i.test(content)) {
    content = replaceUnique(
      content,
      /编码从下一个可用工作日开始。?/i,
      "Ddev 生效当日即可进入 DEV-M0。",
      "Ddev 生效当日开工口径"
    );
  } else if (!/Ddev 生效当日即可进入 DEV-M0。?/i.test(content)) {
    throw new Error("PRD Ddev 开工口径既非可迁移旧文案，也非当日进入 DEV-M0 新文案");
  }

  let synchronized = html.replace(current, `${openTag}${content}${closeTag}`);
  synchronized = replaceUnique(
    synchronized,
    /(<strong\b[^>]*>\s*当前只完成\s*)\d+\s*\/\s*\d+(\s*项准备\s*<\/strong>)/i,
    `$1${completed} / ${total}$2`,
    "Ddev 当前完成总计"
  );
  return replaceUnique(
    synchronized,
    /(<h3\b[^>]*>\s*已经确认\s*·\s*)\d+\s*\/\s*\d+(\s*<\/h3>)/i,
    `$1${completed} / ${total}$2`,
    "Ddev 已确认总计"
  );
}

function synchronizeDdevStartCopy(html) {
  return html
    .replaceAll("仅开发前总检查全部通过后；编码从下一工作日开始", "仅开发前总检查全部通过且 Ddev 正式生效后；生效当日即可进入 DEV-M0")
    .replaceAll("仍按实际检查；编码从下一工作日开始", "仍按实际检查与 Ddev 签发；生效当日即可进入 DEV-M0");
}

function synchronizeFeeSummary(html, projectStatus) {
  const feePattern =
    /(<details\b[^>]*\bdata-contract\s*=\s*(["'])fee\2[^>]*>)([\s\S]*?)(<\/details>)/gi;
  const matches = [...html.matchAll(feePattern)];
  if (matches.length !== 1) {
    throw new Error(`PRD data-contract=fee 必须唯一，实际 ${matches.length} 处`);
  }
  const [current, currentOpenTag, , currentContent, closeTag] = matches[0];
  let openTag = setHtmlAttribute(currentOpenTag, "data-path-code", projectStatus.feePathCode);
  openTag = setHtmlAttribute(openTag, "data-selected", projectStatus.feeSelected);
  openTag = setHtmlAttribute(
    openTag,
    "data-paid-authorization",
    projectStatus.paidSpend === "新增付费授权 = 0" ? "0" : "approved-cap"
  );
  const content = replaceUnique(
    currentContent,
    /(<p>\s*<strong>当前费用：<\/strong>)[\s\S]*?(<\/p>)/i,
    `$1${escapeHtmlText(projectStatus.feePath)}；${escapeHtmlText(projectStatus.paidSpend)}。$2`,
    "费用路径摘要"
  );
  return html.replace(current, `${openTag}${content}${closeTag}`);
}

function requirePattern(text, pattern, label) {
  if (!pattern.test(text)) throw new Error(`PRD 契约缺失：${label}`);
}

function requireText(text, value, label = value) {
  if (!text.includes(value)) throw new Error(`PRD 契约缺失：${label}`);
}

function markedElement(html, attributePattern, label) {
  const openingTag = new RegExp(
    `<([a-z][\\w:-]*)\\b(?=[^>]*\\b${attributePattern})[^>]*>`,
    "i"
  ).exec(html);
  if (!openingTag) throw new Error(`PRD 契约缺失：${label}`);
  const closeTag = `</${openingTag[1]}>`;
  const contentStart = (openingTag.index ?? 0) + openingTag[0].length;
  const contentEnd = html.indexOf(closeTag, contentStart);
  if (contentEnd < 0) throw new Error(`PRD 契约未闭合：${label}`);
  return html.slice(openingTag.index, contentEnd + closeTag.length);
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

  const g0Date = required(
    ledger.match(/\*\*G0 决策日：\*\*\s*(?:原)?目标\s*(\d{4}-\d{2}-\d{2})/)?.[1],
    "G0 历史目标日"
  );
  const charterG0Date = required(
    charter.match(/\| G0 决策 \| \*\*目标 (\d{4}-\d{2}-\d{2})\*\* \|/)?.[1],
    "章程 G0 决策日"
  );
  assertSame("G0 决策日", g0Date, charterG0Date);

  const ddevEarliest = projectStatus.earliestDdev;
  const scheduleDdevIso = required(
    schedule.match(/`(\d{4}-\d{2}-\d{2})`\s+只保留为 Ddev 不得早于的历史日期下限/)?.[1],
    "排期 Ddev 历史日期下限"
  );
  assertSame("Ddev 历史日期下限", ddevEarliest, scheduleDdevIso);

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
    externalPass: projectStatus.externalPass,
    externalTotal: projectStatus.externalTotal,
    scopePass: projectStatus.scopePass,
    scopeTotal: projectStatus.scopeTotal,
    completedGateCount: projectStatus.externalPass + projectStatus.scopePass,
    totalGateCount: projectStatus.externalTotal + projectStatus.scopeTotal,
    resourceBaseline: projectStatus.resourceBaseline,
    feePathCode: projectStatus.feePathCode,
    feePath: projectStatus.feePath,
    feeSelected: projectStatus.feeSelected,
    paidAuthorization,
    paidSpend: projectStatus.paidSpend,
  };
}

function validatePrdContract(html, projectStatus, demandMeetingDate, facts, development) {
  const { statusAxes } = projectStatus;
  const statusAxisClasses = deriveStatusAxisClasses(projectStatus);
  for (const [axis, copy] of Object.entries(statusAxes)) {
    requirePattern(
      html,
      new RegExp(
        `data-status-axis=["']${escapeRegExp(axis)}["'][^>]*>\\s*${escapeRegExp(copy)}`
      ),
      `状态轴 ${axis} = ${copy}`
    );
    const openingTags = [
      ...html.matchAll(
        new RegExp(
          `<[a-z][\\w:-]*\\b(?=[^>]*\\bdata-status-axis=["']${escapeRegExp(axis)}["'])[^>]*>`,
          "gi"
        )
      ),
    ].map((match) => match[0]);
    if (openingTags.length !== 1) {
      throw new Error(`PRD 状态轴 ${axis} 必须唯一，实际 ${openingTags.length} 个`);
    }
    const classNames = new Set(
      String(parseAttributes(openingTags[0]).class || "")
        .split(/\s+/)
        .filter(Boolean)
    );
    const expectedClass = statusAxisClasses[axis];
    const unexpectedClass = expectedClass === "confirmed" ? "pending" : "confirmed";
    if (!classNames.has(expectedClass) || classNames.has(unexpectedClass)) {
      throw new Error(
        `PRD 状态轴 ${axis} 视觉状态应为 ${expectedClass}，实际为 ${[...classNames].join(" ") || "缺失"}`
      );
    }
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
  const developmentShell = ["eyebrow", "summary", "fact"]
    .map((part) =>
      visibleText(
        markedElement(
          html,
          `data-current-development\\s*=\\s*["']${part}["']`,
          `当前开发状态 ${part}`
        )
      )
    )
    .join(" ");
  if (development.active) {
    const milestoneCompleted = development.milestoneState === "COMPLETE";
    const expectedDevelopmentCopy = milestoneCompleted
      ? [
          `${development.milestone} 产品实施已完成`,
          `${development.completedSlicesLabel} 已收口`,
          development.nextActionLabel,
        ]
      : [
          `${development.milestone} 已开始`,
          `${development.completedSlicesLabel} 已完成`,
          development.nextActionLabel,
        ];
    for (const expected of expectedDevelopmentCopy) {
      requireText(developmentShell, expected, `当前开发投影 ${expected}`);
    }
    requirePattern(developmentShell, /仍未部署[、，].*未接真实数据.*未进入真实试点/, "开发中仍保持真实运行边界");
    requirePattern(developmentShell, /^(?!.*(?:软件未开发|软件尚未开发)).*$/s, "开发中投影不得残留未开发文案");
  }
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
  const demandMeetingBlock = markedElement(
    html,
    `data-demand-meeting\\s*=\\s*["']${escapeRegExp(demandMeetingDate)}["']`,
    `${demandMeetingDate} 启动会项目侧建议`
  );
  const demandMeetingRuleBlock = markedElement(
    html,
    "data-demand-meeting-rule(?:\\s|>)",
    "启动会规则段"
  );
  const demandMeetingVisibleText = visibleText(demandMeetingBlock);
  const demandMeetingRuleVisibleText = visibleText(demandMeetingRuleBlock);
  for (const direction of demandMeetingDirections) {
    requireText(demandMeetingVisibleText, direction, `项目侧建议 ${direction}`);
  }
  for (const rule of demandMeetingRules) {
    requireText(demandMeetingRuleVisibleText, rule, `启动会规则 ${rule}`);
  }
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
    {
      "data-earliest": facts.ddevEarliest,
      "data-state": facts.ddevState,
      "data-external-pass": facts.externalPass,
      "data-external-total": facts.externalTotal,
      "data-scope-pass": facts.scopePass,
      "data-scope-total": facts.scopeTotal,
      "data-pass": facts.completedGateCount,
      "data-total": facts.totalGateCount,
    },
    [
      `外部责任包 ${facts.externalPass} / ${facts.externalTotal}`,
      `Scope 检查 ${facts.scopePass} / ${facts.scopeTotal}`,
      `历史日期下限 ${facts.ddevEarliest.slice(5)}`,
      `Ddev ${facts.ddevState}`,
    ]
  );
  requirePattern(
    html,
    new RegExp(
      `<strong\\b[^>]*>\\s*当前只完成\\s*${facts.completedGateCount}\\s*\\/\\s*${facts.totalGateCount}\\s*项准备\\s*<\\/strong>`,
      "i"
    ),
    `Ddev 当前完成总计 ${facts.completedGateCount} / ${facts.totalGateCount}`
  );
  requirePattern(
    html,
    new RegExp(
      `<h3\\b[^>]*>\\s*已经确认\\s*·\\s*${facts.completedGateCount}\\s*\\/\\s*${facts.totalGateCount}\\s*<\\/h3>`,
      "i"
    ),
    `Ddev 已确认总计 ${facts.completedGateCount} / ${facts.totalGateCount}`
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

function buildManifest(html, sources, statusSources) {
  const sourceById = Object.fromEntries(
    [...sources, ...statusSources].map((source) => [source.id, source.text])
  );
  const meetingAgenda = assertMeetingAgendaConsistency(sourceById.ledger, sourceById.cadence);
  const projectStatus = deriveProjectStatus({
    charter: sourceById.charter,
    schedule: sourceById.schedule,
    ledger: sourceById.ledger,
    scope: sourceById.scope,
    cost: sourceById.cost,
    architecture: sourceById.architecture,
    implementation: sourceById.implementation,
    g0Authorization: sourceById.g0Authorization,
    ddevAuthorization: sourceById.ddevAuthorization,
  });
  const facts = derivePrdFacts(sourceById, projectStatus);
  const demandMeetingDate = facts.d0;
  const development = deriveDevelopmentProjection(projectStatus);
  validatePrdContract(html, projectStatus, demandMeetingDate, facts, development);
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
  const statusSourceSnapshots = await Promise.all(
    statusSourceDefinitions.map(async (source) => {
      const sourcePath = path.join(projectDir, source.file);
      const snapshot = await readWorkspaceFile(sourcePath, `状态真源 ${source.file} `);
      return {
        ...source,
        sourcePath,
        text: snapshot.text,
        mode: snapshot.mode,
        sha256: sha256(snapshot.text),
      };
    })
  );
  const sourceById = Object.fromEntries(
    [...sourceSnapshots, ...statusSourceSnapshots].map((source) => [source.id, source.text])
  );
  const projectStatus = deriveProjectStatus({
    charter: sourceById.charter,
    schedule: sourceById.schedule,
    ledger: sourceById.ledger,
    scope: sourceById.scope,
    cost: sourceById.cost,
    architecture: sourceById.architecture,
    implementation: sourceById.implementation,
    g0Authorization: sourceById.g0Authorization,
    ddevAuthorization: sourceById.ddevAuthorization,
  });
  const statusSynchronizedPrd = synchronizeStatusAxes(prdSnapshot.text, projectStatus);
  const g0SynchronizedPrd = synchronizeG0Summary(statusSynchronizedPrd, projectStatus);
  const ddevSynchronizedPrd = synchronizeDdevSummary(g0SynchronizedPrd, projectStatus);
  const startCopySynchronizedPrd = synchronizeDdevStartCopy(ddevSynchronizedPrd);
  const developmentSynchronizedPrd = synchronizeDevelopmentSummary(startCopySynchronizedPrd, projectStatus);
  const contractSynchronizedPrd = synchronizeFeeSummary(developmentSynchronizedPrd, projectStatus);
  const portable = computePortableHtml(
    contractSynchronizedPrd,
    hubSnapshot.text,
    sourceSnapshots
  );
  const manifestHtml = portable.html;

  // buildManifest 包含所有真源推导和 PRD 内容契约验证；它完成前不会写文件。
  const expected = `${JSON.stringify(
    buildManifest(manifestHtml, sourceSnapshots, statusSourceSnapshots),
    null,
    2
  )}\n`;
  if (checkOnly) {
    if (prdSnapshot.text !== portable.html) {
      throw new Error(
        "PRD 状态轴、Ddev 摘要或单文件交付包已过期：请先生成执行中心，再运行 check_customer_agent_prd_sources.mjs --update"
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
      ...statusSourceSnapshots.map((source) => ({
        filePath: source.sourcePath,
        label: `状态真源 ${source.file} `,
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
