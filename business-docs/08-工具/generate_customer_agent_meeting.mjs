import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCustomerProjectSurfaceModel } from "./customer_project_surface_model.mjs";
import {
  assertSafeMeetingArtifact,
  MEETING_SENSITIVE_TEXT_PATTERN,
} from "./customer_project_meeting.mjs";
import { isMeetingLifecycleClosed } from "./customer_project_status.mjs";
import {
  extractPretextVendor,
  isWithin,
  loadCustomerProjectSources,
  readCanonicalSurfaceOutput,
  readRegularFileNoFollow,
  safeJson,
  sha256,
  writeCanonicalSurfaceOutputIfChanged,
} from "./customer_project_surface_io.mjs";
import { resolveCustomerProjectWorkspace } from "./project_workspace.mjs";

const args = process.argv.slice(2);
if (
  args.some((value) => value !== "--check") ||
  args.filter((value) => value === "--check").length > 1
) {
  throw new Error("用法：node generate_customer_agent_meeting.mjs [--check]");
}
const checkOnly = args.includes("--check");
const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const canonicalToolDir = await realpath(scriptDir);
const { projectDir } = await resolveCustomerProjectWorkspace(import.meta.url);
const canonicalProjectDir = await realpath(projectDir);
const prdPath = path.join(projectDir, "07-客服Agent立项PRD.html");
const templatePath = path.join(scriptDir, "templates/customer-agent-meeting.template.html");
const brandLogoPath = path.join(projectDir, "assets/brand/logo.png");
const faviconPath = path.join(projectDir, "assets/brand/favicon.png");
const appleTouchIconPath = path.join(
  projectDir,
  "assets/brand/apple-touch-icon.png"
);
const canonicalOutputPath = path.join(projectDir, "09-客服Agent需求会汇报.html");

async function readBrandAsset(assetPath, label) {
  const fileStat = await lstat(assetPath);
  if (fileStat.isSymbolicLink()) throw new Error(`${label}不能是符号链接：${assetPath}`);
  if (!fileStat.isFile()) throw new Error(`${label}必须是普通文件：${assetPath}`);
  const canonicalAssetPath = await realpath(assetPath);
  if (!isWithin(canonicalProjectDir, canonicalAssetPath)) {
    throw new Error(`${label}真实路径越出客服项目工作区：${canonicalAssetPath}`);
  }

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(assetPath, flags);
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new Error(`${label}必须是普通文件：${assetPath}`);
    return await handle.readFile();
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error(`${label}不能是符号链接：${assetPath}`);
    throw error;
  } finally {
    await handle?.close();
  }
}

function sanitizeMeetingPretext(rawPretextVendor) {
  const lowerIdentifiers = rawPretextVendor.match(/\bg0\b/g) ?? [];
  const upperIdentifiers = rawPretextVendor.match(/\bG0\b/g) ?? [];
  if (lowerIdentifiers.length !== 2 || upperIdentifiers.length !== 2) {
    throw new Error(
      `Pretext 中预期存在 2 个 g0 双向文本表引用和 2 个 G0 emoji 检测函数引用，当前为 ${lowerIdentifiers.length} / ${upperIdentifiers.length}`
    );
  }
  const sanitized = rawPretextVendor
    .replace(/\bg0\b/g, "bidiClassTable")
    .replace(/\bG0\b/g, "containsEmojiText");
  if (/\bG0\b/i.test(sanitized)) {
    throw new Error("Pretext 会议安全命名未完全清除 G0 局部标识符");
  }
  return sanitized;
}

const initialSources = await loadCustomerProjectSources({ projectDir, canonicalProjectDir });
const [
  template,
  prdHtml,
  brandLogo,
  favicon,
  appleTouchIcon,
  generatorSource,
  statusModuleSource,
  surfaceModelSource,
  surfaceIoSource,
  meetingModuleSource,
] = await Promise.all([
    readRegularFileNoFollow(templatePath, {
      allowedRoot: canonicalToolDir,
      label: "需求会汇报模板",
    }),
    readRegularFileNoFollow(prdPath, {
      allowedRoot: canonicalProjectDir,
      label: "PRD ",
    }),
    readBrandAsset(brandLogoPath, "会议品牌 Logo"),
    readBrandAsset(faviconPath, "会议标签页图标"),
    readBrandAsset(appleTouchIconPath, "会议 Apple Touch 图标"),
    readFile(scriptPath, "utf8"),
    readFile(path.join(scriptDir, "customer_project_status.mjs"), "utf8"),
    readFile(path.join(scriptDir, "customer_project_surface_model.mjs"), "utf8"),
    readFile(path.join(scriptDir, "customer_project_surface_io.mjs"), "utf8"),
    readFile(path.join(scriptDir, "customer_project_meeting.mjs"), "utf8"),
]);
const pretextVendor = sanitizeMeetingPretext(
  extractPretextVendor(prdHtml, `PRD：${prdPath}`)
);
const sharedSurface = buildCustomerProjectSurfaceModel(initialSources.byId);

if (!sharedSurface.projectStatus.approvalReady) {
  throw new Error("项目批准尚未成立，拒绝生成“项目已批准”的需求会汇报");
}
if (isMeetingLifecycleClosed(sharedSurface.projectStatus)) {
  throw new Error("一期方向已形成结论、项目已暂停 / 停止或开发授权已成立；启动会汇报生命周期已结束，拒绝改写会前状态");
}

const releaseHash = sha256(
  [
    ...initialSources.entries.map((source) => source.text),
    template,
    pretextVendor,
    sha256(brandLogo),
    sha256(favicon),
    sha256(appleTouchIcon),
    generatorSource,
    statusModuleSource,
    surfaceModelSource,
    surfaceIoSource,
    meetingModuleSource,
  ].join("\n/* meeting-source-boundary */\n")
);
const releaseId = `meeting-v1-${releaseHash.slice(0, 12)}`;

async function readCurrentBuildFingerprint() {
  const currentSources = await loadCustomerProjectSources({ projectDir, canonicalProjectDir });
  const [
    currentTemplate,
    currentPrd,
    currentBrandLogo,
    currentFavicon,
    currentAppleTouchIcon,
    currentGeneratorSource,
    currentStatusModuleSource,
    currentSurfaceModelSource,
    currentSurfaceIoSource,
    currentMeetingModuleSource,
  ] = await Promise.all([
    readRegularFileNoFollow(templatePath, {
      allowedRoot: canonicalToolDir,
      label: "需求会汇报模板",
    }),
    readRegularFileNoFollow(prdPath, {
      allowedRoot: canonicalProjectDir,
      label: "PRD ",
    }),
    readBrandAsset(brandLogoPath, "会议品牌 Logo"),
    readBrandAsset(faviconPath, "会议标签页图标"),
    readBrandAsset(appleTouchIconPath, "会议 Apple Touch 图标"),
    readFile(scriptPath, "utf8"),
    readFile(path.join(scriptDir, "customer_project_status.mjs"), "utf8"),
    readFile(path.join(scriptDir, "customer_project_surface_model.mjs"), "utf8"),
    readFile(path.join(scriptDir, "customer_project_surface_io.mjs"), "utf8"),
    readFile(path.join(scriptDir, "customer_project_meeting.mjs"), "utf8"),
  ]);
  const currentPretext = sanitizeMeetingPretext(
    extractPretextVendor(currentPrd, `PRD：${prdPath}`)
  );
  return sha256(
    [
      ...currentSources.entries.map((source) => source.text),
      currentTemplate,
      currentPretext,
      sha256(currentBrandLogo),
      sha256(currentFavicon),
      sha256(currentAppleTouchIcon),
      currentGeneratorSource,
      currentStatusModuleSource,
      currentSurfaceModelSource,
      currentSurfaceIoSource,
      currentMeetingModuleSource,
    ].join("\n/* meeting-source-boundary */\n")
  );
}

function meetingAudienceText(value) {
  return value
    .replace(/待补证\s*[（(]\s*OPEN\s*[）)]/gi, "待补证")
    .replace(/[（(]?\bOPEN\b[）)]?/gi, "待补证")
    .replace(/待补证(?:\s*待补证)+/g, "待补证")
    .replace(/技术栈/g, "技术方案");
}

const decisionOptionByStatus = Object.freeze({
  DEC: { value: "confirmed", label: "已确认" },
  PRECONFIRM: { value: "confirm-on-site", label: "待共同确认" },
  OPEN: { value: "needs-evidence", label: "待补材料" },
  PARKING: { value: "not-in-this-meeting", label: "本次暂不决定" },
});
const decisionStatusLine = initialSources.byId.ledger.match(/记录只用四种状态：([^\n]+)/)?.[1] || "";
const decisionStatuses = [...decisionStatusLine.matchAll(/`(DEC|PRECONFIRM|OPEN|PARKING)(?:（[^`]*）)?`/g)].map(
  (match) => match[1]
);
if (
  JSON.stringify(decisionStatuses) !==
  JSON.stringify(["DEC", "PRECONFIRM", "OPEN", "PARKING"])
) {
  throw new Error("九项决定状态必须且只能按 DEC / PRECONFIRM / OPEN / PARKING 排列");
}

const meetingAgenda = sharedSurface.meeting.agenda.map(({ topic, decision }) => ({
  topic: meetingAudienceText(topic),
  decision: meetingAudienceText(decision),
}));
const payload = {
  project: {
    name: sharedSurface.project.name,
    code: sharedSurface.project.code,
  },
  state: {
    approval: "项目已批准",
    direction: "一期建议待确认",
    development: "尚未开发",
  },
  meeting: {
    agenda: meetingAgenda,
    decisions: sharedSurface.meeting.decisions.map(({ title }) => ({
      title:
        title === "系统约束"
          ? "使用环境与限制"
          : title === "权威来源"
            ? "内容依据"
            : title === "最小闭环"
              ? "一期做到哪一步"
            : title === "试点人口"
              ? "试点人员"
              : title === "后续责任"
                ? "责任与下一步"
                : title,
    })),
    decisionOptions: decisionStatuses.map((status) => {
      const option = decisionOptionByStatus[status];
      if (!option) throw new Error(`需求会结果状态没有会场映射：${status}`);
      return { ...option };
    }),
    proposal: sharedSurface.meeting.proposal,
    coreQuestions: [
      `“${sharedSurface.meeting.proposal.name}”是否对准当前最痛的问题？`,
      `一期先做“${sharedSurface.meeting.proposal.phaseOneFocus}”是否合适？`,
      "工作边界和灰度前门是否正确，还需要修正什么？",
    ],
    factCards: sharedSurface.meeting.factCards,
  },
  release: {
    id: releaseId,
  },
};

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label}字段越界：${actual.join(", ")}`);
  }
}

assertExactKeys(payload, ["project", "state", "meeting", "release"], "需求会 payload");
assertExactKeys(payload.project, ["name", "code"], "project");
assertExactKeys(payload.state, ["approval", "direction", "development"], "state");
assertExactKeys(
  payload.meeting,
  ["agenda", "decisions", "decisionOptions", "proposal", "coreQuestions", "factCards"],
  "meeting"
);
assertExactKeys(payload.release, ["id"], "release");
for (const [index, item] of payload.meeting.agenda.entries()) {
  assertExactKeys(item, ["topic", "decision"], `agenda[${index}]`);
}
for (const [index, item] of payload.meeting.decisions.entries()) {
  assertExactKeys(item, ["title"], `decisions[${index}]`);
}
for (const [index, item] of payload.meeting.decisionOptions.entries()) {
  assertExactKeys(item, ["value", "label"], `decisionOptions[${index}]`);
}
assertExactKeys(
  payload.meeting.proposal,
  ["name", "phaseOneFocus", "workingBoundary", "shadowGate", "meetingAction"],
  "proposal"
);
for (const [index, item] of payload.meeting.factCards.entries()) {
  assertExactKeys(
    item,
    ["userType", "platform", "task", "frequency", "currentFlow", "impact", "status"],
    `factCards[${index}]`
  );
}

const INTERNAL_MEETING_STRING_PATTERN =
  /\b(?:DEC|PARKING|FDE|G0|Ddev|RACI|EVD|ROLE|USR)\b|\b(?:EVD|ROLE|USR)[-_]|技术栈|技术框架|内部台账|证据代号|费用|风险/i;
const MARKUP_MEETING_STRING_PATTERN =
  /(?:^|\s)#{1,6}\s|(?:^|\s)(?:[-*+]\s|\d+\.\s)|[`*_~]|\[[^\]]*\]\([^)]*\)|<\/?[a-z][^>]*>/i;

function assertMeetingStringTree(value, trail = "payload") {
  if (typeof value === "string") {
    if (INTERNAL_MEETING_STRING_PATTERN.test(value)) {
      throw new Error(`${trail} 包含内部状态码、治理术语或禁区内容`);
    }
    if (trail !== "payload.release.id" && MEETING_SENSITIVE_TEXT_PATTERN.test(value)) {
      throw new Error(`${trail} 包含可识别联系方式或外部地址`);
    }
    if (MARKUP_MEETING_STRING_PATTERN.test(value)) {
      throw new Error(`${trail} 包含 Markdown 或 HTML`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertMeetingStringTree(item, `${trail}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) =>
      assertMeetingStringTree(item, `${trail}.${key}`)
    );
  }
}

assertMeetingStringTree(payload);

const safePayload = safeJson(payload);
for (const forbiddenKey of [
  '"sources"',
  '"portablePrd"',
  '"gates"',
  '"governance"',
  '"roles"',
  '"risks"',
  '"fee"',
  '"sourceHash"',
]) {
  if (safePayload.includes(forbiddenKey)) {
    throw new Error(`需求会 payload 包含禁止字段：${forbiddenKey}`);
  }
}
for (const forbiddenContent of [/\bEVD[-_]/i, /\bROLE[-_]/i, /\bUSR[-_]/i]) {
  if (forbiddenContent.test(safePayload)) {
    throw new Error("需求会 payload 包含内部人员或证据代号");
  }
}
for (const forbiddenMeetingContent of ["费用", "风险"]) {
  if (safePayload.includes(forbiddenMeetingContent)) {
    throw new Error(`需求会 payload 包含内部禁区文本：${forbiddenMeetingContent}`);
  }
}
const proposalText = Object.values(payload.meeting.proposal).join("\n");
if (
  /\b(?:DEC|PRECONFIRM|OPEN|PARKING|FDE|G0|Ddev|RACI|EVD|ROLE|USR)\b|技术栈|技术框架/i.test(
    proposalText
  )
) {
  throw new Error("需求会 proposal 包含内部状态码或技术术语");
}
if (/[`*_~]|\[[^\]]*\]\([^)]*\)|<\/?[a-z][^>]*>/i.test(proposalText)) {
  throw new Error("需求会 proposal 包含 Markdown 或 HTML");
}
for (const [index, item] of payload.meeting.agenda.entries()) {
  if (
    /\b(?:OPEN|PRECONFIRM|READY|FDE)\b|工程|客服人员|不让客服|业务输入|技术栈|技术方案|技术记录清单|需求确认会|需求会汇报|最小闭环|回读|待补证(?:\s*待补证)+/.test(
      `${item.topic} ${item.decision}`
    )
  ) {
    throw new Error(`agenda[${index}] 包含不适合客服会场的内部或工程表述`);
  }
}

for (const placeholder of [
  "__RELEASE_ID__",
  "__MEETING_DATA__",
  "__PRETEXT_VENDOR__",
  "__BRAND_LOGO_DATA_URI__",
  "__FAVICON_DATA_URI__",
  "__APPLE_TOUCH_ICON_DATA_URI__",
]) {
  if (!template.includes(placeholder)) throw new Error(`需求会汇报模板缺少占位符：${placeholder}`);
}
const brandLogoDataUri = `data:image/png;base64,${brandLogo.toString("base64")}`;
const faviconDataUri = `data:image/png;base64,${favicon.toString("base64")}`;
const appleTouchIconDataUri = `data:image/png;base64,${appleTouchIcon.toString("base64")}`;
const generated = template
  .replaceAll("__RELEASE_ID__", releaseId)
  .replace("__MEETING_DATA__", () => safePayload)
  .replace("__PRETEXT_VENDOR__", () => pretextVendor)
  .replace("__BRAND_LOGO_DATA_URI__", () => brandLogoDataUri)
  .replace("__FAVICON_DATA_URI__", () => faviconDataUri)
  .replace("__APPLE_TOUCH_ICON_DATA_URI__", () => appleTouchIconDataUri);
if (
  [
    "__RELEASE_ID__",
    "__MEETING_DATA__",
    "__PRETEXT_VENDOR__",
    "__BRAND_LOGO_DATA_URI__",
    "__FAVICON_DATA_URI__",
    "__APPLE_TOUCH_ICON_DATA_URI__",
  ].some((value) => generated.includes(value))
) {
  throw new Error("需求会汇报模板占位符替换不完整");
}
assertSafeMeetingArtifact(generated);

if (checkOnly) {
  const currentBuildFingerprint = await readCurrentBuildFingerprint();
  if (currentBuildFingerprint !== releaseHash) {
    throw new Error("客服项目真源或会议构建依赖在汇报校验期间发生变化");
  }
  const current = await readCanonicalSurfaceOutput({
    outputPath: canonicalOutputPath,
    canonicalProjectDir,
    label: "需求会汇报",
    optional: true,
  });
  if (current.text !== generated) {
    console.error(
      "客服 Agent 需求会汇报已过期：请运行 node business-docs/08-工具/generate_customer_agent_meeting.mjs"
    );
    process.exitCode = 1;
  } else {
    console.log(`需求会汇报已同步 · ${releaseId} · 7/7 真源`);
  }
} else {
  const written = await writeCanonicalSurfaceOutputIfChanged({
    outputPath: canonicalOutputPath,
    canonicalOutputPath,
    canonicalProjectDir,
    generated,
    expectedSourceFingerprint: releaseHash,
    readSourceFingerprint: readCurrentBuildFingerprint,
    label: "需求会汇报",
  });
  console.log(
    written
      ? `已原子生成需求会汇报 · ${releaseId} · ${generated.length} bytes · ${canonicalOutputPath}`
      : `需求会汇报已稳定，未重写 · ${releaseId} · ${canonicalOutputPath}`
  );
}
