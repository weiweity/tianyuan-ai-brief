import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONTRACT_SET_SCHEMA,
  CONTRACT_SOURCE_PATHS,
  assertSafeContractSetOutputRoot,
  loadContractSetFromCommit,
  verifyContractSetDirectory,
  writeImmutableContractSet,
} from "../../business-docs/08-工具/export_customer_agent_contract_set.mjs";

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function fixtureGit(repositoryRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `fixture git ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`,
  );
  return result.stdout.trim();
}

async function makeWritable(candidate) {
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    await chmod(candidate, 0o700).catch(() => {});
    for (const name of await readdir(candidate)) {
      await makeWritable(path.join(candidate, name));
    }
  } else {
    await chmod(candidate, 0o600).catch(() => {});
  }
}

async function writeSourceFile(repositoryRoot, sourcePath, content) {
  const target = path.join(repositoryRoot, sourcePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function createFixture({
  staleAuthorityHashes = false,
  staleImplementationHashes = false,
} = {}) {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "customer-agent-contract-set-"));
  fixtureGit(repositoryRoot, ["init", "-b", "contract-set-fixture"]);
  fixtureGit(repositoryRoot, ["config", "user.name", "Codex Fixture"]);
  fixtureGit(repositoryRoot, ["config", "user.email", "fixture@example.invalid"]);
  fixtureGit(repositoryRoot, ["config", "commit.gpgsign", "false"]);

  const openapi = [
    "openapi: 3.1.1",
    "info:",
    "  title: Fixture API",
    "  version: 1.11.0",
    "paths: {}",
    "",
  ].join("\n");
  const database = [
    "-- schema.v1.12 — fixture PostgreSQL reference DDL",
    "BEGIN;",
    "COMMIT;",
    "",
  ].join("\n");
  const openapiHash = digest(openapi);
  const databaseHash = digest(database);
  const authorityOpenapiHash = staleAuthorityHashes ? "c".repeat(64) : openapiHash;
  const authorityDatabaseHash = staleAuthorityHashes ? "d".repeat(64) : databaseHash;
  const lockedOpenapiHash = staleImplementationHashes ? "a".repeat(64) : openapiHash;
  const lockedDatabaseHash = staleImplementationHashes ? "b".repeat(64) : databaseHash;
  const architecture = [
    "# 37 · Fixture 架构 SSOT v1",
    "",
    "> **状态：** 静态设计（当前 v1.16）",
    `> **DEC-042 内容资产治理：** 当前合同锁定 DDL ${authorityDatabaseHash} 与 OpenAPI ${authorityOpenapiHash}。`,
    ...(staleAuthorityHashes
      ? [`> 历史核对（非现行）：实际文件曾记录 DDL ${databaseHash} 与 OpenAPI ${openapiHash}。`]
      : []),
    "",
  ].join("\n");
  const apiSemantics = [
    "# 39 · Fixture API 合同",
    "",
    `> **DEC-042 边界 / ENG-T1 修正：** 当前合同锁定 DDL ${authorityDatabaseHash} 与 OpenAPI ${authorityOpenapiHash}。`,
    ...(staleAuthorityHashes
      ? [`> 历史核对（非现行）：实际文件曾记录 DDL ${databaseHash} 与 OpenAPI ${openapiHash}。`]
      : []),
    "",
  ].join("\n");
  const implementation = [
    "# 46 · Fixture 实现设计开工包",
    "",
    "> **日期：** 2026-08-21 · v1.21（fixture）",
    `7. 机器合同已锁定为 schema.v1.12（SHA-256 ${lockedDatabaseHash}）与 OpenAPI 1.11.0（SHA-256 ${lockedOpenapiHash}）。`,
    `**运行状态：** 机器合同已锁定为 schema.v1.12（SHA-256 ${lockedDatabaseHash}）与 OpenAPI 1.11.0（SHA-256 ${lockedOpenapiHash}）。`,
    `5. 实际产物必须精确匹配 schema SHA ${lockedDatabaseHash} 与 OpenAPI SHA ${lockedOpenapiHash}。`,
    "",
  ].join("\n");

  await writeFile(path.join(repositoryRoot, ".gitignore"), "/output/\n", "utf8");
  await writeSourceFile(repositoryRoot, CONTRACT_SOURCE_PATHS.openapi, openapi);
  await writeSourceFile(repositoryRoot, CONTRACT_SOURCE_PATHS.database, database);
  await writeSourceFile(repositoryRoot, CONTRACT_SOURCE_PATHS.architecture, architecture);
  await writeSourceFile(repositoryRoot, CONTRACT_SOURCE_PATHS.apiSemantics, apiSemantics);
  await writeSourceFile(repositoryRoot, CONTRACT_SOURCE_PATHS.nfr, "# 41 · Fixture NFR\n");
  await writeSourceFile(repositoryRoot, CONTRACT_SOURCE_PATHS.implementation, implementation);
  fixtureGit(repositoryRoot, [
    "add",
    "--",
    ".gitignore",
    ...Object.values(CONTRACT_SOURCE_PATHS),
  ]);
  fixtureGit(repositoryRoot, ["commit", "-m", "fixture contract baseline"]);
  return {
    repositoryRoot,
    sourceGitSha: fixtureGit(repositoryRoot, ["rev-parse", "HEAD"]),
    outputRoot: path.join(repositoryRoot, "output/customer-agent-contract-sets"),
    openapi,
    database,
    openapiHash,
    databaseHash,
  };
}

async function withFixture(options, callback) {
  const fixture = await createFixture(options);
  try {
    return await callback(fixture);
  } finally {
    await makeWritable(fixture.repositoryRoot);
    await rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
}

test("合同集只读取完整来源 commit，忽略脏工作树并生成确定性清单", async () => {
  await withFixture({}, async (fixture) => {
    await writeSourceFile(
      fixture.repositoryRoot,
      CONTRACT_SOURCE_PATHS.openapi,
      fixture.openapi.replace("1.11.0", "9.9.9"),
    );
    await writeSourceFile(
      fixture.repositoryRoot,
      CONTRACT_SOURCE_PATHS.database,
      fixture.database.replace("COMMIT;", "ROLLBACK;"),
    );
    const contractSet = loadContractSetFromCommit({
      repository: fixture.repositoryRoot,
      sourceGitSha: fixture.sourceGitSha,
      expectedOpenapiSha256: fixture.openapiHash,
      expectedDatabaseSha256: fixture.databaseHash,
    });
    assert.equal(contractSet.manifest.schema, CONTRACT_SET_SCHEMA);
    assert.equal(contractSet.manifest.source_git_sha, fixture.sourceGitSha);
    assert.equal(contractSet.manifest.architecture_version, "1.16");
    assert.equal(contractSet.manifest.implementation_version, "1.21");
    assert.equal(contractSet.manifest.openapi.version, "1.11.0");
    assert.equal(contractSet.manifest.database.version, "schema.v1.12");
    assert.equal(
      contractSet.manifest.contract_set_id,
      `cs-ai-c11-openapi-1.11.0-schema-1.12-${fixture.sourceGitSha.slice(0, 12)}`,
    );
    assert.equal(contractSet.files.get("openapi.v1.yaml").toString("utf8"), fixture.openapi);
    assert.equal(contractSet.files.get("schema-v1.12.sql").toString("utf8"), fixture.database);
  });
});

test("合同集写入只增不改，复跑复用且篡改后 fail-closed", async () => {
  await withFixture({}, async (fixture) => {
    const contractSet = loadContractSetFromCommit({
      repository: fixture.repositoryRoot,
      sourceGitSha: fixture.sourceGitSha,
      expectedOpenapiSha256: fixture.openapiHash,
      expectedDatabaseSha256: fixture.databaseHash,
    });
    const created = await writeImmutableContractSet({
      contractSet,
      repository: fixture.repositoryRoot,
      outputRoot: fixture.outputRoot,
    });
    assert.equal(created.status, "CREATED");
    const manifest = await verifyContractSetDirectory({
      contractSetDirectory: created.target,
      repository: fixture.repositoryRoot,
      expectedOpenapiSha256: fixture.openapiHash,
      expectedDatabaseSha256: fixture.databaseHash,
    });
    assert.equal(manifest.contract_set_id, contractSet.manifest.contract_set_id);
    assert.equal((await stat(created.target)).mode & 0o777, 0o555);
    assert.equal((await stat(path.join(created.target, "contract-set.json"))).mode & 0o777, 0o444);

    const reused = await writeImmutableContractSet({
      contractSet,
      repository: fixture.repositoryRoot,
      outputRoot: fixture.outputRoot,
    });
    assert.equal(reused.status, "REUSED");

    const openapiPath = path.join(created.target, manifest.openapi.file);
    await chmod(created.target, 0o755);
    await chmod(openapiPath, 0o644);
    await writeFile(openapiPath, "tampered\n", "utf8");
    await chmod(openapiPath, 0o444);
    await chmod(created.target, 0o555);
    await assert.rejects(
      verifyContractSetDirectory({
        contractSetDirectory: created.target,
        repository: fixture.repositoryRoot,
        againstSource: false,
      }),
      /bytes 不匹配|SHA-256 不匹配/,
    );
    await assert.rejects(
      writeImmutableContractSet({
        contractSet,
        repository: fixture.repositoryRoot,
        outputRoot: fixture.outputRoot,
      }),
      /内容不一致，拒绝覆盖/,
    );
  });
});

test("来源 SHA、显式预期哈希与规范锚点任一不一致都拒绝出包", async () => {
  await withFixture({}, async (fixture) => {
    assert.throws(
      () =>
        loadContractSetFromCommit({
          repository: fixture.repositoryRoot,
          sourceGitSha: fixture.sourceGitSha.slice(0, 12),
          expectedOpenapiSha256: fixture.openapiHash,
          expectedDatabaseSha256: fixture.databaseHash,
        }),
      /完整 40 位 commit SHA/,
    );
    assert.throws(
      () =>
        loadContractSetFromCommit({
          repository: fixture.repositoryRoot,
          sourceGitSha: fixture.sourceGitSha,
          expectedOpenapiSha256: "f".repeat(64),
          expectedDatabaseSha256: fixture.databaseHash,
        }),
      /OpenAPI blob 哈希不匹配/,
    );
  });
  await withFixture({ staleImplementationHashes: true }, async (fixture) => {
    assert.throws(
      () =>
        loadContractSetFromCommit({
          repository: fixture.repositoryRoot,
          sourceGitSha: fixture.sourceGitSha,
          expectedOpenapiSha256: fixture.openapiHash,
          expectedDatabaseSha256: fixture.databaseHash,
        }),
      /46 机器合同已锁定为 与机器文件双哈希不一致/,
    );
  });
  await withFixture({ staleAuthorityHashes: true }, async (fixture) => {
    assert.throws(
      () =>
        loadContractSetFromCommit({
          repository: fixture.repositoryRoot,
          sourceGitSha: fixture.sourceGitSha,
          expectedOpenapiSha256: fixture.openapiHash,
          expectedDatabaseSha256: fixture.databaseHash,
        }),
      /37 架构 SSOT 当前合同声明 与机器文件双哈希不一致/,
    );
  });
});

test("只读验证不会创建缺失的输出根", async () => {
  await withFixture({}, async (fixture) => {
    await assert.rejects(
      assertSafeContractSetOutputRoot(fixture.repositoryRoot, fixture.outputRoot, { create: false }),
      /输出目录不存在，拒绝验证/,
    );
    await assert.rejects(lstat(fixture.outputRoot), (error) => error?.code === "ENOENT");
  });
});

test("ignored 输出路径若被符号链接替换则拒绝写入", async () => {
  await withFixture({}, async (fixture) => {
    const outside = await mkdtemp(path.join(tmpdir(), "customer-agent-contract-outside-"));
    try {
      await symlink(outside, path.join(fixture.repositoryRoot, "output"), "dir");
      const contractSet = loadContractSetFromCommit({
        repository: fixture.repositoryRoot,
        sourceGitSha: fixture.sourceGitSha,
        expectedOpenapiSha256: fixture.openapiHash,
        expectedDatabaseSha256: fixture.databaseHash,
      });
      await assert.rejects(
        writeImmutableContractSet({
          contractSet,
          repository: fixture.repositoryRoot,
          outputRoot: fixture.outputRoot,
        }),
        /输出路径禁止符号链接/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("manifest 字段封闭且目录不接受未声明文件", async () => {
  await withFixture({}, async (fixture) => {
    const contractSet = loadContractSetFromCommit({
      repository: fixture.repositoryRoot,
      sourceGitSha: fixture.sourceGitSha,
      expectedOpenapiSha256: fixture.openapiHash,
      expectedDatabaseSha256: fixture.databaseHash,
    });
    const created = await writeImmutableContractSet({
      contractSet,
      repository: fixture.repositoryRoot,
      outputRoot: fixture.outputRoot,
    });
    await chmod(created.target, 0o755);
    const extraPath = path.join(created.target, "extra.txt");
    await writeFile(extraPath, "unexpected\n", "utf8");
    await chmod(extraPath, 0o444);
    await chmod(created.target, 0o555);
    await assert.rejects(
      verifyContractSetDirectory({
        contractSetDirectory: created.target,
        repository: fixture.repositoryRoot,
        againstSource: false,
      }),
      /未声明成员/,
    );

    await chmod(created.target, 0o755);
    await rm(extraPath);
    const manifestPath = path.join(created.target, "contract-set.json");
    await chmod(manifestPath, 0o644);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.unexpected = true;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await chmod(manifestPath, 0o444);
    await chmod(created.target, 0o555);
    await assert.rejects(
      verifyContractSetDirectory({
        contractSetDirectory: created.target,
        repository: fixture.repositoryRoot,
        againstSource: false,
      }),
      /字段集合不封闭/,
    );
  });
});
