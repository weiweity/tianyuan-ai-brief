/**
 * app.js — 渲染 + 编辑 + 写回 content.json
 * 禁止在此文件写业务文案。内容只来自 data/content.json。
 */
import {
  buildDecisionReceipt,
  buildMeetingConclusionText,
  evaluateCheckGate,
  namedOwnersOf,
  sha256,
  verifyDecisionReceipt,
} from "./modules/decision-model.js";
import {
  sanitizeAssetUrl,
  sanitizeBrandColor,
  sanitizeContent,
  sanitizeRichHtml,
  sanitizeSvg,
} from "./modules/html-policy.js";
import { createContentLoader } from "./modules/content-loader.js";
import { createMermaidRuntime } from "./modules/mermaid-runtime.js";
import { mergeMeetingState } from "./modules/meeting-state.js";

(function () {
  "use strict";

  const STORAGE_KEY = "tianyuan-brief-draft-v1";
  const LKG_KEY = "tianyuan-brief-content-lkg-v1";
  const HANDLE_DB = "tianyuan-brief-fs";
  const HANDLE_STORE = "handles";
  const DECISION_SCHEMA_VERSION = 2;

  let content = null;
  let activeTab = "t1";
  let editing = false;
  let fileHandle = null;
  let swipeDir = "left"; // panel animation direction
  let currentReleaseManifest = null;
  let hotPollTimer = null;
  const POLL_MS = 30000; // C端静默检查远端内容
  const isEditQuery = /(?:\?|&)edit=1(?:&|$)/.test(location.search);
  const isFileProtocol = location.protocol === "file:";
  const shellReleaseId = document.documentElement.dataset.release || "";
  document.documentElement.classList.toggle("author-mode", isEditQuery);
  document.documentElement.classList.toggle("offline-file-mode", isFileProtocol);

  const contentLoader = createContentLoader({
    windowLike: window,
    isFileProtocol,
    isAuthorMode: () => isEditQuery || editing,
    sanitizeContent,
    sha256,
    expectedReleaseId: shellReleaseId,
    expectedDecisionSchemaVersion: DECISION_SCHEMA_VERSION,
    cacheKey: LKG_KEY,
  });

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  function toast(msg, ms = 2200) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), ms);
  }

  function setStatus(text, cls = "") {
    const p = $("#status-pill");
    p.textContent = text;
    p.className = cls;
  }

  function showLoadFailure(error, options = {}) {
    const stage = $("#stage");
    const panel = document.createElement("section");
    panel.className = "boot-error";
    const heading = document.createElement("h2");
    const detail = document.createElement("p");
    const hint = document.createElement("p");
    const retry = document.createElement("button");
    const isReleaseRefresh = Boolean(options.releaseId);
    heading.textContent = isFileProtocol
      ? "离线快照暂不可用"
      : isReleaseRefresh
        ? "检测到新版本"
        : "内容暂不可用";
    detail.textContent = isReleaseRefresh
      ? "页面与内容版本正在切换，将自动重新加载。"
      : String(error && error.message ? error.message : error || "加载失败");
    hint.className = "boot-error-hint";
    hint.textContent = isFileProtocol
      ? "请在仓库根执行 npm run build:web 后重新打开此文件。"
      : "网络或发布恢复后可直接重试；本机已保存的会议草稿不会丢失。";
    retry.type = "button";
    retry.className = "boot-retry";
    retry.textContent = isReleaseRefresh ? "立即加载新版本" : "重新加载";
    retry.addEventListener("click", () => {
      if (isReleaseRefresh) {
        const target = new URL(location.href);
        target.searchParams.set("_release", options.releaseId);
        location.replace(target.toString());
      } else {
        location.reload();
      }
    });
    panel.replaceChildren(heading, detail, hint, retry);
    stage.replaceChildren(panel);
  }

  // ---------- File handle (IndexedDB) ----------
  function withTimeout(promise, ms, fallback) {
    return new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) {
          done = true;
          resolve(fallback);
        }
      }, ms);
      Promise.resolve(promise).then(
        (v) => {
          if (!done) {
            done = true;
            clearTimeout(t);
            resolve(v);
          }
        },
        () => {
          if (!done) {
            done = true;
            clearTimeout(t);
            resolve(fallback);
          }
        }
      );
    });
  }

  function idbOpen() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("no idb"));
        return;
      }
      const req = indexedDB.open(HANDLE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(HANDLE_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("idb open failed"));
      req.onblocked = () => reject(new Error("idb blocked"));
    });
  }
  async function saveHandle(handle) {
    try {
      const db = await withTimeout(idbOpen(), 1200, null);
      if (!db) return;
      await withTimeout(
        new Promise((res, rej) => {
          const tx = db.transaction(HANDLE_STORE, "readwrite");
          tx.objectStore(HANDLE_STORE).put(handle, "contentJson");
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        }),
        1200,
        null
      );
    } catch (_) { /* ignore */ }
  }
  async function loadHandle() {
    try {
      const db = await withTimeout(idbOpen(), 1200, null);
      if (!db) return null;
      return await withTimeout(
        new Promise((res, rej) => {
          const tx = db.transaction(HANDLE_STORE, "readonly");
          const r = tx.objectStore(HANDLE_STORE).get("contentJson");
          r.onsuccess = () => res(r.result || null);
          r.onerror = () => rej(r.error);
        }),
        1200,
        null
      );
    } catch (_) {
      return null;
    }
  }

  // ---------- Load content ----------
  async function fetchRemoteContent(manifestHint) {
    return contentLoader.fetchContent(manifestHint);
  }

  async function loadContent(opts) {
    const preferDraft = opts && opts.preferDraft;
    // C端默认不读草稿，保证打开即最新；编辑态/ ?edit=1 才恢复草稿
    if (preferDraft || isEditQuery || editing) {
      try {
        const draft = localStorage.getItem(STORAGE_KEY);
        if (draft) {
          const parsed = sanitizeContent(JSON.parse(draft));
          if (
            parsed &&
            parsed.tabs &&
            Number(parsed.decisionSchemaVersion || 1) === DECISION_SCHEMA_VERSION
          ) {
            content = parsed;
            setStatus("草稿(本机)", "warn");
            return { from: "draft" };
          }
        }
      } catch (_) {}
    }

    let source = isFileProtocol ? "offline" : "remote";
    try {
      const loaded = await fetchRemoteContent();
      content = loaded.content;
      currentReleaseManifest = loaded.manifest;
    } catch (error) {
      const cached = !isFileProtocol && contentLoader.readLastKnownGood();
      if (!cached) throw error;
      content = cached.content;
      currentReleaseManifest = cached.manifest;
      source = "cache";
    }
    // 会议中途刷新：远程文案 + 本机勾选合并（不整份草稿覆盖）
    try {
      const draft = localStorage.getItem(STORAGE_KEY);
      if (draft) {
        const parsed = sanitizeContent(JSON.parse(draft));
        if (parsed && parsed.tabs) {
          content = mergeCheckState(parsed, content);
        }
      }
    } catch (_) {}
    if (source === "cache") setStatus("缓存快照 · 可能不是最新", "warn");
    else setStatus(isFileProtocol ? "本地快照" : "已是最新", isFileProtocol ? "warn" : "ok");
    return { from: source };
  }

  /** 无感应用新内容：保留当前 Tab，轻闪刷新，不整页跳转 */
  function softApplyContent(next, reason) {
    if (!next || !next.tabs) return;
    next = sanitizeContent(next);
    const keep = activeTab;
    // poll/reload 时合并本机勾选，避免会议中途被远端文案覆盖掉勾
    if (reason === "poll" || reason === "reload") {
      next = mergeCheckState(content, next);
    }
    content = next;
    // 热更合并后写回草稿，刷新/重开仍能按 rowId 对齐勾选
    if (reason === "poll" || reason === "reload") {
      saveDraft();
    }
    const stage = $("#stage");
    if (stage) {
      stage.classList.add("is-hot-updating");
      setTimeout(() => stage.classList.remove("is-hot-updating"), 480);
    }
    // 若旧 tab 不存在，回到第一页
    if (!content.tabs.some((x) => x.id === keep)) {
      activeTab = content.tabs[0].id;
    } else {
      activeTab = keep;
    }
    mermaidRuntime.clear();
    renderAll();
    document.body.classList.toggle("is-check-page", activeTab === "t6");
    setStatus(reason === "save" ? "已更新" : "已同步最新", "ok");
    return true;
  }

  let pollFailCount = 0;
  const MSG = {
    hotOk: "内容已自动更新",
    hotClick: "已刷新到最新",
    netWarn: "网络不稳，恢复后将自动同步",
    netStatus: "离线/弱网",
    netBack: "网络已恢复",
    latest: "已是最新",
    release: "发现新版本，正在安全刷新",
  };

  function requestReleaseRefresh(releaseId) {
    const target = new URL(location.href);
    const alreadyTargeted = target.searchParams.get("_release") === releaseId;
    const refresh = () => {
      if (alreadyTargeted) {
        location.reload();
        return;
      }
      target.searchParams.set("_release", releaseId);
      location.replace(target.toString());
    };
    pollFailCount = 0;
    setStatus(alreadyTargeted ? "新版本待刷新" : "正在切换新版本", "warn");
    const chip = $("#update-chip");
    if (alreadyTargeted) {
      if (chip) {
        chip.textContent = "新版本已发布 · 点击重新加载";
        chip.hidden = false;
        chip.classList.add("show");
        chip.onclick = refresh;
      }
      return;
    }
    toast(MSG.release, 1400);
    setTimeout(refresh, 80);
  }

  async function checkRemoteUpdate(silent) {
    if (editing) return;
    try {
      // 轮询允许识别“新壳 + 新内容”的 release；跨 release 不在旧 JS 上热套，
      // 而是带版本号刷新整页，避免 shell/content 混版。
      const manifest = await contentLoader.fetchManifest({ allowReleaseMismatch: true });
      if (shellReleaseId && manifest.releaseId !== shellReleaseId) {
        requestReleaseRefresh(manifest.releaseId);
        return;
      }
      if (manifest.contentSha256 === currentReleaseManifest?.contentSha256) {
        pollFailCount = 0;
        return;
      }
      const loaded = await fetchRemoteContent(manifest);
      const remote = loaded.content;
      const wasFailing = pollFailCount >= 3;
      pollFailCount = 0;
      if (wasFailing) {
        setStatus(MSG.latest, "ok");
        toast(MSG.netBack, 1400);
      }
      const apply = (message, duration) => {
        if (!softApplyContent(remote, "poll")) return;
        // 只有成功渲染并保存会议态后，才提交新 SHA，失败时下轮仍会重试。
        currentReleaseManifest = loaded.manifest;
        toast(message, duration);
      };
      // C端：静默热更新（无感）
      if (silent) {
        apply(MSG.hotOk, 1600);
      } else {
        const chip = $("#update-chip");
        if (chip) {
          chip.hidden = false;
          chip.classList.add("show");
          chip.onclick = () => {
            apply(MSG.hotClick, 1400);
            chip.classList.remove("show");
            chip.hidden = true;
          };
        } else {
          apply(MSG.hotOk, 1600);
        }
      }
    } catch (_) {
      pollFailCount += 1;
      // 连续失败 3 次再提示，避免弱网刷屏；文案统一 MSG
      if (pollFailCount === 3) {
        setStatus(MSG.netStatus, "warn");
        toast(MSG.netWarn, 2200);
      }
    }
  }

  function startHotPoll() {
    if (isFileProtocol) return;
    if (hotPollTimer) clearInterval(hotPollTimer);
    hotPollTimer = setInterval(() => checkRemoteUpdate(true), POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !editing) checkRemoteUpdate(true);
    });
    // 回到前台再查一次
    window.addEventListener("focus", () => {
      if (!editing) checkRemoteUpdate(true);
    });
  }

  // ---------- Render ----------
  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const mermaidRuntime = createMermaidRuntime({
    windowLike: window,
    documentLike: document,
    getBlock: (id) => findBlock(id),
    getActiveTab: () => activeTab,
    isEditing: () => editing,
    sanitizeSvg,
  });
  const queueMermaid = (tabId) => mermaidRuntime.queue(tabId);
  const queueAllMermaid = () =>
    Promise.allSettled((content && content.tabs ? content.tabs : []).map((tab) => queueMermaid(tab.id)));
  const prepareAllMermaidFallbacks = () =>
    (content && content.tabs ? content.tabs : []).forEach((tab) =>
      mermaidRuntime.prepareFallback(tab.id)
    );
  const wireMermaidLightbox = () => mermaidRuntime.wireLightbox();

  function renderHeader() {
    const m = content.meta || {};
    const logo = sanitizeAssetUrl(m.logoDataUrl || m.logo, "./assets/logo.png");
    $("#logo-img").src = logo;
    $("#logo-img").alt = m.title || "logo";
    $("#doc-title").textContent = m.title || "AI 赋能立项";

    // 副标题 / 角色行：空则隐藏，不留占位
    const sub = $("#doc-sub");
    const from = (m.from || "").trim();
    const to = (m.to || "").trim();
    const subtitle = (m.subtitle || "").trim();
    if (sub) {
      if (from || to || subtitle) {
        const parts = [];
        if (from || to) parts.push(`<b>${esc(from)}</b>${from || to ? " → " : ""}<b>${esc(to)}</b>`);
        if (subtitle) parts.push(esc(subtitle));
        sub.innerHTML = parts.filter(Boolean).join(" · ");
        sub.hidden = false;
        sub.style.display = "";
      } else {
        sub.innerHTML = "";
        sub.hidden = true;
        sub.style.display = "none";
      }
    }
    const role = $("#doc-role");
    if (role) {
      const rl = (m.roleLine || "").trim();
      role.textContent = rl;
      role.hidden = !rl;
      role.style.display = rl ? "" : "none";
    }

    const fl = $("#footer-left");
    const fr = $("#footer-right");
    if (fl) {
      fl.textContent = m.footerLeft || "";
      fl.hidden = !(m.footerLeft || "").trim();
    }
    if (fr) {
      // 底栏默认极简，不塞版本号/派工说明
      fr.innerHTML = sanitizeRichHtml(m.footerRight || "");
      fr.hidden = !(m.footerRight || "").trim();
    }
    // 两侧都空则藏整条 stage-meta 里的 footer 区（保留页码提示）
    const meta = document.querySelector(".stage-meta");
    if (meta) {
      const hasFoot = (m.footerLeft || "").trim() || (m.footerRight || "").trim();
      const foot = meta.querySelector(".footer");
      if (foot) foot.hidden = !hasFoot;
    }
    if (m.brand) {
      document.documentElement.style.setProperty("--brand", sanitizeBrandColor(m.brand));
    }
    document.title = m.title || "AI 赋能立项";
  }

  function renderTabs() {
    const nav = $("#tabs");
    nav.innerHTML = content.tabs
      .map(
        (t) =>
          `<button type="button" class="tab${t.id === activeTab ? " active" : ""}" data-tab="${esc(t.id)}" role="tab" aria-selected="${t.id === activeTab}" aria-controls="${esc(t.id)}" id="tab-${esc(t.id)}" tabindex="${t.id === activeTab ? "0" : "-1"}">` +
          `<span class="n">${esc(t.no || "")}</span>${esc(t.title)}</button>`
      )
      .join("");
    nav.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => activate(btn.dataset.tab));
    });
    renderDots();
    updatePagerChrome();
  }

  function renderDots() {
    const host = $("#pager-dots");
    if (!host) return;
    host.innerHTML = content.tabs
      .map(
        (t, i) =>
          `<button type="button" data-tab="${esc(t.id)}" class="${t.id === activeTab ? "active" : ""}" aria-label="第 ${i + 1} 页 ${esc(t.title)}"${t.id === activeTab ? ' aria-current="true"' : ""}></button>`
      )
      .join("");
    host.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => activate(btn.dataset.tab));
    });
  }

  /**
   * 只改顶栏 chrome（Tab/进度/页码），不写 activeTab、不切 panel。
   * 手势过阈时乐观调用，回弹时用真实 activeTab 回滚。
   * @param {string} id tab id
   * @param {{ smoothTab?: boolean, scrollTab?: boolean }} [opts]
   *   scrollTab 默认 true；拖拽中应 false，避免 scrollIntoView 抢主线程导致不跟手
   */
  function paintChrome(id, opts) {
    if (!content || !id || !findTab(id)) return;
    const ids = content.tabs.map((x) => x.id);
    const idx = Math.max(0, ids.indexOf(id));
    $$(".tab").forEach((t) => {
      const on = t.dataset.tab === id;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      if (on) t.setAttribute("aria-current", "true");
      else t.removeAttribute("aria-current");
    });
    $$("#pager-dots button").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === id);
      if (b.dataset.tab === id) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    });
    const label = $("#page-label");
    if (label) label.textContent = `${idx + 1} / ${ids.length}`;
    const prev = $("#nav-prev");
    const next = $("#nav-next");
    if (prev) prev.disabled = idx <= 0;
    if (next) next.disabled = idx >= ids.length - 1;
    const fill = $("#progress-fill");
    if (fill && ids.length) {
      fill.style.width = ((idx + 1) / ids.length) * 100 + "%";
    }
    const stage = $("#stage");
    if (stage) {
      const tab = findTab(id);
      stage.setAttribute("aria-label", tab ? `第 ${idx + 1} 页 ${tab.title}` : "正文");
    }
    const allowScroll = !(opts && opts.scrollTab === false);
    if (allowScroll) {
      const tabBtn = document.querySelector(`.tab[data-tab="${CSS.escape(id)}"]`);
      if (tabBtn && tabBtn.scrollIntoView) {
        const behavior = opts && opts.smoothTab ? "smooth" : "auto";
        tabBtn.scrollIntoView({ inline: "center", block: "nearest", behavior });
      }
    }
  }

  function updatePagerChrome() {
    paintChrome(activeTab, { smoothTab: true });
  }

  function blockHtml(b) {
    const id = esc(b.id);
    switch (b.type) {
      case "callout":
        return `<div class="block callout ${esc(b.variant || "brand")}" data-block-id="${id}" data-type="callout">
          <div data-editable="true" data-field="html">${b.html || ""}</div>
        </div>`;
      case "kv-table": {
        const rawRows = b.rows || [];
        // 手机双列：按正文长度自动标 compact/wide；连续 compact 奇数个时末项升 wide，避免「钱」右侧空半格
        const spans = rawRows.map((r) => {
          const plain = String(r.html || "")
            .replace(/<[^>]+>/g, " ")
            .replace(/&[a-z]+;/gi, " ")
            .replace(/\s+/g, "");
          const keyLen = String(r.key || "").length;
          const len = plain.length + keyLen;
          const hasFlow = /flow-step|flow-arrow/.test(r.html || "");
          const multiClause = (plain.match(/[。；;·]/g) || []).length >= 3;
          // 阈值：约两列半宽可读；带流程箭头/多子句强制通栏
          if (hasFlow || multiClause || len >= 40) return "wide";
          return "compact";
        });
        for (let i = 0; i < spans.length; ) {
          if (spans[i] === "wide") {
            i += 1;
            continue;
          }
          let j = i;
          while (j < spans.length && spans[j] === "compact") j += 1;
          if ((j - i) % 2 === 1) spans[j - 1] = "wide";
          i = j;
        }
        const rows = rawRows
          .map((r, i) => {
            const v = r.variant || "default";
            const cls =
              (v === "ok" ? "row-ok" : v === "info" ? "row-info" : v === "warn" ? "row-warn" : "") +
              " kv-" +
              spans[i];
            const w = b.keyWidth === "wide" ? " wide" : "";
            // 内容包一层 .kv-cell：避免 td 的 flex 把 b/→ 拆成多个子项导致换行错位
            return `<tr class="${cls.trim()}" data-row="${i}" data-kv-span="${spans[i]}">
              <td class="label${w}" data-editable="true" data-field="key">${esc(r.key)}</td>
              <td class="kv-val"><div class="kv-cell" data-editable="true" data-field="html">${r.html || ""}</div></td>
            </tr>`;
          })
          .join("");
        return `<div class="block" data-block-id="${id}" data-type="kv-table"><table><tbody>${rows}</tbody></table></div>`;
      }
      case "gate-table": {
        const heads = (b.headers || ["门禁", "标准"])
          .map((h) => `<th>${esc(h)}</th>`)
          .join("");
        const rows = (b.rows || [])
          .map(
            (r, i) => `<tr data-row="${i}">
            <td class="label" data-editable="true" data-field="gate">${esc(r.gate)}</td>
            <td data-editable="true" data-field="html">${r.html || ""}</td>
          </tr>`
          )
          .join("");
        return `<div class="block" data-block-id="${id}" data-type="gate-table"><table><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table></div>`;
      }
      case "check-table": {
        const heads = (b.headers || ["#", "决策", "□"])
          .map((h) => `<th>${esc(h)}</th>`)
          .join("");
        const pathMeta = {
          A: { label: "A 同意启动", hint: "前置齐了再开发 · 按止损线花钱" },
          B: { label: "B 先认方向", hint: "费用批完再动手 · 不烧工具费" },
          C: { label: "C 不立", hint: "写进周报说明 · 不排期" },
        };
        const rows = (b.rows || [])
          .map((r, i) => {
            const on = !!r.checked;
            const extras = [];

            // #1 主开多选
            if (Array.isArray(r.multiOptions) && r.multiOptions.length) {
              const vals = Array.isArray(r.multiValues) ? r.multiValues : [];
              const chips = r.multiOptions
                .map((opt) => {
                  const key = typeof opt === "string" ? opt : opt.id;
                  const lab = typeof opt === "object" && opt.label ? opt.label : key;
                  const sel = vals.includes(key) ? " is-selected" : "";
                  return `<button type="button" class="path-chip multi-chip${sel}" data-multi-pick="${esc(key)}" data-block="${id}" data-row="${i}" aria-pressed="${vals.includes(key) ? "true" : "false"}">${esc(lab)}</button>`;
                })
                .join("");
              const needOther = vals.includes("other");
              extras.push(`<div class="multi-row" data-multi-row="${i}">
                <div class="path-chips multi-chips" role="group" aria-label="主开项目多选">${chips}</div>
                <label class="other-text-wrap${needOther ? "" : " is-hidden"}" data-other-wrap>
                  其他说明
                  <input type="text" data-other-text data-block="${id}" data-row="${i}" value="${esc(r.otherText || "")}" placeholder="写明其他要开的项目" ${needOther ? "" : "disabled"}/>
                </label>
                <div class="path-hint">可多选 · 至少选一项</div>
              </div>`);
            }

            // #2 路径 A/B/C
            if (Array.isArray(r.pathOptions) && r.pathOptions.length) {
              const pathVal = r.pathValue || "";
              const chips = r.pathOptions
                .map((p) => {
                  const key = typeof p === "string" ? p : p.value;
                  const meta = pathMeta[key] || { label: key, hint: "" };
                  const lab = typeof p === "object" && p.label ? p.label : meta.label;
                  const sel = pathVal === key ? " is-selected" : "";
                  const cls = "path-chip path-" + String(key).toLowerCase() + sel;
                  return `<button type="button" class="${cls}" data-path-pick="${esc(key)}" data-block="${id}" data-row="${i}" aria-pressed="${pathVal === key ? "true" : "false"}">${esc(lab)}</button>`;
                })
                .join("");
              const hint = pathVal && pathMeta[pathVal] ? pathMeta[pathVal].hint : "点选一项路径";
              extras.push(`<div class="path-row" data-path-row="${i}">
                <div class="path-chips" role="group" aria-label="${esc(r.projectLabel || "项目")}路径选择">${chips}</div>
                <div class="path-hint" data-path-hint>${esc(hint)}</div>
              </div>`);
            }

            // #3 费用可改填
            if (r.feeFields) {
              const f = r.feeFields;
              extras.push(`<div class="fee-fields" data-fee-row="${i}">
                <label class="fee-num"><span class="fee-lab">全期约</span><span class="fee-inp"><input type="text" inputmode="decimal" enterkeyhint="next" data-fee="total" data-block="${id}" data-row="${i}" value="${esc(f.total ?? "7000")}" placeholder="7000"/><i>元</i></span></label>
                <label class="fee-num"><span class="fee-lab">首月止损</span><span class="fee-inp"><input type="text" inputmode="decimal" enterkeyhint="next" data-fee="monthCap" data-block="${id}" data-row="${i}" value="${esc(f.monthCap ?? "5000")}" placeholder="5000"/><i>元</i></span></label>
                <label class="fee-num"><span class="fee-lab">全期止损</span><span class="fee-inp"><input type="text" inputmode="decimal" enterkeyhint="done" data-fee="allCap" data-block="${id}" data-row="${i}" value="${esc(f.allCap ?? "10000")}" placeholder="10000"/><i>元</i></span></label>
                <label class="fee-other">其他费用说明 <input type="text" enterkeyhint="done" data-fee="otherNote" data-block="${id}" data-row="${i}" value="${esc(f.otherNote || "")}" placeholder="如：加测账号 / 额外 OCR"/></label>
              </div>`);
            }

            // #4 最多 3 位负责人（手机默认只展 1 位）
            if (Array.isArray(r.owners) && r.owners.length) {
              const cards = r.owners
                .map((of, oi) => {
                  const ofx = of || {};
                  const moreCls = oi > 0 ? " owner-card-extra" : "";
                  return `<div class="owner-card${moreCls}" data-owner-idx="${oi}">
                    <div class="owner-card-title">负责人 ${oi + 1}</div>
                    <div class="owner-fields">
                      <label>姓名 <input type="text" data-owner-multi="name" data-owner-idx="${oi}" data-block="${id}" data-row="${i}" value="${esc(ofx.name || "")}" placeholder="${oi === 0 ? "至少填 1 位" : "选填"}" autocomplete="name" enterkeyhint="next"/></label>
                      <label>部门 <input type="text" data-owner-multi="dept" data-owner-idx="${oi}" data-block="${id}" data-row="${i}" value="${esc(ofx.dept || "")}" placeholder="如 客服部" enterkeyhint="next"/></label>
                      <label>负责 <input type="text" data-owner-multi="scope" data-owner-idx="${oi}" data-block="${id}" data-row="${i}" value="${esc(ofx.scope || "")}" placeholder="本项目范围" enterkeyhint="done"/></label>
                    </div>
                  </div>`;
                })
                .join("");
              const moreBtn =
                r.owners.length > 1
                  ? `<button type="button" class="owners-more-btn" data-owners-more data-block="${id}" data-row="${i}" aria-expanded="false">+ 再加负责人（最多 ${r.owners.length} 人）</button>`
                  : "";
              extras.push(`<div class="owners-grid" data-owners-row="${i}" data-owners-collapsed="true">${cards}${moreBtn}</div>`);
            } else if (r.ownerFields) {
              // 兼容旧单人结构
              const of = r.ownerFields;
              extras.push(`<div class="owner-fields" data-owner-row="${i}">
                <label>姓名 <input type="text" data-owner="name" data-block="${id}" data-row="${i}" value="${esc(of.name || "")}" placeholder="必填" autocomplete="name"/></label>
                <label>部门 <input type="text" data-owner="dept" data-block="${id}" data-row="${i}" value="${esc(of.dept || "")}" placeholder="如 客服部"/></label>
                <label>备用 <input type="text" data-owner="backup" data-block="${id}" data-row="${i}" value="${esc(of.backup || "")}" placeholder="可联系"/></label>
              </div>`);
            }

            const hasExtra = extras.length > 0;
            const tier = r.tier === "later" ? "later" : "must";
            const section =
              Array.isArray(r.pathOptions) || Array.isArray(r.multiOptions)
                ? "paths"
                : r.kind === "fee" || r.kind === "stop-authority"
                  ? "budget"
                  : r.kind === "owner" || r.ownerFields
                    ? "owners"
                    : "record";
            return `<tr data-row="${i}" data-tier="${tier}" data-check-section="${section}" class="chk-tier-${tier}${on ? " is-checked" : ""}${hasExtra ? " has-path" : ""}">
            <td class="label narrow" data-editable="true" data-field="no">${esc(r.no)}</td>
            <td class="chk-body">
              <div class="chk-html" data-editable="true" data-field="html">${r.html || ""}</div>
              ${extras.join("")}
            </td>
            <td class="chk">
              <button type="button" class="chk-btn${on ? " is-on" : ""}" data-check-toggle data-block="${id}" data-row="${i}" aria-pressed="${on ? "true" : "false"}" aria-label="勾选第 ${esc(r.no)} 项">
                <span class="chk-box" aria-hidden="true">${on ? "☑" : "☐"}</span>
              </button>
            </td>
          </tr>`;
          })
          .join("");
        const steps = [
          ["paths", "1 路径"],
          ["budget", "2 预算止损"],
          ["owners", "3 Owner"],
          ["record", "4 留痕"],
        ]
          .map(
            ([view, label], index) =>
              `<button type="button" class="check-step${index === 0 ? " is-active" : ""}" data-check-view-button="${view}" aria-pressed="${index === 0 ? "true" : "false"}">${label}</button>`
          )
          .join("");
        const status = checkStatusHtml(b);
        return `<div class="block" data-block-id="${id}" data-type="check-table" data-check-view="paths">
          <div class="check-steps" role="group" aria-label="当场确认步骤">${steps}</div>
          <table><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table>
          ${status}
        </div>`;
      }
      case "do-dont": {
        // 左不做 · 右做 · 双列自适应（非 mermaid，避免排版漂移）
        const dontItems = (b.dont || [])
          .map(
            (t, i) =>
              `<li class="dd-item dd-dont-item" data-editable="true" data-field="dont" data-idx="${i}">${esc(t)}</li>`
          )
          .join("");
        const doItems = (b.do || [])
          .map((t, i) => {
            const arrow =
              i < (b.do || []).length - 1
                ? `<div class="dd-arrow" aria-hidden="true"><span></span></div>`
                : "";
            return `<li class="dd-item dd-do-item" data-editable="true" data-field="do" data-idx="${i}">${esc(t)}</li>${arrow}`;
          })
          .join("");
        return `<div class="block do-dont" data-block-id="${id}" data-type="do-dont">
          ${b.label ? `<div class="mermaid-corner-label dd-label" data-editable="true" data-field="label">${esc(b.label)}</div>` : ""}
          <div class="dd-cols" role="group" aria-label="做与不做">
            <section class="dd-col dd-dont" aria-label="${esc(b.dontTitle || "不做")}">
              <h3 class="dd-title" data-editable="true" data-field="dontTitle">${esc(b.dontTitle || "不做")}</h3>
              <ul class="dd-list">${dontItems}</ul>
            </section>
            <section class="dd-col dd-do" aria-label="${esc(b.doTitle || "做")}">
              <h3 class="dd-title" data-editable="true" data-field="doTitle">${esc(b.doTitle || "做")}</h3>
              <ul class="dd-list dd-flow">${doItems}</ul>
            </section>
          </div>
        </div>`;
      }
      case "mermaid": {
        const compactItems = Array.isArray(b.compactItems)
          ? `<div class="mermaid-context-strip" role="list" aria-label="流程图可读缩略">
              ${b.compactItems
                .map(
                  (item) => `<div class="mermaid-context-item tone-${esc(item.tone || "info")}" role="listitem">
                    <b>${esc(item.label)}</b><span>${esc(item.text)}</span>
                  </div>`
                )
                .join("")}
              <span class="mermaid-context-hint">点按查看完整流程</span>
            </div>`
          : "";
        return `<div class="block" data-block-id="${id}" data-type="mermaid">
          ${b.label ? `<div class="mermaid-corner-label" data-editable="true" data-field="label">${esc(b.label)}</div>` : ""}
          ${compactItems}
          <div class="mermaid-host" data-mermaid-id="${id}"></div>
          <textarea class="mermaid-src" data-field="source" spellcheck="false">${esc(b.source || "")}</textarea>
        </div>`;
      }
      case "image":
        return `<div class="block" data-block-id="${id}" data-type="image" style="text-align:center">
          <img src="${esc(sanitizeAssetUrl(b.src, ""))}" alt="${esc(b.alt || "")}" style="max-width:100%;max-height:40vh;object-fit:contain" data-field="src"/>
        </div>`;
      case "detail-card": {
        // defaultOpen 缺省 false：取舍页默认收起，避免一进页就被表撑爆
        const open = b.defaultOpen === true;
        const h0 = (b.headers && b.headers[0]) || "部门";
        const h1 = (b.headers && b.headers[1]) || "为什么开";
        const h2 = (b.headers && b.headers[2]) || "为什么不开";
        const h3 = (b.headers && b.headers[3]) || "原因";
        const heads = [h0, h1, h2, h3].map((h) => `<th>${esc(h)}</th>`).join("");
        const rows = (b.rows || [])
          .map((r) => {
            // 部门 | 为什么开 | 为什么不开 | 原因
            if (r.sector != null && (r.whyOpen != null || r.need != null)) {
              const c2 = r.whyOpen != null ? r.whyOpen : r.need;
              const c3 = r.whyNot != null ? r.whyNot : r.direction;
              const c4 = r.reason != null ? r.reason : r.choice;
              return `<tr>
                <td data-label="${esc(h0)}" data-editable="true" data-field="sector"><b>${esc(r.sector)}</b></td>
                <td data-label="${esc(h1)}" data-editable="true" data-field="whyOpen">${esc(c2 || "")}</td>
                <td data-label="${esc(h2)}" data-editable="true" data-field="whyNot">${esc(c3 || "")}</td>
                <td data-label="${esc(h3)}" data-editable="true" data-field="reason">${esc(c4 || "")}</td>
              </tr>`;
            }
            return `<tr><td colspan="4">${esc(JSON.stringify(r))}</td></tr>`;
          })
          .join("");
        // 手机专用：各部门竖向卡片（与 table 同源，便于扫读/滚动）
        const deptCards = (b.rows || [])
          .map((r, i) => {
            if (r.sector == null) return "";
            const c2 = r.whyOpen != null ? r.whyOpen : r.need;
            const c3 = r.whyNot != null ? r.whyNot : r.direction;
            const c4 = r.reason != null ? r.reason : r.choice;
            return `<article class="dept-card" data-dept-idx="${i}">
              <h4 class="dept-card-name">${esc(r.sector)}</h4>
              <div class="dept-kv"><span class="dept-lab">${esc(h1)}</span><span class="dept-val" data-editable="true" data-field="whyOpen">${esc(c2 || "—")}</span></div>
              <div class="dept-kv"><span class="dept-lab">${esc(h2)}</span><span class="dept-val" data-editable="true" data-field="whyNot">${esc(c3 || "—")}</span></div>
              <div class="dept-kv is-reason"><span class="dept-lab">${esc(h3)}</span><span class="dept-val" data-editable="true" data-field="reason">${esc(c4 || "—")}</span></div>
            </article>`;
          })
          .join("");
        return `<div class="block detail-card ${open ? "is-open" : ""}" data-block-id="${id}" data-type="detail-card">
          <button type="button" class="detail-card-btn" data-detail-toggle="${id}" aria-expanded="${open ? "true" : "false"}">
            <span class="detail-card-btn-title">${esc(b.title || "明细")}</span>
            <span class="detail-card-btn-sub">${esc(b.subtitle || "点开查看")}</span>
            <span class="detail-card-chevron" aria-hidden="true"></span>
          </button>
          <div class="detail-card-body" id="detail-body-${id}" ${open ? "" : "hidden"}>
            <table class="detail-card-table">
              <thead><tr>${heads}</tr></thead>
              <tbody>${rows}</tbody>
            </table>
            <div class="dept-card-list" aria-label="各部门明细">${deptCards}</div>
          </div>
        </div>`;
      }
      default:
        return `<div class="block" data-block-id="${id}">未知类型 ${esc(b.type)}</div>`;
    }
  }

  function renderPanel(tab) {
    const layout = tab.layout || "stack";
    let body = "";
    const count = (tab.blocks || []).length;
    if (layout === "split") {
      const main = tab.blocks.filter((b) => (b.slot || "main") === "main");
      const side = tab.blocks.filter((b) => b.slot === "side");
      body = `<div class="panel-body layout-split" data-count="${count}" tabindex="0" aria-label="${esc(tab.title)}内容">
        <div class="slot-main">${main.map(blockHtml).join("")}</div>
        <div class="slot-side">${side.map(blockHtml).join("")}</div>
      </div>`;
    } else {
      body = `<div class="panel-body layout-${layout}" data-count="${count}" tabindex="0" aria-label="${esc(tab.title)}内容">${tab.blocks.map(blockHtml).join("")}</div>`;
    }
    return `<section class="panel${tab.id === activeTab ? " active" : ""}" id="${esc(tab.id)}" data-tab-panel="${esc(tab.id)}" role="tabpanel" aria-labelledby="tab-${esc(tab.id)}">
      <h2><span class="tag">${esc(tab.no || "")}</span><span data-editable="true" data-field="tab-title" data-tab-id="${esc(tab.id)}">${esc(tab.title)}</span></h2>
      ${body}
    </section>`;
  }

  function renderAll() {
    renderHeader();
    renderTabs();
    $("#stage").innerHTML = content.tabs.map(renderPanel).join("");
    mermaidRuntime.clear();
    applyEditMode();
    wireDetailCards();
    wireCheckTables();
    wireCheckViews();
    wireCopyConclusion();
    if (activeTab) queueMermaid(activeTab);
  }

  /** 勾选进度：散会最低要求提示（白话）+ 复制结论按钮；文案全在 DOM，不用 CSS ::after */
  function checkStatusHtml(block) {
    const g = evaluateCheckGate(block);
    let cls = "check-status";
    let msg = "";
    const bound = "边界：不立刻上线 · 不代回 · 不编假收益";
    if (g.done === 0) {
      cls += " is-idle";
      msg = `先为两个项目分别选 A / B / C · ${bound}`;
    } else if (g.allC && g.isMinOk) {
      cls += " is-ok";
      msg = "会后分别记录不立原因；全部 C 无需补费用与 Owner。";
    } else if (g.missing.length) {
      cls += " is-warn";
      msg = `散会前还缺：<b>${esc(g.missing.join(" · "))}</b> · ${bound}`;
    } else {
      cls += " is-ok";
      msg = "结论可复制或下载；贴入飞书/邮件确认后生效。边界：不立刻上线、不代回、不编收益。";
    }
    const copyLab = g.isMinOk ? "复制本场结论" : "复制当前状态";
    const hasAnyPath = g.decisions.some((decision) => decision.path);
    const pathBadge = hasAnyPath
      ? `<span class="check-path-badge">${esc(g.pathLab)}</span>`
      : `<span class="check-path-badge is-empty">两项目路径未选</span>`;
    const progBadge = `<span class="check-prog-badge">已确认 <b>${g.done}/${g.total}</b></span>`;
    let gateBadge;
    if (g.isMinOk) {
      gateBadge = `<span class="check-gate-badge is-ok">最低要求已齐</span>`;
    } else if (g.missing.length) {
      gateBadge = `<span class="check-gate-badge is-warn">还缺 ${esc(g.missing.join(" · "))}</span>`;
    } else {
      gateBadge = `<span class="check-gate-badge is-idle">先选路径 A / B / C</span>`;
    }
    return `<div class="${cls}" data-check-status role="status">
      <div class="check-status-dock">
        ${pathBadge}
        ${progBadge}
        ${gateBadge}
      </div>
      <div class="check-status-main">
        <div class="check-status-msg">${msg}</div>
        <div class="check-status-actions">
          <button type="button" class="reset-check-btn" data-reset-check="${esc(block.id)}" title="清空本机保存的会议勾选">清空本次</button>
          <button type="button" class="copy-conclusion-btn" data-copy-conclusion="${esc(block.id)}" title="复制到剪贴板，可贴周报/飞书">${copyLab}</button>
          <button type="button" class="download-receipt-btn" data-download-receipt="${esc(block.id)}" title="下载含 SHA-256 哈希的 JSON 会议凭证">下载凭证</button>
        </div>
      </div>
    </div>`;
  }

  function decisionReceiptContext(generatedAt) {
    return {
      generatedAt: generatedAt || new Date().toISOString(),
      contentVersion: content && content.version,
      decisionSchemaVersion: content && content.decisionSchemaVersion,
      sourceStamp: content && (content.publishStamp || content.ssot),
    };
  }

  function buildMeetingConclusion(block) {
    return buildMeetingConclusionText(block, decisionReceiptContext());
  }

  function downloadDecisionReceipt(block) {
    const receipt = buildDecisionReceipt(block, decisionReceiptContext());
    if (!verifyDecisionReceipt(receipt)) {
      throw new Error("会议凭证校验失败");
    }
    const blob = new Blob([JSON.stringify(receipt, null, 2) + "\n"], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const date = receipt.generatedAt.slice(0, 10).replace(/-/g, "");
    link.href = url;
    link.download = `AI立项会议凭证_${date}_${receipt.integrity.digest.slice(0, 12)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return receipt;
  }

  /** 同步优先 execCommand（保住 iOS user-gesture），再试 clipboard API */
  function copyTextToClipboard(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) return Promise.resolve(true);
    } catch (_) {}
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        () => true,
        () => false
      );
    }
    return Promise.resolve(false);
  }

  let copyConclusionWired = false;
  function wireCopyConclusion() {
    if (copyConclusionWired) return;
    copyConclusionWired = true;
    document.addEventListener("click", (e) => {
      const resetBtn = e.target.closest("[data-reset-check]");
      if (resetBtn) {
        e.preventDefault();
        e.stopPropagation();
        const block = findBlock(resetBtn.getAttribute("data-reset-check"));
        if (!block || !Array.isArray(block.rows)) return;
        if (!window.confirm("清空这台设备上的本次勾选、路径和负责人？")) return;
        block.rows.forEach((r) => {
          r.checked = false;
          if (Array.isArray(r.pathOptions)) r.pathValue = "";
          if (Array.isArray(r.multiOptions)) {
            r.multiValues = [];
            r.otherText = "";
          }
          if (Array.isArray(r.owners)) {
            r.owners = r.owners.map(() => ({ name: "", dept: "", scope: "" }));
          }
          if (r.ownerFields) {
            r.ownerFields = { name: "", dept: "", scope: "", backup: "" };
          }
        });
        saveDraft();
        renderAll();
        tapHaptic("light");
        toast("已清空本机的本次会议勾选");
        return;
      }
      const receiptBtn = e.target.closest("[data-download-receipt]");
      if (receiptBtn) {
        e.preventDefault();
        e.stopPropagation();
        const block = findBlock(receiptBtn.getAttribute("data-download-receipt"));
        if (!block) return;
        try {
          const receipt = downloadDecisionReceipt(block);
          tapHaptic(receipt.minimumReady ? "ok" : "light");
          toast(
            receipt.minimumReady
              ? "✅ 可校验会议凭证已下载"
              : "当前状态凭证已下载（最低要求未齐）",
            2400
          );
        } catch (error) {
          tapHaptic("warn");
          toast(error.message || "凭证下载失败", 2800);
        }
        return;
      }
      const btn = e.target.closest("[data-copy-conclusion]");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const blockId = btn.getAttribute("data-copy-conclusion");
      const block = findBlock(blockId);
      if (!block) return;
      const text = buildMeetingConclusion(block);
      // 同步发起复制，避免 await 丢掉 gesture
      Promise.resolve(copyTextToClipboard(text)).then((ok) => {
        if (ok) {
          const g = evaluateCheckGate(block);
          toast(g.isMinOk ? "✅ 本场结论已复制 · 可贴周报/飞书" : "已复制当前勾选（最低要求未齐）", 2400);
          tapHaptic("ok");
          btn.classList.add("is-copied");
          const prev = btn.textContent;
          btn.textContent = "已复制";
          setTimeout(() => {
            btn.textContent = prev;
            btn.classList.remove("is-copied");
          }, 1600);
        } else {
          tapHaptic("warn");
          toast("复制失败 · 请手动选中文字，或用 HTTPS/本机打开", 2800);
        }
      });
    });
  }

  function refreshCheckStatus(blockId) {
    const block = findBlock(blockId);
    const wrap = document.querySelector(`.block[data-block-id="${CSS.escape(blockId)}"]`);
    if (!block || !wrap) return;
    const old = wrap.querySelector("[data-check-status]");
    const tmp = document.createElement("div");
    tmp.innerHTML = checkStatusHtml(block);
    const neu = tmp.firstElementChild;
    if (old && neu) old.replaceWith(neu);
    else if (neu && !old) wrap.appendChild(neu);
  }

  function setRowCheckedUI(tr, checked) {
    if (!tr) return;
    tr.classList.toggle("is-checked", !!checked);
    const btn = tr.querySelector("[data-check-toggle]");
    if (!btn) return;
    btn.classList.toggle("is-on", !!checked);
    btn.setAttribute("aria-pressed", checked ? "true" : "false");
    const box = btn.querySelector(".chk-box");
    if (box) {
      box.textContent = checked ? "☑" : "☐";
      box.classList.remove("is-pop");
      void box.offsetWidth;
      box.classList.add("is-pop");
      setTimeout(() => box.classList.remove("is-pop"), 280);
    }
  }

  function pulseChips(el) {
    if (!el) return;
    el.classList.add("is-pulse");
    setTimeout(() => el.classList.remove("is-pulse"), 600);
  }

  function bindNoSwipe(inp) {
    inp.addEventListener("pointerdown", (e) => e.stopPropagation());
    inp.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    // 手机软键盘弹起时把输入框滚进可视区 + 行高亮
    inp.addEventListener("focus", () => {
      const tr = inp.closest("tr");
      if (tr) tr.classList.add("is-focus-row");
      setTimeout(() => {
        try {
          const r = inp.getBoundingClientRect();
          if (r.bottom > window.innerHeight * 0.52 || r.top < 72) {
            inp.scrollIntoView({ block: "center", behavior: "smooth" });
          }
        } catch (_) {}
      }, 300);
    });
    inp.addEventListener("blur", () => {
      const tr = inp.closest("tr");
      if (tr) tr.classList.remove("is-focus-row");
    });
  }

  function wireCheckTables() {
    // 勾选框：任何模式可点（会议现场用）
    const toggleCheckRow = (btn) => {
      const blockId = btn.dataset.block;
      const row = +btn.dataset.row;
      const block = findBlock(blockId);
      if (!block || !block.rows || !block.rows[row]) return;
      const r = block.rows[row];
      const tr = btn.closest("tr");
      if (Array.isArray(r.pathOptions) && r.pathOptions.length) {
        if (!r.pathValue) {
          toast("请先点选路径 A / B / C");
          tapHaptic("warn");
          pulseChips(tr && tr.querySelector(".path-chips:not(.multi-chips)"));
          return;
        }
        toast("改路径请点 A / B / C");
        tapHaptic("light");
        return;
      }
      if (Array.isArray(r.multiOptions) && r.multiOptions.length) {
        const vals = Array.isArray(r.multiValues) ? r.multiValues : [];
        if (!vals.length) {
          toast("请先多选主开项目（至少一项）");
          tapHaptic("warn");
          pulseChips(tr && tr.querySelector(".multi-chips"));
          return;
        }
        if (vals.includes("other") && !(r.otherText || "").trim()) {
          toast("选了「其他」，请填写说明");
          tapHaptic("warn");
          const ot = tr && tr.querySelector("[data-other-text]");
          if (ot) ot.focus();
          return;
        }
      }
      r.checked = !r.checked;
      setRowCheckedUI(tr, r.checked);
      if (tr) {
        tr.classList.remove("is-just-toggled");
        void tr.offsetWidth;
        tr.classList.add("is-just-toggled");
        setTimeout(() => tr.classList.remove("is-just-toggled"), 320);
      }
      tapHaptic(r.checked ? "ok" : "light");
      saveDraft();
      refreshCheckStatus(blockId);
    };

    $$("[data-check-toggle]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleCheckRow(btn);
      });
    });

    // 简勾行：整卡可点（手机 2 列热区）
    $$(".block[data-type='check-table'] tr:not(.has-path)").forEach((tr) => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest("button,input,textarea,label,a,[contenteditable=true]")) return;
        const btn = tr.querySelector("[data-check-toggle]");
        if (btn) toggleCheckRow(btn);
      });
    });

    // #1 主开多选
    $$("[data-multi-pick]").forEach((chip) => {
      chip.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const blockId = chip.dataset.block;
        const row = +chip.dataset.row;
        const val = chip.getAttribute("data-multi-pick");
        const block = findBlock(blockId);
        if (!block || !block.rows || !block.rows[row]) return;
        const r = block.rows[row];
        if (!Array.isArray(r.multiValues)) r.multiValues = [];
        const idx = r.multiValues.indexOf(val);
        if (idx >= 0) r.multiValues.splice(idx, 1);
        else r.multiValues.push(val);
        if (!r.multiValues.includes("other")) r.otherText = r.otherText || "";
        r.checked = r.multiValues.length > 0;
        const tr = chip.closest("tr");
        if (tr) {
          $$("[data-multi-pick]", tr).forEach((c) => {
            const on = r.multiValues.includes(c.getAttribute("data-multi-pick"));
            c.classList.toggle("is-selected", on);
            c.setAttribute("aria-pressed", on ? "true" : "false");
            if (on && c.getAttribute("data-multi-pick") === val) {
              c.classList.remove("is-pop");
              void c.offsetWidth;
              c.classList.add("is-pop");
              setTimeout(() => c.classList.remove("is-pop"), 280);
            }
          });
          const wrap = tr.querySelector("[data-other-wrap]");
          const ot = tr.querySelector("[data-other-text]");
          const needOther = r.multiValues.includes("other");
          if (wrap) wrap.classList.toggle("is-hidden", !needOther);
          if (ot) {
            ot.disabled = !needOther;
            if (!needOther) {
              ot.value = "";
              r.otherText = "";
            } else {
              ot.focus();
            }
          }
          setRowCheckedUI(tr, r.checked);
        }
        tapHaptic("light");
        saveDraft();
        refreshCheckStatus(blockId);
      });
    });

    // 路径 A/B/C
    $$("[data-path-pick]").forEach((chip) => {
      chip.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const blockId = chip.dataset.block;
        const row = +chip.dataset.row;
        const val = chip.getAttribute("data-path-pick");
        const block = findBlock(blockId);
        if (!block || !block.rows || !block.rows[row]) return;
        const r = block.rows[row];
        if (r.pathValue === val) {
          r.pathValue = "";
          r.checked = false;
        } else {
          r.pathValue = val;
          r.checked = true;
        }
        const tr = chip.closest("tr");
        if (tr) {
          $$("[data-path-pick]", tr).forEach((c) => {
            const on = c.getAttribute("data-path-pick") === r.pathValue;
            c.classList.toggle("is-selected", on);
            c.setAttribute("aria-pressed", on ? "true" : "false");
            if (on) {
              c.classList.remove("is-pop");
              void c.offsetWidth;
              c.classList.add("is-pop");
              setTimeout(() => c.classList.remove("is-pop"), 280);
            }
          });
          const hints = {
            A: "前置齐了再开发 · 按止损线花钱",
            B: "费用批完再动手 · 不烧工具费",
            C: "写进周报说明 · 不排期",
          };
          const hintEl = tr.querySelector("[data-path-hint]");
          if (hintEl) hintEl.textContent = r.pathValue ? hints[r.pathValue] || "" : "点选一项路径";
          setRowCheckedUI(tr, r.checked);
        }
        tapHaptic(r.pathValue ? "ok" : "light");
        saveDraft();
        refreshCheckStatus(blockId);
      });
    });

    // #1 其他说明
    $$("input[data-other-text]").forEach((inp) => {
      const commit = () => {
        const blockId = inp.dataset.block;
        const row = +inp.dataset.row;
        const block = findBlock(blockId);
        if (!block || !block.rows || !block.rows[row]) return;
        const r = block.rows[row];
        r.otherText = inp.value;
        if ((r.multiValues || []).includes("other") && inp.value.trim()) {
          r.checked = true;
          setRowCheckedUI(inp.closest("tr"), true);
        }
        saveDraft();
        refreshCheckStatus(blockId);
      };
      inp.addEventListener("input", commit);
      inp.addEventListener("change", commit);
      bindNoSwipe(inp);
    });

    // #3 费用字段
    $$("input[data-fee]").forEach((inp) => {
      const commit = () => {
        const blockId = inp.dataset.block;
        const row = +inp.dataset.row;
        const field = inp.dataset.fee;
        const block = findBlock(blockId);
        if (!block || !block.rows || !block.rows[row]) return;
        if (!block.rows[row].feeFields) block.rows[row].feeFields = {};
        block.rows[row].feeFields[field] = inp.value;
        // 改过金额或点过字段 → 视为同意该口径
        if (inp.value.trim()) {
          block.rows[row].checked = true;
          setRowCheckedUI(inp.closest("tr"), true);
        }
        saveDraft();
        refreshCheckStatus(blockId);
      };
      inp.addEventListener("input", commit);
      inp.addEventListener("change", commit);
      bindNoSwipe(inp);
    });

    // #4 多负责人
    $$("input[data-owner-multi]").forEach((inp) => {
      const commit = () => {
        const blockId = inp.dataset.block;
        const row = +inp.dataset.row;
        const oi = +inp.dataset.ownerIdx;
        const field = inp.dataset.ownerMulti;
        const block = findBlock(blockId);
        if (!block || !block.rows || !block.rows[row]) return;
        const r = block.rows[row];
        if (!Array.isArray(r.owners)) r.owners = [];
        if (!r.owners[oi]) r.owners[oi] = { name: "", dept: "", scope: "" };
        r.owners[oi][field] = inp.value;
        if (namedOwnersOf(r).length) {
          r.checked = true;
          setRowCheckedUI(inp.closest("tr"), true);
        }
        saveDraft();
        refreshCheckStatus(blockId);
      };
      inp.addEventListener("input", commit);
      inp.addEventListener("change", commit);
      bindNoSwipe(inp);
    });

    // 兼容旧单人 ownerFields
    $$("input[data-owner]").forEach((inp) => {
      const commit = () => {
        const blockId = inp.dataset.block;
        const row = +inp.dataset.row;
        const field = inp.dataset.owner;
        const block = findBlock(blockId);
        if (!block || !block.rows || !block.rows[row]) return;
        if (!block.rows[row].ownerFields) block.rows[row].ownerFields = {};
        block.rows[row].ownerFields[field] = inp.value;
        if (field === "name" && inp.value.trim()) {
          block.rows[row].checked = true;
          setRowCheckedUI(inp.closest("tr"), true);
        }
        saveDraft();
        refreshCheckStatus(blockId);
      };
      inp.addEventListener("input", commit);
      inp.addEventListener("change", commit);
      bindNoSwipe(inp);
    });

    // 手机：展开「会后约定」次要勾选项（带动画 class）
    $$("[data-later-toggle]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const wrap = btn.closest(".block[data-type='check-table']");
        if (!wrap) return;
        const open = wrap.getAttribute("data-later-open") === "true";
        const next = !open;
        wrap.setAttribute("data-later-open", next ? "true" : "false");
        wrap.classList.toggle("is-later-animating", true);
        btn.setAttribute("aria-expanded", next ? "true" : "false");
        const n = wrap.querySelectorAll("tr.chk-tier-later").length;
        btn.textContent = next ? "收起会后约定" : `展开会后约定（${n} 项，可后补）`;
        tapHaptic("light");
        setTimeout(() => wrap.classList.remove("is-later-animating"), 360);
      });
    });

    // 再加负责人（高度过渡）
    $$("[data-owners-more]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const grid = btn.closest(".owners-grid");
        if (!grid) return;
        const open = grid.getAttribute("data-owners-collapsed") === "false";
        const next = !open;
        grid.setAttribute("data-owners-collapsed", next ? "false" : "true");
        btn.setAttribute("aria-expanded", next ? "true" : "false");
        btn.textContent = next ? "收起额外负责人" : "+ 再加负责人（最多 3 人）";
        tapHaptic("light");
      });
    });
  }

  function wireCheckViews() {
    $$("[data-check-view-button]").forEach((button) => {
      button.addEventListener("click", () => {
        const wrap = button.closest("[data-type='check-table']");
        const view = button.getAttribute("data-check-view-button");
        if (!wrap || !view) return;
        wrap.setAttribute("data-check-view", view);
        $$("[data-check-view-button]", wrap).forEach((candidate) => {
          const on = candidate === button;
          candidate.classList.toggle("is-active", on);
          candidate.setAttribute("aria-pressed", on ? "true" : "false");
        });
        const firstControl = wrap.querySelector(
          `tr[data-check-section="${CSS.escape(view)}"] button, tr[data-check-section="${CSS.escape(view)}"] input`
        );
        if (firstControl) firstControl.focus({ preventScroll: true });
        tapHaptic("light");
      });
    });
  }

  function wireDetailCards() {
    $$("[data-detail-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (editing) return;
        const id = btn.getAttribute("data-detail-toggle");
        const card = btn.closest(".detail-card");
        const body = document.getElementById("detail-body-" + id);
        if (!card || !body) return;
        const open = !card.classList.contains("is-open");
        card.classList.toggle("is-open", open);
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        const pb = card.closest(".panel-body");
        if (pb) pb.classList.toggle("is-detail-open", open);
        // 手机：面板级标记，CSS 强压流程图 + 整页可滚
        const panel = card.closest(".panel");
        if (panel) panel.classList.toggle("is-dept-open", open);
        document.body.classList.toggle("is-t2-dept-open", open && activeTab === "t2");
        tapHaptic("light");

        if (open) {
          body.hidden = false;
          // 清掉可能残留的 max-height，避免被 50vh 卡住拖不动
          body.style.maxHeight = "";
          body.style.overflow = "";
          body.style.opacity = "1";
          body.style.transition = "";

          if (window.innerWidth <= 640) {
            // 展开不抢滚动位置；保留流程缩略图与详情标题作为上下文。
            requestAnimationFrame(() => {
              mermaidRuntime.clear();
              void queueMermaid(activeTab);
            });
          } else {
            // 桌面：短展开动画
            body.style.overflow = "hidden";
            body.style.maxHeight = "0px";
            body.style.opacity = "0";
            requestAnimationFrame(() => {
              const h = Math.min(body.scrollHeight, window.innerHeight * 0.62);
              body.style.transition =
                "max-height var(--ix-slow, 0.28s) var(--ix-ease, cubic-bezier(0.2,0.8,0.2,1)), opacity var(--ix-mid, 0.2s) ease";
              body.style.maxHeight = h + "px";
              body.style.opacity = "1";
              setTimeout(() => {
                body.style.maxHeight = "";
                body.style.overflow = "";
                body.style.transition = "";
                mermaidRuntime.clear();
                queueMermaid(activeTab);
              }, 300);
            });
          }
        } else {
          if (window.innerWidth <= 640) {
            body.hidden = true;
            body.style.maxHeight = "";
            body.style.opacity = "";
            body.style.overflow = "";
            body.style.transition = "";
            mermaidRuntime.clear();
            queueMermaid(activeTab);
          } else {
            body.style.overflow = "hidden";
            body.style.maxHeight = body.scrollHeight + "px";
            body.style.opacity = "1";
            requestAnimationFrame(() => {
              body.style.transition =
                "max-height var(--ix-slow, 0.28s) var(--ix-ease, cubic-bezier(0.2,0.8,0.2,1)), opacity var(--ix-mid, 0.2s) ease";
              body.style.maxHeight = "0px";
              body.style.opacity = "0";
              setTimeout(() => {
                body.hidden = true;
                body.style.maxHeight = "";
                body.style.opacity = "";
                body.style.overflow = "";
                body.style.transition = "";
                mermaidRuntime.clear();
                queueMermaid(activeTab);
              }, 280);
            });
          }
        }
      });
    });
  }

  function mergeCheckState(prev, next) {
    const result = mergeMeetingState(prev, next);
    if (result.outcome === "schema-mismatch") {
      toast("决策结构已升级，旧版会议勾选未带入", 2800);
    } else if (result.outcome === "aligned-with-drops") {
      toast("检测到内容结构更新，部分旧勾选已按新结构对齐", 2600);
    }
    return result.content;
  }

  function findBlock(id) {
    for (const t of content.tabs) {
      const b = t.blocks.find((x) => x.id === id);
      if (b) return b;
    }
    return null;
  }

  function findTab(id) {
    return content.tabs.find((t) => t.id === id);
  }

  /** 清掉滑页跟手/邻页预览的全部内联残留，避免叠影与半透明 ghost */
  function resetAllSwipeStyles() {
    document.body.classList.remove("is-swiping");
    $$(".panel").forEach((p) => {
      p.classList.remove("is-peek");
      p.style.transition = "none";
      p.style.transform = "";
      p.style.opacity = "";
      p.style.zIndex = "";
      p.style.position = "";
      p.style.left = "";
      p.style.right = "";
      p.style.top = "";
      p.style.bottom = "";
      p.style.margin = "";
      p.style.pointerEvents = "";
      p.style.willChange = "";
    });
    // 下一帧再放回 transition，避免 clear→set 同帧闪回
    requestAnimationFrame(() => {
      $$(".panel").forEach((p) => {
        if (p.style.transition === "none") p.style.transition = "";
      });
    });
  }

  async function activate(id, dir, opts) {
    if (!id || !findTab(id)) return;
    if (id === activeTab && !dir && !(opts && opts.force)) return;
    // 点 Tab 时打断未完成的滑页进位
    if (typeof cancelPendingGoSwipe === "function") cancelPendingGoSwipe(true);
    const ids = content.tabs.map((x) => x.id);
    const prevIdx = ids.indexOf(activeTab);
    const nextIdx = ids.indexOf(id);
    if (dir === "left" || dir === "right") swipeDir = dir;
    else if (prevIdx >= 0 && nextIdx >= 0) swipeDir = nextIdx >= prevIdx ? "left" : "right";

    activeTab = id;
    if (document.body.classList.contains("is-mobile")) tapHaptic("light");
    // 切页前强制清残留，防止上一页 transform/opacity 挂着
    resetAllSwipeStyles();
    // chrome 幂等（手势可能已 paintChrome 过）
    paintChrome(id, { smoothTab: !(opts && opts.fromSwipe) });
    $$(".panel").forEach((p) => {
      const on = p.id === id;
      p.classList.toggle("active", on);
      p.classList.remove("slide-left", "slide-right");
      // 手势跟手进位后不再播二次 panelIn，避免「残留滑一下」
      if (on && !(opts && opts.fromSwipe)) {
        p.classList.add(swipeDir === "left" ? "slide-left" : "slide-right");
      }
    });
    // 勾选页：标记 body，方便悬浮底栏；切走则清
    document.body.classList.toggle("is-check-page", id === "t6");
    // 离开取舍页时清掉部门展开态，避免样式串页
    if (id !== "t2") {
      document.body.classList.remove("is-t2-dept-open");
      $$("#t2.is-dept-open, #t2 .panel-body.is-detail-open, #t2 .detail-card.is-open").forEach((el) => {
        el.classList.remove("is-dept-open", "is-detail-open", "is-open");
      });
      $$("#t2 [data-detail-toggle]").forEach((b) => b.setAttribute("aria-expanded", "false"));
      $$("#t2 .detail-card-body").forEach((el) => {
        el.hidden = true;
      });
    }
    await queueMermaid(id);
  }

  function go(delta, opts) {
    const ids = content.tabs.map((x) => x.id);
    const cur = ids.indexOf(activeTab);
    const next = cur + delta;
    if (next < 0 || next >= ids.length) {
      toast(next < 0 ? "已是第一页" : "已是最后一页");
      tapHaptic("warn");
      paintChrome(activeTab);
      return;
    }
    activate(ids[next], delta > 0 ? "left" : "right", opts || null);
  }

  /** 供 wireSwipe 暴露：点 Tab 时硬取消进位（在 wireSwipe 内赋值） */
  let cancelPendingGoSwipe = null;

  // ---------- Edit mode ----------
  function applyEditMode() {
    document.body.classList.toggle("is-editing", editing);
    $$("[data-editable='true']").forEach((el) => {
      el.contentEditable = editing ? "true" : "false";
    });
    $("#btn-edit").classList.toggle("active", editing);
    $("#btn-edit").textContent = editing ? "退出编辑" : "编辑";
  }

  function toggleEdit() {
    if (editing) {
      // harvest before exit so mermaid re-render uses new source
      harvestDomToContent();
      saveDraft();
    }
    editing = !editing;
    applyEditMode();
    if (!editing) {
      mermaidRuntime.clear();
      queueMermaid(activeTab);
      toast("已退出编辑 · 记得点「保存到源码」");
    } else {
      toast("编辑中 · 改完点「保存到源码」写回 content.json");
    }
  }

  function harvestDomToContent() {
    // tab titles
    $$("[data-field='tab-title']").forEach((el) => {
      const tab = findTab(el.dataset.tabId);
      if (tab) tab.title = el.textContent.trim();
    });

    $$(".block[data-block-id]").forEach((wrap) => {
      const id = wrap.dataset.blockId;
      const type = wrap.dataset.type;
      const block = findBlock(id);
      if (!block) return;

      if (type === "callout") {
        const el = wrap.querySelector("[data-field='html']");
        if (el) block.html = sanitizeRichHtml(el.innerHTML);
      } else if (type === "kv-table") {
        $$("tbody tr", wrap).forEach((tr) => {
          const i = +tr.dataset.row;
          if (!block.rows[i]) return;
          const k = tr.querySelector("[data-field='key']");
          const h = tr.querySelector("[data-field='html']");
          if (k) block.rows[i].key = k.textContent.trim();
          if (h) block.rows[i].html = sanitizeRichHtml(h.innerHTML);
        });
      } else if (type === "gate-table") {
        $$("tbody tr", wrap).forEach((tr) => {
          const i = +tr.dataset.row;
          if (!block.rows[i]) return;
          const g = tr.querySelector("[data-field='gate']");
          const h = tr.querySelector("[data-field='html']");
          if (g) block.rows[i].gate = g.textContent.trim();
          if (h) block.rows[i].html = sanitizeRichHtml(h.innerHTML);
        });
      } else if (type === "check-table") {
        $$("tbody tr", wrap).forEach((tr) => {
          const i = +tr.dataset.row;
          if (!block.rows[i]) return;
          const n = tr.querySelector("[data-field='no']");
          const h = tr.querySelector("[data-field='html']");
          if (n) block.rows[i].no = n.textContent.trim();
          if (h) block.rows[i].html = sanitizeRichHtml(h.innerHTML);
          const btn = tr.querySelector("[data-check-toggle]");
          if (btn) block.rows[i].checked = btn.classList.contains("is-on");
          const sel = tr.querySelector("[data-path-pick].is-selected");
          if (sel) block.rows[i].pathValue = sel.getAttribute("data-path-pick") || "";
          // 主开多选
          const multiSel = $$("[data-multi-pick].is-selected", tr).map((c) =>
            c.getAttribute("data-multi-pick")
          );
          if (Array.isArray(block.rows[i].multiOptions)) {
            block.rows[i].multiValues = multiSel;
          }
          const ot = tr.querySelector("[data-other-text]");
          if (ot) block.rows[i].otherText = ot.value;
          // 费用
          if (block.rows[i].feeFields) {
            $$("input[data-fee]", tr).forEach((inp) => {
              block.rows[i].feeFields[inp.dataset.fee] = inp.value;
            });
          }
          // 多负责人
          if (Array.isArray(block.rows[i].owners)) {
            $$("input[data-owner-multi]", tr).forEach((inp) => {
              const oi = +inp.dataset.ownerIdx;
              if (!block.rows[i].owners[oi]) {
                block.rows[i].owners[oi] = { name: "", dept: "", scope: "" };
              }
              block.rows[i].owners[oi][inp.dataset.ownerMulti] = inp.value;
            });
          }
          if (block.rows[i].ownerFields) {
            $$("input[data-owner]", tr).forEach((inp) => {
              block.rows[i].ownerFields[inp.dataset.owner] = inp.value;
            });
          }
        });
      } else if (type === "do-dont") {
        const lab = wrap.querySelector("[data-field='label']");
        if (lab) block.label = lab.textContent.trim();
        const dt = wrap.querySelector("[data-field='dontTitle']");
        if (dt) block.dontTitle = dt.textContent.trim();
        const ot = wrap.querySelector("[data-field='doTitle']");
        if (ot) block.doTitle = ot.textContent.trim();
        const dont = [];
        $$("[data-field='dont']", wrap).forEach((el) => dont.push(el.textContent.trim()));
        if (dont.length) block.dont = dont;
        const dos = [];
        $$("[data-field='do']", wrap).forEach((el) => dos.push(el.textContent.trim()));
        if (dos.length) block.do = dos;
      } else if (type === "mermaid") {
        const ta = wrap.querySelector(".mermaid-src");
        if (ta) block.source = ta.value;
        const lab = wrap.querySelector("[data-field='label']");
        if (lab) block.label = lab.textContent.trim();
      } else if (type === "detail-card") {
        const title = wrap.querySelector(".detail-card-btn-title");
        if (title) block.title = title.textContent.trim();
        $$("tbody tr", wrap).forEach((tr, i) => {
          if (!block.rows || !block.rows[i]) return;
          const s = tr.querySelector("[data-field='sector']");
          const o = tr.querySelector("[data-field='whyOpen']");
          const n = tr.querySelector("[data-field='whyNot']");
          const r = tr.querySelector("[data-field='reason']");
          if (s) block.rows[i].sector = s.textContent.trim();
          if (o) block.rows[i].whyOpen = o.textContent.trim();
          if (n) block.rows[i].whyNot = n.textContent.trim();
          if (r) block.rows[i].reason = r.textContent.trim();
        });
      }
    });

    // header title/sub not fully harvested as structured; keep meta.title from h1 if edited
    const titleEl = $("#doc-title");
    if (titleEl && titleEl.isContentEditable) {
      content.meta.title = titleEl.textContent.trim();
    }
    content.updated = new Date().toISOString().slice(0, 10);
  }

  function saveDraft() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(content));
    } catch (_) {}
  }

  function downloadJson() {
    const blob = new Blob([JSON.stringify(content, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "content.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function bindFile() {
    if (!window.showOpenFilePicker) {
      toast("当前浏览器不支持直接写盘，请用「导出 JSON」覆盖 docs/data/content.json");
      return;
    }
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [
          {
            description: "content.json",
            accept: { "application/json": [".json"] },
          },
        ],
        multiple: false,
      });
      fileHandle = handle;
      await saveHandle(handle);
      setStatus("已绑定源码文件", "ok");
      toast("已绑定 · 之后点保存将直接写入该文件");
    } catch (e) {
      if (e.name !== "AbortError") toast("绑定失败: " + e.message);
    }
  }

  async function writeToHandle(handle, text) {
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") throw new Error("未授权写文件");
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  async function saveToSource() {
    const btn = $("#btn-save");
    if (btn) btn.classList.add("is-saving");

    try {
      // 1) 从页面收割 → 内存 SSOT
      harvestDomToContent();
      content.updated = new Date().toISOString().slice(0, 10);
      content.publishStamp = String(Date.now());
      if (!content.version) content.version = "5.6.1";

      const text = JSON.stringify(content, null, 2);
      let persisted = false;
      let persistHint = "";

      // 2) 尽量一次写盘（已绑定 → 直接写；未绑定 → 首次弹出保存位置）
      if (!fileHandle) fileHandle = await loadHandle();

      if (fileHandle) {
        try {
          await writeToHandle(fileHandle, text);
          persisted = true;
          persistHint = "已写入源码文件";
        } catch (e) {
          fileHandle = null;
        }
      }

      if (!persisted && window.showSaveFilePicker) {
        try {
          // 首次引导：一键选中 docs/data/content.json，之后无感
          const handle = await window.showSaveFilePicker({
            suggestedName: "content.json",
            types: [
              {
                description: "JSON",
                accept: { "application/json": [".json"] },
              },
            ],
          });
          fileHandle = handle;
          await saveHandle(handle);
          await writeToHandle(handle, text);
          persisted = true;
          persistHint = "已绑定并写入 content.json";
        } catch (e) {
          if (e.name === "AbortError") {
            // 用户取消写盘，仍做内存热更新
            persistHint = "未写文件，仅本页已更新";
          }
        }
      }

      if (!persisted && !persistHint) {
        // 兜底：下载 + 本页仍热更新
        downloadJson();
        persistHint = "已下载 content.json，请放回 docs/data/ 后 git push";
      }

      // 3) 清草稿 + 无感刷新本页（C端同页立即看到结果，不整页 reload）
      try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
      softApplyContent(content, "save");

      if (persisted) {
        if (editing) {
          editing = false;
          applyEditMode();
        }
        setStatus("已更新", "ok");
        toast("✅ 已保存并更新 · 推送后客户约 30 秒内自动同步", 2600);
      } else {
        // 写盘未成功：页面已热更新预览，保留编辑态可再点保存（乐观 UI + 可回滚重试）
        if (!editing) {
          editing = true;
          applyEditMode();
        }
        setStatus("预览已更新", "warn");
        toast("本页已更新（预览）· " + (persistHint || "请再点保存写入文件"), 2800);
      }
    } finally {
      if (btn) btn.classList.remove("is-saving");
    }
  }

  // logo replace
  function wireLogo() {
    $("#logo-file").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        content.meta.logoDataUrl = reader.result;
        $("#logo-img").src = reader.result;
        saveDraft();
        toast("Logo 已替换（保存在 json · 建议另存为 assets/logo.png）");
      };
      reader.readAsDataURL(f);
    });
    $(".logo-edit-hint").addEventListener("click", () => {
      if (editing) $("#logo-file").click();
    });
  }

  // keyboard
  function wireKeys() {
    document.addEventListener("keydown", (e) => {
      if (e.target.matches("input, textarea") || e.target.isContentEditable) {
        if (isEditQuery && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          saveToSource();
        }
        return;
      }
      const ids = content.tabs.map((t) => t.id);
      const cur = ids.indexOf(activeTab);
      if (e.key >= "1" && e.key <= "7") {
        const t = ids[Number(e.key) - 1];
        if (t) activate(t);
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        go(1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        go(-1);
      } else if (e.key === "Home") {
        activate(ids[0], "right");
      } else if (e.key === "End") {
        activate(ids[ids.length - 1], "left");
      } else if (isEditQuery && e.key.toLowerCase() === "e") {
        toggleEdit();
      } else if (isEditQuery && e.key.toLowerCase() === "s" && !e.metaKey && !e.ctrlKey) {
        saveToSource();
      }
    });
  }

  function wireToolbar() {
    const exportFn = () => {
      if (editing) harvestDomToContent();
      downloadJson();
      toast("已导出 content.json");
    };
    const reloadFn = async () => {
      localStorage.removeItem(STORAGE_KEY);
      await loadContent({ preferDraft: false });
      softApplyContent(content, "reload");
      toast("已同步最新内容");
    };
    $("#btn-edit").addEventListener("click", toggleEdit);
    $("#btn-save").addEventListener("click", saveToSource);
    $("#btn-bind") && $("#btn-bind").addEventListener("click", bindFile);
    $("#btn-export") && $("#btn-export").addEventListener("click", exportFn);
    $("#btn-reload") && $("#btn-reload").addEventListener("click", reloadFn);
    $("#btn-bind-m") && $("#btn-bind-m").addEventListener("click", () => { closeMore(); bindFile(); });
    $("#btn-export-m") && $("#btn-export-m").addEventListener("click", () => { closeMore(); exportFn(); });
    $("#btn-reload-m") && $("#btn-reload-m").addEventListener("click", () => { closeMore(); reloadFn(); });

    const moreBtn = $("#btn-more");
    const menu = $("#toolbar-menu");
    if (moreBtn && menu) {
      moreBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (menu.classList.contains("open")) closeMore();
        else openMore();
      });
      // 点菜单本体不关闭；点遮罩/页面其它处关闭
      menu.addEventListener("click", (e) => e.stopPropagation());
      document.addEventListener("click", () => closeMore());
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeMore();
      });
      window.addEventListener("resize", () => {
        if (menu.classList.contains("open")) positionMoreMenu();
      });
      window.addEventListener("scroll", () => {
        if (menu.classList.contains("open")) positionMoreMenu();
      }, true);
    }
    $("#nav-prev") && $("#nav-prev").addEventListener("click", () => go(-1));
    $("#nav-next") && $("#nav-next").addEventListener("click", () => go(1));
  }

  /** 三点菜单：fixed 悬浮，避开 chrome overflow 裁切与标题叠层 */
  function positionMoreMenu() {
    const moreBtn = $("#btn-more");
    const menu = $("#toolbar-menu");
    if (!moreBtn || !menu || !menu.classList.contains("open")) return;
    // 先显示才能量宽
    menu.style.visibility = "hidden";
    menu.style.display = "flex";
    const r = moreBtn.getBoundingClientRect();
    const mw = Math.max(menu.offsetWidth || 0, 168);
    const mh = menu.offsetHeight || 160;
    const gap = 8;
    let left = r.right - mw;
    left = Math.max(gap, Math.min(left, window.innerWidth - mw - gap));
    let top = r.bottom + 6;
    // 下方不够则往上翻
    if (top + mh > window.innerHeight - gap && r.top - 6 - mh > gap) {
      top = r.top - 6 - mh;
    }
    top = Math.max(gap, Math.min(top, window.innerHeight - mh - gap));
    menu.style.position = "fixed";
    menu.style.top = Math.round(top) + "px";
    menu.style.left = Math.round(left) + "px";
    menu.style.right = "auto";
    menu.style.bottom = "auto";
    menu.style.zIndex = "300";
    menu.style.visibility = "";
  }

  function openMore() {
    const menu = $("#toolbar-menu");
    const moreBtn = $("#btn-more");
    if (!menu || !moreBtn) return;
    menu.classList.add("open");
    document.body.classList.add("is-more-open");
    moreBtn.setAttribute("aria-expanded", "true");
    positionMoreMenu();
    // 下一帧再量一次（字体/布局稳定）
    requestAnimationFrame(() => positionMoreMenu());
  }

  function closeMore() {
    const menu = $("#toolbar-menu");
    const moreBtn = $("#btn-more");
    if (menu) {
      menu.classList.remove("open");
      menu.style.top = "";
      menu.style.left = "";
      menu.style.right = "";
      menu.style.bottom = "";
      menu.style.position = "";
      menu.style.zIndex = "";
      menu.style.visibility = "";
      menu.style.display = "";
    }
    if (moreBtn) moreBtn.setAttribute("aria-expanded", "false");
    document.body.classList.remove("is-more-open");
  }

  /** 触屏左右滑翻页：中央带 + 过阈乐观 Tab + 竖滚优先 + 单链（touch 主 / pointer 仅 mouse） */
  function wireSwipe() {
    const stage = $("#stage");
    if (!stage || wireSwipe._on) return;
    wireSwipe._on = true;
    let startX = 0,
      startY = 0,
      startT = 0,
      tracking = false,
      axis = null,
      dragging = false,
      peekEl = null,
      pendingGoTimer = null,
      pendingDir = 0,
      chromeOptimisticId = null;

    /** hard=true：连同未完成的进位动画一起清干净，并回滚乐观 chrome */
    const cancelPendingGo = (hard) => {
      if (pendingGoTimer) {
        clearTimeout(pendingGoTimer);
        pendingGoTimer = null;
      }
      if (hard) {
        pendingDir = 0;
        peekEl = null;
        if (chromeOptimisticId && chromeOptimisticId !== activeTab) {
          paintChrome(activeTab);
        }
        chromeOptimisticId = null;
        resetAllSwipeStyles();
      }
    };
    cancelPendingGoSwipe = cancelPendingGo;

    // 仅控件吞手势；卡片空白区可滑（方案 skip 最终表）
    const skipSel = "a,button,input,textarea,select,label,[contenteditable=true]";

    const activePanel = () => document.querySelector(".panel.active:not(.is-peek)");

    const inSwipeBand = (clientY) => {
      const rect = stage.getBoundingClientRect();
      const H = rect.height || window.innerHeight;
      const y = clientY - rect.top;
      let safeTop = 0,
        safeBot = 0;
      try {
        const cs = getComputedStyle(document.documentElement);
        // env() 读不到时退回 0
        safeTop = parseFloat(cs.getPropertyValue("--safe-t")) || 0;
        safeBot = parseFloat(cs.getPropertyValue("--safe-b")) || 0;
      } catch (_) {}
      const topEx = Math.max(0.16 * H, safeTop + 8);
      const botEx = Math.max(0.16 * H, safeBot + 24);
      return y >= topEx && y <= H - botEx;
    };

    const clearPeek = () => {
      $$(".panel.is-peek").forEach((p) => {
        p.classList.remove("is-peek");
        p.style.transition = "none";
        p.style.transform = "";
        p.style.opacity = "";
        p.style.zIndex = "";
        p.style.position = "";
        p.style.pointerEvents = "";
      });
      peekEl = null;
    };

    // 翻页专用 ease-out（禁止 spring 过冲）；时长跟 velocity
    const reduceMotion = () =>
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const swipeTransition = (ms) =>
      "transform " + ms + "ms cubic-bezier(0.25, 0.1, 0.25, 1)";

    const clearDrag = (panel, animate) => {
      clearPeek();
      document.body.classList.remove("is-swiping");
      if (chromeOptimisticId && chromeOptimisticId !== activeTab) {
        paintChrome(activeTab, { scrollTab: true });
      }
      chromeOptimisticId = null;
      pendingDir = 0;
      if (!panel) {
        resetAllSwipeStyles();
        return;
      }
      if (animate && !reduceMotion()) {
        const dur = 200;
        panel.style.transition = swipeTransition(dur);
        panel.style.transform = "translateX(0)";
        panel.style.opacity = "1";
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          panel.removeEventListener("transitionend", onEndTr);
          resetAllSwipeStyles();
        };
        const onEndTr = (e) => {
          if (e.propertyName === "transform") finish();
        };
        panel.addEventListener("transitionend", onEndTr);
        setTimeout(finish, dur + 60);
      } else {
        resetAllSwipeStyles();
      }
    };

    const passThreshold = (dx, dt, w) => {
      const abs = Math.abs(dx);
      const v = abs / Math.max(dt, 1); // px/ms
      return abs >= 36 || (abs >= 22 && dt < 240) || abs / w >= 0.14 || v >= 0.42;
    };

    const commitDuration = (dx, dt, w) => {
      if (reduceMotion()) return 0;
      const rem = Math.max(24, w - Math.abs(dx));
      const v = Math.max(0.25, Math.abs(dx) / Math.max(dt, 1));
      // 快甩更短、慢拖更长，钳在 140–240
      return Math.round(Math.min(240, Math.max(140, rem / v)));
    };

    const applyDrag = (dx) => {
      const panel = activePanel();
      if (!panel || !content) return;
      const ids = content.tabs.map((t) => t.id);
      const idx = ids.indexOf(activeTab);
      const w = stage.clientWidth || window.innerWidth;
      let tx = dx;
      // 边缘 rubber：更轻，保持实体不透明
      if ((idx <= 0 && dx > 0) || (idx >= ids.length - 1 && dx < 0)) tx = dx * 0.28;

      panel.style.transition = "none";
      panel.style.transform = "translateX(" + tx + "px)";
      panel.style.opacity = "1"; // 禁止鬼影衰减 — 实体页感
      panel.style.zIndex = "3";

      // 过阈乐观 chrome（拖拽中不 scroll Tab，避免 jank）
      const dt = Date.now() - startT;
      if (passThreshold(dx, dt, w)) {
        const dir = dx < 0 ? 1 : -1;
        const next = idx + dir;
        if (next >= 0 && next < ids.length) {
          const nid = ids[next];
          if (chromeOptimisticId !== nid) {
            chromeOptimisticId = nid;
            paintChrome(nid, { scrollTab: false });
            tapHaptic("light");
          }
        }
      } else if (chromeOptimisticId && chromeOptimisticId !== activeTab) {
        chromeOptimisticId = null;
        paintChrome(activeTab, { scrollTab: false });
      }

      // 邻页预览：全不透明 + translate 露边
      let peekId = null;
      if (dx < -10 && idx < ids.length - 1) peekId = ids[idx + 1];
      else if (dx > 10 && idx > 0) peekId = ids[idx - 1];

      if (!peekId) {
        if (peekEl) clearPeek();
        return;
      }
      const peek = document.getElementById(peekId);
      if (!peek) return;
      if (peekEl && peekEl !== peek) clearPeek();
      peekEl = peek;
      peek.classList.add("is-peek");
      peek.style.transition = "none";
      peek.style.zIndex = "2";
      peek.style.opacity = "1";
      if (dx < 0) peek.style.transform = "translateX(" + (w + tx) + "px)";
      else peek.style.transform = "translateX(" + (-w + tx) + "px)";
    };

    const onStart = (x, y) => {
      if (editing || document.body.classList.contains("is-lightbox")) return;
      if (!inSwipeBand(y)) return;
      cancelPendingGo(true);
      startX = x;
      startY = y;
      startT = Date.now();
      tracking = true;
      axis = null;
      dragging = false;
      chromeOptimisticId = null;
      pendingDir = 0;
    };

    const onMove = (x, y, e) => {
      if (!tracking || editing) return;
      const dx = x - startX;
      const dy = y - startY;
      if (!axis) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        // 先竖：整段手势不翻页
        if (Math.abs(dy) > 6 && Math.abs(dy) >= Math.abs(dx)) {
          axis = "v";
          return;
        }
        // 认横：滞回 1.15
        if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.15) axis = "h";
        else return;
      }
      if (axis !== "h") return;
      if (e && e.cancelable) e.preventDefault();
      dragging = true;
      document.body.classList.add("is-swiping");
      applyDrag(dx);
    };

    const onEnd = (x, y) => {
      if (!tracking || editing) {
        tracking = false;
        return;
      }
      tracking = false;
      const panel = activePanel();
      const dx = x - startX;
      const dy = y - startY;
      const dt = Date.now() - startT;
      const wasH = axis === "h" && dragging;
      axis = null;
      dragging = false;
      if (!wasH) {
        clearDrag(panel, false);
        return;
      }
      const w = stage.clientWidth || window.innerWidth;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      const pass = passThreshold(dx, dt, w) && absX >= absY * 0.95;
      if (!pass) {
        clearDrag(panel, true);
        return;
      }
      const dir = dx < 0 ? 1 : -1;
      const ids = content.tabs.map((t) => t.id);
      const idx = ids.indexOf(activeTab);
      const next = idx + dir;
      if (next < 0 || next >= ids.length) {
        clearDrag(panel, true);
        toast(next < 0 ? "已是第一页" : "已是最后一页");
        return;
      }
      // 确认 chrome（可能已乐观切过）
      const nextId = ids[next];
      paintChrome(nextId, { scrollTab: true });
      chromeOptimisticId = nextId;
      pendingDir = dir;
      document.body.classList.add("is-swiping");

      const finishCommit = () => {
        if (pendingGoTimer) {
          clearTimeout(pendingGoTimer);
          pendingGoTimer = null;
        }
        const d = pendingDir;
        pendingDir = 0;
        chromeOptimisticId = null;
        // 先无动画落位再切 active，避免 transform 清空时「弹回」一帧
        $$(".panel").forEach((p) => {
          p.style.transition = "none";
          p.classList.remove("is-peek", "slide-left", "slide-right");
          p.style.transform = "";
          p.style.opacity = "";
          p.style.zIndex = "";
          p.style.position = "";
          p.style.pointerEvents = "";
          p.style.left = "";
          p.style.right = "";
          p.style.top = "";
          p.style.bottom = "";
          p.style.margin = "";
          p.style.willChange = "";
          p.classList.toggle("active", p.id === nextId);
        });
        peekEl = null;
        document.body.classList.remove("is-swiping");
        go(d, { fromSwipe: true });
      };

      // reduced-motion 或 duration=0：瞬时切
      const dur = commitDuration(dx, dt, w);
      if (dur === 0 || reduceMotion()) {
        finishCommit();
        return;
      }

      if (panel) {
        panel.style.transition = swipeTransition(dur);
        panel.style.transform = "translateX(" + (dir > 0 ? -w : w) + "px)";
        panel.style.opacity = "1";
        panel.style.zIndex = "3";
      }
      if (peekEl) {
        peekEl.style.transition = swipeTransition(dur);
        peekEl.style.transform = "translateX(0)";
        peekEl.style.opacity = "1";
        peekEl.style.zIndex = "4";
      }
      cancelPendingGo(false);
      let committed = false;
      const runOnce = () => {
        if (committed) return;
        committed = true;
        if (panel) panel.removeEventListener("transitionend", onTr);
        finishCommit();
      };
      const onTr = (e) => {
        if (e.target === panel && e.propertyName === "transform") runOnce();
      };
      if (panel) panel.addEventListener("transitionend", onTr);
      // 兜底：防止 transitionend 丢失
      pendingGoTimer = setTimeout(runOnce, dur + 50);
    };

    // —— touch 主链 ——
    stage.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) return;
        if (e.target.closest(skipSel)) return;
        onStart(e.touches[0].clientX, e.touches[0].clientY);
      },
      { passive: true }
    );
    stage.addEventListener(
      "touchmove",
      (e) => {
        if (!tracking || e.touches.length !== 1) return;
        onMove(e.touches[0].clientX, e.touches[0].clientY, e);
      },
      { passive: false }
    );
    stage.addEventListener(
      "touchend",
      (e) => {
        const t = e.changedTouches[0];
        if (t) onEnd(t.clientX, t.clientY);
      },
      { passive: true }
    );
    stage.addEventListener("touchcancel", () => {
      cancelPendingGo(true);
      tracking = false;
      axis = null;
      dragging = false;
      clearDrag(activePanel(), false);
    });

    // —— pointer 仅 mouse，禁与 touch 双 fire ——
    let mouseDown = false;
    stage.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch" || e.pointerType === "pen") return;
      if (e.button !== 0) return;
      if (e.target.closest(skipSel)) return;
      mouseDown = true;
      onStart(e.clientX, e.clientY);
    });
    stage.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch" || e.pointerType === "pen") return;
      if (!mouseDown) return;
      onMove(e.clientX, e.clientY, null);
    });
    stage.addEventListener("pointerup", (e) => {
      if (e.pointerType === "touch" || e.pointerType === "pen") return;
      if (!mouseDown) return;
      mouseDown = false;
      onEnd(e.clientX, e.clientY);
    });
    stage.addEventListener("pointercancel", (e) => {
      if (e.pointerType === "touch" || e.pointerType === "pen") return;
      cancelPendingGo(true);
      mouseDown = false;
      tracking = false;
      axis = null;
      dragging = false;
      clearDrag(activePanel(), false);
    });
  }
  // ---------- boot ----------
  function applyMobileClasses() {
    const w = window.innerWidth || 0;
    const h = window.innerHeight || 0;
    document.body.classList.toggle("is-mobile", w <= 640);
    // 手机竖屏一律短屏策略：决策页优先，次要文案折叠
    document.body.classList.toggle("is-short", w <= 640 || (h > 0 && h < 780));
    document.body.classList.toggle("is-tiny", h > 0 && h < 700);
  }

  /** 轻触反馈：iOS 上 :active 不可靠，用 pressed 类 + 可选震动 */
  function wirePressFeedback() {
    if (wirePressFeedback._on) return;
    wirePressFeedback._on = true;
    const sel =
      "button, .tab, .path-chip, .multi-chip, .chk-btn, .copy-conclusion-btn, .chk-later-toggle, .owners-more-btn, .detail-card-btn";
    const down = (e) => {
      const el = e.target.closest(sel);
      if (!el || el.disabled) return;
      el.classList.add("is-pressed");
    };
    const up = () => {
      $$(".is-pressed").forEach((el) => el.classList.remove("is-pressed"));
    };
    document.addEventListener("touchstart", down, { passive: true });
    document.addEventListener("touchend", up, { passive: true });
    document.addEventListener("touchcancel", up, { passive: true });
    document.addEventListener("mousedown", down);
    document.addEventListener("mouseup", up);
    document.addEventListener("mouseleave", up);
  }

  function tapHaptic(kind) {
    let vibrated = false;
    try {
      if (navigator.vibrate) {
        if (kind === "ok") vibrated = navigator.vibrate(12);
        else if (kind === "warn") vibrated = navigator.vibrate([8, 30, 8]);
        else vibrated = navigator.vibrate(8);
      }
    } catch (_) {
      vibrated = false;
    }
    // 无震动权限时：全屏极短闪一下，补交互闭环
    if (!vibrated) {
      document.body.classList.remove("ix-haptic-flash", "ix-haptic-ok", "ix-haptic-warn");
      void document.body.offsetWidth;
      document.body.classList.add("ix-haptic-flash");
      if (kind === "ok") document.body.classList.add("ix-haptic-ok");
      if (kind === "warn") document.body.classList.add("ix-haptic-warn");
      setTimeout(() => {
        document.body.classList.remove("ix-haptic-flash", "ix-haptic-ok", "ix-haptic-warn");
      }, 160);
    }
  }

  async function boot() {
    applyMobileClasses();
    window.addEventListener("resize", applyMobileClasses);
    window.addEventListener("orientationchange", () => setTimeout(applyMobileClasses, 200));
    wirePressFeedback();
    const offlineNotice = $("#offline-notice");
    if (offlineNotice) offlineNotice.hidden = !isFileProtocol;

    try {
      // C端默认拉最新；仅 ?edit=1 优先草稿
      await loadContent({ preferDraft: isEditQuery });
      renderAll();
      wireToolbar();
      wireLogo();
      wireKeys();
      wireSwipe();
      wireMermaidLightbox();
      window.addEventListener("ai-brief:mermaid-ready", () => {
        mermaidRuntime.clear();
        void queueMermaid(activeTab);
      });
      window.addEventListener("beforeprint", () => {
        // beforeprint 不等待 Promise；先同步写入可读文字摘要，图形随后尽力替换。
        prepareAllMermaidFallbacks();
        void queueAllMermaid();
      });
      document.body.classList.toggle("is-check-page", activeTab === "t6");
      // title editable only in edit mode
      $("#doc-title").dataset.editable = "true";
      document.documentElement.dataset.appState = "ready";
      window.dispatchEvent(new CustomEvent("ai-brief:booted", { detail: { state: "ready" } }));
      // 文件句柄、热轮询和图表预热都在首屏 ready 之后进行。
      void loadHandle().then((handle) => {
        fileHandle = handle;
        if (fileHandle && isEditQuery) setStatus("可一键保存", "ok");
      });
      if (!isFileProtocol) startHotPoll();
    } catch (e) {
      let nextReleaseId = "";
      if (!isFileProtocol) {
        try {
          const manifest = await contentLoader.fetchManifest({ allowReleaseMismatch: true });
          if (shellReleaseId && manifest.releaseId !== shellReleaseId) {
            nextReleaseId = manifest.releaseId;
          }
        } catch (_) {}
      }
      showLoadFailure(e, { releaseId: nextReleaseId });
      setStatus("加载失败", "warn");
      document.documentElement.dataset.appState = nextReleaseId ? "refreshing" : "error";
      window.dispatchEvent(new CustomEvent("ai-brief:booted", { detail: { state: "error" } }));
      if (nextReleaseId) requestReleaseRefresh(nextReleaseId);
    }
  }

  boot();
})();
