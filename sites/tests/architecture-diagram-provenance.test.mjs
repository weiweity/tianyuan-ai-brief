import assert from "node:assert/strict";
import test from "node:test";

import {
  buildArchitectureProvenance,
  parseArchitectureProvenance,
  reconcileRenderedSvg,
  semanticSvgSha256,
  sha256,
  upsertArchitectureProvenance,
} from "../scripts/architecture-diagram-provenance.mjs";

const committedSvg =
  '<svg class="diagram-svg" viewBox="0 0 120 80" width="120" height="80"><g class="entity" id="ent1" data-source-line="3"><rect x="10" y="12" width="90" height="40" fill="#fff" stroke="#111"/><text x="18" y="36" font-size="14" fill="#111" font-family="sans-serif">客服 Agent</text></g></svg>\n';

const linuxEquivalentSvg =
  '<svg class="diagram-svg" viewBox="0 0 116 72" width="116" height="72"><g class="entity" id="ent1" data-source-line="3"><rect x="8.4" y="9.5" width="88" height="36" fill="#fff" stroke="#111"/><text x="16.4" y="31.5" font-size="14" fill="#111" font-family="sans-serif">客服 Agent</text></g></svg>\n';

const changedTextSvg = linuxEquivalentSvg.replace("客服 Agent", "客服 Copilot");

test("SVG 语义哈希忽略跨平台几何，但保留文字、结构与样式", () => {
  assert.equal(semanticSvgSha256(committedSvg), semanticSvgSha256(linuxEquivalentSvg));
  assert.notEqual(semanticSvgSha256(committedSvg), semanticSvgSha256(changedTextSvg));
  assert.notEqual(
    semanticSvgSha256(committedSvg),
    semanticSvgSha256(linuxEquivalentSvg.replace('fill="#111"', 'fill="#222"'))
  );
});

test("缺少溯源时保持 fail-closed，即使语义等价也采用现场渲染结果", () => {
  const result = reconcileRenderedSvg({
    id: "ctx",
    current: committedSvg,
    rendered: linuxEquivalentSvg,
    sourceSha256: sha256("@startuml\n客服 Agent\n@enduml\n"),
    rendererSha256: sha256("renderer-v1"),
    previousProvenance: null,
  });

  assert.equal(result.canonical, linuxEquivalentSvg);
  assert.equal(result.changed, true);
  assert.equal(result.reason, "provenance-missing");
});

test("溯源一致时接受平台几何差异，源、渲染器或 SVG 漂移时强制重生成", () => {
  const sourceSha256 = sha256("@startuml\n客服 Agent\n@enduml\n");
  const rendererSha256 = sha256("renderer-v1");
  const previousProvenance = buildArchitectureProvenance({
    rendererSha256,
    diagrams: [{ id: "ctx", baseName: "01-系统上下文", sourceSha256, svg: committedSvg }],
  });
  const stable = reconcileRenderedSvg({
    id: "ctx",
    current: committedSvg,
    rendered: linuxEquivalentSvg,
    sourceSha256,
    rendererSha256,
    previousProvenance,
  });
  assert.equal(stable.canonical, committedSvg);
  assert.equal(stable.changed, false);
  assert.equal(stable.reason, "proven-platform-equivalent");

  for (const overrides of [
    { sourceSha256: sha256("@startuml\nleft to right direction\n客服 Agent\n@enduml\n") },
    { rendererSha256: sha256("renderer-v2") },
    { current: committedSvg.replace('width="120"', 'width="121"') },
  ]) {
    const drifted = reconcileRenderedSvg({
      id: "ctx",
      current: committedSvg,
      rendered: linuxEquivalentSvg,
      sourceSha256,
      rendererSha256,
      previousProvenance,
      ...overrides,
    });
    assert.equal(drifted.canonical, linuxEquivalentSvg);
    assert.equal(drifted.changed, true);
    assert.equal(drifted.reason, "provenance-mismatch");
  }
});

test("语义变化始终重生成，不能被旧溯源放行", () => {
  const sourceSha256 = sha256("source");
  const rendererSha256 = sha256("renderer");
  const previousProvenance = buildArchitectureProvenance({
    rendererSha256,
    diagrams: [{ id: "ctx", baseName: "01-系统上下文", sourceSha256, svg: committedSvg }],
  });
  const result = reconcileRenderedSvg({
    id: "ctx",
    current: committedSvg,
    rendered: changedTextSvg,
    sourceSha256,
    rendererSha256,
    previousProvenance,
  });

  assert.equal(result.canonical, changedTextSvg);
  assert.equal(result.changed, true);
  assert.equal(result.reason, "semantic-change");
});

test("架构 HTML 溯源块可稳定写入、解析和更新", () => {
  const first = buildArchitectureProvenance({
    rendererSha256: sha256("renderer-v1"),
    diagrams: [
      {
        id: "ctx",
        baseName: "01-系统上下文",
        sourceSha256: sha256("source-v1"),
        svg: committedSvg,
      },
    ],
  });
  const html = "<!doctype html>\n<html><head><title>架构</title></head><body></body></html>\n";
  const inserted = upsertArchitectureProvenance(html, first);
  assert.deepEqual(parseArchitectureProvenance(inserted), first);
  assert.equal(upsertArchitectureProvenance(inserted, first), inserted);

  const second = buildArchitectureProvenance({
    rendererSha256: sha256("renderer-v2"),
    diagrams: [
      {
        id: "ctx",
        baseName: "01-系统上下文",
        sourceSha256: sha256("source-v2"),
        svg: linuxEquivalentSvg,
      },
    ],
  });
  const updated = upsertArchitectureProvenance(inserted, second);
  assert.deepEqual(parseArchitectureProvenance(updated), second);
  assert.equal((updated.match(/architecture-diagram-provenance/g) ?? []).length, 1);
});
