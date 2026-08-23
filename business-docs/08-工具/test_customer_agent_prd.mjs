import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  copyFile,
  mkdtemp,
  readFile,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createSafeResultsDir } from "../../sites/tests/support/safe-results-dir.mjs";
import { deriveProjectStatus } from "./customer_project_status.mjs";
import {
  resolveCustomerProjectQaPaths,
  resolveCustomerProjectWorkspace,
} from "./project_workspace.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const workspace = await resolveCustomerProjectWorkspace(import.meta.url);
const { mode, projectDir } = workspace;
const siteRoot = path.join(repoRoot, "sites");
const requireFromSites = createRequire(path.join(siteRoot, "package.json"));
const { chromium } = requireFromSites("playwright");
const axeSource = requireFromSites("axe-core").source;

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function visibleHtmlText(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlAttributes(openTag) {
  return Object.fromEntries(
    [...openTag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gs)].map((match) => [
      match[1],
      match[3],
    ])
  );
}

function expectedStatusAxisClasses(projectStatus) {
  return {
    direction: projectStatus.direction === "已记录" ? "confirmed" : "pending",
    approval: projectStatus.approvalReady ? "confirmed" : "pending",
    "problem-fit": projectStatus.problemFitReady ? "confirmed" : "pending",
    external:
      projectStatus.externalPass === projectStatus.externalTotal ? "confirmed" : "pending",
    scope: projectStatus.scopePass === projectStatus.scopeTotal ? "confirmed" : "pending",
    resource: projectStatus.resourceBaseline === "未选择" ? "pending" : "confirmed",
    ddev: projectStatus.ddevReady ? "confirmed" : "pending",
  };
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
  assert.ok(
    fileStat.size < 2_000_000,
    `HTML 体积 ${fileStat.size} bytes 超过 2 MB 单文件交付上限`
  );
  return `${fileStat.size} bytes`;
});

await check("关键业务口径完整", async () => {
  const html = await readFile(targetPath, "utf8");
  const visible = visibleHtmlText(html);
  const requiredFacts = [
    "客服 Agent 一期启动会",
    "项目已批准",
    "项目侧建议待客服确认",
    "证据型客服助理",
    "灰度前影子回放",
    "2026-08-04",
    "自动代发 = 0",
    "供应链不进入客服一期范围、预算和排期",
    "不做功能投票",
    "不让客服人员选择技术框架",
  ];
  if (mode === "public-template") {
    requiredFacts.push(
      "G0 未签发",
      "13 / 14",
      "14 / 15",
      "最早 08-14"
    );
  }
  const missing = requiredFacts.filter((fact) => !visible.includes(fact));
  assert.deepEqual(missing, [], `缺少关键口径：${missing.join("、")}`);
  for (const stale of ["话术库 MVP-A", "独立预评分", "强制排序"]) {
    assert.equal(visible.includes(stale), false, `可见页面仍包含废止口径：${stale}`);
  }
  assert.equal(visible.includes("编码从下一个可用工作日开始"), false, "Ddev 不得额外强制次日开工");
  assert.match(visible, /Ddev 生效当日即可进入 DEV-M0/);
  return `${requiredFacts.length} 项`;
});

await check("状态轴文字与视觉类同源", async () => {
  const [html, charter, schedule, ledger, scope, cost, architecture, implementation] = await Promise.all([
    readFile(targetPath, "utf8"),
    readFile(path.join(projectDir, "00-项目章程.md"), "utf8"),
    readFile(path.join(projectDir, "01-总排期与阶段门禁.md"), "utf8"),
    readFile(path.join(projectDir, "02-G0责任与证据台账.md"), "utf8"),
    readFile(path.join(projectDir, "03-Scope与验收.md"), "utf8"),
    readFile(path.join(projectDir, "04-费用与成本控制.md"), "utf8"),
    readFile(path.join(projectDir, "20-设计-进行中/37-架构SSOT-v1.md"), "utf8"),
    readFile(path.join(projectDir, "20-设计-进行中/46-实现设计-开工包.md"), "utf8"),
  ]);
  const projectStatus = deriveProjectStatus({
    charter,
    schedule,
    ledger,
    scope,
    cost,
    architecture,
    implementation,
  });
  const expectedClasses = expectedStatusAxisClasses(projectStatus);
  for (const [axis, expectedClass] of Object.entries(expectedClasses)) {
    const openingTags = [
      ...html.matchAll(
        new RegExp(
          `<[a-z][\\w:-]*\\b(?=[^>]*\\bdata-status-axis=["']${axis}["'])[^>]*>`,
          "gi"
        )
      ),
    ].map((match) => match[0]);
    assert.equal(openingTags.length, 1, `状态轴 ${axis} 必须唯一`);
    const classValue = openingTags[0].match(/\sclass=(["'])([^"']*)\1/i)?.[2] || "";
    const classNames = new Set(classValue.split(/\s+/).filter(Boolean));
    assert.equal(classNames.has(expectedClass), true, `${axis} 缺少 ${expectedClass}`);
    assert.equal(
      classNames.has(expectedClass === "confirmed" ? "pending" : "confirmed"),
      false,
      `${axis} 同时保留了冲突视觉类`
    );
  }
  return `${Object.keys(expectedClasses).length}/7 状态轴`;
});

await check("Ddev 摘要计数与 G0 / Scope 真源同源", async () => {
  const [html, charter, schedule, ledger, scope, cost, architecture, implementation] = await Promise.all([
    readFile(targetPath, "utf8"),
    readFile(path.join(projectDir, "00-项目章程.md"), "utf8"),
    readFile(path.join(projectDir, "01-总排期与阶段门禁.md"), "utf8"),
    readFile(path.join(projectDir, "02-G0责任与证据台账.md"), "utf8"),
    readFile(path.join(projectDir, "03-Scope与验收.md"), "utf8"),
    readFile(path.join(projectDir, "04-费用与成本控制.md"), "utf8"),
    readFile(path.join(projectDir, "20-设计-进行中/37-架构SSOT-v1.md"), "utf8"),
    readFile(path.join(projectDir, "20-设计-进行中/46-实现设计-开工包.md"), "utf8"),
  ]);
  const projectStatus = deriveProjectStatus({
    charter,
    schedule,
    ledger,
    scope,
    cost,
    architecture,
    implementation,
  });
  const ddevMatches = [
    ...html.matchAll(
      /(<([a-z][\w:-]*)\b[^>]*\bdata-contract\s*=\s*(["'])ddev\3[^>]*>)([\s\S]*?)(<\/\2>)/gi
    ),
  ];
  assert.equal(ddevMatches.length, 1, "data-contract=ddev 必须唯一");

  const attributes = htmlAttributes(ddevMatches[0][1]);
  const ddevVisible = visibleHtmlText(ddevMatches[0][0]);
  const completed = projectStatus.externalPass + projectStatus.scopePass;
  const total = projectStatus.externalTotal + projectStatus.scopeTotal;
  assert.deepEqual(
    {
      externalPass: attributes["data-external-pass"],
      externalTotal: attributes["data-external-total"],
      scopePass: attributes["data-scope-pass"],
      scopeTotal: attributes["data-scope-total"],
      completed: attributes["data-pass"],
      total: attributes["data-total"],
    },
    {
      externalPass: String(projectStatus.externalPass),
      externalTotal: String(projectStatus.externalTotal),
      scopePass: String(projectStatus.scopePass),
      scopeTotal: String(projectStatus.scopeTotal),
      completed: String(completed),
      total: String(total),
    }
  );
  assert.ok(
    ddevVisible.includes(
      `外部责任包 ${projectStatus.externalPass} / ${projectStatus.externalTotal}`
    ),
    "Ddev 摘要的外部责任包计数不同源"
  );
  assert.ok(
    ddevVisible.includes(`Scope 检查 ${projectStatus.scopePass} / ${projectStatus.scopeTotal}`),
    "Ddev 摘要的 Scope 计数不同源"
  );

  const visible = visibleHtmlText(html);
  assert.ok(visible.includes(`当前只完成 ${completed} / ${total} 项准备`), "Ddev 完成总计不同源");
  assert.ok(visible.includes(`已经确认 · ${completed} / ${total}`), "Ddev 确认总计不同源");
  return `外部 ${projectStatus.externalPass}/${projectStatus.externalTotal}；Scope ${projectStatus.scopePass}/${projectStatus.scopeTotal}；总计 ${completed}/${total}`;
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

      if (viewport.name === "mobile-wide") {
        await check(`${viewport.name} · 真源 HTML 表格限定在弹窗内滚动`, async () => {
          await page.locator(".source-maintenance").evaluate((element) => (element.open = true));
          const trigger = page.locator('button[data-source-id="charter"]');
          await trigger.click();
          const wrapper = page.locator("#source-dialog-content .source-table-wrap").first();
          assert.equal(await wrapper.isVisible(), true);
          const dimensions = await wrapper.evaluate((element) => ({
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            documentOverflow:
              document.documentElement.scrollWidth - document.documentElement.clientWidth,
          }));
          assert.ok(dimensions.scrollWidth > dimensions.clientWidth, JSON.stringify(dimensions));
          assert.ok(dimensions.documentOverflow <= 1, JSON.stringify(dimensions));
          await page.keyboard.press("Escape");
          assert.equal(await page.evaluate(() => document.activeElement?.dataset.sourceId), "charter");
          await page.locator(".source-maintenance").evaluate((element) => (element.open = false));
          return `${dimensions.clientWidth}/${dimensions.scrollWidth}px`;
        });
      }
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
      await check("页内导航与交付目标全部有效", async () => {
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

      await check("顶部章节与 Hero 入口逐一真实点击", async () => {
        const localLinks = page.locator('.top-nav a[href^="#"], .hero-actions a[href^="#"]');
        const count = await localLinks.count();
        assert.ok(count >= 9, `页内业务入口数量异常：${count}`);
        for (let index = 0; index < count; index += 1) {
          const link = localLinks.nth(index);
          const href = await link.getAttribute("href");
          await link.click();
          await page.waitForFunction(
            (expected) => location.hash === expected,
            href
          );
          assert.equal(await page.locator(href).count(), 1, `目标不唯一：${href}`);
          assert.equal(await page.locator(href).isVisible(), true, `目标不可见：${href}`);
        }
        return `${count}/${count}`;
      });

      await check("7 份真源均使用安全只读弹窗", async () => {
        const payload = await page.locator("#portable-project-data").evaluate((element) =>
          JSON.parse(element.textContent)
        );
        const sourceButtons = page.locator('button[data-source-id]');
        assert.equal(await page.locator('a[href$=".md"]').count(), 0, "PRD 不得保留可绕过的 Markdown 跳转");
        assert.equal(payload.sources.length, 7);
        assert.equal(await sourceButtons.count(), 7);
        await page.locator(".source-maintenance").evaluate((element) => (element.open = true));
        try {
          for (const [index, source] of payload.sources.entries()) {
            const sourceText = await readFile(path.join(path.dirname(targetPath), source.file), "utf8");
            assert.equal(source.content, sourceText, `${source.file} 内置内容不一致`);
            assert.equal(source.sha256, sha256(sourceText), `${source.file} 哈希不一致`);
            const trigger = sourceButtons.nth(index);
            await trigger.click();
            assert.equal(await page.locator("#source-dialog").isVisible(), true);
            assert.equal(await page.locator("#source-dialog-title").innerText(), source.label);
            assert.match(
              await page.locator("#source-dialog-meta").innerText(),
              new RegExp(source.sha256.slice(0, 12))
            );
            const renderedSource = page.locator("#source-dialog-content");
            const sourceHeading = sourceText.match(/^#\s+(.+)$/m)?.[1];
            assert.equal(await renderedSource.getAttribute("data-rendered-format"), "html");
            assert.ok(sourceHeading, `${source.file} 缺少文档标题`);
            assert.match(await renderedSource.innerText(), new RegExp(sourceHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            assert.ok(await renderedSource.locator("h3").count(), `${source.file} 未渲染 HTML 标题`);
            assert.ok(await renderedSource.locator("table").count(), `${source.file} 未渲染 HTML 表格`);
            assert.equal(await renderedSource.locator("a[href], script, style").count(), 0);
            const tableLabels = await renderedSource
              .locator('.source-table-wrap[role="region"]')
              .evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")));
            assert.deepEqual(
              tableLabels,
              tableLabels.map(
                (_, tableIndex) => `真源数据表 ${tableIndex + 1}/${tableLabels.length}，可横向滚动`
              ),
              `${source.file} 表格地标名称不唯一`
            );
            const leakedMarkdown = await renderedSource.evaluate((element) => {
              const leaks = [];
              const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
              let current = walker.nextNode();
              while (current) {
                if (!current.parentElement?.closest("pre, code")) {
                  for (const line of current.nodeValue.split(/\r?\n/)) {
                    if (
                      /^[ \t]*#{1,6}[ \t]+/.test(line) ||
                      /^[ \t]*-{3,}[ \t]*$/.test(line) ||
                      /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/.test(line)
                    ) {
                      leaks.push(line);
                    }
                  }
                }
                current = walker.nextNode();
              }
              return leaks;
            });
            assert.deepEqual(leakedMarkdown, [], `${source.file} 泄露原始 Markdown 标记`);
            if (index === 0) {
              const dialogAxe = await page.evaluate(async () =>
                window.axe.run(document, {
                  runOnly: {
                    type: "tag",
                    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
                  },
                })
              );
              assert.deepEqual(
                dialogAxe.violations.map((violation) => ({
                  id: violation.id,
                  impact: violation.impact,
                  nodes: violation.nodes.length,
                })),
                [],
                "真源弹窗打开态存在 WCAG A/AA 违规"
              );
              const landmarkAudit = await page.evaluate(async () =>
                window.axe.run(document, {
                  runOnly: { type: "rule", values: ["landmark-unique"] },
                })
              );
              assert.deepEqual(
                landmarkAudit.violations.map((violation) => violation.id),
                [],
                "真源表格地标名称不唯一"
              );
              await page.keyboard.press("Shift+Tab");
              assert.equal(
                await page.evaluate(() => document.querySelector("#source-dialog").contains(document.activeElement)),
                true,
                "Shift+Tab 后焦点逃出真源弹窗"
              );
              await page.keyboard.press("Tab");
              assert.equal(await page.evaluate(() => document.activeElement?.id), "source-dialog-close");
              await page.keyboard.press("Escape");
            } else if (index === 1) {
              await page.mouse.click(5, 5);
            } else {
              await page.locator("#source-dialog-close").click();
            }
            assert.equal(await page.locator("#source-dialog").isVisible(), false);
            assert.equal(
              await page.evaluate(() => document.activeElement?.dataset.sourceId),
              source.id,
              `${source.id} 关闭后焦点未恢复`
            );
          }
        } finally {
          await page.locator("#source-dialog").evaluate((element) => {
            if (element.open) element.close();
          });
          await page.locator(".source-maintenance").evaluate((element) => (element.open = false));
        }
        return "7/7 安全 HTML 结构化阅读、哈希、axe、焦点与 Esc / 背景 / 按钮关闭";
      });

      await check("资源情景切换与 URL 深链", async () => {
        const soloButton = page.getByRole("button", { name: "单人全栈" });
        const teamButton = page.getByRole("button", { name: "完整小队" });
        await soloButton.click();
        assert.equal(
          await soloButton.getAttribute("aria-pressed"),
          "true"
        );
        assert.match(await page.locator("#scenario-output").innerText(), /11-20/);
        assert.match(page.url(), /resource=solo/);
        await page.reload({ waitUntil: "load" });
        assert.equal(await soloButton.getAttribute("aria-pressed"), "true");
        assert.match(await page.locator("#scenario-output").innerText(), /11-20/);
        await teamButton.click();
        assert.match(await page.locator("#scenario-output").innerText(), /09-11/);
        assert.match(page.url(), /resource=team/);
        await page.goBack();
        await page.waitForFunction(() => new URL(location.href).searchParams.get("resource") === "solo");
        assert.equal(await soloButton.getAttribute("aria-pressed"), "true");
        assert.match(await page.locator("#scenario-output").innerText(), /11-20/);
        await page.goForward();
        await page.waitForFunction(() => new URL(location.href).searchParams.get("resource") === "team");
        assert.equal(await teamButton.getAttribute("aria-pressed"), "true");
        assert.match(await page.locator("#scenario-output").innerText(), /09-11/);
        return "solo → reload → team → Back solo → Forward team";
      });

      await check("脑图弹窗、缩放、复位、焦点与 Esc", async () => {
        const opener = page.locator("#map-open");
        assert.equal(
          await opener.getAttribute("aria-label"),
          "放大查看客服 Agent 一期最小闭环"
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

    await check(`${viewport.name} · 全部交互结束后仍无运行时错误`, async () => {
      assert.deepEqual(consoleErrors, [], `console error：${consoleErrors.join(" | ")}`);
      assert.deepEqual(pageErrors, [], `page error：${pageErrors.join(" | ")}`);
      assert.deepEqual(failedRequests, [], `失败请求：${failedRequests.join(" | ")}`);
      assert.deepEqual(externalRequests, [], `外部请求：${externalRequests.join(" | ")}`);
      return "0 console / page / request error，0 外部请求";
    });

    await context.close();
  }

  await check("单文件隔离交付·真源阅读与 PRD ↔ 执行中心闭环", async () => {
    const portableDir = await mkdtemp(path.join(tmpdir(), "customer-agent-prd-portable-"));
    const portablePath = path.join(portableDir, "客服Agent立项PRD-单文件.html");
    const portableUrl = pathToFileURL(portablePath).href;
    let context;
    try {
      await copyFile(targetPath, portablePath);
      context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: "light",
        reducedMotion: "no-preference",
        locale: "zh-CN",
      });
      const page = await context.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      const failedRequests = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("requestfailed", (request) => {
        failedRequests.push(`${request.url()} · ${request.failure()?.errorText || "unknown"}`);
      });

      await page.goto(portableUrl, { waitUntil: "load" });
      assert.equal(await page.title(), "客服 Agent 一期 · 需求会项目说明");
      assert.equal(page.url(), portableUrl, "应先从仅有 PRD 的隔离目录打开");

      await page.locator(".source-maintenance > summary").click();
      const charterLink = page.locator('[data-source-id="charter"]');
      await charterLink.focus();
      await charterLink.click();
      assert.equal(
        await page.locator("#source-dialog").evaluate((element) => element.open),
        true,
        "PRD 内置真源未打开"
      );
      assert.match(
        await page.locator("#source-dialog-content").innerText(),
        /CS-AI-C11/,
        "PRD 内置真源内容不完整"
      );
      await page.keyboard.press("Escape");
      assert.equal(
        await page.evaluate(() => document.activeElement?.dataset.sourceId),
        "charter",
        "PRD 真源弹窗关闭后焦点未恢复"
      );

      const executionCenterButton = page.locator("#open-execution-center");
      assert.equal(await executionCenterButton.evaluate((element) => element.tagName), "BUTTON");
      assert.equal(await executionCenterButton.getAttribute("href"), null);
      await executionCenterButton.click();
      await page.waitForFunction(() => document.title === "客服 Agent 一期 · 项目执行中心");
      assert.equal(new URL(page.url()).protocol, "file:");
      assert.equal(fileURLToPath(new URL(page.url())), portablePath);
      assert.equal(new URL(page.url()).searchParams.get("portable"), "hub");
      assert.doesNotMatch(page.url(), /^(?:blob|chrome-error):/);
      assert.doesNotMatch(
        await page.locator("body").innerText(),
        /ERR_FILE_NOT_FOUND|无法访问您的文件/,
        "执行中心进入了浏览器错误页"
      );

      await page.reload({ waitUntil: "load" });
      await page.waitForFunction(() => document.title === "客服 Agent 一期 · 项目执行中心");
      assert.equal(new URL(page.url()).searchParams.get("portable"), "hub");
      assert.doesNotMatch(await page.locator("body").innerText(), /ERR_FILE_NOT_FOUND/);

      await page.goBack({ waitUntil: "load" });
      await page.waitForFunction(() => document.title === "客服 Agent 一期 · 需求会项目说明");
      assert.equal(new URL(page.url()).searchParams.get("portable"), null);
      await page.goForward({ waitUntil: "load" });
      await page.waitForFunction(() => document.title === "客服 Agent 一期 · 项目执行中心");
      assert.equal(new URL(page.url()).searchParams.get("portable"), "hub");

      await page.locator("#source-drawer > summary").click();
      await page.locator('button[data-source-id="charter"]').click();
      assert.equal(
        await page.locator("#source-dialog").evaluate((element) => element.open),
        true,
        "执行中心内置真源未打开"
      );
      assert.match(await page.locator("#source-dialog-content").innerText(), /CS-AI-C11/);
      await page.locator("#source-dialog-close").click();

      const returnToPrdButton = page.locator("#return-to-prd");
      assert.equal(await returnToPrdButton.evaluate((element) => element.tagName), "BUTTON");
      assert.equal(await returnToPrdButton.getAttribute("href"), null);
      await returnToPrdButton.click();
      await page.waitForFunction(() => document.title === "客服 Agent 一期 · 需求会项目说明");
      assert.equal(new URL(page.url()).protocol, "file:");
      assert.equal(fileURLToPath(new URL(page.url())), portablePath);
      assert.equal(new URL(page.url()).searchParams.get("portable"), null);
      assert.doesNotMatch(await page.locator("body").innerText(), /ERR_FILE_NOT_FOUND/);

      await page.locator("#open-execution-center").click();
      await page.waitForFunction(() => document.title === "客服 Agent 一期 · 项目执行中心");
      assert.equal(new URL(page.url()).searchParams.get("portable"), "hub");
      assert.doesNotMatch(page.url(), /^(?:blob|chrome-error):/);

      assert.deepEqual(consoleErrors, [], `console error：${consoleErrors.join(" | ")}`);
      assert.deepEqual(pageErrors, [], `page error：${pageErrors.join(" | ")}`);
      assert.deepEqual(failedRequests, [], `失败请求：${failedRequests.join(" | ")}`);
      return "隔离 PRD → Hub → reload → Back / Forward → 真源 → PRD → Hub，0 错误页";
    } finally {
      if (context) await context.close();
      try {
        await unlink(portablePath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await rmdir(portableDir);
    }
  });

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
