import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, stat, writeFile } from "node:fs/promises";
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

const targetPath = path.join(projectDir, "08-客服Agent立项执行中心.html");
const manifestPath = path.join(projectDir, "07-客服Agent立项PRD.sources.json");
const targetUrl = pathToFileURL(targetPath).href;
const roundArg = process.argv.find((value) => value.startsWith("--round="));
const round = roundArg ? roundArg.slice("--round=".length) : "manual";
const qaPaths = resolveCustomerProjectQaPaths(workspace, "hub");
const resultsDir = await createSafeResultsDir({
  trustedRootPath: qaPaths.trustedRootPath,
  rootPath: qaPaths.rootPath,
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
  const generatorSource = await readFile(path.join(scriptDir, "generate_customer_agent_hub.mjs"), "utf8");
  const templateSource = await readFile(
    path.join(scriptDir, "templates/customer-agent-hub.template.html"),
    "utf8"
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const payloadMatch = html.match(
    /<script id="hub-data" type="application\/json">([\s\S]*?)<\/script>/
  );
  assert.ok(payloadMatch, "缺少 hub-data 生成数据");
  const payload = JSON.parse(payloadMatch[1]);
  assert.match(html, /GENERATED FILE — source: 00-06 Markdown; DO NOT EDIT/);
  assert.doesNotMatch(html, /__HUB_DATA__|__PRETEXT_VENDOR__|__RELEASE_ID__/);
  assert.match(html, /function renderMarkdownDocument\(/, "缺少真源结构化阅读器");
  assert.match(
    html,
    /id="source-dialog-content"\s+role="document"\s+aria-label="原始真源结构化内容"/,
    "真源阅读器缺少文档语义"
  );
  assert.doesNotMatch(html, /<pre\b[^>]*\bid="source-dialog-content"/i);
  assert.doesNotMatch(html, /\.innerHTML\s*=/, "结构化阅读器不得写入 raw innerHTML");
  assert.doesNotMatch(html, /sourceDialogContent\.textContent\s*=\s*source\.content/);
  assert.match(generatorSource, /row\["接受职责证据 ID"\]/, "角色接受不得只凭具名判断");
  assert.match(generatorSource, /row\["生效日期"\]/, "角色接受必须校验生效日期");
  assert.match(generatorSource, /needsAcceptance:\s*!roleIsAccepted\(row\)/, "Hub 必须独立投影待接受状态");
  assert.match(
    templateSource,
    /data\.governance\.roles\.filter\(\(item\) => item\.needsAcceptance\)\.length/,
    "角色摘要必须按职责接受状态计数，不能把已具名误当已接受"
  );
  assert.doesNotMatch(
    templateSource,
    /data\.governance\.roles\.filter\(\(item\) => item\.needsNaming\)\.length/,
    "角色摘要不得回退为仅按是否具名计数"
  );
  assert.equal(payload.governance.fee.filter((item) => item.current).length, 1);
  assert.equal(
    payload.governance.fee.filter((item) => item.selected).length,
    payload.status.feeSelected ? 1 : 0,
    "正式费用选择与当前临时管控必须分开"
  );
  assert.equal(payload.governance.roles.length, 13);
  assert.equal(payload.sources.length, 7);
  assert.equal(payload.sources.every((source) => source.content.length > 0), true);
  assert.equal(payload.sources.some((source) => "href" in source), false);
  assert.deepEqual(
    payload.sources.map(({ id, label, file, sha256: sourceSha }) => ({ id, label, file, sha256: sourceSha })),
    manifest.sources,
    "Hub 真源身份与 manifest 不一致"
  );
  assert.match(payload.metrics.find((item) => item.label === "证据型助理 Top3（建议）")?.note || "", /分层 ≥50% 且至少命中 1 条/);
  assert.equal(payload.metrics.find((item) => item.label === "内部真实试点")?.value, "3–5 人 × 2 周");
  assert.ok(payload.portablePrd?.htmlBase64, "缺少便携 PRD");
  const portablePrdHtml = Buffer.from(payload.portablePrd.htmlBase64, "base64").toString("utf8");
  assert.equal(payload.portablePrd.sha256, sha256(portablePrdHtml));
  const portableDataMatch = portablePrdHtml.match(
    /<script\b[^>]*\bid=["']portable-project-data["'][^>]*>([\s\S]*?)<\/script>/i
  );
  assert.ok(portableDataMatch, "便携 PRD 缺少 portable-project-data");
  assert.equal(JSON.parse(portableDataMatch[1]).hub, null, "Hub 内嵌 PRD 不得递归包含 Hub");
  const contracts = manifest.contracts;
  assert.equal(
    payload.status.direction === "已记录"
      ? `${payload.project.priority} · 工作方向已登记`
      : `${payload.project.priority} · 工作方向${payload.status.direction}`,
    contracts.statusAxes.direction
  );
  assert.equal(`公司批准 · ${payload.status.approval}`, contracts.statusAxes.approval);
  assert.equal(`问题适配 · ${payload.status.problemFit}`, contracts.statusAxes["problem-fit"]);
  assert.equal(`外部责任包 · ${payload.status.externalPass} / ${payload.status.externalTotal}`, contracts.statusAxes.external);
  assert.equal(`Scope · ${payload.status.scopePass} / ${payload.status.scopeTotal}`, contracts.statusAxes.scope);
  assert.equal(`资源基线 · ${payload.status.resourceBaseline}`, contracts.statusAxes.resource);
  assert.equal(`Ddev · ${payload.status.ddev}`, contracts.statusAxes.ddev);
  assert.equal(payload.project.d0, contracts.milestones.d0);
  assert.equal(payload.project.g0Target, contracts.milestones.g0Date);
  assert.equal(payload.status.g0, contracts.milestones.g0State);
  assert.equal(payload.status.ddev, contracts.milestones.ddevState);
  assert.equal(payload.status.resourceBaseline, contracts.resourceBaseline);
  assert.equal(payload.status.scopePass, contracts.acceptance.scopePass);
  assert.equal(payload.status.scopeTotal, contracts.acceptance.scopeTotal);
  const metricByLabel = Object.fromEntries(payload.metrics.map((metric) => [metric.label, metric]));
  assert.equal(Number(metricByLabel["证据型助理 Top3（建议）"].value.match(/\d+/)[0]), contracts.acceptance.top3OverallMinPercent);
  assert.match(metricByLabel["证据型助理 Top3（建议）"].note, new RegExp(`分层 ≥${contracts.acceptance.top3StratumMinPercent}%`));
  assert.match(metricByLabel["证据型助理 Top3（建议）"].note, new RegExp(`至少命中 ${contracts.acceptance.top3StratumMinHits} 条`));
  assert.equal(Number(metricByLabel["知识来源正确（建议）"].value.match(/\d+/)[0]), contracts.acceptance.citationCorrectPercent);
  assert.equal(Number(metricByLabel["风险错误直答（建议）"].value), contracts.acceptance.negativeMaxWrongAnswers);
  assert.match(metricByLabel["风险错误直答（建议）"].note, new RegExp(`不少于 ${contracts.acceptance.negativeMinCases} 条`));
  assert.equal(
    metricByLabel["内部真实试点"].value,
    `${contracts.acceptance.pilotMinPeople}–${contracts.acceptance.pilotMaxPeople} 人 × ${contracts.acceptance.pilotWeeks} 周`
  );
  assert.match(metricByLabel["内部真实试点"].note, new RegExp(`每人每周 ≥${contracts.acceptance.pilotTasksPerPersonWeek} 个`));
  assert.equal(payload.governance.fee.find((item) => item.current)?.id, contracts.fee.pathCode);
  assert.equal(payload.status.feeSelected, contracts.fee.selected);
  assert.equal("forceRank" in contracts, false, "manifest 不得保留废止的强制排序契约");
  assert.equal(contracts.demandMeeting.date, "2026-08-04");
  assert.equal(contracts.demandMeeting.agendaSha256.length, 64);
  assert.equal("agenda" in payload.meeting, false, "08 不得继续内嵌现场议程");
  assert.equal("decisions" in payload.meeting, false, "08 不得继续内嵌九项回读");
  assert.equal("facilitation" in payload.meeting, false, "08 不得继续内嵌主持控制");
  assert.match(payload.runtime?.canonicalLocationFingerprint || "", /^[a-f0-9]{16}$/);
  assert.match(html, /data-meeting-link[^>]+09-客服Agent需求会汇报\.html/);
  assert.doesNotMatch(html, /id="facilitator-|id="agenda"|id="decision-progress"|print-host|is-facilitating/);
  if (contracts.fee.paidAuthorization === "0") {
    assert.match(payload.status.paidSpend, /= 0/);
  } else {
    assert.equal(payload.status.paidSpend, "按已批准 cap 执行");
  }
  if (mode === "public-template") {
    const [
      charter,
      schedule,
      ledger,
      scope,
      cost,
      architecture,
      implementation,
      g0Authorization,
      ddevAuthorization,
    ] = await Promise.all([
      readFile(path.join(projectDir, "00-项目章程.md"), "utf8"),
      readFile(path.join(projectDir, "01-总排期与阶段门禁.md"), "utf8"),
      readFile(path.join(projectDir, "02-G0责任与证据台账.md"), "utf8"),
      readFile(path.join(projectDir, "03-Scope与验收.md"), "utf8"),
      readFile(path.join(projectDir, "04-费用与成本控制.md"), "utf8"),
      readFile(path.join(projectDir, "20-设计-进行中/37-架构SSOT-v1.md"), "utf8"),
      readFile(path.join(projectDir, "20-设计-进行中/46-实现设计-开工包.md"), "utf8"),
      readFile(path.join(projectDir, "90-评审/2026-08-31_G0正式签发记录.md"), "utf8"),
      readFile(path.join(projectDir, "90-评审/2026-08-31_Ddev正式签发记录.md"), "utf8"),
    ]);
    const projectStatus = deriveProjectStatus({
      charter,
      schedule,
      ledger,
      scope,
      cost,
      architecture,
      implementation,
      g0Authorization,
      ddevAuthorization,
    });
    assert.match(html, /项目已批准/);
    assert.equal(payload.status.externalPass, projectStatus.externalPass);
    assert.equal(payload.status.externalTotal, projectStatus.externalTotal);
    assert.equal(payload.status.scopePass, projectStatus.scopePass);
    assert.equal(payload.status.scopeTotal, projectStatus.scopeTotal);
    assert.equal(payload.status.direction, "已记录");
    assert.equal(payload.status.approval, "已批准");
    assert.match(payload.status.paidSpend, /新增付费授权 = 0/);
    assert.equal(payload.status.g0, "Pass");
    assert.equal(payload.status.ddev, "2026-08-31");
    assert.equal(payload.status.development, "开发中");
    assert.match(payload.headline.title, /DEV-M0 已开工.*W0、W1 已完成/);
    assert.match(payload.headline.summary, /DEV-M0 正在进行.*W0、W1 已完成.*合同开发授权.*待单独授权.*不得进入下一里程碑/);
    assert.match(payload.headline.nowTitle, /DEV-M0 进行中.*等待下一动作授权/);
    assert.match(payload.headline.nowSummary, /W0、W1 已完成.*合同开发授权.*待单独授权.*不激活未授权 runtime/);
    assert.match(payload.headline.scheduleTitle, /DEV-M0 已开始.*W0、W1 已完成.*单人全栈 \/ FDE/);
    assert.match(payload.meeting.title, /DEV-M0 已开始.*W0、W1 已完成.*下一动作待授权/);
    assert.match(payload.meeting.positioning, /DEV-M0 实施与证据复核会.*W0、W1 已完成.*合同开发授权.*尚未授权.*CR \/ DEC/);
    assert.equal(payload.meeting.copyTitle, "客服 Agent 当前推进清单");
    assert.equal(payload.gates.every((gate) => gate.status === "Pass"), true);
    assert.equal(payload.headline.nextTitle, "下一 DEV-M0 能力授权");
    assert.match(payload.headline.nextOutput, /合同开发授权.*授权前不实施/);
    assert.equal(payload.schedule.length, 5);
    assert.equal(payload.schedule[0].title, "DEV-M0 · W0、W1 已完成");
    assert.equal(payload.schedule[0].date, "2026-08-31");
    assert.match(payload.schedule[0].action, /下一动作 合同开发授权.*未授权前不实施/);
    assert.equal(payload.governance.fee.find((item) => item.current)?.id, "B");
    assert.equal(payload.governance.fee.find((item) => item.current)?.selected, true);
    assert.match(payload.governance.fee.find((item) => item.id === "B")?.title || "", /当前路径/);
    assert.equal(
      payload.governance.roles.every(
        (item) => item.needsNaming === (item.name === "待具名")
      ),
      true,
      "needsNaming 必须只由人员代号是否为空决定"
    );
    assert.equal(
      payload.governance.roles.every(
        (item) => item.needsAcceptance === !(item.status === "已接受" || item.status === "Pass")
      ),
      true,
      "当前完整 RACI 中 needsAcceptance 必须由接受状态收敛为 false"
    );
    assert.equal(
      payload.governance.roles.every(
        (item) => item.name === "待具名" || /^(?:ROLE|USR)-[A-Z0-9-]+$/.test(item.name)
      ),
      true,
      "公开角色只能使用 ROLE-* / USR-* 代号或待具名"
    );
    assert.equal(payload.governance.roles.length, 13, "公开模板必须投影完整 13 角色");
    assert.equal(payload.governance.roles.filter((item) => item.needsNaming).length, 0, "13 角色均已接受后不得再显示待具名");
    assert.equal(payload.governance.roles.filter((item) => item.needsAcceptance).length, 0, "13 角色均已接受后不得再显示待接受职责");
    assert.equal(payload.governance.roles.filter((item) => item.status === "已接受" || item.status === "Pass").length, 13);
    assert.equal(payload.gates.find((gate) => gate.id === "G0-06")?.status, "Pass");
    assert.equal(
      payload.gates.find((gate) => gate.id === "G0-06")?.evidence,
      "EVD-CONTENT-GOVERNANCE-APPROVAL-20260809"
    );
    assert.equal(payload.scopeChecks.find((item) => String(item.id) === "7")?.status, "Pass");
    assert.equal(
      payload.scopeChecks.find((item) => String(item.id) === "7")?.evidence,
      "EVD-CONTENT-GOVERNANCE-APPROVAL-20260809"
    );
    assert.equal(payload.gates.find((gate) => gate.id === "G0-08")?.status, "Pass");
    assert.equal(
      payload.gates.find((gate) => gate.id === "G0-08")?.evidence,
      "EVD-G0-08-GREENFIELD-ISOLATION-20260810"
    );
    assert.equal(payload.scopeChecks.find((item) => String(item.id) === "8")?.status, "Pass");
    assert.equal(
      payload.scopeChecks.find((item) => String(item.id) === "8")?.evidence,
      "EVD-G0-08-GREENFIELD-ISOLATION-20260810"
    );
    assert.equal(payload.gates.find((gate) => gate.id === "G0-10")?.status, "Pass");
    assert.equal(
      payload.gates.find((gate) => gate.id === "G0-10")?.evidence,
      "EVD-G0-10-PRD-SCOPE-FREEZE-20260810"
    );
    assert.equal(payload.scopeChecks.find((item) => String(item.id) === "10")?.status, "Pass");
    assert.equal(
      payload.scopeChecks.find((item) => String(item.id) === "10")?.evidence,
      "EVD-G0-10-PRD-SCOPE-FREEZE-20260810"
    );
    assert.equal(payload.gates.find((gate) => gate.id === "G0-11")?.status, "Pass");
    assert.equal(
      payload.gates.find((gate) => gate.id === "G0-11")?.evidence,
      "EVD-G0-11-SECURITY-BOUNDARY-20260810"
    );
    assert.equal(payload.scopeChecks.find((item) => String(item.id) === "12")?.status, "Pass");
    assert.equal(
      payload.scopeChecks.find((item) => String(item.id) === "12")?.evidence,
      "EVD-G0-11-SECURITY-BOUNDARY-20260810"
    );
    assert.equal(payload.gates.find((gate) => gate.id === "G0-12")?.status, "Pass");
    assert.equal(
      payload.gates.find((gate) => gate.id === "G0-12")?.evidence,
      "EVD-G0-12-OPS-DEPLOYMENT-20260810"
    );
    assert.equal(payload.scopeChecks.find((item) => String(item.id) === "13")?.status, "Pass");
    assert.equal(
      payload.scopeChecks.find((item) => String(item.id) === "13")?.evidence,
      "EVD-G0-12-OPS-DEPLOYMENT-20260810"
    );
    assert.equal(payload.prelaunchChecklist.length, 4);
    assert.match(payload.prelaunchChecklist[0], /保持 W0、W1 基线.*行为不漂移/);
    assert.match(payload.prelaunchChecklist[1], /只准备合同开发授权.*范围、验收与授权输入.*授权前不实施/);
    assert.match(payload.prelaunchChecklist[2], /获批后.*受影响测试.*构建.*workspace.*E2E.*实施证据/);
    assert.match(payload.prelaunchChecklist[3], /development \/ test.*合成数据.*不启用真实数据.*下一里程碑/);
    assert.match(payload.governance.allowed[0].allowed, /只做已签 Ddev、Scope、费用与环境边界内的 WBS/);
    assert.match(payload.governance.allowed[0].forbidden, /自动代发.*未经 CR \/ DEC 的新增范围/);
    assert.match(payload.governance.allowed[1].forbidden, /未授权的生产发布/);
    assert.doesNotMatch(payload.meeting.positioning, /\b(?:Owner|PRD)\b/);
    assert.doesNotMatch(payload.meeting.copyTitle, /\bPRD\b/);
    assert.equal(payload.governance.forbiddenTitle, "持续禁止");
  }
  assert.doesNotMatch(payload.meeting.director.join("\n"), /外包推进节奏/);
  assert.match(html, /Ddev/);
  const fileStat = await stat(targetPath);
  assert.ok(fileStat.size < 1_000_000, `HTML 体积 ${fileStat.size} bytes`);
  return `${fileStat.size} bytes`;
});

const browserLaunchOptions = process.env.CI
  ? { headless: true }
  : { channel: "chrome", headless: true };
if (process.env.CHROME_PATH) {
  delete browserLaunchOptions.channel;
  browserLaunchOptions.executablePath = process.env.CHROME_PATH;
}
const servedFiles = new Set([
  "07-客服Agent立项PRD.html",
  "08-客服Agent立项执行中心.html",
  "09-客服Agent需求会汇报.html",
]);
const staticServer = createServer(async (request, response) => {
  try {
    const file = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname.slice(1));
    if (!servedFiles.has(file)) {
      response.writeHead(404).end("Not found");
      return;
    }
    const body = await readFile(path.join(projectDir, file));
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500).end(error instanceof Error ? error.message : String(error));
  }
});
await new Promise((resolve, reject) => {
  staticServer.once("error", reject);
  staticServer.listen(0, "127.0.0.1", resolve);
});
const serverAddress = staticServer.address();
assert.ok(serverAddress && typeof serverAddress !== "string");
const httpBase = `http://127.0.0.1:${serverAddress.port}/`;
const httpHubUrl = new URL(encodeURIComponent("08-客服Agent立项执行中心.html"), httpBase).href;
let browser;
try {
  browser = await chromium.launch(browserLaunchOptions);
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

    await check(`${viewport.name} · 产品开发与动态真源一致`, async () => {
      const statusStrip = await page.evaluate(() => {
        const payload = JSON.parse(document.querySelector("#hub-data").textContent);
        const items = [...document.querySelectorAll("#status-strip .status-item")].map((item) => ({
          value: item.querySelector(".status-value")?.textContent?.trim() || "",
          label: item.querySelector(".status-label")?.textContent?.trim() || "",
        }));
        return { expected: payload.status.development, items };
      });
      assert.equal(statusStrip.items.length, 6, "状态条应保持 6 格");
      assert.deepEqual(
        statusStrip.items.filter((item) => item.label === "产品开发"),
        [{ value: statusStrip.expected, label: "产品开发" }]
      );
      assert.equal(
        statusStrip.items.some((item) => item.label === "工作方向"),
        false,
        "状态条不应重复 hero 中的工作方向"
      );
      return `产品开发 · ${statusStrip.expected}`;
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

    await check(`${viewport.name} · 7 个顶部导航逐项可达`, async () => {
      const hrefs = await page.locator(".top-nav a").evaluateAll((items) =>
        items.map((item) => item.getAttribute("href"))
      );
      assert.deepEqual(hrefs, [
        "#overview",
        "#now",
        "#gates",
        "#schedule",
        "#acceptance",
        "#meeting",
        "#governance",
      ]);
      for (const href of hrefs) {
        await page.locator(`.top-nav a[href="${href}"]`).click();
        await page.waitForFunction((expected) => location.hash === expected, href);
        assert.equal(await page.locator(href).count(), 1, `${href} 目标缺失`);
        assert.equal(await page.locator(href).isVisible(), true, `${href} 目标不可见`);
      }
      await page.goto(targetUrl, { waitUntil: "load" });
      return "7/7 hash 与目标";
    });

    if (viewport.width <= 560) {
      await check(`${viewport.name} · 触控目标不小于 44px`, async () => {
        await page.locator("#source-drawer").evaluate((item) => (item.open = true));
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
        assert.equal(
          await page.locator("#source-list code").first().evaluate((item) => parseFloat(getComputedStyle(item).fontSize)),
          12,
          "真源摘要最小字号应为 12px"
        );
        await page.locator("#source-drawer").evaluate((item) => (item.open = false));
        return "全部通过";
      });

      await check(`${viewport.name} · 真源长表仅在弹窗内横向滚动`, async () => {
        await page.locator("#source-drawer").evaluate((item) => (item.open = true));
        await page.locator('button[data-source-id="cadence"]').click();
        const closeButtonMetrics = await page.locator("#source-dialog-close").evaluate((item) => {
          const range = document.createRange();
          range.selectNodeContents(item);
          const box = item.getBoundingClientRect();
          return {
            textLines: range.getClientRects().length,
            width: box.width,
            height: box.height,
            whiteSpace: getComputedStyle(item).whiteSpace,
          };
        });
        assert.equal(closeButtonMetrics.textLines, 1, `关闭按钮文案换行：${JSON.stringify(closeButtonMetrics)}`);
        assert.ok(
          closeButtonMetrics.width >= 56 && closeButtonMetrics.height >= 44,
          `关闭按钮热区不足：${JSON.stringify(closeButtonMetrics)}`
        );
        assert.equal(closeButtonMetrics.whiteSpace, "nowrap");
        const tableMetrics = await page.locator("#source-dialog .source-table-scroll").evaluateAll((items) =>
          items.map((item) => ({
            clientWidth: item.clientWidth,
            scrollWidth: item.scrollWidth,
            overflowX: getComputedStyle(item).overflowX,
          }))
        );
        assert.ok(tableMetrics.length > 0, "启动会真源缺少结构化表格");
        assert.equal(
          tableMetrics.every((item) => item.overflowX === "auto"),
          true,
          `表格横向滚动样式异常：${JSON.stringify(tableMetrics)}`
        );
        const widestTableIndex = tableMetrics.reduce(
          (bestIndex, item, itemIndex, items) =>
            item.scrollWidth - item.clientWidth > items[bestIndex].scrollWidth - items[bestIndex].clientWidth
              ? itemIndex
              : bestIndex,
          0
        );
        assert.ok(
          tableMetrics[widestTableIndex].scrollWidth > tableMetrics[widestTableIndex].clientWidth,
          `长表未形成独立横向滚动：${JSON.stringify(tableMetrics)}`
        );
        const scrolled = await page
          .locator("#source-dialog .source-table-scroll")
          .nth(widestTableIndex)
          .evaluate((item) => {
            item.scrollLeft = 40;
            return item.scrollLeft;
          });
        assert.ok(scrolled > 0, "长表无法横向滚动");
        const pageWidth = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        assert.ok(pageWidth.scrollWidth <= pageWidth.clientWidth + 1, `页面溢出：${JSON.stringify(pageWidth)}`);
        await page.locator("#source-dialog-close").click();
        await page.locator("#source-drawer").evaluate((item) => (item.open = false));
        return `${tableMetrics.length} 张表，最大滚动 ${Math.round(
          tableMetrics[widestTableIndex].scrollWidth - tableMetrics[widestTableIndex].clientWidth
        )}px`;
      });

      await check(`${viewport.name} · 返回项目说明始终可见可点`, async () => {
        const control = page.getByRole("button", { name: "返回项目说明" });
        assert.equal(await control.isVisible(), true);
        const box = await control.boundingBox();
        assert.ok(box && box.width >= 44 && box.height >= 44, `返回项目说明热区：${JSON.stringify(box)}`);
        const canonicalHref = await control.getAttribute("data-canonical-href");
        assert.ok(canonicalHref);
        await stat(fileURLToPath(new URL(canonicalHref, targetUrl)));
        return `${Math.round(box.width)}×${Math.round(box.height)}`;
      });

      await check(`${viewport.name} · 独立汇报入口先于会前长清单`, async () => {
        await page.locator("#meeting").scrollIntoViewIfNeeded();
        const positions = await page.evaluate(() => ({
          launchTop: document.querySelector(".meeting-launch").getBoundingClientRect().top,
          prepTop: document.querySelector(".meeting-prep").getBoundingClientRect().top,
        }));
        assert.ok(positions.launchTop < positions.prepTop, JSON.stringify(positions));
        return `launch ${Math.round(positions.launchTop)} < prep ${Math.round(positions.prepTop)}`;
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
          assert.equal(source.content, text, `${source.file} 内嵌内容不一致`);
        }
        return "7/7";
      });

      await check("7 份真源使用安全只读弹窗，不导航 Markdown", async () => {
        const markdownLinks = page.locator('a[href$=".md"]');
        const sourceButtons = page.locator("#source-list button[data-source-id]");
        const payload = await page.locator("#hub-data").evaluate((item) => JSON.parse(item.textContent));
        const structuredTotals = {
          heading: 0,
          paragraph: 0,
          blockquote: 0,
          unorderedList: 0,
          orderedList: 0,
          checkbox: 0,
          table: 0,
          codeBlock: 0,
          horizontalRule: 0,
          bold: 0,
          inlineCode: 0,
          linkLabel: 0,
        };
        assert.equal(await markdownLinks.count(), 0);
        assert.equal(await sourceButtons.count(), 7);
        assert.equal(await sourceButtons.first().isVisible(), false);
        await page.locator("#source-drawer summary").click();
        await page.addScriptTag({ content: axeSource });
        assert.equal(await sourceButtons.first().isVisible(), true);
        const sourceButtonSizes = await sourceButtons.evaluateAll((items) =>
          items.map((item) => {
            const rect = item.getBoundingClientRect();
            return { width: rect.width, height: rect.height };
          })
        );
        assert.equal(
          sourceButtonSizes.every((size) => size.width >= 44 && size.height >= 44),
          true,
          `真源按钮热区不足：${JSON.stringify(sourceButtonSizes)}`
        );
        assert.equal(
          await page.locator("#source-list code").first().evaluate((item) => parseFloat(getComputedStyle(item).fontSize)),
          12
        );
        for (const [index, source] of payload.sources.entries()) {
          const trigger = sourceButtons.nth(index);
          await trigger.click();
          const sourceContent = page.locator("#source-dialog-content");
          assert.equal(await page.locator("#source-dialog").isVisible(), true);
          assert.equal(await page.locator("#source-dialog-title").innerText(), source.label);
          assert.match(await page.locator("#source-dialog-meta").innerText(), new RegExp(source.sha256));
          assert.equal(await page.locator("#source-dialog").getAttribute("aria-modal"), "true");
          assert.equal(await page.locator("#source-dialog").getAttribute("aria-describedby"), "source-dialog-meta");
          assert.equal(await sourceContent.getAttribute("role"), "document");
          assert.notEqual(await sourceContent.textContent(), source.content, `${source.id} 仍显示原始 Markdown`);
          const sourceTitle = source.content.match(/^#\s+(.+)$/m)?.[1];
          assert.ok(sourceTitle, `${source.id} 缺少一级标题测试样本`);
          assert.equal(
            await sourceContent.locator('[data-source-level="1"]').first().innerText(),
            sourceTitle,
            `${source.id} 标题未结构化渲染`
          );
          const structure = await sourceContent.evaluate((root) => ({
            heading: root.querySelectorAll("h3, h4, h5, h6").length,
            paragraph: root.querySelectorAll("p").length,
            blockquote: root.querySelectorAll("blockquote").length,
            unorderedList: root.querySelectorAll("ul:not(.source-task-list)").length,
            orderedList: root.querySelectorAll("ol").length,
            checkbox: root.querySelectorAll('input[type="checkbox"]').length,
            table: root.querySelectorAll("table.source-table").length,
            codeBlock: root.querySelectorAll("pre.source-code-block > code").length,
            horizontalRule: root.querySelectorAll("hr").length,
            bold: root.querySelectorAll("strong").length,
            inlineCode: root.querySelectorAll("code.source-inline-code").length,
            linkLabel: root.querySelectorAll(".source-inline-link-label").length,
          }));
          Object.entries(structure).forEach(([name, count]) => {
            structuredTotals[name] += count;
          });
          assert.ok(structure.heading > 0, `${source.id} 未渲染标题`);
          assert.ok(structure.paragraph > 0, `${source.id} 未渲染段落`);
          assert.ok(structure.table > 0, `${source.id} 未渲染表格`);
          assert.equal(await sourceContent.locator("a[href], script").count(), 0);
          const tableLabels = await sourceContent
            .locator('.source-table-scroll[role="region"]')
            .evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")));
          assert.deepEqual(
            tableLabels,
            tableLabels.map(
              (_, tableIndex) =>
                `原始文档数据表 ${tableIndex + 1}/${tableLabels.length}，可横向滚动查看`
            ),
            `${source.id} 表格地标名称不唯一`
          );
          const codeLabels = await sourceContent
            .locator('.source-code-block[role="region"]')
            .evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")));
          assert.deepEqual(
            codeLabels,
            codeLabels.map(
              (_, codeIndex) => `原始文档代码块 ${codeIndex + 1}/${codeLabels.length}`
            ),
            `${source.id} 代码块地标名称不唯一`
          );
          const rawMarkdownMarkers = await sourceContent.evaluate((root) => {
            const hits = [];
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            const blockPatterns = [
              /^\s{0,3}(?:#{1,6}|>)\s/,
              /^\s{0,3}(?:[-+*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/,
              /^\s*(?:\|?\s*:?-{3,}:?\s*)+\|?\s*$/,
            ];
            const inlinePatterns = [
              /\*\*[^*]+\*\*/,
              /^\*[^*]+\*$/,
              /!?\[[^\]]+\]\([^)]+\)/,
              /\[(?: |x|X)\]/,
            ];
            while (walker.nextNode()) {
              const node = walker.currentNode;
              if (node.parentElement?.closest(".source-code-block, .source-inline-code")) continue;
              const value = node.textContent || "";
              const isRawBlockMarker =
                Boolean(node.parentElement?.closest("p")) &&
                blockPatterns.some((pattern) => pattern.test(value));
              if (isRawBlockMarker || inlinePatterns.some((pattern) => pattern.test(value))) {
                hits.push(value.trim().slice(0, 120));
              }
            }
            return hits;
          });
          assert.deepEqual(rawMarkdownMarkers, [], `${source.id} 暴露 Markdown 标记`);
          assert.equal(await page.locator("body").evaluate((item) => getComputedStyle(item).overflow), "hidden");
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
            `${source.id} 弹窗可访问性违规`
          );
          const landmarkAudit = await page.evaluate(async () =>
            window.axe.run(document, {
              runOnly: { type: "rule", values: ["landmark-unique"] },
            })
          );
          assert.deepEqual(
            landmarkAudit.violations.map((violation) => violation.id),
            [],
            `${source.id} 表格地标名称不唯一`
          );
          await page.keyboard.press("Tab");
          assert.equal(
            await page.evaluate(() => Boolean(document.activeElement?.closest("#source-dialog"))),
            true,
            `${source.id} Tab 焦点逃出弹窗`
          );
          await page.keyboard.press("Shift+Tab");
          assert.equal(
            await page.evaluate(() => Boolean(document.activeElement?.closest("#source-dialog"))),
            true,
            `${source.id} Shift+Tab 焦点逃出弹窗`
          );
          if (index === 0) await page.keyboard.press("Escape");
          else await page.locator("#source-dialog-close").click();
          assert.equal(await page.locator("#source-dialog").isVisible(), false);
          assert.notEqual(await page.locator("body").evaluate((item) => getComputedStyle(item).overflow), "hidden");
          assert.equal(
            await page.evaluate(() => document.activeElement?.dataset?.sourceId || ""),
            source.id,
            `${source.id} 关闭后焦点未恢复`
          );
        }
        Object.entries(structuredTotals).forEach(([name, count]) => {
          assert.ok(count > 0, `7 份真源未覆盖结构化元素：${name}`);
        });
        return `7/7 结构化内容、无 Markdown/链接/脚本、axe、Esc、关闭与焦点恢复 · ${JSON.stringify(structuredTotals)}`;
      });

      await check("孤立 file 返回项目说明使用持久 query 路由", async () => {
        try {
          const isolatedHubPath = path.join(resultsDir, "isolated-customer-agent-hub.html");
          await writeFile(isolatedHubPath, await readFile(targetPath, "utf8"), "utf8");
          await page.goto(pathToFileURL(isolatedHubPath).href, { waitUntil: "load" });
          const originalPathname = new URL(page.url()).pathname;
          const control = page.locator("#return-to-prd");
          assert.equal(await control.getAttribute("data-portable"), "true");
          assert.equal(await control.getAttribute("data-canonical-href"), "./07-客服Agent立项PRD.html");
          assert.equal(await page.locator("a[data-meeting-link]").count(), 0);
          assert.match(await page.locator(".meeting-unavailable").innerText(), /不在此便携文件内/);
          assert.match(await page.locator("#meeting-launch-note").innerText(), /项目目录.*09-客服Agent需求会汇报\.html/);
          await control.click();
          await page.waitForFunction(() => document.title.includes("项目说明"));
          assert.match(await page.title(), /客服 Agent.*项目说明/);
          assert.equal(new URL(page.url()).protocol, "file:");
          assert.equal(new URL(page.url()).pathname, originalPathname);
          assert.equal(new URL(page.url()).searchParams.get("portable"), "prd");
          assert.doesNotMatch(page.url(), /^(?:blob:|chrome-error:)/);
          const portableData = await page.locator("#portable-project-data").evaluate((item) =>
            JSON.parse(item.textContent)
          );
          assert.equal(portableData.hub, null);
          assert.equal(portableData.sources.length, 7);
          await page.reload({ waitUntil: "load" });
          await page.waitForFunction(() => document.title.includes("项目说明"));
          assert.equal(new URL(page.url()).searchParams.get("portable"), "prd");
          await page.goBack();
          await page.waitForFunction(() =>
            document.title.includes("执行中心") && !new URL(location.href).searchParams.has("portable")
          );
          assert.equal(new URL(page.url()).pathname, originalPathname);
          await page.goForward();
          await page.waitForFunction(() =>
            document.title.includes("项目说明") && new URL(location.href).searchParams.get("portable") === "prd"
          );
          await page.goBack();
          await page.waitForFunction(() => document.title.includes("执行中心"));
          await page.locator("#return-to-prd").click();
          await page.waitForFunction(() => document.title.includes("项目说明"));
          assert.doesNotMatch(page.url(), /^(?:blob:|chrome-error:)/);
          await page.locator("#open-execution-center").click();
          await page.waitForFunction(() =>
            document.title.includes("执行中心") && !new URL(location.href).searchParams.has("portable")
          );
          assert.equal(new URL(page.url()).pathname, originalPathname);
          assert.equal(new URL(page.url()).searchParams.has("portable"), false);
          assert.doesNotMatch(page.url(), /^(?:blob:|chrome-error:)/);
          await page.reload({ waitUntil: "load" });
          await page.waitForFunction(() => document.title.includes("执行中心"));
          assert.equal(new URL(page.url()).pathname, originalPathname);
          assert.equal(new URL(page.url()).searchParams.has("portable"), false);

          const canonicalNamedCopy = path.join(resultsDir, path.basename(targetPath));
          await writeFile(canonicalNamedCopy, await readFile(targetPath, "utf8"), "utf8");
          await page.goto(pathToFileURL(canonicalNamedCopy).href, { waitUntil: "load" });
          assert.equal(
            await page.locator("a[data-meeting-link]").count(),
            0,
            "同名孤立副本也不得误认为 canonical 目录"
          );
          assert.match(await page.locator(".meeting-unavailable").innerText(), /不在此便携文件内/);
          assert.match(await page.locator("#meeting-launch-note").innerText(), /项目目录.*09-客服Agent需求会汇报\.html/);
          return "click / reload / back / forward / reclick / PRD 回宿主 Hub / reload / 同名孤立副本";
        } finally {
          await page.goto(targetUrl, { waitUntil: "load" });
        }
      });

      await check("口径卡、费用语义、角色与现在做均对齐 PRD", async () => {
        const payload = await page.locator("#hub-data").evaluate((item) => JSON.parse(item.textContent));
        assert.equal(await page.locator("#prelaunch-list > li").count(), payload.prelaunchChecklist.length);
        assert.match(await page.locator("#metric-grid").innerText(), /分层 ≥50% 且至少命中 1 条/);
        assert.match(await page.locator("#metric-grid").innerText(), /3–5 人 × 2 周/);
        const pendingCount = payload.governance.roles.filter((item) => item.needsAcceptance).length;
        const acceptedCount = payload.governance.roles.filter((item) => item.status === "已接受" || item.status === "Pass").length;
        assert.equal(pendingCount, 0);
        assert.equal(await page.locator("#role-summary").innerText(), `${acceptedCount} 个角色已接受职责`);
        const currentFee = page.locator(`[data-fee-id="${payload.governance.fee.find((item) => item.current).id}"]`);
        assert.equal(await currentFee.getAttribute("data-current"), "true");
        assert.equal(await currentFee.getAttribute("data-selected"), String(payload.status.feeSelected));
        if (mode === "public-template") assert.match(await currentFee.innerText(), /当前路径/);
        return `${payload.prelaunchChecklist.length} 项 · ${acceptedCount} 角色已接受职责 · 指标分层`;
      });

      await check("业务拍板 / BP 协同与经理 / 坐席角色筛选及深链", async () => {
        const directorFilter = page.getByRole("button", { name: "客服总监（拍板）/ BP（协同）" });
        await directorFilter.click();
        assert.equal(
          await directorFilter.getAttribute("aria-pressed"),
          "true"
        );
        assert.equal(await page.locator('[data-role-panel="director"]').isVisible(), true);
        assert.equal(await page.locator('[data-role-panel="manager"]').isVisible(), false);
        assert.match(page.url(), /role=director/);
        await page.reload({ waitUntil: "load" });
        assert.equal(await page.locator('[data-role-panel="director"]').isVisible(), true);
        assert.equal(await page.locator('[data-role-panel="manager"]').isVisible(), false);
        assert.equal(
          await directorFilter.getAttribute("aria-pressed"),
          "true"
        );
        await page.getByRole("button", { name: "客服经理 / 坐席" }).click();
        assert.equal(await page.locator('[data-role-panel="director"]').isVisible(), false);
        assert.equal(await page.locator('[data-role-panel="manager"]').isVisible(), true);
        assert.match(page.url(), /role=manager/);
        await page.goBack();
        await page.waitForFunction(() => new URL(location.href).searchParams.get("role") === "director");
        assert.equal(await page.locator('[data-role-panel="director"]').isVisible(), true);
        assert.equal(await page.locator('[data-role-panel="manager"]').isVisible(), false);
        await page.goForward();
        await page.waitForFunction(() => new URL(location.href).searchParams.get("role") === "manager");
        assert.equal(await page.locator('[data-role-panel="director"]').isVisible(), false);
        assert.equal(await page.locator('[data-role-panel="manager"]').isVisible(), true);
        await page.getByRole("button", { name: "全部" }).click();
        assert.equal(await page.locator('[data-role-panel="director"]').isVisible(), true);
        assert.equal(await page.locator('[data-role-panel="manager"]').isVisible(), true);
        assert.equal(new URL(page.url()).searchParams.has("role"), false);
        return "reload / back / forward · all / director / manager";
      });

      await check("08 仅保留会前准备与独立 09 入口", async () => {
        await page.goto(targetUrl, { waitUntil: "load" });
        assert.equal(await page.locator("#meeting .meeting-prep").count(), 1);
        assert.equal(await page.locator("#facilitator-console, #agenda, #decision-progress, #print-host-card").count(), 0);
        const meetingControl = page.locator("[data-meeting-link]");
        assert.equal(await meetingControl.innerText(), "打开启动会主屏");
        assert.equal(await meetingControl.getAttribute("href"), "./09-客服Agent需求会汇报.html");
        const meetingPath = fileURLToPath(new URL(await meetingControl.getAttribute("href"), targetUrl));
        const meetingStat = await stat(meetingPath);
        assert.ok(meetingStat.size > 20_000, `09 生成物体积异常：${meetingStat.size}`);
        return `会前准备 1 份 · 现场实现 0 套 · 09 ${meetingStat.size} bytes`;
      });

      await check("复制会前清单", async () => {
        await page.locator("#copy-checklist").click();
        await page.waitForFunction(() => Boolean(window.__hubCopiedText));
        const copied = await page.evaluate(() => window.__hubCopiedText);
        assert.match(copied, /客服总监（拍板）\/ BP（协同）/);
        assert.match(copied, /客服经理 \/ 坐席/);
        assert.match(copied, /最终负责人/);
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
        await page.locator("[data-source-id]").first().click();
        assert.equal(await page.locator("#source-dialog").isVisible(), true);
        await page.emulateMedia({ media: "print" });
        assert.equal(
          await page.locator(".site-header").evaluate((item) => getComputedStyle(item).display),
          "none"
        );
        assert.equal(
          await page.locator("#source-dialog").evaluate((item) => getComputedStyle(item).display),
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
        await page.locator("#source-dialog").evaluate((item) => item.close());
        await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
        assert.equal(await details.evaluateAll((items) => items.every((item) => !item.open)), true);
        return `内部执行中心 ${pageCount} 页`;
      });

      await check("跳到正文与键盘焦点", async () => {
        await page.locator(".skip-link").focus();
        await page.keyboard.press("Enter");
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        assert.equal(await page.evaluate(() => document.activeElement?.id), "main");
        return "焦点进入 main";
      });
    }

    await check(`${viewport.name} · 全交互后仍无控制台与请求异常`, async () => {
      assert.deepEqual(consoleErrors, []);
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(failedRequests, []);
      assert.deepEqual(externalRequests, []);
      assert.doesNotMatch(page.url(), /^(?:blob:|chrome-error:)/);
      return "console 0 · pageerror 0 · requestfailed 0 · external 0";
    });

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

  await check("HTTP 返回 PRD 保持 canonical pathname 与浏览器历史", async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: "zh-CN",
    });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    const externalRequests = [];
    const expectedOrigin = new URL(httpHubUrl).origin;
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) =>
      failedRequests.push(`${request.url()} · ${request.failure()?.errorText || "unknown"}`)
    );
    page.on("request", (request) => {
      const requestUrl = new URL(request.url());
      if (
        !["data:", "blob:", "file:"].includes(requestUrl.protocol) &&
        requestUrl.origin !== expectedOrigin
      ) {
        externalRequests.push(request.url());
      }
    });
    try {
      await page.goto(httpHubUrl, { waitUntil: "load" });
      const hubPathname = decodeURIComponent(new URL(page.url()).pathname);
      assert.match(hubPathname, /08-客服Agent立项执行中心\.html$/);
      await page.locator("#return-to-prd").click();
      await page.waitForURL((url) => decodeURIComponent(url.pathname).endsWith("07-客服Agent立项PRD.html"));
      assert.equal(new URL(page.url()).searchParams.has("portable"), false);
      assert.doesNotMatch(page.url(), /^(?:blob:|chrome-error:)/);
      await page.reload({ waitUntil: "load" });
      assert.match(decodeURIComponent(new URL(page.url()).pathname), /07-客服Agent立项PRD\.html$/);
      await page.goBack({ waitUntil: "load" });
      assert.match(decodeURIComponent(new URL(page.url()).pathname), /08-客服Agent立项执行中心\.html$/);
      await page.locator("#return-to-prd").click();
      await page.waitForURL((url) => decodeURIComponent(url.pathname).endsWith("07-客服Agent立项PRD.html"));
      await page.goBack({ waitUntil: "load" });
      await page.goForward({ waitUntil: "load" });
      assert.match(decodeURIComponent(new URL(page.url()).pathname), /07-客服Agent立项PRD\.html$/);
      assert.doesNotMatch(page.url(), /^(?:blob:|chrome-error:)/);
      assert.deepEqual(consoleErrors, []);
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(failedRequests, []);
      assert.deepEqual(externalRequests, []);
      return "08 → 07 · reload / back / forward / reclick · errors 0";
    } finally {
      await context.close();
    }
  });
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    await new Promise((resolve, reject) =>
      staticServer.close((error) => (error ? reject(error) : resolve()))
    );
  }
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
