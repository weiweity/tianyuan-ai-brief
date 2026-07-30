import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import Ajv from "ajv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

test("content.json 通过结构 Schema", async () => {
  const [schemaText, contentText] = await Promise.all([
    read("docs/data/content.schema.json"),
    read("docs/data/content.json"),
  ]);
  const schema = JSON.parse(schemaText);
  const content = JSON.parse(contentText);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  assert.equal(validate(content), true, JSON.stringify(validate.errors, null, 2));
});

test("七页信息架构、区块 ID 与项目级决策键唯一", async () => {
  const content = JSON.parse(await read("docs/data/content.json"));
  assert.equal(content.version, "5.24.0");
  assert.equal(content.decisionSchemaVersion, 2);
  assert.equal(content.tabs.length, 7);
  assert.deepEqual(
    content.tabs.map((tab) => tab.id),
    ["t1", "t2", "t3", "t4", "t5", "t6", "t7"]
  );

  const blockIds = content.tabs.flatMap((tab) => tab.blocks.map((block) => block.id));
  assert.equal(new Set(blockIds).size, blockIds.length);

  const t6 = content.tabs.find((tab) => tab.id === "t6");
  const check = t6.blocks.find((block) => block.type === "check-table");
  const rowIds = check.rows.map((row) => row.rowId);
  assert.equal(new Set(rowIds).size, rowIds.length);

  const projectRows = check.rows.filter((row) => row.projectId && row.pathOptions);
  assert.deepEqual(
    projectRows.map((row) => row.projectId),
    ["agent", "filing"]
  );
  projectRows.forEach((row) => assert.deepEqual(row.pathOptions, ["A", "B", "C"]));

  const ownerProjects = check.rows
    .filter((row) => row.kind === "owner")
    .map((row) => row.projectId);
  assert.deepEqual(ownerProjects, ["agent", "filing"]);
  assert.equal(check.rows.filter((row) => row.kind === "fee").length, 1);
  assert.equal(check.rows.filter((row) => row.kind === "stop-authority").length, 1);
});

test("核心隐性知识与反误导边界存在且无旧版统一路径", async () => {
  const text = await read("docs/data/content.json");
  for (const term of [
    "未批不开发",
    "人在环",
    "客服 Agent",
    "供应链备案识别",
    "7000",
    "5000",
    "10000",
    "立即停扩",
    "飞书/邮件",
  ]) {
    assert.match(text, new RegExp(term.replace("/", "\\/")));
  }
  assert.doesNotMatch(text, /对已选项目统一选路径/);
  assert.doesNotMatch(text, /如两项路径不同，请分两次记录/);
});

test("正式入口自包含、依赖固定、发布指纹一致且启用 CSP", async () => {
  const [
    index,
    app,
    policy,
    bootstrap,
    mermaidVendor,
    httpBundle,
    offlineBundle,
    buildScript,
    contentText,
    releaseText,
    css,
    logoBytes,
  ] =
    await Promise.all([
      read("docs/index.html"),
      read("docs/js/app.js"),
      read("docs/js/modules/html-policy.js"),
      read("docs/js/bootstrap.js"),
      read("docs/vendor/mermaid-10.9.6.min.js"),
      read("docs/js/app.bundle.js"),
      read("docs/js/app.offline.bundle.js"),
      read("scripts/build-web.mjs"),
      read("docs/data/content.json"),
      read("docs/data/release.json"),
      read("docs/css/app.css"),
      readFile(path.join(root, "docs/assets/logo.png")),
    ]);
  const release = JSON.parse(releaseText);
  assert.match(index, /Content-Security-Policy/);
  assert.match(index, new RegExp(`<html lang="zh-CN" data-release="${release.releaseId}"`));
  assert.match(
    index,
    new RegExp(`href="\\.\\/css\\/app\\.css\\?v=${release.releaseId.replaceAll(".", "\\.")}"`)
  );
  assert.match(
    index,
    new RegExp(`src="\\.\\/js\\/bootstrap\\.js\\?v=${release.releaseId.replaceAll(".", "\\.")}"`)
  );
  assert.doesNotMatch(index, /<script type="module"/);
  assert.doesNotMatch(index, /https:\/\/cdn\.jsdelivr\.net/);
  assert.doesNotMatch(index, /unsafe-eval/);
  assert.match(app, /sanitizeContent/);
  assert.match(app, /sanitizeRichHtml/);
  assert.match(app, /createContentLoader/);
  assert.match(app, /isFileProtocol/);
  assert.match(policy, /dompurify-3\.4\.12\.es\.mjs/);
  assert.match(bootstrap, /location\.protocol === "file:"/);
  assert.match(bootstrap, /app\.offline\.bundle\.js\?v=\$\{encodeURIComponent\(releaseId\)\}/);
  assert.match(bootstrap, /app\.bundle\.js\?v=\$\{encodeURIComponent\(releaseId\)\}/);
  assert.doesNotMatch(bootstrap, /app\.type\s*=\s*"module"/);
  assert.match(bootstrap, /__AI_BRIEF_LOAD_MERMAID__/);
  assert.match(bootstrap, /mermaid-10\.9\.6\.min\.js/);
  assert.match(bootstrap, /sha384-qX9VvWkP79m/);
  assert.equal(
    createHash("sha384").update(mermaidVendor).digest("base64"),
    "qX9VvWkP79m/O121ZE6sOYp0nf/pldQgtvWDbkpzi+3mUo4Wn4Ix4cFzNPay3VaB"
  );
  assert.match(offlineBundle, /GENERATED FILE/);
  assert.match(offlineBundle, /__AI_BRIEF_EMBEDDED_CONTENT__/);
  assert.match(offlineBundle, /__AI_BRIEF_OFFLINE_META__/);
  assert.match(offlineBundle, new RegExp(release.releaseId.replaceAll(".", "\\.")));
  assert.doesNotMatch(httpBundle, /^\/\* GENERATED FILE/);
  assert.match(httpBundle, /tianyuan-brief-content-lkg-v1/);
  assert.doesNotMatch(httpBundle, /\bimport\s+[^("]/);
  assert.match(buildScript, /contentSha256/);
  assert.match(buildScript, /releaseSourceSha256/);
  assert.equal(
    release.contentSha256,
    createHash("sha256").update(contentText).digest("hex"),
    "release.json 必须绑定 content.json 精确字节"
  );
  const indexTemplate = index
    .replace(
      /<html lang="zh-CN"(?: data-release="[^"]*")?>/,
      '<html lang="zh-CN" data-release="__RELEASE__">'
    )
    .replace(/href="\.\/css\/app\.css\?v=[^"]+"/, 'href="./css/app.css?v=__RELEASE__"')
    .replace(
      /src="\.\/js\/bootstrap\.js\?v=[^"]+"/,
      'src="./js/bootstrap.js?v=__RELEASE__"'
    );
  const shellSha = createHash("sha256")
    .update(httpBundle)
    .update("\n/* runtime-asset-boundary */\n")
    .update(css)
    .update("\n/* runtime-asset-boundary */\n")
    .update(bootstrap)
    .update("\n/* runtime-asset-boundary */\n")
    .update(indexTemplate)
    .update("\n/* runtime-asset-boundary */\n")
    .update(mermaidVendor)
    .update("\n/* runtime-asset-boundary */\n")
    .update(logoBytes)
    .digest("hex");
  assert.equal(release.sourceSha256, shellSha, "release 必须绑定真实 HTTP 运行时字节");
  assert.equal(
    release.releaseId,
    `shell-v${release.decisionSchemaVersion}-${shellSha.slice(0, 12)}`
  );
});

test("CSS 是单一分层契约，不再加载尾部版本补丁", async () => {
  const [index, css] = await Promise.all([read("docs/index.html"), read("docs/css/app.css")]);
  const lines = css.split("\n").length;
  assert.ok(lines < 4500, `app.css 行数过高：${lines}`);
  assert.match(css, /UI contract v2/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /@media \(max-width: 640px\) and \(max-height: 700px\)/);
  assert.match(css, /@media \(min-width: 1025px\) and \(max-height: 800px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(index, /app\.legacy\.css/);
});

test("高风险前端能力保持独立模块且主控制器受体积门禁约束", async () => {
  const [
    app,
    decisionModel,
    meetingState,
    htmlPolicy,
    mermaidRuntime,
    contentLoader,
    domPurifyVendor,
  ] =
    await Promise.all([
      read("docs/js/app.js"),
      read("docs/js/modules/decision-model.js"),
      read("docs/js/modules/meeting-state.js"),
      read("docs/js/modules/html-policy.js"),
      read("docs/js/modules/mermaid-runtime.js"),
      read("docs/js/modules/content-loader.js"),
      read("docs/vendor/dompurify-3.4.12.es.mjs"),
    ]);

  assert.ok(app.split("\n").length < 2700, "app.js 应只负责 UI 编排");
  for (const modulePath of [
    "./modules/decision-model.js",
    "./modules/meeting-state.js",
    "./modules/html-policy.js",
    "./modules/content-loader.js",
    "./modules/mermaid-runtime.js",
  ]) {
    assert.match(app, new RegExp(modulePath.replaceAll(".", "\\.")));
  }
  assert.match(decisionModel, /export function evaluateCheckGate/);
  assert.match(meetingState, /export function mergeMeetingState/);
  assert.match(htmlPolicy, /export function createHtmlPolicy/);
  assert.match(mermaidRuntime, /export function createMermaidRuntime/);
  assert.match(mermaidRuntime, /sanitizeSvg\(svg\)/);
  assert.match(contentLoader, /export function createContentLoader/);
  assert.match(contentLoader, /contentSha256/);
  assert.doesNotMatch(app, /function wireMermaidLightbox/);
  assert.match(domPurifyVendor, /DOMPurify/);
});

test("历史打印入口是无业务副本的单一入口跳转", async () => {
  const legacy = await read("01-立项主线/print/AI赋能立项_金主一页汇报.html");
  assert.match(legacy, /旧版打印入口已合并/);
  assert.match(legacy, /http-equiv="refresh"/);
  assert.match(legacy, /\.\.\/\.\.\/docs\/index\.html\?from=legacy-print/);
  assert.match(legacy, /rel="canonical"/);
  assert.match(legacy, /rel="icon" href="\.\.\/\.\.\/docs\/assets\/favicon\.png"/);
  assert.match(legacy, /robots" content="noindex"/);
  assert.doesNotMatch(legacy, /mermaid/);
  assert.doesNotMatch(legacy, /<script/);
  assert.doesNotMatch(legacy, /A\/B=立|月 API cap|客服业务 Owner/);
});
