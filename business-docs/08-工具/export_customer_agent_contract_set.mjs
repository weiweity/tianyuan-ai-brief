#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "../..");
const defaultOutputRoot = path.join(repositoryRoot, "output/customer-agent-contract-sets");

export const CONTRACT_SET_SCHEMA = "customer-agent-contract-set/v1";
export const CONTRACT_SET_TOOL_VERSION = "1.0.0";

export const CONTRACT_SOURCE_PATHS = Object.freeze({
  architecture: "business-docs/01-客服Agent项目/20-设计-进行中/37-架构SSOT-v1.md",
  apiSemantics: "business-docs/01-客服Agent项目/20-设计-进行中/39-API合同与发布状态机-v1.md",
  nfr: "business-docs/01-客服Agent项目/20-设计-进行中/41-NFR扩展并发与防改崩.md",
  implementation:
    "business-docs/01-客服Agent项目/20-设计-进行中/46-实现设计-开工包.md",
  openapi: "business-docs/01-客服Agent项目/20-设计-进行中/openapi.v1.yaml",
  database: "business-docs/01-客服Agent项目/20-设计-进行中/33-schema-v1-草案.sql",
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const REQUIRED_MANIFEST_KEYS = Object.freeze([
  "architecture_version",
  "contract_set_id",
  "database",
  "implementation_version",
  "openapi",
  "schema",
  "source_git_sha",
  "source_repository",
]);
const REQUIRED_CONTRACT_KEYS = Object.freeze([
  "bytes",
  "file",
  "sha256",
  "source_path",
  "version",
]);

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function utf8(buffer, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${label} 不是合法 UTF-8，拒绝生成合同集`);
  }
}

function runGit(repository, args, { allowFailure = false, encoding = "utf8" } = {}) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout;
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
    throw new Error(`git ${args[0]} 失败：${`${stdout ?? ""}${stderr ?? ""}`.trim()}`);
  }
  return result;
}

function gitText(repository, args) {
  return String(runGit(repository, args).stdout).trim();
}

function gitBlob(repository, sourceGitSha, sourcePath) {
  const blobOid = gitText(repository, ["rev-parse", "--verify", `${sourceGitSha}:${sourcePath}`]);
  const objectType = gitText(repository, ["cat-file", "-t", blobOid]);
  if (objectType !== "blob") {
    throw new Error(`来源对象不是普通 Git blob：${sourcePath}`);
  }
  return runGit(repository, ["cat-file", "blob", blobOid], { encoding: null }).stdout;
}

function normalizeExpectedHash(value, label, { required = true } = {}) {
  if (value == null || value === "") {
    if (!required) return null;
    throw new Error(`缺少 ${label}`);
  }
  const normalized = String(value).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${label} 必须是 64 位 SHA-256`);
  return normalized;
}

export function resolveExactSourceCommit(repository, sourceGitSha) {
  const normalized = String(sourceGitSha ?? "").toLowerCase();
  if (!GIT_SHA_PATTERN.test(normalized)) {
    throw new Error("--source-git-sha 必须是完整 40 位 commit SHA，禁止使用 HEAD、分支或短 SHA");
  }
  const resolved = gitText(repository, ["rev-parse", "--verify", `${normalized}^{commit}`]).toLowerCase();
  if (resolved !== normalized) throw new Error("来源 commit 解析结果与请求 SHA 不一致");
  return resolved;
}

function extractOpenapiVersion(source) {
  const infoBlock = source.match(/^info:\s*\r?\n(?:(?: {2,}[^\n]*)(?:\r?\n|$))+/m)?.[0] ?? "";
  const version = infoBlock.match(/^ {2}version:\s*["']?([0-9]+(?:\.[0-9]+)*)["']?\s*$/m)?.[1];
  if (!version) throw new Error("无法从 OpenAPI info.version 提取合同版本");
  return version;
}

function extractDatabaseVersion(source) {
  const version = source.match(/^--\s*(schema\.v[0-9]+(?:\.[0-9]+)*)\b/m)?.[1];
  if (!version) throw new Error("无法从 reference DDL 首部提取 schema 版本");
  return version;
}

function extractArchitectureVersion(source) {
  const version = source.match(/当前\s+v([0-9]+(?:\.[0-9]+)*)/)?.[1];
  if (!version) throw new Error("无法从 37 架构 SSOT 提取当前版本");
  return version;
}

function extractImplementationVersion(source) {
  const version = source.match(/>\s*\*\*日期：\*\*[^\n]*?·\s*v([0-9]+(?:\.[0-9]+)*)/)?.[1];
  if (!version) throw new Error("无法从 46 实现设计开工包提取当前版本");
  return version;
}

function assertLineCarriesHashes(line, label, databaseHash, openapiHash) {
  if (!line.includes(databaseHash) || !line.includes(openapiHash)) {
    throw new Error(`${label} 与机器文件双哈希不一致，拒绝生成合同集：${line.trim()}`);
  }
}

export function assertNormativeContractAlignment({
  architecture,
  apiSemantics,
  implementation,
  databaseHash,
  openapiHash,
}) {
  for (const [label, source, anchor] of [
    ["37 架构 SSOT 当前合同声明", architecture, "**DEC-042 内容资产治理：**"],
    ["39 API 合同当前声明", apiSemantics, "**DEC-042 边界 / ENG-T1 修正：**"],
  ]) {
    const lines = source.split(/\r?\n/).filter((line) => line.includes(anchor));
    if (lines.length === 0) throw new Error(`${label} 缺少现行锚点“${anchor}”`);
    for (const line of lines) {
      assertLineCarriesHashes(line, label, databaseHash, openapiHash);
    }
  }

  for (const anchor of ["机器合同已锁定为", "实际产物必须精确匹配"]) {
    const lines = implementation.split(/\r?\n/).filter((line) => line.includes(anchor));
    if (lines.length === 0) throw new Error(`46 实现设计缺少“${anchor}”锚点`);
    for (const line of lines) {
      assertLineCarriesHashes(line, `46 ${anchor}`, databaseHash, openapiHash);
    }
  }
}

export function buildContractSetId({ openapiVersion, databaseVersion, sourceGitSha }) {
  const databaseShort = databaseVersion.replace(/^schema\.v/, "");
  for (const [label, value] of [
    ["OpenAPI 版本", openapiVersion],
    ["数据库版本", databaseShort],
  ]) {
    if (!/^[0-9]+(?:\.[0-9]+)*$/.test(value)) throw new Error(`${label} 不能安全用于合同集 ID`);
  }
  if (!GIT_SHA_PATTERN.test(sourceGitSha)) throw new Error("合同集 ID 缺少完整来源 SHA");
  return `cs-ai-c11-openapi-${openapiVersion}-schema-${databaseShort}-${sourceGitSha.slice(0, 12)}`;
}

export function renderContractSetManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function loadContractSetFromCommit({
  repository = repositoryRoot,
  sourceGitSha,
  expectedOpenapiSha256,
  expectedDatabaseSha256,
}) {
  const exactSourceGitSha = resolveExactSourceCommit(repository, sourceGitSha);
  const buffers = Object.fromEntries(
    Object.entries(CONTRACT_SOURCE_PATHS).map(([key, sourcePath]) => [
      key,
      gitBlob(repository, exactSourceGitSha, sourcePath),
    ]),
  );
  const sources = Object.fromEntries(
    Object.entries(buffers).map(([key, value]) => [key, utf8(value, CONTRACT_SOURCE_PATHS[key])]),
  );
  const openapiHash = sha256(buffers.openapi);
  const databaseHash = sha256(buffers.database);
  const expectedOpenapi = normalizeExpectedHash(expectedOpenapiSha256, "OpenAPI 预期 SHA-256");
  const expectedDatabase = normalizeExpectedHash(expectedDatabaseSha256, "DDL 预期 SHA-256");
  if (openapiHash !== expectedOpenapi) {
    throw new Error(`OpenAPI blob 哈希不匹配：expected=${expectedOpenapi} actual=${openapiHash}`);
  }
  if (databaseHash !== expectedDatabase) {
    throw new Error(`DDL blob 哈希不匹配：expected=${expectedDatabase} actual=${databaseHash}`);
  }

  assertNormativeContractAlignment({
    architecture: sources.architecture,
    apiSemantics: sources.apiSemantics,
    implementation: sources.implementation,
    databaseHash,
    openapiHash,
  });

  const openapiVersion = extractOpenapiVersion(sources.openapi);
  const databaseVersion = extractDatabaseVersion(sources.database);
  const architectureVersion = extractArchitectureVersion(sources.architecture);
  const implementationVersion = extractImplementationVersion(sources.implementation);
  const contractSetId = buildContractSetId({
    openapiVersion,
    databaseVersion,
    sourceGitSha: exactSourceGitSha,
  });
  const databaseFile = `schema-v${databaseVersion.replace(/^schema\.v/, "")}.sql`;
  const manifest = {
    schema: CONTRACT_SET_SCHEMA,
    contract_set_id: contractSetId,
    source_repository: "ai-赋能立项",
    source_git_sha: exactSourceGitSha,
    architecture_version: architectureVersion,
    implementation_version: implementationVersion,
    openapi: {
      version: openapiVersion,
      source_path: CONTRACT_SOURCE_PATHS.openapi,
      file: "openapi.v1.yaml",
      sha256: openapiHash,
      bytes: buffers.openapi.byteLength,
    },
    database: {
      version: databaseVersion,
      source_path: CONTRACT_SOURCE_PATHS.database,
      file: databaseFile,
      sha256: databaseHash,
      bytes: buffers.database.byteLength,
    },
  };
  return {
    manifest,
    files: new Map([
      ["contract-set.json", Buffer.from(renderContractSetManifest(manifest), "utf8")],
      [manifest.openapi.file, buffers.openapi],
      [manifest.database.file, buffers.database],
    ]),
  };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

async function assertExistingPathChainHasNoSymlink(repository, candidate) {
  const relative = path.relative(repository, candidate);
  let current = repository;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw new Error(`输出路径禁止符号链接：${current}`);
      if (!metadata.isDirectory()) throw new Error(`输出路径分量不是目录：${current}`);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

export async function assertSafeContractSetOutputRoot(
  repository = repositoryRoot,
  outputRoot = defaultOutputRoot,
  { create = true } = {},
) {
  const absoluteRepository = path.resolve(repository);
  const absoluteOutput = path.resolve(outputRoot);
  if (!isWithin(absoluteRepository, absoluteOutput) || absoluteRepository === absoluteOutput) {
    throw new Error("合同集输出目录必须位于仓库内且不能等于仓库根");
  }
  await assertExistingPathChainHasNoSymlink(absoluteRepository, absoluteOutput);
  const relativeOutput = path.relative(absoluteRepository, absoluteOutput).split(path.sep).join("/");
  const ignored = runGit(
    absoluteRepository,
    ["check-ignore", "--no-index", "-q", "--", `${relativeOutput}/.ignore-probe`],
    { allowFailure: true },
  );
  if (ignored.status !== 0) throw new Error("合同集输出目录不再受 Git ignore 保护，拒绝写入");
  if (create) {
    await mkdir(absoluteOutput, { recursive: true, mode: 0o700 });
  } else {
    try {
      const metadata = await lstat(absoluteOutput);
      if (!metadata.isDirectory()) throw new Error("合同集输出路径不是目录");
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error("合同集输出目录不存在，拒绝验证");
      throw error;
    }
  }
  await assertExistingPathChainHasNoSymlink(absoluteRepository, absoluteOutput);
  const [canonicalRepository, canonicalOutput] = await Promise.all([
    realpath(absoluteRepository),
    realpath(absoluteOutput),
  ]);
  if (!isWithin(canonicalRepository, canonicalOutput) || canonicalRepository === canonicalOutput) {
    throw new Error("合同集输出真实路径越出仓库");
  }
  return canonicalOutput;
}

async function readRegularFileNoFollow(filePath, allowedParent) {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error("当前平台缺少 O_NOFOLLOW，拒绝读取合同集");
  }
  const before = await lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`合同集成员必须是普通文件且禁止符号链接：${filePath}`);
  }
  if ((before.mode & 0o222) !== 0) throw new Error(`合同集成员必须只读：${filePath}`);
  const canonicalParent = await realpath(path.dirname(filePath));
  if (canonicalParent !== allowedParent) throw new Error(`合同集成员父目录越界：${filePath}`);
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error(`合同集成员在读取期间被替换：${filePath}`);
    }
    return await handle.readFile();
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error(`合同集成员禁止符号链接：${filePath}`);
    throw error;
  } finally {
    await handle?.close();
  }
}

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.join("\n") !== expected.join("\n")) {
    throw new Error(`${label} 字段集合不封闭：${actual.join(", ")}`);
  }
}

function parseContractSetManifest(content) {
  let manifest;
  try {
    manifest = JSON.parse(content);
  } catch (error) {
    throw new Error(`contract-set.json 不是合法 JSON：${error.message}`);
  }
  assertExactKeys(manifest, REQUIRED_MANIFEST_KEYS, "contract-set.json");
  assertExactKeys(manifest.openapi, REQUIRED_CONTRACT_KEYS, "contract-set.json.openapi");
  assertExactKeys(manifest.database, REQUIRED_CONTRACT_KEYS, "contract-set.json.database");
  if (manifest.schema !== CONTRACT_SET_SCHEMA) throw new Error("contract-set schema 不受支持");
  if (!GIT_SHA_PATTERN.test(manifest.source_git_sha)) throw new Error("manifest source_git_sha 非法");
  for (const [label, contract] of [
    ["OpenAPI", manifest.openapi],
    ["DDL", manifest.database],
  ]) {
    normalizeExpectedHash(contract.sha256, `${label} manifest SHA-256`);
    if (path.basename(contract.file) !== contract.file) throw new Error(`${label} 文件名越界`);
    if (!Number.isSafeInteger(contract.bytes) || contract.bytes < 0) {
      throw new Error(`${label} bytes 非法`);
    }
  }
  const expectedId = buildContractSetId({
    openapiVersion: manifest.openapi.version,
    databaseVersion: manifest.database.version,
    sourceGitSha: manifest.source_git_sha,
  });
  if (manifest.contract_set_id !== expectedId) throw new Error("contract_set_id 与版本/来源 SHA 不一致");
  return manifest;
}

async function assertDirectoryMatchesFiles(directory, expectedFiles) {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`合同集目标必须是普通目录且禁止符号链接：${directory}`);
  }
  if ((metadata.mode & 0o222) !== 0) throw new Error(`合同集目标目录必须只读：${directory}`);
  const canonicalDirectory = await realpath(directory);
  const names = (await readdir(directory)).sort();
  const expectedNames = [...expectedFiles.keys()].sort();
  if (names.join("\n") !== expectedNames.join("\n")) {
    throw new Error(`既有合同集目录成员不一致，拒绝覆盖：${directory}`);
  }
  for (const [name, expected] of expectedFiles) {
    const actual = await readRegularFileNoFollow(path.join(directory, name), canonicalDirectory);
    if (!actual.equals(expected)) throw new Error(`既有合同集内容不一致，拒绝覆盖：${name}`);
  }
}

async function removeTemporaryDirectory(temporaryDirectory) {
  if (!temporaryDirectory) return;
  try {
    await chmod(temporaryDirectory, 0o700);
    for (const name of await readdir(temporaryDirectory)) {
      await chmod(path.join(temporaryDirectory, name), 0o600).catch(() => {});
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function writeImmutableContractSet({
  contractSet,
  repository = repositoryRoot,
  outputRoot = defaultOutputRoot,
}) {
  const canonicalOutput = await assertSafeContractSetOutputRoot(repository, outputRoot);
  const target = path.join(canonicalOutput, contractSet.manifest.contract_set_id);
  try {
    await assertDirectoryMatchesFiles(target, contractSet.files);
    return { status: "REUSED", target };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  let temporaryDirectory = await mkdtemp(path.join(canonicalOutput, ".contract-set-tmp-"));
  try {
    for (const [name, content] of contractSet.files) {
      const filePath = path.join(temporaryDirectory, name);
      const handle = await open(filePath, "wx", 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(filePath, 0o444);
    }
    await chmod(temporaryDirectory, 0o555);
    try {
      await rename(temporaryDirectory, target);
      temporaryDirectory = null;
      return { status: "CREATED", target };
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
      await assertDirectoryMatchesFiles(target, contractSet.files);
      return { status: "REUSED", target };
    }
  } finally {
    await removeTemporaryDirectory(temporaryDirectory);
  }
}

export async function verifyContractSetDirectory({
  contractSetDirectory,
  repository = repositoryRoot,
  expectedOpenapiSha256 = null,
  expectedDatabaseSha256 = null,
  againstSource = true,
}) {
  const directory = path.resolve(contractSetDirectory);
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("合同集路径必须是普通目录且禁止符号链接");
  }
  if ((metadata.mode & 0o222) !== 0) throw new Error("合同集目录必须只读");
  const canonicalDirectory = await realpath(directory);
  const manifestBuffer = await readRegularFileNoFollow(
    path.join(directory, "contract-set.json"),
    canonicalDirectory,
  );
  const manifest = parseContractSetManifest(utf8(manifestBuffer, "contract-set.json"));
  if (path.basename(directory) !== manifest.contract_set_id) {
    throw new Error("合同集目录名与 contract_set_id 不一致");
  }
  const expectedOpenapi = normalizeExpectedHash(expectedOpenapiSha256, "OpenAPI 预期 SHA-256", {
    required: false,
  });
  const expectedDatabase = normalizeExpectedHash(expectedDatabaseSha256, "DDL 预期 SHA-256", {
    required: false,
  });
  if (expectedOpenapi && manifest.openapi.sha256 !== expectedOpenapi) {
    throw new Error("manifest OpenAPI SHA-256 与调用方预期不一致");
  }
  if (expectedDatabase && manifest.database.sha256 !== expectedDatabase) {
    throw new Error("manifest DDL SHA-256 与调用方预期不一致");
  }

  const allowedNames = ["contract-set.json", manifest.openapi.file, manifest.database.file].sort();
  const actualNames = (await readdir(directory)).sort();
  if (actualNames.join("\n") !== allowedNames.join("\n")) {
    throw new Error("合同集目录包含缺失或未声明成员");
  }
  for (const [label, contract] of [
    ["OpenAPI", manifest.openapi],
    ["DDL", manifest.database],
  ]) {
    const content = await readRegularFileNoFollow(path.join(directory, contract.file), canonicalDirectory);
    if (content.byteLength !== contract.bytes) throw new Error(`${label} bytes 不匹配`);
    if (sha256(content) !== contract.sha256) throw new Error(`${label} SHA-256 不匹配`);
  }

  if (againstSource) {
    const expected = loadContractSetFromCommit({
      repository,
      sourceGitSha: manifest.source_git_sha,
      expectedOpenapiSha256: manifest.openapi.sha256,
      expectedDatabaseSha256: manifest.database.sha256,
    });
    await assertDirectoryMatchesFiles(directory, expected.files);
  }
  return manifest;
}

function parseArguments(argv) {
  const options = { mode: null };
  for (const argument of argv) {
    if (["--check", "--write"].includes(argument)) {
      if (options.mode) throw new Error("--check / --write / --verify 只能选择一个");
      options.mode = argument.slice(2);
    } else if (argument.startsWith("--verify=")) {
      if (options.mode) throw new Error("--check / --write / --verify 只能选择一个");
      options.mode = "verify";
      options.verifyPath = argument.slice("--verify=".length);
    } else if (argument.startsWith("--source-git-sha=")) {
      options.sourceGitSha = argument.slice("--source-git-sha=".length);
    } else if (argument.startsWith("--expect-openapi-sha256=")) {
      options.expectedOpenapiSha256 = argument.slice("--expect-openapi-sha256=".length);
    } else if (argument.startsWith("--expect-database-sha256=")) {
      options.expectedDatabaseSha256 = argument.slice("--expect-database-sha256=".length);
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  if (!options.mode) throw new Error("必须显式指定 --check、--write 或 --verify=<directory>");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === "verify") {
    const outputRoot = await assertSafeContractSetOutputRoot(repositoryRoot, defaultOutputRoot, {
      create: false,
    });
    const target = path.resolve(options.verifyPath);
    if (path.dirname(target) !== outputRoot) throw new Error("--verify 只能指向固定 ignored 输出根的一层子目录");
    const manifest = await verifyContractSetDirectory({
      contractSetDirectory: target,
      expectedOpenapiSha256: options.expectedOpenapiSha256,
      expectedDatabaseSha256: options.expectedDatabaseSha256,
    });
    console.log(
      JSON.stringify(
        {
          status: "VERIFIED",
          contract_set_id: manifest.contract_set_id,
          source_git_sha: manifest.source_git_sha,
          path: target,
          ddev_authorized: false,
          product_consumed: false,
        },
        null,
        2,
      ),
    );
    return;
  }

  const contractSet = loadContractSetFromCommit({
    sourceGitSha: options.sourceGitSha,
    expectedOpenapiSha256: options.expectedOpenapiSha256,
    expectedDatabaseSha256: options.expectedDatabaseSha256,
  });
  if (options.mode === "check") {
    console.log(renderContractSetManifest(contractSet.manifest));
    return;
  }
  const written = await writeImmutableContractSet({ contractSet });
  const verified = await verifyContractSetDirectory({
    contractSetDirectory: written.target,
    expectedOpenapiSha256: options.expectedOpenapiSha256,
    expectedDatabaseSha256: options.expectedDatabaseSha256,
  });
  console.log(
    JSON.stringify(
      {
        status: written.status,
        contract_set_id: verified.contract_set_id,
        source_git_sha: verified.source_git_sha,
        path: written.target,
        ddev_authorized: false,
        product_consumed: false,
      },
      null,
      2,
    ),
  );
}

if (path.resolve(process.argv[1] ?? "") === scriptPath) {
  main().catch((error) => {
    console.error(`CONTRACT_SET_ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
