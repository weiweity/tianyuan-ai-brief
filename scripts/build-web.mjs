import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentPath = path.join(root, "docs/data/content.json");
const outputPath = path.join(root, "docs/js/app.offline.bundle.js");
const checkOnly = process.argv.includes("--check");

const contentText = await readFile(contentPath, "utf8");
const content = JSON.parse(contentText);
const contentSha256 = createHash("sha256").update(contentText).digest("hex");
const banner = [
  "/* GENERATED FILE — source: docs/js/app.js + docs/data/content.json */",
  `globalThis.__AI_BRIEF_EMBEDDED_CONTENT__=${JSON.stringify(content)};`,
  `globalThis.__AI_BRIEF_OFFLINE_META__=Object.freeze(${JSON.stringify({
    contentVersion: content.version,
    publishStamp: content.publishStamp,
    contentSha256,
  })});`,
].join("\n");

const result = await build({
  absWorkingDir: root,
  entryPoints: ["docs/js/app.js"],
  outfile: "docs/js/app.offline.bundle.js",
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: ["chrome109", "safari16"],
  charset: "utf8",
  minify: true,
  legalComments: "none",
  banner: { js: banner },
});

const generated = result.outputFiles[0].text;
if (checkOnly) {
  let current = "";
  try {
    current = await readFile(outputPath, "utf8");
  } catch {}
  if (current !== generated) {
    console.error("离线 Bundle 已过期：请执行 npm run build:web 并提交生成物");
    process.exitCode = 1;
  } else {
    console.log(`离线 Bundle 已同步 · content sha256 ${contentSha256.slice(0, 12)}`);
  }
} else {
  await writeFile(outputPath, generated, "utf8");
  console.log(
    `已生成 ${path.relative(root, outputPath)} · ${generated.length} bytes · content sha256 ${contentSha256.slice(0, 12)}`
  );
}
