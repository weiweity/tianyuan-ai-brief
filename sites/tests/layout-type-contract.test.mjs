/**
 * Layout / type-scale contract for decision brief CSS.
 * Asserts the shipped app.css encodes non-overlap, badge centering, and adaptive table type.
 * Live browser assertions run separately in layout-type-contract.ui.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archiveRoot = path.resolve(root, "../archive/2026-08-09-ai-project-brief-security-maintenance");
const cssPath = path.join(archiveRoot, "css/app.css");

async function readCss() {
  return readFile(cssPath, "utf8");
}

test("app.css: tab badges and h2 tags use line-height 1 and flex centering", async () => {
  const css = await readCss();
  assert.match(css, /\.tab \.n\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(css, /\.tab \.n\s*\{[^}]*line-height:\s*1/s);
  assert.match(css, /\.tab \.n\s*\{[^}]*align-items:\s*center/s);
  assert.match(css, /\.tab \.n\s*\{[^}]*justify-content:\s*center/s);
  assert.match(css, /\.panel > h2 \.tag\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(css, /\.panel > h2 \.tag\s*\{[^}]*line-height:\s*1/s);
});

test("app.css: department detail table uses adaptive --fs-* tokens", async () => {
  const css = await readCss();
  assert.match(css, /\.detail-card-table td\s*\{[^}]*font-size:\s*var\(--fs-sm\)/s);
  assert.match(css, /\.detail-card-table th\s*\{[^}]*font-size:\s*var\(--fs-xs\)/s);
  // Must not hard-cap department body at 13–14px in the main (non-print) rule block
  const mainBlock = css.split("@media print")[0];
  assert.doesNotMatch(
    mainBlock,
    /\.detail-card-table td\s*\{[^}]*font-size:\s*13(?:\.5)?px/s
  );
  assert.doesNotMatch(
    mainBlock,
    /\.detail-card-table td\s*\{[^}]*font-size:\s*14px/s
  );
});

test("app.css: t4/t5 grid track and label width cannot paint over body cell", async () => {
  const css = await readCss();
  // Single-source grid: em-based track, not 96px with 110px label
  assert.match(
    css,
    /#t4 \[data-type="gate-table"\] tr[\s\S]*?grid-template-columns:\s*minmax\([^)]+\)\s+minmax\(0,\s*1fr\)/s
  );
  assert.match(
    css,
    /#t4 \[data-type="gate-table"\] td\.label[\s\S]*?width:\s*auto/s
  );
  assert.match(
    css,
    /#t5 \[data-type="kv-table"\] td\.label[\s\S]*?width:\s*auto/s
  );
  // Body and label fonts track adaptive scale
  assert.match(
    css,
    /#t4 \[data-type="gate-table"\] td[\s\S]*?font-size:\s*var\(--fs-md\)/s
  );
  // No classic conflict pair left in the primary desktop rules
  assert.doesNotMatch(
    css,
    /#t4 \[data-type="gate-table"\] tr[\s\S]*?grid-template-columns:\s*96px/s
  );
});

test("app.css: t7 gate rows use non-overlapping label track", async () => {
  const css = await readCss();
  assert.match(
    css,
    /#t7 \[data-type="gate-table"\] tr[\s\S]*?grid-template-columns:\s*minmax\(/s
  );
  assert.match(css, /#t7 \[data-type="gate-table"\] td\.label[\s\S]*?width:\s*auto/s);
});
