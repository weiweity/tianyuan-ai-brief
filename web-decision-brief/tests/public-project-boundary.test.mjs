import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  resolveCustomerProjectQaPaths,
  resolveCustomerProjectWorkspace,
} from "../../business-docs/08-工具/project_workspace.mjs";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");
const projectRoot = path.join(repoRoot, "business-docs/01-客服Agent项目");
const workspaceModuleUrl = pathToFileURL(
  path.join(repoRoot, "business-docs/08-工具/project_workspace.mjs")
).href;
const currentFiles = [
  "00-项目章程.md",
  "01-总排期与阶段门禁.md",
  "02-G0责任与证据台账.md",
  "03-Scope与验收.md",
  "04-费用与成本控制.md",
  "05-全栈交付计划.md",
  "06-启动会与周推进.md",
  "README.md",
];

function isOutsideRepo(candidate) {
  const relative = path.relative(repoRoot, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function replaceRequired(text, before, after, label) {
  const count = text.split(before).length - 1;
  assert.equal(count, 1, `${label} 应唯一命中，实际 ${count}`);
  return text.replace(before, after);
}

async function collectFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const candidate = path.join(root, entry.name);
      return entry.isDirectory() ? collectFiles(candidate) : entry.isFile() ? [candidate] : [];
    })
  );
  return nested.flat();
}

async function advancePrivateFixture(target) {
  const readmePath = path.join(target, "README.md");
  const charterPath = path.join(target, "00-项目章程.md");
  const ledgerPath = path.join(target, "02-G0责任与证据台账.md");
  const prdPath = path.join(target, "07-客服Agent立项PRD.html");

  const charter = replaceRequired(
    await readFile(charterPath, "utf8"),
    "外部责任包 **0/14**、Scope **0/15**，合计 **0/29**",
    "外部责任包 **1/14**、Scope **0/15**，合计 **1/29**",
    "私有章程门禁汇总"
  );
  await writeFile(charterPath, charter, "utf8");

  const readme = replaceRequired(
    await readFile(readmePath, "utf8"),
    "外部责任包 0/14、Scope 0/15（合计 0/29）",
    "外部责任包 1/14、Scope 0/15（合计 1/29）",
    "私有 README 门禁汇总"
  );
  await writeFile(readmePath, readme, "utf8");

  let ledger = replaceRequired(
    await readFile(ledgerPath, "utf8"),
    "| 外部责任包 | **0/14 Pass** | G0-02～G0-15 |",
    "| 外部责任包 | **1/14 Pass** | G0-02～G0-15 |",
    "私有台账外部责任包汇总"
  );
  ledger = replaceRequired(
    ledger,
    "| 资源基线 | **未选择** | G0-14 完成前不承诺小队或单人排期 |",
    "| 资源基线 | **单人全栈 / FDE** | G0-14 完成前不承诺小队或单人排期 |",
    "私有台账资源基线"
  );
  const gateLines = ledger.split(/\r?\n/);
  const gateIndex = gateLines.findIndex((line) => line.startsWith("| G0-08 |"));
  assert.notEqual(gateIndex, -1, "私有台账缺少 G0-08");
  const gateCells = gateLines[gateIndex].split("|");
  assert.equal(gateCells.length, 9, "G0-08 表格结构异常");
  assert.equal(gateCells[6].trim(), "待办", "G0-08 初始状态应为待办");
  gateCells[6] = " **Pass** ";
  gateCells[7] = " `EVD-REUSE-001` ";
  gateLines[gateIndex] = gateCells.join("|");
  ledger = gateLines.join("\n");
  await writeFile(ledgerPath, ledger, "utf8");

  let prd = await readFile(prdPath, "utf8");
  prd = replaceRequired(
    prd,
    "外部责任包 · 0 / 14",
    "外部责任包 · 1 / 14",
    "PRD 外部责任包状态轴"
  );
  prd = replaceRequired(
    prd,
    "当前：外部责任包 0 / 14 Pass；",
    "当前：外部责任包 1 / 14 Pass；",
    "PRD Ddev 门禁摘要"
  );
  prd = replaceRequired(
    prd,
    'data-status-axis="resource" data-contract="resource-baseline" data-value="未选择">资源基线 · 未选择',
    'data-status-axis="resource" data-contract="resource-baseline" data-value="单人全栈 / FDE">资源基线 · 单人全栈 / FDE',
    "PRD 资源基线状态轴"
  );
  await writeFile(prdPath, prd, "utf8");
}

function qaEvidenceDirectory(run, expectedRoot, label) {
  assert.equal(run.status, 0, `${label} 失败\n${run.stderr}\n${run.stdout}`);
  const match = `${run.stdout}\n${run.stderr}`.match(/^证据目录：(.+)$/m);
  assert.ok(match, `${label} 未输出证据目录`);
  const evidenceDir = path.resolve(match[1].trim());
  const relative = path.relative(expectedRoot, evidenceDir);
  assert.ok(
    relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `${label} 证据越出私有 QA 根目录：${evidenceDir}`
  );
  assert.equal(isOutsideRepo(evidenceDir), true, `${label} 证据不得落入公开仓`);
  return evidenceDir;
}

test("公开仓客服真源只使用代号和证据 ID，不诱导提交原始敏感资料", async () => {
  const entries = await Promise.all(currentFiles.map(async (file) => ({
    file,
    text: await readFile(path.join(projectRoot, file), "utf8"),
  })));
  const joined = entries.map(({ file, text }) => `\n# ${file}\n${text}`).join("\n");
  assert.match(joined, /公共仓安全边界/);
  assert.match(joined, /ROLE-\*/);
  assert.match(joined, /EVD-\*/);
  assert.doesNotMatch(joined, /https?:\/\/[^\s)]*feishu\.cn|tenant_access_token|open_id/i);
  assert.doesNotMatch(joined, /\b1[3-9]\d{9}\b/);
  assert.doesNotMatch(joined, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  assert.doesNotMatch(joined, /天元（AI 组 FDE）|\| 角色 \| 姓名 \||外部证据链接 \/ 备注/);
});

test("公开副本不得落正式 A 金额，真实 cap 只能进入私有副本", async () => {
  const cost = await readFile(path.join(projectRoot, "04-费用与成本控制.md"), "utf8");
  assert.doesNotMatch(cost, /^- \[[xX]\] \*\*A 费用可用/m);
  assert.match(cost, /\| 客服项目月 cap \|\s*\|/);
  assert.match(cost, /\| 客服项目全期 cap \|\s*\|/);
  assert.match(cost, /必须先把 00–06 迁到私有仓/);
});

test("公共 CI 不上传客服 PRD 或执行中心浏览器证据", async () => {
  const [quality, pages] = await Promise.all([
    readFile(path.join(repoRoot, ".github/workflows/quality.yml"), "utf8"),
    readFile(path.join(repoRoot, ".github/workflows/pages.yml"), "utf8"),
  ]);
  for (const workflow of [quality, pages]) {
    assert.doesNotMatch(workflow, /output\/customer-agent-(?:prd|hub)-qa/);
  }
  assert.doesNotMatch(pages, /business-docs\/01-客服Agent项目/);
});

test("公开现行文档的相对链接只指向 Git 已跟踪目标，且不暴露姓名或 notes 路径", async () => {
  const referenceDir = path.join(projectRoot, "80-参考");
  const referenceFiles = await collectFiles(referenceDir);
  const documentPaths = [
    ...currentFiles.map((file) => path.join(projectRoot, file)),
    ...referenceFiles,
  ];
  const entries = await Promise.all(
    documentPaths.map(async (file) => ({ file, text: await readFile(file, "utf8") }))
  );
  const trackedResult = spawnSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(trackedResult.status, 0, trackedResult.stderr);
  const trackedFiles = new Set(trackedResult.stdout.split("\0").filter(Boolean));
  const failures = [];

  for (const { file, text } of entries) {
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const rawDestination = match[1].trim();
      const angleMatch = rawDestination.match(/^<([^>]+)>/);
      const destination = angleMatch
        ? angleMatch[1]
        : rawDestination.split(/\s+(?=["'])/)[0];
      if (
        !destination ||
        destination.startsWith("#") ||
        destination.startsWith("/") ||
        destination.startsWith("//") ||
        /^[A-Za-z][A-Za-z\d+.-]*:/.test(destination)
      ) {
        continue;
      }

      let decoded;
      try {
        decoded = decodeURIComponent(destination.split(/[?#]/, 1)[0]);
      } catch {
        failures.push(`${path.relative(repoRoot, file)} -> 无法解码 ${destination}`);
        continue;
      }
      const target = path.resolve(path.dirname(file), decoded);
      if (isOutsideRepo(target)) {
        failures.push(`${path.relative(repoRoot, file)} -> 越出仓库 ${destination}`);
        continue;
      }

      try {
        const targetStat = await stat(target);
        const repoRelative = path.relative(repoRoot, target).split(path.sep).join("/");
        const tracked = targetStat.isDirectory()
          ? [...trackedFiles].some((trackedFile) => trackedFile.startsWith(`${repoRelative}/`))
          : trackedFiles.has(repoRelative);
        if (!tracked) failures.push(`${path.relative(repoRoot, file)} -> 未跟踪 ${destination}`);
      } catch (error) {
        failures.push(`${path.relative(repoRoot, file)} -> 不存在 ${destination} (${error.code || error.message})`);
      }
    }
  }

  assert.deepEqual(failures, []);
  const joined = entries.map(({ file, text }) => `\n# ${path.relative(repoRoot, file)}\n${text}`).join("\n");
  assert.doesNotMatch(joined, /魏炜/);
  assert.doesNotMatch(joined, /\bnotes[\\/]/i);
});

test("客服工作区模式与路径必须成对，未知模式失败关闭", async () => {
  const implicitPublic = await resolveCustomerProjectWorkspace(workspaceModuleUrl, {});
  assert.equal(implicitPublic.mode, "public-template");
  assert.equal(implicitPublic.projectDir, projectRoot);

  const explicitPublic = await resolveCustomerProjectWorkspace(workspaceModuleUrl, {
    CUSTOMER_PROJECT_MODE: "public-template",
  });
  assert.equal(explicitPublic.mode, "public-template");
  assert.equal(explicitPublic.projectDir, projectRoot);

  await assert.rejects(
    resolveCustomerProjectWorkspace(workspaceModuleUrl, {
      CUSTOMER_PROJECT_MODE: "private",
    }),
    /private 时必须同时设置 CUSTOMER_PROJECT_ROOT/
  );
  await assert.rejects(
    resolveCustomerProjectWorkspace(workspaceModuleUrl, {
      CUSTOMER_PROJECT_ROOT: projectRoot,
    }),
    /必须同时设置 CUSTOMER_PROJECT_MODE=private/
  );
  await assert.rejects(
    resolveCustomerProjectWorkspace(workspaceModuleUrl, {
      CUSTOMER_PROJECT_MODE: "public-template",
      CUSTOMER_PROJECT_ROOT: projectRoot,
    }),
    /必须同时设置 CUSTOMER_PROJECT_MODE=private/
  );
  await assert.rejects(
    resolveCustomerProjectWorkspace(workspaceModuleUrl, {
      CUSTOMER_PROJECT_MODE: "staging",
    }),
    /不支持的 CUSTOMER_PROJECT_MODE：staging/
  );
  await assert.rejects(
    resolveCustomerProjectWorkspace(workspaceModuleUrl, {
      CUSTOMER_PROJECT_MODE: "private",
      CUSTOMER_PROJECT_ROOT: "relative/customer-agent",
    }),
    /CUSTOMER_PROJECT_ROOT 必须是绝对路径/
  );
  await assert.rejects(
    resolveCustomerProjectWorkspace(workspaceModuleUrl, {
      CUSTOMER_PROJECT_MODE: "private",
      CUSTOMER_PROJECT_ROOT: projectRoot,
    }),
    /必须位于公开仓库之外/
  );
});

test("真实状态可迁到仓外私有工作区，工具链拒绝覆盖并完整切换", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "customer-private-workspace-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "customer-agent");
  const prepare = path.join(repoRoot, "business-docs/08-工具/prepare_private_customer_project.mjs");
  const checker = path.join(repoRoot, "business-docs/08-工具/check_customer_agent_prd_sources.mjs");
  const generator = path.join(repoRoot, "business-docs/08-工具/generate_customer_agent_hub.mjs");
  const first = spawnSync(process.execPath, [prepare, `--target=${target}`], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  const marker = JSON.parse(await readFile(path.join(target, ".customer-project-private.json"), "utf8"));
  assert.deepEqual({ schemaVersion: marker.schemaVersion, visibility: marker.visibility }, { schemaVersion: 1, visibility: "private" });
  const privateReadme = await readFile(path.join(target, "README.md"), "utf8");
  const privateGuide = await readFile(path.join(target, "PRIVATE-WORKSPACE.md"), "utf8");
  assert.match(privateReadme, /私有现行工作区/);
  assert.match(privateReadme, /当前目录已经完成迁移/);
  assert.match(privateReadme, /不要再次运行 `prepare_private_customer_project\.mjs`/);
  assert.doesNotMatch(privateReadme, /公共仓安全边界|进入真实状态或选择 A 前/);
  assert.match(privateGuide, /当前目录已完成迁移/);
  assert.match(privateGuide, /QA 证据默认写入本目录的 `\.qa-output\/`/);

  const env = { ...process.env, CUSTOMER_PROJECT_MODE: "private", CUSTOMER_PROJECT_ROOT: target };
  const workspace = await resolveCustomerProjectWorkspace(workspaceModuleUrl, env);
  const canonicalTarget = await realpath(target);
  assert.equal(workspace.mode, "private");
  assert.equal(workspace.projectDir, canonicalTarget);
  const linkedTarget = path.join(parent, "customer-agent-link");
  await symlink(target, linkedTarget, "dir");
  await assert.rejects(
    resolveCustomerProjectWorkspace(workspaceModuleUrl, {
      ...env,
      CUSTOMER_PROJECT_ROOT: linkedTarget,
    }),
    /不能是符号链接/
  );
  for (const [surface, outputDirectory] of [
    ["prd", "customer-agent-prd-qa"],
    ["hub", "customer-agent-hub-qa"],
  ]) {
    const qaPaths = resolveCustomerProjectQaPaths(workspace, surface);
    assert.deepEqual(qaPaths, {
      trustedRootPath: canonicalTarget,
      rootPath: path.join(canonicalTarget, ".qa-output", outputDirectory),
    });
    assert.equal(isOutsideRepo(qaPaths.rootPath), true);
  }
  await advancePrivateFixture(target);
  const update = spawnSync(process.execPath, [checker, "--update"], { cwd: repoRoot, env, encoding: "utf8" });
  assert.equal(update.status, 0, `${update.stderr}\n${update.stdout}`);
  const generate = spawnSync(process.execPath, [generator], { cwd: repoRoot, env, encoding: "utf8" });
  assert.equal(generate.status, 0, `${generate.stderr}\n${generate.stdout}`);
  await stat(path.join(target, "07-客服Agent立项PRD.sources.json"));
  const prd = await readFile(path.join(target, "07-客服Agent立项PRD.html"), "utf8");
  const hub = await readFile(path.join(target, "08-客服Agent立项执行中心.html"), "utf8");
  assert.match(prd, /data-status-axis="external">\s*外部责任包 · 1 \/ 14/);
  assert.doesNotMatch(prd, /data-status-axis="external">\s*外部责任包 · 0 \/ 14/);
  const payloadMatch = hub.match(/<script id="hub-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(payloadMatch, "私有 Hub 缺少 hub-data");
  const payload = JSON.parse(payloadMatch[1]);
  assert.equal(payload.status.externalPass, 1);
  assert.equal(payload.status.externalTotal, 14);
  assert.equal(payload.status.resourceBaseline, "单人全栈 / FDE");
  assert.equal(payload.gates.find((gate) => gate.id === "G0-08")?.status, "Pass");
  assert.equal(payload.gates.find((gate) => gate.id === "G0-08")?.evidence, "EVD-REUSE-001");

  const qaEnv = { ...env };
  const prdQa = spawnSync(
    process.execPath,
    [path.join(repoRoot, "business-docs/08-工具/test_customer_agent_prd.mjs"), "--round=private-progress"],
    { cwd: repoRoot, env: qaEnv, encoding: "utf8", timeout: 120_000, maxBuffer: 5 * 1024 * 1024 }
  );
  const prdEvidenceDir = qaEvidenceDirectory(
    prdQa,
    path.join(canonicalTarget, ".qa-output/customer-agent-prd-qa"),
    "私有 PRD QA"
  );
  const prdResults = JSON.parse(await readFile(path.join(prdEvidenceDir, "results.json"), "utf8"));
  assert.equal(prdResults.summary.failed, 0);
  assert.equal(prdResults.targetPath, path.join(canonicalTarget, "07-客服Agent立项PRD.html"));

  const hubQa = spawnSync(
    process.execPath,
    [path.join(repoRoot, "business-docs/08-工具/test_customer_agent_hub.mjs"), "--round=private-progress"],
    { cwd: repoRoot, env: qaEnv, encoding: "utf8", timeout: 120_000, maxBuffer: 5 * 1024 * 1024 }
  );
  const hubEvidenceDir = qaEvidenceDirectory(
    hubQa,
    path.join(canonicalTarget, ".qa-output/customer-agent-hub-qa"),
    "私有 Hub QA"
  );
  const hubResults = JSON.parse(await readFile(path.join(hubEvidenceDir, "results.json"), "utf8"));
  assert.equal(hubResults.summary.failed, 0);
  assert.equal(hubResults.targetPath, path.join(canonicalTarget, "08-客服Agent立项执行中心.html"));

  const second = spawnSync(process.execPath, [prepare, `--target=${target}`], { cwd: repoRoot, encoding: "utf8" });
  assert.notEqual(second.status, 0, "迁移脚本不得覆盖既有私有工作区");
  assert.match(`${second.stderr}\n${second.stdout}`, /目标已存在，拒绝覆盖/);
});
