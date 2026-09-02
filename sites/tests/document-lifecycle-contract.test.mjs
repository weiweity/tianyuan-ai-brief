import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const projectRoot = path.join(repoRoot, "business-docs/01-客服Agent项目");

async function readRepoFile(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("文档生命周期规则保留当前源、历史冻结与生成视图边界", async () => {
  const [lifecycle, projectReadme, surfacesSync, diagramsSync] = await Promise.all([
    readRepoFile("business-docs/01-客服Agent项目/文档生命周期与动态视图规则.md"),
    readRepoFile("business-docs/01-客服Agent项目/README.md"),
    readRepoFile("business-docs/08-工具/sync_customer_agent_surfaces.mjs"),
    readRepoFile("sites/scripts/sync-customer-agent-architecture-diagrams.mjs"),
  ]);

  for (const marker of [
    "`00–06` 是当前项目状态和批准范围的真源",
    "`09` 在 D0 需求会生命周期关闭后是历史快照",
    "`.puml → .svg → HTML`",
    "HTML 手写壳负责受控说明与状态投影",
    "SVG、内嵌 SVG 与溯源块只由生成脚本改",
    "读取现有 HTML 作为 canonical 手写壳",
    "飞书是正式阅读/留存面，不是本地运行时真源",
    "没有目标父目录、当前修订号和权限证据时不写入",
  ]) {
    assert.match(lifecycle, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  }

  const reviewedAt = lifecycle.match(/当前复核：(\d{4}-\d{2}-\d{2})/)?.[1];
  const verifiedThrough = lifecycle.match(/截至 (\d{4}-\d{2}-\d{2})，本地已核实：/)?.[1];
  assert.ok(reviewedAt, "生命周期文档必须声明当前复核日期");
  assert.ok(verifiedThrough, "生命周期文档必须声明本轮核对截止日期");
  assert.equal(verifiedThrough, reviewedAt, "本轮核对截止日期必须与当前复核日期一致");

  assert.match(projectReadme, /文档生命周期与动态视图规则\.md/);
  assert.match(surfacesSync, /meetingLifecycleClosed/);
  assert.match(surfacesSync, /verifyFrozenMeetingSnapshot/);
  assert.match(lifecycle, /20-设计-进行中\/diagrams\/.*01～08.*\.puml/);
  assert.doesNotMatch(lifecycle, /架构图-PlantUML浏览器\.puml/);
  assert.match(diagramsSync, /架构图-PlantUML浏览器\.html/);
  assert.match(diagramsSync, /PlantUML 产物未同步/);
  assert.ok(projectRoot.endsWith("business-docs/01-客服Agent项目"));
});

test("归档后的 G0-09 决定仍能解析其相对文档链接", async () => {
  const archiveDir = path.join(
    projectRoot,
    "99-历史/2026-08-30-G0-09企业级权限取证方案"
  );
  const documents = [
    "2026-08-30_G0-09四域共用ACL-EVD草案.md",
    "2026-08-30_G0-09管理员取证暂停与S0分账决定.md",
  ];

  for (const document of documents) {
    const documentPath = path.join(archiveDir, document);
    const content = await readFile(documentPath, "utf8");
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+\.md)\)/g)) {
      const target = path.resolve(path.dirname(documentPath), decodeURIComponent(match[1]));
      await assert.doesNotReject(access(target), `${document} -> ${match[1]}`);
    }
  }
});
