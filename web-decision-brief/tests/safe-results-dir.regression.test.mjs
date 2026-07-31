import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertStrictDescendant,
  createSafeResultsDir,
  validateResultToken,
} from "./support/safe-results-dir.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../..");

test("结果标识只接受短且无路径语义的 token", () => {
  for (const value of ["manual", "2", "2-final", "ci_123", "v1.2"]) {
    assert.equal(validateResultToken(value), value);
  }
  for (const value of ["", ".", "..", "../outside", "nested/path", "nested\\path", " spaced ", "x".repeat(65)]) {
    assert.throws(() => validateResultToken(value));
  }
});

test("自定义结果目录必须是固定根目录的严格子目录", () => {
  const root = path.join(tmpdir(), "customer-agent-safe-root");
  assert.equal(
    assertStrictDescendant(root, path.join(root, "run-1")),
    path.join(root, "run-1")
  );
  assert.throws(() => assertStrictDescendant(root, root));
  assert.throws(() => assertStrictDescendant(root, path.join(root, "..", "outside")));
  assert.throws(() => assertStrictDescendant(root, `${root}-sibling`));
});

test("默认运行创建唯一目录且不覆盖既有目录", async () => {
  const trustedRootPath = await mkdtemp(path.join(tmpdir(), "safe-results-trusted-"));
  const rootPath = path.join(trustedRootPath, "results");
  const first = await createSafeResultsDir({ trustedRootPath, rootPath, prefix: "round", label: "ci" });
  const second = await createSafeResultsDir({ trustedRootPath, rootPath, prefix: "round", label: "ci" });
  assert.notEqual(first, second);
  assertStrictDescendant(rootPath, first);
  assertStrictDescendant(rootPath, second);

  const requestedPath = path.join(rootPath, "manual-result");
  assert.equal(
    await createSafeResultsDir({
      trustedRootPath,
      rootPath,
      prefix: "round",
      label: "manual",
      requestedPath,
    }),
    requestedPath
  );
  await assert.rejects(
    createSafeResultsDir({
      trustedRootPath,
      rootPath,
      prefix: "round",
      label: "manual",
      requestedPath,
    }),
    { code: "EEXIST" }
  );
});

test("自定义目录遇到根内符号链接时拒绝且不在根外产生副作用", async () => {
  const trustedRootPath = await mkdtemp(path.join(tmpdir(), "safe-results-trusted-"));
  const rootPath = path.join(trustedRootPath, "results");
  await createSafeResultsDir({ trustedRootPath, rootPath, prefix: "round", label: "seed" });
  const outside = await mkdtemp(path.join(tmpdir(), "safe-results-outside-"));
  await symlink(outside, path.join(rootPath, "link"), "dir");
  await assert.rejects(
    createSafeResultsDir({
      trustedRootPath,
      rootPath,
      prefix: "round",
      label: "manual",
      requestedPath: path.join(rootPath, "link", "created", "result"),
    }),
    /符号链接/
  );
  await assert.rejects(stat(path.join(outside, "created")), { code: "ENOENT" });
});

test("结果根目录的中间分量是符号链接时拒绝且不在根外建目录", async () => {
  const trustedRootPath = await mkdtemp(path.join(tmpdir(), "safe-results-trusted-"));
  const outside = await mkdtemp(path.join(tmpdir(), "safe-results-outside-"));
  await symlink(outside, path.join(trustedRootPath, "output"), "dir");
  await assert.rejects(
    createSafeResultsDir({
      trustedRootPath,
      rootPath: path.join(trustedRootPath, "output", "customer-agent"),
      prefix: "round",
      label: "manual",
    }),
    /符号链接/
  );
  await assert.rejects(stat(path.join(outside, "customer-agent")), { code: "ENOENT" });
});

test("三套浏览器 QA 不得恢复递归结果目录清理", async () => {
  const files = [
    path.join(repoRoot, "business-docs/08-工具/test_customer_agent_prd.mjs"),
    path.join(repoRoot, "business-docs/08-工具/test_customer_agent_hub.mjs"),
    path.join(repoRoot, "web-decision-brief/tests/ui-audit.mjs"),
  ];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /\brm\s*\(/, file);
    assert.doesNotMatch(source, /\brecursive\s*:\s*true\s*,\s*force\s*:\s*true\b/, file);
  }
});
