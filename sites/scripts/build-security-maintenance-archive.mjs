import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const scriptPath = fileURLToPath(import.meta.url);
const siteRoot = path.resolve(path.dirname(scriptPath), "..");
const repoRoot = path.resolve(siteRoot, "..");
const archiveRoot = path.join(repoRoot, "archive");

export const BASE_ARCHIVE_NAME = "2026-07-31-ai-project-brief";
export const SECURITY_ARCHIVE_NAME = "2026-08-09-ai-project-brief-security-maintenance";
export const BASE_ARCHIVE_ROOT = path.join(archiveRoot, BASE_ARCHIVE_NAME);
export const SECURITY_ARCHIVE_ROOT = path.join(archiveRoot, SECURITY_ARCHIVE_NAME);
export const BASE_MANIFEST_PATH = path.join(archiveRoot, "archive-manifest.json");
export const SECURITY_MANIFEST_PATH = path.join(
  archiveRoot,
  `${SECURITY_ARCHIVE_NAME}.manifest.json`
);

const BASE_MANIFEST_SHA256 =
  "2329fd56c22b746f4575096cc5efd30c967f72e3ed7eda0356bc26d9228d5879";
const DOMPURIFY_FROM = "3.4.12";
const DOMPURIFY_TO = "3.4.13";
const MERMAID_FROM = "10.9.6";
const MERMAID_TO = "10.9.8";

export const ALLOWED_SECURITY_DIFFERENCES = Object.freeze([
  "ARCHITECTURE.md",
  "SECURITY-MAINTENANCE.md",
  "data/release.json",
  "index.html",
  "js/app.bundle.js",
  "js/app.offline.bundle.js",
  "js/bootstrap.js",
  "js/modules/html-policy.js",
  `vendor/dompurify-${DOMPURIFY_FROM}.es.mjs`,
  `vendor/dompurify-${DOMPURIFY_TO}.es.mjs`,
  `vendor/mermaid-${MERMAID_FROM}.min.js`,
  `vendor/mermaid-${MERMAID_TO}.min.js`,
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

async function walkFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
      else throw new Error(`归档中只允许普通文件和目录：${target}`);
    }
  }
  await visit(root);
  return files;
}

async function directoryReceipt(root) {
  const relativeFiles = (await walkFiles(root))
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .sort();
  const hashes = new Map();
  for (const relative of relativeFiles) {
    hashes.set(relative, sha256(await readFile(path.join(root, relative))));
  }
  const treeSha256 = sha256(
    relativeFiles.map((relative) => `${hashes.get(relative)}  ${relative}\n`).join("")
  );
  return { relativeFiles, hashes, treeSha256 };
}

function replaceExactly(text, before, after, label) {
  const occurrences = text.split(before).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${label} 预期命中 1 次，实际 ${occurrences} 次`);
  }
  return text.replace(before, after);
}

async function assertPackageVersion(packageName, expectedVersion) {
  const packagePath = path.join(siteRoot, "node_modules", packageName, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  if (packageJson.version !== expectedVersion) {
    throw new Error(
      `${packageName} node_modules 版本 ${packageJson.version} 与要求 ${expectedVersion} 不一致；请先执行 npm ci --ignore-scripts`
    );
  }
}

export async function assertBaseArchiveFrozen() {
  const manifestBytes = await readFile(BASE_MANIFEST_PATH);
  const manifestSha256 = sha256(manifestBytes);
  if (manifestSha256 !== BASE_MANIFEST_SHA256) {
    throw new Error(
      `旧 manifest 必须保持字节不动：${manifestSha256}/${BASE_MANIFEST_SHA256}`
    );
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const receipt = await directoryReceipt(BASE_ARCHIVE_ROOT);
  const entrySha256 = sha256(await readFile(path.join(BASE_ARCHIVE_ROOT, "index.html")));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.status !== "archived" ||
    manifest.fileCount !== receipt.relativeFiles.length ||
    manifest.treeSha256 !== receipt.treeSha256 ||
    manifest.entrySha256 !== entrySha256
  ) {
    throw new Error("2026-07-31 基础归档或旧 manifest 已发生变化，拒绝派生安全快照");
  }
  return { manifest, manifestSha256, ...receipt, entrySha256 };
}

async function patchSecurityRuntime(stagingRoot) {
  await Promise.all([
    assertPackageVersion("dompurify", DOMPURIFY_TO),
    assertPackageVersion("mermaid", MERMAID_TO),
  ]);

  const oldDomPurifyPath = path.join(
    stagingRoot,
    `vendor/dompurify-${DOMPURIFY_FROM}.es.mjs`
  );
  const newDomPurifyPath = path.join(
    stagingRoot,
    `vendor/dompurify-${DOMPURIFY_TO}.es.mjs`
  );
  const oldMermaidPath = path.join(stagingRoot, `vendor/mermaid-${MERMAID_FROM}.min.js`);
  const newMermaidPath = path.join(stagingRoot, `vendor/mermaid-${MERMAID_TO}.min.js`);
  const domPurifyBytes = await readFile(
    path.join(siteRoot, "node_modules/dompurify/dist/purify.es.mjs")
  );
  const mermaidBytes = await readFile(path.join(siteRoot, "node_modules/mermaid/dist/mermaid.min.js"));

  await Promise.all([
    rm(oldDomPurifyPath),
    rm(oldMermaidPath),
    writeFile(newDomPurifyPath, domPurifyBytes, { flag: "wx" }),
    writeFile(newMermaidPath, mermaidBytes, { flag: "wx" }),
  ]);

  const policyPath = path.join(stagingRoot, "js/modules/html-policy.js");
  const policy = replaceExactly(
    await readFile(policyPath, "utf8"),
    `../../vendor/dompurify-${DOMPURIFY_FROM}.es.mjs`,
    `../../vendor/dompurify-${DOMPURIFY_TO}.es.mjs`,
    "DOMPurify 运行时引用"
  );
  await writeFile(policyPath, policy, "utf8");

  const mermaidIntegrity = `sha384-${createHash("sha384").update(mermaidBytes).digest("base64")}`;
  const bootstrapPath = path.join(stagingRoot, "js/bootstrap.js");
  let bootstrap = await readFile(bootstrapPath, "utf8");
  bootstrap = replaceExactly(
    bootstrap,
    `mermaid-${MERMAID_FROM}.min.js`,
    `mermaid-${MERMAID_TO}.min.js`,
    "Mermaid 运行时引用"
  );
  bootstrap = bootstrap.replace(
    /const mermaidIntegrity =\n\s+"sha384-[A-Za-z0-9+/=]+";/,
    `const mermaidIntegrity =\n    "${mermaidIntegrity}";`
  );
  if (!bootstrap.includes(`"${mermaidIntegrity}"`)) {
    throw new Error("Mermaid SRI 未能确定性更新");
  }
  await writeFile(bootstrapPath, bootstrap, "utf8");

  const architecturePath = path.join(stagingRoot, "ARCHITECTURE.md");
  let architecture = await readFile(architecturePath, "utf8");
  architecture = replaceExactly(
    architecture,
    `- Mermaid 固定为 ${MERMAID_FROM} 并随站点发布，不依赖 CDN。`,
    `- Mermaid 固定为 ${MERMAID_TO} 并随站点发布，不依赖 CDN。`,
    "ARCHITECTURE Mermaid 版本说明"
  );
  architecture = replaceExactly(
    architecture,
    `- DOMPurify 固定为 ${DOMPURIFY_FROM}；远端 JSON、本机草稿、编辑器富文本和 Mermaid SVG 都在进入 DOM 前经过显式白名单。`,
    `- DOMPurify 固定为 ${DOMPURIFY_TO}；远端 JSON、本机草稿、编辑器富文本和 Mermaid SVG 都在进入 DOM 前经过显式白名单。`,
    "ARCHITECTURE DOMPurify 版本说明"
  );
  await writeFile(architecturePath, architecture, "utf8");

  const maintenanceNote = `# 2026-08-09 安全维护快照\n\n` +
    `> **性质：** 仅修复公开历史 Web 的第三方前端依赖，不改变 2026-07-31 的业务内容、状态、结论或审批记录。\n` +
    `> **派生基线：** \`${BASE_ARCHIVE_NAME}\`（旧目录与旧 manifest 保持字节不动）。\n\n` +
    `## 变更\n\n` +
    `- DOMPurify \`${DOMPURIFY_FROM}\` → \`${DOMPURIFY_TO}\`（GHSA-55q2-fjhq-7xh7）；\n` +
    `- Mermaid \`${MERMAID_FROM}\` → \`${MERMAID_TO}\`（GHSA-c4c3-pg64-4m4v、GHSA-6x64-9x62-f2gx、GHSA-2v8p-3f2j-5mp7）；\n` +
    `- 同步本地 vendor、DOMPurify import、Mermaid loader/SRI，以及由构建器生成的 Bundle、release.json 和 index 资源指纹。\n\n` +
    `## 不变边界\n\n` +
    `除上述安全白名单与本说明外，所有文件必须与基础归档逐字节一致。尤其 \`data/content.json\`、Schema、CSS、业务源 JS、许可证与素材不得变化。\n` +
    `本目录仍是历史展示快照，不是当前客服 Agent 项目或任何业务状态的真源。\n` +
    `\`ARCHITECTURE.md\` 只同步上述两项依赖版本，其余历史语义不变。\n`;
  await writeFile(path.join(stagingRoot, "SECURITY-MAINTENANCE.md"), maintenanceNote, {
    encoding: "utf8",
    flag: "wx",
  });
}

async function generateRuntimeArtifacts(stagingRoot) {
  const contentPath = path.join(stagingRoot, "data/content.json");
  const indexPath = path.join(stagingRoot, "index.html");
  const [contentText, currentIndex, cssText, bootstrapText, mermaidVendor, logoBytes] =
    await Promise.all([
      readFile(contentPath, "utf8"),
      readFile(indexPath, "utf8"),
      readFile(path.join(stagingRoot, "css/app.css"), "utf8"),
      readFile(path.join(stagingRoot, "js/bootstrap.js"), "utf8"),
      readFile(path.join(stagingRoot, `vendor/mermaid-${MERMAID_TO}.min.js`), "utf8"),
      readFile(path.join(stagingRoot, "assets/logo.png")),
    ]);
  const content = JSON.parse(contentText);
  const contentSha256 = sha256(contentText);

  const result = await build({
    absWorkingDir: stagingRoot,
    entryPoints: ["js/app.js"],
    outfile: "js/app.bundle.js",
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["chrome109", "safari16"],
    charset: "utf8",
    minify: true,
    legalComments: "none",
  });
  const httpGenerated = result.outputFiles[0].text;
  const indexTemplate = currentIndex
    .replace(
      /<html lang="zh-CN"(?: data-release="[^"]*")?>/,
      '<html lang="zh-CN" data-release="__RELEASE__">'
    )
    .replace(/href="\.\/css\/app\.css\?v=[^"]+"/, 'href="./css/app.css?v=__RELEASE__"')
    .replace(
      /src="\.\/js\/bootstrap\.js\?v=[^"]+"/,
      'src="./js/bootstrap.js?v=__RELEASE__"'
    );
  const releaseSourceSha256 = createHash("sha256")
    .update(httpGenerated)
    .update("\n/* runtime-asset-boundary */\n")
    .update(cssText)
    .update("\n/* runtime-asset-boundary */\n")
    .update(bootstrapText)
    .update("\n/* runtime-asset-boundary */\n")
    .update(indexTemplate)
    .update("\n/* runtime-asset-boundary */\n")
    .update(mermaidVendor)
    .update("\n/* runtime-asset-boundary */\n")
    .update(logoBytes)
    .digest("hex");
  const releaseId = `shell-v${content.decisionSchemaVersion}-${releaseSourceSha256.slice(0, 12)}`;
  const release = Object.freeze({
    schemaVersion: 1,
    releaseId,
    decisionSchemaVersion: content.decisionSchemaVersion,
    contentVersion: content.version,
    publishStamp: content.publishStamp,
    contentSha256,
    sourceSha256: releaseSourceSha256,
  });
  const releaseText = `${JSON.stringify(release, null, 2)}\n`;
  const expectedIndex = indexTemplate.replaceAll("__RELEASE__", releaseId);
  const banner = [
    "/* GENERATED FILE — source: docs/js/app.js + docs/data/content.json */",
    `globalThis.__AI_BRIEF_EMBEDDED_CONTENT__=${JSON.stringify(content)};`,
    `globalThis.__AI_BRIEF_OFFLINE_META__=Object.freeze(${JSON.stringify(release)});`,
  ].join("\n");
  const offlineGenerated = `${banner}\n${httpGenerated}`;

  await Promise.all([
    writeFile(path.join(stagingRoot, "js/app.bundle.js"), httpGenerated, "utf8"),
    writeFile(path.join(stagingRoot, "js/app.offline.bundle.js"), offlineGenerated, "utf8"),
    writeFile(path.join(stagingRoot, "data/release.json"), releaseText, "utf8"),
    writeFile(indexPath, expectedIndex, "utf8"),
  ]);
  return release;
}

export async function compareSecuritySnapshot(candidateRoot = SECURITY_ARCHIVE_ROOT) {
  const [base, candidate] = await Promise.all([
    directoryReceipt(BASE_ARCHIVE_ROOT),
    directoryReceipt(candidateRoot),
  ]);
  const paths = [...new Set([...base.relativeFiles, ...candidate.relativeFiles])].sort();
  const differences = paths.filter(
    (relative) => base.hashes.get(relative) !== candidate.hashes.get(relative)
  );
  const unexpected = differences.filter(
    (relative) => !ALLOWED_SECURITY_DIFFERENCES.includes(relative)
  );
  const missingExpected = ALLOWED_SECURITY_DIFFERENCES.filter(
    (relative) => !differences.includes(relative)
  );
  if (unexpected.length || missingExpected.length) {
    throw new Error(
      `安全快照越出变更白名单：unexpected=${unexpected.join(",") || "none"} · missing=${missingExpected.join(",") || "none"}`
    );
  }
  return { base, candidate, differences };
}

async function createExpectedSnapshot(stagingRoot) {
  await cp(BASE_ARCHIVE_ROOT, stagingRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  await patchSecurityRuntime(stagingRoot);
  const release = await generateRuntimeArtifacts(stagingRoot);
  const comparison = await compareSecuritySnapshot(stagingRoot);
  const contentSha256 = sha256(await readFile(path.join(stagingRoot, "data/content.json")));
  const entrySha256 = sha256(await readFile(path.join(stagingRoot, "index.html")));
  const manifest = Object.freeze({
    schemaVersion: 1,
    status: "archived-security-maintenance",
    snapshotDate: "2026-08-09",
    businessSnapshotDate: "2026-07-31",
    derivedFrom: BASE_ARCHIVE_NAME,
    derivedFromManifestSha256: BASE_MANIFEST_SHA256,
    maintenanceType: "security-only",
    releaseId: release.releaseId,
    contentVersion: release.contentVersion,
    publicUrl: "https://weiweity.github.io/tianyuan-ai-brief/",
    runtimeDependencies: {
      dompurify: DOMPURIFY_TO,
      mermaid: MERMAID_TO,
    },
    businessContentSha256: contentSha256,
    allowedDifferences: ALLOWED_SECURITY_DIFFERENCES,
    fileCount: comparison.candidate.relativeFiles.length,
    entrySha256,
    treeSha256: comparison.candidate.treeSha256,
  });
  return { manifest, comparison, release };
}

async function assertDirectoriesEqual(expectedRoot, actualRoot) {
  const [expected, actual] = await Promise.all([
    directoryReceipt(expectedRoot),
    directoryReceipt(actualRoot),
  ]);
  const paths = [...new Set([...expected.relativeFiles, ...actual.relativeFiles])].sort();
  const mismatches = paths.filter(
    (relative) => expected.hashes.get(relative) !== actual.hashes.get(relative)
  );
  if (mismatches.length) {
    throw new Error(`安全维护归档与确定性生成结果不一致：${mismatches.join("、")}`);
  }
  return actual;
}

export async function verifySecurityMaintenanceArchive() {
  await assertBaseArchiveFrozen();
  if (!(await pathExists(SECURITY_ARCHIVE_ROOT)) || !(await pathExists(SECURITY_MANIFEST_PATH))) {
    throw new Error("2026-08-09 安全维护归档或 manifest 缺失");
  }
  const stagingParent = await mkdtemp(path.join(tmpdir(), "ai-brief-security-check-"));
  const stagingRoot = path.join(stagingParent, SECURITY_ARCHIVE_NAME);
  try {
    const expected = await createExpectedSnapshot(stagingRoot);
    const actualReceipt = await assertDirectoriesEqual(stagingRoot, SECURITY_ARCHIVE_ROOT);
    const actualManifestText = await readFile(SECURITY_MANIFEST_PATH, "utf8");
    const expectedManifestText = `${JSON.stringify(expected.manifest, null, 2)}\n`;
    if (actualManifestText !== expectedManifestText) {
      throw new Error("安全维护 manifest 与确定性目录收据不一致");
    }
    await compareSecuritySnapshot();
    return { manifest: expected.manifest, receipt: actualReceipt };
  } finally {
    await rm(stagingParent, { recursive: true, force: true });
  }
}

export async function createSecurityMaintenanceArchive() {
  await assertBaseArchiveFrozen();
  if ((await pathExists(SECURITY_ARCHIVE_ROOT)) || (await pathExists(SECURITY_MANIFEST_PATH))) {
    throw new Error("安全维护归档已存在，拒绝覆盖；请使用 --check 验证");
  }
  const stagingParent = await mkdtemp(path.join(archiveRoot, ".security-maintenance-stage-"));
  const stagingRoot = path.join(stagingParent, SECURITY_ARCHIVE_NAME);
  const manifestStage = path.join(
    archiveRoot,
    `.${path.basename(SECURITY_MANIFEST_PATH)}.stage-${process.pid}`
  );
  let directoryPublished = false;
  try {
    const result = await createExpectedSnapshot(stagingRoot);
    await writeFile(manifestStage, `${JSON.stringify(result.manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(stagingRoot, SECURITY_ARCHIVE_ROOT);
    directoryPublished = true;
    try {
      await rename(manifestStage, SECURITY_MANIFEST_PATH);
    } catch (error) {
      await rename(SECURITY_ARCHIVE_ROOT, stagingRoot);
      directoryPublished = false;
      throw error;
    }
    return result;
  } finally {
    if (directoryPublished && !(await pathExists(SECURITY_MANIFEST_PATH))) {
      throw new Error("安全维护目录已生成但 manifest 未发布；拒绝继续");
    }
    await rm(manifestStage, { force: true });
    await rm(stagingParent, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--create", "--check"].includes(args[0])) {
    throw new Error("用法：node scripts/build-security-maintenance-archive.mjs --create|--check");
  }
  if (args[0] === "--create") {
    const result = await createSecurityMaintenanceArchive();
    console.log(
      `安全维护归档已生成 · ${result.manifest.fileCount} 文件 · release ${result.release.releaseId}`
    );
  } else {
    const result = await verifySecurityMaintenanceArchive();
    console.log(
      `安全维护归档已验证 · ${result.manifest.fileCount} 文件 · tree ${result.manifest.treeSha256.slice(0, 12)}`
    );
  }
}
