import { createHash } from "node:crypto";

import { JSDOM } from "jsdom";

export const ARCHITECTURE_PROVENANCE_SCHEMA = "customer-agent-architecture-diagrams/v1";

const PROVENANCE_LABEL = "architecture-diagram-provenance";
const PROVENANCE_PATTERN = /<!-- architecture-diagram-provenance\n([\s\S]*?)\n-->/g;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GEOMETRY_ATTRIBUTES = new Set([
  "cx",
  "cy",
  "d",
  "dx",
  "dy",
  "height",
  "points",
  "r",
  "rx",
  "ry",
  "textlength",
  "transform",
  "viewbox",
  "width",
  "x",
  "x1",
  "x2",
  "y",
  "y1",
  "y2",
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function semanticNode(node) {
  if (node.nodeType === node.TEXT_NODE) {
    return node.nodeValue?.trim() ? ["#text", node.nodeValue] : null;
  }
  if (node.nodeType !== node.ELEMENT_NODE) return null;

  const attributes = [...node.attributes]
    .filter((attribute) => !GEOMETRY_ATTRIBUTES.has(attribute.name.toLowerCase()))
    .map((attribute) => [attribute.name, attribute.value])
    .sort(([left], [right]) => left.localeCompare(right, "en"));
  const children = [...node.childNodes].map(semanticNode).filter(Boolean);
  return [node.localName, attributes, children];
}

export function semanticSvgSha256(svg) {
  let dom;
  try {
    dom = new JSDOM(svg, { contentType: "image/svg+xml" });
    const root = dom.window.document.documentElement;
    if (root.localName !== "svg") throw new Error("根节点不是 svg");
    return sha256(JSON.stringify(semanticNode(root)));
  } catch (error) {
    throw new Error(`无法计算 SVG 语义哈希：${error.message}`, { cause: error });
  } finally {
    dom?.window.close();
  }
}

function assertSha256(value, label) {
  if (!SHA256_PATTERN.test(value ?? "")) throw new Error(`${label} 必须是 64 位 SHA-256`);
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} 字段不受支持：${actual.join(", ")}`);
  }
}

function validateArchitectureProvenance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("架构图溯源必须是对象");
  }
  assertExactKeys(value, ["schema", "renderer_sha256", "diagrams"], "架构图溯源");
  if (value.schema !== ARCHITECTURE_PROVENANCE_SCHEMA) {
    throw new Error(`不支持的架构图溯源 schema：${value.schema}`);
  }
  assertSha256(value.renderer_sha256, "renderer_sha256");
  if (!Array.isArray(value.diagrams) || value.diagrams.length === 0) {
    throw new Error("架构图溯源 diagrams 必须是非空数组");
  }

  const ids = new Set();
  for (const [index, diagram] of value.diagrams.entries()) {
    if (!diagram || typeof diagram !== "object" || Array.isArray(diagram)) {
      throw new Error(`diagrams[${index}] 必须是对象`);
    }
    assertExactKeys(
      diagram,
      ["id", "base_name", "source_sha256", "svg_sha256", "semantic_svg_sha256"],
      `diagrams[${index}]`
    );
    if (typeof diagram.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(diagram.id)) {
      throw new Error(`diagrams[${index}].id 非法`);
    }
    if (ids.has(diagram.id)) throw new Error(`架构图溯源 id 重复：${diagram.id}`);
    ids.add(diagram.id);
    if (typeof diagram.base_name !== "string" || diagram.base_name.length === 0) {
      throw new Error(`diagrams[${index}].base_name 不能为空`);
    }
    assertSha256(diagram.source_sha256, `diagrams[${index}].source_sha256`);
    assertSha256(diagram.svg_sha256, `diagrams[${index}].svg_sha256`);
    assertSha256(diagram.semantic_svg_sha256, `diagrams[${index}].semantic_svg_sha256`);
  }
  return value;
}

export function buildArchitectureProvenance({ rendererSha256, diagrams }) {
  const value = {
    schema: ARCHITECTURE_PROVENANCE_SCHEMA,
    renderer_sha256: rendererSha256,
    diagrams: diagrams.map(({ id, baseName, sourceSha256, svg }) => ({
      id,
      base_name: baseName,
      source_sha256: sourceSha256,
      svg_sha256: sha256(svg),
      semantic_svg_sha256: semanticSvgSha256(svg),
    })),
  };
  return validateArchitectureProvenance(value);
}

export function parseArchitectureProvenance(html) {
  const matches = [...html.matchAll(PROVENANCE_PATTERN)];
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error("架构 HTML 只能包含一个机器溯源块");
  try {
    return validateArchitectureProvenance(JSON.parse(matches[0][1]));
  } catch (error) {
    throw new Error(`架构 HTML 机器溯源无效：${error.message}`, { cause: error });
  }
}

export function upsertArchitectureProvenance(html, provenance) {
  const validated = validateArchitectureProvenance(provenance);
  const serialized = JSON.stringify(validated, null, 2);
  if (serialized.includes("-->")) {
    throw new Error("架构图溯源不能包含 HTML 注释终止序列");
  }
  const block = `<!-- ${PROVENANCE_LABEL}\n${serialized}\n-->`;

  const matches = [...html.matchAll(PROVENANCE_PATTERN)];
  if (matches.length > 1) throw new Error("架构 HTML 只能包含一个机器溯源块");
  if (matches.length === 1) return html.replace(PROVENANCE_PATTERN, block);

  const headClosures = html.match(/<\/head>/g) ?? [];
  if (headClosures.length !== 1) throw new Error("架构 HTML 必须包含唯一 </head>");
  return html.replace("</head>", `${block}\n</head>`);
}

export function reconcileRenderedSvg({
  id,
  current,
  rendered,
  sourceSha256,
  rendererSha256,
  previousProvenance,
}) {
  assertSha256(sourceSha256, `${id}.sourceSha256`);
  assertSha256(rendererSha256, `${id}.rendererSha256`);
  if (typeof rendered !== "string" || rendered.length === 0) {
    throw new Error(`${id}.rendered 不能为空`);
  }
  if (current === rendered) {
    return {
      canonical: rendered,
      changed: false,
      reason: "exact",
      semanticSha256: semanticSvgSha256(rendered),
    };
  }
  if (typeof current !== "string" || current.length === 0) {
    return {
      canonical: rendered,
      changed: true,
      reason: "missing-current",
      semanticSha256: semanticSvgSha256(rendered),
    };
  }

  const renderedSemantic = semanticSvgSha256(rendered);
  let currentSemantic;
  try {
    currentSemantic = semanticSvgSha256(current);
  } catch {
    return {
      canonical: rendered,
      changed: true,
      reason: "invalid-current",
      semanticSha256: renderedSemantic,
    };
  }
  if (currentSemantic !== renderedSemantic) {
    return {
      canonical: rendered,
      changed: true,
      reason: "semantic-change",
      semanticSha256: renderedSemantic,
    };
  }
  if (previousProvenance === null) {
    return {
      canonical: rendered,
      changed: true,
      reason: "provenance-missing",
      semanticSha256: renderedSemantic,
    };
  }

  const previous = previousProvenance.diagrams.find((diagram) => diagram.id === id);
  const provenanceMatches =
    previousProvenance.renderer_sha256 === rendererSha256 &&
    previous?.source_sha256 === sourceSha256 &&
    previous?.svg_sha256 === sha256(current) &&
    previous?.semantic_svg_sha256 === currentSemantic;
  if (provenanceMatches) {
    return {
      canonical: current,
      changed: false,
      reason: "proven-platform-equivalent",
      semanticSha256: currentSemantic,
    };
  }
  return {
    canonical: rendered,
    changed: true,
    reason: "provenance-mismatch",
    semanticSha256: renderedSemantic,
  };
}
