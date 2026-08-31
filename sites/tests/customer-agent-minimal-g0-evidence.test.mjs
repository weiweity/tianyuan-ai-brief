import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reviewRoot = path.join(repoRoot, "business-docs/01-客服Agent项目/90-评审");
const snapshotPath = path.join(reviewRoot, "2026-08-30_G0-09单工作簿脱敏快照.json");

test("DEC-058 单人开发前证据保持四域完整且不携带原始内容", async () => {
  const [snapshotText, decision, businessBaseline, workbookClosure, aclBaseline] = await Promise.all([
    readFile(snapshotPath, "utf8"),
    readFile(path.join(reviewRoot, "2026-08-30_单人开发开工门最小化决定.md"), "utf8"),
    readFile(path.join(reviewRoot, "2026-08-30_Menokin单人开发基线包.md"), "utf8"),
    readFile(path.join(reviewRoot, "2026-08-30_G0-09单工作簿收口包.md"), "utf8"),
    readFile(path.join(reviewRoot, "2026-08-30_G0-09单人Owner权限基线.md"), "utf8"),
  ]);
  const snapshot = JSON.parse(snapshotText);

  assert.equal(snapshot.schema_version, "customer-agent-g009-l1-snapshot.v2");
  assert.equal(snapshot.raw_content_persisted, false);
  assert.match(snapshot.source_ref, /^SRC-[A-Z0-9]{12,32}$/);
  assert.match(snapshot.workbook_version_ref, /^WBV-[A-Z0-9]{16,32}$/);
  assert.equal(snapshot.snapshot_evd, "EVD-G0-09-WORKBOOK-CLOSURE-20260830");
  assert.equal(snapshot.quality_evd, snapshot.snapshot_evd);
  assert.equal(snapshot.acl_evd, "EVD-G0-09-ACL-OWNER-BASELINE-20260830");
  assert.equal(snapshot.overall_approval_evd, "EVD-G0-09-AUTHORITY-SOURCES-20260830");

  assert.deepEqual(
    snapshot.domains.map(({ domain }) => domain).sort(),
    ["aftersale", "campaign", "presale", "product"]
  );
  assert.equal(snapshot.domains.length, 4);
  for (const domain of snapshot.domains) {
    assert.match(domain.source_version_id, /^srcv_[a-z0-9]{16,32}$/);
    assert.equal(domain.total_rows, domain.importable_rows + domain.quarantined_rows);
    assert.equal(domain.readiness, "READY");
  }
  assert.equal(
    new Set(snapshot.domains.map(({ source_version_id: sourceVersionId }) => sourceVersionId)).size,
    4,
    "四个逻辑域必须使用四个独立 source_version_id"
  );

  assert.doesNotMatch(snapshotText, /https?:\/\//i);
  assert.doesNotMatch(snapshotText, /(?:^|[^\d])1[3-9]\d{9}(?:[^\d]|$)/);
  assert.doesNotMatch(snapshotText, /"(?:token|url|raw_content|members?|phone|mobile)"\s*:/i);

  assert.match(decision, /`DEC-058`/);
  assert.match(decision, /外部责任包为 `14\/14`，Scope 为 `15\/15`/);
  assert.match(businessBaseline, /EVD-G0-03-MENOKIN-APPLICABILITY-20260830/);
  assert.match(businessBaseline, /EVD-G0-13-MENOKIN-EVALUATION-FREEZE-20260830/);
  assert.match(businessBaseline, /Tests\s+52 passed \(52\)/);
  assert.match(workbookClosure, /EVD-G0-09-AUTHORITY-SOURCES-20260830/);
  assert.match(workbookClosure, /四个逻辑域共用一个物理版本/);
  assert.match(aclBaseline, /组合关闭 G0-09 \/ Scope #9/);
  assert.doesNotMatch(aclBaseline, /G0-09 \/ Scope #9 继续 `INCOMPLETE`/);
});
