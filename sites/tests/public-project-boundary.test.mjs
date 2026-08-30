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
const publicSensitiveScanFiles = [
  ...currentFiles,
  "07-客服Agent立项PRD.html",
  "07-客服Agent立项PRD.sources.json",
  "08-客服Agent立项执行中心.html",
  "09-客服Agent需求会汇报.html",
];

const feishuSensitivePatterns = {
  url: /https?:\/\/[^\s)"'<>]*(?:feishu\.cn|larksuite\.com)(?:[^\s)"'<>]*)?/i,
  valuedToken: /\b(?:doc_token|wiki_token|file_token|tenant_access_token|open_id)\b["'`]?\s*(?:=|:|：)\s*(?:"[A-Za-z0-9._~+\/-]{8,}"|'[A-Za-z0-9._~+\/-]{8,}'|`[A-Za-z0-9._~+\/-]{8,}`|[A-Za-z0-9._~+\/-]{8,})/i,
  entityId: /\b(?:ou|oc|on)_[A-Za-z0-9_-]{8,}\b/i,
  snapshotSha256: /\bsnapshot_sha256\b\s*(?:=|:|：)\s*["'`]?[a-f\d]{64}\b/i,
};
const publicEmailPattern = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/i;

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
  const g003Evidence = "EVD-G0-03-MENOKIN-APPLICABILITY-20260830";
  const g009ClosureEvidence = "EVD-G0-09-AUTHORITY-SOURCES-20260830";
  const g013Evidence = "EVD-G0-13-MENOKIN-EVALUATION-FREEZE-20260830";
  const readmePath = path.join(target, "README.md");
  const charterPath = path.join(target, "00-项目章程.md");
  const ledgerPath = path.join(target, "02-G0责任与证据台账.md");
  const scopePath = path.join(target, "03-Scope与验收.md");
  const prdPath = path.join(target, "07-客服Agent立项PRD.html");

  const charter = replaceRequired(
    await readFile(charterPath, "utf8"),
    "外部责任包 **11/14**、Scope **11/15**",
    "外部责任包 **14/14**、Scope **15/15**",
    "私有章程门禁汇总"
  );
  await writeFile(charterPath, charter, "utf8");

  const readme = replaceRequired(
    await readFile(readmePath, "utf8"),
    "外部责任包 11/14、Scope 11/15（合计 22/29）",
    "外部责任包 14/14、Scope 15/15（合计 29/29）",
    "私有 README 门禁汇总"
  );
  await writeFile(readmePath, readme, "utf8");

  const gateLines = (await readFile(ledgerPath, "utf8")).split(/\r?\n/);
  const summaryIndex = gateLines.findIndex((line) => line.startsWith("| 外部责任包 |"));
  assert.notEqual(summaryIndex, -1, "私有台账缺少外部责任包汇总");
  const summaryCells = gateLines[summaryIndex].split("|");
  assert.equal(
    summaryCells[2].replace(/\*\*/g, "").trim(),
    "11/14 Pass",
    "私有台账必须从当前 11/14 基线推进"
  );
  summaryCells[2] = " **14/14 Pass** ";
  summaryCells[3] = " G0-02～G0-15 已完成；等待正式 G0 签发（职责接受与草案不等于 Pass） ";
  gateLines[summaryIndex] = summaryCells.join("|");
  const priorityIndex = gateLines.findIndex((line) => line.startsWith("| 业务问题优先级 |"));
  assert.notEqual(priorityIndex, -1, "私有台账缺少业务问题优先级汇总");
  const priorityCells = gateLines[priorityIndex].split("|");
  priorityCells[2] = " **已核验** ";
  priorityCells[3] = ` Menokin 适用性已由 \`${g003Evidence}\` 签发 `;
  gateLines[priorityIndex] = priorityCells.join("|");
  const scopeSummaryIndex = gateLines.findIndex((line) => line.startsWith("| Scope 检查 |"));
  assert.notEqual(scopeSummaryIndex, -1, "私有台账缺少 Scope 汇总");
  const scopeSummaryCells = gateLines[scopeSummaryIndex].split("|");
  assert.equal(scopeSummaryCells[2].replace(/\*\*/g, "").trim(), "11/15 Pass");
  scopeSummaryCells[2] = " **15/15 Pass** ";
  scopeSummaryCells[3] = " #1～#15 已确认；等待正式 G0 签发 ";
  gateLines[scopeSummaryIndex] = scopeSummaryCells.join("|");
  for (const [gateId, evidence] of [
    ["G0-03", g003Evidence],
    ["G0-09", g009ClosureEvidence],
    ["G0-13", g013Evidence],
  ]) {
    const gateIndex = gateLines.findIndex((line) => line.startsWith(`| ${gateId} |`));
    assert.notEqual(gateIndex, -1, `私有台账缺少 ${gateId}`);
    const gateCells = gateLines[gateIndex].split("|");
    assert.equal(gateCells.length, 9, `${gateId} 表格结构异常`);
    assert.equal(
      gateCells[6].replace(/\*\*/g, "").trim(),
      "进行中",
      `${gateId} 应从进行中基线推进`
    );
    gateCells[6] = " **Pass** ";
    gateCells[7] = ` \`${evidence}\` `;
    gateLines[gateIndex] = gateCells.join("|");
  }

  // 仅用于仓外私有迁移测试：使用不透明代号、脱敏计数和 EVD 收据，
  // 不写入 URL、token、真实标题、原始快照 SHA、成员名单或审批原文。
  const readyReceiptRows = [
    {
      domain: "presale",
      sourceRef: "SRC-1A7C9E4B2D8F6H3K",
      sourceVersionId: "srcv_2b8d4f6a1c3e7b90",
      snapshotEvd: "EVD-G0-09-PRESALE-SNAPSHOT-20260830",
      aclEvd: "EVD-FEISHU-ACL-PRESALE-20260830",
      totalRows: 81,
      importableRows: 79,
      quarantinedRows: 2,
      qualityEvd: "EVD-G0-09-PRESALE-QUALITY-20260830",
    },
    {
      domain: "campaign",
      sourceRef: "SRC-04A9A86874258A6A",
      sourceVersionId: "srcv_76b9165b2fe31908",
      snapshotEvd: "EVD-G0-09-CAMPAIGN-SNAPSHOT-20260830",
      aclEvd: "EVD-FEISHU-ACL-CAMPAIGN-20260830",
      totalRows: 4,
      importableRows: 4,
      quarantinedRows: 0,
      qualityEvd: "EVD-G0-09-CAMPAIGN-QUALITY-20260830",
    },
    {
      domain: "aftersale",
      sourceRef: "SRC-8C2E6G4J9L1N5Q7S",
      sourceVersionId: "srcv_5d9a1c3e7b2f6d80",
      snapshotEvd: "EVD-G0-09-AFTERSALE-SNAPSHOT-20260830",
      aclEvd: "EVD-FEISHU-ACL-AFTERSALE-20260830",
      totalRows: 223,
      importableRows: 223,
      quarantinedRows: 0,
      qualityEvd: "EVD-G0-09-AFTERSALE-QUALITY-20260830",
    },
    {
      domain: "product",
      sourceRef: "SRC-60D6B23861F4FBF5",
      sourceVersionId: "srcv_88af65aa70c894aa",
      snapshotEvd: "EVD-G0-09-PRODUCT-SNAPSHOT-20260830",
      aclEvd: "EVD-FEISHU-ACL-PRODUCT-20260830",
      totalRows: 106,
      importableRows: 106,
      quarantinedRows: 0,
      qualityEvd: "EVD-G0-09-PRODUCT-QUALITY-20260830",
    },
  ];
  for (const row of readyReceiptRows) {
    const receiptIndex = gateLines.findIndex((line) => line.startsWith(`| ${row.domain} |`));
    assert.notEqual(receiptIndex, -1, `私有台账缺少 ${row.domain} G0-09 关闭收据`);
    const receiptCells = gateLines[receiptIndex].split("|");
    assert.equal(receiptCells.length, 14, `${row.domain} G0-09 关闭收据结构异常`);
    assert.equal(receiptCells[12].trim(), "INCOMPLETE", `${row.domain} 收据应从 INCOMPLETE 推进`);
    gateLines[receiptIndex] = [
      "",
      ` ${row.domain} `,
      ` ${row.sourceRef} `,
      ` ${row.sourceVersionId} `,
      ` ${row.snapshotEvd} `,
      ` ${row.aclEvd} `,
      ` ${row.totalRows} `,
      ` ${row.importableRows} `,
      ` ${row.quarantinedRows} `,
      ` ${row.qualityEvd} `,
      " ROLE-CONTENT-LEAD ",
      ` ${g009ClosureEvidence} `,
      " READY ",
      "",
    ].join("|");
  }
  const ledger = gateLines.join("\n");
  await writeFile(ledgerPath, ledger, "utf8");

  const scopeLines = (await readFile(scopePath, "utf8")).split(/\r?\n/);
  for (const [scopeId, evidence] of [
    ["5", g003Evidence],
    ["6", g003Evidence],
    ["9", g009ClosureEvidence],
    ["14", g013Evidence],
  ]) {
    const scopeIndex = scopeLines.findIndex((line) => line.startsWith(`| ${scopeId} |`));
    assert.notEqual(scopeIndex, -1, `私有 Scope 缺少 #${scopeId}`);
    const scopeCells = scopeLines[scopeIndex].split("|");
    assert.equal(scopeCells[4].trim(), "[ ]", `Scope #${scopeId} 必须从未完成基线推进`);
    scopeCells[4] = " [X] ";
    scopeCells[5] = ` \`${evidence}\` `;
    scopeLines[scopeIndex] = scopeCells.join("|");
  }
  await writeFile(scopePath, scopeLines.join("\n"), "utf8");

  let prd = await readFile(prdPath, "utf8");
  prd = replaceRequired(
    prd,
    "外部责任包 · 11 / 14",
    "外部责任包 · 14 / 14",
    "PRD 外部责任包状态轴"
  );
  prd = replaceRequired(
    prd,
    "外部责任包 11 / 14；Scope 检查 11 / 15；",
    "外部责任包 14 / 14；Scope 检查 15 / 15；",
    "PRD Ddev 门禁摘要"
  );
  prd = replaceRequired(
    prd,
    "Scope · 11 / 15",
    "Scope · 15 / 15",
    "PRD Scope 状态轴"
  );
  prd = replaceRequired(
    prd,
    "当前只完成 22 / 29 项准备",
    "当前只完成 29 / 29 项准备",
    "PRD 总准备计数"
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

test("公开仓客服真源与生成视图只使用代号和证据 ID，不诱导提交原始敏感资料", async () => {
  const entries = await Promise.all(publicSensitiveScanFiles.map(async (file) => ({
    file,
    text: await readFile(path.join(projectRoot, file), "utf8"),
  })));
  const joined = entries.map(({ file, text }) => `\n# ${file}\n${text}`).join("\n");
  assert.match(joined, /公共仓安全边界/);
  assert.match(joined, /ROLE-\*/);
  assert.match(joined, /EVD-\*/);
  for (const { file, text } of entries) {
    for (const [label, pattern] of Object.entries(feishuSensitivePatterns)) {
      assert.doesNotMatch(text, pattern, `${file} 不得包含飞书敏感值：${label}`);
    }
    assert.doesNotMatch(text, /\b1[3-9]\d{9}\b/, `${file} 不得包含手机号`);
    assert.doesNotMatch(text, publicEmailPattern, `${file} 不得包含邮箱`);
  }
  assert.doesNotMatch(joined, /天元（AI 组 FDE）|\| 角色 \| 姓名 \||外部证据链接 \/ 备注/);
});

test("飞书敏感扫描识别实体值，但不全局禁止合法 64 位哈希", () => {
  const sensitiveFixtures = [
    ["url", "https://example.feishu.cn/docx/ExampleToken123"],
    ["url", "https://example.larksuite.com/wiki/ExampleToken123"],
    ["valuedToken", '"doc_token": "doxcnExampleToken123"'],
    ["valuedToken", "wiki_token=wikcnExampleToken123"],
    ["valuedToken", "file_token：boxcnExampleToken123"],
    ["valuedToken", "tenant_access_token=t-ExampleToken123"],
    ["valuedToken", "open_id=ou_ExampleEntity123"],
    ["entityId", "ou_ExampleEntity123"],
    ["entityId", "oc_ExampleEntity123"],
    ["entityId", "on_ExampleEntity123"],
    ["snapshotSha256", `snapshot_sha256=${"a".repeat(64)}`],
  ];
  for (const [patternName, fixture] of sensitiveFixtures) {
    assert.match(fixture, feishuSensitivePatterns[patternName], `应识别飞书敏感样例：${fixture}`);
  }

  const legitimateArtifactHashes = [
    `schema SHA-256 ${"b".repeat(64)}`,
    `OpenAPI SHA-256: ${"c".repeat(64)}`,
  ];
  for (const fixture of legitimateArtifactHashes) {
    for (const pattern of Object.values(feishuSensitivePatterns)) {
      assert.doesNotMatch(fixture, pattern, `合法产物哈希不应被误报：${fixture}`);
    }
  }
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
  assert.match(sync.stdout, /客服双视图已同步并收敛；需求会视图生命周期已结束，保留历史文件 · private/);
  const stable = spawnSync(process.execPath, [surfaceSync, "--check"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(stable.status, 0, `${stable.stderr}\n${stable.stdout}`);
  assert.match(stable.stdout, /客服双视图已在稳定点；需求会视图生命周期已结束，保留历史文件 · private/);
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
    assert.notEqual(
      directGenerator.status,
      0,
      `第 ${iteration + 1} 次直接 Meeting 生成应被已关闭生命周期拒绝`
    );
    assert.match(
      `${directGenerator.stderr}\n${directGenerator.stdout}`,
      /生命周期已结束，拒绝改写会前状态/
    );
  }
  assert.deepEqual(
    await artifactState([meetingPath]),
    meetingStableBefore,
    "生命周期关闭后 Meeting bytes + mtime 必须保持冻结"
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
    assert.match(stableSync.stdout, /启动会冻结快照有效/);
  }
  assert.deepEqual(
    await artifactState(managedSurfaces),
    syncStableBefore,
    "连续 sync 在稳定点必须保持 PRD / manifest / Hub / Meeting bytes + mtime 全部不变"
  );
  await stat(path.join(target, "07-客服Agent立项PRD.sources.json"));
  const prd = await readFile(prdPath, "utf8");
  const hub = await readFile(hubPath, "utf8");
  assert.match(prd, /data-status-axis="external">\s*外部责任包 · 14 \/ 14/);
  assert.doesNotMatch(prd, /data-status-axis="external">\s*外部责任包 · 13 \/ 14/);
  const payloadMatch = hub.match(/<script id="hub-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(payloadMatch, "私有 Hub 缺少 hub-data");
  const payload = JSON.parse(payloadMatch[1]);
  assert.equal(payload.status.externalPass, 14);
  assert.equal(payload.status.externalTotal, 14);
  assert.equal(payload.status.scopePass, 15);
  assert.equal(payload.status.scopeTotal, 15);
  assert.equal(payload.status.resourceBaseline, "单人全栈 / FDE");
  assert.equal(payload.gates.find((gate) => gate.id === "G0-05")?.status, "Pass");
  assert.equal(
    payload.gates.find((gate) => gate.id === "G0-05")?.evidence,
    "EVD-CONTENT-OWNER-ACCEPT-20260809"
  );
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
  assert.equal(payload.gates.find((gate) => gate.id === "G0-10")?.status, "Pass");
  assert.equal(payload.gates.find((gate) => gate.id === "G0-10")?.evidence, "EVD-G0-10-PRD-SCOPE-FREEZE-20260810");
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
  assert.equal(payload.gates.find((gate) => gate.id === "G0-13")?.status, "Pass");
  assert.equal(
    payload.gates.find((gate) => gate.id === "G0-13")?.evidence,
    "EVD-G0-13-MENOKIN-EVALUATION-FREEZE-20260830"
  );
  assert.equal(payload.scopeChecks.find((item) => String(item.id) === "14")?.status, "Pass");
  assert.equal(
    payload.scopeChecks.find((item) => String(item.id) === "14")?.evidence,
    "EVD-G0-13-MENOKIN-EVALUATION-FREEZE-20260830"
  );

  const privateLedgerPath = path.join(target, "02-G0责任与证据台账.md");
  const acceptedLedger = await readFile(privateLedgerPath, "utf8");
  const acceptedSurfaceBytes = await Promise.all(managedSurfaces.map((filePath) => readFile(filePath)));
  try {
    const candidateLines = acceptedLedger.split(/\r?\n/);
    const designRoleIndex = candidateLines.findIndex((line) => line.startsWith("| 设计负责人 |"));
    assert.notEqual(designRoleIndex, -1, "私有台账缺少设计负责人 RACI 行");
    const designRoleCells = candidateLines[designRoleIndex].split("|");
    assert.equal(designRoleCells[2].trim(), "USR-TIANYUAN-001");
    assert.equal(designRoleCells[5].trim(), "已接受");
    designRoleCells[4] = " ";
    designRoleCells[5] = " 候选 ";
    designRoleCells[6] = " ";
    candidateLines[designRoleIndex] = designRoleCells.join("|");
    await writeFile(privateLedgerPath, candidateLines.join("\n"), "utf8");

    const candidateSync = spawnSync(process.execPath, [surfaceSync], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(candidateSync.status, 0, `${candidateSync.stderr}\n${candidateSync.stdout}`);
    const candidateHub = await readFile(hubPath, "utf8");
    const candidatePayloadMatch = candidateHub.match(
      /<script id="hub-data" type="application\/json">([\s\S]*?)<\/script>/
    );
    assert.ok(candidatePayloadMatch, "候选角色场景的私有 Hub 缺少 hub-data");
    const candidatePayload = JSON.parse(candidatePayloadMatch[1]);
    const candidateDesignRole = candidatePayload.governance.roles.find(
      (item) => item.role === "设计负责人"
    );
    assert.ok(candidateDesignRole, "候选角色场景缺少设计负责人投影");
    assert.equal(candidateDesignRole.name, "USR-TIANYUAN-001", "候选角色仍应保留公开代号");
    assert.equal(candidateDesignRole.needsNaming, false, "已有代号的候选角色不应误报待具名");
    assert.equal(candidateDesignRole.needsAcceptance, true, "候选角色必须继续显示待接受职责");
    assert.equal(
      candidatePayload.governance.roles.filter((item) => item.needsAcceptance).length,
      1,
      "只有回退为候选的设计负责人应待接受职责"
    );
    assert.match(candidatePayload.headline.summary, /12\/13 个角色已接受职责，其余仍待受控确认/);
    assert.match(candidatePayload.meeting.positioning, /12\/13 个角色已接受职责，其余仍待受控确认/);
  } finally {
    await writeFile(privateLedgerPath, acceptedLedger, "utf8");
    const restoreSync = spawnSync(process.execPath, [surfaceSync], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(restoreSync.status, 0, `${restoreSync.stderr}\n${restoreSync.stdout}`);
  }
  assert.deepEqual(
    await Promise.all(managedSurfaces.map((filePath) => readFile(filePath))),
    acceptedSurfaceBytes,
    "候选角色负例结束后必须逐字节恢复私有 PRD / manifest / Hub / Meeting"
  );

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
