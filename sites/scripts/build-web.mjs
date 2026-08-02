import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archiveRoot = path.resolve(siteRoot, "../archive/2026-07-31-ai-project-brief");
const contentPath = path.join(archiveRoot, "data/content.json");
const httpOutputPath = path.join(archiveRoot, "js/app.bundle.js");
const offlineOutputPath = path.join(archiveRoot, "js/app.offline.bundle.js");
const releasePath = path.join(archiveRoot, "data/release.json");
const indexPath = path.join(archiveRoot, "index.html");
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== "--check") {
  throw new Error(
    "7 月 31 日站点已冻结；本脚本只允许 --check，不得原地重新生成。需要修改时请建立新的日期归档。"
  );
}

const [contentText, currentIndex, cssText, bootstrapText, mermaidVendor, logoBytes] =
  await Promise.all([
    readFile(contentPath, "utf8"),
    readFile(indexPath, "utf8"),
    readFile(path.join(archiveRoot, "css/app.css"), "utf8"),
    readFile(path.join(archiveRoot, "js/bootstrap.js"), "utf8"),
    readFile(path.join(archiveRoot, "vendor/mermaid-10.9.6.min.js"), "utf8"),
    readFile(path.join(archiveRoot, "assets/logo.png")),
  ]);
const content = JSON.parse(contentText);
const contentSha256 = createHash("sha256").update(contentText).digest("hex");

const result = await build({
  absWorkingDir: archiveRoot,
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
let currentHttpBundle = "";
let currentOfflineBundle = "";
let currentRelease = "";
try {
  currentHttpBundle = await readFile(httpOutputPath, "utf8");
} catch {}
try {
  currentOfflineBundle = await readFile(offlineOutputPath, "utf8");
} catch {}
try {
  currentRelease = await readFile(releasePath, "utf8");
} catch {}
const stale = [];
if (currentHttpBundle !== httpGenerated) stale.push("HTTP Bundle");
if (currentOfflineBundle !== offlineGenerated) stale.push("离线 Bundle");
if (currentRelease !== releaseText) stale.push("release.json");
if (currentIndex !== expectedIndex) stale.push("index.html 资源版本");
if (stale.length) {
  console.error(
    `${stale.join("、")} 与冻结基线不一致：请从归档清单记录的源提交恢复，或建立新的日期归档；禁止原地重建。`
  );
  process.exitCode = 1;
} else {
  console.log(
    `归档 Web 已验证 · release ${releaseId} · content sha256 ${contentSha256.slice(0, 12)}`
  );
}
