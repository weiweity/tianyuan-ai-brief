import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { loadCustomerProjectSources } from "../../business-docs/08-工具/customer_project_surface_io.mjs";
import { buildCustomerProjectSurfaceModel } from "../../business-docs/08-工具/customer_project_surface_model.mjs";

import {
  buildArchitectureProvenance,
  parseArchitectureProvenance,
  reconcileRenderedSvg,
  sha256,
  upsertArchitectureProvenance,
} from "./architecture-diagram-provenance.mjs";
import { replaceEmbeddedSvg } from "./architecture-diagram-embedding.mjs";
import { architectureDiagrams } from "./customer-agent-architecture-diagrams.manifest.mjs";

const sitesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(sitesDir, "..");
const designDir = path.join(
  repoRoot,
  "business-docs",
  "01-客服Agent项目",
  "20-设计-进行中"
);
const diagramDir = path.join(designDir, "diagrams");
const svgDir = path.join(diagramDir, "svg");
const boardPath = path.join(designDir, "架构图-PlantUML浏览器.html");
const coreDir = path.join(sitesDir, "node_modules", "@plantuml", "core");
const checkOnly = process.argv.includes("--check");

function replaceUnique(value, pattern, replacement, label) {
  assert.equal(pattern.global, true, `${label}替换表达式必须使用 global`);
  const matches = [...value.matchAll(pattern)];
  assert.equal(matches.length, 1, `${label}必须且只能命中 1 处，当前 ${matches.length} 处`);
  return value.replace(pattern, replacement);
}

function readDevelopmentShell(projectStatus) {
  const progress = projectStatus.developmentProgress;
  assert.ok(progress && typeof progress === "object", "项目状态缺少结构化产品开发进度");
  if (progress.category === "active") {
    const completed = progress.completedSlices.join("、");
    return {
      category: progress.category,
      gateClass: "partial",
      codeStatus: `${progress.milestone} · 进行中（${completed} 已完成）`,
      currentSummary: `${progress.milestone} 已进入开发中，${completed} 已完成；下一切片为 ${progress.nextSlice} ${progress.nextSliceName}。`,
      footerStatus: `${progress.milestone} · IN_PROGRESS，${completed} 已完成、${progress.nextSlice} ${progress.nextSliceName} 待执行`,
    };
  }
  if (progress.category === "completed") {
    return {
      category: progress.category,
      gateClass: "pass",
      codeStatus: `代码开发 · ${progress.state}`,
      currentSummary: `${progress.detail || "当前开发切片已完成"}；下一里程碑仍须独立决定。`,
      footerStatus: `产品开发${progress.state}，下一里程碑未自动放行`,
    };
  }
  if (["paused", "stopped"].includes(progress.category)) {
    return {
      category: progress.category,
      gateClass: "partial",
      codeStatus: `代码开发 · ${progress.state}`,
      currentSummary: `${progress.detail || `产品开发${progress.state}`}；历史 Ddev 不自动恢复开发。`,
      footerStatus: `产品开发${progress.state}，只允许复核恢复 / 终止条件`,
    };
  }
  return {
    category: progress.category,
    gateClass: "todo",
    codeStatus: projectStatus.ddevReady ? "Ddev 已授权 · 代码开发未开始" : "代码开发未开始",
    currentSummary: progress.detail || "代码开发未开始。",
    footerStatus: "代码开发未开始",
  };
}

function readAuthorizationShell(projectStatus) {
  const g0 = projectStatus.g0Ready
    ? `G0=PASS（${projectStatus.g0Evidence}）`
    : `G0=${projectStatus.g0}`;
  const ddev = projectStatus.ddevReady
    ? `Ddev=PASS（${projectStatus.ddevEvidence}）`
    : `Ddev=${projectStatus.ddev}`;
  const counts = `外部责任包 ${projectStatus.externalPass}/${projectStatus.externalTotal}、Scope ${projectStatus.scopePass}/${projectStatus.scopeTotal}`;
  return {
    passed: projectStatus.g0Ready && projectStatus.ddevReady,
    gateClass: projectStatus.ddevReady ? "pass" : projectStatus.g0Ready ? "partial" : "todo",
    value: projectStatus.ddevReady ? "G0 / Ddev Pass" : projectStatus.g0Ready ? "G0 Pass / 待 Ddev" : "G0 / Ddev 未完成",
    summary: `${counts}；${g0}，${ddev}${projectStatus.ddevReady ? "；只即时放行 DEV-M0" : ""}`,
  };
}

function synchronizeBoardStatusShell(board, projectStatus) {
  const development = readDevelopmentShell(projectStatus);
  const authorization = readAuthorizationShell(projectStatus);
  const currentGate = projectStatus.ddevReady ? "第 4 关代码开发" : "第 3→4 关组织授权门";
  const currentSummary = `${authorization.summary}；${development.currentSummary}${projectStatus.ddevReady ? "DEV-M1、真实数据、飞书运行接入、Pilot 与生产仍未放行。" : ""}`;

  const developmentSpan = `<span class="gate ${development.gateClass}" data-current-development>代码开发：${development.codeStatus}</span>`;
  if (/data-current-development/.test(board)) {
    board = replaceUnique(
      board,
      /<span class="gate (?:pass|partial|todo)" data-current-development>[\s\S]*?<\/span>/g,
      developmentSpan,
      "顶部产品开发状态"
    );
  } else {
    board = replaceUnique(
      board,
      /(<span class="next">)/g,
      `${developmentSpan}\n      $1`,
      "顶部产品开发状态插入点"
    );
  }
  board = replaceUnique(
    board,
    /<span class="next">[\s\S]*?<\/span>/g,
    `<span class="next">当前推进项：${currentGate}；${currentSummary}</span>`,
    "顶部当前推进项"
  );
  board = replaceUnique(
    board,
    /<div class="cv-card" role="listitem"><div class="k">组织门禁<\/div><div class="v">[\s\S]*?<\/div><div class="d">[\s\S]*?<\/div><\/div>/g,
    `<div class="cv-card" role="listitem"><div class="k">组织门禁</div><div class="v">${authorization.value}</div><div class="d">${authorization.summary}。${development.currentSummary}${projectStatus.ddevReady ? "只有 DEV-M0 已放行，DEV-M1 及真实运行能力仍须后续门禁。" : "未获 Ddev 前不得开始正式代码开发。"}</div></div>`,
    "组织门禁状态卡"
  );
  board = replaceUnique(
    board,
    /(<section class="panel" id="panel-wf"[\s\S]*?<p class="purpose"><strong>生成状态：<\/strong>)[\s\S]*?(<\/p>)/g,
    `$1本 Tab 已由当前 PlantUML 与项目状态真源确定性重生成并通过对齐检查：<strong>实现设计已通过；${currentSummary}</strong>$2`,
    "瀑布 Tab 生成状态"
  );
  board = replaceUnique(
    board,
    /<tr><td>代码开发<\/td><td>按设计真正写程序。<\/td><td>[\s\S]*?<\/td><\/tr>/g,
    `<tr><td>代码开发</td><td>按设计真正写程序。</td><td>${development.codeStatus}</td></tr>`,
    "小白版代码开发状态"
  );
  board = replaceUnique(
    board,
    /<li><strong>G0\/Ddev 组织授权门（不计入八关）<\/strong>：[\s\S]*?<\/li>/g,
    `<li><strong>G0/Ddev 组织授权门（不计入八关）</strong>：它位于第 3 关与第 4 关之间，${authorization.passed ? "现已通过" : "当前尚未全部通过"}；${authorization.summary}。${development.currentSummary}G0-15 与 Ddev 均不授权真实数据、飞书运行链路、Pilot、生产发布、付费调用、自动发送或 DEV-M1。</li>`,
    "小白版组织授权说明"
  );
  board = replaceUnique(
    board,
    /<p><strong>当前推进项：<\/strong>[\s\S]*?<\/p>/g,
    `<p><strong>当前推进项：</strong>${currentGate}。${currentSummary}</p>`,
    "瀑布状态表当前推进项"
  );
  board = replaceUnique(
    board,
    /<tr><th>4 代码开发<\/th><td><span class="gate (?:pass|partial|todo)">[\s\S]*?<\/span><\/td><td>开发<\/td><\/tr>/g,
    `<tr><th>4 代码开发</th><td><span class="gate ${development.gateClass}">${development.codeStatus}</span></td><td>开发</td></tr>`,
    "瀑布状态表代码开发行"
  );
  board = replaceUnique(
    board,
    /(<footer>离线单文件[\s\S]*?当前规范以 37\/39\/40\/46 为准 · )[\s\S]*?( · schema v1\.12)/g,
    `$1${authorization.summary} · 代码开发当前为 ${development.footerStatus}${projectStatus.ddevReady ? "；DEV-M1 与真实运行能力未放行" : ""}$2`,
    "页脚产品开发状态"
  );
  return board;
}

const rendererHtml = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><title>PlantUML renderer</title>
<script src="/viz-global.js"></script>
<script type="module">
  import { renderToString } from "/plantuml.js";
  window.renderPlantUml = (lines) => new Promise((resolve, reject) => {
    renderToString(lines, resolve, (message) => reject(new Error(String(message))));
  });
  window.rendererReady = true;
</script></html>`;

function contentType(fileName) {
  if (fileName.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "text/html; charset=utf-8";
}

async function startRendererServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/" || pathname === "/index.html") {
        response.writeHead(200, { "content-type": contentType("index.html") });
        response.end(rendererHtml);
        return;
      }
      const fileName = pathname.slice(1);
      assert.ok(["viz-global.js", "plantuml.js"].includes(fileName), "unsupported renderer asset");
      const body = await readFile(path.join(coreDir, fileName));
      response.writeHead(200, { "content-type": contentType(fileName) });
      response.end(body);
    } catch (error) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end(String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (bundledError) {
    if (process.env.CI) throw bundledError;
    return chromium.launch({ channel: "chrome", headless: true });
  }
}

function normalizeSvg(svg) {
  let result = svg
    .trim()
    .replace(/^<\?xml[^>]*>\s*/i, "")
    .replace(/^<!DOCTYPE[^>]*>\s*/i, "");
  if (/^<svg\b[^>]*\bclass="[^"]*"/i.test(result)) {
    result = result.replace(/^<svg\b([^>]*?)\bclass="([^"]*)"/i, (_all, before, classes) => {
      const next = new Set(classes.split(/\s+/).filter(Boolean));
      next.add("diagram-svg");
      return `<svg${before}class="${[...next].join(" ")}"`;
    });
  } else {
    result = result.replace(/^<svg\b/i, '<svg class="diagram-svg"');
  }
  return `${result}\n`;
}

async function calculateRendererSha256() {
  const assets = await Promise.all(
    ["plantuml.js", "viz-global.js"].map(async (fileName) => ({
      fileName,
      sha256: sha256(await readFile(path.join(coreDir, fileName))),
    }))
  );
  return sha256(JSON.stringify(assets));
}

const rendererSha256 = await calculateRendererSha256();
const projectDir = path.join(repoRoot, "business-docs", "01-客服Agent项目");
const canonicalProjectDir = await realpath(projectDir);
const projectSources = await loadCustomerProjectSources({ projectDir, canonicalProjectDir });
const { projectStatus } = buildCustomerProjectSurfaceModel(projectSources.byId);
const { server, origin } = await startRendererServer();
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(`${origin}/index.html`, { waitUntil: "load" });
  await page.waitForFunction(() => window.rendererReady === true);

  const currentBoard = await readFile(boardPath, "utf8");
  const previousProvenance = parseArchitectureProvenance(currentBoard);
  let board = synchronizeBoardStatusShell(currentBoard, projectStatus);
  const differences = [];
  const renderedDiagrams = [];
  const provenanceDiagrams = [];
  for (const { id, baseName } of architectureDiagrams) {
    const sourcePath = path.join(diagramDir, `${baseName}.puml`);
    const outputPath = path.join(svgDir, `${baseName}.svg`);
    const source = await readFile(sourcePath, "utf8");
    const rendered = normalizeSvg(
      await page.evaluate((lines) => window.renderPlantUml(lines), source.split(/\r\n|\r|\n/))
    );

    let current = null;
    try {
      current = await readFile(outputPath, "utf8");
    } catch {}
    const sourceSha256 = sha256(source);
    const reconciliation = reconcileRenderedSvg({
      id,
      current,
      rendered,
      sourceSha256,
      rendererSha256,
      previousProvenance,
    });
    if (reconciliation.changed) differences.push(path.relative(repoRoot, outputPath));
    board = replaceEmbeddedSvg(board, id, reconciliation.canonical);
    renderedDiagrams.push({ outputPath, baseName, rendered: reconciliation.canonical });
    provenanceDiagrams.push({
      id,
      baseName,
      sourceSha256,
      svg: reconciliation.canonical,
    });
  }

  board = upsertArchitectureProvenance(
    board,
    buildArchitectureProvenance({ rendererSha256, diagrams: provenanceDiagrams })
  );
  if (currentBoard !== board) differences.push(path.relative(repoRoot, boardPath));

  if (checkOnly && differences.length > 0) {
    throw new Error(`PlantUML 产物未同步：\n${differences.map((item) => `- ${item}`).join("\n")}`);
  }
  if (!checkOnly && differences.length > 0) {
    // Render and validate the complete set before touching tracked outputs. Each final replacement
    // is an atomic rename; the HTML is renamed last so it never advertises a partially rendered set.
    // Stage beside the destination so rename stays on one filesystem (no EXDEV in split-volume CI).
    const stagingDir = await mkdtemp(path.join(designDir, ".csai-arch-diagrams-"));
    try {
      for (const item of renderedDiagrams) {
        const stagedPath = path.join(stagingDir, `${item.baseName}.svg`);
        await writeFile(stagedPath, item.rendered, "utf8");
      }
      const stagedBoard = path.join(stagingDir, "board.html");
      await writeFile(stagedBoard, board, "utf8");
      for (const item of renderedDiagrams) {
        await rename(path.join(stagingDir, `${item.baseName}.svg`), item.outputPath);
      }
      await rename(stagedBoard, boardPath);
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }
  console.log(
    checkOnly
      ? `PASS PlantUML source/SVG/HTML aligned (${architectureDiagrams.length}/${architectureDiagrams.length})`
      : `SYNC PlantUML source/SVG/HTML (${architectureDiagrams.length}/${architectureDiagrams.length}); changed=${differences.length}`
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
