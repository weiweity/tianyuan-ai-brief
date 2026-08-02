import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  resolveCustomerProjectQaPaths,
  resolveCustomerProjectWorkspace,
} from "../../business-docs/08-工具/project_workspace.mjs";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(siteRoot, "..");
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

async function artifactState(paths) {
  return Promise.all(
    paths.map(async (filePath) => ({
      filePath,
      bytes: await readFile(filePath),
      mtimeNs: (await stat(filePath, { bigint: true })).mtimeNs,
    }))
  );
}

async function advancePrivateFixture(target) {
  const readmePath = path.join(target, "README.md");
  const charterPath = path.join(target, "00-项目章程.md");
  const ledgerPath = path.join(target, "02-G0责任与证据台账.md");
  const prdPath = path.join(target, "07-客服Agent立项PRD.html");

  const charter = replaceRequired(
    await readFile(charterPath, "utf8"),
    "外部责任包 **1/14**、Scope **1/15**",
    "外部责任包 **2/14**、Scope **1/15**",
    "私有章程门禁汇总"
  );
  await writeFile(charterPath, charter, "utf8");

  const readme = replaceRequired(
    await readFile(readmePath, "utf8"),
    "外部责任包 1/14、Scope 1/15（合计 2/29）",
    "外部责任包 2/14、Scope 1/15（合计 3/29）",
    "私有 README 门禁汇总"
  );
  await writeFile(readmePath, readme, "utf8");

  let ledger = replaceRequired(
    await readFile(ledgerPath, "utf8"),
    "| 外部责任包 | **1/14 Pass** | G0-02 已完成；G0-03～15 待关闭 |",
    "| 外部责任包 | **2/14 Pass** | G0-02、G0-08 已完成；其余待关闭 |",
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
    "外部责任包 · 1 / 14",
    "外部责任包 · 2 / 14",
    "PRD 外部责任包状态轴"
  );
  prd = replaceRequired(
    prd,
    "外部责任包 1 / 14；Scope 检查 1 / 15；",
    "外部责任包 2 / 14；Scope 检查 1 / 15；",
    "PRD Ddev 门禁摘要"
  );
  prd = replaceRequired(
    prd,
    "当前只完成 2 / 29 项准备",
    "当前只完成 3 / 29 项准备",
    "PRD 总准备计数"
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

test("公共 CI 不上传客服三视图浏览器证据", async () => {
  const [quality, pages] = await Promise.all([
    readFile(path.join(repoRoot, ".github/workflows/quality.yml"), "utf8"),
    readFile(path.join(repoRoot, ".github/workflows/pages.yml"), "utf8"),
  ]);
  for (const workflow of [quality, pages]) {
    assert.doesNotMatch(workflow, /output\/customer-agent-(?:prd|hub|meeting)-qa/);
  }
  assert.match(pages, /business-docs\/01-客服Agent项目\/09-客服Agent需求会汇报\.html/);
  assert.doesNotMatch(
    pages,
    /business-docs\/01-客服Agent项目\/(?:00-|01-|02-|03-|04-|05-|06-|07-|08-)/
  );
});

test("公开现行文档的相对链接只指向已跟踪目标或 canonical 09 生成视图，且不暴露姓名或 notes 路径", async () => {
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
  const canonicalGeneratedFiles = new Set([
    "business-docs/01-客服Agent项目/09-客服Agent需求会汇报.html",
  ]);
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
          : trackedFiles.has(repoRelative) || canonicalGeneratedFiles.has(repoRelative);
        if (!tracked) failures.push(`${path.relative(repoRoot, file)} -> 未跟踪 ${destination}`);
      } catch (error) {
        failures.push(`${path.relative(repoRoot, file)} -> 不存在 ${destination} (${error.code || error.message})`);
      }
    }
  }

  assert.deepEqual(failures, []);
  const meetingHtml = await readFile(path.join(projectRoot, "09-客服Agent需求会汇报.html"), "utf8");
  assert.match(meetingHtml, /GENERATED FILE — safe meeting view; DO NOT EDIT/);
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

test("PRIVATE-WORKSPACE 按 POSIX 字面量导出特殊路径，zsh/bash 均不执行路径内容", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "customer-private-shell-quote-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const substitutionMarker = "COMMAND_SUBSTITUTION_SIDE_EFFECT";
  const backtickMarker = "BACKTICK_SIDE_EFFECT";
  const target = path.join(
    parent,
    `customer agent's $(touch ${substitutionMarker}) \`touch ${backtickMarker}\` $HOME`
  );
  const prepare = path.join(repoRoot, "business-docs/08-工具/prepare_private_customer_project.mjs");
  const prepared = spawnSync(process.execPath, [prepare, `--target=${target}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(prepared.status, 0, `${prepared.stderr}\n${prepared.stdout}`);

  const privateGuide = await readFile(path.join(target, "PRIVATE-WORKSPACE.md"), "utf8");
  const rootExport = privateGuide
    .split(/\r?\n/)
    .find((line) => line.startsWith("export CUSTOMER_PROJECT_ROOT="));
  assert.ok(rootExport, "私有指南缺少 CUSTOMER_PROJECT_ROOT 导出命令");
  assert.match(rootExport, /^export CUSTOMER_PROJECT_ROOT='.*'$/);
  assert.ok(rootExport.includes("'\"'\"'"), "单引号未使用 POSIX 字面量转义");
  assert.ok(rootExport.includes(`$(touch ${substitutionMarker})`));
  assert.ok(rootExport.includes(`\`touch ${backtickMarker}\``));
  assert.ok(rootExport.includes("$HOME"));
  assert.doesNotMatch(rootExport, /^export CUSTOMER_PROJECT_ROOT="/);

  const shellEnv = {
    ...process.env,
    HOME: path.join(parent, "fake-home-must-not-expand"),
    CUSTOMER_PROJECT_ROOT: "preexisting-value",
  };
  delete shellEnv.BASH_ENV;
  delete shellEnv.ENV;
  const shellScript = `${rootExport}\nprintf '%s' "$CUSTOMER_PROJECT_ROOT"`;
  const runs = [];
  for (const shell of [
    { name: "zsh", command: "/bin/zsh", args: ["-f", "-c", shellScript] },
    {
      name: "bash",
      command: "/bin/bash",
      args: ["--noprofile", "--norc", "-c", shellScript],
    },
  ]) {
    const probeDir = await mkdtemp(path.join(parent, `${shell.name}-probe-`));
    const run = spawnSync(shell.command, shell.args, {
      cwd: probeDir,
      env: shellEnv,
      encoding: "utf8",
    });
    const sideEffects = [];
    for (const marker of [substitutionMarker, backtickMarker]) {
      try {
        await stat(path.join(probeDir, marker));
        sideEffects.push(marker);
      } catch (error) {
        assert.equal(error?.code, "ENOENT", `${shell.name} 副作检查失败：${error}`);
      }
    }
    runs.push({ ...shell, run, sideEffects });
  }

  assert.deepEqual(
    runs.map(({ name, sideEffects }) => ({ name, sideEffects })),
    [
      { name: "zsh", sideEffects: [] },
      { name: "bash", sideEffects: [] },
    ]
  );
  for (const { name, run } of runs) {
    assert.equal(run.status, 0, `${name} 解析失败：${run.stderr}`);
    assert.equal(run.stderr, "");
    assert.equal(run.stdout, target, `${name} 未按字面量保留目标路径`);
  }
});

test("真实状态可迁到仓外私有工作区，工具链拒绝覆盖并完整切换", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "customer-private-workspace-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "customer-agent");
  const prepare = path.join(repoRoot, "business-docs/08-工具/prepare_private_customer_project.mjs");
  const surfaceSync = path.join(repoRoot, "business-docs/08-工具/sync_customer_agent_surfaces.mjs");
  const first = spawnSync(process.execPath, [prepare, `--target=${target}`], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  const marker = JSON.parse(await readFile(path.join(target, ".customer-project-private.json"), "utf8"));
  assert.deepEqual({ schemaVersion: marker.schemaVersion, visibility: marker.visibility }, { schemaVersion: 1, visibility: "private" });
  const privateReadme = await readFile(path.join(target, "README.md"), "utf8");
  const privateGuide = await readFile(path.join(target, "PRIVATE-WORKSPACE.md"), "utf8");
  assert.match(privateReadme, /私有现行工作区/);
  assert.match(privateReadme, /当前目录已经完成迁移/);
  assert.match(privateReadme, /不要再次运行 `prepare_private_customer_project\.mjs`/);
  assert.doesNotMatch(privateReadme, /公共仓安全边界|进入真实状态或选择 A 前|如需录入真实姓名/);
  assert.match(privateGuide, /当前目录已完成迁移/);
  assert.match(privateGuide, /三套浏览器 QA 证据默认写入本目录的 `\.qa-output\/`/);
  assert.match(privateGuide, /sync_customer_agent_surfaces\.mjs/);
  await stat(path.join(target, "08-客服Agent立项执行中心.html"));
  await stat(path.join(target, "09-客服Agent需求会汇报.html"));

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
    ["meeting", "customer-agent-meeting-qa"],
  ]) {
    const qaPaths = resolveCustomerProjectQaPaths(workspace, surface);
    assert.deepEqual(qaPaths, {
      trustedRootPath: canonicalTarget,
      rootPath: path.join(canonicalTarget, ".qa-output", outputDirectory),
    });
    assert.equal(isOutsideRepo(qaPaths.rootPath), true);
  }
  await advancePrivateFixture(target);
  const sync = spawnSync(process.execPath, [surfaceSync], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(sync.status, 0, `${sync.stderr}\n${sync.stdout}`);
  assert.match(sync.stdout, /客服三视图已同步并收敛 · private/);
  const stable = spawnSync(process.execPath, [surfaceSync, "--check"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(stable.status, 0, `${stable.stderr}\n${stable.stdout}`);
  assert.match(stable.stdout, /客服三视图已在稳定点 · private/);
  const prdPath = path.join(target, "07-客服Agent立项PRD.html");
  const manifestPath = path.join(target, "07-客服Agent立项PRD.sources.json");
  const hubPath = path.join(target, "08-客服Agent立项执行中心.html");
  const meetingPath = path.join(target, "09-客服Agent需求会汇报.html");
  const managedSurfaces = [prdPath, manifestPath, hubPath, meetingPath];
  const fixedTime = new Date("2001-01-01T00:00:00.000Z");
  await Promise.all(managedSurfaces.map((filePath) => utimes(filePath, fixedTime, fixedTime)));

  const generator = path.join(repoRoot, "business-docs/08-工具/generate_customer_agent_hub.mjs");
  const hubStableBefore = await artifactState([hubPath]);
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const directGenerator = spawnSync(process.execPath, [generator], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(
      directGenerator.status,
      0,
      `第 ${iteration + 1} 次直接 Hub 生成失败\n${directGenerator.stderr}\n${directGenerator.stdout}`
    );
    assert.match(directGenerator.stdout, /执行中心已稳定，未重写/);
  }
  assert.deepEqual(
    await artifactState([hubPath]),
    hubStableBefore,
    "generator 连续运行时 Hub bytes + mtime 必须幂等"
  );

  const meetingGenerator = path.join(repoRoot, "business-docs/08-工具/generate_customer_agent_meeting.mjs");
  const meetingStableBefore = await artifactState([meetingPath]);
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const directGenerator = spawnSync(process.execPath, [meetingGenerator], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(
      directGenerator.status,
      0,
      `第 ${iteration + 1} 次直接 Meeting 生成失败\n${directGenerator.stderr}\n${directGenerator.stdout}`
    );
    assert.match(directGenerator.stdout, /需求会汇报已稳定，未重写/);
  }
  assert.deepEqual(
    await artifactState([meetingPath]),
    meetingStableBefore,
    "generator 连续运行时 Meeting bytes + mtime 必须幂等"
  );

  const syncStableBefore = await artifactState(managedSurfaces);
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const stableSync = spawnSync(process.execPath, [surfaceSync], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(
      stableSync.status,
      0,
      `第 ${iteration + 1} 次稳定点同步失败\n${stableSync.stderr}\n${stableSync.stdout}`
    );
    assert.match(stableSync.stdout, /PRD 真源清单已稳定，未重写/);
    assert.match(stableSync.stdout, /执行中心已稳定，未重写/);
    assert.match(stableSync.stdout, /需求会汇报已稳定，未重写/);
  }
  assert.deepEqual(
    await artifactState(managedSurfaces),
    syncStableBefore,
    "连续 sync 在稳定点必须保持 PRD / manifest / Hub / Meeting bytes + mtime 全部不变"
  );
  await stat(path.join(target, "07-客服Agent立项PRD.sources.json"));
  const prd = await readFile(prdPath, "utf8");
  const hub = await readFile(hubPath, "utf8");
  assert.match(prd, /data-status-axis="external">\s*外部责任包 · 2 \/ 14/);
  assert.doesNotMatch(prd, /data-status-axis="external">\s*外部责任包 · 1 \/ 14/);
  const payloadMatch = hub.match(/<script id="hub-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(payloadMatch, "私有 Hub 缺少 hub-data");
  const payload = JSON.parse(payloadMatch[1]);
  assert.equal(payload.status.externalPass, 2);
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

  const meetingQa = spawnSync(
    process.execPath,
    [path.join(repoRoot, "business-docs/08-工具/test_customer_agent_meeting.mjs"), "--round=private-progress"],
    { cwd: repoRoot, env: qaEnv, encoding: "utf8", timeout: 120_000, maxBuffer: 5 * 1024 * 1024 }
  );
  const meetingEvidenceDir = qaEvidenceDirectory(
    meetingQa,
    path.join(canonicalTarget, ".qa-output/customer-agent-meeting-qa"),
    "私有 Meeting QA"
  );
  const meetingResults = JSON.parse(await readFile(path.join(meetingEvidenceDir, "results.json"), "utf8"));
  assert.equal(meetingResults.summary.failed, 0);
  assert.equal(meetingResults.targetPath, path.join(canonicalTarget, "09-客服Agent需求会汇报.html"));

  const second = spawnSync(process.execPath, [prepare, `--target=${target}`], { cwd: repoRoot, encoding: "utf8" });
  assert.notEqual(second.status, 0, "迁移脚本不得覆盖既有私有工作区");
  assert.match(`${second.stderr}\n${second.stdout}`, /目标已存在，拒绝覆盖/);
});
