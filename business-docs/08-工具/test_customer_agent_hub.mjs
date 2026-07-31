import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createSafeResultsDir } from "../../web-decision-brief/tests/support/safe-results-dir.mjs";
import { resolveCustomerProjectWorkspace } from "./project_workspace.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const { projectDir } = await resolveCustomerProjectWorkspace(import.meta.url);
const webRoot = path.join(repoRoot, "web-decision-brief");
const requireFromWeb = createRequire(path.join(webRoot, "package.json"));
const { chromium } = requireFromWeb("playwright");
const axeSource = requireFromWeb("axe-core").source;

const targetPath = path.join(projectDir, "08-客服Agent立项执行中心.html");
const targetUrl = pathToFileURL(targetPath).href;
const roundArg = process.argv.find((value) => value.startsWith("--round="));
const round = roundArg ? roundArg.slice("--round=".length) : "manual";
const resultsRoot = path.join(repoRoot, "output/customer-agent-hub-qa");
const resultsDir = await createSafeResultsDir({
  trustedRootPath: repoRoot,
  rootPath: resultsRoot,
  prefix: "round",
  label: round,
  requestedPath: process.env.HUB_QA_RESULTS_DIR,
});

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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

await check("生成物新鲜度 --check", async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["business-docs/08-工具/generate_customer_agent_hub.mjs", "--check"],
    { cwd: repoRoot }
  );
  assert.equal(stderr, "");
  assert.match(stdout, /执行中心已同步/);
  return stdout.trim();
});

await check("HTML 文件存在且为只读生成视图", async () => {
  const html = await readFile(targetPath, "utf8");
  const payloadMatch = html.match(
    /<script id="hub-data" type="application\/json">([\s\S]*?)<\/script>/
  );
  assert.ok(payloadMatch, "缺少 hub-data 生成数据");
  const payload = JSON.parse(payloadMatch[1]);
  assert.match(html, /GENERATED FILE — source: 00-06 Markdown; DO NOT EDIT/);
  assert.doesNotMatch(html, /__HUB_DATA__|__PRETEXT_VENDOR__|__RELEASE_ID__/);
  assert.match(html, /现在不是开工，是把 G0 证据补齐/);
  assert.equal(payload.status.externalPass, 0);
  assert.equal(payload.status.externalTotal, 14);
  assert.equal(payload.status.scopePass, 0);
  assert.equal(payload.status.scopeTotal, 15);
  assert.equal(payload.status.direction, "已记录");
  assert.equal(payload.status.approval, "未完成");
  assert.match(payload.status.paidSpend, /新增付费授权 = 0/);
  assert.match(payload.headline.summary, /工作方向已登记，不等于公司批准/);
  assert.match(payload.headline.nextOutput, /5 份原始评分 · 每候选 ≥3 样本 · 异常分清单/);
  assert.equal(payload.governance.fee.filter((item) => item.current).length, 1);
  assert.equal(payload.governance.fee.find((item) => item.current)?.id, "B");
  assert.doesNotMatch(payload.meeting.director.join("\n"), /外包推进节奏/);
  assert.match(html, /Ddev/);
  const fileStat = await stat(targetPath);
  assert.ok(fileStat.size < 160_000, `HTML 体积 ${fileStat.size} bytes`);
  return `${fileStat.size} bytes`;
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
      window.__hubPrintCalls = 0;
      window.print = () => {
        window.__hubPrintCalls += 1;
      };
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value) => {
            window.__hubCopiedText = value;
          },
        },
      });
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
    page.on("requestfailed", (request) =>
      failedRequests.push(`${request.url()} · ${request.failure()?.errorText || "unknown"}`)
    );
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
    results.viewports[viewport.name] = {
      width: viewport.width,
      height: viewport.height,
      elapsedMs: elapsed,
      consoleErrors,
      pageErrors,
      failedRequests,
      externalRequests,
    };

    await check(`${viewport.name} · 结构、标题与无横向溢出`, async () => {
      const structure = await page.evaluate(() => ({
        h1Count: document.querySelectorAll("h1").length,
        headings: [...document.querySelectorAll("h1,h2,h3")].map((item) =>
          Number(item.tagName.slice(1))
        ),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        lang: document.documentElement.lang,
        release: document.documentElement.dataset.release,
      }));
      assert.equal(structure.h1Count, 1);
      assert.equal(structure.lang, "zh-CN");
      assert.match(structure.release, /^hub-v1-[a-f0-9]{12}$/);
      assertNoHeadingSkip(structure.headings);
      assert.ok(
        structure.scrollWidth <= structure.clientWidth + 1,
        `横向溢出 ${structure.scrollWidth - structure.clientWidth}px`
      );
      return `${structure.scrollWidth}/${structure.clientWidth}`;
    });

    await check(`${viewport.name} · 控制台、请求与性能`, async () => {
      assert.deepEqual(consoleErrors, []);
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(failedRequests, []);
      assert.deepEqual(externalRequests, []);
      assert.ok(elapsed < 3000, `加载耗时 ${elapsed}ms`);
      return `${elapsed}ms，0 外部请求`;
    });

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
        []
      );
      return `0 violations，${axeResult.passes.length} passes`;
    });

    if (viewport.width <= 560) {
      await check(`${viewport.name} · 触控目标不小于 44px`, async () => {
        const undersized = await page.locator("a, button, summary").evaluateAll((items) =>
          items
            .filter((item) => {
              const rect = item.getBoundingClientRect();
              const style = getComputedStyle(item);
              return (
                item.checkVisibility() &&
                style.pointerEvents !== "none" &&
                rect.width > 0 &&
                rect.height > 0 &&
                (rect.width < 44 || rect.height < 44)
              );
            })
            .map((item) => {
              const rect = item.getBoundingClientRect();
              return `${item.tagName.toLowerCase()} ${Math.round(rect.width)}×${Math.round(
                rect.height
              )}`;
            })
        );
        assert.deepEqual(undersized, [], `过小目标：${undersized.join("、")}`);
        return "全部通过";
      });

      await check(`${viewport.name} · 返回 PRD 始终可见可点`, async () => {
        const link = page.getByRole("link", { name: "返回 PRD" });
        assert.equal(await link.isVisible(), true);
        const box = await link.boundingBox();
        assert.ok(box && box.width >= 44 && box.height >= 44, `返回 PRD 热区：${JSON.stringify(box)}`);
        const href = await link.getAttribute("href");
        assert.ok(href);
        await stat(fileURLToPath(new URL(href, targetUrl)));
        return `${Math.round(box.width)}×${Math.round(box.height)}`;
      });
    }

    await page.screenshot({
      path: path.join(resultsDir, `${viewport.name}-${viewport.width}x${viewport.height}.png`),
      fullPage: true,
    });

    if (viewport.name === "desktop") {
      await check("空 Hash / Back 回到总览且无脚本错误", async () => {
        assert.equal(new URL(page.url()).hash, "");
        await page.locator('.top-nav a[href="#now"]').click();
        assert.equal(new URL(page.url()).hash, "#now");
        await page.goBack();
        await page.waitForFunction(() => location.hash === "");
        assert.equal(
          await page.locator('.top-nav a[href="#overview"]').getAttribute("aria-current"),
          "location"
        );
        assert.deepEqual(pageErrors, []);
        return "#now → Back → empty hash / overview";
      });

      await check("7 份源文件哈希与生成数据一致", async () => {
        const payload = await page.locator("#hub-data").evaluate((item) =>
          JSON.parse(item.textContent)
        );
        assert.equal(payload.sources.length, 7);
        for (const source of payload.sources) {
          const sourcePath = path.join(path.dirname(targetPath), source.file);
          const text = await readFile(sourcePath, "utf8");
          assert.equal(source.sha256, sha256(text), `${source.file} 哈希不一致`);
        }
        return "7/7";
      });

      await check("原始 Markdown 只在维护抽屉", async () => {
        const markdownLinks = page.locator('a[href$=".md"]');
        assert.equal(await markdownLinks.count(), 7);
        assert.equal(
          await markdownLinks.evaluateAll((items) =>
            items.every((item) => item.closest("#source-drawer"))
          ),
          true
        );
        assert.equal(await markdownLinks.first().isVisible(), false);
        await page.locator("#source-drawer summary").click();
        assert.equal(await markdownLinks.first().isVisible(), true);
        for (const href of await markdownLinks.evaluateAll((items) =>
          items.map((item) => item.getAttribute("href"))
        )) {
          await stat(fileURLToPath(new URL(href, targetUrl)));
        }
        return "7 个链接，默认折叠";
      });

      await check("返回 PRD 链路有效", async () => {
        const href = await page.getByRole("link", { name: "返回 PRD" }).getAttribute("href");
        assert.ok(href);
        await stat(fileURLToPath(new URL(href, targetUrl)));
        return href;
      });

      await check("业务决策 / 一线运营候选角色筛选与深链", async () => {
        await page.getByRole("button", { name: "业务决策候选" }).click();
        assert.equal(
          await page.getByRole("button", { name: "业务决策候选" }).getAttribute("aria-pressed"),
          "true"
        );
        assert.equal(await page.locator('[data-role-panel="director"]').isVisible(), true);
        assert.equal(await page.locator('[data-role-panel="manager"]').isVisible(), false);
        assert.match(page.url(), /role=director/);
        await page.getByRole("button", { name: "一线运营候选" }).click();
        assert.equal(await page.locator('[data-role-panel="director"]').isVisible(), false);
        assert.equal(await page.locator('[data-role-panel="manager"]').isVisible(), true);
        assert.match(page.url(), /role=manager/);
        await page.getByRole("button", { name: "全部" }).click();
        assert.equal(await page.locator('[data-role-panel="director"]').isVisible(), true);
        assert.equal(await page.locator('[data-role-panel="manager"]').isVisible(), true);
        return "all / director / manager";
      });

      await check("复制会前清单", async () => {
        await page.locator("#copy-checklist").click();
        await page.waitForFunction(() => Boolean(window.__hubCopiedText));
        const copied = await page.evaluate(() => window.__hubCopiedText);
        assert.match(copied, /业务决策角色候选（待核验）/);
        assert.match(copied, /一线运营角色候选（待核验）/);
        assert.match(copied, /谁最终负责/);
        assert.equal(await page.locator("#copy-status").innerText(), "已复制");
        return `${copied.length} 字`;
      });

      await check("G0 门禁分组、折叠与 ID 深链", async () => {
        assert.equal(await page.locator(".gate-item").count(), 14);
        assert.equal(await page.locator("#gate-groups details").count(), 4);
        await page.goto(`${targetUrl}#G0-11`, { waitUntil: "load" });
        await page.waitForTimeout(100);
        assert.equal(await page.locator("#G0-11").isVisible(), true);
        assert.equal(
          await page.locator("#G0-11").evaluate((item) => item.closest("details").open),
          true
        );
        return "14 项，4 组";
      });

      await check("打印按钮、折叠展开恢复与 A4 PDF", async () => {
        await page.goto(targetUrl, { waitUntil: "load" });
        const details = page.locator("details");
        await details.evaluateAll((items) => items.forEach((item) => (item.open = false)));
        await page.locator("#print-button").click();
        assert.equal(await page.evaluate(() => window.__hubPrintCalls), 1);
        await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
        assert.equal(await details.evaluateAll((items) => items.every((item) => item.open)), true);
        await page.emulateMedia({ media: "print" });
        assert.equal(
          await page.locator(".site-header").evaluate((item) => getComputedStyle(item).display),
          "none"
        );
        const pdfPath = path.join(resultsDir, "客服Agent立项执行中心-A4.pdf");
        await page.pdf({
          path: pdfPath,
          format: "A4",
          printBackground: true,
          preferCSSPageSize: true,
        });
        const pdf = await readFile(pdfPath);
        const pageCount = (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;
        assert.ok(pdf.byteLength > 50_000);
        assert.ok(pageCount >= 3 && pageCount <= 20, `PDF 页数 ${pageCount}`);
        await page.emulateMedia({ media: "screen" });
        await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
        assert.equal(await details.evaluateAll((items) => items.every((item) => !item.open)), true);
        return `${pageCount} 页，${pdf.byteLength} bytes`;
      });

      await check("跳到正文与键盘焦点", async () => {
        await page.locator(".skip-link").focus();
        await page.keyboard.press("Enter");
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        assert.equal(await page.evaluate(() => document.activeElement?.id), "main");
        return "焦点进入 main";
      });
    }

    await context.close();
  }

  await check("暗色模式 + reduced motion + axe", async () => {
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
    assert.equal(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), true);
    assert.equal(
      await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
      true
    );
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
      []
    );
    await page.screenshot({
      path: path.join(resultsDir, "dark-reduced-390x844.png"),
      fullPage: true,
    });
    await context.close();
    return "0 violations";
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
  `客服 Agent 执行中心 QA round ${round}: ${results.summary.passed}/${results.summary.total} passed`
);
for (const item of results.checks.filter((checkResult) => !checkResult.passed)) {
  console.error(`FAIL · ${item.name} · ${item.detail}`);
}
console.log(`证据目录：${resultsDir}`);
