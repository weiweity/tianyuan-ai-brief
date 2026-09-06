import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
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
  assert.match(quality, /path: sites\/dist\/pages/);
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
