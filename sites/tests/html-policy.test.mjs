import test from "node:test";
import assert from "node:assert/strict";

import { JSDOM } from "jsdom";
import { createHtmlPolicy } from "../../archive/2026-07-31-ai-project-brief/js/modules/html-policy.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const policy = createHtmlPolicy(dom.window);

test("富文本只保留业务白名单标签、属性和类名", () => {
  const clean = policy.sanitizeRichHtml(
    '<script>alert(1)</script><img src=x onerror=alert(2)><b onclick="alert(3)">保留</b>' +
      '<span class="flow-step evil" style="color:red" aria-hidden="TRUE">步骤</span>'
  );
  assert.doesNotMatch(clean, /script|img|onerror|onclick|style=|evil/);
  assert.match(clean, /<b>保留<\/b>/);
  assert.match(clean, /class="flow-step"/);
  assert.match(clean, /aria-hidden="false"/);
});

test("资源 URL 拒绝 javascript、外域和非图片 data", () => {
  assert.equal(policy.sanitizeAssetUrl("javascript:alert(1)", "fallback.png"), "fallback.png");
  assert.equal(policy.sanitizeAssetUrl("https://evil.example/x.png", "fallback.png"), "fallback.png");
  assert.equal(policy.sanitizeAssetUrl("//evil.example/x.png", "fallback.png"), "fallback.png");
  assert.equal(policy.sanitizeAssetUrl("///evil.example/x.png", "fallback.png"), "fallback.png");
  assert.equal(policy.sanitizeAssetUrl("/etc/passwd", "fallback.png"), "fallback.png");
  assert.equal(policy.sanitizeAssetUrl("assets/../secret.png", "fallback.png"), "fallback.png");
  assert.equal(
    policy.sanitizeAssetUrl("assets/%2e%2e/secret.png", "fallback.png"),
    "fallback.png"
  );
  assert.equal(policy.sanitizeAssetUrl("assets\\logo.png", "fallback.png"), "fallback.png");
  assert.equal(policy.sanitizeAssetUrl("data:text/html;base64,PHNjcmlwdD4=", "fallback.png"), "fallback.png");
  assert.equal(policy.sanitizeAssetUrl("./assets/logo.png", "fallback.png"), "./assets/logo.png");
  assert.match(
    policy.sanitizeAssetUrl("data:image/png;base64,iVBORw0KGgo=", "fallback.png"),
    /^data:image\/png/
  );
  assert.equal(
    policy.sanitizeAssetUrl(
      "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+",
      "fallback.png"
    ),
    "fallback.png"
  );
});

test("内容树在进入渲染器前统一清洗且不修改原对象", () => {
  const source = {
    meta: {
      logo: "javascript:alert(1)",
      logoDataUrl: "data:text/html;base64,WA==",
      brand: "red; background:url(javascript:alert(1))",
      footerRight: '<b onclick="x()">页脚</b><iframe src="x"></iframe>',
    },
    tabs: [
      {
        blocks: [
          {
            type: "callout",
            html: '<div class="line bad">文本</div><svg onload="x()"></svg>',
          },
        ],
      },
    ],
  };
  const result = policy.sanitizeContent(source);
  assert.equal(source.meta.logo, "javascript:alert(1)");
  assert.equal(result.meta.logo, "");
  assert.equal(result.meta.logoDataUrl, "");
  assert.equal(result.meta.brand, "#EBE6EF");
  assert.equal(result.meta.footerRight, "<b>页脚</b>");
  assert.equal(result.tabs[0].blocks[0].html, '<div class="line">文本</div>');
});

test("Mermaid SVG 保留原生文字并移除全部主动内容与外部引用", () => {
  const clean = policy.sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
      '<script>alert(2)</script>' +
      '<foreignObject><div>危险 HTML</div></foreignObject>' +
      '<g onpointerenter="alert(3)"><text>安全图<tspan>文字</tspan></text></g>' +
      '<a href="javascript:alert(4)"><text>危险链接</text></a>' +
      '<use href="#safe-marker"/><image href="https://evil.example/a.png"/>' +
      "</svg>"
  );
  assert.match(clean, /^<svg/);
  assert.match(clean, /安全图.*tspan.*文字/s);
  assert.doesNotMatch(
    clean,
    /script|foreignObject|onload|onpointerenter|javascript:|https:\/\/evil\.example/
  );
  assert.equal(policy.sanitizeSvg("<div>not svg</div>"), "");
});

test("Mermaid SVG 的 CSS 只允许本地 fragment，不允许外链或脚本协议", () => {
  const clean = policy.sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<style>@import url(https://evil.example/a.css);.bad{fill:url(https://evil.example/a)}</style>' +
      '<defs><linearGradient id="safe"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
      '<rect class="bad" style="fill:url(javascript:alert(1))"/>' +
      '<rect class="safe" style="fill:url(#safe);stroke:#333"/>' +
      "</svg>"
  );
  assert.doesNotMatch(clean, /@import|evil\.example|javascript:/);
  assert.doesNotMatch(clean, /class="bad"[^>]*style=/);
  assert.match(clean, /class="safe"[^>]*style="[^"]*url\(#safe\)/);
});

test("Mermaid SVG 的 presentation 属性同样禁止外部 url", () => {
  const clean = policy.sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<rect class="bad" filter="url(https://evil.example/f#x)" marker-end="url(//evil.example/y#z)" fill="url(javascript:alert(1))"/>' +
      '<rect class="safe" filter="url(#shadow)" fill="url(#paint)"/>' +
      "</svg>"
  );
  assert.doesNotMatch(clean, /evil\.example|javascript:/);
  assert.doesNotMatch(clean, /class="bad"[^>]*(?:filter|marker-end|fill)=/);
  assert.match(clean, /class="safe"[^>]*filter="url\(#shadow\)"/);
  assert.match(clean, /class="safe"[^>]*fill="url\(#paint\)"/);
});
