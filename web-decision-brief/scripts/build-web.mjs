import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentPath = path.join(root, "docs/data/content.json");
const httpOutputPath = path.join(root, "docs/js/app.bundle.js");
const offlineOutputPath = path.join(root, "docs/js/app.offline.bundle.js");
const releasePath = path.join(root, "docs/data/release.json");
const indexPath = path.join(root, "docs/index.html");
const checkOnly = process.argv.includes("--check");

const [contentText, currentIndex, cssText, bootstrapText, mermaidVendor, logoBytes] =
  await Promise.all([
    readFile(contentPath, "utf8"),
    readFile(indexPath, "utf8"),
    readFile(path.join(root, "docs/css/app.css"), "utf8"),
    readFile(path.join(root, "docs/js/bootstrap.js"), "utf8"),
    readFile(path.join(root, "docs/vendor/mermaid-10.9.6.min.js"), "utf8"),
    readFile(path.join(root, "docs/assets/logo.png")),
  ]);
const content = JSON.parse(contentText);
const contentSha256 = createHash("sha256").update(contentText).digest("hex");

const result = await build({
  absWorkingDir: root,
  entryPoints: ["docs/js/app.js"],
  outfile: "docs/js/app.bundle.js",
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
if (checkOnly) {
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
    console.error(`${stale.join("、")} 已过期：请执行 npm run build:web 并提交生成物`);
    process.exitCode = 1;
  } else {
    console.log(
      `Web 产物已同步 · release ${releaseId} · content sha256 ${contentSha256.slice(0, 12)}`
    );
  }
} else {
  await Promise.all([
    writeFile(httpOutputPath, httpGenerated, "utf8"),
    writeFile(offlineOutputPath, offlineGenerated, "utf8"),
    writeFile(releasePath, releaseText, "utf8"),
    writeFile(indexPath, expectedIndex, "utf8"),
  ]);
  console.log(
    `已生成 Web 产物 · release ${releaseId} · HTTP Bundle ${httpGenerated.length} bytes · 离线 Bundle ${offlineGenerated.length} bytes · content sha256 ${contentSha256.slice(0, 12)}`
  );
}
