import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
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
const webRoot = path.resolve(path.dirname(scriptPath), "..");
const LOCAL_PRD_HREF = "../../business-docs/01-客服Agent项目/07-客服Agent立项PRD.html";
const LOCAL_HUB_HREF = "../../business-docs/01-客服Agent项目/08-客服Agent立项执行中心.html";
const INTERNAL_ONLY_HREF = "./internal-only.html";
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

async function populateArtifact({ stagingOutput, webDocsPath }) {
  const sourceRoot = path.resolve(webDocsPath);
  await cp(sourceRoot, stagingOutput, { recursive: true, force: false, errorOnExist: true });

  const stagedIndexPath = path.join(stagingOutput, "index.html");
  const stagedIndex = await readFile(stagedIndexPath, "utf8");
  if (!stagedIndex.includes(LOCAL_PRD_HREF) || !stagedIndex.includes(LOCAL_HUB_HREF)) {
    throw new Error("历史页缺少两个仓库内现行材料入口，无法生成公开投影");
  }
  await writeFile(
    stagedIndexPath,
    stagedIndex.replaceAll(LOCAL_PRD_HREF, INTERNAL_ONLY_HREF).replaceAll(LOCAL_HUB_HREF, INTERNAL_ONLY_HREF),
    "utf8"
  );
  await writeFile(path.join(stagingOutput, "internal-only.html"), INTERNAL_ONLY_PAGE, "utf8");

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
  outputPath = path.join(webRoot, "dist/pages"),
  webDocsPath = path.join(webRoot, "docs"),
  replaceExisting = false,
} = {}) {
  const output = path.resolve(outputPath);
  const canonicalBuildOutput = path.join(webRoot, "dist/pages");
  const outputExists = await pathExists(output);
  if (replaceExisting) {
    await assertSafeReplaceTarget({
      outputPath: output,
      canonicalOutputPath: canonicalBuildOutput,
      trustedRoot: webRoot,
    });
  } else if (outputExists) {
    throw eexistError(output);
  }

  await mkdir(path.dirname(output), { recursive: true });
  const stagingParent = await mkdtemp(path.join(path.dirname(output), `.${path.basename(output)}.stage-`));
  const stagingOutput = path.join(stagingParent, "artifact");
  try {
    const files = await populateArtifact({ stagingOutput, webDocsPath });
    if (replaceExisting) {
      await assertSafeReplaceTarget({
        outputPath: output,
        canonicalOutputPath: canonicalBuildOutput,
        trustedRoot: webRoot,
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
