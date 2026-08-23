import assert from "node:assert/strict";
import test from "node:test";

import { replaceEmbeddedSvg } from "../scripts/architecture-diagram-embedding.mjs";


test("内嵌 SVG 把 replacement token 当作普通 SVG 文本", () => {
  const html = '<div class="stage" id="stage-p1"><svg><text>old</text></svg></div>';
  const svg = '<svg class="diagram-svg"><text>$&amp; $1 $$</text></svg>';
  const updated = replaceEmbeddedSvg(html, "p1", svg);

  assert.equal((updated.match(/<svg/g) ?? []).length, 1);
  assert.match(updated, /<text>\$&amp; \$1 \$\$<\/text>/);
  assert.doesNotMatch(updated, /<text><div class="stage"/);
});

test("缺少目标 stage 时 fail-closed", () => {
  assert.throws(
    () => replaceEmbeddedSvg("<main></main>", "p1", "<svg></svg>"),
    /missing embedded SVG stage-p1/
  );
});
