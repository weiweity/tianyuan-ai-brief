import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import axe from "axe-core";
import { chromium } from "playwright";
import { sha256, verifyDecisionReceipt } from "../../archive/2026-08-09-ai-project-brief-security-maintenance/js/modules/decision-model.js";
import { createSafeResultsDir } from "./support/safe-results-dir.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // sites
const monorepoRoot = path.resolve(root, "..");
const siteBase = "/archive/2026-08-09-ai-project-brief-security-maintenance";
const resultsRoot = path.join(root, "test-results");
const resultsDir = await createSafeResultsDir({
  trustedRootPath: root,
  rootPath: resultsRoot,
  prefix: "ui",
  label: String(process.pid),
  requestedPath: process.env.UI_AUDIT_RESULTS_DIR,
});
const port =
  Number(process.env.UI_AUDIT_PORT) ||
  (await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  }));

await new Promise((resolve, reject) => {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const build = spawn(npmCommand, ["run", "build:pages"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  build.stdout.on("data", (chunk) => { output += chunk; });
  build.stderr.on("data", (chunk) => { output += chunk; });
  build.once("error", reject);
  build.once("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`公开 Pages 产物构建失败（${code}）\n${output}`));
  });
});

const origin = `http://127.0.0.1:${port}`;
// 从 monorepo 根托管，才能同时访问冻结归档与业务 print 兼容入口
const server = spawn("python3", ["-m", "http.server", String(port)], {
  cwd: monorepoRoot,
  stdio: "ignore",
});

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}${siteBase}/`);
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

async function assertTouchTargets(page, label, minimum = 44) {
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

async function assertMinimumTargetSize(page, selector, label, minimum = 44) {
  const failures = await page.locator(selector).evaluateAll((elements, min) =>
    elements
      .filter((element) => element.checkVisibility())
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label: element.getAttribute("aria-label") || element.textContent.trim(),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((target) => target.width < min || target.height < min), minimum);
  assert.deepEqual(failures, [], `${label} 热区不足：${JSON.stringify(failures)}`);
}

async function swipeStage(page, direction) {
  const point = await page.locator("#stage").evaluate((stage, dir) => {
    const rect = stage.getBoundingClientRect();
    const skip =
      "a,button,input,textarea,select,label,[contenteditable=true],.mermaid-host,#diagram-lightbox,.diagram-lightbox-close,.diagram-zoom-viewport,.diagram-zoom-hint";
    const startFractions = dir === "left" ? [0.78, 0.66, 0.5] : [0.22, 0.34, 0.5];
    for (const yFraction of [0.42, 0.58, 0.7]) {
      for (const xFraction of startFractions) {
        const startX = rect.left + rect.width * xFraction;
        const y = rect.top + rect.height * yFraction;
        const target = document.elementFromPoint(startX, y);
        if (target && stage.contains(target) && !target.closest(skip)) {
          const delta = rect.width * 0.46 * (dir === "left" ? -1 : 1);
          return {
            startX: Math.round(startX),
            endX: Math.round(Math.min(rect.right - 8, Math.max(rect.left + 8, startX + delta))),
            y: Math.round(y),
          };
        }
      }
    }
    throw new Error("未找到可用的滑页起点");
  }, direction);
  const cdp = await page.context().newCDPSession(page);
  try {
    const touch = (x) => [{ x, y: point.y, radiusX: 2, radiusY: 2, force: 1, id: 0 }];
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: touch(point.startX),
    });
    for (let step = 1; step <= 5; step += 1) {
      const x = Math.round(point.startX + ((point.endX - point.startX) * step) / 5);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: touch(x),
      });
      await page.waitForTimeout(18);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

async function assertNoClippedChildren(page, selector, label) {
  const clipped = await page.locator(selector).evaluate((root) => {
    const bounds = root.getBoundingClientRect();
    return [
      ...root.querySelectorAll(
        "tr, .callout, .check-step, .check-status, .chk-btn, .owner-card, input"
      ),
    ]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0 &&
          (rect.left < bounds.left - 1 ||
            rect.right > bounds.right + 1 ||
            rect.top < bounds.top - 1 ||
            rect.bottom > bounds.bottom + 1)
        );
      })
      .map((element) => ({
        text: element.textContent.trim().slice(0, 40),
        top: Math.round(element.getBoundingClientRect().top),
        bottom: Math.round(element.getBoundingClientRect().bottom),
      }));
  });
  assert.deepEqual(clipped, [], `${label} 存在裁切：${JSON.stringify(clipped)}`);
}

async function assertNoBlockOverlap(page, panelId, label) {
  const overlaps = await page.locator(`#${panelId} .panel-body`).evaluate((body) => {
    const blocks = [...body.querySelectorAll(":scope > [data-block-id]")]
      .filter((element) => element.checkVisibility())
      .map((element) => {
        const visibleRects = [element, ...element.querySelectorAll("*")]
          .filter((item) => item.checkVisibility())
          .map((item) => item.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0);
        return {
          id: element.dataset.blockId,
          rect: {
            left: Math.min(...visibleRects.map((rect) => rect.left)),
            right: Math.max(...visibleRects.map((rect) => rect.right)),
            top: Math.min(...visibleRects.map((rect) => rect.top)),
            bottom: Math.max(...visibleRects.map((rect) => rect.bottom)),
          },
        };
      });
    const collisions = [];
    for (let left = 0; left < blocks.length; left += 1) {
      for (let right = left + 1; right < blocks.length; right += 1) {
        const a = blocks[left];
        const b = blocks[right];
        const overlapX = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const overlapY = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (overlapX > 1 && overlapY > 1) {
          collisions.push(`${a.id} × ${b.id}: ${Math.round(overlapX)}×${Math.round(overlapY)}`);
        }
      }
    }
    return collisions;
  });
  assert.deepEqual(overlaps, [], `${label} 内容块重叠：${overlaps.join("、")}`);
}

async function assertVisibleMermaidText(page, id) {
  const expected = {
    t2: ["客服话术库 MVP-A", "供应链备案识别", "组合 P0"],
    t4: ["G0", "Ddev", "停止扩面"],
    t5: ["客服执行路径", "费用已批", "立即停扩"],
  }[id];
  await page.locator(`#${id} .mermaid-host[data-render-state="ready"] svg`).waitFor({
    timeout: 10000,
  });
  const result = await page.locator(`#${id} .mermaid-host`).evaluate((host) => {
    const svg = host.querySelector("svg");
    const rect = svg && svg.getBoundingClientRect();
    return {
      text: [...host.querySelectorAll("svg text, svg tspan")]
        .map((node) => node.textContent)
        .join(" "),
      textNodes: host.querySelectorAll("svg text, svg tspan").length,
      foreignObjects: host.querySelectorAll("foreignObject").length,
      width: rect ? rect.width : 0,
      height: rect ? rect.height : 0,
    };
  });
  assert.ok(result.textNodes > 0, `${id} SVG 只有外壳、没有原生文字节点`);
  expected.forEach((keyword) =>
    assert.match(result.text, new RegExp(keyword.replace(" ", "\\s*")), `${id} 缺少 ${keyword}`)
  );
  assert.equal(result.foreignObjects, 0, `${id} 不得依赖 foreignObject 标签`);
  assert.ok(result.width > 100 && result.height > 80, `${id} 图形可见区域异常`);
}

async function assertSingleVerticalScroller(page, panelId, label, maximum = 1) {
  const scrollable = await page.locator(`#${panelId}`).evaluate((panel) =>
    [panel.querySelector(".panel-body"), ...panel.querySelectorAll(".panel-body *")]
      .filter(Boolean)
      .filter((element) => {
        const style = getComputedStyle(element);
        return (
          /(auto|scroll)/.test(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 2
        );
      })
      .map((element) => ({
        cls: element.className,
        client: element.clientHeight,
        scroll: element.scrollHeight,
      }))
  );
  assert.ok(
    scrollable.length <= maximum,
    `${label} 嵌套纵向滚动超过 ${maximum} 个：${JSON.stringify(scrollable)}`
  );
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
  const region = result.violations
    .filter((violation) => violation.id === "region" || violation.id.startsWith("landmark-"))
    .map((violation) => ({
      nodes: violation.nodes.length,
      targets: violation.nodes.map((node) => node.target),
    }));
  assert.deepEqual(region, [], `${label} landmark 区域遗漏：${JSON.stringify(region)}`);
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
  let manifestRequests = 0;
  let moduleRequests = 0;
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("request", (request) => {
    if (/\/archive\/2026-08-09-ai-project-brief-security-maintenance\/data\/content\.json\?/.test(request.url())) contentRequests += 1;
    if (/\/archive\/2026-08-09-ai-project-brief-security-maintenance\/data\/release\.json(?:\?|$)/.test(request.url())) manifestRequests += 1;
    if (/\/archive\/2026-08-09-ai-project-brief-security-maintenance\/js\/modules\//.test(request.url())) moduleRequests += 1;
  });
  await page.addInitScript(() => {
    localStorage.removeItem("tianyuan-brief-draft-v1");
    globalThis.__AI_BRIEF_CLS__ = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) globalThis.__AI_BRIEF_CLS__ += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto(`${origin}${siteBase}/?audit=${viewport.width}`, { waitUntil: "networkidle" });
  await page.locator(".panel.active").waitFor();

  assert.equal(await page.locator(".toolbar").evaluate((el) => getComputedStyle(el).display), "none");
  assert.equal(await page.locator("#offline-notice").isVisible(), false);
  assert.equal(await page.evaluate(() => globalThis.__AI_BRIEF_EMBEDDED_CONTENT__), undefined);
  assert.ok(contentRequests > 0, "HTTP 正式入口必须读取 content.json SSOT");
  assert.ok(manifestRequests > 0, "HTTP 正式入口必须先读取 release.json");
  assert.equal(moduleRequests, 0, "HTTP 必须使用版本化原子 Bundle，不能请求可混版的 ESM 子模块");
  await page.waitForTimeout(250);
  const initialCls = await page.evaluate(() => globalThis.__AI_BRIEF_CLS__ || 0);
  if (viewport.width > 1024) {
    assert.ok(initialCls <= 0.1, `桌面首屏 CLS 超标：${initialCls.toFixed(4)}`);
  }
  await assertNoHorizontalOverflow(page, `正式入口 ${viewport.width}px 首页`);
  await assertMinimumTargetSize(
    page,
    ".archive-guard-links a",
    `正式入口 ${viewport.width}px 现行项目入口`
  );
  if (viewport.width > 1024) {
    await assertMinimumTargetSize(
      page,
      ".pager-dots button",
      `正式入口 ${viewport.width}px 页码点`
    );
    const edgeAffordance = await page.evaluate(() => {
      const stage = document.querySelector("#stage").getBoundingClientRect();
      const next = document.querySelector("#nav-next");
      const rect = next.getBoundingClientRect();
      return {
        opacity: Number.parseFloat(getComputedStyle(next).opacity),
        left: rect.left,
        stageRight: stage.right,
      };
    });
    assert.ok(edgeAffordance.opacity >= 0.4, `桌面翻页按钮默认不可见：${JSON.stringify(edgeAffordance)}`);
    assert.ok(
      edgeAffordance.left >= edgeAffordance.stageRight - 1,
      `桌面翻页按钮覆盖正文：${JSON.stringify(edgeAffordance)}`
    );
  }

  const tabIds = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"];
  const accessibilityByTab = {};
  accessibilityByTab.performance = { initialCls };
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
      await assertVisibleMermaidText(page, id);
    }
    if (viewport.width <= 640) {
      await assertSingleVerticalScroller(page, id, `${viewport.width}px ${id}`);
      if (id === "t7") await assertNoBlockOverlap(page, id, `${viewport.width}px ${id}`);
    } else if (["t2", "t4", "t5", "t7"].includes(id)) {
      const body = await page.locator(`#${id} .panel-body`).evaluate((element) => ({
        client: element.clientHeight,
        scroll: element.scrollHeight,
      }));
      assert.ok(
        body.scroll <= body.client + 1,
        `${viewport.width}px ${id} 桌面主态不应滚动：${JSON.stringify(body)}`
      );
      await assertNoClippedChildren(page, `#${id} .panel-body`, `${viewport.width}px ${id}`);
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

  await page.locator("#tab-t2").click();
  const zoomHost = page.locator('#t2 .mermaid-host[data-render-state="ready"]');
  await zoomHost.focus();
  await page.keyboard.press("Enter");
  await page.locator("#diagram-lightbox:not([hidden])").waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "diagram-lightbox-close");
  assert.equal(await page.locator("#app").getAttribute("inert"), "");
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "diagram-lightbox-close",
    "流程图模态框焦点不得逃回背景"
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#diagram-lightbox").getAttribute("hidden"), "");
  assert.equal(
    await page.evaluate(() => document.activeElement?.classList.contains("mermaid-host")),
    true,
    "关闭流程图后必须回焦触发元素"
  );
  await page.keyboard.press("Space");
  await page.locator("#diagram-lightbox:not([hidden])").waitFor();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "diagram-lightbox-close");
  await page.getByRole("button", { name: "关闭" }).click();
  const t2Before = await page.locator("#t2 .panel-body").evaluate((element) => ({
    scrollTop: element.scrollTop,
    diagram: element.querySelector("[data-type=mermaid]").getBoundingClientRect().height,
  }));
  await page.locator("#t2 [data-detail-toggle]").click();
  await page.locator("#t2 .detail-card.is-open").waitFor();
  await page.waitForTimeout(380);
  assert.equal(
    await page.locator("#nav-next").evaluate((element) => getComputedStyle(element).display),
    "none",
    "部门详情展开时翻页按钮不得覆盖内容"
  );
  const t2After = await page.locator("#t2 .panel-body").evaluate((element) => {
    const body = element.querySelector(".detail-card-body");
    return {
      scrollTop: element.scrollTop,
      diagram: element.querySelector("[data-type=mermaid]").getBoundingClientRect().height,
      detailClient: body.clientHeight,
      detailScroll: body.scrollHeight,
      first: body.querySelector(".dept-card, tbody tr")?.textContent || "",
      last:
        [...body.querySelectorAll(".dept-card, tbody tr")].at(-1)?.textContent || "",
    };
  });
  assert.equal(t2After.scrollTop, t2Before.scrollTop, "展开部门详情不得自动抢滚动位置");
  assert.ok(t2After.diagram < t2Before.diagram, "展开后流程图必须压缩为上下文缩略图");
  assert.match(t2After.first, /客服/);
  assert.match(t2After.last, /对账|数仓/);
  assert.ok(t2After.detailScroll >= t2After.detailClient, "部门详情必须完整可达");
  if (viewport.width <= 640) {
    await assertSingleVerticalScroller(page, "t2", `${viewport.width}px t2 展开态`);
    const compact = await page.locator("#t2 .mermaid-context-strip").evaluate((strip) => {
      const items = [...strip.querySelectorAll(".mermaid-context-item")];
      return {
        display: getComputedStyle(strip).display,
        text: strip.textContent,
        count: items.length,
        minFont: Math.min(
          ...items.flatMap((item) =>
            [...item.querySelectorAll("b, span")].map((node) =>
              Number.parseFloat(getComputedStyle(node).fontSize)
            )
          )
        ),
        clipped: items.some((item) => {
          const itemRect = item.getBoundingClientRect();
          const stripRect = strip.getBoundingClientRect();
          return (
            itemRect.left < stripRect.left - 1 ||
            itemRect.right > stripRect.right + 1 ||
            itemRect.top < stripRect.top - 1 ||
            itemRect.bottom > stripRect.bottom + 1
          );
        }),
      };
    });
    assert.equal(compact.display, "grid");
    assert.equal(compact.count, 4);
    assert.match(compact.text, /现在.*客服话术库.*下一项.*供应链.*后置.*仓储.*不开.*设计/s);
    assert.ok(compact.minFont >= 10, `t2 可读缩略字号过小：${compact.minFont}px`);
    assert.equal(compact.clipped, false, "t2 可读缩略不得裁切");
  } else {
    assert.ok(
      t2After.detailScroll <= t2After.detailClient + 1,
      `${viewport.width}px t2 展开详情应直接完整显示：${JSON.stringify(t2After)}`
    );
    const compact = await page.locator("#t2 .mermaid-context-strip").evaluate((strip) => ({
      display: getComputedStyle(strip).display,
      count: strip.querySelectorAll(".mermaid-context-item").length,
      text: strip.textContent,
      minFont: Math.min(
        ...[...strip.querySelectorAll(".mermaid-context-item b, .mermaid-context-item span")].map(
          (node) => Number.parseFloat(getComputedStyle(node).fontSize)
        )
      ),
    }));
    assert.equal(compact.display, "grid");
    assert.equal(compact.count, 4);
    assert.match(compact.text, /现在.*下一项.*后置.*不开/s);
    assert.ok(compact.minFont >= 10, `t2 桌面缩略字号过小：${compact.minFont}px`);
  }
  await page.screenshot({
    path: path.join(
      resultsDir,
      `canonical-${viewport.width}x${viewport.height}-t2-open.png`
    ),
    fullPage: true,
  });
  await page.locator("#t2 [data-detail-toggle]").click();

  await page.locator("#tab-t1").click();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-tab"), "t2");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.tab), "t2");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-tab"), "t1");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.tab), "t1");
  await page.keyboard.press("End");
  assert.equal(await page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-tab"), "t7");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.tab), "t7");
  await page.keyboard.press("Home");
  assert.equal(await page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-tab"), "t1");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.tab), "t1");

  if (viewport.width <= 640) {
    await page.locator("#tab-t3").click();
    await swipeStage(page, "right");
    await page.locator("#t2.panel.active").waitFor({ timeout: 2000 });
    assert.equal(
      await page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-tab"),
      "t2"
    );
    await page.locator("#tab-t3").click();
    await swipeStage(page, "left");
    await page.locator("#t4.panel.active").waitFor({ timeout: 2000 });
    await page.locator('#t4 .mermaid-host[data-render-state="ready"]').waitFor({ timeout: 10000 });
    await page.locator("#t4 .panel-body").evaluate((body) => {
      body.scrollTop = body.scrollHeight;
    });
    await page.waitForTimeout(100);
    await swipeStage(page, "left");
    await page.locator("#t5.panel.active").waitFor({ timeout: 2000 });
    assert.equal(
      await page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-tab"),
      "t5",
      "连续滑页不得被冷却态卡住"
    );
  }

  await page.locator("#tab-t6").click();
  assert.equal(
    await page.locator("#nav-next").evaluate((element) => getComputedStyle(element).display),
    "none",
    "执行补录页翻页按钮不得覆盖交互表格"
  );
  const agentGroup = page.getByRole("group", { name: "客服话术库 MVP-A路径选择" });
  await agentGroup.getByRole("button", { name: "C 暂停执行" }).click();
  await page.locator('[data-check-view-button="record"]').click();
  await page
    .getByRole("row", { name: /公司正式批准凭证已归档/ })
    .getByRole("button")
    .click();
  await waitForText(page.locator("[data-check-status]"), /最低要求已齐/);

  await page.locator('[data-check-view-button="paths"]').click();
  await agentGroup.getByRole("button", { name: "A 费用已批，可执行" }).click();
  await waitForText(page.locator("[data-check-status]"), /客服话术库 MVP-A Owner/);
  await page.locator('[data-check-view-button="owners"]').click();
  const agentOwner = page.getByRole("row", { name: /3 客服话术库 MVP-A Owner/ });
  await agentOwner.getByRole("textbox", { name: "姓名" }).fill("李负责人");
  await agentOwner.getByRole("textbox", { name: "部门" }).fill("客服部");
  await agentOwner.getByRole("textbox", { name: "负责" }).fill("客服话术库 MVP-A");
  await page.locator('[data-check-view-button="budget"]').click();
  const feeRow = page.getByRole("row", { name: /客服单项目目标预算/ });
  await feeRow.getByRole("textbox", { name: "目标预算" }).fill("3000");
  await feeRow.getByRole("textbox", { name: "月度 cap" }).fill("1000");
  await feeRow.getByRole("textbox", { name: "全期 cap" }).fill("3000");
  await page.getByRole("row", { name: /授权超客服单项目 cap/ }).getByRole("button").click();
  await waitForText(page.locator("[data-check-status]"), /最低要求已齐/);

  await page.getByRole("button", { name: "复制本场结论" }).click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clipboard, /客服话术库 MVP-A · 路径：A 费用已批，可执行/);
  assert.doesNotMatch(clipboard, /供应链备案识别 · 路径/);
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
    [["agent", "A"]]
  );

  accessibilityByTab["t6-decision"] = await axeViolations(
    page,
    `正式入口 ${viewport.width}px t6 决策完成态`
  );
  if (viewport.width <= 640) {
    await assertTouchTargets(page, `正式入口 ${viewport.width}px t6 决策完成态`);
  }
  for (const view of ["paths", "budget", "owners", "record"]) {
    await page.locator(`[data-check-view-button="${view}"]`).click();
    const metric = await page.locator("#t6 [data-type=check-table] > table").evaluate((table) => ({
      client: table.clientHeight,
      scroll: table.scrollHeight,
    }));
    assert.ok(
      metric.scroll <= metric.client + 1,
      `${viewport.width}px t6 ${view} 步骤不能依赖内滚：${JSON.stringify(metric)}`
    );
    await assertNoClippedChildren(
      page,
      "#t6 [data-type=check-table]",
      `${viewport.width}px t6 ${view}`
    );
    if (view === "owners") {
      assert.equal(
        await page.locator('#t6 tr[data-check-section="owners"]:visible').count(),
        1,
        `${viewport.width}px Owner 步骤只显示客服项目`
      );
    }
    await page.screenshot({
      path: path.join(
        resultsDir,
        `canonical-${viewport.width}x${viewport.height}-t6-${view}.png`
      ),
      fullPage: true,
    });
  }
  await page.screenshot({
    path: path.join(
      resultsDir,
      `canonical-${viewport.width}x${viewport.height}-decision.png`
    ),
    fullPage: true,
  });

  const authorPage = await context.newPage();
  await authorPage.goto(`${origin}${siteBase}/?edit=1`, { waitUntil: "networkidle" });
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
    `${origin}/business-docs/99-%E5%BD%92%E6%A1%A3/2026-07-31-%E7%AB%8B%E9%A1%B9%E9%98%B6%E6%AE%B5/print/AI%E8%B5%8B%E8%83%BD%E7%AB%8B%E9%A1%B9_%E9%87%91%E4%B8%BB%E4%B8%80%E9%A1%B5%E6%B1%87%E6%8A%A5.html`,
    { waitUntil: "networkidle" }
  );
  await page.waitForURL(/archive\/2026-07-31-ai-project-brief\/index\.html\?from=legacy-print/);
  await page.locator(".panel.active").waitFor();
  assert.equal(await page.title(), "天元 · AI 赋能汇报（历史快照）");
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

async function runHistoricalCurrentNavigationAudit(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const failures = [];
  const hubStatusPattern =
    /DEV-M0 已开工，W0、W1、W2、W3 已完成[\s\S]*DEV-M0 正在进行[\s\S]*DEV-M0-W4 不可变 migration \/ PostgreSQL 深模块[\s\S]*待单独授权[\s\S]*不得进入下一里程碑/;
  const prdStatusPattern =
    /G0 \/ Ddev 已签发[\s\S]*DEV-M0 已进入开发中[\s\S]*W0、W1、W2、W3 已完成[\s\S]*DEV-M0-W4 不可变 migration \/ PostgreSQL 深模块[\s\S]*仍未部署/i;
  const attachFailureAudit = (page, label) => {
    page.on("pageerror", (error) => failures.push(`${label} pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") failures.push(`${label} console: ${message.text()}`);
    });
    page.on("requestfailed", (request) => {
      failures.push(`${label} requestfailed: ${request.url()} ${request.failure()?.errorText || ""}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) failures.push(`${label} HTTP ${response.status()}: ${response.url()}`);
    });
  };
  const assertHealthyPage = async (page, expectedTitle, bodyPattern, label) => {
    await page.waitForFunction((title) => document.title === title, expectedTitle);
    const body = await page.locator("body").innerText();
    assert.equal(await page.title(), expectedTitle, `${label} 标题错误`);
    assert.match(body, bodyPattern, `${label} 正文未加载`);
    assert.doesNotMatch(page.url(), /^chrome-error:/, `${label} 落入 Chrome 错误页`);
    assert.doesNotMatch(body, /ERR_FILE_NOT_FOUND|无法访问您的文件/, `${label} 出现文件丢失`);
  };
  const assertCanonicalHttp = (page, suffix, label) => {
    const url = new URL(page.url());
    assert.equal(url.protocol, "http:", `${label} 必须保持 HTTP canonical URL`);
    assert.equal(decodeURIComponent(url.pathname).endsWith(suffix), true, `${label} 路径错误：${url.pathname}`);
    assert.equal(url.searchParams.has("portable"), false, `${label} HTTP 不得落入便携降级`);
  };

  const chainPage = await context.newPage();
  attachFailureAudit(chainPage, "PRD 主链路");
  await chainPage.goto(`${origin}${siteBase}/?audit=current-links-prd`, { waitUntil: "networkidle" });
  await Promise.all([
    chainPage.waitForURL((url) =>
      decodeURIComponent(url.pathname).endsWith("/business-docs/01-客服Agent项目/07-客服Agent立项PRD.html")
    ),
    chainPage.getByRole("link", { name: "现行 PRD", exact: true }).click(),
  ]);
  await chainPage.waitForLoadState("networkidle");
  await assertHealthyPage(chainPage, "客服 Agent 一期 · 需求会项目说明", prdStatusPattern, "HTTP PRD");
  assertCanonicalHttp(chainPage, "/business-docs/01-客服Agent项目/07-客服Agent立项PRD.html", "HTTP PRD");

  await chainPage.waitForFunction(() => document.querySelector("#open-execution-center"));
  await Promise.all([
    chainPage.waitForURL((url) =>
      decodeURIComponent(url.pathname).endsWith("/business-docs/01-客服Agent项目/08-客服Agent立项执行中心.html")
    ),
    chainPage.locator("#open-execution-center").click(),
  ]);
  await chainPage.waitForLoadState("networkidle");
  await assertHealthyPage(
    chainPage,
    "客服 Agent 一期 · 项目执行中心",
    hubStatusPattern,
    "PRD → HTTP Hub"
  );
  assertCanonicalHttp(chainPage, "/business-docs/01-客服Agent项目/08-客服Agent立项执行中心.html", "PRD → HTTP Hub");
  await chainPage.reload({ waitUntil: "networkidle" });
  await assertHealthyPage(
    chainPage,
    "客服 Agent 一期 · 项目执行中心",
    hubStatusPattern,
    "HTTP Hub reload"
  );
  assertCanonicalHttp(chainPage, "/business-docs/01-客服Agent项目/08-客服Agent立项执行中心.html", "HTTP Hub reload");

  await chainPage.waitForFunction(() => document.querySelector("#return-to-prd"));
  await Promise.all([
    chainPage.waitForURL((url) =>
      decodeURIComponent(url.pathname).endsWith("/business-docs/01-客服Agent项目/07-客服Agent立项PRD.html")
    ),
    chainPage.locator("#return-to-prd").click(),
  ]);
  await chainPage.waitForLoadState("networkidle");
  await assertHealthyPage(
    chainPage,
    "客服 Agent 一期 · 需求会项目说明",
    prdStatusPattern,
    "Hub → HTTP PRD"
  );
  assertCanonicalHttp(chainPage, "/business-docs/01-客服Agent项目/07-客服Agent立项PRD.html", "Hub → HTTP PRD");
  await chainPage.reload({ waitUntil: "networkidle" });
  await assertHealthyPage(chainPage, "客服 Agent 一期 · 需求会项目说明", prdStatusPattern, "HTTP PRD reload");
  await chainPage.goBack({ waitUntil: "networkidle" });
  await assertHealthyPage(chainPage, "客服 Agent 一期 · 项目执行中心", hubStatusPattern, "HTTP Back 回 Hub");
  assertCanonicalHttp(chainPage, "/business-docs/01-客服Agent项目/08-客服Agent立项执行中心.html", "HTTP Back 回 Hub");
  await chainPage.goForward({ waitUntil: "networkidle" });
  await assertHealthyPage(chainPage, "客服 Agent 一期 · 需求会项目说明", prdStatusPattern, "HTTP Forward 回 PRD");
  assertCanonicalHttp(chainPage, "/business-docs/01-客服Agent项目/07-客服Agent立项PRD.html", "HTTP Forward 回 PRD");
  await Promise.all([
    chainPage.waitForURL((url) =>
      decodeURIComponent(url.pathname).endsWith("/business-docs/01-客服Agent项目/08-客服Agent立项执行中心.html")
    ),
    chainPage.locator("#open-execution-center").click(),
  ]);
  await chainPage.waitForLoadState("networkidle");
  await assertHealthyPage(chainPage, "客服 Agent 一期 · 项目执行中心", hubStatusPattern, "Forward 后重点 Hub");
  assertCanonicalHttp(chainPage, "/business-docs/01-客服Agent项目/08-客服Agent立项执行中心.html", "Forward 后重点 Hub");
  await Promise.all([
    chainPage.waitForURL((url) =>
      decodeURIComponent(url.pathname).endsWith("/business-docs/01-客服Agent项目/07-客服Agent立项PRD.html")
    ),
    chainPage.locator("#return-to-prd").click(),
  ]);
  await chainPage.waitForLoadState("networkidle");
  await assertHealthyPage(chainPage, "客服 Agent 一期 · 需求会项目说明", prdStatusPattern, "重点 Hub 后返回 PRD");
  assertCanonicalHttp(chainPage, "/business-docs/01-客服Agent项目/07-客服Agent立项PRD.html", "重点 Hub 后返回 PRD");

  const hubPage = await context.newPage();
  attachFailureAudit(hubPage, "Hub 直达链路");
  await hubPage.goto(`${origin}${siteBase}/?audit=current-links-hub`, { waitUntil: "networkidle" });
  await Promise.all([
    hubPage.waitForURL((url) =>
      decodeURIComponent(url.pathname).endsWith("/business-docs/01-客服Agent项目/08-客服Agent立项执行中心.html")
    ),
    hubPage.getByRole("link", { name: "执行中心", exact: true }).click(),
  ]);
  await hubPage.waitForLoadState("networkidle");
  await assertHealthyPage(
    hubPage,
    "客服 Agent 一期 · 项目执行中心",
    hubStatusPattern,
    "HTTP Hub"
  );
  assertCanonicalHttp(hubPage, "/business-docs/01-客服Agent项目/08-客服Agent立项执行中心.html", "HTTP Hub 直达");
  await hubPage.reload({ waitUntil: "networkidle" });
  await assertHealthyPage(hubPage, "客服 Agent 一期 · 项目执行中心", hubStatusPattern, "HTTP Hub 直达 reload");

  await hubPage.waitForFunction(() => document.querySelector("a[data-meeting-link]"));
  await Promise.all([
    hubPage.waitForURL((url) =>
      decodeURIComponent(url.pathname).endsWith("/business-docs/01-客服Agent项目/09-客服Agent需求会汇报.html")
    ),
    hubPage.locator("a[data-meeting-link]").click(),
  ]);
  await hubPage.waitForLoadState("networkidle");
  await assertHealthyPage(
    hubPage,
    "客服 Agent 一期启动会 · 天元 · 客服 Agent 启动会",
    /项目已批准.*一期建议待确认.*尚未开发/s,
    "Hub → HTTP Meeting"
  );
  assertCanonicalHttp(hubPage, "/business-docs/01-客服Agent项目/09-客服Agent需求会汇报.html", "Hub → HTTP Meeting");
  await hubPage.goBack({ waitUntil: "networkidle" });
  await assertHealthyPage(hubPage, "客服 Agent 一期 · 项目执行中心", hubStatusPattern, "Meeting Back 回 Hub");

  const meetingPage = await context.newPage();
  attachFailureAudit(meetingPage, "Meeting 直达链路");
  await meetingPage.goto(`${origin}${siteBase}/?audit=current-links-meeting`, { waitUntil: "networkidle" });
  await Promise.all([
    meetingPage.waitForURL((url) =>
      decodeURIComponent(url.pathname).endsWith("/business-docs/01-客服Agent项目/09-客服Agent需求会汇报.html")
    ),
    meetingPage.getByRole("link", { name: "启动会主屏", exact: true }).click(),
  ]);
  await meetingPage.waitForLoadState("networkidle");
  await assertHealthyPage(
    meetingPage,
    "客服 Agent 一期启动会 · 天元 · 客服 Agent 启动会",
    /项目已批准.*一期建议待确认.*尚未开发/s,
    "HTTP Meeting"
  );
  assertCanonicalHttp(meetingPage, "/business-docs/01-客服Agent项目/09-客服Agent需求会汇报.html", "HTTP Meeting 直达");

  const poisonedPage = await context.newPage();
  attachFailureAudit(poisonedPage, "HTTP portable 污染查询");
  const poisonedPrdUrl = `${origin}/business-docs/01-%E5%AE%A2%E6%9C%8DAgent%E9%A1%B9%E7%9B%AE/07-%E5%AE%A2%E6%9C%8DAgent%E7%AB%8B%E9%A1%B9PRD.html?portable=prd`;
  await poisonedPage.goto(poisonedPrdUrl, { waitUntil: "networkidle" });
  await assertHealthyPage(
    poisonedPage,
    "客服 Agent 一期 · 需求会项目说明",
    prdStatusPattern,
    "HTTP 污染查询 PRD"
  );
  assert.equal(new URL(poisonedPage.url()).searchParams.get("portable"), "prd");
  await Promise.all([
    poisonedPage.waitForURL((url) =>
      decodeURIComponent(url.pathname).endsWith("/business-docs/01-客服Agent项目/08-客服Agent立项执行中心.html")
    ),
    poisonedPage.locator("#open-execution-center").click(),
  ]);
  await poisonedPage.waitForLoadState("networkidle");
  await assertHealthyPage(
    poisonedPage,
    "客服 Agent 一期 · 项目执行中心",
    hubStatusPattern,
    "HTTP 污染查询仍进入 Hub"
  );
  assertCanonicalHttp(
    poisonedPage,
    "/business-docs/01-客服Agent项目/08-客服Agent立项执行中心.html",
    "HTTP 污染查询后 Hub"
  );
  await poisonedPage.reload({ waitUntil: "networkidle" });
  await assertHealthyPage(poisonedPage, "客服 Agent 一期 · 项目执行中心", hubStatusPattern, "HTTP 污染链路 reload");
  await poisonedPage.goBack({ waitUntil: "networkidle" });
  await assertHealthyPage(poisonedPage, "客服 Agent 一期 · 需求会项目说明", prdStatusPattern, "HTTP 污染链路 Back");
  assert.equal(new URL(poisonedPage.url()).searchParams.get("portable"), "prd");
  await poisonedPage.goForward({ waitUntil: "networkidle" });
  await assertHealthyPage(poisonedPage, "客服 Agent 一期 · 项目执行中心", hubStatusPattern, "HTTP 污染链路 Forward");
  await poisonedPage.goBack({ waitUntil: "networkidle" });
  await poisonedPage.locator("#open-execution-center").click();
  await poisonedPage.waitForURL((url) =>
    decodeURIComponent(url.pathname).endsWith("/business-docs/01-客服Agent项目/08-客服Agent立项执行中心.html")
  );
  await poisonedPage.locator("#return-to-prd").click();
  await poisonedPage.waitForURL((url) =>
    decodeURIComponent(url.pathname).endsWith("/business-docs/01-客服Agent项目/07-客服Agent立项PRD.html") &&
    !url.searchParams.has("portable")
  );
  await assertHealthyPage(poisonedPage, "客服 Agent 一期 · 需求会项目说明", prdStatusPattern, "HTTP 污染链路重点击与返回");

  assert.deepEqual(failures, [], `历史 Web 现行入口链路失败：${failures.join("\n")}`);
  await context.close();
  return "历史 Web → HTTP PRD ⇄ HTTP Hub → HTTP Meeting；reload / Back / Forward / reclick；portable 污染查询不劫持 HTTP；历史 Web → HTTP Hub / Meeting";
}

async function runPublicArtifactNavigationAudit(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const failures = [];
  const publicUrl = `${origin}/sites/dist/pages/index.html`;
  for (const linkName of ["现行 PRD", "执行中心"]) {
    const page = await context.newPage();
    page.on("pageerror", (error) => failures.push(`${linkName} pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") failures.push(`${linkName} console: ${message.text()}`);
    });
    page.on("requestfailed", (request) => {
      failures.push(`${linkName} requestfailed: ${request.url()} ${request.failure()?.errorText || ""}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) failures.push(`${linkName} HTTP ${response.status()}: ${response.url()}`);
    });

    await page.goto(publicUrl, { waitUntil: "networkidle" });
    await Promise.all([
      page.waitForURL((url) => url.pathname.endsWith("/sites/dist/pages/internal-only.html")),
      page.getByRole("link", { name: linkName, exact: true }).click(),
    ]);
    await page.waitForLoadState("networkidle");
    assert.equal(await page.title(), "内部材料访问说明", `${linkName} 公开降级页标题错误`);
    const body = await page.locator("body").innerText();
    assert.match(body, /现行材料仅授权内部访问/);
    assert.doesNotMatch(page.url(), /^chrome-error:/, `${linkName} 公开入口落入错误页`);
    assert.doesNotMatch(body, /ERR_FILE_NOT_FOUND|无法访问您的文件/);
    await page.close();
  }

  const meetingPage = await context.newPage();
  meetingPage.on("pageerror", (error) => failures.push(`启动会主屏 pageerror: ${error.message}`));
  meetingPage.on("console", (message) => {
    if (message.type() === "error") failures.push(`启动会主屏 console: ${message.text()}`);
  });
  meetingPage.on("requestfailed", (request) => {
    failures.push(`启动会主屏 requestfailed: ${request.url()} ${request.failure()?.errorText || ""}`);
  });
  meetingPage.on("response", (response) => {
    if (response.status() >= 400) failures.push(`启动会主屏 HTTP ${response.status()}: ${response.url()}`);
  });
  await meetingPage.goto(publicUrl, { waitUntil: "networkidle" });
  await Promise.all([
    meetingPage.waitForURL((url) =>
      url.pathname.endsWith("/sites/dist/pages/customer-agent/")
    ),
    meetingPage.getByRole("link", { name: "启动会主屏", exact: true }).click(),
  ]);
  await meetingPage.waitForLoadState("networkidle");
  assert.match(await meetingPage.title(), /天元 · 客服 Agent 启动会$/);
  assert.match(await meetingPage.locator("html").getAttribute("data-release"), /^meeting-v1-[a-f0-9]{12}$/);
  assert.equal(await meetingPage.locator(".brand-logo").getAttribute("alt"), "SHINE MAGE");
  assert.match(
    await meetingPage.locator('link[rel="icon"]').getAttribute("href"),
    /^data:image\/png;base64,/
  );
  await assertNoHorizontalOverflow(meetingPage, "Pages 启动会主屏");
  await meetingPage.close();

  assert.deepEqual(failures, [], `公开 Pages 现行入口失败：${failures.join("\n")}`);
  await context.close();
  return "Pages 启动会主屏 → /customer-agent/；现行 PRD / 执行中心 → internal-only.html";
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
  page.on("requestfailed", (request) => {
    errors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ""}`);
  });

  const entryPath = useLegacyEntry
    ? path.join(root, "../business-docs/99-归档/2026-07-31-立项阶段/print/AI赋能立项_金主一页汇报.html")
    : path.join(root, "../archive/2026-08-09-ai-project-brief-security-maintenance/index.html");
  const entryUrl = `${pathToFileURL(entryPath).href}${
    useLegacyEntry ? "" : "?audit=file-direct"
  }`;
  await page.goto(entryUrl, { waitUntil: "load" });
  if (useLegacyEntry) {
    await page.waitForURL(/archive\/2026-07-31-ai-project-brief\/index\.html\?from=legacy-print/);
  }
  await page.locator(".panel.active").waitFor({ timeout: 10000 });

  assert.equal(
    await page.locator("#doc-title").innerText(),
    "天元 · AI 赋能汇报（历史快照）"
  );
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
      await assertVisibleMermaidText(page, id);
    }
  }

  await page.locator("#tab-t6").click();
  await page
    .getByRole("group", { name: "客服话术库 MVP-A路径选择" })
    .getByRole("button", { name: "C 暂停执行" })
    .click();
  await page.locator('[data-check-view-button="record"]').click();
  await page
    .getByRole("row", { name: /公司正式批准凭证已归档/ })
    .getByRole("button")
    .click();
  await waitForText(page.locator("[data-check-status]"), /最低要求已齐/);

  const label = `${useLegacyEntry ? "offline-legacy" : "offline-direct"}-${
    viewport.width
  }x${viewport.height}`;
  await page.screenshot({
    path: path.join(resultsDir, `${label}.png`),
    fullPage: true,
  });

  if (!useLegacyEntry && viewport.width === 1440) {
    const projectPrdPath = path.join(
      monorepoRoot,
      "business-docs/01-客服Agent项目/07-客服Agent立项PRD.html"
    );
    await Promise.all([
      page.waitForURL((url) => fileURLToPath(url) === projectPrdPath),
      page.getByRole("link", { name: "现行 PRD", exact: true }).click(),
    ]);
    await page.waitForFunction(() => document.title === "客服 Agent 一期 · 需求会项目说明");
    assert.doesNotMatch(await page.locator("body").innerText(), /ERR_FILE_NOT_FOUND|无法访问您的文件/);
    await page.locator("#open-execution-center").click();
    await page.waitForFunction(() => document.title === "客服 Agent 一期 · 项目执行中心");
    await page.locator(".meeting-unavailable").waitFor();
    assert.equal(await page.locator("a[data-meeting-link]").count(), 0, "便携 Hub 不得导航到相邻 09 文件");
    assert.match(await page.locator("body").innerText(), /请回到项目目录，打开 09-客服Agent需求会汇报\.html/);
    assert.equal(fileURLToPath(new URL(page.url())), projectPrdPath);
    assert.equal(new URL(page.url()).searchParams.get("portable"), "hub");
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.title === "客服 Agent 一期 · 项目执行中心");
    await page.goBack({ waitUntil: "load" });
    await page.waitForFunction(() => document.title === "客服 Agent 一期 · 需求会项目说明");
    await page.goForward({ waitUntil: "load" });
    await page.waitForFunction(() => document.title === "客服 Agent 一期 · 项目执行中心");
    await page.locator("#return-to-prd").click();
    await page.waitForFunction(() => document.title === "客服 Agent 一期 · 需求会项目说明");
    assert.equal(new URL(page.url()).searchParams.has("portable"), false);
    await page.reload({ waitUntil: "load" });
    await page.locator("#open-execution-center").click();
    await page.waitForFunction(() => document.title === "客服 Agent 一期 · 项目执行中心");
    assert.equal(fileURLToPath(new URL(page.url())), projectPrdPath);
    assert.doesNotMatch(page.url(), /^(?:blob|chrome-error):/);
    assert.doesNotMatch(await page.locator("body").innerText(), /ERR_FILE_NOT_FOUND|无法访问您的文件/);
  }
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
  await page.goto(pathToFileURL(path.join(root, "../archive/2026-08-09-ai-project-brief-security-maintenance/index.html")).href, {
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

async function runMermaidResilienceAudit(browser, mode) {
  const context = await browser.newContext({
    viewport: { width: 375, height: 667 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.addInitScript(() => localStorage.clear());
  if (mode === "unavailable") {
    await page.addInitScript(() => {
      window.addEventListener(
        "ai-brief:mermaid-ready",
        () => {
          globalThis.mermaid = undefined;
        },
        { capture: true }
      );
    });
  } else {
    await page.route(/mermaid-10\.9\.6\.min\.js/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });
  }

  const started = Date.now();
  await page.goto(`${origin}${siteBase}/?audit=mermaid-${mode}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.appState === "ready", null, {
    timeout: 1500,
  });
  const readyMs = Date.now() - started;
  assert.ok(readyMs < 1500, `${mode} Mermaid 不得阻塞正文，实际 ${readyMs}ms`);
  assert.equal(await page.locator("[role=tab]").count(), 7);
  assert.equal(await page.locator("#boot-loading").count(), 0);

  await page.locator("#tab-t2").click();
  if (mode === "slow") {
    await assertVisibleMermaidText(page, "t2");
  } else {
    await page.locator('#t2 .mermaid-host[data-render-state="fallback"]').waitFor({
      timeout: 3000,
    });
    assert.match(await page.locator("#t2 .mermaid-host").innerText(), /客服话术库/);
    for (const id of ["t4", "t5"]) {
      await page.locator(`#tab-${id}`).click();
      await page.locator(`#${id} .mermaid-host[data-render-state="fallback"]`).waitFor({
        timeout: 3000,
      });
      assert.ok((await page.locator(`#${id} .mermaid-host`).innerText()).length > 20);
    }
  }
  assert.deepEqual(errors, [], `${mode} Mermaid 故障隔离失败：${errors.join("\n")}`);
  await context.close();
  return readyMs;
}

async function runLastKnownGoodAudit(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const first = await context.newPage();
  await first.addInitScript(() => localStorage.clear());
  await first.goto(`${origin}${siteBase}/?audit=lkg-seed`, { waitUntil: "networkidle" });
  await first.waitForFunction(() => document.documentElement.dataset.appState === "ready");
  assert.equal(
    await first.evaluate(() => Boolean(localStorage.getItem("tianyuan-brief-content-lkg-v1"))),
    true,
    "正常加载后必须写入可信内容快照"
  );
  await first.close();

  const fallback = await context.newPage();
  const errors = [];
  fallback.on("pageerror", (error) => errors.push(error.message));
  await fallback.route(/\/archive\/2026-08-09-ai-project-brief-security-maintenance\/data\/release\.json/, (route) =>
    route.fulfill({ status: 503, body: "unavailable" })
  );
  await fallback.goto(`${origin}${siteBase}/?audit=lkg-fallback`, { waitUntil: "domcontentloaded" });
  await fallback.waitForFunction(() => document.documentElement.dataset.appState === "ready");
  assert.equal(await fallback.locator("[role=tab]").count(), 7);
  assert.match(await fallback.locator("#status-pill").innerText(), /缓存快照/);
  assert.deepEqual(errors, [], `可信快照降级产生脚本错误：${errors.join("\n")}`);
  await context.close();
}

async function runColdStartRecoveryAudit(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  let failManifest = true;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.clear());
  await page.route(/\/archive\/2026-08-09-ai-project-brief-security-maintenance\/data\/release\.json/, (route) =>
    failManifest
      ? route.fulfill({ status: 503, contentType: "text/plain", body: "unavailable" })
      : route.continue()
  );

  await page.goto(`${origin}${siteBase}/?audit=cold-start-recovery`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => document.documentElement.dataset.appState === "error");
  const failureText = await page.locator("#stage").innerText();
  assert.match(failureText, /内容暂不可用/);
  assert.doesNotMatch(failureText, /npm run|localhost|仓库根/);
  const retry = page.getByRole("button", { name: "重新加载" });
  const retryBox = await retry.boundingBox();
  assert.ok(
    retryBox && retryBox.width >= 44 && retryBox.height >= 44,
    `冷启动重试热区不足：${JSON.stringify(retryBox)}`
  );

  failManifest = false;
  await retry.click();
  await page.waitForFunction(() => document.documentElement.dataset.appState === "ready", null, {
    timeout: 8000,
  });
  assert.equal(await page.locator("[role=tab]").count(), 7);
  assert.deepEqual(errors, [], `HTTP 冷启动恢复产生脚本错误：${errors.join("\n")}`);
  await context.close();
}

async function runSameReleaseHotUpdateAudit(browser) {
  const [contentText, releaseText] = await Promise.all([
    readFile(path.join(root, "../archive/2026-08-09-ai-project-brief-security-maintenance/data/content.json"), "utf8"),
    readFile(path.join(root, "../archive/2026-08-09-ai-project-brief-security-maintenance/data/release.json"), "utf8"),
  ]);
  const updatedText = contentText.replace("收尾时 Goal", "校验时 Goal");
  assert.equal(updatedText.length, contentText.length, "故障注入必须保持正文长度不变");
  assert.notEqual(updatedText, contentText, "故障注入文案必须真实变化");
  const release = JSON.parse(releaseText);
  const updatedManifest = { ...release, contentSha256: sha256(updatedText) };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  let serveUpdate = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.clear());
  await page.route(/\/archive\/2026-08-09-ai-project-brief-security-maintenance\/data\/release\.json/, (route) =>
    serveUpdate
      ? route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(updatedManifest),
        })
      : route.continue()
  );
  await page.route(/\/archive\/2026-08-09-ai-project-brief-security-maintenance\/data\/content\.json/, (route) => {
    const requestedSha = new URL(route.request().url()).searchParams.get("sha");
    return serveUpdate && requestedSha === updatedManifest.contentSha256
      ? route.fulfill({ contentType: "application/json", body: updatedText })
      : route.continue();
  });

  await page.goto(`${origin}${siteBase}/?audit=equal-length-hot-update`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => document.documentElement.dataset.appState === "ready");
  assert.match(await page.locator("#t1").innerText(), /收尾时 Goal/);
  serveUpdate = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await waitForText(page.locator("#t1"), /校验时 Goal/, 4000);
  assert.match(await page.locator("#status-pill").innerText(), /已同步最新/);
  assert.deepEqual(errors, [], `同长度热更新产生脚本错误：${errors.join("\n")}`);
  await context.close();
}

async function runCrossReleaseRefreshAudit(browser) {
  const release = JSON.parse(
    await readFile(path.join(root, "../archive/2026-08-09-ai-project-brief-security-maintenance/data/release.json"), "utf8")
  );
  const nextReleaseId = `${release.releaseId}-next`;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  let serveNextRelease = false;
  let versionedNavigation = "";
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.isNavigationRequest() &&
      new URL(request.url()).searchParams.get("_release") === nextReleaseId
    ) {
      versionedNavigation = request.url();
    }
  });
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.route(/\/archive\/2026-08-09-ai-project-brief-security-maintenance\/data\/release\.json/, (route) => {
    const targeted =
      new URL(page.url()).searchParams.get("_release") === nextReleaseId;
    return serveNextRelease && !targeted
      ? route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ...release, releaseId: nextReleaseId }),
        })
      : route.continue();
  });

  await page.goto(`${origin}${siteBase}/?audit=cross-release-refresh`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => document.documentElement.dataset.appState === "ready");
  serveNextRelease = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForURL((url) => url.searchParams.get("_release") === nextReleaseId, {
    timeout: 4000,
  });
  await page.waitForFunction(() => document.documentElement.dataset.appState === "ready");
  assert.ok(versionedNavigation, "跨 release 必须用带版本号的页面 URL 绕过旧 HTML 缓存");
  assert.doesNotMatch(await page.locator("#status-pill").innerText(), /离线|弱网/);
  assert.deepEqual(errors, [], `跨 release 安全刷新产生脚本错误：${errors.join("\n")}`);
  await context.close();
}

async function runImmediatePrintFallbackAudit(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/mermaid-10\.9\.6\.min\.js/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue();
  });
  await page.goto(`${origin}${siteBase}/?audit=immediate-print`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => document.documentElement.dataset.appState === "ready", null, {
    timeout: 1500,
  });

  const pdfPath = path.join(resultsDir, "immediate-print-fallback.pdf");
  const started = Date.now();
  await page.pdf({
    path: pdfPath,
    printBackground: true,
    preferCSSPageSize: true,
    format: "A4",
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2500, `立即打印不应等待慢 Mermaid：${elapsed}ms`);
  const states = await page.locator(".mermaid-host").evaluateAll((hosts) =>
    hosts.map((host) => ({
      state: host.dataset.renderState,
      text: host.textContent.trim(),
      svg: Boolean(host.querySelector("svg")),
    }))
  );
  assert.equal(states.length, 3);
  states.forEach((state) => {
    assert.ok(state.svg || state.text.length > 20, "立即打印不得产生空流程图");
  });
  const pdf = await readFile(pdfPath);
  assert.ok(pdf.byteLength > 40000, "立即打印降级 PDF 异常");
  assert.equal(
    (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length,
    7,
    "立即打印降级仍须恰好七页"
  );
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".mermaid-host svg").length ===
      document.querySelectorAll(".mermaid-host").length,
    null,
    { timeout: 5000 }
  );
  assert.deepEqual(errors, [], `立即打印故障注入产生脚本错误：${errors.join("\n")}`);
  await context.close();
  return { elapsed, pdfPath };
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
  await page.goto(`${origin}${siteBase}/?audit=print`, { waitUntil: "networkidle" });
  await page.locator(".panel.active").waitFor();
  const mermaidHosts = await page.locator(".mermaid-host").count();
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
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
  for (const id of ["t2", "t4", "t5"]) await assertVisibleMermaidText(page, id);

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

async function runNavigationAndResetAudit(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto(`${origin}${siteBase}/?audit=history-reset`, { waitUntil: "networkidle" });
  await page.locator("#t1.panel.active").waitFor();

  await page.locator("#tab-t3").click();
  await page.locator("#t3.panel.active").waitFor();
  assert.match(page.url(), /#tab=t3$/);
  await page.locator("#tab-t4").click();
  await page.locator("#t4.panel.active").waitFor();
  assert.match(page.url(), /#tab=t4$/);
  await page.goBack();
  await page.locator("#t3.panel.active").waitFor();
  assert.match(page.url(), /#tab=t3$/);
  await page.goForward();
  await page.locator("#t4.panel.active").waitFor();
  assert.match(page.url(), /#tab=t4$/);

  await page.locator("#tab-t6").click();
  await page.locator("#t6.panel.active").waitFor();

  // 普通会议变更也必须在持久化失败时显式回滚，不能只保护“清空”。
  await page.evaluate(() => {
    window.__originalStorageSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new DOMException("quota", "QuotaExceededError"); };
  });
  await page.locator('[data-path-pick="A"]').first().click();
  await waitForText(page.locator("#toast"), /保存失败：浏览器存储不可用/);
  assert.equal(
    await page.locator('[data-path-pick="A"]').first().getAttribute("aria-pressed"),
    "false",
    "普通会议变更保存失败后必须回滚"
  );
  await page.evaluate(() => { Storage.prototype.setItem = window.__originalStorageSetItem; });

  await page.locator('[data-path-pick="A"]').first().click();
  await page.locator('input[data-fee="total"]').first().fill("3000");
  await page.locator('input[data-owner-multi="name"]').first().fill("回归负责人");
  assert.equal(await page.locator('[data-path-pick="A"]').first().getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator('input[data-fee="total"]').first().inputValue(), "3000");
  assert.equal(
    await page.locator('input[data-owner-multi="name"]').first().inputValue(),
    "回归负责人"
  );

  await page.evaluate(() => {
    window.__originalStorageSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new DOMException("quota", "QuotaExceededError"); };
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("[data-reset-check]").click();
  await waitForText(page.locator("#toast"), /清空失败：浏览器未能保存/);
  assert.equal(await page.locator('input[data-fee="total"]').first().inputValue(), "3000");
  assert.equal(await page.locator('input[data-owner-multi="name"]').first().inputValue(), "回归负责人");
  await page.evaluate(() => { Storage.prototype.setItem = window.__originalStorageSetItem; });

  const staleFee = await page.locator('input[data-fee="total"]').first().elementHandle();
  const staleOwner = await page.locator('input[data-owner-multi="name"]').first().elementHandle();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("[data-reset-check]").click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("input[data-fee], input[data-owner-multi], input[data-owner]")]
      .every((input) => input.value === "")
  );
  assert.equal(await page.locator('input[data-fee="total"]').first().inputValue(), "");
  assert.equal(await page.locator('input[data-owner-multi="name"]').first().inputValue(), "");
  assert.equal(
    await page.locator('[data-path-pick="A"]').first().getAttribute("aria-pressed"),
    "false"
  );
  assert.equal(
    await page.locator("[data-check-toggle]").evaluateAll((items) =>
      items.every((item) => item.getAttribute("aria-pressed") === "false")
    ),
    true
  );

  await staleFee.evaluate((input) => input.dispatchEvent(new Event("change", { bubbles: true })));
  await staleOwner.evaluate((input) => input.dispatchEvent(new Event("change", { bubbles: true })));
  await page.waitForTimeout(100);
  assert.doesNotMatch(
    (await page.evaluate(() => localStorage.getItem("tianyuan-brief-draft-v1"))) || "",
    /3000|回归负责人/,
    "重置前失效输入的延迟事件不得复活会议状态"
  );

  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#t6.panel.active").waitFor();
  assert.equal(await page.locator('input[data-fee="total"]').first().inputValue(), "");
  assert.equal(await page.locator('input[data-owner-multi="name"]').first().inputValue(), "");
  assert.equal(
    await page.locator('[data-path-pick="A"]').first().getAttribute("aria-pressed"),
    "false"
  );
  await page.screenshot({
    path: path.join(resultsDir, "history-back-forward-reset.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, [], `历史 / 重置回归产生脚本错误：${errors.join("\n")}`);
  await context.close();
  return "t3 → t4 → Back → Forward；path / fee / owner / checked 清空并刷新后保持";
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch(
    process.env.CI ? { headless: true } : { channel: "chrome", headless: true }
  );
  const viewports = [
    { width: 375, height: 667 },
    { width: 390, height: 844 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
  ];
  const accessibility = {};
  for (const viewport of viewports) {
    accessibility[`${viewport.width}x${viewport.height}`] = await runCanonicalAudit(
      browser,
      viewport
    );
  }
  const historicalCurrentNavigation = await runHistoricalCurrentNavigationAudit(browser);
  const publicArtifactNavigation = await runPublicArtifactNavigationAudit(browser);
  const mobileViewport = viewports.find((viewport) => viewport.width === 390);
  const desktopViewport = viewports.find((viewport) => viewport.width === 1440);
  await runLegacyAudit(browser, mobileViewport);
  await runLegacyAudit(browser, desktopViewport);
  await runFileAudit(browser, mobileViewport, false);
  await runFileAudit(browser, mobileViewport, true);
  await runFileAudit(browser, desktopViewport, false);
  await runFileAudit(browser, desktopViewport, true);
  await runFileFailureAudit(browser);
  const mermaidReady = {
    slow: await runMermaidResilienceAudit(browser, "slow"),
    unavailable: await runMermaidResilienceAudit(browser, "unavailable"),
  };
  await runLastKnownGoodAudit(browser);
  await runColdStartRecoveryAudit(browser);
  await runSameReleaseHotUpdateAudit(browser);
  await runCrossReleaseRefreshAudit(browser);
  const navigationAndReset = await runNavigationAndResetAudit(browser);
  const immediatePrint = await runImmediatePrintFallbackAudit(browser);
  const printArtifact = await runPrintAudit(browser);
  console.log(
    JSON.stringify(
      {
        ok: true,
        viewports,
        accessibility,
        historicalCurrentNavigation,
        publicArtifactNavigation,
        offlineFile: ["390 direct", "390 legacy", "1440 direct", "1440 legacy"],
        offlineFailure: "explicit recovery UI",
        mermaidReady,
        lastKnownGood: "release failure recovered from verified local snapshot",
        coldStart: "actionable retry recovered without local-only instructions",
        hotUpdate: "equal-length content applied by verified SHA",
        crossRelease: "versioned full-page refresh",
        navigationAndReset,
        immediatePrint,
        printArtifact,
        artifacts: resultsDir,
      },
      null,
      2
    )
  );
} finally {
  try {
    await browser?.close();
  } finally {
    server.kill("SIGTERM");
  }
}
