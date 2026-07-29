import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import axe from "axe-core";
import { chromium } from "playwright";
import { sha256, verifyDecisionReceipt } from "../docs/js/modules/decision-model.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir =
  process.env.UI_AUDIT_RESULTS_DIR || path.join(root, "test-results", `ui-${process.pid}`);
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

async function assertVisibleMermaidText(page, id) {
  const expected = {
    t2: ["客服 Agent", "供应链 备案识别", "本期主开"],
    t4: ["先齐前置", "内部演示", "停扩"],
    t5: ["您怎么批", "同意启动", "超线即停"],
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
    if (/\/docs\/data\/content\.json\?/.test(request.url())) contentRequests += 1;
    if (/\/docs\/data\/release\.json(?:\?|$)/.test(request.url())) manifestRequests += 1;
    if (/\/docs\/js\/modules\//.test(request.url())) moduleRequests += 1;
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
  assert.ok(manifestRequests > 0, "HTTP 正式入口必须先读取 release.json");
  assert.equal(moduleRequests, 0, "HTTP 必须使用版本化原子 Bundle，不能请求可混版的 ESM 子模块");
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
      await assertVisibleMermaidText(page, id);
    }
    if (viewport.width <= 640) {
      await assertSingleVerticalScroller(page, id, `${viewport.width}px ${id}`);
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
    assert.match(compact.text, /主开.*客服 Agent.*产出.*可周报.*后置.*仓储.*不开.*设计/s);
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
    assert.match(compact.text, /主开.*产出.*后置.*不开/s);
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

  await page.locator("#tab-t6").click();
  assert.equal(
    await page.locator("#nav-next").evaluate((element) => getComputedStyle(element).display),
    "none",
    "当场确认页翻页按钮不得覆盖交互表格"
  );
  const agentGroup = page.getByRole("group", { name: "客服 Agent路径选择" });
  const filingGroup = page.getByRole("group", { name: "供应链备案识别路径选择" });
  await agentGroup.getByRole("button", { name: "C 不立" }).click();
  await filingGroup.getByRole("button", { name: "C 不立" }).click();
  await waitForText(page.locator("[data-check-status]"), /最低要求已齐/);

  await agentGroup.getByRole("button", { name: "A 同意启动" }).click();
  await waitForText(page.locator("[data-check-status]"), /客服 Agent Owner/);
  await page.locator('[data-check-view-button="owners"]').click();
  const agentOwner = page.getByRole("row", { name: /3A 客服 Agent Owner/ });
  await agentOwner.getByRole("textbox", { name: "姓名" }).fill("李负责人");
  await agentOwner.getByRole("textbox", { name: "部门" }).fill("客服部");
  await agentOwner.getByRole("textbox", { name: "负责" }).fill("客服 Agent");
  await page.locator('[data-check-view-button="budget"]').click();
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
        2,
        `${viewport.width}px Owner 步骤必须同时看见两个项目`
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
      await assertVisibleMermaidText(page, id);
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
  await page.goto(`${origin}/docs/?audit=mermaid-${mode}`, { waitUntil: "domcontentloaded" });
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
    assert.match(await page.locator("#t2 .mermaid-host").innerText(), /客服 Agent/);
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
  await first.goto(`${origin}/docs/?audit=lkg-seed`, { waitUntil: "networkidle" });
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
  await fallback.route(/\/docs\/data\/release\.json/, (route) =>
    route.fulfill({ status: 503, body: "unavailable" })
  );
  await fallback.goto(`${origin}/docs/?audit=lkg-fallback`, { waitUntil: "domcontentloaded" });
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
  await page.route(/\/docs\/data\/release\.json/, (route) =>
    failManifest
      ? route.fulfill({ status: 503, contentType: "text/plain", body: "unavailable" })
      : route.continue()
  );

  await page.goto(`${origin}/docs/?audit=cold-start-recovery`, {
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
    readFile(path.join(root, "docs/data/content.json"), "utf8"),
    readFile(path.join(root, "docs/data/release.json"), "utf8"),
  ]);
  const updatedText = contentText.replace("项目清单", "项目名单");
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
  await page.route(/\/docs\/data\/release\.json/, (route) =>
    serveUpdate
      ? route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(updatedManifest),
        })
      : route.continue()
  );
  await page.route(/\/docs\/data\/content\.json/, (route) => {
    const requestedSha = new URL(route.request().url()).searchParams.get("sha");
    return serveUpdate && requestedSha === updatedManifest.contentSha256
      ? route.fulfill({ contentType: "application/json", body: updatedText })
      : route.continue();
  });

  await page.goto(`${origin}/docs/?audit=equal-length-hot-update`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => document.documentElement.dataset.appState === "ready");
  assert.match(await page.locator("#t1").innerText(), /项目清单/);
  serveUpdate = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await waitForText(page.locator("#t1"), /项目名单/, 4000);
  assert.match(await page.locator("#status-pill").innerText(), /已同步最新/);
  assert.deepEqual(errors, [], `同长度热更新产生脚本错误：${errors.join("\n")}`);
  await context.close();
}

async function runCrossReleaseRefreshAudit(browser) {
  const release = JSON.parse(
    await readFile(path.join(root, "docs/data/release.json"), "utf8")
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
  await page.route(/\/docs\/data\/release\.json/, (route) => {
    const targeted =
      new URL(page.url()).searchParams.get("_release") === nextReleaseId;
    return serveNextRelease && !targeted
      ? route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ...release, releaseId: nextReleaseId }),
        })
      : route.continue();
  });

  await page.goto(`${origin}/docs/?audit=cross-release-refresh`, {
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
  await page.goto(`${origin}/docs/?audit=immediate-print`, {
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
  await page.goto(`${origin}/docs/?audit=print`, { waitUntil: "networkidle" });
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

await rm(resultsDir, { recursive: true, force: true });
await mkdir(resultsDir, { recursive: true });
await waitForServer();
const browser = await chromium.launch(
  process.env.CI ? { headless: true } : { channel: "chrome", headless: true }
);

try {
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
  const immediatePrint = await runImmediatePrintFallbackAudit(browser);
  const printArtifact = await runPrintAudit(browser);
  console.log(
    JSON.stringify(
      {
        ok: true,
        viewports,
        accessibility,
        offlineFile: ["390 direct", "390 legacy", "1440 direct", "1440 legacy"],
        offlineFailure: "explicit recovery UI",
        mermaidReady,
        lastKnownGood: "release failure recovered from verified local snapshot",
        coldStart: "actionable retry recovered without local-only instructions",
        hotUpdate: "equal-length content applied by verified SHA",
        crossRelease: "versioned full-page refresh",
        immediatePrint,
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
