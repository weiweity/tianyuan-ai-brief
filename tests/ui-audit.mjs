import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import axe from "axe-core";
import { chromium } from "playwright";
import { verifyDecisionReceipt } from "../docs/js/modules/decision-model.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = path.join(root, "test-results");
const port = 8767;
const origin = `http://127.0.0.1:${port}`;
const server = spawn("python3", ["-m", "http.server", String(port)], {
  cwd: root,
  stdio: "ignore",
});

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/docs/`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("本地测试服务启动超时");
}

async function waitForText(locator, pattern, timeout = 3000) {
  const deadline = Date.now() + timeout;
  let value = "";
  while (Date.now() < deadline) {
    value = await locator.innerText();
    if (pattern.test(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(value, pattern);
  return value;
}

async function assertNoHorizontalOverflow(page, label) {
  const metric = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(
    Math.max(metric.scroll, metric.body) <= metric.client + 1,
    `${label} 横向溢出：${JSON.stringify(metric)}`
  );
}

async function assertTouchTargets(page, label, minimum = 40) {
  const failures = await page.evaluate((min) => {
    const candidates = [...document.querySelectorAll("button, a, input, [role=tab]")];
    return candidates
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top < innerHeight
        );
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label:
            element.getAttribute("aria-label") ||
            element.textContent.trim().slice(0, 32) ||
            element.getAttribute("placeholder") ||
            element.tagName,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((target) => target.width < min || target.height < min);
  }, minimum);
  assert.deepEqual(failures, [], `${label} 点击热区不足：${JSON.stringify(failures)}`);
}

async function axeViolations(page, label) {
  if (!(await page.evaluate(() => Boolean(globalThis.axe)))) {
    await page.evaluate(axe.source);
  }
  const result = await page.evaluate(async () => {
    return globalThis.axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21aa"],
      },
    });
  });
  const blocking = result.violations
    .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.length,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target),
    }));
  assert.deepEqual(blocking, [], `${label} 可访问性阻断：${JSON.stringify(blocking)}`);
  return result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.length,
  }));
}

async function runCanonicalAudit(browser, viewport) {
  const context = await browser.newContext({
    viewport,
    hasTouch: viewport.width <= 640,
    isMobile: viewport.width <= 640,
    deviceScaleFactor: 1,
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = await context.newPage();
  const errors = [];
  let contentRequests = 0;
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("request", (request) => {
    if (/\/docs\/data\/content\.json\?/.test(request.url())) contentRequests += 1;
  });
  await page.addInitScript(() => {
    localStorage.removeItem("tianyuan-brief-draft-v1");
  });
  await page.goto(`${origin}/docs/?audit=${viewport.width}`, { waitUntil: "networkidle" });
  await page.locator(".panel.active").waitFor();

  assert.equal(await page.locator(".toolbar").evaluate((el) => getComputedStyle(el).display), "none");
  assert.equal(await page.locator("#offline-notice").isVisible(), false);
  assert.equal(await page.evaluate(() => globalThis.__AI_BRIEF_EMBEDDED_CONTENT__), undefined);
  assert.ok(contentRequests > 0, "HTTP 正式入口必须读取 content.json SSOT");
  await assertNoHorizontalOverflow(page, `正式入口 ${viewport.width}px 首页`);

  const tabIds = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"];
  const accessibilityByTab = {};
  for (const id of tabIds) {
    await page.locator(`#tab-${id}`).click();
    await page.locator(`#${id}.panel.active`).waitFor();
    await page.waitForTimeout(250);
    await assertNoHorizontalOverflow(page, `正式入口 ${viewport.width}px ${id}`);
    const panelMetric = await page.locator(`#${id}`).evaluate((panel) => {
      const rect = panel.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        scrollHeight: panel.scrollHeight,
      };
    });
    assert.ok(panelMetric.width > 0 && panelMetric.height > 0, `${id} 面板不可见`);
    if (id === "t2" || id === "t4" || id === "t5") {
      await page.locator(`#${id} .mermaid-host svg`).first().waitFor({ timeout: 8000 });
    }
    accessibilityByTab[id] = await axeViolations(
      page,
      `正式入口 ${viewport.width}px ${id}`
    );
    if (viewport.width <= 640) {
      await assertTouchTargets(page, `正式入口 ${viewport.width}px ${id}`);
    }
    await page.screenshot({
      path: path.join(
        resultsDir,
        `canonical-${viewport.width}x${viewport.height}-${id}.png`
      ),
      fullPage: true,
    });
  }

  await page.locator("#tab-t1").click();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-tab"), "t2");

  await page.locator("#tab-t6").click();
  const agentGroup = page.getByRole("group", { name: "客服 Agent路径选择" });
  const filingGroup = page.getByRole("group", { name: "供应链备案识别路径选择" });
  await agentGroup.getByRole("button", { name: "C 不立" }).click();
  await filingGroup.getByRole("button", { name: "C 不立" }).click();
  await waitForText(page.locator("[data-check-status]"), /最低要求已齐/);

  await agentGroup.getByRole("button", { name: "A 同意启动" }).click();
  await waitForText(page.locator("[data-check-status]"), /客服 Agent Owner/);
  const agentOwner = page.getByRole("row", { name: /3A 客服 Agent Owner/ });
  await agentOwner.getByRole("textbox", { name: "姓名" }).fill("李负责人");
  await agentOwner.getByRole("textbox", { name: "部门" }).fill("客服部");
  await agentOwner.getByRole("textbox", { name: "负责" }).fill("客服 Agent");
  await page.getByRole("row", { name: /共享工具费用与止损/ }).getByRole("button").click();
  await page.getByRole("row", { name: /授权超止损/ }).getByRole("button").click();
  await waitForText(page.locator("[data-check-status]"), /最低要求已齐/);

  await page.getByRole("button", { name: "复制本场结论" }).click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clipboard, /客服 Agent · 路径：A 同意启动/);
  assert.match(clipboard, /供应链备案识别 · 路径：C 不立/);
  assert.match(clipboard, /凭证哈希（SHA-256）：[a-f0-9]{64}/);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载凭证" }).click();
  const download = await downloadPromise;
  const receiptPath = await download.path();
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(verifyDecisionReceipt(receipt), true);
  assert.equal(receipt.minimumReady, true);
  assert.deepEqual(
    receipt.projects.map((project) => [project.projectId, project.path]),
    [
      ["agent", "A"],
      ["filing", "C"],
    ]
  );

  accessibilityByTab["t6-decision"] = await axeViolations(
    page,
    `正式入口 ${viewport.width}px t6 决策完成态`
  );
  if (viewport.width <= 640) {
    await assertTouchTargets(page, `正式入口 ${viewport.width}px t6 决策完成态`);
  }
  await page.screenshot({
    path: path.join(
      resultsDir,
      `canonical-${viewport.width}x${viewport.height}-decision.png`
    ),
    fullPage: true,
  });

  const authorPage = await context.newPage();
  await authorPage.goto(`${origin}/docs/?edit=1`, { waitUntil: "networkidle" });
  assert.equal(
    await authorPage.locator(".toolbar").evaluate((el) => getComputedStyle(el).display),
    "flex"
  );
  await authorPage.close();

  assert.deepEqual(errors, [], `正式入口 ${viewport.width}px 控制台错误：${errors.join("\n")}`);
  await context.close();
  return accessibilityByTab;
}

async function runLegacyAudit(browser, viewport) {
  const context = await browser.newContext({
    viewport,
    hasTouch: viewport.width <= 640,
    isMobile: viewport.width <= 640,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto(
    `${origin}/01-%E7%AB%8B%E9%A1%B9%E4%B8%BB%E7%BA%BF/print/AI%E8%B5%8B%E8%83%BD%E7%AB%8B%E9%A1%B9_%E9%87%91%E4%B8%BB%E4%B8%80%E9%A1%B5%E6%B1%87%E6%8A%A5.html`,
    { waitUntil: "networkidle" }
  );
  await page.waitForURL(/\/docs\/index\.html\?from=legacy-print/);
  await page.locator(".panel.active").waitFor();
  assert.equal(await page.title(), "AI 立项决策台");
  await assertNoHorizontalOverflow(page, `历史兼容入口 ${viewport.width}px`);
  if (viewport.width <= 640) {
    await assertTouchTargets(page, `历史兼容入口 ${viewport.width}px`);
  }
  await page.screenshot({
    path: path.join(resultsDir, `legacy-${viewport.width}x${viewport.height}.png`),
    fullPage: true,
  });
  assert.deepEqual(errors, [], `历史兼容入口 ${viewport.width}px 控制台错误：${errors.join("\n")}`);
  await context.close();
}

async function runFileAudit(browser, viewport, useLegacyEntry) {
  const context = await browser.newContext({
    viewport,
    hasTouch: viewport.width <= 640,
    isMobile: viewport.width <= 640,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });

  const entryPath = useLegacyEntry
    ? path.join(root, "01-立项主线/print/AI赋能立项_金主一页汇报.html")
    : path.join(root, "docs/index.html");
  const entryUrl = `${pathToFileURL(entryPath).href}${
    useLegacyEntry ? "" : "?audit=file-direct"
  }`;
  await page.goto(entryUrl, { waitUntil: "load" });
  if (useLegacyEntry) {
    await page.waitForURL(/\/docs\/index\.html\?from=legacy-print/);
  }
  await page.locator(".panel.active").waitFor({ timeout: 10000 });

  assert.equal(await page.locator("#doc-title").innerText(), "AI 立项决策台");
  assert.equal(await page.locator("#offline-notice").isVisible(), true);
  assert.equal(await page.locator("[role=tab]").count(), 7);
  assert.equal(
    await page.evaluate(() => /^[a-f0-9]{64}$/.test(
      globalThis.__AI_BRIEF_OFFLINE_META__?.contentSha256 || ""
    )),
    true
  );

  for (const id of ["t1", "t2", "t3", "t4", "t5", "t6", "t7"]) {
    await page.locator(`#tab-${id}`).click();
    await page.locator(`#${id}.panel.active`).waitFor();
    await assertNoHorizontalOverflow(
      page,
      `file ${useLegacyEntry ? "历史" : "直接"}入口 ${viewport.width}px ${id}`
    );
    if (id === "t2" || id === "t4" || id === "t5") {
      await page.locator(`#${id} .mermaid-host svg`).first().waitFor({ timeout: 8000 });
    }
  }

  await page.locator("#tab-t6").click();
  await page
    .getByRole("group", { name: "客服 Agent路径选择" })
    .getByRole("button", { name: "C 不立" })
    .click();
  await page
    .getByRole("group", { name: "供应链备案识别路径选择" })
    .getByRole("button", { name: "C 不立" })
    .click();
  await waitForText(page.locator("[data-check-status]"), /最低要求已齐/);

  const label = `${useLegacyEntry ? "offline-legacy" : "offline-direct"}-${
    viewport.width
  }x${viewport.height}`;
  await page.screenshot({
    path: path.join(resultsDir, `${label}.png`),
    fullPage: true,
  });
  assert.deepEqual(errors, [], `${label} 控制台错误：${errors.join("\n")}`);
  await context.close();
}

async function runFileFailureAudit(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.route(/app\.offline\.bundle\.js/, (route) => route.abort("failed"));
  await page.goto(pathToFileURL(path.join(root, "docs/index.html")).href, {
    waitUntil: "load",
  });
  await waitForText(page.locator("#doc-title"), /加载失败/, 3000);
  assert.match(
    await page.locator("#stage").innerText(),
    /离线程序包缺失.*npm run build:web/s,
    "file 启动失败必须显式给出恢复方式"
  );
  await context.close();
}

async function runPrintAudit(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto(`${origin}/docs/?audit=print`, { waitUntil: "networkidle" });
  await page.locator(".panel.active").waitFor();
  const mermaidHosts = await page.locator(".mermaid-host").count();
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".mermaid-host svg").length === expected,
    mermaidHosts,
    { timeout: 10000 }
  );

  await page.emulateMedia({ media: "print" });
  const visiblePanels = await page.locator(".panel").evaluateAll((panels) =>
    panels.filter((panel) => getComputedStyle(panel).display !== "none").length
  );
  assert.equal(visiblePanels, 7, "打印模式必须包含全部七页");
  assert.equal(
    await page.locator(".mermaid-host svg").count(),
    mermaidHosts,
    "打印模式不能丢失 Mermaid"
  );

  const pdfPath = path.join(resultsDir, "canonical-print.pdf");
  await page.pdf({
    path: pdfPath,
    printBackground: true,
    preferCSSPageSize: true,
    format: "A4",
  });
  const pdf = await readFile(pdfPath);
  assert.ok(pdf.byteLength > 50000, "打印 PDF 产物异常");
  assert.equal(
    (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length,
    7,
    "打印 PDF 必须恰好七页"
  );
  assert.deepEqual(errors, [], `打印模式控制台错误：${errors.join("\n")}`);
  await context.close();
  return pdfPath;
}

await rm(resultsDir, { recursive: true, force: true });
await mkdir(resultsDir, { recursive: true });
await waitForServer();
const browser = await chromium.launch(
  process.env.CI ? { headless: true } : { channel: "chrome", headless: true }
);

try {
  const viewports = [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ];
  const accessibility = {};
  for (const viewport of viewports) {
    accessibility[viewport.width] = await runCanonicalAudit(browser, viewport);
  }
  await runLegacyAudit(browser, viewports[0]);
  await runLegacyAudit(browser, viewports[2]);
  await runFileAudit(browser, viewports[0], false);
  await runFileAudit(browser, viewports[0], true);
  await runFileAudit(browser, viewports[2], false);
  await runFileAudit(browser, viewports[2], true);
  await runFileFailureAudit(browser);
  const printArtifact = await runPrintAudit(browser);
  console.log(
    JSON.stringify(
      {
        ok: true,
        viewports,
        accessibility,
        offlineFile: ["390 direct", "390 legacy", "1440 direct", "1440 legacy"],
        offlineFailure: "explicit recovery UI",
        printArtifact,
        artifacts: resultsDir,
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
  server.kill("SIGTERM");
}
