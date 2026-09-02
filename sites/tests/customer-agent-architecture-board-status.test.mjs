import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeHtml,
  synchronizeBoardStatusShell,
} from "../scripts/customer-agent-architecture-board-status.mjs";

const boardShell = `
<span class="gate todo" data-current-development>old development</span>
<span class="next">old next</span>
<div class="cv-card" role="listitem"><div class="k">组织门禁</div><div class="v">old</div><div class="d">old</div></div>
<section class="panel" id="panel-wf"><p class="purpose"><strong>生成状态：</strong>old</p></section>
<tr><td>代码开发</td><td>按设计真正写程序。</td><td>old</td></tr>
<li><strong>G0/Ddev 组织授权门（不计入八关）</strong>：old</li>
<p><strong>当前推进项：</strong>old</p>
<tr><th>4 代码开发</th><td><span class="gate todo">old</span></td><td>开发</td></tr>
<footer>离线单文件 · 当前规范以 37/39/40/46 为准 · old · schema v1.12</footer>
`;

test("架构图状态壳对动态文本做 HTML 转义", () => {
  assert.equal(
    escapeHtml(`<tag attr="value">Tom & Jerry's</tag>`),
    "&lt;tag attr=&quot;value&quot;&gt;Tom &amp; Jerry&#39;s&lt;/tag&gt;"
  );

  const rendered = synchronizeBoardStatusShell(boardShell, {
    developmentProgress: {
      category: "active",
      completedSlices: ["W0<script>"],
      milestone: `DEV-M0<img src=x onerror="boom()">$1$&`,
      nextSlice: "",
      nextSliceName: "",
      nextAction: `<svg onload="boom()">合同开发$1$&`,
    },
    g0Ready: true,
    ddevReady: true,
    g0: "Pass",
    ddev: "2026-08-31",
    g0Evidence: `EVD-G0<img>`,
    ddevEvidence: `EVD-DDEV<svg>`,
    externalPass: 14,
    externalTotal: 14,
    scopePass: 15,
    scopeTotal: 15,
  });

  assert.doesNotMatch(rendered, /<(?:img|script|svg)\b/i);
  assert.match(rendered, /&lt;img src=x onerror=&quot;boom\(\)&quot;&gt;/);
  assert.match(rendered, /&lt;svg onload=&quot;boom\(\)&quot;&gt;/);
  assert.match(rendered, /\$1\$&/);
  const currentProgressLine = rendered
    .split("\n")
    .find((line) => line.includes('<span class="next">'));
  assert.equal((currentProgressLine?.match(/待单独授权/g) || []).length, 1);
});
