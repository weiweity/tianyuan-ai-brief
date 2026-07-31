import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createSafeResultsDir } from "../../web-decision-brief/tests/support/safe-results-dir.mjs";
import {
  resolveCustomerProjectQaPaths,
  resolveCustomerProjectWorkspace,
} from "./project_workspace.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const workspace = await resolveCustomerProjectWorkspace(import.meta.url);
const { mode, projectDir } = workspace;
const webRoot = path.join(repoRoot, "web-decision-brief");
const requireFromWeb = createRequire(path.join(webRoot, "package.json"));
const { chromium } = requireFromWeb("playwright");
const axeSource = requireFromWeb("axe-core").source;

const targetPath = path.resolve(
  process.env.PRD_HTML ||
    path.join(projectDir, "07-客服Agent立项PRD.html")
);
const roundArg = process.argv.find((value) => value.startsWith("--round="));
const round = roundArg ? roundArg.slice("--round=".length) : "manual";
const qaPaths = resolveCustomerProjectQaPaths(workspace, "prd");
const resultsDir = await createSafeResultsDir({
  trustedRootPath: qaPaths.trustedRootPath,
  rootPath: qaPaths.rootPath,
  prefix: "round",
  label: round,
  requestedPath: process.env.PRD_QA_RESULTS_DIR,
});
const targetUrl = pathToFileURL(targetPath).href;

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "laptop", width: 1024, height: 768 },
  { name: "mobile-wide", width: 390, height: 844 },
  { name: "mobile-compact", width: 375, height: 667 },
  { name: "reflow-320", width: 320, height: 720 },
];

const results = {
  round,
  targetPath,
  startedAt: new Date().toISOString(),
  checks: [],
  viewports: {},
};

function record(name, passed, detail = "") {
  results.checks.push({ name, passed, detail });
  if (!passed) process.exitCode = 1;
}

async function check(name, callback) {
  try {
    const detail = await callback();
    record(name, true, detail ?? "");
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

function assertNoHeadingSkip(levels) {
  for (let index = 1; index < levels.length; index += 1) {
    assert.ok(
      levels[index] <= levels[index - 1] + 1,
      `标题层级从 h${levels[index - 1]} 跳到 h${levels[index]}`
    );
  }
}

await check("PRD 真源清单与内容契约 --check", async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["business-docs/08-工具/check_customer_agent_prd_sources.mjs", "--check"],
    { cwd: repoRoot }
  );
  assert.equal(stderr, "");
  assert.match(stdout, /PRD 真源与内容契约已同步/);
  return stdout.trim();
});

await check("HTML 文件存在且体积受控", async () => {
  const fileStat = await stat(targetPath);
  assert.ok(fileStat.isFile(), "PRD HTML 不存在");
  assert.ok(fileStat.size < 150_000, `HTML 体积 ${fileStat.size} bytes 超过 150 KB`);
  return `${fileStat.size} bytes`;
});

await check("关键业务口径完整", async () => {
  const html = await readFile(targetPath, "utf8");
  const requiredFacts = [
    "客服 Agent",
    "话术库 MVP-A",
    "2026-08-04",
    "自动代发 = 0",
    "供应链能力不进入本项目",
  ];
  if (mode === "public-template") {
    requiredFacts.push(
      "G0 未签发",
      "0 / 14",
      "0 / 15",
      "8 月 4 日启动立项，不启动开发"
    );
  }
  const missing = requiredFacts.filter((fact) => !html.includes(fact));
  assert.deepEqual(missing, [], `缺少关键口径：${missing.join("、")}`);
  return `${requiredFacts.length} 项`;
});

const browserLaunchOptions = process.env.CI
  ? { headless: true }
  : { channel: "chrome", headless: true };
if (process.env.CHROME_PATH) {
  delete browserLaunchOptions.channel;
  browserLaunchOptions.executablePath = process.env.CHROME_PATH;
}
const browser = await chromium.launch(browserLaunchOptions);

try {
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      colorScheme: "light",
      reducedMotion: "no-preference",
      locale: "zh-CN",
    });
    await context.addInitScript(() => {
      window.__prdPrintCalls = 0;
      window.print = () => {
        window.__prdPrintCalls += 1;
      };
    });

    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    const externalRequests = [];

    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => {
      failedRequests.push(`${request.url()} · ${request.failure()?.errorText || "unknown"}`);
    });
    page.on("request", (request) => {
      const protocol = new URL(request.url()).protocol;
      if (!["file:", "data:", "blob:"].includes(protocol)) {
        externalRequests.push(request.url());
      }
    });

    const startedAt = performance.now();
    await page.goto(targetUrl, { waitUntil: "load" });
    await page.waitForTimeout(250);
    const elapsed = Math.round(performance.now() - startedAt);
    const viewportResult = {
      width: viewport.width,
      height: viewport.height,
      elapsedMs: elapsed,
      consoleErrors,
      pageErrors,
      failedRequests,
      externalRequests,
    };
    results.viewports[viewport.name] = viewportResult;

    await check(`${viewport.name} · 页面结构与无横向溢出`, async () => {
      const structure = await page.evaluate(() => {
        const headings = [...document.querySelectorAll("h1,h2,h3")].map((element) =>
          Number(element.tagName.slice(1))
        );
        return {
          h1Count: document.querySelectorAll("h1").length,
          headings,
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          lang: document.documentElement.lang,
        };
      });
      assert.equal(structure.h1Count, 1, "页面必须只有一个 h1");
      assert.equal(structure.lang, "zh-CN", "页面语言必须为 zh-CN");
      assertNoHeadingSkip(structure.headings);
      assert.ok(
        structure.scrollWidth <= structure.clientWidth + 1,
        `整页横向溢出 ${structure.scrollWidth - structure.clientWidth}px`
      );
      return `${structure.scrollWidth}/${structure.clientWidth}`;
    });

    await check(`${viewport.name} · 控制台、请求与加载性能`, async () => {
      assert.deepEqual(consoleErrors, [], `console error：${consoleErrors.join(" | ")}`);
      assert.deepEqual(pageErrors, [], `page error：${pageErrors.join(" | ")}`);
      assert.deepEqual(failedRequests, [], `失败请求：${failedRequests.join(" | ")}`);
      assert.deepEqual(externalRequests, [], `外部请求：${externalRequests.join(" | ")}`);
      assert.ok(elapsed < 3000, `加载耗时 ${elapsed}ms`);
      return `${elapsed}ms，0 外部请求`;
    });

    await check(`${viewport.name} · 响应式脑图呈现`, async () => {
      const mapState = await page.evaluate(() => ({
        desktopMap: document.querySelector("#capability-map").checkVisibility(),
        mobileMap: document.querySelector(".map-mobile").checkVisibility(),
      }));
      if (viewport.width <= 720) {
        assert.equal(mapState.desktopMap, false, "移动端应隐藏 SVG 脑图");
        assert.equal(mapState.mobileMap, true, "移动端能力卡必须可见");
      } else {
        assert.equal(mapState.desktopMap, true, "桌面端 SVG 脑图必须可见");
        assert.equal(mapState.mobileMap, false, "桌面端应隐藏移动能力卡");
      }
      return viewport.width <= 720 ? "移动能力卡" : "SVG 脑图";
    });

    if (viewport.width <= 720) {
      await check(`${viewport.name} · 触控目标不小于 44px`, async () => {
        const undersized = await page.locator("a, button, summary").evaluateAll((elements) =>
          elements
            .filter((element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                rect.width > 0 &&
                rect.height > 0 &&
                (rect.width < 44 || rect.height < 44)
              );
            })
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return `${element.tagName.toLowerCase()}#${element.id || "-"} ${Math.round(
                rect.width
              )}×${Math.round(rect.height)}`;
            })
        );
        assert.deepEqual(undersized, [], `过小目标：${undersized.join("、")}`);
        return "全部通过";
      });

      await check(`${viewport.name} · 移动端能力地图入口与焦点恢复`, async () => {
        const opener = page.locator("#map-open");
        assert.equal(await opener.isVisible(), true);
        assert.equal(await page.locator(".map-open-mobile").isVisible(), true);
        assert.match(await opener.innerText(), /打开完整能力地图/);
        await opener.click();
        assert.equal(await page.locator("#map-dialog").evaluate((element) => element.open), true);
        assert.equal(
          await page.evaluate(() => document.querySelector("#map-dialog").contains(document.activeElement)),
          true
        );
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#map-dialog").evaluate((element) => element.open), false);
        assert.equal(await page.evaluate(() => document.activeElement?.id), "map-open");
        return "入口可见 · Esc 关闭 · 焦点回到入口";
      });
    }

    await check(`${viewport.name} · axe WCAG 2.1 A/AA`, async () => {
      await page.addScriptTag({ content: axeSource });
      const axeResult = await page.evaluate(async () =>
        window.axe.run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
          },
        })
      );
      assert.deepEqual(
        axeResult.violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          nodes: violation.nodes.length,
        })),
        [],
        "存在 WCAG A/AA 违规"
      );
      return `0 violations，${axeResult.passes.length} passes`;
    });

    if (viewport.width > 720) {
      await check(`${viewport.name} · 脑图弹窗语义与可访问性`, async () => {
        await page.locator("#map-open").click();
        const audit = await page.evaluate(async () => {
          const duplicateIds = [...document.querySelectorAll("[id]")]
            .map((element) => element.id)
            .filter((id, index, ids) => ids.indexOf(id) !== index);
          const axeResult = await window.axe.run(document);
          return {
            duplicateIds: [...new Set(duplicateIds)],
            violations: axeResult.violations.map((violation) => ({
              id: violation.id,
              impact: violation.impact,
              nodes: violation.nodes.length,
            })),
          };
        });
        await page.keyboard.press("Escape");
        assert.deepEqual(audit.duplicateIds, [], `重复 id：${audit.duplicateIds.join("、")}`);
        assert.deepEqual(audit.violations, [], "弹窗打开后存在 axe 违规");
        return "0 duplicate id，0 axe violations";
      });
    }

    await page.screenshot({
      path: path.join(resultsDir, `${viewport.name}-${viewport.width}x${viewport.height}.png`),
      fullPage: true,
    });

    if (viewport.name === "desktop") {
      await check("业务真源与页内锚点全部有效", async () => {
        const links = await page.locator("a[href]").evaluateAll((anchors) =>
          anchors.map((anchor) => anchor.getAttribute("href"))
        );
        for (const href of links) {
          if (href.startsWith("#")) {
            assert.ok(
              await page.locator(href).count(),
              `页内锚点不存在：${href}`
            );
            continue;
          }
          const url = new URL(href, targetUrl);
          if (url.protocol === "file:") {
            await stat(fileURLToPath(url));
          }
        }
        return `${links.length} 个链接`;
      });

      await check("资源情景切换与 URL 深链", async () => {
        await page.getByRole("button", { name: "单人全栈 · 保守基线" }).click();
        assert.equal(
          await page.getByRole("button", { name: "单人全栈 · 保守基线" }).getAttribute(
            "aria-pressed"
          ),
          "true"
        );
        assert.match(await page.locator("#scenario-output").innerText(), /11-20/);
        assert.match(page.url(), /resource=solo/);
        await page.getByRole("button", { name: "跨职能小队 · 资源满足" }).click();
        assert.match(await page.locator("#scenario-output").innerText(), /09-11/);
        assert.match(page.url(), /resource=team/);
        return "team / solo";
      });

      await check("脑图弹窗、缩放、复位、焦点与 Esc", async () => {
        const opener = page.locator("#map-open");
        assert.equal(
          await opener.getAttribute("aria-label"),
          "放大查看话术库 MVP-A 能力地图"
        );
        await opener.click();
        assert.equal(await page.locator("#map-dialog").evaluate((element) => element.open), true);
        assert.equal(await page.evaluate(() => document.activeElement?.id), "map-close");
        assert.equal(await page.locator(".dialog-canvas").getAttribute("tabindex"), "0");
        const backgroundScroll = await page.evaluate(() => window.scrollY);
        await page.keyboard.press("PageDown");
        await page.waitForTimeout(80);
        assert.equal(
          await page.evaluate(() => window.scrollY),
          backgroundScroll,
          "弹窗打开时背景页面被 PageDown 滚动"
        );
        await page.locator("#map-plus").click();
        await page.locator("#map-plus").click();
        assert.ok(
          Math.abs(
            Number(
              await page.locator("#dialog-map").evaluate((element) =>
                element.style.getPropertyValue("--map-scale")
              )
            ) - 1.24
          ) < 0.001,
          "连续放大两次后应为 1.24"
        );
        await page.locator("#map-reset").click();
        assert.equal(
          await page.locator("#dialog-map").evaluate((element) =>
            element.style.getPropertyValue("--map-scale")
          ),
          "1"
        );
        for (let index = 0; index < 7; index += 1) await page.keyboard.press("Tab");
        assert.equal(
          await page.evaluate(() =>
            document.querySelector("#map-dialog").contains(document.activeElement)
          ),
          true,
          "弹窗焦点逃逸"
        );
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#map-dialog").evaluate((element) => element.open), false);
        assert.equal(await page.evaluate(() => document.activeElement?.id), "map-open");
        return "通过";
      });

      await check("折叠内容、打印按钮与打印状态恢复", async () => {
        const details = page.locator("details");
        await details.evaluateAll((elements) => elements.forEach((element) => (element.open = false)));
        await details.first().locator("summary").click();
        assert.equal(await details.first().evaluate((element) => element.open), true);
        await details.first().locator("summary").click();
        assert.equal(await details.first().evaluate((element) => element.open), false);
        await page.locator("#print-button").click();
        assert.equal(await page.evaluate(() => window.__prdPrintCalls), 1);
        await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
        assert.equal(await details.evaluateAll((elements) => elements.every((item) => item.open)), true);
        await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
        assert.equal(await details.evaluateAll((elements) => elements.every((item) => !item.open)), true);
        return `${await details.count()} 个折叠区`;
      });

      await check("跳到正文与键盘焦点", async () => {
        const skipLink = page.locator(".skip-link");
        await skipLink.focus();
        await page.keyboard.press("Enter");
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        assert.equal(await page.evaluate(() => document.activeElement?.id), "main");
        return "焦点进入 main";
      });

      await check("打印 CSS 与 A4 PDF", async () => {
        await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
        await page.emulateMedia({ media: "print" });
        assert.equal(
          await page.locator(".site-header").evaluate((element) => getComputedStyle(element).display),
          "none"
        );
        assert.equal(
          await page.locator(".skip-link").evaluate((element) => getComputedStyle(element).display),
          "none"
        );
        const pdfPath = path.join(resultsDir, "客服Agent立项PRD-A4.pdf");
        await page.pdf({
          path: pdfPath,
          format: "A4",
          printBackground: true,
          preferCSSPageSize: true,
        });
        const pdf = await readFile(pdfPath);
        const pageCount = (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;
        assert.ok(pdf.byteLength > 50_000, `PDF 体积异常：${pdf.byteLength}`);
        assert.ok(pageCount >= 2 && pageCount <= 12, `PDF 页数异常：${pageCount}`);
        await page.emulateMedia({ media: "screen" });
        await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
        return `${pageCount} 页，${pdf.byteLength} bytes`;
      });
    }

    await context.close();
  }

  await check("暗色模式与减弱动画组合", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      colorScheme: "dark",
      reducedMotion: "reduce",
      locale: "zh-CN",
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(targetUrl, { waitUntil: "load" });
    await page.waitForTimeout(250);
    const state = await page.evaluate(() => ({
      dark: matchMedia("(prefers-color-scheme: dark)").matches,
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    assert.equal(state.dark, true);
    assert.equal(state.reduced, true);
    assert.ok(state.overflow <= 1, `横向溢出 ${state.overflow}px`);
    assert.deepEqual(errors, []);
    await page.addScriptTag({ content: axeSource });
    const axeResult = await page.evaluate(async () =>
      window.axe.run(document, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
        },
      })
    );
    assert.deepEqual(
      axeResult.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.length,
      })),
      [],
      "暗色模式存在 WCAG A/AA 违规"
    );
    await page.screenshot({
      path: path.join(resultsDir, "dark-reduced-390x844.png"),
      fullPage: true,
    });
    await context.close();
    return "390×844";
  });
} finally {
  await browser.close();
}

results.finishedAt = new Date().toISOString();
results.summary = {
  passed: results.checks.filter((item) => item.passed).length,
  failed: results.checks.filter((item) => !item.passed).length,
  total: results.checks.length,
};
await writeFile(
  path.join(resultsDir, "results.json"),
  `${JSON.stringify(results, null, 2)}\n`,
  "utf8"
);

console.log(
  `客服 Agent PRD QA round ${round}: ${results.summary.passed}/${results.summary.total} passed`
);
for (const item of results.checks.filter((checkResult) => !checkResult.passed)) {
  console.error(`FAIL · ${item.name} · ${item.detail}`);
}
console.log(`证据目录：${resultsDir}`);
