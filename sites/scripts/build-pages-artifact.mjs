import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import {
  cp,
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

const scriptPath = fileURLToPath(import.meta.url);
const siteRoot = path.resolve(path.dirname(scriptPath), "..");
const repoRoot = path.resolve(siteRoot, "..");
const ARCHIVED_SITE_ROOT = path.join(
  repoRoot,
  "archive/2026-08-09-ai-project-brief-security-maintenance"
);
const ARCHIVE_MANIFEST_PATH = path.join(
  repoRoot,
  "archive/2026-08-09-ai-project-brief-security-maintenance.manifest.json"
);
const LOCAL_PRD_HREF = "../../business-docs/01-客服Agent项目/07-客服Agent立项PRD.html";
const LOCAL_HUB_HREF = "../../business-docs/01-客服Agent项目/08-客服Agent立项执行中心.html";
const LOCAL_MEETING_HREF = "../../business-docs/01-客服Agent项目/09-客服Agent需求会汇报.html";
const INTERNAL_ONLY_HREF = "./internal-only.html";
const PUBLIC_MEETING_HREF = "./customer-agent/";
const PUBLIC_MEETING_DIRECTORY = "customer-agent";
const CANONICAL_MEETING_SOURCE = path.join(
  repoRoot,
  "business-docs/01-客服Agent项目/09-客服Agent需求会汇报.html"
);
const REPOSITORY_ONLY_NOTE = "内部资料（仅授权内部访问；公开版不提供）";

const INTERNAL_ONLY_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>内部材料访问说明</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, -apple-system, "PingFang SC", sans-serif; color: #26212c; background: #f5f1f7; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
    main { width: min(560px, 100%); box-sizing: border-box; padding: 36px; border: 1px solid #ded5e4; border-radius: 20px; background: #fff; box-shadow: 0 16px 48px rgba(55, 38, 66, .08); }
    p { margin: 12px 0 0; color: #625969; line-height: 1.75; }
    a { display: inline-block; margin-top: 24px; color: #6b4d7c; font-weight: 650; }
  </style>
</head>
<body>
  <main>
    <h1>现行材料仅授权内部访问</h1>
    <p>公开站点不提供现行项目内容、人员信息、审批记录、费用信息或协作链接。</p>
    <p>请在公司授权环境中通过内部资料入口访问；本地仓库路径不会在此公开。</p>
    <a href="./index.html">返回历史展示页</a>
  </main>
</body>
</html>
`;

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function eexistError(output) {
  const error = new Error(`Pages artifact 已存在，拒绝覆盖：${output}`);
  error.code = "EEXIST";
  return error;
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

export async function readSafePublicMeeting(sourcePath = CANONICAL_MEETING_SOURCE) {
  const source = path.resolve(sourcePath);
  if (!isWithin(repoRoot, source)) throw new Error(`启动会公开源文件越出仓库：${source}`);
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
    throw new Error(`启动会公开源必须是仓库内普通文件：${source}`);
  }
  const canonicalSource = await realpath(source);
  if (!isWithin(await realpath(repoRoot), canonicalSource)) {
    throw new Error(`启动会公开源真实路径越出仓库：${canonicalSource}`);
  }

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  let html;
  try {
    handle = await open(source, flags);
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile()) throw new Error(`启动会公开源必须是仓库内普通文件：${source}`);
    html = (await handle.readFile()).toString("utf8");
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error(`启动会公开源不能是符号链接：${source}`);
    throw error;
  } finally {
    await handle?.close();
  }
  const required = [
    /GENERATED FILE — safe meeting view; DO NOT EDIT/,
    /<meta name="robots" content="noindex,nofollow">/,
    /<link rel="icon" href="data:image\/png;base64,/,
    /<img class="brand-logo" src="data:image\/png;base64,[^"]+" alt="SHINE MAGE">/,
    /<script id="meeting-data" type="application\/json">/,
  ];
  const missing = required.filter((pattern) => !pattern.test(html));
  if (missing.length) throw new Error(`启动会公开源缺少安全标记：${missing.join("、")}`);

  const forbidden = [
    /\bbusiness-docs\b/i,
    /\bsources\b/i,
    /portablePrd/i,
    /\bG0(?:-|\b)/i,
    /\bRACI\b/i,
    /\b(?:EVD|ROLE|USR)[-_]/i,
    /费用|风险/,
    /<a\b[^>]*href=["']https?:/i,
    /<script\b[^>]*src=/i,
    /<link\b[^>]*href=["']https?:/i,
  ];
  const hits = forbidden.filter((pattern) => pattern.test(html));
  if (hits.length) throw new Error(`启动会公开源命中禁区：${hits.join("、")}`);
  return html;
}

/**
 * 删除 canonical artifact 前的边界检查。任何现存路径分量为 symlink，或
 * realpath 逃出受信 Web 根时都拒绝；避免 dist -> 仓库外目录后递归删除。
 */
export async function assertSafeReplaceTarget({ outputPath, canonicalOutputPath, trustedRoot }) {
  const output = path.resolve(outputPath);
  const canonical = path.resolve(canonicalOutputPath);
  const root = path.resolve(trustedRoot);
  if (output !== canonical || !isWithin(root, output)) {
    throw new Error(`只允许替换固定构建目录 ${canonical}`);
  }

  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) throw new Error(`受信 Web 根不能是符号链接：${root}`);
  const realRoot = await realpath(root);
  const relativeParts = path.relative(root, output).split(path.sep).filter(Boolean);
  let cursor = root;
  for (const part of relativeParts) {
    cursor = path.join(cursor, part);
    if (!(await pathExists(cursor))) break;
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`构建目录路径不能包含符号链接：${cursor}`);
    const resolved = await realpath(cursor);
    if (!isWithin(realRoot, resolved)) throw new Error(`构建目录 realpath 逃出 Web 根：${cursor}`);
  }
}

function splitReference(reference) {
  const trimmed = reference.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return null;
  const pathname = trimmed.split(/[?#]/, 1)[0];
  if (!pathname) return null;
  try {
    return decodeURIComponent(pathname);
  } catch {
    return { malformed: true, pathname };
  }
}

function rewriteMarkdownForPublicArtifact(markdown, sourcePath, publicSourceRoot) {
  const linkPattern = /(!?)\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  const linksSanitized = markdown.replace(linkPattern, (whole, imageMarker, _label, angleTarget, plainTarget) => {
    const target = angleTarget ?? plainTarget;
    const reference = splitReference(target);
    if (!reference || reference.malformed || reference.startsWith("/")) return whole;
    const resolved = path.resolve(path.dirname(sourcePath), reference);
    if (isWithin(publicSourceRoot, resolved)) return whole;
    return `${imageMarker ? "图片：" : ""}${REPOSITORY_ONLY_NOTE}`;
  });
  return linksSanitized
    .replace(/`(?:\.\.\/)*business-docs\/[^`]*`/g, "`内部资料路径（公开版不提供）`")
    .replace(/(?:\.\.\/)+business-docs\/[^\s）)，。；;]*/g, REPOSITORY_ONLY_NOTE);
}

async function walkFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  await visit(root);
  return files;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function assertArchivedSiteFrozen({
  archiveSitePath = ARCHIVED_SITE_ROOT,
  manifestPath = ARCHIVE_MANIFEST_PATH,
} = {}) {
  const archiveRoot = path.resolve(archiveSitePath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const files = (await walkFiles(archiveRoot))
    .map((file) => path.relative(archiveRoot, file).split(path.sep).join("/"))
    .sort();
  const treeReceipt = files
    .map((relative) => {
      const filePath = path.join(archiveRoot, relative);
      return readFile(filePath).then((bytes) => `${sha256(bytes)}  ${relative}\n`);
    });
  const treeSha256 = sha256((await Promise.all(treeReceipt)).join(""));
  const entrySha256 = sha256(await readFile(path.join(archiveRoot, "index.html")));
  if (
    manifest.schemaVersion !== 1 ||
    !["archived", "archived-security-maintenance"].includes(manifest.status) ||
    manifest.fileCount !== files.length ||
    manifest.treeSha256 !== treeSha256 ||
    manifest.entrySha256 !== entrySha256
  ) {
    throw new Error(
      `${path.basename(archiveRoot)} 归档站点发生未授权变化：files ${files.length}/${manifest.fileCount} · tree ${treeSha256}/${manifest.treeSha256} · entry ${entrySha256}/${manifest.entrySha256}`
    );
  }
  return { files, treeSha256, entrySha256 };
}

function referencesIn(content, extension) {
  const references = [];
  const htmlPattern = /\bhref\s*=\s*(["'])(.*?)\1/gi;
  if (extension === ".html" || extension === ".md") {
    for (const match of content.matchAll(htmlPattern)) references.push(match[2]);
  }
  if (extension === ".md") {
    const markdownPattern = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
    for (const match of content.matchAll(markdownPattern)) references.push(match[1] ?? match[2]);
  }
  return references;
}

/** 递归校验 artifact 中 HTML href 与 Markdown 链接；查询串和 fragment 不参与文件定位。 */
export async function validateArtifactLinks(artifactRoot) {
  const root = path.resolve(artifactRoot);
  const failures = [];
  for (const file of await walkFiles(root)) {
    const extension = path.extname(file).toLowerCase();
    if (extension !== ".html" && extension !== ".md") continue;
    const content = await readFile(file, "utf8");
    for (const rawReference of referencesIn(content, extension)) {
      const reference = splitReference(rawReference);
      if (!reference) continue;
      if (reference.malformed) {
        failures.push(`${path.relative(root, file)} -> ${rawReference}（URL 编码非法）`);
        continue;
      }
      const target = reference.startsWith("/")
        ? path.resolve(root, `.${reference}`)
        : path.resolve(path.dirname(file), reference);
      if (!isWithin(root, target)) {
        failures.push(`${path.relative(root, file)} -> ${rawReference}（逃出发布包）`);
        continue;
      }
      try {
        const info = await stat(target);
        if (info.isDirectory()) await stat(path.join(target, "index.html"));
      } catch {
        failures.push(`${path.relative(root, file)} -> ${rawReference}（目标不存在）`);
      }
    }
  }
  if (failures.length) throw new Error(`Pages artifact 存在断链：\n${failures.join("\n")}`);
  return true;
}

async function populateArtifact({ stagingOutput, archiveSitePath, meetingSourcePath }) {
  const sourceRoot = path.resolve(archiveSitePath);
  await cp(sourceRoot, stagingOutput, { recursive: true, force: false, errorOnExist: true });

  const stagedIndexPath = path.join(stagingOutput, "index.html");
  const stagedIndex = await readFile(stagedIndexPath, "utf8");
  if (
    !stagedIndex.includes(LOCAL_PRD_HREF) ||
    !stagedIndex.includes(LOCAL_HUB_HREF) ||
    !stagedIndex.includes(LOCAL_MEETING_HREF)
  ) {
    throw new Error("历史页缺少三个仓库内现行材料入口，无法生成公开投影");
  }
  await writeFile(
    stagedIndexPath,
    stagedIndex
      .replaceAll(LOCAL_PRD_HREF, INTERNAL_ONLY_HREF)
      .replaceAll(LOCAL_HUB_HREF, INTERNAL_ONLY_HREF)
      .replaceAll(LOCAL_MEETING_HREF, PUBLIC_MEETING_HREF),
    "utf8"
  );
  await writeFile(path.join(stagingOutput, "internal-only.html"), INTERNAL_ONLY_PAGE, "utf8");
  const publicMeetingDirectory = path.join(stagingOutput, PUBLIC_MEETING_DIRECTORY);
  await mkdir(publicMeetingDirectory);
  await writeFile(
    path.join(publicMeetingDirectory, "index.html"),
    await readSafePublicMeeting(meetingSourcePath),
    "utf8"
  );

  for (const stagedFile of await walkFiles(stagingOutput)) {
    if (path.extname(stagedFile).toLowerCase() !== ".md") continue;
    const relative = path.relative(stagingOutput, stagedFile);
    const sourceFile = path.join(sourceRoot, relative);
    const markdown = await readFile(stagedFile, "utf8");
    await writeFile(
      stagedFile,
      rewriteMarkdownForPublicArtifact(markdown, sourceFile, sourceRoot),
      "utf8"
    );
  }

  await validateArtifactLinks(stagingOutput);
  const files = (await walkFiles(stagingOutput))
    .map((file) => path.relative(stagingOutput, file).split(path.sep).join("/"))
    .sort();
  await writeFile(
    path.join(stagingOutput, "artifact-manifest.json"),
    `${JSON.stringify({ schemaVersion: 3, visibility: "public", files }, null, 2)}\n`,
    "utf8"
  );
  return files;
}

export async function stagePagesArtifact({
  outputPath = path.join(siteRoot, "dist/pages"),
  archiveSitePath = ARCHIVED_SITE_ROOT,
  meetingSourcePath = CANONICAL_MEETING_SOURCE,
  replaceExisting = false,
} = {}) {
  const output = path.resolve(outputPath);
  const canonicalBuildOutput = path.join(siteRoot, "dist/pages");
  const outputExists = await pathExists(output);
  if (replaceExisting) {
    await assertSafeReplaceTarget({
      outputPath: output,
      canonicalOutputPath: canonicalBuildOutput,
      trustedRoot: siteRoot,
    });
  } else if (outputExists) {
    throw eexistError(output);
  }

  await mkdir(path.dirname(output), { recursive: true });
  if (path.resolve(archiveSitePath) === path.resolve(ARCHIVED_SITE_ROOT)) {
    await assertArchivedSiteFrozen({ archiveSitePath });
  }
  const stagingParent = await mkdtemp(path.join(path.dirname(output), `.${path.basename(output)}.stage-`));
  const stagingOutput = path.join(stagingParent, "artifact");
  try {
    const files = await populateArtifact({ stagingOutput, archiveSitePath, meetingSourcePath });
    if (replaceExisting) {
      await assertSafeReplaceTarget({
        outputPath: output,
        canonicalOutputPath: canonicalBuildOutput,
        trustedRoot: siteRoot,
      });
      if (await pathExists(output)) await rm(output, { recursive: true, force: false });
    } else if (await pathExists(output)) {
      throw eexistError(output);
    }
    await rename(stagingOutput, output);
    return { outputPath: output, files };
  } finally {
    await rm(stagingParent, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const outputArg = process.argv.find((value) => value.startsWith("--output="));
  const result = await stagePagesArtifact({
    outputPath: outputArg ? outputArg.slice("--output=".length) : undefined,
    replaceExisting: !outputArg,
  });
  console.log(`Pages 公开投影已生成 · ${result.files.length} 个公开文件 · ${result.outputPath}`);
}
