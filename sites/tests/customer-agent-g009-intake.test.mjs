import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { G009_DOMAINS, validateG009IntakeManifest } from "../../business-docs/08-工具/verify_customer_agent_g009_intake.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const verifier = path.join(repoRoot, "business-docs/08-工具/verify_customer_agent_g009_intake.mjs");
const evidenceId = "EVD-G0-09-AUTHORITY-SOURCES-20260814";
const valuedTokenFixture = `${["doc", "token"].join("_")}=secret-value`;

function readyManifest() {
  return {
    schemaVersion: 1,
    evidenceId,
    domains: G009_DOMAINS.map((domain, index) => ({
      domain,
      source_ref: `SRC-A1B2C3D4E5F60${String(index + 1).padStart(2, "0")}`,
      source_version_id: `srcv_a1b2c3d4e5f6010${index + 1}`,
      snapshot_evd: `EVD-G0-09-SNAPSHOT-${domain.toUpperCase()}-20260814`,
      acl_evd: `EVD-G0-09-ACL-${domain.toUpperCase()}-20260814`,
      total_rows: 10 + index,
      importable_rows: 9 + index,
      quarantined_rows: 1,
      quality_evd: `EVD-G0-09-QUALITY-${domain.toUpperCase()}-20260814`,
      final_approver_role: "ROLE-CONTENT-LEAD",
      overall_approval_evd: evidenceId,
      readiness: "READY",
    })),
  };
}

test("四域完整且使用同一整体证据时才返回 READY_FOR_G0_UPDATE", () => {
  const result = validateG009IntakeManifest(readyManifest());
  assert.equal(result.status, "READY_FOR_G0_UPDATE");
  assert.deepEqual(result.readyDomains, G009_DOMAINS);
  assert.ok(result.doesNotAuthorize.includes("Ddev"));
});

test("INCOMPLETE 可用于当前预填且明确列出缺项", () => {
  const manifest = readyManifest();
  manifest.evidenceId = "";
  manifest.domains.forEach((row) => { row.overall_approval_evd = ""; row.readiness = "INCOMPLETE"; });
  Object.assign(manifest.domains[0], {
    source_ref: "", source_version_id: "", snapshot_evd: "", acl_evd: "",
    total_rows: null, importable_rows: null, quarantined_rows: null, quality_evd: "",
  });
  const result = validateG009IntakeManifest(manifest);
  assert.equal(result.status, "INCOMPLETE");
  assert.deepEqual(result.readyDomains, []);
  assert.ok(result.missingByDomain.presale.includes("source_ref"));
});

test("缺域、重复域、整体证据错配和质量分母错误均 fail closed", () => {
  const missing = readyManifest();
  missing.domains.pop();
  assert.throws(() => validateG009IntakeManifest(missing), /恰好包含四域/);
  const duplicate = readyManifest();
  duplicate.domains[3].domain = "campaign";
  assert.throws(() => validateG009IntakeManifest(duplicate), /重复/);
  const mismatch = readyManifest();
  mismatch.domains[0].overall_approval_evd = "EVD-G0-09-AUTHORITY-SOURCES-20260815";
  assert.throws(() => validateG009IntakeManifest(mismatch), /整体证据一致/);
  const badCount = readyManifest();
  badCount.domains[0].importable_rows = 1;
  assert.throws(() => validateG009IntakeManifest(badCount), /质量分母不守恒/);
});

test("公开安全投影拒绝 URL、token、原始 SHA 和任意扩展字段", () => {
  for (const unsafe of ["https://example.invalid/source", valuedTokenFixture, "a".repeat(64)]) {
    const manifest = readyManifest();
    manifest.domains[0].snapshot_evd = unsafe;
    assert.throws(() => validateG009IntakeManifest(manifest), /公开安全投影禁止/);
  }
  const extra = readyManifest();
  extra.domains[0].document_title = "真实标题";
  assert.throws(() => validateG009IntakeManifest(extra), /未授权字段/);
});

test("负例 token 在运行时构造，仓库源码不保存发布阻断形状", async () => {
  const source = await readFile(fileURLToPath(import.meta.url), "utf8");

  assert.equal(valuedTokenFixture.split("=")[0], ["doc", "token"].join("_"));
  assert.equal(source.includes(valuedTokenFixture), false);
});

test("CLI 默认允许 INCOMPLETE，--require-ready 则以 exit 2 阻断", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "g009-intake-test-"));
  try {
    const manifest = readyManifest();
    manifest.evidenceId = "";
    manifest.domains.forEach((row) => { row.overall_approval_evd = ""; row.readiness = "INCOMPLETE"; });
    const file = path.join(root, "manifest.json");
    await writeFile(file, JSON.stringify(manifest), "utf8");
    const audit = spawnSync(process.execPath, [verifier, `--manifest=${file}`], { encoding: "utf8" });
    assert.equal(audit.status, 0, audit.stderr);
    assert.match(audit.stdout, /"status": "INCOMPLETE"/);
    const gate = spawnSync(process.execPath, [verifier, `--manifest=${file}`, "--require-ready"], { encoding: "utf8" });
    assert.equal(gate.status, 2, gate.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
