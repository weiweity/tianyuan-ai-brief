/**
 * Layout / type-scale contract for decision brief CSS.
 * Asserts the shipped app.css encodes non-overlap, badge centering, and adaptive table type.
 * Optionally drives the real page with Playwright (system Chrome) when available.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cssPath = path.join(root, "docs/css/app.css");

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

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

test("live page: label does not overlap body text; badges centered; dept type tracks body", async (t) => {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    t.skip("playwright not installed");
    return;
  }

  const port = await freePort();
  const server = spawn("python3", ["-m", "http.server", String(port), "-d", "docs"], {
    cwd: root,
    stdio: "ignore",
  });

  const waitServer = async () => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        if (res.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("preview server timeout");
  };

  let browser;
  try {
    await waitServer();
    try {
      browser = await chromium.launch({ headless: true, channel: "chrome" });
    } catch {
      browser = await chromium.launch({ headless: true });
    }

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.appState === "ready" ||
        document.body.innerText.includes("今日拍板"),
      null,
      { timeout: 20000 }
    );

    // Tabs badge geometry
    await page.keyboard.press("1");
    await page.waitForTimeout(200);
    const badge = await page.evaluate(() => {
      const n = document.querySelector(".tab.active .n") || document.querySelector(".tab .n");
      const tag = document.querySelector(".panel.active h2 .tag");
      const measure = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          w: r.width,
          h: r.height,
          fs: parseFloat(cs.fontSize),
          lh: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize),
          display: cs.display,
          align: cs.alignItems,
          justify: cs.justifyContent,
        };
      };
      return { n: measure(n), tag: measure(tag) };
    });
    assert.ok(badge.n, "tab number badge missing");
    assert.ok(badge.n.w + 0.5 >= badge.n.fs, "badge width must fit glyph");
    assert.ok(badge.n.h + 0.5 >= badge.n.fs, "badge height must fit glyph");
    assert.ok(badge.n.lh <= badge.n.fs + 1, `line-height must not inflate: lh=${badge.n.lh} fs=${badge.n.fs}`);
    assert.match(badge.n.display, /flex|grid/);
    assert.ok(badge.tag, "h2 tag missing");
    assert.ok(badge.tag.lh <= badge.tag.fs + 1, "h2 tag line-height inflated");

    // t4 non-overlap
    await page.keyboard.press("4");
    await page.waitForTimeout(400);
    const t4 = await page.evaluate(() => {
      const label = document.querySelector("#t4 td.label");
      const body = document.querySelector("#t4 tr td:not(.label)");
      if (!label || !body) return null;
      const lr = label.getBoundingClientRect();
      const br = body.getBoundingClientRect();
      return {
        labelRight: lr.right,
        bodyLeft: br.left,
        bodyFs: parseFloat(getComputedStyle(body).fontSize),
        labelFs: parseFloat(getComputedStyle(label).fontSize),
        pageBody: parseFloat(getComputedStyle(document.body).fontSize),
      };
    });
    assert.ok(t4, "t4 gate cells missing");
    assert.ok(
      t4.labelRight <= t4.bodyLeft + 0.5,
      `label paints over body: labelRight=${t4.labelRight} bodyLeft=${t4.bodyLeft}`
    );
    assert.ok(
      t4.bodyFs >= t4.pageBody * 0.75,
      `t4 body type too small vs page: ${t4.bodyFs} vs ${t4.pageBody}`
    );

    // t5 non-overlap
    await page.keyboard.press("5");
    await page.waitForTimeout(400);
    const t5 = await page.evaluate(() => {
      const label = document.querySelector("#t5 td.label");
      const body = document.querySelector("#t5 tr td:not(.label)");
      if (!label || !body) return null;
      const lr = label.getBoundingClientRect();
      const br = body.getBoundingClientRect();
      return { labelRight: lr.right, bodyLeft: br.left, bodyFs: parseFloat(getComputedStyle(body).fontSize) };
    });
    assert.ok(t5, "t5 cells missing");
    assert.ok(t5.labelRight <= t5.bodyLeft + 0.5, `t5 overlap: ${t5.labelRight} > ${t5.bodyLeft}`);

    // t2 department table type scale
    await page.keyboard.press("2");
    await page.waitForTimeout(400);
    const toggle = page.locator("#t2 [data-detail-toggle]");
    if (await toggle.count()) {
      await toggle.click();
      await page.waitForTimeout(500);
    }
    const t2 = await page.evaluate(() => {
      const td = document.querySelector("#t2 .detail-card-table td");
      const th = document.querySelector("#t2 .detail-card-table th");
      const pageBody = parseFloat(getComputedStyle(document.body).fontSize);
      return {
        open: document.querySelector("#t2 .detail-card")?.classList.contains("is-open"),
        tdFs: td ? parseFloat(getComputedStyle(td).fontSize) : null,
        thFs: th ? parseFloat(getComputedStyle(th).fontSize) : null,
        pageBody,
      };
    });
    assert.ok(t2.open, "department detail should open");
    assert.ok(t2.tdFs != null, "department td missing");
    assert.ok(
      t2.tdFs >= t2.pageBody * 0.72,
      `department td stuck small: ${t2.tdFs} vs body ${t2.pageBody}`
    );
    assert.ok(t2.tdFs > 15, `department td should exceed 15px at large type scale, got ${t2.tdFs}`);

    await browser.close();
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    // If Chromium binary missing, keep CSS contract tests as the gate
    if (String(error).includes("Executable doesn't exist") || String(error).includes("browserType.launch")) {
      t.skip(`browser unavailable: ${error.message || error}`);
      return;
    }
    throw error;
  } finally {
    server.kill("SIGTERM");
  }
});
