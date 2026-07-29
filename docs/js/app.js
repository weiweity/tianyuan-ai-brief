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
  async function loadContent() {
    // 1) draft
    try {
      const draft = localStorage.getItem(STORAGE_KEY);
      if (draft) {
        const parsed = JSON.parse(draft);
        if (parsed && parsed.tabs) {
          content = parsed;
          setStatus("草稿(本机)", "warn");
          return;
        }
      }
    } catch (_) {}

    // 2) fetch SSOT
    const res = await fetch("./data/content.json", { cache: "no-store" });
    if (!res.ok) throw new Error("无法加载 data/content.json（请用 http 服务打开，不要 file://）");
    content = await res.json();
    setStatus("源码 content.json", "ok");
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
    $("#footer-right").innerHTML = m.footerRight || "";
    if (m.brand) document.documentElement.style.setProperty("--brand", m.brand);
  }

  function renderTabs() {
    const nav = $("#tabs");
    nav.innerHTML = content.tabs
      .map(
        (t) =>
          `<button type="button" class="tab${t.id === activeTab ? " active" : ""}" data-tab="${esc(t.id)}">` +
          `<span class="n">${esc(t.no || "")}</span>${esc(t.title)}</button>`
      )
      .join("");
    nav.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => activate(btn.dataset.tab));
    });
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
    if (layout === "split") {
      const main = tab.blocks.filter((b) => (b.slot || "main") === "main");
      const side = tab.blocks.filter((b) => b.slot === "side");
      body = `<div class="panel-body layout-split">
        <div class="slot-main">${main.map(blockHtml).join("")}</div>
        <div class="slot-side">${side.map(blockHtml).join("")}</div>
      </div>`;
    } else {
      body = `<div class="panel-body layout-${layout}">${tab.blocks.map(blockHtml).join("")}</div>`;
    }
    return `<section class="panel${tab.id === activeTab ? " active" : ""}" id="${esc(tab.id)}" data-tab-panel="${esc(tab.id)}">
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
      if (!block || !block.source) continue;
      host.innerHTML = "";
      try {
        const { svg } = await window.mermaid.render(
          "mmd-" + id.replace(/\W/g, "_") + "-" + Date.now(),
          block.source
        );
        host.innerHTML = svg;
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

  async function activate(id) {
    activeTab = id;
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === id));
    $$(".panel").forEach((p) => p.classList.toggle("active", p.id === id));
    await queueMermaid(id);
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
    if (editing) harvestDomToContent();
    else harvestDomToContent();
    saveDraft();

    const text = JSON.stringify(content, null, 2);

    // try bound handle
    if (!fileHandle) fileHandle = await loadHandle();
    if (fileHandle) {
      try {
        await writeToHandle(fileHandle, text);
        localStorage.removeItem(STORAGE_KEY);
        setStatus("已写回源码", "ok");
        toast("✅ 已写入绑定的 content.json（真源码）");
        return;
      } catch (e) {
        toast("写盘失败，改为下载: " + (e.message || e));
      }
    }

    // File System Access save picker
    if (window.showSaveFilePicker) {
      try {
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
        localStorage.removeItem(STORAGE_KEY);
        setStatus("已写回源码", "ok");
        toast("✅ 已保存 content.json · 请放回 docs/data/ 并 git push");
        return;
      } catch (e) {
        if (e.name === "AbortError") return;
      }
    }

    downloadJson();
    setStatus("已导出下载", "warn");
    toast("已下载 content.json · 请覆盖 docs/data/content.json 后 git push");
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
        activate(ids[Math.min(ids.length - 1, cur + 1)]);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        activate(ids[Math.max(0, cur - 1)]);
      } else if (e.key.toLowerCase() === "e") {
        toggleEdit();
      } else if (e.key.toLowerCase() === "s" && !e.metaKey && !e.ctrlKey) {
        saveToSource();
      }
    });
  }

  function wireToolbar() {
    $("#btn-edit").addEventListener("click", toggleEdit);
    $("#btn-save").addEventListener("click", saveToSource);
    $("#btn-bind").addEventListener("click", bindFile);
    $("#btn-export").addEventListener("click", () => {
      if (editing) harvestDomToContent();
      downloadJson();
      toast("已导出 content.json");
    });
    $("#btn-reload").addEventListener("click", async () => {
      localStorage.removeItem(STORAGE_KEY);
      await loadContent();
      renderAll();
      toast("已从 content.json 重新加载（草稿已清）");
    });
  }

  // ---------- boot ----------
  async function boot() {
    try {
      await loadContent();
      fileHandle = await loadHandle();
      if (fileHandle) setStatus("已绑定源码(待验证)", "ok");
      renderAll();
      wireToolbar();
      wireLogo();
      wireKeys();
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
