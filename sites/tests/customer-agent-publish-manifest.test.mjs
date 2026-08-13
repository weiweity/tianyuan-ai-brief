import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertSafePath,
  buildCandidateRecord,
  candidateFiles,
  candidateReadme,
  compareUtf8Paths,
  parseNameStatus,
  parseStageManifest,
  parseWorkspaceInventory,
  readCandidateFile,
  renderManifest,
  validateAtomicRelationships,
  verifyStagedCandidate,
} from "../../business-docs/08-工具/prepare_customer_agent_publish_manifest.mjs";

function fixtureGit(repositoryRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `fixture git ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`,
  );
  return result.stdout.trim();
}

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function headBlob(repositoryRoot, filePath) {
  return fixtureGit(repositoryRoot, ["rev-parse", `HEAD:${filePath}`]);
}

const emptyLocalExclusions = [
  "legacy-rescore-evidence",
  "legacy-brand-and-font-assets",
  "local-private-workspace",
  "unapproved-root-pdf",
].map((name) => ({
  class: name,
  presentCount: 0,
  disposition: "EXCLUDED_LOCAL_NO_READ",
}));

async function createStagedFixture() {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "customer-agent-staged-gate-"));
  fixtureGit(repositoryRoot, ["init", "-b", "verify-staged-fixture"]);
  fixtureGit(repositoryRoot, ["config", "user.name", "Codex Fixture"]);
  fixtureGit(repositoryRoot, ["config", "user.email", "fixture@example.invalid"]);
  fixtureGit(repositoryRoot, ["config", "commit.gpgsign", "false"]);
  fixtureGit(repositoryRoot, ["config", "core.fileMode", "true"]);
  const remote = "https://example.invalid/customer-agent.git";
  fixtureGit(repositoryRoot, ["remote", "add", "origin", remote]);

  await writeFile(path.join(repositoryRoot, ".gitignore"), "output/\n", "utf8");
  await writeFile(path.join(repositoryRoot, "tracked.txt"), "before\n", "utf8");
  await writeFile(path.join(repositoryRoot, "deleted.txt"), "delete me\n", "utf8");
  fixtureGit(repositoryRoot, ["add", "--", ".gitignore", "tracked.txt", "deleted.txt"]);
  fixtureGit(repositoryRoot, ["commit", "-m", "fixture baseline"]);

  const trackedContent = "after\n";
  const addedContent = "new file\n";
  await writeFile(path.join(repositoryRoot, "tracked.txt"), trackedContent, "utf8");
  await writeFile(path.join(repositoryRoot, "added.txt"), addedContent, "utf8");
  await rm(path.join(repositoryRoot, "deleted.txt"));

  const entries = [
    {
      status: "A",
      path: "added.txt",
      sha256: digest(addedContent),
      oldMode: "-",
      newMode: "100644",
      baseBlob: "-",
      bytes: Buffer.byteLength(addedContent),
      group: "fixture",
      hashMode: "raw-bytes",
    },
    {
      status: "D",
      path: "deleted.txt",
      sha256: "-",
      oldMode: "100644",
      newMode: "-",
      baseBlob: headBlob(repositoryRoot, "deleted.txt"),
      bytes: 0,
      group: "fixture",
    },
    {
      status: "M",
      path: "tracked.txt",
      sha256: digest(trackedContent),
      oldMode: "100644",
      newMode: "100644",
      baseBlob: headBlob(repositoryRoot, "tracked.txt"),
      bytes: Buffer.byteLength(trackedContent),
      group: "fixture",
      hashMode: "raw-bytes",
    },
  ];
  const checks = [{ label: "fixture-project-checks", status: "PASS" }];
  const candidate = buildCandidateRecord({
    baseHead: fixtureGit(repositoryRoot, ["rev-parse", "HEAD"]),
    branch: "verify-staged-fixture",
    origin: new URL(remote).toString(),
    entries,
    localExclusions: emptyLocalExclusions,
    checks,
  });
  const candidateOutputRoot = path.join(repositoryRoot, "output/customer-agent-publish-gate");
  const candidateDirectory = path.join(
    candidateOutputRoot,
    `candidate-${candidate.candidateBundleSha256.slice(0, 16)}`,
  );
  await mkdir(candidateDirectory, { recursive: true });
  await Promise.all(
    [...candidateFiles(candidate)].map(([name, content]) =>
      writeFile(path.join(candidateDirectory, name), content, "utf8"),
    ),
  );
  fixtureGit(repositoryRoot, ["add", "-A", "--", "tracked.txt", "added.txt", "deleted.txt"]);
  return { repositoryRoot, candidateOutputRoot, candidate, checks };
}

async function withStagedFixture(callback) {
  const fixture = await createStagedFixture();
  try {
    return await callback(fixture);
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
}

test("发布清单按 UTF-8 路径字节序确定性输出 M/A/D 与哈希", () => {
  const entries = [
    { status: "A", path: "中.md", sha256: "b".repeat(64) },
    { status: "D", path: "a.md", sha256: "-" },
    { status: "M", path: "z.md", sha256: "a".repeat(64) },
  ];
  const expected = entries.slice().sort(compareUtf8Paths);
  const manifest = renderManifest(entries);
  assert.deepEqual(
    manifest.trimEnd().split("\n").map((line) => line.split("\t")[1]),
    expected.map((entry) => entry.path),
  );
  assert.match(manifest, /^D\ta\.md\t-$/m);
  assert.match(manifest, new RegExp(`^M\\tz\\.md\\t${"a".repeat(64)}$`, "m"));
});

test("name-status NUL 解析拒绝类型变化等未受控状态", () => {
  assert.deepEqual(parseNameStatus(Buffer.from("M\0a.md\0D\0旧.md\0")), [
    { status: "M", path: "a.md" },
    { status: "D", path: "旧.md" },
  ]);
  assert.throws(() => parseNameStatus(Buffer.from("T\0a.md\0")), /不支持的未暂存 Git 状态/);
  assert.throws(() => parseNameStatus(Buffer.from("M\0a.md\0D\0")), /结构异常/);
});

test("历史迁移必须删除旧路径并新增归档路径，禁止单边交付", () => {
  const before = "business-docs/01-客服Agent项目/10-客服Agent启动会逐字稿.md";
  const after = "business-docs/01-客服Agent项目/99-历史/2026-08-04_客服Agent启动会逐字稿.md";
  assert.doesNotThrow(() =>
    validateAtomicRelationships([
      { status: "D", path: before },
      { status: "A", path: after },
    ]),
  );
  assert.throws(
    () => validateAtomicRelationships([{ status: "D", path: before }]),
    /历史迁移原子集合不完整/,
  );
});

test("00–06 真源变化必须携带 07/08 三个生成视图", () => {
  for (const sourcePath of [
    "business-docs/01-客服Agent项目/00-项目章程.md",
    "business-docs/01-客服Agent项目/20-设计-进行中/37-架构SSOT-v1.md",
    "business-docs/01-客服Agent项目/20-设计-进行中/46-实现设计-开工包.md",
  ]) {
    const source = { status: "M", path: sourcePath };
    assert.throws(() => validateAtomicRelationships([source]), /07\/08 生成视图原子集合不完整/);
    assert.doesNotThrow(() =>
      validateAtomicRelationships([
        source,
        { status: "M", path: "business-docs/01-客服Agent项目/07-客服Agent立项PRD.html" },
        { status: "M", path: "business-docs/01-客服Agent项目/07-客服Agent立项PRD.sources.json" },
        { status: "M", path: "business-docs/01-客服Agent项目/08-客服Agent立项执行中心.html" },
      ]),
    );
  }
});

test("候选路径拒绝私密目录、生成缓存、根 PDF、旧品牌资产与密钥文件", () => {
  for (const filePath of [
    "local-private/customer.md",
    "output/customer-agent/result.json",
    "sites/dist/pages/index.html",
    "未核准材料.pdf",
    "business-docs/01-客服Agent项目/20-设计-进行中/assets/font.woff2",
    "secrets/id_ed25519",
    ".env.production",
  ]) {
    assert.throws(() => assertSafePath(filePath), /候选|PDF|assets|密钥|环境/);
  }
  assert.doesNotThrow(() => assertSafePath("business-docs/01-客服Agent项目/README.md"));
});

test("stage manifest 只接受排序、唯一且与状态匹配的原始字节哈希", () => {
  const digest = "a".repeat(64);
  assert.deepEqual(parseStageManifest(`D\ta.md\t-\nA\t中.md\t${digest}\n`), [
    { status: "D", path: "a.md", sha256: "-" },
    { status: "A", path: "中.md", sha256: digest },
  ]);
  assert.throws(
    () => parseStageManifest(`A\t中.md\t${digest}\nD\ta.md\t-\n`),
    /UTF-8 路径字节序排序/,
  );
  assert.throws(
    () => parseStageManifest(`A\ta.md\t${digest}\nM\ta.md\t${digest}\n`),
    /路径重复/,
  );
  assert.throws(() => parseStageManifest("D\ta.md\tdeadbeef\n"), /哈希非法/);
});

test("PlantUML 必须携带同名 SVG 与架构 HTML，不能用同编号异名文件替代", () => {
  const root = "business-docs/01-客服Agent项目/20-设计-进行中";
  assert.throws(
    () =>
      validateAtomicRelationships([
        { status: "M", path: `${root}/diagrams/02-运行容器与端口.puml` },
        { status: "M", path: `${root}/diagrams/svg/02-另一个图.svg` },
        { status: "M", path: `${root}/架构图-PlantUML浏览器.html` },
      ]),
    /02-运行容器与端口.*原子集合不完整/,
  );
  assert.doesNotThrow(() =>
    validateAtomicRelationships([
      { status: "M", path: `${root}/diagrams/02-运行容器与端口.puml` },
      { status: "M", path: `${root}/diagrams/svg/02-运行容器与端口.svg` },
      { status: "M", path: `${root}/架构图-PlantUML浏览器.html` },
    ]),
  );
});

test("候选 README 展示全部审批分组、真实 stage manifest 与 index 复核命令", () => {
  const bundle = "b".repeat(64);
  const candidate = {
    baseHead: "a".repeat(40),
    branch: "codex/example",
    origin: "https://example.invalid/repo.git",
    workspaceInventorySha256: "c".repeat(64),
    stageManifestSha256: "d".repeat(64),
    candidateBundleSha256: bundle,
    counts: {
      total: 3,
      byStatus: { M: 1, A: 1, D: 1 },
      byReviewGroup: { "shared-repository": 1, "customer-agent": 2 },
    },
  };
  const readme = candidateReadme(candidate);
  assert.match(readme, /按 `stage-manifest\.tsv` 精确暂存/);
  assert.match(readme, new RegExp(`--verify-staged=${bundle}`));
  assert.match(readme, /STAGED_MATCH.*不自动获得 commit\/push 授权/);
  assert.match(readme, /`customer-agent`：2 个路径/);
  assert.match(readme, /`shared-repository`：1 个路径/);
  assert.match(readme, /禁止对同一 bundle 做局部批准/);
  assert.doesNotMatch(readme, /按 `manifest\.tsv` 精确暂存/);

  const approvals = JSON.parse(candidateFiles(candidate).get("approvals.template.json"));
  assert.equal(approvals.approvalScope, "ALL_REVIEW_GROUPS_IN_BUNDLE");
  assert.deepEqual(approvals.reviewGroups, {
    "customer-agent": 2,
    "shared-repository": 1,
  });
  assert.match(approvals.rule, /批准覆盖 reviewGroups 列出的全部分组/);
});

test("workspace inventory 是 file mode 与 Git 基线的受控真源", () => {
  const digest = "a".repeat(64);
  const baseBlob = "b".repeat(40);
  const inventory = [
    `INCLUDE\tM\ta.md\t${digest}\t100644\t100644\t${baseBlob}\t12\tshared-repository`,
    `INCLUDE\tA\t中.md\t${digest}\t-\t100644\t-\t8\tcustomer-agent`,
    "",
  ].join("\n");
  assert.deepEqual(parseWorkspaceInventory(inventory), [
    {
      disposition: "INCLUDE",
      status: "M",
      path: "a.md",
      sha256: digest,
      oldMode: "100644",
      newMode: "100644",
      baseBlob,
      bytes: 12,
      group: "shared-repository",
    },
    {
      disposition: "INCLUDE",
      status: "A",
      path: "中.md",
      sha256: digest,
      oldMode: "-",
      newMode: "100644",
      baseBlob: "-",
      bytes: 8,
      group: "customer-agent",
    },
  ]);
  assert.throws(
    () => parseWorkspaceInventory(inventory.replace("100644\t100644", "100644\t100755")),
    /mode\/blob 形状非法/,
  );
  assert.throws(
    () => parseWorkspaceInventory(inventory.replace("INCLUDE\tA", "EXCLUDE\tA")),
    /disposition 非法/,
  );
});

test("候选单文件读取拒绝符号链接且不跟随到目录外", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "customer-agent-publish-candidate-"));
  try {
    await writeFile(path.join(directory, "plain.txt"), "safe\n", "utf8");
    assert.equal(await readCandidateFile(directory, "plain.txt"), "safe\n");
    await symlink(path.join(directory, "plain.txt"), path.join(directory, "linked.txt"));
    await assert.rejects(() => readCandidateFile(directory, "linked.txt"), /符号链接/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verify-staged 在真实临时 Git index 中接受精确候选并拒绝 blob、mode、额外路径篡改", async (t) => {
  await t.test("精确暂存通过且项目检查只执行一次", async () => {
    await withStagedFixture(async ({ repositoryRoot, candidateOutputRoot, candidate, checks }) => {
      let checkRuns = 0;
      const verified = await verifyStagedCandidate(candidate.candidateBundleSha256, {
        repositoryRoot,
        candidateOutputRoot,
        runChecks: () => {
          checkRuns += 1;
          return checks;
        },
      });
      assert.equal(checkRuns, 1);
      assert.equal(verified.entries.length, 3);
    });
  });

  await t.test("staged blob 内容漂移被拒绝", async () => {
    await withStagedFixture(async ({ repositoryRoot, candidateOutputRoot, candidate, checks }) => {
      await writeFile(path.join(repositoryRoot, "tracked.txt"), "tampered after approval\n", "utf8");
      fixtureGit(repositoryRoot, ["add", "--", "tracked.txt"]);
      await assert.rejects(
        () =>
          verifyStagedCandidate(candidate.candidateBundleSha256, {
            repositoryRoot,
            candidateOutputRoot,
            runChecks: () => checks,
          }),
        /staged index blob SHA 与 stage manifest 不一致/,
      );
    });
  });

  await t.test("staged executable mode 漂移被拒绝", async () => {
    await withStagedFixture(async ({ repositoryRoot, candidateOutputRoot, candidate, checks }) => {
      await chmod(path.join(repositoryRoot, "added.txt"), 0o755);
      fixtureGit(repositoryRoot, ["add", "--", "added.txt"]);
      await assert.rejects(
        () =>
          verifyStagedCandidate(candidate.candidateBundleSha256, {
            repositoryRoot,
            candidateOutputRoot,
            runChecks: () => checks,
          }),
        /staged file mode 漂移/,
      );
    });
  });

  await t.test("额外 staged 路径被拒绝", async () => {
    await withStagedFixture(async ({ repositoryRoot, candidateOutputRoot, candidate, checks }) => {
      await writeFile(path.join(repositoryRoot, "extra.txt"), "not approved\n", "utf8");
      fixtureGit(repositoryRoot, ["add", "--", "extra.txt"]);
      await assert.rejects(
        () =>
          verifyStagedCandidate(candidate.candidateBundleSha256, {
            repositoryRoot,
            candidateOutputRoot,
            runChecks: () => checks,
          }),
        /staged 路径\/状态与 stage manifest 不一致/,
      );
    });
  });
});
