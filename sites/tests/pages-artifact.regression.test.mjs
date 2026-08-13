import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertArchivedSiteFrozen,
  assertSafeReplaceTarget,
  stagePagesArtifact,
  validateArtifactLinks,
} from "../scripts/build-pages-artifact.mjs";
import {
  BASE_ARCHIVE_ROOT,
  BASE_MANIFEST_PATH,
  SECURITY_ARCHIVE_ROOT,
} from "../scripts/build-security-maintenance-archive.mjs";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(siteRoot, "..");
const archiveRoot = SECURITY_ARCHIVE_ROOT;
const privateProjectRoot = path.join(repoRoot, "business-docs/01-客服Agent项目");
const privateProjectFiles = [
  "README.md",
  "00-项目章程.md",
  "01-总排期与阶段门禁.md",
  "02-G0责任与证据台账.md",
  "03-Scope与验收.md",
  "04-费用与成本控制.md",
  "05-全栈交付计划.md",
  "06-启动会与周推进.md",
  "07-客服Agent立项PRD.html",
  "07-客服Agent立项PRD.sources.json",
  "08-客服Agent立项执行中心.html",
  "09-客服Agent需求会汇报.html",
  "assets/brand/logo.png",
  "assets/brand/favicon.png",
  "assets/brand/apple-touch-icon.png",
];

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

async function publicText(artifactRoot) {
  const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".mjs", ".txt"]);
  const contents = [];
  for (const file of await walkFiles(artifactRoot)) {
    if (textExtensions.has(path.extname(file).toLowerCase())) contents.push(await readFile(file, "utf8"));
  }
  return contents.join("\n");
}

test("Pages artifact 发布历史 Web 与脱敏启动会，PRD / Hub 仍降级", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pages-artifact-"));
  const outputPath = path.join(parent, "pages");
  await stagePagesArtifact({ outputPath });

  const index = await readFile(path.join(outputPath, "index.html"), "utf8");
  assert.doesNotMatch(index, /business-docs|current\/customer-agent/);
  assert.equal((index.match(/href="\.\/internal-only\.html"/g) || []).length, 2);
  assert.equal((index.match(/href="\.\/customer-agent\/"/g) || []).length, 1);

  const internalOnly = await readFile(path.join(outputPath, "internal-only.html"), "utf8");
  assert.match(internalOnly, /现行材料仅授权内部访问/);
  assert.match(internalOnly, /本地仓库路径不会在此公开/);
  assert.doesNotMatch(internalOnly, /business-docs|客服Agent立项PRD|客服Agent立项执行中心|客服Agent需求会汇报|meeting-v1-/);
  const publicMeeting = await readFile(path.join(outputPath, "customer-agent/index.html"), "utf8");
  assert.match(publicMeeting, /GENERATED FILE — safe meeting view; DO NOT EDIT/);
  assert.match(publicMeeting, /data-release="meeting-v1-[a-f0-9]{12}"/);
  assert.match(publicMeeting, /<title>天元 · 客服 Agent 一期启动会<\/title>/);
  assert.match(publicMeeting, /<link rel="icon" href="data:image\/png;base64,/);
  assert.match(publicMeeting, /<img class="brand-logo" src="data:image\/png;base64,[^"]+" alt="SHINE MAGE">/);
  assert.doesNotMatch(
    publicMeeting,
    /\bbusiness-docs\b|\bsources\b|portablePrd|\bG0(?:-|\b)|\bRACI\b|\b(?:EVD|ROLE|USR)[-_]|费用|风险/i
  );
  await assert.rejects(stat(path.join(outputPath, "current/customer-agent")), { code: "ENOENT" });

  await validateArtifactLinks(outputPath);
  const artifactText = await publicText(outputPath);
  assert.doesNotMatch(artifactText, /business-docs|current\/customer-agent/);
  assert.match(artifactText, /客服 Agent 一期启动会|meeting-v1-/);
  for (const name of privateProjectFiles.filter((name) => name !== "09-客服Agent需求会汇报.html")) {
    assert.doesNotMatch(artifactText, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const privateHashes = await Promise.all(privateProjectFiles.map(async (name) => {
    const source = await readFile(path.join(privateProjectRoot, name));
    return createHash("sha256").update(source).digest("hex");
  }));
  for (const privateHash of privateHashes) assert.equal(artifactText.includes(privateHash), false);

  const manifest = JSON.parse(await readFile(path.join(outputPath, "artifact-manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest), ["schemaVersion", "visibility", "files"]);
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.visibility, "public");
  assert.ok(manifest.files.includes("internal-only.html"));
  assert.ok(manifest.files.includes("index.html"));
  assert.ok(manifest.files.includes("customer-agent/index.html"));
  assert.equal(manifest.files.some((file) => file.startsWith("current/") || file.includes("business-docs")), false);
  assert.doesNotMatch(JSON.stringify(manifest), /sha256|sourceSha|[a-f\d]{64}/i);
});

test("7 月 31 日历史站点与归档清单完全一致", async () => {
  const result = await assertArchivedSiteFrozen({
    archiveSitePath: BASE_ARCHIVE_ROOT,
    manifestPath: BASE_MANIFEST_PATH,
  });
  assert.equal(result.files.length, 29);
  assert.equal(result.entrySha256, "2cabb4ffdf323d4668d4dc9932080b0662c2d7137aed16e3aaa4779c7831f720");
  assert.equal(result.treeSha256, "b6a18b2ef16b335f0f9224e776b6a36299be5fb73fbbe7330ddb188282cef418");
});

test("Pages 默认发布 8 月 9 日安全维护快照", async () => {
  const result = await assertArchivedSiteFrozen();
  assert.equal(result.files.length, 30);
  assert.equal(result.entrySha256, "3054840a85e506341c4229b7fbb9cc814756ef86b49ab97e53ff6db7aecc2a43");
  assert.equal(result.treeSha256, "f3183f1cc9a2a5fbf881c962ef2ecfd0af73cc7ea77842b2797b2da199d555a2");
});

test("发布副本降级指向仓库外的 Markdown 链接，保留公开 Web 内部链接", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pages-artifact-markdown-"));
  const docs = path.join(parent, "docs");
  const outputPath = path.join(parent, "pages");
  await mkdir(docs);
  await writeFile(
    path.join(docs, "index.html"),
    '<a href="../../business-docs/01-客服Agent项目/07-客服Agent立项PRD.html">A</a><a href="../../business-docs/01-客服Agent项目/08-客服Agent立项执行中心.html">B</a><a href="../../business-docs/01-客服Agent项目/09-客服Agent需求会汇报.html">C</a>'
  );
  await writeFile(path.join(docs, "public.md"), "[公开入口](./index.html)\n[内部材料](../../business-docs/private.md)\n");
  await stagePagesArtifact({ outputPath, archiveSitePath: docs });

  const markdown = await readFile(path.join(outputPath, "public.md"), "utf8");
  assert.match(markdown, /\[公开入口\]\(\.\/index\.html\)/);
  assert.match(markdown, /内部资料（仅授权内部访问；公开版不提供）/);
  assert.doesNotMatch(markdown, /business-docs|private\.md/);
  await validateArtifactLinks(outputPath);
});

test("链接校验剥离 query 与 fragment，并递归检查 HTML / Markdown", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pages-artifact-links-"));
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "target.html"), "<!doctype html><title>target</title>");
  await writeFile(path.join(root, "nested/query.html"), '<a href="../target.html?from=html#section">target</a>');
  await writeFile(path.join(root, "nested/query.md"), "[target](../target.html?from=markdown#section)\n[section](#local)\n");
  await validateArtifactLinks(root);

  await writeFile(path.join(root, "nested/broken.md"), "[missing](../missing.html?query=1#fragment)\n");
  await assert.rejects(validateArtifactLinks(root), /missing\.html\?query=1#fragment（目标不存在）/);
});

test("源码历史页保留本地 PRD / Hub / Meeting 入口，仅发布副本改写", async () => {
  const sourceIndex = await readFile(path.join(archiveRoot, "index.html"), "utf8");
  assert.match(sourceIndex, /\.\.\/\.\.\/business-docs\/01-客服Agent项目\/07-客服Agent立项PRD\.html/);
  assert.match(sourceIndex, /\.\.\/\.\.\/business-docs\/01-客服Agent项目\/08-客服Agent立项执行中心\.html/);
  assert.match(sourceIndex, /\.\.\/\.\.\/business-docs\/01-客服Agent项目\/09-客服Agent需求会汇报\.html/);
});

test("Pages staging 对现存自定义目录和文件明确返回 EEXIST 且不覆盖", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pages-artifact-existing-"));
  const existingDirectory = path.join(parent, "directory");
  await mkdir(existingDirectory);
  await writeFile(path.join(existingDirectory, "sentinel.txt"), "keep-directory");
  await assert.rejects(stagePagesArtifact({ outputPath: existingDirectory }), { code: "EEXIST" });
  assert.equal(await readFile(path.join(existingDirectory, "sentinel.txt"), "utf8"), "keep-directory");

  const existingFile = path.join(parent, "file");
  await writeFile(existingFile, "keep-file");
  await assert.rejects(stagePagesArtifact({ outputPath: existingFile }), { code: "EEXIST" });
  assert.equal(await readFile(existingFile, "utf8"), "keep-file");
});

test("canonical replace 遇到 dist symlink 时拒绝，仓库外目录不删除也不写入", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pages-artifact-symlink-"));
  const fakeWebRoot = path.join(parent, "web");
  const external = path.join(parent, "external");
  await mkdir(fakeWebRoot);
  await mkdir(external);
  await writeFile(path.join(external, "sentinel.txt"), "keep-external");
  await symlink(external, path.join(fakeWebRoot, "dist"), "dir");
  const output = path.join(fakeWebRoot, "dist/pages");

  await assert.rejects(
    assertSafeReplaceTarget({ outputPath: output, canonicalOutputPath: output, trustedRoot: fakeWebRoot }),
    /符号链接/
  );
  assert.equal(await readFile(path.join(external, "sentinel.txt"), "utf8"), "keep-external");
  await assert.rejects(stat(path.join(external, "pages")), { code: "ENOENT" });
});

test("Pages 由任一归档、发布工具或脱敏 09 触发，不上传客服证据且 Action 固定提交", async () => {
  const workflow = await readFile(path.join(repoRoot, ".github/workflows/pages.yml"), "utf8");
  assert.match(workflow, /archive\/\*\*/);
  assert.match(workflow, /sites\/\*\*/);
  assert.match(workflow, /business-docs\/01-客服Agent项目\/09-客服Agent需求会汇报\.html/);
  assert.doesNotMatch(workflow, /customer-agent-(?:prd|hub|meeting)-qa|Upload quality evidence/);
  assert.match(workflow, /actions\/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa/);
  assert.match(workflow, /actions\/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e/);
  assert.match(workflow, /path:\s*sites\/dist\/pages/);
});
