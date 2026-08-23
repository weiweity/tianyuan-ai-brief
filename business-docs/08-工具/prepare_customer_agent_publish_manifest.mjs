#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DECISION_ID = "DEC-PUBLISH-01";
const MANIFEST_SCHEMA = "customer-agent-dec-publish-candidate.v1";
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "../..");
const outputRoot = path.join(repoRoot, "output/customer-agent-publish-gate");
const projectRoot = path.join(repoRoot, "business-docs/01-客服Agent项目");
const publicBoundaryFixturePath = "sites/tests/public-project-boundary.test.mjs";

const movePairs = [
  [
    "business-docs/01-客服Agent项目/10-客服Agent启动会逐字稿.md",
    "business-docs/01-客服Agent项目/99-历史/2026-08-04_客服Agent启动会逐字稿.md",
  ],
  ...[
    "20-产品与交互设计.md",
    "21-技术方案设计.md",
    "22-数据与知识库设计.md",
    "23-测试与灰度设计.md",
    "24-项目细则议程.md",
    "27-RAG方案与开源选型.md",
    "28-自研vs中台WBS对照.md",
  ].map((name) => [
    `business-docs/01-客服Agent项目/20-设计-进行中/${name}`,
    `business-docs/01-客服Agent项目/99-历史/2026-08-06-架构设计收口/${name}`,
  ]),
  [
    "business-docs/01-客服Agent项目/20-设计-进行中/26-话术库与采纳日志数据模型.md",
    "business-docs/01-客服Agent项目/20-设计-进行中/26-话术库与自动事实数据模型.md",
  ],
];

const businessSourcePaths = [
  "business-docs/01-客服Agent项目/00-项目章程.md",
  "business-docs/01-客服Agent项目/01-总排期与阶段门禁.md",
  "business-docs/01-客服Agent项目/02-G0责任与证据台账.md",
  "business-docs/01-客服Agent项目/03-Scope与验收.md",
  "business-docs/01-客服Agent项目/04-费用与成本控制.md",
  "business-docs/01-客服Agent项目/05-全栈交付计划.md",
  "business-docs/01-客服Agent项目/06-启动会与周推进.md",
  "business-docs/01-客服Agent项目/20-设计-进行中/37-架构SSOT-v1.md",
  "business-docs/01-客服Agent项目/20-设计-进行中/46-实现设计-开工包.md",
];
const businessGeneratedPaths = [
  "business-docs/01-客服Agent项目/07-客服Agent立项PRD.html",
  "business-docs/01-客服Agent项目/07-客服Agent立项PRD.sources.json",
  "business-docs/01-客服Agent项目/08-客服Agent立项执行中心.html",
];
const businessGeneratorPrefixes = [
  "business-docs/08-工具/check_customer_agent_prd_sources.mjs",
  "business-docs/08-工具/customer_project_status.mjs",
  "business-docs/08-工具/customer_project_surface_",
  "business-docs/08-工具/generate_customer_agent_hub.mjs",
  "business-docs/08-工具/templates/customer-agent-hub.template.html",
];

const forbiddenExactPaths = new Set([
  "business-docs/01-客服Agent项目/20-设计-进行中/tests/codex_nfr_rescore_raw.txt",
  "business-docs/01-客服Agent项目/20-设计-进行中/tests/codex_nfr_rescore_r2.txt",
  "business-docs/01-客服Agent项目/20-设计-进行中/架构交互图-CS-AI-C11.html",
]);
const forbiddenSegments = new Set([
  ".git",
  "local-private",
  "node_modules",
  "output",
  "test-results",
  "playwright-report",
  "tmp",
  "dist",
]);
const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".puml",
  ".py",
  ".sh",
  ".sql",
  ".svg",
  ".txt",
  ".yaml",
  ".yml",
]);
const allowedBinaryExtensions = new Set([".gif", ".ico", ".jpeg", ".jpg", ".png", ".webp"]);
const highConfidenceSecretPatterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{32,}\b/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  [
    "feishu-url",
    /https?:\/\/[^\s)"'<>]*(?:feishu\.cn|larksuite\.com)(?:[^\s)"'<>]*)?/i,
  ],
  [
    "feishu-valued-token",
    /\b(?:doc_token|wiki_token|file_token|tenant_access_token|open_id)\b["'`]?\s*(?:=|:|：)\s*(?:"[A-Za-z0-9._~+/=-]{8,}"|'[A-Za-z0-9._~+/=-]{8,}'|`[A-Za-z0-9._~+/=-]{8,}`|[A-Za-z0-9._~+/=-]{8,})/i,
  ],
  ["feishu-entity-id", /\b(?:ou|oc|on)_[A-Za-z0-9_-]{8,}\b/],
  ["absolute-local-path", /(?:^|[\s"'`])\/(?:Users|Volumes)\//m],
];

function usage() {
  return [
    `用法：node business-docs/08-工具/${path.basename(scriptPath)} [--check] [--write] [--expect-bundle=<sha256>] [--verify-staged=<sha256>]`,
    "",
    "默认只在内存中核对当前完整工作树；--write 将确定性候选写入已忽略的 output/。",
    "--verify-staged 只在获批并精确暂存后核对 index blob/mode；该命令永不执行 git add/commit/push。",
  ].join("\n");
}

function parseArgs(argv) {
  let write = false;
  let expectBundle = null;
  let verifyStaged = null;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--check") continue;
    if (arg === "--write") {
      write = true;
      continue;
    }
    if (arg.startsWith("--expect-bundle=")) {
      expectBundle = arg.slice("--expect-bundle=".length);
      if (!/^[0-9a-f]{64}$/.test(expectBundle)) {
        throw new Error("--expect-bundle 必须是 64 位小写 SHA-256");
      }
      continue;
    }
    if (arg.startsWith("--verify-staged=")) {
      verifyStaged = arg.slice("--verify-staged=".length);
      if (!/^[0-9a-f]{64}$/.test(verifyStaged)) {
        throw new Error("--verify-staged 必须是 64 位小写 SHA-256");
      }
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  if (verifyStaged && (write || expectBundle)) {
    throw new Error("--verify-staged 不得与 --write/--expect-bundle 同时使用");
  }
  return { write, expectBundle, verifyStaged };
}

function runGitAt(repositoryRoot, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} 失败（${result.status}）：${result.stderr.toString("utf8").trim()}`,
    );
  }
  return result;
}

function runGit(args, options = {}) {
  return runGitAt(repoRoot, args, options);
}

function splitNul(buffer) {
  const parts = buffer.toString("utf8").split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

function parseHeadTree(buffer) {
  const tree = new Map();
  for (const record of splitNul(buffer)) {
    const match = record.match(/^(\d{6})\s+(\w+)\s+([0-9a-f]+)\t([\s\S]+)$/);
    if (!match) throw new Error(`git ls-tree 输出结构异常：${record}`);
    tree.set(match[4], { oldMode: match[1], baseType: match[2], baseBlob: match[3] });
  }
  return tree;
}

export function parseNameStatus(buffer, allowedStatuses = ["M", "D"]) {
  const parts = splitNul(buffer);
  if (parts.length % 2 !== 0) throw new Error("git name-status -z 输出结构异常");
  const entries = [];
  for (let index = 0; index < parts.length; index += 2) {
    const status = parts[index];
    const filePath = parts[index + 1];
    if (!new Set(allowedStatuses).has(status)) {
      throw new Error(`不支持的未暂存 Git 状态：${status}\t${filePath}`);
    }
    entries.push({ status, path: filePath });
  }
  return entries;
}

export function compareUtf8Paths(left, right) {
  return Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeCandidatePath(filePath) {
  if (
    !filePath ||
    filePath.includes("\0") ||
    filePath.includes("\n") ||
    filePath.includes("\r") ||
    filePath.includes("\t") ||
    filePath.includes("\uFFFD")
  ) {
    throw new Error(`路径含 TSV 禁止字符：${JSON.stringify(filePath)}`);
  }
  const normalized = filePath.split(path.sep).join("/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`路径越出仓库：${filePath}`);
  }
  return normalized;
}

function sanitizeRemote(remote) {
  const value = remote.trim();
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const scp = value.match(/^[^@\s]+@([^:\s]+):(.+)$/);
    if (scp) return `ssh://${scp[1]}/${scp[2]}`;
    return value.replace(/[?#].*$/, "").replace(/:\/\/[^/@]+@/, "://<redacted>@");
  }
}

function groupFor(filePath) {
  if (filePath.startsWith("business-docs/02-供应链项目/")) return "supply-chain";
  if (filePath.startsWith("business-docs/03-设计组-PSD与AI调研/")) return "design-research";
  if (
    filePath.startsWith("archive/2026-08-09-ai-project-brief-security-maintenance") ||
    filePath === "sites/scripts/build-security-maintenance-archive.mjs" ||
    filePath === "sites/tests/security-maintenance-archive.test.mjs"
  ) {
    return "security-maintenance-archive";
  }
  if (
    filePath.startsWith("business-docs/01-客服Agent项目/") ||
    filePath.startsWith("business-docs/08-工具/") ||
    /customer-(?:agent|project)/.test(filePath)
  ) {
    return "customer-agent";
  }
  return "shared-repository";
}

export function assertSafePath(filePath) {
  const normalized = normalizeCandidatePath(filePath);
  const segments = normalized.split("/");
  if (forbiddenExactPaths.has(normalized)) throw new Error(`DEC-PUBLISH 明确排除：${normalized}`);
  if (segments.some((segment) => forbiddenSegments.has(segment))) {
    throw new Error(`候选包含禁止目录：${normalized}`);
  }
  if (segments.some((segment) => /^\.env(?:\.|$)/.test(segment))) {
    throw new Error(`候选包含环境密钥文件：${normalized}`);
  }
  if (/\.(?:key|pem|p12|pfx)$/i.test(normalized) || /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i.test(normalized)) {
    throw new Error(`候选包含密钥文件：${normalized}`);
  }
  if (!normalized.includes("/") && /\.pdf$/i.test(normalized)) {
    throw new Error(`根目录 PDF 未经 DEC-PUBLISH 批准：${normalized}`);
  }
  if (normalized.startsWith("business-docs/01-客服Agent项目/20-设计-进行中/assets/")) {
    throw new Error(`旧架构图品牌/字体 assets 明确排除：${normalized}`);
  }
}

function entryMap(entries) {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

function requireEntry(entriesByPath, filePath, status, label) {
  const entry = entriesByPath.get(filePath);
  const statuses = Array.isArray(status) ? status : status ? [status] : null;
  if (!entry || (statuses && !statuses.includes(entry.status))) {
    const actual = entry ? entry.status : "缺失";
    throw new Error(
      `${label}原子集合不完整：${filePath} 应为 ${statuses?.join("/") ?? "候选项"}，实际 ${actual}`,
    );
  }
}

export function validateAtomicRelationships(entries) {
  const entriesByPath = entryMap(entries);
  for (const [before, after] of movePairs) {
    if (!entriesByPath.has(before) && !entriesByPath.has(after)) continue;
    requireEntry(entriesByPath, before, "D", "历史迁移");
    requireEntry(entriesByPath, after, "A", "历史迁移");
  }

  const businessTriggered = entries.some(
    (entry) =>
      ["M", "A"].includes(entry.status) &&
      (businessSourcePaths.includes(entry.path) ||
        businessGeneratorPrefixes.some((prefix) => entry.path.startsWith(prefix))),
  );
  if (businessTriggered) {
    for (const filePath of businessGeneratedPaths) {
      requireEntry(entriesByPath, filePath, ["M", "A"], "07/08 生成视图");
    }
  }

  const diagramRoot = "business-docs/01-客服Agent项目/20-设计-进行中/diagrams";
  const diagramSources = [...entriesByPath.keys()].filter(
    (filePath) => filePath.startsWith(`${diagramRoot}/`) && filePath.endsWith(".puml"),
  );
  const diagramSvgs = [...entriesByPath.keys()].filter(
    (filePath) => filePath.startsWith(`${diagramRoot}/svg/`) && filePath.endsWith(".svg"),
  );
  for (const puml of diagramSources) {
    const basename = path.posix.basename(puml, ".puml");
    requireEntry(entriesByPath, `${diagramRoot}/svg/${basename}.svg`, ["M", "A"], basename);
  }
  for (const svg of diagramSvgs) {
    const basename = path.posix.basename(svg, ".svg");
    requireEntry(entriesByPath, `${diagramRoot}/${basename}.puml`, ["M", "A"], basename);
  }
  if (diagramSources.length || diagramSvgs.length) {
    requireEntry(
      entriesByPath,
      "business-docs/01-客服Agent项目/20-设计-进行中/架构图-PlantUML浏览器.html",
      ["M", "A"],
      "架构图 HTML",
    );
  }

  const securityArchiveTriggered = entries.some((entry) =>
    entry.path.startsWith("archive/2026-08-09-ai-project-brief-security-maintenance"),
  );
  if (securityArchiveTriggered) {
    for (const filePath of [
      "archive/2026-08-09-ai-project-brief-security-maintenance.manifest.json",
      "sites/scripts/build-security-maintenance-archive.mjs",
      "sites/tests/security-maintenance-archive.test.mjs",
    ]) {
      requireEntry(entriesByPath, filePath, ["M", "A"], "安全维护归档");
    }
  }
}

async function assertCandidateFile(entry) {
  assertSafePath(entry.path);
  if (entry.status === "D") return null;
  const ignored = runGit(["check-ignore", "--no-index", "-q", "--", entry.path], {
    allowFailure: true,
  });
  if (ignored.status === 0) {
    throw new Error(`候选 M/A 路径被 ignore 规则命中，拒绝 tracked-but-ignored：${entry.path}`);
  }
  const absolute = path.join(repoRoot, entry.path);
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink()) throw new Error(`候选禁止符号链接：${entry.path}`);
  if (!metadata.isFile()) throw new Error(`候选不是普通文件：${entry.path}`);
  if ((metadata.mode & 0o111) !== 0) {
    throw new Error(`三字段 manifest 不承载 executable bit，候选须先移除执行位：${entry.path}`);
  }
  const sample = (await readFile(absolute)).subarray(0, 8192);
  if (sample.includes(0) && !allowedBinaryExtensions.has(path.extname(entry.path).toLowerCase())) {
    throw new Error(`候选包含未知二进制类型，须由 Security/License 明确处置：${entry.path}`);
  }
  return metadata;
}

function shouldScanText(filePath) {
  return (
    textExtensions.has(path.extname(filePath).toLowerCase()) ||
    [".gitattributes", ".gitignore"].includes(path.basename(filePath))
  );
}

async function assertNoHighConfidenceSecrets(entry) {
  if (entry.status === "D" || !shouldScanText(entry.path)) return;
  if (entry.path === publicBoundaryFixturePath) return;
  const text = await readFile(path.join(repoRoot, entry.path), "utf8");
  for (const [label, pattern] of highConfidenceSecretPatterns) {
    if (pattern.test(text)) throw new Error(`候选命中高置信敏感模式 ${label}：${entry.path}`);
  }
}

async function assertNewTextHygiene(entry) {
  if (entry.status !== "A" || !shouldScanText(entry.path)) return;
  if (entry.path.includes("/vendor/") || entry.path.endsWith(".min.js")) return;
  const text = await readFile(path.join(repoRoot, entry.path), "utf8");
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^(?:<<<<<<<|=======|>>>>>>>)(?: |$)/.test(line)) {
      throw new Error(`新增文本含冲突标记：${entry.path}:${index + 1}`);
    }
    const trailing = line.match(/[ \t]+$/)?.[0] ?? "";
    const markdownHardBreak = entry.path.endsWith(".md") && trailing === "  ";
    if (trailing && !markdownHardBreak) {
      throw new Error(`新增文本含非受控行尾空白：${entry.path}:${index + 1}`);
    }
  }
}

function markdownDestinations(text) {
  return [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1].trim());
}

function isProjectedFile(filePath, entriesByPath, trackedFiles) {
  const entry = entriesByPath.get(filePath);
  if (entry?.status === "D") return false;
  return Boolean(entry && ["M", "A"].includes(entry.status)) || trackedFiles.has(filePath);
}

function isProjectedDirectory(directoryPath, entriesByPath, trackedFiles) {
  const prefix = `${directoryPath.replace(/\/$/, "")}/`;
  return [...new Set([...trackedFiles, ...entriesByPath.keys()])].some(
    (filePath) => filePath.startsWith(prefix) && isProjectedFile(filePath, entriesByPath, trackedFiles),
  );
}

function documentDestinations(filePath, text) {
  if (filePath.endsWith(".md")) return markdownDestinations(text);
  if (filePath.endsWith(".html")) {
    return [...text.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)].map(
      (match) => match[1].trim(),
    );
  }
  return [];
}

async function assertChangedDocumentLinks(entries) {
  const failures = [];
  const entriesByPath = entryMap(entries);
  const trackedFiles = new Set(splitNul(runGit(["ls-files", "-z"]).stdout));
  const projectedDocuments = [...new Set([...trackedFiles, ...entriesByPath.keys()])]
    .filter(
      (filePath) =>
        isProjectedFile(filePath, entriesByPath, trackedFiles) &&
        (filePath.endsWith(".md") || filePath.endsWith(".html")),
    )
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const filePath of projectedDocuments) {
    const sourcePath = path.join(repoRoot, filePath);
    const text = await readFile(sourcePath, "utf8");
    for (const rawDestination of documentDestinations(filePath, text)) {
      const angleMatch = rawDestination.match(/^<([^>]+)>/);
      const destination = angleMatch
        ? angleMatch[1]
        : rawDestination.split(/\s+(?=["'])/)[0];
      if (
        !destination ||
        /^__[A-Z0-9_]+__$/.test(destination) ||
        destination.startsWith("#") ||
        destination.startsWith("/") ||
        destination.startsWith("//") ||
        /^[A-Za-z][A-Za-z\d+.-]*:/.test(destination)
      ) {
        continue;
      }
      let decoded;
      try {
        decoded = decodeURIComponent(destination.split(/[?#]/, 1)[0]);
      } catch {
        failures.push(`${filePath} -> 无法解码 ${destination}`);
        continue;
      }
      const linkBase = filePath.startsWith("business-docs/08-工具/templates/")
        ? projectRoot
        : path.dirname(sourcePath);
      const target = path.resolve(linkBase, decoded);
      const relative = path.relative(repoRoot, target);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        failures.push(`${filePath} -> 越出仓库 ${destination}`);
        continue;
      }
      try {
        const targetStat = await stat(target);
        const repoRelative = relative.split(path.sep).join("/");
        const ignored = runGit(["check-ignore", "--no-index", "-q", "--", repoRelative], {
          allowFailure: true,
        });
        if (ignored.status === 0) {
          failures.push(`${filePath} -> 指向 ignored 目标 ${destination}`);
          continue;
        }
        const projected = targetStat.isDirectory()
          ? isProjectedDirectory(repoRelative, entriesByPath, trackedFiles)
          : isProjectedFile(repoRelative, entriesByPath, trackedFiles);
        if (!projected) failures.push(`${filePath} -> 目标不在 HEAD/候选投影 ${destination}`);
      } catch (error) {
        failures.push(`${filePath} -> 不存在 ${destination} (${error.code ?? error.message})`);
      }
    }
  }
  if (failures.length) throw new Error(`候选投影文档断链：\n${failures.join("\n")}`);
}

async function hashEntry(entry) {
  if (entry.status === "D") return { ...entry, sha256: "-", group: groupFor(entry.path) };
  const content = await readFile(path.join(repoRoot, entry.path));
  return {
    ...entry,
    sha256: sha256(content),
    group: groupFor(entry.path),
    hashMode: "raw-bytes",
  };
}

export function renderManifest(entries) {
  return entries
    .slice()
    .sort(compareUtf8Paths)
    .map((entry) => `${entry.status}\t${entry.path}\t${entry.sha256}\n`)
    .join("");
}

export function parseStageManifest(text) {
  const entries = [];
  const paths = new Set();
  const lines = String(text).split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line && index === lines.length - 1) continue;
    const cells = line.split("\t");
    if (cells.length !== 3) throw new Error(`stage manifest 第 ${index + 1} 行不是三列`);
    const [status, filePath, digest] = cells;
    if (!["M", "A", "D"].includes(status)) throw new Error(`stage manifest 状态非法：${status}`);
    normalizeCandidatePath(filePath);
    if (paths.has(filePath)) throw new Error(`stage manifest 路径重复：${filePath}`);
    paths.add(filePath);
    if (status === "D" ? digest !== "-" : !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`stage manifest 哈希非法：${filePath}`);
    }
    entries.push({ status, path: filePath, sha256: digest });
  }
  const sorted = entries.slice().sort(compareUtf8Paths);
  if (entries.some((entry, index) => entry.path !== sorted[index].path)) {
    throw new Error("stage manifest 未按 UTF-8 路径字节序排序");
  }
  return entries;
}

function bundleMaterial({ baseHead, branch, origin, manifestSha256, manifest }) {
  return [
    `${MANIFEST_SCHEMA}\n`,
    `base_head=${baseHead}\n`,
    `branch=${branch}\n`,
    `origin=${origin}\n`,
    `origin_visibility=public\n`,
    `stage_manifest_sha256=${manifestSha256}\n`,
    "--- stage-manifest.tsv ---\n",
    manifest,
  ].join("");
}

function runNodeValidation(label, relativeScript, args = []) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, relativeScript), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} 失败：\n${result.stdout}${result.stderr}`);
  }
  return { label, status: "PASS" };
}

function runProjectChecks() {
  return [
    runNodeValidation(
      "business-sources",
      "business-docs/08-工具/sync_customer_agent_surfaces.mjs",
      ["--check"],
    ),
    runNodeValidation(
      "architecture-diagrams",
      "sites/scripts/sync-customer-agent-architecture-diagrams.mjs",
      ["--check"],
    ),
    runNodeValidation("archive-build", "sites/scripts/build-web.mjs", ["--check"]),
    runNodeValidation(
      "security-maintenance-archive",
      "sites/scripts/build-security-maintenance-archive.mjs",
      ["--check"],
    ),
  ];
}

function renderWorkspaceInventory(entries) {
  return entries
    .slice()
    .sort(compareUtf8Paths)
    .map(
      (entry) =>
        `INCLUDE\t${entry.status}\t${entry.path}\t${entry.sha256}\t${entry.oldMode}\t${entry.newMode}\t${entry.baseBlob}\t${entry.bytes}\t${entry.group}\n`,
    )
    .join("");
}

export function parseWorkspaceInventory(text) {
  const entries = [];
  const paths = new Set();
  const lines = String(text).split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line && index === lines.length - 1) continue;
    const cells = line.split("\t");
    if (cells.length !== 9) throw new Error(`workspace inventory 第 ${index + 1} 行不是九列`);
    const [disposition, status, filePath, digest, oldMode, newMode, baseBlob, bytesText, group] =
      cells;
    if (disposition !== "INCLUDE") throw new Error(`workspace inventory disposition 非法：${disposition}`);
    if (!["M", "A", "D"].includes(status)) throw new Error(`workspace inventory 状态非法：${status}`);
    normalizeCandidatePath(filePath);
    if (paths.has(filePath)) throw new Error(`workspace inventory 路径重复：${filePath}`);
    paths.add(filePath);
    if (status === "D" ? digest !== "-" : !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`workspace inventory 哈希非法：${filePath}`);
    }
    if (!/^(?:0|[1-9][0-9]*)$/.test(bytesText)) {
      throw new Error(`workspace inventory bytes 非法：${filePath}`);
    }
    if (!group || /[\t\r\n]/.test(group)) throw new Error(`workspace inventory group 非法：${filePath}`);
    const baseBlobValid = baseBlob === "-" || /^[0-9a-f]{40,64}$/.test(baseBlob);
    if (!baseBlobValid) throw new Error(`workspace inventory base blob 非法：${filePath}`);
    const shapeValid =
      (status === "A" && oldMode === "-" && newMode === "100644" && baseBlob === "-") ||
      (status === "M" && oldMode === "100644" && newMode === "100644" && baseBlob !== "-") ||
      (status === "D" && /^(?:100644|100755)$/.test(oldMode) && newMode === "-" && baseBlob !== "-");
    if (!shapeValid) throw new Error(`workspace inventory mode/blob 形状非法：${filePath}`);
    if (status === "D" && bytesText !== "0") {
      throw new Error(`workspace inventory 删除项 bytes 必须为 0：${filePath}`);
    }
    entries.push({
      disposition,
      status,
      path: filePath,
      sha256: digest,
      oldMode,
      newMode,
      baseBlob,
      bytes: Number(bytesText),
      group,
    });
  }
  const sorted = entries.slice().sort(compareUtf8Paths);
  if (entries.some((entry, index) => entry.path !== sorted[index].path)) {
    throw new Error("workspace inventory 未按 UTF-8 路径字节序排序");
  }
  return entries;
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function localExclusionSummary(repositoryRoot = repoRoot) {
  const rootEntries = await readdir(repositoryRoot, { withFileTypes: true });
  const rootPdfCount = rootEntries.filter(
    (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"),
  ).length;
  const probes = [
    {
      class: "legacy-rescore-evidence",
      paths: [
        "business-docs/01-客服Agent项目/20-设计-进行中/tests/codex_nfr_rescore_raw.txt",
        "business-docs/01-客服Agent项目/20-设计-进行中/tests/codex_nfr_rescore_r2.txt",
      ],
    },
    {
      class: "legacy-brand-and-font-assets",
      paths: [
        "business-docs/01-客服Agent项目/20-设计-进行中/架构交互图-CS-AI-C11.html",
        "business-docs/01-客服Agent项目/20-设计-进行中/assets",
      ],
    },
    { class: "local-private-workspace", paths: ["local-private"] },
  ];
  const summary = [];
  for (const probe of probes) {
    let presentCount = 0;
    for (const relative of probe.paths) {
      const absolute = path.join(repositoryRoot, relative);
      if (!(await pathExists(absolute))) continue;
      presentCount += 1;
      const ignored = runGitAt(repositoryRoot, ["check-ignore", "-q", "--", relative], {
        allowFailure: true,
      });
      if (ignored.status !== 0) {
        throw new Error(`已知本地排除项未被 Git ignore，拒绝生成候选：${probe.class}`);
      }
    }
    summary.push({ class: probe.class, presentCount, disposition: "EXCLUDED_LOCAL_NO_READ" });
  }
  if (rootPdfCount > 0) {
    const rootPdfs = rootEntries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
      .map((entry) => entry.name);
    for (const filePath of rootPdfs) {
      const ignored = runGitAt(repositoryRoot, ["check-ignore", "-q", "--", filePath], {
        allowFailure: true,
      });
      if (ignored.status !== 0) throw new Error("根目录 PDF 未被 Git ignore，拒绝生成候选");
    }
  }
  summary.push({
    class: "unapproved-root-pdf",
    presentCount: rootPdfCount,
    disposition: "EXCLUDED_LOCAL_NO_READ",
  });
  return summary;
}

function countBy(entries, key) {
  return Object.fromEntries(
    [...new Set(entries.map((entry) => entry[key]))]
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map((value) => [value, entries.filter((entry) => entry[key] === value).length]),
  );
}

export function buildCandidateRecord({
  baseHead,
  branch,
  origin,
  entries,
  localExclusions,
  checks,
}) {
  const sortedEntries = entries.slice().sort(compareUtf8Paths);
  const manifest = renderManifest(sortedEntries);
  const stageManifestSha256 = sha256(manifest);
  const workspaceInventory = renderWorkspaceInventory(sortedEntries);
  const workspaceInventorySha256 = sha256(workspaceInventory);
  const candidateBundleSha256 = sha256(
    `${bundleMaterial({
      baseHead,
      branch,
      origin,
      manifestSha256: stageManifestSha256,
      manifest,
    })}` +
      `--- workspace-inventory.tsv ---\n${workspaceInventorySha256}\n${workspaceInventory}` +
      `--- local-exclusions.json ---\n${JSON.stringify(localExclusions)}\n` +
      `--- checks.json ---\n${JSON.stringify(checks)}\n`,
  );
  return {
    schemaVersion: 1,
    schema: MANIFEST_SCHEMA,
    decisionId: DECISION_ID,
    state: "CANDIDATE_NOT_APPROVED",
    originVisibility: "public",
    baseHead,
    branch,
    origin,
    stageManifestSha256,
    workspaceInventorySha256,
    candidateBundleSha256,
    counts: {
      total: sortedEntries.length,
      byStatus: countBy(sortedEntries, "status"),
      byReviewGroup: countBy(sortedEntries, "group"),
    },
    selectionPolicy: "INCLUDE_ALL_NONIGNORED_WORKTREE_CHANGES",
    localExclusions,
    checks,
    entries: sortedEntries.map((entry) => ({ disposition: "INCLUDE", ...entry })),
    manifest,
    workspaceInventory,
  };
}

async function collectCandidateSnapshot(checks) {
  const staged = splitNul(runGit(["diff", "--cached", "--name-only", "-z"]).stdout);
  if (staged.length) {
    throw new Error(`检测到已暂存路径，候选生成器拒绝继续：\n${staged.join("\n")}`);
  }
  const conflicts = splitNul(
    runGit(["diff", "--name-only", "--diff-filter=U", "-z"]).stdout,
  );
  if (conflicts.length) throw new Error(`检测到未解决冲突：\n${conflicts.join("\n")}`);
  const summary = runGit(["diff", "--summary"]).stdout.toString("utf8");
  if (/^ mode change /m.test(summary)) {
    throw new Error("三字段 manifest 不承载 mode-only 变化，须先单独处置文件模式");
  }

  const tracked = parseNameStatus(
    runGit(["diff", "--name-status", "--no-renames", "-z"]).stdout,
  );
  const untracked = splitNul(
    runGit(["ls-files", "--others", "--exclude-standard", "-z"]).stdout,
  ).map((filePath) => ({ status: "A", path: filePath }));
  const paths = new Set();
  const normalizedPaths = new Map();
  const headTree = parseHeadTree(runGit(["ls-tree", "-r", "-z", "HEAD"]).stdout);
  const entries = [...tracked, ...untracked]
    .map((entry) => ({ ...entry, path: normalizeCandidatePath(entry.path) }))
    .sort(compareUtf8Paths);
  for (const entry of entries) {
    if (paths.has(entry.path)) throw new Error(`候选路径重复：${entry.path}`);
    const nfc = entry.path.normalize("NFC");
    const collision = normalizedPaths.get(nfc);
    if (collision && collision !== entry.path) {
      throw new Error(`候选路径 Unicode 归一化碰撞：${collision} / ${entry.path}`);
    }
    normalizedPaths.set(nfc, entry.path);
    paths.add(entry.path);
    const metadata = await assertCandidateFile(entry);
    const base = headTree.get(entry.path);
    if (["M", "D"].includes(entry.status) && (!base || base.baseType !== "blob")) {
      throw new Error(`候选 ${entry.status} 路径缺少 HEAD blob：${entry.path}`);
    }
    if (entry.status === "A" && base) throw new Error(`候选 A 路径已存在于 HEAD：${entry.path}`);
    entry.oldMode = base?.oldMode ?? "-";
    entry.newMode = entry.status === "D" ? "-" : "100644";
    entry.baseBlob = base?.baseBlob ?? "-";
    entry.bytes = metadata?.size ?? 0;
  }
  if (!entries.length) throw new Error("当前工作树没有可生成的 DEC-PUBLISH 候选变更");
  validateAtomicRelationships(entries);
  await Promise.all(entries.map(assertNoHighConfidenceSecrets));
  await Promise.all(entries.map(assertNewTextHygiene));
  await assertChangedDocumentLinks(entries);

  const diffCheck = runGit(["diff", "--check"], { allowFailure: true });
  if (diffCheck.status !== 0) {
    throw new Error(`git diff --check 失败：\n${diffCheck.stdout.toString("utf8")}${diffCheck.stderr.toString("utf8")}`);
  }

  const hashedEntries = await Promise.all(entries.map(hashEntry));
  hashedEntries.sort(compareUtf8Paths);
  const baseHead = runGit(["rev-parse", "HEAD"]).stdout.toString("utf8").trim();
  const branch = runGit(["branch", "--show-current"]).stdout.toString("utf8").trim() || "DETACHED";
  const originResult = runGit(["remote", "get-url", "origin"], { allowFailure: true });
  if (originResult.status !== 0) throw new Error("DEC-PUBLISH 候选必须绑定 origin");
  const origin = sanitizeRemote(originResult.stdout.toString("utf8"));
  const localExclusions = await localExclusionSummary();
  return buildCandidateRecord({
    baseHead,
    branch,
    origin,
    entries: hashedEntries,
    localExclusions,
    checks,
  });
}

async function collectStableCandidate() {
  const beforeChecks = await collectCandidateSnapshot([]);
  const checks = runProjectChecks();
  const first = await collectCandidateSnapshot(checks);
  if (
    beforeChecks.baseHead !== first.baseHead ||
    beforeChecks.manifest !== first.manifest ||
    beforeChecks.workspaceInventory !== first.workspaceInventory ||
    JSON.stringify(beforeChecks.localExclusions) !== JSON.stringify(first.localExclusions)
  ) {
    throw new Error("工作树在生成/归档稳定检查期间发生变化，候选已失效，请停止并重新生成");
  }
  const second = await collectCandidateSnapshot(checks);
  if (
    first.baseHead !== second.baseHead ||
    first.candidateBundleSha256 !== second.candidateBundleSha256 ||
    first.manifest !== second.manifest ||
    first.workspaceInventory !== second.workspaceInventory
  ) {
    throw new Error("工作树在双采样期间发生变化，候选已失效，请停止并重新生成");
  }
  return second;
}

function candidateJson(candidate) {
  const { manifest: _manifest, workspaceInventory: _workspaceInventory, ...metadata } = candidate;
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

function approvalTemplate(candidate) {
  const reviewGroups = Object.fromEntries(
    Object.entries(candidate.counts.byReviewGroup).sort(([left], [right]) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    ),
  );
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      decisionId: DECISION_ID,
      state: "PENDING_THREE_PARTY_APPROVAL",
      candidateBundleSha256: candidate.candidateBundleSha256,
      stageManifestSha256: candidate.stageManifestSha256,
      workspaceInventorySha256: candidate.workspaceInventorySha256,
      baseHead: candidate.baseHead,
      approvalScope: "ALL_REVIEW_GROUPS_IN_BUNDLE",
      reviewGroups,
      approvals: [
        { ownerRole: "Product Owner", status: "PENDING", evidenceId: "" },
        { ownerRole: "Security Owner", status: "PENDING", evidenceId: "" },
        { ownerRole: "Tech Owner", status: "PENDING", evidenceId: "" },
      ],
      rule: "三方必须分别以受控 EVD 确认同一 candidateBundleSha256，且批准覆盖 reviewGroups 列出的全部分组；不允许对同一 bundle 做局部分组批准。任一路径、状态、内容、HEAD、branch、origin、inventory disposition 或本地排除处置变化即全部失效。",
    },
    null,
    2,
  )}\n`;
}

export function candidateFiles(candidate) {
  return new Map([
    ["README.md", candidateReadme(candidate)],
    ["approvals.template.json", approvalTemplate(candidate)],
    ["manifest.json", candidateJson(candidate)],
    ["stage-manifest.tsv", candidate.manifest],
    ["workspace-inventory.tsv", candidate.workspaceInventory],
  ]);
}

export function candidateReadme(candidate) {
  const reviewGroupLines = Object.entries(candidate.counts.byReviewGroup)
    .sort(([left], [right]) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    )
    .map(([group, count]) => `- \`${group}\`：${count} 个路径`);
  return [
    `# ${DECISION_ID} 候选（未批准）`,
    "",
    "状态：`CANDIDATE_NOT_APPROVED`。本目录位于已忽略的 `output/`，不得暂存或作为批准本身。",
    "",
    `- Base HEAD：\`${candidate.baseHead}\``,
    `- Branch：\`${candidate.branch}\``,
    `- Origin：\`${candidate.origin}\`（Public 合同边界）`,
    `- Workspace inventory SHA-256：\`${candidate.workspaceInventorySha256}\``,
    `- Exact-file stage manifest SHA-256：\`${candidate.stageManifestSha256}\``,
    `- Candidate bundle SHA-256：\`${candidate.candidateBundleSha256}\``,
    `- 路径数：${candidate.counts.total}（M ${candidate.counts.byStatus.M ?? 0} / A ${candidate.counts.byStatus.A ?? 0} / D ${candidate.counts.byStatus.D ?? 0}）`,
    "",
    "## 审批范围（同一 bundle）",
    "",
    ...reviewGroupLines,
    "",
    "Product / Security / Tech 三方批准必须覆盖上述全部分组。如任一分组不应交付，必须先调整工作树并重新生成 bundle；禁止对同一 bundle 做局部批准。",
    "",
    "## 文件",
    "",
    "- `workspace-inventory.tsv`：覆盖全部非忽略工作树变更，当前全部标为 `INCLUDE`；不得静默漏项。",
    "- `stage-manifest.tsv`：按 UTF-8 路径字节序排列的 `<status>\\t<path>\\t<sha256-or->`。",
    "- `manifest.json`：基线、分组、本地排除类别、单文件哈希与三层摘要。",
    "- `approvals.template.json`：三方同摘要签发模板；真实确认与身份映射只留受控系统。",
    "",
    "## 复核",
    "",
    "```bash",
    `node business-docs/08-工具/${path.basename(scriptPath)} --expect-bundle=${candidate.candidateBundleSha256}`,
    "# 三方批准并按清单人工精确暂存后，commit 前再运行：",
    `node business-docs/08-工具/${path.basename(scriptPath)} --verify-staged=${candidate.candidateBundleSha256}`,
    "```",
    "",
    "只有 Product / Security / Tech 三方受控 EVD 都明确引用同一 bundle SHA 后，才允许按 `stage-manifest.tsv` 精确暂存；仍禁止 `git add .`。`STAGED_MATCH` 只证明 index 与候选一致，不自动获得 commit/push 授权。",
    "",
  ].join("\n");
}

async function directoryFiles(root) {
  const names = await readdir(root);
  return names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

export async function readCandidateFile(directory, name) {
  if (path.basename(name) !== name) throw new Error(`候选文件名非法：${name}`);
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error("当前平台缺少 O_NOFOLLOW，拒绝读取审批候选");
  }
  const target = path.join(directory, name);
  const before = await lstat(target);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`候选文件必须是普通文件且禁止符号链接：${target}`);
  }
  const canonicalDirectory = await realpath(directory);
  const canonicalParent = await realpath(path.dirname(target));
  if (canonicalParent !== canonicalDirectory) throw new Error(`候选文件父目录发生越界：${target}`);
  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error(`候选文件在读取期间被替换：${target}`);
    }
    return await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error(`候选文件禁止符号链接：${target}`);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function assertSafeOutputRoot(
  repositoryRoot = repoRoot,
  candidateOutputRoot = outputRoot,
) {
  const relativeOutput = normalizeCandidatePath(path.relative(repositoryRoot, candidateOutputRoot));
  if (!relativeOutput || relativeOutput.startsWith("../")) {
    throw new Error("候选输出路径必须位于仓库内且不能与仓库根重合");
  }
  const ignored = runGitAt(
    repositoryRoot,
    [
      "check-ignore",
      "--no-index",
      "-q",
      "--",
      `${relativeOutput}/.ignore-probe`,
    ],
    { allowFailure: true },
  );
  if (ignored.status !== 0) {
    throw new Error("output/customer-agent-publish-gate 不再受 Git ignore 保护，拒绝写入");
  }
  for (const candidate of [path.dirname(candidateOutputRoot), candidateOutputRoot]) {
    if (!(await pathExists(candidate))) continue;
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) throw new Error(`候选输出路径禁止符号链接：${candidate}`);
    if (!metadata.isDirectory()) throw new Error(`候选输出路径不是目录：${candidate}`);
  }
  await mkdir(candidateOutputRoot, { recursive: true });
  const [canonicalRepo, canonicalOutput] = await Promise.all([
    realpath(repositoryRoot),
    realpath(candidateOutputRoot),
  ]);
  const relative = path.relative(canonicalRepo, canonicalOutput);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("候选输出真实路径越出仓库或与仓库根重合");
  }
}

async function writeCandidate(candidate) {
  await assertSafeOutputRoot();
  const directoryName = `candidate-${candidate.candidateBundleSha256.slice(0, 16)}`;
  const target = path.join(outputRoot, directoryName);
  const files = candidateFiles(candidate);

  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) throw new Error(`既有候选目录禁止符号链接：${target}`);
    if (!metadata.isDirectory()) throw new Error(`既有候选目标不是目录：${target}`);
    const existing = await directoryFiles(target);
    if (existing.join("\n") !== [...files.keys()].sort().join("\n")) {
      throw new Error(`既有候选目录结构异常，拒绝覆盖：${target}`);
    }
    for (const [name, expected] of files) {
      const actual = await readCandidateFile(target, name);
      if (actual !== expected) throw new Error(`既有候选内容不一致，拒绝覆盖：${target}/${name}`);
    }
    return target;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporaryRoot = await mkdtemp(path.join(outputRoot, ".candidate-tmp-"));
  try {
    await Promise.all(
      [...files].map(([name, content]) => writeFile(path.join(temporaryRoot, name), content, "utf8")),
    );
    await rename(temporaryRoot, target);
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  return target;
}

function indexMetadata(filePath, repositoryRoot = repoRoot) {
  const records = splitNul(
    runGitAt(repositoryRoot, ["ls-files", "--stage", "-z", "--", filePath]).stdout,
  );
  if (records.length !== 1) throw new Error(`index 条目数量异常：${filePath}`);
  const match = records[0].match(/^(\d{6})\s+([0-9a-f]+)\s+(\d+)\t([\s\S]+)$/);
  if (!match || match[3] !== "0" || match[4] !== filePath) {
    throw new Error(`index 条目结构异常：${filePath}`);
  }
  return { mode: match[1], blob: match[2] };
}

async function loadCandidate(
  bundleSha256,
  { repositoryRoot = repoRoot, candidateOutputRoot = outputRoot } = {},
) {
  await assertSafeOutputRoot(repositoryRoot, candidateOutputRoot);
  const directory = path.join(
    candidateOutputRoot,
    `candidate-${bundleSha256.slice(0, 16)}`,
  );
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("候选审批目录必须是仓内普通目录");
  }
  const expectedNames = [
    "README.md",
    "approvals.template.json",
    "manifest.json",
    "stage-manifest.tsv",
    "workspace-inventory.tsv",
  ].sort();
  const actualNames = await directoryFiles(directory);
  if (actualNames.join("\n") !== expectedNames.join("\n")) {
    throw new Error("候选审批目录文件集合异常");
  }
  const [readme, approvals, manifestJson, stageManifest, workspaceInventory] = await Promise.all([
    readCandidateFile(directory, "README.md"),
    readCandidateFile(directory, "approvals.template.json"),
    readCandidateFile(directory, "manifest.json"),
    readCandidateFile(directory, "stage-manifest.tsv"),
    readCandidateFile(directory, "workspace-inventory.tsv"),
  ]);
  const candidate = JSON.parse(manifestJson);
  for (const [key, expected] of [
    ["schemaVersion", 1],
    ["schema", MANIFEST_SCHEMA],
    ["decisionId", DECISION_ID],
    ["state", "CANDIDATE_NOT_APPROVED"],
    ["originVisibility", "public"],
    ["selectionPolicy", "INCLUDE_ALL_NONIGNORED_WORKTREE_CHANGES"],
  ]) {
    if (candidate[key] !== expected) throw new Error(`manifest.json ${key} 非法`);
  }
  if (candidate.candidateBundleSha256 !== bundleSha256) {
    throw new Error("候选目录名、参数与 manifest.json bundle SHA 不一致");
  }
  if (sha256(stageManifest) !== candidate.stageManifestSha256) {
    throw new Error("stage-manifest.tsv 摘要与 manifest.json 不一致");
  }
  if (sha256(workspaceInventory) !== candidate.workspaceInventorySha256) {
    throw new Error("workspace-inventory.tsv 摘要与 manifest.json 不一致");
  }
  const entries = parseStageManifest(stageManifest);
  const inventoryEntries = parseWorkspaceInventory(workspaceInventory);
  assertSameJson(
    inventoryEntries.map(({ status, path: filePath, sha256: digest }) => ({
      status,
      path: filePath,
      sha256: digest,
    })),
    entries,
    "workspace inventory 与 stage manifest 不一致",
  );
  if (!Array.isArray(candidate.entries)) throw new Error("manifest.json entries 缺失");
  const allowedEntryKeys = new Set([
    "disposition",
    "status",
    "path",
    "sha256",
    "oldMode",
    "newMode",
    "baseBlob",
    "bytes",
    "group",
    "hashMode",
  ]);
  for (const entry of candidate.entries) {
    if (Object.keys(entry).some((key) => !allowedEntryKeys.has(key))) {
      throw new Error(`manifest.json entry 含未知字段：${entry.path ?? "<unknown>"}`);
    }
    if (entry.status === "D" ? "hashMode" in entry : entry.hashMode !== "raw-bytes") {
      throw new Error(`manifest.json entry hashMode 非法：${entry.path ?? "<unknown>"}`);
    }
  }
  const jsonInventoryMirror = candidate.entries.map(
    ({ disposition, status, path: filePath, sha256: digest, oldMode, newMode, baseBlob, bytes, group }) => ({
      disposition,
      status,
      path: filePath,
      sha256: digest,
      oldMode,
      newMode,
      baseBlob,
      bytes,
      group,
    }),
  );
  assertSameJson(jsonInventoryMirror, inventoryEntries, "manifest.json entries 与 inventory 原始字节不一致");
  assertSameJson(
    candidate.counts,
    {
      total: inventoryEntries.length,
      byStatus: countBy(inventoryEntries, "status"),
      byReviewGroup: countBy(inventoryEntries, "group"),
    },
    "manifest.json counts 与 inventory 不一致",
  );
  const recomputedBundle = sha256(
    `${bundleMaterial({
      baseHead: candidate.baseHead,
      branch: candidate.branch,
      origin: candidate.origin,
      manifestSha256: candidate.stageManifestSha256,
      manifest: stageManifest,
    })}` +
      `--- workspace-inventory.tsv ---\n${candidate.workspaceInventorySha256}\n${workspaceInventory}` +
      `--- local-exclusions.json ---\n${JSON.stringify(candidate.localExclusions)}\n` +
      `--- checks.json ---\n${JSON.stringify(candidate.checks)}\n`,
  );
  if (recomputedBundle !== bundleSha256) throw new Error("候选 bundle 内容重算不一致");
  if (readme !== candidateReadme(candidate)) throw new Error("候选 README.md 与确定性生成结果不一致");
  if (approvals !== approvalTemplate(candidate)) {
    throw new Error("候选 approvals.template.json 与确定性生成结果不一致");
  }
  return { candidate, entries, inventoryEntries };
}

async function stagedCandidateSnapshot(
  candidate,
  entries,
  inventoryEntries,
  repositoryRoot = repoRoot,
) {
  const git = (args, options = {}) => runGitAt(repositoryRoot, args, options);
  const currentHead = git(["rev-parse", "HEAD"]).stdout.toString("utf8").trim();
  const currentBranch =
    git(["branch", "--show-current"]).stdout.toString("utf8").trim() || "DETACHED";
  const currentOrigin = sanitizeRemote(
    git(["remote", "get-url", "origin"]).stdout.toString("utf8"),
  );
  if (currentHead !== candidate.baseHead) throw new Error("staged 核验时 Base HEAD 已漂移");
  if (currentBranch !== candidate.branch) throw new Error("staged 核验时 branch 已漂移");
  if (currentOrigin !== candidate.origin) throw new Error("staged 核验时 origin 已漂移");

  const staged = parseNameStatus(
    git(["diff", "--cached", "--name-status", "--no-renames", "-z"]).stdout,
    ["M", "A", "D"],
  ).sort(compareUtf8Paths);
  const expectedShape = entries.map(({ status, path: filePath }) => ({ status, path: filePath }));
  assertSameJson(staged, expectedShape, "staged 路径/状态与 stage manifest 不一致");

  const candidateEntries = new Map(inventoryEntries.map((entry) => [entry.path, entry]));
  const actualEntries = [];
  for (const entry of staged) {
    const expected = candidateEntries.get(entry.path);
    if (!expected) throw new Error(`staged 路径缺少候选元数据：${entry.path}`);
    if (entry.status === "D") {
      actualEntries.push({ ...entry, sha256: "-" });
      continue;
    }
    const index = indexMetadata(entry.path, repositoryRoot);
    if (index.mode !== expected.newMode) {
      throw new Error(`staged file mode 漂移：${entry.path} ${index.mode} != ${expected.newMode}`);
    }
    const blob = git(["show", `:${entry.path}`]).stdout;
    actualEntries.push({ ...entry, sha256: sha256(blob) });
  }
  if (renderManifest(actualEntries) !== renderManifest(entries)) {
    throw new Error("staged index blob SHA 与 stage manifest 不一致");
  }

  const unstaged = splitNul(git(["diff", "--name-only", "-z"]).stdout);
  const untracked = splitNul(
    git(["ls-files", "--others", "--exclude-standard", "-z"]).stdout,
  );
  if (unstaged.length || untracked.length) {
    throw new Error(
      `精确暂存后仍有候选漂移：unstaged=${unstaged.length}, untracked=${untracked.length}`,
    );
  }
  const diffCheck = git(["diff", "--cached", "--check"], { allowFailure: true });
  if (diffCheck.status !== 0) throw new Error("staged git diff --check 失败");
  const localExclusions = await localExclusionSummary(repositoryRoot);
  assertSameJson(localExclusions, candidate.localExclusions, "本地排除处置已漂移");
  return {
    baseHead: currentHead,
    branch: currentBranch,
    origin: currentOrigin,
    staged,
    stageManifest: renderManifest(actualEntries),
    localExclusions,
  };
}

export async function verifyStagedCandidate(
  bundleSha256,
  {
    repositoryRoot = repoRoot,
    candidateOutputRoot = outputRoot,
    runChecks = runProjectChecks,
  } = {},
) {
  const { candidate, entries, inventoryEntries } = await loadCandidate(bundleSha256, {
    repositoryRoot,
    candidateOutputRoot,
  });
  const beforeChecks = await stagedCandidateSnapshot(
    candidate,
    entries,
    inventoryEntries,
    repositoryRoot,
  );
  const checks = runChecks();
  assertSameJson(checks, candidate.checks, "生成/归档稳定点已漂移");
  const afterChecks = await stagedCandidateSnapshot(
    candidate,
    entries,
    inventoryEntries,
    repositoryRoot,
  );
  assertSameJson(afterChecks, beforeChecks, "staged index/工作树在生成检查期间发生漂移");
  return { candidate, entries };
}

function assertSameJson(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

async function main() {
  const { write, expectBundle, verifyStaged } = parseArgs(process.argv.slice(2));
  if (verifyStaged) {
    const verified = await verifyStagedCandidate(verifyStaged);
    console.log(`${DECISION_ID} STAGED_MATCH / COMMIT_PUSH_STILL_REQUIRE_ACTIVE_AUTHORITY`);
    console.log(`Bundle SHA-256：${verified.candidate.candidateBundleSha256}`);
    console.log(`Index 路径：${verified.entries.length}`);
    return;
  }
  const candidate = await collectStableCandidate();
  if (expectBundle && candidate.candidateBundleSha256 !== expectBundle) {
    throw new Error(
      `候选摘要漂移：期望 ${expectBundle}，当前 ${candidate.candidateBundleSha256}`,
    );
  }
  const target = write ? await writeCandidate(candidate) : null;
  const statusCounts = candidate.counts.byStatus;
  console.log(`${DECISION_ID} STRUCTURE_PASS / CANDIDATE_NOT_APPROVED`);
  console.log(`Base HEAD：${candidate.baseHead}`);
  console.log(
    `路径：${candidate.counts.total}（M ${statusCounts.M ?? 0} / A ${statusCounts.A ?? 0} / D ${statusCounts.D ?? 0}）`,
  );
  console.log(`Workspace inventory SHA-256：${candidate.workspaceInventorySha256}`);
  console.log(`Stage manifest SHA-256：${candidate.stageManifestSha256}`);
  console.log(`Bundle SHA-256：${candidate.candidateBundleSha256}`);
  if (target) console.log(`候选目录：${target}`);
  console.log("三方同摘要 EVD 未齐前：不得 stage、commit 或 push。");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === scriptPath;
if (isMain) {
  main().catch((error) => {
    console.error(`DEC-PUBLISH 候选生成失败：${error.message}`);
    process.exitCode = 1;
  });
}
