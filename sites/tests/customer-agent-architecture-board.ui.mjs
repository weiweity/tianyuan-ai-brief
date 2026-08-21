import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import axe from "axe-core";
import { chromium } from "playwright";

import { architectureDiagrams } from "../scripts/customer-agent-architecture-diagrams.manifest.mjs";

const sitesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const boardPath = path.join(
  sitesDir,
  "..",
  "business-docs",
  "01-客服Agent项目",
  "20-设计-进行中",
  "架构图-PlantUML浏览器.html"
);
const board = await readFile(boardPath);
const tabs = architectureDiagrams.map(({ id }) => id);
const viewports = [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
];

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname !== "/" && pathname !== "/architecture.html") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(board);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (bundledError) {
    if (process.env.CI) throw bundledError;
    return chromium.launch({ headless: true, channel: "chrome" });
  }
}

let browser;
const evidence = [];
try {
  browser = await launchBrowser();
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const externalRequests = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin !== origin) externalRequests.push(request.url());
    });

    await page.goto(`${origin}/architecture.html`, { waitUntil: "load" });
    assert.equal(await page.locator('[role="tab"]').count(), tabs.length);
    assert.match(
      await page.locator(".stage-summary").innerText(),
      /架构设计：通过 · PASS-WITH-CONDITIONS（含 CR-002、CR-003、CR-004、DEC-042 与扩展治理静态增量）/
    );
    const evidenceText = await page.locator(".evidence-details").textContent();
    assert.match(
      evidenceText,
      /扩展治理[\s\S]*静态已冻结[\s\S]*N\/N-1[\s\S]*PlatformAdapter[\s\S]*迁移兼容矩阵/
    );
    const bodyText = await page.locator("body").innerText();
    assert.match(
      evidenceText,
      /DEC-042 内容治理[\s\S]*静态机器合同已锁[\s\S]*稳定 Question[\s\S]*search_recommendable_scripts[\s\S]*质量 plan\/evidence 分账/
    );
    assert.match(
      evidenceText,
      /机器基线[\s\S]*v1\.12 \/ 1\.11\.0[\s\S]*513 statements \/ 89 function bodies \/ 20 guards[\s\S]*不等于迁移、类型或 runtime 已完成/
    );
    for (const invariant of [
      /稳定\s*Question/,
      /显式\s*scope/,
      /taxonomy/,
      /双审/,
      /placeholder/,
      /quarantine/,
      /promoted_by_role/,
      /population_manifest_hash/,
      /非通用JCS/,
    ]) {
      assert.match(bodyText, invariant);
    }
    assert.match(
      bodyText,
      /当前 schema v1\.12 reference DDL[^\n]*本机隔离 PostgreSQL 15\.18[^\n]*PASS-WITH-LIMITATION/
    );
    assert.match(
      bodyText,
      /immutable migration[^\n]*N\/N-1[^\n]*application runtime[^\n]*managed PG[^\n]*NOT_CERTIFIED/
    );
    assert.match(
      evidenceText,
      /47b667958e522a28df1c04d7c79a56c930bfe0ac04598321824b55744ac4a801/
    );
    assert.match(evidenceText, /06698f233702591c8f981c7b08ebac4b7d5bc5cc2d69d36014ef2a9f5a6802e4/);
    assert.match(evidenceText, /513 statements/);
    assert.match(evidenceText, /89 function bodies/);
    assert.match(evidenceText, /20 guards/);
    assert.doesNotMatch(
      bodyText,
      /<DEC-042-SCHEMA-SHA>|schema v1\.(?:9|10|11)(?!\.)|OpenAPI 1\.10\.0/
    );
    assert.match(
      await page.getByRole("row", { name: /2 架构设计/ }).innerText(),
      /通过 · PASS-WITH-CONDITIONS（含 CR-002、CR-003、CR-004、DEC-042 与扩展治理静态增量）/
    );
    assert.match(
      await page.getByRole("row", { name: /3 实现设计/ }).innerText(),
      /通过 · 文档包 Ready（含 CR-002\/003\/004[\/、]DEC-042 与扩展治理）；技术设计已收口，不代表开发授权/
    );
    const authorizationGate = await page
      .getByRole("row", { name: /组织授权门（不计入八关）/ })
      .innerText();
    assert.match(
      authorizationGate,
      /当前推进项 · 费用路径与 G0-14 WBS \/ 成本包已签发；G0 未签发、Ddev 未授权/
    );
    assert.match(authorizationGate, /外部责任包 13\/14、Scope 14\/15/);
    assert.match(bodyText, /EVD-G0-11-SECURITY-BOUNDARY-20260810/);
    assert.match(bodyText, /EVD-G0-12-OPS-DEPLOYMENT-20260810/);
    assert.match(authorizationGate, /DEC-DDEV-01=PASS/);
    assert.match(authorizationGate, /只即时放行 DEV-M0/);
    assert.match(
      await page.getByRole("row", { name: /4 代码开发/ }).innerText(),
      /等待授权 · 未开始/
    );

    for (const id of tabs) {
      await page.locator(`#tab-${id}`).click();
      await page.locator(`#panel-${id}`).waitFor({ state: "visible" });
      assert.equal(await page.locator(`#tab-${id}`).getAttribute("aria-selected"), "true");
      assert.equal(new URL(page.url()).hash, `#diagram-${id}`);
      await page.evaluate(() =>
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      );

      const layout = await page.evaluate((activeId) => {
        const root = document.documentElement;
        const viewportElement = document.querySelector(`#viewport-${activeId}`);
        const viewportRect = viewportElement.getBoundingClientRect();
        const buttons = [...document.querySelectorAll("button")]
          .filter((element) => element.checkVisibility())
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return { label: element.textContent.trim(), width: rect.width, height: rect.height };
          })
          .filter((item) => item.width < 44 || item.height < 44);
        const textHeights = [...document.querySelectorAll(`#panel-${activeId} svg text`)]
          .filter((element) => element.checkVisibility())
          .map((element) => element.getBoundingClientRect().height)
          .filter((height) => height > 0);
        const svgTextNodes = [...document.querySelectorAll(`#panel-${activeId} svg text`)];
        const visibleSvgText = svgTextNodes
          .filter((element) => element.checkVisibility())
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              rect.right > viewportRect.left + 1 &&
              rect.left < viewportRect.right - 1 &&
              rect.bottom > viewportRect.top + 1 &&
              rect.top < viewportRect.bottom - 1
            );
          });
        const tablist = document.querySelector('[role="tablist"]');
        return {
          pageClientWidth: root.clientWidth,
          pageScrollWidth: root.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          undersizedButtons: buttons,
          minSvgTextHeight: textHeights.length ? Math.min(...textHeights) : null,
          visibleSvgTextCount: visibleSvgText.length,
          visibleSvgContentCount: visibleSvgText.filter(
            (element) => svgTextNodes.indexOf(element) >= 2
          ).length,
          visibleSvgTextSample: visibleSvgText.slice(0, 3).map((element) => element.textContent.trim()),
          tablistHeight: tablist.getBoundingClientRect().height,
        };
      }, id);
      assert.ok(
        Math.max(layout.pageScrollWidth, layout.bodyScrollWidth) <= layout.pageClientWidth + 1,
        `${viewport.width}x${viewport.height}/${id}: page horizontal overflow ${JSON.stringify(layout)}`
      );
      assert.deepEqual(
        layout.undersizedButtons,
        [],
        `${viewport.width}x${viewport.height}/${id}: control target below 44px`
      );
      assert.ok(
        layout.minSvgTextHeight === null || layout.minSvgTextHeight >= 12,
        `${viewport.width}x${viewport.height}/${id}: rendered SVG text below 12px (${layout.minSvgTextHeight})`
      );
      assert.ok(
        layout.visibleSvgTextCount > 0,
        `${viewport.width}x${viewport.height}/${id}: readable mode opens on blank diagram viewport`
      );
      assert.ok(
        layout.visibleSvgContentCount > 0,
        `${viewport.width}x${viewport.height}/${id}: readable mode shows only title copy, not diagram content`
      );
      if (viewport.width <= 700) {
        assert.ok(
          layout.tablistHeight <= 72,
          `${viewport.width}x${viewport.height}/${id}: mobile tablist wraps beyond one compact row (${layout.tablistHeight}px)`
        );
      }

      await page.addScriptTag({ content: axe.source });
      const axeResult = await page.evaluate(async () =>
        window.axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
        })
      );
      assert.deepEqual(
        axeResult.violations,
        [],
        `${viewport.width}x${viewport.height}/${id}: axe violations`
      );
    }

    const assertKeyboardTab = async (id) => {
      assert.equal(await page.locator(`#tab-${id}`).getAttribute("aria-selected"), "true");
      assert.equal(await page.evaluate(() => document.activeElement?.id), `tab-${id}`);
      const tabState = await page.locator(".tab").evaluateAll((elements) =>
        elements.map((element) => ({
          id: element.getAttribute("data-id"),
          selected: element.getAttribute("aria-selected"),
          tabIndex: element.getAttribute("tabindex"),
        }))
      );
      assert.deepEqual(
        tabState.filter(({ selected }) => selected === "true").map(({ id: tabId }) => tabId),
        [id]
      );
      assert.deepEqual(
        tabState.filter(({ tabIndex }) => tabIndex === "0").map(({ id: tabId }) => tabId),
        [id]
      );
      assert.deepEqual(
        await page
          .locator(".panel:not([hidden])")
          .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-id"))),
        [id]
      );
      assert.equal(await page.evaluate(() => window.location.hash), `#diagram-${id}`);
    };

    await page.locator(`#tab-${tabs[0]}`).click();
    await assertKeyboardTab(tabs[0]);
    for (let index = 0; index < tabs.length; index += 1) {
      await page.keyboard.press("ArrowRight");
      await assertKeyboardTab(tabs[(index + 1) % tabs.length]);
    }
    for (let index = 0; index < tabs.length; index += 1) {
      await page.keyboard.press("ArrowLeft");
      await assertKeyboardTab(tabs[(tabs.length - 1 - index + tabs.length) % tabs.length]);
    }
    await page.keyboard.press("End");
    await assertKeyboardTab(tabs.at(-1));
    await page.keyboard.press("Home");
    await assertKeyboardTab(tabs[0]);

    await page.goto(`${origin}/architecture.html#diagram-stack`, { waitUntil: "load" });
    assert.equal(await page.locator("#tab-stack").getAttribute("aria-selected"), "true");
    await page.evaluate(() =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );

    const visibleStackLayers = await page.evaluate(() => {
      const viewport = document.querySelector("#viewport-stack");
      const viewportRect = viewport.getBoundingClientRect();
      return [...document.querySelectorAll("#panel-stack svg text")]
        .filter((element) => element.checkVisibility())
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.right > viewportRect.left + 1 &&
            rect.left < viewportRect.right - 1 &&
            rect.bottom > viewportRect.top + 1 &&
            rect.top < viewportRect.bottom - 1
          );
        })
        .map((element) => element.textContent.trim())
        .flatMap((text) => [...text.matchAll(/\bL(\d{1,2})\b/g)].map((match) => `L${match[1]}`));
    });
    const expectedReadableLayers = viewport.width <= 700
      ? ["L0", "L1", "L2"]
      : ["L0", "L1", "L2", "L3"];
    for (const layer of expectedReadableLayers) {
      assert.ok(
        visibleStackLayers.includes(layer),
        `${viewport.width}x${viewport.height}/stack: readable start misses ${layer}; visible=${visibleStackLayers.join(",")}`
      );
    }

    const zoomToolbar = page.locator('[data-zoom-for="stack"]');
    const zoomPercent = async () =>
      Number.parseInt((await page.locator("#zoom-label-stack").textContent()).trim(), 10);
    const readablePercent = await zoomPercent();
    await zoomToolbar.locator('[data-act="in"]').click();
    assert.ok(await zoomPercent() > readablePercent, `${viewport.width}x${viewport.height}: zoom in failed`);
    await zoomToolbar.locator('[data-act="100"]').click();
    assert.equal(await page.locator("#zoom-label-stack").textContent(), "100%");
    await zoomToolbar.locator('[data-act="fit"]').click();
    const overviewPercent = await zoomPercent();
    assert.ok(overviewPercent < 100, `${viewport.width}x${viewport.height}: overview fit did not shrink`);
    await zoomToolbar.locator('[data-act="reset"]').click();
    assert.ok(
      await zoomPercent() >= overviewPercent,
      `${viewport.width}x${viewport.height}: readable reset is smaller than overview fit`
    );

    assert.deepEqual(consoleErrors, [], `${viewport.width}x${viewport.height}: console errors`);
    assert.deepEqual(pageErrors, [], `${viewport.width}x${viewport.height}: page errors`);
    assert.deepEqual(externalRequests, [], `${viewport.width}x${viewport.height}: external requests`);
    evidence.push({
      viewport,
      tabs: tabs.length,
      axeViolations: 0,
      keyboardNavigation: true,
      zoomControls: true,
      readableStackLayers: expectedReadableLayers,
    });
    await context.close();
  }
  console.log(JSON.stringify({ ok: true, viewports: evidence, tabs: tabs.length }));
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
