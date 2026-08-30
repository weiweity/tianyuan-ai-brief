import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
    "飞书是正式阅读/留存面，不是本地运行时真源",
    "没有目标父目录、当前修订号和权限证据时不写入",
  ]) {
    assert.match(lifecycle, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  }

  assert.match(projectReadme, /文档生命周期与动态视图规则\.md/);
  assert.match(surfacesSync, /meetingLifecycleClosed/);
  assert.match(surfacesSync, /verifyFrozenMeetingSnapshot/);
  assert.match(lifecycle, /20-设计-进行中\/diagrams\/.*01～08.*\.puml/);
  assert.doesNotMatch(lifecycle, /架构图-PlantUML浏览器\.puml/);
  assert.match(diagramsSync, /架构图-PlantUML浏览器\.html/);
  assert.match(diagramsSync, /PlantUML 产物未同步/);
  assert.ok(projectRoot.endsWith("business-docs/01-客服Agent项目"));
});
