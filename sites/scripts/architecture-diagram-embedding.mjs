import assert from "node:assert/strict";

/**
 * Replace one embedded architecture SVG without interpreting SVG text as a
 * String.replace replacement program. SVG can legally contain $&, $1 or $$.
 */
export function replaceEmbeddedSvg(html, id, svg) {
  const pattern = new RegExp(
    `(<div class="stage" id="stage-${id}">\\s*)<svg\\b[\\s\\S]*?</svg>(\\s*</div>)`
  );
  assert.match(html, pattern, `missing embedded SVG stage-${id}`);
  return html.replace(pattern, (_match, before, after) =>
    `${before}${svg.trim()}${after}`
  );
}
