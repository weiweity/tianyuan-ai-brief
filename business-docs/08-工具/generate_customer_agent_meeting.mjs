import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCustomerProjectSurfaceModel } from "./customer_project_surface_model.mjs";
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
const repoRoot = path.resolve(scriptDir, "../..");
const canonicalRepoRoot = await realpath(repoRoot);
const canonicalToolDir = await realpath(scriptDir);
const { projectDir } = await resolveCustomerProjectWorkspace(import.meta.url);
const canonicalProjectDir = await realpath(projectDir);
const prdPath = path.join(projectDir, "07-客服Agent立项PRD.html");
const templatePath = path.join(scriptDir, "templates/customer-agent-meeting.template.html");
const brandLogoPath = path.join(repoRoot, "web-decision-brief/docs/assets/logo.png");
const canonicalOutputPath = path.join(projectDir, "09-客服Agent需求会汇报.html");

async function readBrandLogo() {
  const fileStat = await lstat(brandLogoPath);
  if (fileStat.isSymbolicLink()) throw new Error(`会议品牌 Logo 不能是符号链接：${brandLogoPath}`);
  if (!fileStat.isFile()) throw new Error(`会议品牌 Logo 必须是普通文件：${brandLogoPath}`);
  const canonicalLogoPath = await realpath(brandLogoPath);
  if (!isWithin(canonicalRepoRoot, canonicalLogoPath)) {
    throw new Error(`会议品牌 Logo 真实路径越出仓库：${canonicalLogoPath}`);
  }

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(brandLogoPath, flags);
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new Error(`会议品牌 Logo 必须是普通文件：${brandLogoPath}`);
    return await handle.readFile();
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error(`会议品牌 Logo 不能是符号链接：${brandLogoPath}`);
    throw error;
  } finally {
    await handle?.close();
  }
}

const initialSources = await loadCustomerProjectSources({ projectDir, canonicalProjectDir });
const [template, prdHtml, brandLogo, generatorSource, statusModuleSource, surfaceModelSource, surfaceIoSource, meetingModuleSource] =
  await Promise.all([
    readRegularFileNoFollow(templatePath, {
      allowedRoot: canonicalToolDir,
      label: "需求会汇报模板",
    }),
    readRegularFileNoFollow(prdPath, {
      allowedRoot: canonicalProjectDir,
      label: "PRD ",
    }),
    readBrandLogo(),
    readFile(scriptPath, "utf8"),
    readFile(path.join(scriptDir, "customer_project_status.mjs"), "utf8"),
    readFile(path.join(scriptDir, "customer_project_surface_model.mjs"), "utf8"),
    readFile(path.join(scriptDir, "customer_project_surface_io.mjs"), "utf8"),
    readFile(path.join(scriptDir, "customer_project_meeting.mjs"), "utf8"),
  ]);
const rawPretextVendor = extractPretextVendor(prdHtml, `PRD：${prdPath}`);
const pretextLowerG0Identifiers = rawPretextVendor.match(/\bg0\b/g) ?? [];
const pretextUpperG0Identifiers = rawPretextVendor.match(/\bG0\b/g) ?? [];
if (pretextLowerG0Identifiers.length !== 2 || pretextUpperG0Identifiers.length !== 2) {
  throw new Error(
    `Pretext 中预期存在 2 个 g0 双向文本表引用和 2 个 G0 emoji 检测函数引用，当前为 ${pretextLowerG0Identifiers.length} / ${pretextUpperG0Identifiers.length}`
  );
}
const pretextVendor = rawPretextVendor
  .replace(/\bg0\b/g, "bidiClassTable")
  .replace(/\bG0\b/g, "containsEmojiText");
if (/\bG0\b/i.test(pretextVendor)) {
  throw new Error("Pretext 会议安全命名未完全清除 G0 局部标识符");
}
const sharedSurface = buildCustomerProjectSurfaceModel(initialSources.byId);

if (!sharedSurface.projectStatus.approvalReady) {
  throw new Error("项目批准尚未成立，拒绝生成“项目已批准”的需求会汇报");
}
if (sharedSurface.projectStatus.problemFitReady || sharedSurface.projectStatus.ddevReady) {
  throw new Error("一期方向已确认或开发授权已成立；8 月 4 日需求会汇报生命周期已结束，拒绝改写会前状态");
}

const releaseHash = sha256(
  [
    ...initialSources.entries.map((source) => source.text),
    template,
    pretextVendor,
    sha256(brandLogo),
    generatorSource,
    statusModuleSource,
    surfaceModelSource,
    surfaceIoSource,
    meetingModuleSource,
  ].join("\n/* meeting-source-boundary */\n")
);
const releaseId = `meeting-v1-${releaseHash.slice(0, 12)}`;

function meetingAudienceText(value) {
  return value
    .replace(/待补证\s*[（(]\s*OPEN\s*[）)]/gi, "待补证")
    .replace(/[（(]?\bOPEN\b[）)]?/gi, "待补证")
    .replace(/待补证(?:\s*待补证)+/g, "待补证")
    .replace(/技术栈/g, "技术方案");
}

const meetingAudienceTopics = [
  "先对齐启动目标与参与方式",
  "一起还原两个真实任务",
  "一起确定一期主问题",
  "一起明确一期先做到哪一步",
  "一起确认成功与停止条件",
  "一起确认可靠的内容依据",
  "一起确认试点与真实使用环境",
  "确认启动结果与下一步",
];

const meetingAudienceDecisions = [
  "项目已批准；今天共同启动需求定义，确认一期业务问题与后续责任。",
  "用一个高频任务和一个高影响任务对齐现状：谁在做、怎么做、哪里卡住、影响什么。",
  "四个方向只用于理解问题；我们确认一个主问题，证据不足就写清还要补什么。",
  "确认谁在什么场景使用、软件帮到哪一步，以及人工如何确认。",
  "确认指标名称、数据出处和负责人；没有现状基线，不填写目标值。",
  "同一问题出现不同答案时，明确以什么为准、由谁维护、如何裁决。",
  "确认试点人员、班次、设备、网络限制和使用高峰。",
  "逐项选择九项启动结果；未确认的事项写清负责人、补充内容、确认日期与位置。",
];

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

const meetingAgenda = sharedSurface.meeting.agenda.map(({ topic, decision }, index) => ({
  topic: meetingAudienceTopics[index] ?? meetingAudienceText(topic),
  decision: meetingAudienceDecisions[index] ?? meetingAudienceText(decision),
}));
const payload = {
  project: {
    name: sharedSurface.project.name,
    code: sharedSurface.project.code,
  },
  state: {
    approval: "项目已批准",
    direction: "一期方向待确认",
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
    coreQuestions: [
      "结合刚才两个真实任务，哪一个最该成为一期唯一主问题？",
      "这个主问题的损失或卡点，能否拿出可核对的证据？",
      "能否在 3–5 名坐席的小范围试点中先验证改善？",
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
  ["agenda", "decisions", "decisionOptions", "coreQuestions", "factCards"],
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
for (const [index, item] of payload.meeting.factCards.entries()) {
  assertExactKeys(
    item,
    ["userType", "platform", "task", "frequency", "currentFlow", "impact", "status"],
    `factCards[${index}]`
  );
}

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
]) {
  if (!template.includes(placeholder)) throw new Error(`需求会汇报模板缺少占位符：${placeholder}`);
}
const brandLogoDataUri = `data:image/png;base64,${brandLogo.toString("base64")}`;
const generated = template
  .replaceAll("__RELEASE_ID__", releaseId)
  .replace("__MEETING_DATA__", () => safePayload)
  .replace("__PRETEXT_VENDOR__", () => pretextVendor)
  .replace("__BRAND_LOGO_DATA_URI__", () => brandLogoDataUri);
if (
  ["__RELEASE_ID__", "__MEETING_DATA__", "__PRETEXT_VENDOR__", "__BRAND_LOGO_DATA_URI__"].some(
    (value) => generated.includes(value)
  )
) {
  throw new Error("需求会汇报模板占位符替换不完整");
}

async function readCurrentSourceFingerprint() {
  const current = await loadCustomerProjectSources({ projectDir, canonicalProjectDir });
  return current.fingerprint;
}

if (checkOnly) {
  const currentSourceFingerprint = await readCurrentSourceFingerprint();
  if (currentSourceFingerprint !== initialSources.fingerprint) {
    throw new Error("客服项目真源在需求会汇报校验期间发生变化");
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
    expectedSourceFingerprint: initialSources.fingerprint,
    readSourceFingerprint: readCurrentSourceFingerprint,
    label: "需求会汇报",
  });
  console.log(
    written
      ? `已原子生成需求会汇报 · ${releaseId} · ${generated.length} bytes · ${canonicalOutputPath}`
      : `需求会汇报已稳定，未重写 · ${releaseId} · ${canonicalOutputPath}`
  );
}
