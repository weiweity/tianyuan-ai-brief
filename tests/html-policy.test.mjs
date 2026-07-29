import test from "node:test";
import assert from "node:assert/strict";

import { JSDOM } from "jsdom";
import { createHtmlPolicy } from "../docs/js/modules/html-policy.js";

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
  assert.equal(policy.sanitizeAssetUrl("data:text/html;base64,PHNjcmlwdD4=", "fallback.png"), "fallback.png");
  assert.equal(policy.sanitizeAssetUrl("./assets/logo.png", "fallback.png"), "./assets/logo.png");
  assert.match(
    policy.sanitizeAssetUrl("data:image/png;base64,iVBORw0KGgo=", "fallback.png"),
    /^data:image\/png/
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

test("Mermaid SVG 注入前移除脚本和事件属性", () => {
  const clean = policy.sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
      '<script>alert(2)</script><g onclick="alert(3)"><text>安全图</text></g></svg>'
  );
  assert.match(clean, /^<svg/);
  assert.match(clean, /安全图/);
  assert.doesNotMatch(clean, /script|onload|onclick/);
  assert.equal(policy.sanitizeSvg("<div>not svg</div>"), "");
});
