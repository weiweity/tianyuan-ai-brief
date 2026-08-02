import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createSafeResultsDir } from "../../web-decision-brief/tests/support/safe-results-dir.mjs";
import {
  resolveCustomerProjectQaPaths,
  resolveCustomerProjectWorkspace,
} from "./project_workspace.mjs";
import { FACT_CARD_FIELD_LIMITS } from "./customer_project_surface_model.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const workspace = await resolveCustomerProjectWorkspace(import.meta.url);
const { projectDir } = workspace;
const webRoot = path.join(repoRoot, "web-decision-brief");
const requireFromWeb = createRequire(path.join(webRoot, "package.json"));
const { chromium } = requireFromWeb("playwright");
const axeSource = requireFromWeb("axe-core").source;

const targetPath = path.join(projectDir, "09-客服Agent需求会汇报.html");
const targetUrl = pathToFileURL(targetPath).href;
const templatePath = path.join(
  repoRoot,
  "business-docs/08-工具/templates/customer-agent-meeting.template.html"
);
const roundArg = process.argv.find((value) => value.startsWith("--round="));
const round = roundArg ? roundArg.slice("--round=".length) : "manual";
const qaPaths = resolveCustomerProjectQaPaths(workspace, "meeting");
const resultsDir = await createSafeResultsDir({
  trustedRootPath: qaPaths.trustedRootPath,
  rootPath: qaPaths.rootPath,
  prefix: "round",
  label: round,
  requestedPath: process.env.MEETING_QA_RESULTS_DIR,
});

const viewports = [
  { name: "projector-small", width: 1024, height: 768 },
  { name: "projector-wide", width: 1366, height: 768 },
  { name: "desktop", width: 1440, height: 900 },
  { name: "full-hd", width: 1920, height: 1080 },
  { name: "mobile", width: 390, height: 844 },
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

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function assertExactKeys(value, keys, label) {
  assert.deepEqual(Object.keys(value || {}).sort(), [...keys].sort(), `${label} 字段越界`);
}

function assertNoHeadingSkip(levels) {
  for (let index = 1; index < levels.length; index += 1) {
    assert.ok(
      levels[index] <= levels[index - 1] + 1,
      `标题层级从 h${levels[index - 1]} 跳到 h${levels[index]}`
    );
  }
}

function parsePayload(html) {
  const match = html.match(
    /<script id="meeting-data" type="application\/json">([\s\S]*?)<\/script>/
  );
  assert.ok(match, "缺少 meeting-data");
  return JSON.parse(match[1]);
}

await check("模板占位符契约", async () => {
  const template = await readFile(templatePath, "utf8");
  const placeholders = [...template.matchAll(/__[A-Z][A-Z0-9_]*__/g)].map(
    (match) => match[0]
  );
  assert.deepEqual([...new Set(placeholders)].sort(), [
    "__APPLE_TOUCH_ICON_DATA_URI__",
    "__BRAND_LOGO_DATA_URI__",
    "__FAVICON_DATA_URI__",
    "__MEETING_DATA__",
    "__PRETEXT_VENDOR__",
    "__RELEASE_ID__",
  ]);
  assert.equal(countMatches(template, /__MEETING_DATA__/g), 1);
  assert.equal(countMatches(template, /__PRETEXT_VENDOR__/g), 1);
  assert.ok(countMatches(template, /__RELEASE_ID__/g) >= 1);
  assert.match(template, /\bprepare\(/);
  assert.match(template, /\blayout\(/);
  assert.match(template, /new ResizeObserver\(/);
  assert.doesNotMatch(template, /contenteditable/i);
  assert.doesNotMatch(template, /\.innerHTML\s*=/);
  return `${placeholders.length} 个占位符引用`;
});

await check("生成物新鲜度 --check", async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["business-docs/08-工具/generate_customer_agent_meeting.mjs", "--check"],
    { cwd: repoRoot }
  );
  assert.equal(stderr, "");
  assert.ok(stdout.trim(), "--check 没有输出结果");
  return stdout.trim();
});

await check("安全数据白名单与会议契约", async () => {
  const html = await readFile(targetPath, "utf8");
  const payload = parsePayload(html);
  assertExactKeys(payload, ["project", "state", "meeting", "release"], "payload");
  assertExactKeys(payload.project, ["name", "code"], "project");
  assertExactKeys(payload.state, ["approval", "direction", "development"], "state");
  assertExactKeys(
    payload.meeting,
    ["agenda", "decisions", "decisionOptions", "coreQuestions", "factCards"],
    "meeting"
  );
  assertExactKeys(payload.release, ["id"], "release");
  assert.match(payload.release.id, /^meeting-v1-[a-f0-9]{12}$/);
  assert.equal(payload.release.id, documentRelease(html));
  assert.equal(payload.meeting.agenda.length, 8);
  payload.meeting.agenda.forEach((item, index) => {
    assertExactKeys(item, ["topic", "decision"], `agenda[${index}]`);
  });
  assert.equal(payload.meeting.decisions.length, 9);
  payload.meeting.decisions.forEach((item, index) => {
    assertExactKeys(item, ["title"], `decisions[${index}]`);
  });
  assert.deepEqual(payload.meeting.decisionOptions, [
    { value: "confirmed", label: "已确认" },
    { value: "confirm-on-site", label: "待共同确认" },
    { value: "needs-evidence", label: "待补材料" },
    { value: "not-in-this-meeting", label: "本次暂不决定" },
  ]);
  assert.equal(payload.meeting.decisions[7].title, "使用环境与限制");
  assert.equal(payload.meeting.decisions[2].title, "一期做到哪一步");
  assert.equal(payload.meeting.factCards.length <= 2, true);
  payload.meeting.factCards.forEach((item, index) => {
    assertExactKeys(
      item,
      ["userType", "platform", "task", "frequency", "currentFlow", "impact", "status"],
      `factCards[${index}]`
    );
    Object.values(item).forEach((value) => assert.equal(typeof value, "string"));
  });
  assert.equal(payload.meeting.coreQuestions.every((item) => typeof item === "string"), true);
  assert.deepEqual(payload.meeting.coreQuestions, [
    "结合刚才两个真实任务，哪一个最该成为一期唯一主问题？",
    "这个主问题的损失或卡点，能否拿出可核对的证据？",
    "能否在 3–5 名坐席的小范围试点中先验证改善？",
  ]);
  assert.doesNotMatch(JSON.stringify(payload), /"(?:date|time|sourceDate)"\s*:/);
  assert.doesNotMatch(
    payload.meeting.agenda.map((item) => item.decision).join("\n"),
    /\b(?:DEC|PRECONFIRM|PARKING)\b/
  );
  assert.equal(
    payload.meeting.agenda.at(-1).decision,
    "只有结论能被全场复述，才选择“已确认”；其余事项写清负责人、补充内容、确认日期与位置。"
  );
  return "4 个顶层白名单 · 8 段议程 · 9 项结果 · 4 种选择";
});

function documentRelease(html) {
  return html.match(/<html\b[^>]*\bdata-release="([^"]+)"/)?.[1] || "";
}

await check("生成文件无内部内容与外部依赖", async () => {
  const html = await readFile(targetPath, "utf8");
  const forbidden = [
    /\bsources\b/i,
    /portablePrd/i,
    /\bG0(?:-|\b)/i,
    /\bRACI\b/i,
    /\bEVD-/i,
    /\bROLE-/i,
    /\bUSR-/i,
    /费用|风险/,
    /<a\b[^>]*href=["']https?:/i,
    /<script\b[^>]*src=/i,
    /<link\b[^>]*href=["']https?:/i,
    /\.md(?:["'#?\s<]|$)/i,
  ];
  const hits = forbidden.filter((pattern) => pattern.test(html)).map(String);
  assert.deepEqual(hits, [], `发现禁区内容：${hits.join("、")}`);
  assert.match(html, /GENERATED FILE — safe meeting view; DO NOT EDIT/);
  assert.doesNotMatch(
    html,
    /__MEETING_DATA__|__PRETEXT_VENDOR__|__RELEASE_ID__|__BRAND_LOGO_DATA_URI__|__FAVICON_DATA_URI__|__APPLE_TOUCH_ICON_DATA_URI__/
  );
  assert.doesNotMatch(html, /contenteditable/i);
  assert.doesNotMatch(html, /\bfetch\s*\(|XMLHttpRequest|new WebSocket\s*\(/);
  assert.match(html, /<img class="brand-logo" src="data:image\/png;base64,[^"]+" alt="SHINE MAGE">/);
  assert.match(
    html,
    /<link rel="icon" href="data:image\/png;base64,[^"]+" type="image\/png" sizes="64x64">/
  );
  assert.match(
    html,
    /<link rel="apple-touch-icon" href="data:image\/png;base64,[^"]+" sizes="180x180">/
  );
  for (const removedTimeUi of [
    /id="meeting-clock"/,
    /id="meeting-time"/,
    /id="timer-toggle"/,
    /data-project-date/,
    /data-agenda-time/,
    /class="time-chip"/,
    /8 月 4 日/,
    /2026-08-04/,
    /60:00/,
    /开始计时|暂停计时|全场剩余/,
  ]) {
    assert.doesNotMatch(html, removedTimeUi);
  }
  const fileStat = await stat(targetPath);
  assert.ok(fileStat.size < 700_000, `HTML 体积 ${fileStat.size} bytes`);
  return `${fileStat.size} bytes · 0 外链`;
});

await check("隔离工作区生成安全、幂等与并发保护", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "customer-meeting-qa-"));
  const isolatedProject = path.join(sandbox, "customer-project");
  const isolatedOutput = path.join(isolatedProject, "09-客服Agent需求会汇报.html");
  const isolatedEnv = {
    ...process.env,
    CUSTOMER_PROJECT_MODE: "private",
    CUSTOMER_PROJECT_ROOT: isolatedProject,
  };
  const generatorArgs = ["business-docs/08-工具/generate_customer_agent_meeting.mjs"];
  try {
    await mkdir(isolatedProject, { recursive: true });
    await writeFile(
      path.join(isolatedProject, ".customer-project-private.json"),
      `${JSON.stringify({ schemaVersion: 1, visibility: "private" })}\n`,
      "utf8"
    );
    for (const file of [
      "00-项目章程.md",
      "01-总排期与阶段门禁.md",
      "02-G0责任与证据台账.md",
      "03-Scope与验收.md",
      "04-费用与成本控制.md",
      "05-全栈交付计划.md",
      "06-启动会与周推进.md",
      "07-客服Agent立项PRD.html",
    ]) {
      await copyFile(path.join(projectDir, file), path.join(isolatedProject, file));
    }

    const isolatedLedger = path.join(isolatedProject, "02-G0责任与证据台账.md");
    const ledgerBaseline = await readFile(isolatedLedger, "utf8");
    const emptyFactRow = "| FACT-01 | | | | | | | OPEN |";
    const oversizedFactRow = `| FACT-01 | | | ${"客".repeat(FACT_CARD_FIELD_LIMITS.task + 1)} | | | | OPEN |`;
    await writeFile(isolatedLedger, ledgerBaseline.replace(emptyFactRow, oversizedFactRow), "utf8");
    await assert.rejects(
      execFileAsync(process.execPath, generatorArgs, { cwd: repoRoot, env: isolatedEnv }),
      (error) => /FACT-01.*任务.*最多 36 个字符/.test(`${error.stderr || ""}${error.stdout || ""}`)
    );
    const sensitiveFactRow = "| FACT-01 | | | 13800138000 | | | | OPEN |";
    await writeFile(isolatedLedger, ledgerBaseline.replace(emptyFactRow, sensitiveFactRow), "utf8");
    await assert.rejects(
      execFileAsync(process.execPath, generatorArgs, { cwd: repoRoot, env: isolatedEnv }),
      (error) => /FACT-01.*包含明显敏感信息/.test(`${error.stderr || ""}${error.stdout || ""}`)
    );
    await writeFile(isolatedLedger, ledgerBaseline, "utf8");

    await execFileAsync(process.execPath, generatorArgs, { cwd: repoRoot, env: isolatedEnv });
    const firstBytes = await readFile(isolatedOutput);
    const firstStat = await stat(isolatedOutput);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await execFileAsync(process.execPath, generatorArgs, { cwd: repoRoot, env: isolatedEnv });
    const secondBytes = await readFile(isolatedOutput);
    const secondStat = await stat(isolatedOutput);
    assert.deepEqual(secondBytes, firstBytes, "连续生成 bytes 发生变化");
    assert.equal(secondStat.mtimeMs, firstStat.mtimeMs, "无变化生成仍改写 mtime");

    await writeFile(isolatedOutput, `${secondBytes.toString("utf8")}\nSTALE`, "utf8");
    await assert.rejects(
      execFileAsync(process.execPath, [...generatorArgs, "--check"], {
        cwd: repoRoot,
        env: isolatedEnv,
      }),
      (error) => /已过期/.test(`${error.stderr || ""}${error.stdout || ""}`)
    );
    await execFileAsync(process.execPath, generatorArgs, { cwd: repoRoot, env: isolatedEnv });

    const symlinkTarget = path.join(sandbox, "outside-target.html");
    await writeFile(symlinkTarget, "OUTSIDE_UNCHANGED", "utf8");
    await unlink(isolatedOutput);
    await symlink(symlinkTarget, isolatedOutput);
    await assert.rejects(
      execFileAsync(process.execPath, generatorArgs, { cwd: repoRoot, env: isolatedEnv }),
      (error) => /符号链接/.test(`${error.stderr || ""}${error.stdout || ""}`)
    );
    assert.equal(await readFile(symlinkTarget, "utf8"), "OUTSIDE_UNCHANGED");
    assert.equal((await lstat(isolatedOutput)).isSymbolicLink(), true);
    await unlink(isolatedOutput);

    const concurrent = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        execFileAsync(process.execPath, generatorArgs, { cwd: repoRoot, env: isolatedEnv })
      )
    );
    assert.equal(concurrent.some((result) => result.status === "fulfilled"), true);
    concurrent
      .filter((result) => result.status === "rejected")
      .forEach((result) => {
        assert.match(
          `${result.reason?.stderr || ""}${result.reason?.stdout || ""}`,
          /生成期间发生变化|拒绝覆盖/
        );
      });
    await execFileAsync(process.execPath, [...generatorArgs, "--check"], {
      cwd: repoRoot,
      env: isolatedEnv,
    });
    const leftovers = (await readdir(isolatedProject)).filter((file) =>
      file.includes(".update-") && file.endsWith(".tmp")
    );
    assert.deepEqual(leftovers, [], `遗留原子临时文件：${leftovers.join("、")}`);

    await assert.rejects(
      execFileAsync(process.execPath, [...generatorArgs, "--output=../escape.html"], {
        cwd: repoRoot,
        env: isolatedEnv,
      }),
      (error) => /用法/.test(`${error.stderr || ""}${error.stdout || ""}`)
    );
    return "bytes/mtime 幂等 · stale 拒绝 · symlink 拒绝 · 6 路并发 · tmp 0";
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

const browserLaunchOptions = process.env.CI
  ? { headless: true }
  : { channel: "chrome", headless: true };
if (process.env.CHROME_PATH) {
  delete browserLaunchOptions.channel;
  browserLaunchOptions.executablePath = process.env.CHROME_PATH;
}

const browser = await chromium.launch(browserLaunchOptions);

async function attachHealthCollectors(page) {
  const health = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    externalRequests: [],
  };
  page.on("console", (message) => {
    if (message.type() === "error") health.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => health.pageErrors.push(error.message));
  page.on("requestfailed", (request) =>
    health.failedRequests.push(`${request.url()} · ${request.failure()?.errorText || "unknown"}`)
  );
  page.on("request", (request) => {
    const protocol = new URL(request.url()).protocol;
    if (!["file:", "data:", "blob:"].includes(protocol)) {
      health.externalRequests.push(request.url());
    }
  });
  return health;
}

function assertHealthy(health) {
  assert.deepEqual(health.consoleErrors, []);
  assert.deepEqual(health.pageErrors, []);
  assert.deepEqual(health.failedRequests, []);
  assert.deepEqual(health.externalRequests, []);
}

try {
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      colorScheme: "light",
      reducedMotion: "no-preference",
      locale: "zh-CN",
    });
    await context.addInitScript(() => {
      window.__meetingPrintCalls = 0;
      window.print = () => {
        window.__meetingPrintCalls += 1;
      };
    });
    const page = await context.newPage();
    const health = await attachHealthCollectors(page);
    const startedAt = performance.now();
    await page.goto(targetUrl, { waitUntil: "load" });
    await page.waitForTimeout(250);
    const elapsedMs = Math.round(performance.now() - startedAt);
    results.viewports[viewport.name] = {
      width: viewport.width,
      height: viewport.height,
      elapsedMs,
      ...health,
    };

    await check(`${viewport.name} · 结构、字号与无横向溢出`, async () => {
      const structure = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        title: document.title,
        release: document.documentElement.dataset.release,
        h1Count: document.querySelectorAll("h1").length,
        headings: [...document.querySelectorAll("main h1, main h2, main h3")].map((item) =>
          Number(item.tagName.slice(1))
        ),
        slides: document.querySelectorAll(".slide").length,
        activeSlides: document.querySelectorAll(".slide.is-active").length,
        stepCountVisible: document.querySelector("#step-count").checkVisibility(),
        visibleStatePills: [...document.querySelectorAll(".state-strip .state-pill")].filter(
          (item) => item.checkVisibility()
        ).length,
        brandLogo: (() => {
          const logo = document.querySelector(".brand-logo");
          return logo
            ? {
                count: document.querySelectorAll(".brand-logo").length,
                alt: logo.getAttribute("alt"),
                source: logo.getAttribute("src")?.slice(0, 22),
                naturalWidth: logo.naturalWidth,
                naturalHeight: logo.naturalHeight,
              }
            : null;
        })(),
        favicon: document.querySelector('link[rel="icon"]')?.getAttribute("href")?.slice(0, 22),
        appleTouchIcon: document
          .querySelector('link[rel="apple-touch-icon"]')
          ?.getAttribute("href")
          ?.slice(0, 22),
        headerTitle: document.querySelector(".header-title")?.textContent.trim(),
        headerTitleVisible: document.querySelector(".header-title")?.checkVisibility(),
        headerSubtitleVisible: document.querySelector(".header-subtitle")?.checkVisibility(),
        headerSubtitleFont: parseFloat(
          getComputedStyle(document.querySelector(".header-subtitle")).fontSize
        ),
        headerChrome: (() => {
          const style = getComputedStyle(document.querySelector(".header-inner"));
          return {
            borderRadius: parseFloat(style.borderRadius),
            background: style.backgroundColor,
            borderWidth: parseFloat(style.borderTopWidth),
          };
        })(),
        surfaceEdges: (() => {
          const edge = (selector) => {
            const box = document.querySelector(selector).getBoundingClientRect();
            return { left: box.left, right: box.right, width: box.width };
          };
          return {
            header: edge(".header-inner"),
            body: edge(".slide.is-active .slide-inner"),
            footer: edge(".controls-inner"),
          };
        })(),
        bodyStage: (() => {
          const stage = document.querySelector(".slide.is-active .slide-inner");
          const style = getComputedStyle(stage);
          const box = stage.getBoundingClientRect();
          return {
            background: style.backgroundColor,
            borderRadius: parseFloat(style.borderRadius),
            borderWidth: parseFloat(style.borderTopWidth),
            boxShadow: style.boxShadow,
            left: box.left,
            right: box.right,
            height: box.height,
          };
        })(),
        deckHeight: document.querySelector(".deck").getBoundingClientRect().height,
        coverAsideBackground: getComputedStyle(document.querySelector(".cover-aside"))
          .backgroundColor,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyFont: parseFloat(getComputedStyle(document.body).fontSize),
        visibleTitleFont: parseFloat(
          getComputedStyle(document.querySelector(".slide.is-active h1, .slide.is-active h2"))
            .fontSize
        ),
        kickerTextTransform: getComputedStyle(document.querySelector(".slide-kicker")).textTransform,
        factLabels: [...document.querySelectorAll("[data-fact-card] [data-fact]")].map(
          (item) => item.textContent.trim()
        ),
        emptyFactCards: document.querySelectorAll('[data-fact-card][data-empty="true"]').length,
        visibleFactFields: [...document.querySelectorAll("[data-fact-card] .fact-fields")].filter(
          (item) => item.checkVisibility()
        ).length,
        renderedFactChecklists: [
          ...document.querySelectorAll("[data-fact-card] .fact-checklist"),
        ].filter((item) => !item.hidden).length,
        factChecklistLabels: [
          ...document.querySelectorAll("[data-fact-card] .fact-checklist li"),
        ].map((item) => item.textContent.trim()),
        payloadOpenCount: Object.values(
          JSON.parse(document.querySelector("#meeting-data").textContent).meeting.factCards
        )
          .flatMap((card) => Object.values(card))
          .filter((value) => value === "OPEN").length,
        agendaAudienceText: JSON.parse(
          document.querySelector("#meeting-data").textContent
        ).meeting.agenda.flatMap((item) => [item.topic, item.decision]),
        agendaTopics: JSON.parse(
          document.querySelector("#meeting-data").textContent
        ).meeting.agenda.map((item) => item.topic),
        agendaDecisions: JSON.parse(
          document.querySelector("#meeting-data").textContent
        ).meeting.agenda.map((item) => item.decision),
        directionQuestions: [...document.querySelectorAll("#core-question-list .question-card")].map(
          (item) => item.textContent.trim()
        ),
        topicKickers: [...document.querySelectorAll(".topic-card > span")].map((item) =>
          item.textContent.trim()
        ),
        decisionSelectCount: document.querySelectorAll(".decision-select").length,
        decisionOptionLabels: [...document.querySelector(".decision-select").options].map(
          (item) => item.textContent.trim()
        ),
        decisionLegend: [...document.querySelectorAll("#decision-option-legend span")].map(
          (item) => item.textContent.trim()
        ),
        decisionLegendTitle: document
          .querySelector("#decision-option-legend strong")
          ?.textContent.trim(),
        decisionLegendDots: [...document.querySelectorAll("#decision-option-legend span")].map(
          (item) => getComputedStyle(item, "::before").backgroundColor
        ),
        decisionProgress: document.querySelector("#decision-progress").textContent.trim(),
        progressTrackVisible: document.querySelector(".progress-track").checkVisibility(),
        fullscreenIconCount: document.querySelectorAll("#fullscreen-button svg").length,
        coverMark: document.querySelector(".cover-mark")?.textContent.trim(),
        coverKicker: document.querySelector(".cover .slide-kicker")?.textContent.trim(),
        coverGoal: document.querySelector(".cover-goal")?.textContent.trim(),
        coverExclusion: document.querySelector(".cover-exclusion")?.textContent.trim(),
        goalMarkers: [...document.querySelectorAll(".boundary-list li")].map((item) =>
          getComputedStyle(item, "::before").content.replaceAll('"', "")
        ),
        goalListTag: document.querySelector(".boundary-list")?.tagName,
        goalTexts: [...document.querySelectorAll(".boundary-list li")].map((item) =>
          item.textContent.trim()
        ),
      }));
      assert.equal(structure.lang, "zh-CN");
      assert.equal(structure.title, "客服 Agent 一期启动会 · 天元 · 客服 Agent 启动会");
      assert.match(structure.release, /^meeting-v1-[a-f0-9]{12}$/);
      assert.equal(structure.h1Count, 2, "正文与打印摘要各应有一个 h1");
      assert.equal(structure.slides, 9);
      assert.equal(structure.activeSlides, 1);
      assert.equal(structure.stepCountVisible, true);
      assert.equal(structure.visibleStatePills, 3);
      assert.deepEqual(structure.brandLogo, {
        count: 1,
        alt: "SHINE MAGE",
        source: "data:image/png;base64,",
        naturalWidth: 249,
        naturalHeight: 45,
      });
      assert.equal(structure.favicon, "data:image/png;base64,");
      assert.equal(structure.appleTouchIcon, "data:image/png;base64,");
      assert.equal(structure.headerTitle, "客服 Agent 一期启动会");
      assert.equal(structure.headerTitleVisible, viewport.width > 760);
      assert.equal(structure.headerSubtitleVisible, viewport.width > 760);
      if (viewport.width > 760) assert.ok(structure.headerSubtitleFont >= 11);
      assert.ok(structure.headerChrome.borderRadius >= 16, JSON.stringify(structure.headerChrome));
      assert.ok(structure.headerChrome.borderWidth >= 1, JSON.stringify(structure.headerChrome));
      assert.notEqual(structure.headerChrome.background, "rgba(0, 0, 0, 0)");
      for (const edge of ["left", "right", "width"]) {
        assert.ok(
          Math.abs(structure.surfaceEdges.header[edge] - structure.surfaceEdges.body[edge]) <= 1,
          JSON.stringify(structure.surfaceEdges)
        );
        assert.ok(
          Math.abs(structure.surfaceEdges.footer[edge] - structure.surfaceEdges.body[edge]) <= 1,
          JSON.stringify(structure.surfaceEdges)
        );
      }
      assert.equal(structure.bodyStage.background, "rgb(255, 255, 255)");
      assert.ok(structure.bodyStage.borderRadius >= 16, JSON.stringify(structure.bodyStage));
      assert.ok(structure.bodyStage.borderWidth >= 1, JSON.stringify(structure.bodyStage));
      assert.notEqual(structure.bodyStage.boxShadow, "none");
      assert.ok(structure.bodyStage.left >= 9, JSON.stringify(structure.bodyStage));
      assert.ok(
        structure.bodyStage.right <= structure.clientWidth - 9,
        JSON.stringify(structure.bodyStage)
      );
      if (viewport.width >= 1024) {
        assert.ok(
          structure.bodyStage.height >= structure.deckHeight - 24,
          JSON.stringify({ bodyStage: structure.bodyStage, deckHeight: structure.deckHeight })
        );
      }
      assert.notEqual(structure.coverAsideBackground, structure.bodyStage.background);
      assertNoHeadingSkip(structure.headings);
      assert.ok(structure.scrollWidth <= structure.clientWidth + 1, JSON.stringify(structure));
      assert.ok(structure.bodyFont >= (viewport.width >= 1024 ? 18 : 16));
      assert.ok(structure.visibleTitleFont >= 34);
      assert.equal(structure.kickerTextTransform, "none");
      assert.equal(
        structure.agendaAudienceText.some(
          (value) =>
            /\b(?:OPEN|PRECONFIRM|READY|FDE)\b|工程|客服人员|不让客服|业务输入|技术栈|技术方案|技术记录清单|需求确认会|需求会汇报|本环节请补|这里只标记|试点人口|最小闭环|回读|方案设计|待补证(?:\s*待补证)+/.test(value)
        ),
        false,
        "会场议程不得出现内部状态码或工程黑话"
      );
      assert.deepEqual(structure.agendaTopics, [
        "先对齐启动目标与参与方式",
        "一起还原两个真实任务",
        "一起确定一期主问题",
        "一起明确一期先做到哪一步",
        "一起确认成功与停止条件",
        "一起确认可靠的内容依据",
        "一起确认试点与真实使用环境",
        "确认启动结果与下一步",
      ]);
      assert.equal(
        structure.agendaDecisions[6],
        "确认试点人员、班次、设备、网络限制和使用高峰。"
      );
      assert.equal(
        structure.agendaDecisions[2],
        "先用三问判断；下方常见表现不是选项，可改、可删，也可以提出其他真实问题。"
      );
      assert.match(structure.agendaDecisions[3], /^基于刚才确定的一期主问题/);
      assert.match(structure.agendaDecisions[7], /结论能被全场复述/);
      assert.deepEqual(structure.directionQuestions, [
        "结合刚才两个真实任务，哪一个最该成为一期唯一主问题？",
        "这个主问题的损失或卡点，能否拿出可核对的证据？",
        "能否在 3–5 名坐席的小范围试点中先验证改善？",
      ]);
      assert.deepEqual(structure.topicKickers, Array(4).fill("常见表现 · 非选项"));
      assert.equal(structure.decisionSelectCount, 9);
      assert.deepEqual(structure.decisionOptionLabels, [
        "请选择结果",
        "已确认",
        "待共同确认",
        "待补材料",
        "本次暂不决定",
      ]);
      assert.deepEqual(structure.decisionLegend, structure.decisionOptionLabels.slice(1));
      assert.equal(structure.decisionLegendTitle, "结论可复述后选择");
      assert.equal(new Set(structure.decisionLegendDots).size, 4);
      assert.equal(structure.decisionProgress, "0 / 9 已处理");
      assert.equal(structure.progressTrackVisible, true);
      assert.equal(structure.fullscreenIconCount, 1);
      assert.equal(structure.coverMark, "一期项目启动");
      assert.equal(structure.coverKicker, "客服团队 · 业务与协作对齐");
      assert.equal(structure.coverGoal, "今天共同确认一期主问题、范围、责任与下一步。");
      assert.match(structure.coverExclusion, /技术选型、开发开工与上线承诺/);
      assert.equal(structure.goalListTag, "OL");
      assert.deepEqual(structure.goalMarkers, Array(3).fill("counter(meeting-goal)"));
      assert.deepEqual(structure.goalTexts, [
        "对齐一个一期主问题",
        "明确范围、成功与试点条件",
        "确认责任、未决事项与下一步",
      ]);
      assert.equal(
        structure.factLabels.filter((value) => value === "会上确认").length,
        structure.payloadOpenCount,
        "缺失事实应保留内部 OPEN 状态，并只向参会者显示中文"
      );
      assert.equal(structure.factLabels.some((value) => /OPEN|PRECONFIRM|READY/.test(value)), false);
      assert.equal(structure.emptyFactCards, 2);
      assert.equal(structure.visibleFactFields, 0);
      assert.equal(structure.renderedFactChecklists, 2);
      assert.deepEqual(
        structure.factChecklistLabels,
        Array(2)
          .fill(["真实任务名称", "主用户", "平台", "频次 / 样本", "主要卡点", "业务影响"])
          .flat()
      );
      const meetingCallouts = await page.locator(".callout").allTextContents();
      assert.match(meetingCallouts[1], /两个真实任务名称/);
      assert.match(meetingCallouts[4], /谁上报、谁拍板、先停用并回到原流程/);
      assert.match(meetingCallouts[4], /纪要与台账/);
      assert.deepEqual(
        await page.locator(".callout").evaluateAll((items) =>
          items.map((item) => getComputedStyle(item, "::before").content.replaceAll('"', ""))
        ),
        ["结论", "会中产出", "会中产出", "验收", "会中产出", "会中产出", "用途", "输出"]
      );
      return `${structure.slides} 屏 · ${structure.scrollWidth}/${structure.clientWidth}px`;
    });

    await check(`${viewport.name} · 九屏布局边界`, async () => {
      await page.evaluate((limits) => {
        document.querySelectorAll("[data-fact-card]").forEach((card) => {
          card.dataset.empty = "false";
          card.querySelector(".fact-empty").hidden = true;
          card.querySelector(".fact-checklist").hidden = true;
          card.querySelector(".fact-fields").hidden = false;
          Object.entries(limits).forEach(([field, limit]) => {
            if (field === "status") return;
            const target = card.querySelector(`[data-fact="${field}"]`);
            if (target) target.textContent = "客".repeat(limit);
          });
          const status = card.querySelector('[data-fact="status"]');
          if (status) status.textContent = "材料已齐";
        });
      }, FACT_CARD_FIELD_LIMITS);
      const metrics = [];
      const visibleTexts = [];
      for (let index = 0; index < 9; index += 1) {
        const active = page.locator(`.slide[data-slide-index="${index}"]`);
        assert.equal(await active.isVisible(), true, `第 ${index + 1} 屏不可见`);
        visibleTexts.push(await active.innerText());
        metrics.push(
          await active.evaluate((slide) => {
            const box = slide.getBoundingClientRect();
            const inner = slide.querySelector(".slide-inner").getBoundingClientRect();
            return {
              slideHeight: box.height,
              slideScrollHeight: slide.scrollHeight,
              innerBottom: inner.bottom,
              slideBottom: box.bottom,
              innerLeft: inner.left,
              innerRight: inner.right,
              slideLeft: box.left,
              slideRight: box.right,
              overflowY: getComputedStyle(slide).overflowY,
            };
          })
        );
        if (index < 8) await page.locator("#next-slide").click();
      }
      assert.equal(await page.locator("#next-slide .button-label").isVisible(), true);
      assert.equal(await page.locator("#next-slide .button-label").innerText(), "已是最后一页");
      assert.ok(
        (await page.locator("#next-slide").boundingBox()).width >= 44,
        "末页终态按钮需保留可见语义与触控宽度"
      );
      metrics.forEach((item, index) => {
        assert.ok(item.innerLeft >= item.slideLeft - 1, `第 ${index + 1} 屏左溢出`);
        assert.ok(item.innerRight <= item.slideRight + 1, `第 ${index + 1} 屏右溢出`);
        if (viewport.width >= 1024) {
          assert.equal(item.overflowY, "hidden");
          assert.ok(item.innerBottom <= item.slideBottom + 1, `第 ${index + 1} 屏内容被裁切`);
        } else {
          assert.equal(item.overflowY, "auto");
        }
      });
      assert.equal(
        visibleTexts.some(
          (value) =>
            /\b(?:OPEN|PRECONFIRM|READY|FDE)\b|工程|客服人员|不让客服|业务输入|技术栈|技术方案|技术记录清单|需求确认会|需求会汇报|本环节请补|这里只标记|试点人口|最小闭环|标记回读|方案设计|知识 \/ 话术辅助|智能质检|反馈分析|聊天分析|待补证(?:\s*待补证)+/.test(
              value
            )
        ),
        false,
        "九屏可见文本不得泄漏内部状态码或工程黑话"
      );
      await page.screenshot({
        path: path.join(
          resultsDir,
          `${viewport.name}-readback-${viewport.width}x${viewport.height}.png`
        ),
        fullPage: true,
      });
      return viewport.width >= 1024 ? "9/9 无滚动无裁切" : "9/9 可单屏滚动";
    });

    await page.evaluate(() => sessionStorage.clear());
    await page.goto(targetUrl, { waitUntil: "load" });

    await check(`${viewport.name} · axe serious / critical 为 0`, async () => {
      await page.addScriptTag({ content: axeSource });
      const axeResult = await page.evaluate(async () =>
        window.axe.run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
          },
        })
      );
      const blockers = axeResult.violations
        .filter((violation) => ["serious", "critical"].includes(violation.impact))
        .map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          nodes: violation.nodes.length,
        }));
      assert.deepEqual(blockers, []);
      return `${axeResult.violations.length} 条非阻断项 · ${axeResult.passes.length} passes`;
    });

    if (viewport.width <= 760) {
      await check(`${viewport.name} · 可见触控目标不小于 44px`, async () => {
        const undersized = await page.locator("button, summary, a, select").evaluateAll((items) =>
          items
            .filter((item) => {
              const box = item.getBoundingClientRect();
              return (
                item.checkVisibility() &&
                getComputedStyle(item).pointerEvents !== "none" &&
                box.width > 0 &&
                box.height > 0 &&
                (box.width < 44 || box.height < 44)
              );
            })
            .map((item) => {
              const box = item.getBoundingClientRect();
              return `${item.tagName.toLowerCase()} ${Math.round(box.width)}×${Math.round(box.height)}`;
            })
        );
        assert.deepEqual(undersized, []);
        return "全部通过";
      });
    }

    await page.screenshot({
      path: path.join(resultsDir, `${viewport.name}-${viewport.width}x${viewport.height}.png`),
      fullPage: true,
    });

    assertHealthy(health);
    assert.ok(elapsedMs < 3000, `加载耗时 ${elapsedMs}ms`);
    await context.close();
  }

  await check("按钮与键盘完成九屏导航", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const health = await attachHealthCollectors(page);
    await page.goto(targetUrl, { waitUntil: "load" });
    assert.equal(await page.locator(".slide.is-active").getAttribute("data-slide-index"), "0");
    assert.equal(await page.locator("#step-count").innerText(), "封面");
    assert.match(await page.locator("#progress-label").innerText(), /启动会 · 封面$/);
    const initialTitleFrame = await page.locator("#cover-title").evaluate((item) => {
      const style = getComputedStyle(item);
      return {
        outline: style.outlineStyle,
        border: style.borderStyle,
        shadow: style.boxShadow,
      };
    });
    assert.deepEqual(initialTitleFrame, { outline: "none", border: "none", shadow: "none" });
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator(".slide.is-active").getAttribute("data-slide-index"), "1");
    assert.equal(await page.locator("#step-count").innerText(), "1 / 8");
    assert.match(await page.locator("#progress-label").innerText(), /环节 1 \/ 8$/);
    const focusedTitleFrame = await page.locator("#boundary-title").evaluate((item) => {
      const style = getComputedStyle(item);
      return {
        focused: document.activeElement === item,
        outline: style.outlineStyle,
        border: style.borderStyle,
        shadow: style.boxShadow,
      };
    });
    assert.deepEqual(focusedTitleFrame, {
      focused: true,
      outline: "none",
      border: "none",
      shadow: "none",
    });
    await page.keyboard.press("PageDown");
    assert.equal(await page.locator(".slide.is-active").getAttribute("data-slide-index"), "2");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.locator(".slide.is-active").getAttribute("data-slide-index"), "1");
    await page.keyboard.press("PageUp");
    assert.equal(await page.locator(".slide.is-active").getAttribute("data-slide-index"), "0");
    for (let index = 0; index < 8; index += 1) await page.locator("#next-slide").click();
    assert.equal(await page.locator(".slide.is-active").getAttribute("data-slide-index"), "8");
    assert.equal(await page.locator("#next-slide").isDisabled(), true);
    assert.equal(await page.locator("#next-slide .button-label").innerText(), "已是最后一页");
    assert.equal(await page.locator("#next-slide").evaluate((item) => item.classList.contains("primary")), false);
    assert.equal(await page.locator("#next-slide .next-arrow").isHidden(), true);
    assert.equal(await page.locator("#meeting-progress").getAttribute("aria-valuenow"), "8");
    assert.equal(await page.locator("#meeting-progress").getAttribute("aria-valuemax"), "8");
    assert.equal(await page.locator("#step-count").innerText(), "8 / 8");
    assertHealthy(health);
    await context.close();
    return "方向键、PageUp/PageDown、按钮全部通过";
  });

  await check("九屏逐屏 axe serious / critical 为 0", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const health = await attachHealthCollectors(page);
    await page.goto(targetUrl, { waitUntil: "load" });
    await page.addScriptTag({ content: axeSource });
    const blockers = [];
    for (let index = 0; index < 9; index += 1) {
      const violations = await page.evaluate(async () => {
        const result = await window.axe.run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
          },
        });
        return result.violations
          .filter((violation) => ["serious", "critical"].includes(violation.impact))
          .map((violation) => ({ id: violation.id, impact: violation.impact }));
      });
      blockers.push(...violations.map((violation) => ({ slide: index + 1, ...violation })));
      if (index < 8) await page.locator("#next-slide").click();
    }
    assert.deepEqual(blockers, []);
    assertHealthy(health);
    await context.close();
    return "9/9 屏无 serious / critical";
  });

  await check("页码、确认结果与 release 刷新恢复", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const health = await attachHealthCollectors(page);
    await page.goto(targetUrl, { waitUntil: "load" });
    const releaseId = await page.locator("html").getAttribute("data-release");
    const storageKey = await page.locator("html").getAttribute("data-storage-key");
    assert.ok(releaseId && storageKey);
    const staleStorageKey = "customer-agent-meeting:meeting-v1-000000000000";
    await page.evaluate((key) => sessionStorage.setItem(key, "{}"), staleStorageKey);
    await page.reload({ waitUntil: "load" });
    assert.equal(
      await page.evaluate((key) => sessionStorage.getItem(key), staleStorageKey),
      null,
      "旧 release 状态未自动失效"
    );

    await page.evaluate(
      ({ key, release }) => {
        sessionStorage.setItem(
          key,
          JSON.stringify({
            releaseId: release,
            index: 4,
            decisionStates: [
              "confirmed",
              "pending",
              "pending",
              "pending",
              "pending",
              "pending",
              "pending",
              "pending",
              "pending",
            ],
          })
        );
      },
      { key: storageKey, release: releaseId }
    );
    await page.reload({ waitUntil: "load" });
    assert.equal(await page.locator(".slide.is-active").getAttribute("data-slide-index"), "4");
    assert.equal(await page.locator(".decision-select").first().inputValue(), "confirmed");
    assert.equal(await page.locator(".decision-card").first().getAttribute("data-result"), "confirmed");
    assert.equal(await page.locator(".decision-select").nth(1).inputValue(), "pending");
    assert.equal(await page.locator("#decision-progress").innerText(), "1 / 9 已处理");
    assert.equal(await page.locator("#meeting-clock, #meeting-time, #timer-toggle").count(), 0);
    assertHealthy(health);
    await context.close();
    return "旧 release 失效 · 页码恢复 · 四态结果恢复 · 计时 UI 0";
  });

  await check("四态结果持久化与二次确认重置", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const health = await attachHealthCollectors(page);
    await page.goto(targetUrl, { waitUntil: "load" });
    const releaseId = await page.locator("html").getAttribute("data-release");
    const storageKey = await page.locator("html").getAttribute("data-storage-key");
    await page.evaluate(
      ({ key, release }) => {
        const decisionStates = Array(9).fill("pending");
        decisionStates[0] = "confirmed";
        sessionStorage.setItem(
          key,
          JSON.stringify({
            releaseId: release,
            index: 8,
            decisionStates,
          })
        );
      },
      { key: storageKey, release: releaseId }
    );
    await page.reload({ waitUntil: "load" });
    assert.equal(await page.locator(".decision-select").first().inputValue(), "confirmed");
    await page.locator(".decision-select").nth(1).selectOption("needs-evidence");
    await page.reload({ waitUntil: "load" });
    assert.equal(await page.locator(".decision-select").nth(1).inputValue(), "needs-evidence");
    assert.equal(
      await page.locator(".decision-card").nth(1).getAttribute("data-result"),
      "needs-evidence"
    );
    assert.equal(await page.locator("#decision-progress").innerText(), "2 / 9 已处理");

    await page.locator("#more-menu summary").click();
    await page.locator('#more-menu summary[aria-expanded="true"]').waitFor();
    assert.equal(await page.locator("#more-menu summary").getAttribute("aria-expanded"), "true");
    await page.locator("#reset-button").click();
    await page.locator('#more-menu summary[aria-expanded="false"]').waitFor();
    assert.equal(await page.locator("#more-menu summary").getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator("#reset-dialog").getAttribute("open"), "");
    assert.match(await page.locator("#reset-dialog").innerText(), /重置全部状态/);
    await page.locator("#reset-cancel").click();
    assert.equal(await page.locator("#reset-dialog").getAttribute("open"), null);
    assert.equal(await page.locator(".decision-select").nth(1).inputValue(), "needs-evidence");
    await page.locator("#more-menu summary").click();
    await page.locator("#reset-button").click();
    await page.locator("#reset-confirm").click();
    assert.equal(await page.locator("#reset-dialog").getAttribute("open"), null);
    assert.equal(await page.locator(".slide.is-active").getAttribute("data-slide-index"), "0");
    assert.equal(
      await page.locator(".decision-select").evaluateAll((items) =>
        items.every((item) => item.value === "pending")
      ),
      true
    );
    assert.equal(
      await page.locator(".decision-card").evaluateAll((items) =>
        items.every((item) => item.dataset.result === "pending")
      ),
      true
    );
    assert.equal(await page.locator("#decision-progress").innerText(), "0 / 9 已处理");
    assertHealthy(health);
    await context.close();
    return "9 项四态结果 · 刷新恢复 · 自定义二次确认";
  });

  await check("帮助、全屏失败降级与打印按钮", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      window.__meetingPrintCalls = 0;
      window.print = () => {
        window.__meetingPrintCalls += 1;
      };
    });
    const page = await context.newPage();
    const health = await attachHealthCollectors(page);
    await page.goto(targetUrl, { waitUntil: "load" });
    await page.keyboard.press("?");
    assert.equal(await page.locator("#help-dialog").getAttribute("open"), "");
    assert.doesNotMatch(await page.locator("#help-dialog").innerText(), /Space|计时|分钟/);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#help-dialog").getAttribute("open"), null);
    await page.evaluate(() => {
      document.documentElement.requestFullscreen = () => Promise.reject(new Error("blocked"));
    });
    await page.keyboard.press("f");
    await page.waitForTimeout(50);
    assert.match(await page.locator("#live-status").innerText(), /未进入全屏/);
    await page.locator("#more-menu summary").click();
    await page.locator("#print-button").click();
    assert.equal(await page.evaluate(() => window.__meetingPrintCalls), 1);
    assertHealthy(health);
    await context.close();
    return "? / Escape · F 降级 · print";
  });

  await check("sessionStorage 不可用时退化为内存状态", async () => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    await context.addInitScript(() => {
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        get() {
          throw new DOMException("blocked", "SecurityError");
        },
      });
    });
    const page = await context.newPage();
    const health = await attachHealthCollectors(page);
    await page.goto(targetUrl, { waitUntil: "load" });
    await page.locator("#next-slide").click();
    assert.equal(await page.locator(".slide.is-active").getAttribute("data-slide-index"), "1");
    for (let index = 1; index < 8; index += 1) await page.locator("#next-slide").click();
    await page.locator(".decision-select").first().selectOption("not-in-this-meeting");
    assert.equal(await page.locator(".decision-select").first().inputValue(), "not-in-this-meeting");
    assert.equal(await page.locator("#decision-progress").innerText(), "1 / 9 已处理");
    assertHealthy(health);
    await context.close();
    return "导航与四态选择可用 · errors 0";
  });

  await check("JavaScript 禁用时九屏仍可阅读", async () => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1024, height: 768 },
    });
    const page = await context.newPage();
    const health = await attachHealthCollectors(page);
    await page.goto(targetUrl, { waitUntil: "load" });
    const fallback = await page.evaluate(() => ({
      jsClass: document.documentElement.classList.contains("js"),
      visibleSlides: [...document.querySelectorAll(".slide")].filter((item) =>
        item.checkVisibility()
      ).length,
      controlsDisplay: getComputedStyle(document.querySelector(".meeting-controls")).display,
      text: document.body.innerText,
    }));
    assert.equal(fallback.jsClass, false);
    assert.equal(fallback.visibleSlides, 9);
    assert.equal(fallback.controlsDisplay, "none");
    assert.match(fallback.text, /未启用脚本/);
    assert.match(fallback.text, /确认启动结果与下一步/);
    assert.doesNotMatch(
      fallback.text,
      /\b(?:OPEN|PRECONFIRM|READY|FDE)\b|工程|客服人员|不让客服|业务输入|技术栈|技术方案|技术记录清单|需求确认会|需求会汇报|本环节请补|这里只标记|试点人口|最小闭环|回读|方案设计/
    );
    assertHealthy(health);
    await context.close();
    return "9/9 静态展开";
  });

  await check("reduced-motion 与只读语义", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
      locale: "zh-CN",
    });
    const page = await context.newPage();
    const health = await attachHealthCollectors(page);
    await page.goto(targetUrl, { waitUntil: "load" });
    assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
    assert.equal(await page.locator("[contenteditable]").count(), 0);
    assert.equal(await page.locator("#meeting-clock, #meeting-time, #timer-toggle").count(), 0);
    assert.equal(await page.locator("#live-status").getAttribute("aria-live"), "polite");
    assertHealthy(health);
    await context.close();
    return "reduce 匹配 · contenteditable 0 · 计时 UI 0";
  });

  await check("A4 打印摘要为 1–2 页", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const health = await attachHealthCollectors(page);
    await page.goto(targetUrl, { waitUntil: "load" });
    await page.emulateMedia({ media: "print" });
    assert.equal(
      await page.locator(".meeting-controls").evaluate((item) => getComputedStyle(item).display),
      "none"
    );
    assert.equal(
      await page.locator(".print-summary").evaluate((item) => getComputedStyle(item).display),
      "block"
    );
    const printText = await page.locator(".print-summary").innerText();
    assert.match(printText, /客服 Agent 一期启动会/);
    assert.match(printText, /一期主问题：未处理/);
    for (const output of ["一期结论", "材料与权限清单", "试点准备清单"]) {
      assert.match(printText, new RegExp(output));
    }
    assert.doesNotMatch(
      printText,
      /\b(?:OPEN|PRECONFIRM|READY|FDE)\b|工程|客服人员|不让客服|业务输入|技术栈|技术方案|技术记录清单|需求确认会|需求会汇报|本环节请补|这里只标记|试点人口|最小闭环|回读|方案设计/
    );
    const pdfPath = path.join(resultsDir, "客服Agent需求会摘要-A4.pdf");
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });
    const pdf = await readFile(pdfPath);
    const pageCount = (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;
    assert.ok(pdf.byteLength > 15_000, `PDF 体积异常：${pdf.byteLength}`);
    assert.ok(pageCount >= 1 && pageCount <= 2, `PDF 必须为 1–2 页，当前 ${pageCount}`);
    assertHealthy(health);
    await context.close();
    return `${pageCount} 页 · ${pdf.byteLength} bytes`;
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
  `客服 Agent 需求会汇报 QA round ${round}: ${results.summary.passed}/${results.summary.total} passed`
);
for (const item of results.checks.filter((checkResult) => !checkResult.passed)) {
  console.error(`FAIL · ${item.name} · ${item.detail}`);
}
console.log(`证据目录：${resultsDir}`);
