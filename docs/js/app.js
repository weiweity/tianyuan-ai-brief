/**
 * app.js — 渲染 + 编辑 + 写回 content.json
 * 禁止在此文件写业务文案。内容只来自 data/content.json。
 */
(function () {
  "use strict";

  const STORAGE_KEY = "tianyuan-brief-draft-v1";
  const HANDLE_DB = "tianyuan-brief-fs";
  const HANDLE_STORE = "handles";

  let content = null;
  let activeTab = "t1";
  let editing = false;
  let fileHandle = null;
  let mermaidReady = false;
  const renderedMermaid = new Set();
  let swipeDir = "left"; // panel animation direction
  let contentFingerprint = "";
  let hotPollTimer = null;
  const POLL_MS = 30000; // C端静默检查远端内容
  const isEditQuery = /(?:\?|&)edit=1(?:&|$)/.test(location.search);


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

  // ---------- File handle (IndexedDB) ----------
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(HANDLE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(HANDLE_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function saveHandle(handle) {
    try {
      const db = await idbOpen();
      await new Promise((res, rej) => {
        const tx = db.transaction(HANDLE_STORE, "readwrite");
        tx.objectStore(HANDLE_STORE).put(handle, "contentJson");
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    } catch (_) { /* ignore */ }
  }
  async function loadHandle() {
    try {
      const db = await idbOpen();
      return await new Promise((res, rej) => {
        const tx = db.transaction(HANDLE_STORE, "readonly");
        const r = tx.objectStore(HANDLE_STORE).get("contentJson");
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => rej(r.error);
      });
    } catch (_) {
      return null;
    }
  }

  // ---------- Load content ----------
  function fingerprintOf(obj) {
    if (!obj) return "";
    return [obj.version || "", obj.updated || "", obj.publishStamp || "", (obj.tabs || []).length].join("|");
  }

  async function fetchRemoteContent() {
    const url = "./data/content.json?_=" + Date.now();
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("无法加载 data/content.json（请用 http 服务打开，不要 file://）");
    return res.json();
  }

  async function loadContent(opts) {
    const preferDraft = opts && opts.preferDraft;
    // C端默认不读草稿，保证打开即最新；编辑态/ ?edit=1 才恢复草稿
    if (preferDraft || isEditQuery || editing) {
      try {
        const draft = localStorage.getItem(STORAGE_KEY);
        if (draft) {
          const parsed = JSON.parse(draft);
          if (parsed && parsed.tabs) {
            content = parsed;
            contentFingerprint = fingerprintOf(content);
            setStatus("草稿(本机)", "warn");
            return { from: "draft" };
          }
        }
      } catch (_) {}
    }

    content = await fetchRemoteContent();
    contentFingerprint = fingerprintOf(content);
    setStatus("已是最新", "ok");
    return { from: "remote" };
  }

  /** 无感应用新内容：保留当前 Tab，轻闪刷新，不整页跳转 */
  function softApplyContent(next, reason) {
    if (!next || !next.tabs) return;
    const keep = activeTab;
    content = next;
    contentFingerprint = fingerprintOf(content);
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
    renderedMermaid.clear();
    renderAll();
    setStatus(reason === "save" ? "已更新" : "已同步最新", "ok");
  }

  let pollFailCount = 0;
  async function checkRemoteUpdate(silent) {
    if (editing) return;
    try {
      const remote = await fetchRemoteContent();
      pollFailCount = 0;
      const fp = fingerprintOf(remote);
      if (!fp || fp === contentFingerprint) return;
      // C端：静默热更新（无感）
      if (silent) {
        softApplyContent(remote, "poll");
        toast("内容已自动更新", 1600);
      } else {
        const chip = $("#update-chip");
        if (chip) {
          chip.hidden = false;
          chip.classList.add("show");
          chip.onclick = () => {
            softApplyContent(remote, "poll");
            chip.classList.remove("show");
            chip.hidden = true;
            toast("已刷新到最新", 1400);
          };
        } else {
          softApplyContent(remote, "poll");
        }
      }
    } catch (_) {
      pollFailCount += 1;
      // 连续失败 3 次再提示，避免弱网刷屏
      if (pollFailCount === 3) {
        setStatus("离线/弱网", "warn");
        toast("网络不稳，将在恢复后自动同步", 2000);
      }
    }
  }

  function startHotPoll() {
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

  function renderHeader() {
    const m = content.meta;
    const logo = m.logoDataUrl || m.logo || "assets/logo.png";
    $("#logo-img").src = logo;
    $("#logo-img").alt = m.from || "logo";
    $("#doc-title").textContent = m.title || "";
    $("#doc-sub").innerHTML = `<b>${esc(m.from || "")}</b> → <b>${esc(m.to || "")}</b> · ${esc(m.subtitle || "")}`;
    $("#doc-role").textContent = m.roleLine || "";
    $("#footer-left").textContent = m.footerLeft || "";
    $("#footer-right").innerHTML = m.footerRight || "左右滑翻页 · 1–7 / ←→";
    if (m.brand) document.documentElement.style.setProperty("--brand", m.brand);
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

  function updatePagerChrome() {
    const ids = content.tabs.map((x) => x.id);
    const idx = Math.max(0, ids.indexOf(activeTab));
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
      const tab = findTab(activeTab);
      stage.setAttribute("aria-label", tab ? `第 ${idx + 1} 页 ${tab.title}` : "正文");
    }
    const tabBtn = document.querySelector(`.tab[data-tab="${activeTab}"]`);
    if (tabBtn && tabBtn.scrollIntoView) {
      tabBtn.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    }
  }

  function blockHtml(b) {
    const id = esc(b.id);
    switch (b.type) {
      case "callout":
        return `<div class="block callout ${esc(b.variant || "brand")}" data-block-id="${id}" data-type="callout">
          <div data-editable="true" data-field="html">${b.html || ""}</div>
        </div>`;
      case "kv-table": {
        const rows = (b.rows || [])
          .map((r, i) => {
            const v = r.variant || "default";
            const cls = v === "ok" ? "row-ok" : v === "info" ? "row-info" : v === "warn" ? "row-warn" : "";
            const w = b.keyWidth === "wide" ? " wide" : "";
            return `<tr class="${cls}" data-row="${i}">
              <td class="label${w}" data-editable="true" data-field="key">${esc(r.key)}</td>
              <td data-editable="true" data-field="html">${r.html || ""}</td>
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
        const rows = (b.rows || [])
          .map(
            (r, i) => `<tr data-row="${i}">
            <td class="label narrow" data-editable="true" data-field="no">${esc(r.no)}</td>
            <td data-editable="true" data-field="html">${r.html || ""}</td>
            <td class="chk">☐</td>
          </tr>`
          )
          .join("");
        return `<div class="block" data-block-id="${id}" data-type="check-table"><table><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table></div>`;
      }
      case "mermaid":
        return `<div class="block" data-block-id="${id}" data-type="mermaid">
          <div class="mermaid-host" data-mermaid-id="${id}"></div>
          <textarea class="mermaid-src" data-field="source" spellcheck="false">${esc(b.source || "")}</textarea>
        </div>`;
      case "image":
        return `<div class="block" data-block-id="${id}" data-type="image" style="text-align:center">
          <img src="${esc(b.src)}" alt="${esc(b.alt || "")}" style="max-width:100%;max-height:40vh;object-fit:contain" data-field="src"/>
        </div>`;
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
      body = `<div class="panel-body layout-split" data-count="${count}">
        <div class="slot-main">${main.map(blockHtml).join("")}</div>
        <div class="slot-side">${side.map(blockHtml).join("")}</div>
      </div>`;
    } else {
      body = `<div class="panel-body layout-${layout}" data-count="${count}">${tab.blocks.map(blockHtml).join("")}</div>`;
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
    renderedMermaid.clear();
    applyEditMode();
    if (activeTab) queueMermaid(activeTab);
  }

  async function ensureMermaid() {
    if (mermaidReady) return;
    if (!window.mermaid) throw new Error("mermaid 未加载");
    window.mermaid.initialize({
      startOnLoad: false,
      theme: "base",
      securityLevel: "loose",
      flowchart: {
        curve: "basis",
        htmlLabels: true,
        useMaxWidth: true,
        padding: 6,
        nodeSpacing: 24,
        rankSpacing: 28,
      },
      themeVariables: {
        fontFamily: "-apple-system, PingFang SC, Microsoft YaHei, sans-serif",
        fontSize: "13px",
        primaryColor: "#EBE6EF",
        primaryTextColor: "#2A1A38",
        primaryBorderColor: "#7A4F96",
        lineColor: "#7A4F96",
        secondaryColor: "#F5F0F8",
        tertiaryColor: "#FFFFFF",
        clusterBkg: "#F8F5FA",
        clusterBorder: "#C9B8D9",
      },
    });
    mermaidReady = true;
  }

  async function queueMermaid(tabId) {
    if (editing) return;
    await ensureMermaid();
    const panel = document.getElementById(tabId);
    if (!panel) return;
    const hosts = $$(".mermaid-host", panel);
    for (const host of hosts) {
      const id = host.dataset.mermaidId;
      if (renderedMermaid.has(id)) continue;
      const block = findBlock(id);
      if (!block || !block.source) {
        host.innerHTML = '<div class="mermaid-empty">暂无流程图 · 编辑态可粘贴 mermaid</div>';
        continue;
      }
      host.innerHTML = "";
      try {
        const { svg } = await window.mermaid.render(
          "mmd-" + id.replace(/\W/g, "_") + "-" + Date.now(),
          block.source
        );
        host.innerHTML = svg;
        const svgEl = host.querySelector("svg");
        if (svgEl) {
          svgEl.setAttribute("role", "img");
          const label = (block.source || "").replace(/\s+/g, " ").trim().slice(0, 48);
          svgEl.setAttribute("aria-label", "流程图: " + (label || id));
          // 隐藏文本副本供读屏
          let desc = host.querySelector(".mermaid-a11y");
          if (!desc) {
            desc = document.createElement("span");
            desc.className = "mermaid-a11y";
            desc.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)";
            host.style.position = "relative";
            host.appendChild(desc);
          }
          desc.id = "mmd-desc-" + id.replace(/\W/g, "_");
          desc.textContent = block.source || "";
          svgEl.setAttribute("aria-describedby", desc.id);
        }
        renderedMermaid.add(id);
      } catch (e) {
        host.innerHTML = `<pre style="color:#b00;font-size:11px;padding:8px;white-space:pre-wrap">Mermaid 错误: ${esc(e.message || e)}</pre>`;
      }
    }
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

  async function activate(id, dir) {
    if (!id || !findTab(id)) return;
    const ids = content.tabs.map((x) => x.id);
    const prevIdx = ids.indexOf(activeTab);
    const nextIdx = ids.indexOf(id);
    if (dir === "left" || dir === "right") swipeDir = dir;
    else if (prevIdx >= 0 && nextIdx >= 0) swipeDir = nextIdx >= prevIdx ? "left" : "right";

    activeTab = id;
    $$(".tab").forEach((t) => {
      const on = t.dataset.tab === id;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
    });
    $$("#pager-dots button").forEach((b) => b.classList.toggle("active", b.dataset.tab === id));
    $$(".panel").forEach((p) => {
      const on = p.id === id;
      p.classList.toggle("active", on);
      p.classList.remove("slide-left", "slide-right");
      if (on) p.classList.add(swipeDir === "left" ? "slide-left" : "slide-right");
    });
    updatePagerChrome();
    await queueMermaid(id);
  }

  function go(delta) {
    const ids = content.tabs.map((x) => x.id);
    const cur = ids.indexOf(activeTab);
    const next = cur + delta;
    if (next < 0 || next >= ids.length) {
      toast(next < 0 ? "已是第一页" : "已是最后一页");
      return;
    }
    activate(ids[next], delta > 0 ? "left" : "right");
  }

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
      renderedMermaid.clear();
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
        if (el) block.html = el.innerHTML;
      } else if (type === "kv-table") {
        $$("tbody tr", wrap).forEach((tr) => {
          const i = +tr.dataset.row;
          if (!block.rows[i]) return;
          const k = tr.querySelector("[data-field='key']");
          const h = tr.querySelector("[data-field='html']");
          if (k) block.rows[i].key = k.textContent.trim();
          if (h) block.rows[i].html = h.innerHTML;
        });
      } else if (type === "gate-table") {
        $$("tbody tr", wrap).forEach((tr) => {
          const i = +tr.dataset.row;
          if (!block.rows[i]) return;
          const g = tr.querySelector("[data-field='gate']");
          const h = tr.querySelector("[data-field='html']");
          if (g) block.rows[i].gate = g.textContent.trim();
          if (h) block.rows[i].html = h.innerHTML;
        });
      } else if (type === "check-table") {
        $$("tbody tr", wrap).forEach((tr) => {
          const i = +tr.dataset.row;
          if (!block.rows[i]) return;
          const n = tr.querySelector("[data-field='no']");
          const h = tr.querySelector("[data-field='html']");
          if (n) block.rows[i].no = n.textContent.trim();
          if (h) block.rows[i].html = h.innerHTML;
        });
      } else if (type === "mermaid") {
        const ta = wrap.querySelector(".mermaid-src");
        if (ta) block.source = ta.value;
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
      contentFingerprint = fingerprintOf(content);

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
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
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
      } else if (e.key.toLowerCase() === "e") {
        toggleEdit();
      } else if (e.key.toLowerCase() === "s" && !e.metaKey && !e.ctrlKey) {
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
        e.stopPropagation();
        const open = menu.classList.toggle("open");
        moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
      });
      document.addEventListener("click", () => closeMore());
    }
    $("#nav-prev") && $("#nav-prev").addEventListener("click", () => go(-1));
    $("#nav-next") && $("#nav-next").addEventListener("click", () => go(1));
  }

  function closeMore() {
    const menu = $("#toolbar-menu");
    const moreBtn = $("#btn-more");
    if (menu) menu.classList.remove("open");
    if (moreBtn) moreBtn.setAttribute("aria-expanded", "false");
  }

  /** 触屏左右滑翻页：水平位移主导且超过阈值才触发，避免干扰正文竖滑 */
  function wireSwipe() {
    const stage = $("#stage");
    if (!stage) return;
    let startX = 0, startY = 0, startT = 0, tracking = false;

    const onStart = (x, y) => {
      if (editing) return;
      startX = x;
      startY = y;
      startT = Date.now();
      tracking = true;
    };
    const onEnd = (x, y) => {
      if (!tracking || editing) return;
      tracking = false;
      document.body.classList.remove("is-swiping");
      const dx = x - startX;
      const dy = y - startY;
      const dt = Date.now() - startT;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      // 水平主导、距离够、时间不太长
      if (absX < 48) return;
      if (absX < absY * 1.15) return; // 竖滑优先
      if (dt > 800) return;
      if (dx < 0) go(1); // 左滑 → 下一页
      else go(-1); // 右滑 → 上一页
    };

    stage.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) return;
        onStart(e.touches[0].clientX, e.touches[0].clientY);
      },
      { passive: true }
    );
    stage.addEventListener(
      "touchmove",
      (e) => {
        if (!tracking || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
          document.body.classList.add("is-swiping");
        }
      },
      { passive: true }
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
      tracking = false;
      document.body.classList.remove("is-swiping");
    });

    // 触控板/鼠标拖拽（可选）
    let mouseDown = false;
    stage.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target.closest("a,button,input,textarea,[contenteditable=true]")) return;
      mouseDown = true;
      onStart(e.clientX, e.clientY);
    });
    stage.addEventListener("pointerup", (e) => {
      if (!mouseDown) return;
      mouseDown = false;
      onEnd(e.clientX, e.clientY);
    });
  }

  // ---------- boot ----------
  async function boot() {
    try {
      // C端默认拉最新；仅 ?edit=1 优先草稿
      await loadContent({ preferDraft: isEditQuery });
      fileHandle = await loadHandle();
      if (fileHandle) setStatus("可一键保存", "ok");
      renderAll();
      wireToolbar();
      wireLogo();
      wireKeys();
      wireSwipe();
      startHotPoll();
      // title editable only in edit mode
      $("#doc-title").dataset.editable = "true";
    } catch (e) {
      $("#stage").innerHTML = `<div style="padding:24px;color:#b00">
        <h2>加载失败</h2>
        <p>${esc(e.message || e)}</p>
        <p style="margin-top:8px;color:#666">请在仓库根执行：<code>python3 -m http.server 8080 -d docs</code><br/>
        然后打开 <code>http://localhost:8080</code></p>
      </div>`;
      setStatus("加载失败", "warn");
    }
  }

  boot();
})();
