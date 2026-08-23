import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

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
const { server, origin } = await startRendererServer();
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(`${origin}/index.html`, { waitUntil: "load" });
  await page.waitForFunction(() => window.rendererReady === true);

  const currentBoard = await readFile(boardPath, "utf8");
  const previousProvenance = parseArchitectureProvenance(currentBoard);
  let board = currentBoard;
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
