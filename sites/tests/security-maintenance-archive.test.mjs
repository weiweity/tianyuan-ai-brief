import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  ALLOWED_SECURITY_DIFFERENCES,
  BASE_ARCHIVE_ROOT,
  BASE_MANIFEST_PATH,
  SECURITY_ARCHIVE_ROOT,
  SECURITY_MANIFEST_PATH,
  assertBaseArchiveFrozen,
  compareSecuritySnapshot,
  verifySecurityMaintenanceArchive,
} from "../scripts/build-security-maintenance-archive.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fileSha(root, relative) {
  return sha256(await readFile(path.join(root, relative)));
}

test("旧归档与旧 manifest 保持冻结字节", async () => {
  const receipt = await assertBaseArchiveFrozen();
  assert.equal(
    receipt.manifestSha256,
    "2329fd56c22b746f4575096cc5efd30c967f72e3ed7eda0356bc26d9228d5879"
  );
  assert.equal(receipt.relativeFiles.length, 29);
  assert.equal(
    sha256(await readFile(BASE_MANIFEST_PATH)),
    "2329fd56c22b746f4575096cc5efd30c967f72e3ed7eda0356bc26d9228d5879"
  );
});

test("安全维护快照可由锁定依赖确定性重建", async () => {
  const result = await verifySecurityMaintenanceArchive();
  assert.equal(result.manifest.status, "archived-security-maintenance");
  assert.equal(result.manifest.maintenanceType, "security-only");
  assert.deepEqual(result.manifest.runtimeDependencies, {
    dompurify: "3.4.13",
    mermaid: "10.9.8",
  });
  assert.equal(result.receipt.relativeFiles.length, 30);
});

test("新旧快照只允许安全白名单差异，业务内容与素材逐字节相同", async () => {
  const comparison = await compareSecuritySnapshot();
  assert.deepEqual(comparison.differences, [...ALLOWED_SECURITY_DIFFERENCES].sort());

  const byteIdentical = [
    "css/app.css",
    "data/content.json",
    "data/content.schema.json",
    "js/app.js",
    "js/modules/content-loader.js",
    "js/modules/decision-model.js",
    "js/modules/meeting-state.js",
    "js/modules/mermaid-runtime.js",
    "js/modules/tab-history.js",
    "js/modules/tab-keyboard.js",
    "assets/apple-touch-icon.png",
    "assets/favicon-32.png",
    "assets/favicon-48.png",
    "assets/favicon.png",
    "assets/logo-mark.png",
    "assets/logo-wordmark.png",
    "assets/logo.png",
    "logo-ty.png",
    "vendor/dompurify-LICENSE.txt",
    "vendor/mermaid-LICENSE.txt",
  ];
  for (const relative of byteIdentical) {
    assert.equal(
      await fileSha(SECURITY_ARCHIVE_ROOT, relative),
      await fileSha(BASE_ARCHIVE_ROOT, relative),
      `${relative} 不得产生业务或素材漂移`
    );
  }

  await assert.rejects(
    stat(path.join(SECURITY_ARCHIVE_ROOT, "vendor/dompurify-3.4.12.es.mjs")),
    { code: "ENOENT" }
  );
  await assert.rejects(
    stat(path.join(SECURITY_ARCHIVE_ROOT, "vendor/mermaid-10.9.6.min.js")),
    { code: "ENOENT" }
  );
  await stat(path.join(SECURITY_ARCHIVE_ROOT, "vendor/dompurify-3.4.13.es.mjs"));
  await stat(path.join(SECURITY_ARCHIVE_ROOT, "vendor/mermaid-10.9.8.min.js"));

  const architecture = await readFile(path.join(SECURITY_ARCHIVE_ROOT, "ARCHITECTURE.md"), "utf8");
  assert.match(architecture, /Mermaid 固定为 10\.9\.8/);
  assert.match(architecture, /DOMPurify 固定为 3\.4\.13/);
  assert.doesNotMatch(architecture, /Mermaid 固定为 10\.9\.6|DOMPurify 固定为 3\.4\.12/);

  const manifest = JSON.parse(await readFile(SECURITY_MANIFEST_PATH, "utf8"));
  assert.equal(
    manifest.businessContentSha256,
    await fileSha(BASE_ARCHIVE_ROOT, "data/content.json")
  );
  assert.deepEqual(manifest.allowedDifferences, ALLOWED_SECURITY_DIFFERENCES);
});
