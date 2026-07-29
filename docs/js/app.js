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
  /**
   * 内容指纹：只用「作者态」字段，不含会议勾选/路径/费用手填，
   * 避免本机勾选污染指纹导致 30s 轮询假热更。
   */
  function fingerprintOf(obj) {
    if (!obj) return "";
    try {
      const parts = [
        obj.version || "",
        obj.updated || "",
        obj.publishStamp || "",
        obj.ssot || "",
        String((obj.tabs || []).length),
      ];
      let struct = "";
      (obj.tabs || []).forEach((t) => {
        struct += (t.id || "") + ":" + (t.title || "") + ";";
        (t.blocks || []).forEach((b) => {
          struct += (b.id || "") + "|" + (b.type || "") + "|";
          if (b.html) struct += "h" + b.html.length + ";";
          if (b.source) struct += "s" + b.source.length + ";";
          (b.rows || []).forEach((r) => {
            struct +=
              (r.rowId || r.no || "") +
              ":" +
              (r.html || "").length +
              ":" +
              (r.gate || r.key || "").length +
              ";";
          });
        });
      });
      // djb2 of structure (not meeting state)
      let h = 5381;
      for (let i = 0; i < struct.length; i++) h = ((h << 5) + h) ^ struct.charCodeAt(i);
      parts.push(String(struct.length), (h >>> 0).toString(36));
      return parts.join("|");
    } catch (_) {
      return [obj.version || "", obj.updated || "", obj.publishStamp || "", (obj.tabs || []).length].join("|");
    }
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
    // 会议中途刷新：远程文案 + 本机勾选合并（不整份草稿覆盖）
    try {
      const draft = localStorage.getItem(STORAGE_KEY);
      if (draft) {
        const parsed = JSON.parse(draft);
        if (parsed && parsed.tabs) {
          content = mergeCheckState(parsed, content);
        }
      }
    } catch (_) {}
    contentFingerprint = fingerprintOf(content);
    setStatus("已是最新", "ok");
    return { from: "remote" };
  }

  /** 无感应用新内容：保留当前 Tab，轻闪刷新，不整页跳转 */
  function softApplyContent(next, reason) {
    if (!next || !next.tabs) return;
    const keep = activeTab;
    // poll/reload 时合并本机勾选，避免会议中途被远端文案覆盖掉勾
    if (reason === "poll" || reason === "reload") {
      next = mergeCheckState(content, next);
    }
    content = next;
    contentFingerprint = fingerprintOf(content);
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
    renderedMermaid.clear();
    renderAll();
    document.body.classList.toggle("is-check-page", activeTab === "t6");
    syncCheckStatusFloat();
    setStatus(reason === "save" ? "已更新" : "已同步最新", "ok");
  }

  let pollFailCount = 0;
  const MSG = {
    hotOk: "内容已自动更新",
    hotClick: "已刷新到最新",
    netWarn: "网络不稳，恢复后将自动同步",
    netStatus: "离线/弱网",
    netBack: "网络已恢复",
    latest: "已是最新",
  };
  async function checkRemoteUpdate(silent) {
    if (editing) return;
    try {
      const remote = await fetchRemoteContent();
      const wasFailing = pollFailCount >= 3;
      pollFailCount = 0;
      if (wasFailing) {
        setStatus(MSG.latest, "ok");
        toast(MSG.netBack, 1400);
      }
      const fp = fingerprintOf(remote);
      if (!fp || fp === contentFingerprint) return;
      // C端：静默热更新（无感）
      if (silent) {
        softApplyContent(remote, "poll");
        toast(MSG.hotOk, 1600);
      } else {
        const chip = $("#update-chip");
        if (chip) {
          chip.hidden = false;
          chip.classList.add("show");
          chip.onclick = () => {
            softApplyContent(remote, "poll");
            chip.classList.remove("show");
            chip.hidden = true;
            toast(MSG.hotClick, 1400);
          };
        } else {
          softApplyContent(remote, "poll");
          toast(MSG.hotOk, 1600);
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
    const m = content.meta || {};
    const logo = m.logoDataUrl || m.logo || "assets/logo.png";
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
      fr.innerHTML = m.footerRight || "";
      fr.hidden = !(m.footerRight || "").trim();
    }
    // 两侧都空则藏整条 stage-meta 里的 footer 区（保留页码提示）
    const meta = document.querySelector(".stage-meta");
    if (meta) {
      const hasFoot = (m.footerLeft || "").trim() || (m.footerRight || "").trim();
      const foot = meta.querySelector(".footer");
      if (foot) foot.hidden = !hasFoot;
    }
    if (m.brand) document.documentElement.style.setProperty("--brand", m.brand);
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
            // 内容包一层 .kv-cell：避免 td 的 flex 把 b/→ 拆成多个子项导致换行错位
            return `<tr class="${cls}" data-row="${i}">
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
                <div class="path-chips" role="group" aria-label="路径选择">${chips}</div>
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
                      <label>负责 <input type="text" data-owner-multi="scope" data-owner-idx="${oi}" data-block="${id}" data-row="${i}" value="${esc(ofx.scope || "")}" placeholder="如 客服 Agent" enterkeyhint="done"/></label>
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
            return `<tr data-row="${i}" data-tier="${tier}" class="chk-tier-${tier}${on ? " is-checked" : ""}${hasExtra ? " has-path" : ""}">
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
        const laterCount = (b.rows || []).filter((r) => r.tier === "later").length;
        const laterToggle =
          laterCount > 0
            ? `<button type="button" class="chk-later-toggle" data-later-toggle data-block="${id}" aria-expanded="false">展开会后约定（${laterCount} 项，可后补）</button>`
            : "";
        const status = checkStatusHtml(b);
        return `<div class="block" data-block-id="${id}" data-type="check-table" data-later-open="false">
          <table><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table>
          ${laterToggle}
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
      case "mermaid":
        return `<div class="block" data-block-id="${id}" data-type="mermaid">
          ${b.label ? `<div class="mermaid-corner-label" data-editable="true" data-field="label">${esc(b.label)}</div>` : ""}
          <div class="mermaid-host" data-mermaid-id="${id}"></div>
          <textarea class="mermaid-src" data-field="source" spellcheck="false">${esc(b.source || "")}</textarea>
        </div>`;
      case "image":
        return `<div class="block" data-block-id="${id}" data-type="image" style="text-align:center">
          <img src="${esc(b.src)}" alt="${esc(b.alt || "")}" style="max-width:100%;max-height:40vh;object-fit:contain" data-field="src"/>
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
    wireDetailCards();
    wireCheckTables();
    wireCopyConclusion();
    if (activeTab) queueMermaid(activeTab);
  }

  function stripHtmlText(html) {
    const d = document.createElement("div");
    d.innerHTML = html || "";
    return (d.textContent || "").replace(/\s+/g, " ").trim();
  }

  const PATH_LABELS = {
    A: "A 同意启动",
    B: "B 先认方向",
    C: "C 不立",
  };

  function multiLabelsOf(row) {
    const opts = row.multiOptions || [];
    const vals = Array.isArray(row.multiValues) ? row.multiValues : [];
    const map = {};
    opts.forEach((o) => {
      const id = typeof o === "string" ? o : o.id;
      const lab = typeof o === "object" && o.label ? o.label : id;
      map[id] = lab;
    });
    return vals.map((v) => {
      if (v === "other") {
        const t = (row.otherText || "").trim();
        return t ? "其他（" + t + "）" : "其他";
      }
      return map[v] || v;
    });
  }

  function namedOwnersOf(row) {
    if (Array.isArray(row.owners)) {
      return row.owners.filter((o) => o && String(o.name || "").trim());
    }
    if (row.ownerFields && String(row.ownerFields.name || "").trim()) {
      return [row.ownerFields];
    }
    return [];
  }

  /** 散会最低要求：选 A/B 须 #1 #3 #4 #6；选 C 只须已选路径（pathValue 即表态） */
  function evaluateCheckGate(block) {
    const rows = block.rows || [];
    const total = rows.length;
    const done = rows.filter((r) => r.checked || (Array.isArray(r.pathOptions) && r.pathValue)).length;
    const pathRow = rows.find((r) => Array.isArray(r.pathOptions) && r.pathOptions.length);
    const path = pathRow ? pathRow.pathValue || "" : "";
    const multiRow = rows.find((r) => Array.isArray(r.multiOptions) && r.multiOptions.length);
    const feeRow = rows.find((r) => r.feeFields);
    const ownerRow = rows.find((r) => Array.isArray(r.owners) || r.ownerFields);
    const needNos = path === "C" ? ["2"] : ["1", "3", "4", "6"];
    const missing = [];
    needNos.forEach((no) => {
      const r = rows.find((x) => String(x.no) === String(no));
      if (!r) return;
      if (no === "2") {
        // 选了路径即视为 #2 完成（不依赖勾选框）
        if (!r.pathValue) missing.push("#2 路径");
      } else if (no === "1") {
        const vals = Array.isArray(r.multiValues) ? r.multiValues : [];
        if (!vals.length || !r.checked) missing.push("#1 主开");
        else if (vals.includes("other") && !(r.otherText || "").trim()) missing.push("#1 其他说明");
      } else if (no === "4") {
        if (!namedOwnersOf(r).length || !r.checked) missing.push("#4 负责人");
      } else if (!r.checked) {
        missing.push("#" + no);
      }
    });
    return {
      rows,
      total,
      done,
      path,
      pathLab: PATH_LABELS[path] || (path ? path : "未选"),
      missing,
      isMinOk: !!path && missing.length === 0,
      multiRow,
      feeRow,
      ownerRow,
    };
  }

  /** 勾选进度：散会最低要求提示（白话）+ 复制结论按钮；文案全在 DOM，不用 CSS ::after */
  function checkStatusHtml(block) {
    const g = evaluateCheckGate(block);
    let cls = "check-status";
    let msg = "";
    const bound = "边界：不立刻上线 · 不代回 · 不编假收益";
    if (!g.path && g.done === 0) {
      cls += " is-idle";
      msg = `点右侧方框即可勾选 · 已勾 <b>${g.done}/${g.total}</b> · 建议先选路径 A / B / C · ${bound}`;
    } else if (g.path === "C") {
      // C：选路径即表态；missing 理论上为空，若 schema 缺 #2 才 warn
      cls += g.missing.length ? " is-warn" : " is-ok";
      msg = g.missing.length
        ? `路径 <b>C 不立</b> · 还缺：<b>${g.missing.join(" · ")}</b> · 已勾 <b>${g.done}/${g.total}</b> · ${bound}`
        : `路径 <b>C 不立</b> · 最低要求已齐 · 不立项 · 会后写周报说明 · 已勾 <b>${g.done}/${g.total}</b>`;
    } else if (g.missing.length) {
      cls += " is-warn";
      msg = `路径 <b>${g.pathLab}</b> · 散会前还缺：<b>${g.missing.join(" · ")}</b> · 已勾 <b>${g.done}/${g.total}</b> · ${bound}`;
    } else {
      cls += " is-ok";
      msg = `路径 <b>${g.pathLab}</b> · 最低要求已齐，可记「本场可启动准备」· 可复制结论贴飞书 · 已勾 <b>${g.done}/${g.total}</b> · ${bound}`;
    }
    const copyLab = g.isMinOk ? "复制本场结论" : "复制当前勾选";
    // 悬浮头：路径 + 进度 + 门禁，滚动多选时一眼能看见
    const pathCls = g.path ? " path-" + String(g.path).toLowerCase() : " is-empty";
    const pathBadge = g.path
      ? `<span class="check-path-badge${pathCls}">${esc(g.pathLab)}</span>`
      : `<span class="check-path-badge is-empty">路径未选</span>`;
    const progBadge = `<span class="check-prog-badge">已勾 <b>${g.done}/${g.total}</b></span>`;
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
        <button type="button" class="copy-conclusion-btn" data-copy-conclusion="${esc(block.id)}" title="复制到剪贴板，可贴周报/飞书">${copyLab}</button>
      </div>
    </div>`;
  }

  function buildMeetingConclusion(block) {
    const g = evaluateCheckGate(block);
    const date = (content && content.updated) || new Date().toISOString().slice(0, 10);
    const now = new Date();
    const stamp =
      date +
      " " +
      String(now.getHours()).padStart(2, "0") +
      ":" +
      String(now.getMinutes()).padStart(2, "0");
    const lines = [];
    lines.push("【AI 赋能立项 · 本场结论】");
    lines.push("时间：" + stamp);
    lines.push("路径：" + g.pathLab + (g.isMinOk ? "（最低要求已齐）" : "（最低要求未齐）"));
    if (g.multiRow) {
      const labs = multiLabelsOf(g.multiRow);
      lines.push("主开项目：" + (labs.length ? labs.join(" · ") : "（未选）"));
    } else {
      lines.push("主开项目：（未选）");
    }
    if (g.feeRow && g.feeRow.feeFields) {
      const f = g.feeRow.feeFields;
      let fee =
        "费用口径：全期约 " +
        (f.total || "—") +
        " 元 · 首月止损 " +
        (f.monthCap || "—") +
        " · 全期止损 " +
        (f.allCap || "—");
      if ((f.otherNote || "").trim()) fee += " · 其他：" + f.otherNote.trim();
      lines.push(fee);
    } else {
      lines.push("费用口径：（未填）");
    }
    const owners = g.ownerRow ? namedOwnersOf(g.ownerRow) : [];
    if (owners.length) {
      owners.forEach((of, i) => {
        const name = (of.name || "").trim() || "（未填）";
        const dept = (of.dept || "").trim() || "—";
        const scope = (of.scope || of.backup || "").trim() || "—";
        lines.push("业务负责人" + (owners.length > 1 ? i + 1 : "") + "：" + name + " · 部门 " + dept + " · 负责 " + scope);
      });
    } else {
      lines.push("业务负责人：（未填）");
    }
    lines.push("勾选明细：");
    g.rows.forEach((r) => {
      const mark = r.checked ? "☑" : "☐";
      let line = "  " + mark + " #" + (r.no || "") + " " + stripHtmlText(r.html);
      if (Array.isArray(r.multiOptions) && r.multiOptions.length) {
        const labs = multiLabelsOf(r);
        line += labs.length ? " → " + labs.join("、") : " → 未选项目";
      }
      if (Array.isArray(r.pathOptions) && r.pathOptions.length) {
        line += r.pathValue ? " → 路径 " + (PATH_LABELS[r.pathValue] || r.pathValue) : " → 路径未选";
      }
      if (r.feeFields) {
        const f = r.feeFields;
        line +=
          " → 全期" +
          (f.total || "—") +
          "/首月止损" +
          (f.monthCap || "—") +
          "/全期止损" +
          (f.allCap || "—");
        if ((f.otherNote || "").trim()) line += "；其他 " + f.otherNote.trim();
      }
      if (Array.isArray(r.owners)) {
        const named = namedOwnersOf(r);
        if (named.length) {
          line +=
            " → " +
            named
              .map((o) => (o.name || "").trim() + (o.scope ? "(" + o.scope + ")" : ""))
              .join("、");
        }
      }
      lines.push(line);
    });
    if (g.missing.length) {
      lines.push("散会最低要求：还缺 " + g.missing.join(" · "));
      lines.push("结论口径：只记「有意向」，不排开发（除非路径 C）。");
    } else if (g.path === "C") {
      lines.push("散会最低要求：已齐（不立）");
      lines.push("会后：一页「不立+原因」进周报 · 不排期");
    } else if (g.path === "B") {
      lines.push("散会最低要求：已齐");
      lines.push("会后：组织准备 · 费用没批完前不开发、不烧工具费 · 批完再开工");
    } else if (g.path === "A") {
      lines.push("散会最低要求：已齐");
      lines.push("会后：负责人 3 天内补书面同意 · 2 天内钉死账户与对接人 · 按止损线开通工具 · 超线即停");
    } else {
      lines.push("散会最低要求：路径未选");
    }
    lines.push("本场边界：不承诺立刻上线 · 不自动代回客户 · 金额以确认的止损线为准");
    lines.push("— 可直接贴周报 / 飞书纪要 —");
    return lines.join("\n");
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
    // 手机悬浮底栏：同步键盘/可视区 bottom
    syncCheckStatusFloat();
  }

  /** 手机：进度条 fixed 时避开软键盘遮挡 */
  function syncCheckStatusFloat() {
    if (window.innerWidth > 640) return;
    const el = document.querySelector("#t6.panel.active [data-check-status]");
    if (!el) return;
    const vv = window.visualViewport;
    let lift = 0;
    if (vv) {
      // 键盘顶起时，把底栏抬到可视区上方
      lift = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    }
    el.style.bottom = "calc(" + (10 + lift) + "px + env(safe-area-inset-bottom, 0px))";
  }

  function wireCheckStatusFloat() {
    if (wireCheckStatusFloat._on) return;
    wireCheckStatusFloat._on = true;
    const tick = () => syncCheckStatusFloat();
    window.addEventListener("resize", tick);
    window.addEventListener("orientationchange", () => setTimeout(tick, 200));
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", tick);
      window.visualViewport.addEventListener("scroll", tick);
    }
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
    $$("[data-check-toggle]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const blockId = btn.dataset.block;
        const row = +btn.dataset.row;
        const block = findBlock(blockId);
        if (!block || !block.rows || !block.rows[row]) return;
        const r = block.rows[row];
        const tr = btn.closest("tr");
        if (Array.isArray(r.pathOptions) && r.pathOptions.length) {
          // 路径行：只能通过 A/B/C 改表态，勾选框不单独翻转
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
        if (Array.isArray(r.owners) && !namedOwnersOf(r).length && !r.checked) {
          // 允许先勾，但状态条会提示缺姓名；若要严格：
          // 不拦截，只在 gate 检查
        }
        r.checked = !r.checked;
        setRowCheckedUI(tr, r.checked);
        if (tr) {
          tr.classList.remove("is-just-toggled");
          // force reflow for pop animation
          void tr.offsetWidth;
          tr.classList.add("is-just-toggled");
          setTimeout(() => tr.classList.remove("is-just-toggled"), 320);
        }
        tapHaptic(r.checked ? "ok" : "light");
        saveDraft();
        refreshCheckStatus(blockId);
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

  function wireDetailCards() {
    $$("[data-detail-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (editing) return;
        const id = btn.getAttribute("data-detail-toggle");
        const card = btn.closest(".detail-card");
        const body = document.getElementById("detail-body-" + id);
        if (!card || !body) return;
        const open = !card.classList.contains("is-open");
        const isMobile = window.innerWidth <= 640;
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

          if (isMobile) {
            // 手机：不限高动画，展开后压缩图 + 列表随页面滚
            requestAnimationFrame(() => {
              renderedMermaid.clear();
              queueMermaid(activeTab);
              // 把「各部门」滚到可视区顶部，下面可继续拖
              try {
                card.scrollIntoView({ block: "start", behavior: "smooth" });
              } catch (_) {}
              // 若 panel-body 是滚动容器，滚到明细
              if (pb) {
                const top = card.offsetTop - 8;
                pb.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
              }
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
                renderedMermaid.clear();
                queueMermaid(activeTab);
              }, 300);
            });
          }
        } else {
          if (isMobile) {
            body.hidden = true;
            body.style.maxHeight = "";
            body.style.opacity = "";
            body.style.overflow = "";
            body.style.transition = "";
            renderedMermaid.clear();
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
                renderedMermaid.clear();
                queueMermaid(activeTab);
              }, 280);
            });
          }
        }
      });
    });
  }

  function checkRowKey(r) {
    if (!r) return "";
    if (r.rowId) return String(r.rowId);
    if (r.no != null && r.no !== "") return "no:" + String(r.no);
    return "";
  }

  function pathOptionKeys(row) {
    return (row.pathOptions || []).map((p) => (typeof p === "string" ? p : p && p.value)).filter(Boolean);
  }

  function multiOptionKeys(row) {
    return (row.multiOptions || []).map((p) => (typeof p === "string" ? p : p && p.id)).filter(Boolean);
  }

  /**
   * 热更新时保留本机勾选：按 rowId/no 匹配，字段级合并；
   * 允许 checked=false；schema 漂移时丢弃无效字段并提示。
   */
  function mergeCheckState(prev, next) {
    if (!prev || !next || !prev.tabs || !next.tabs) return next;
    const prevMap = {};
    prev.tabs.forEach((t) => {
      (t.blocks || []).forEach((b) => {
        if (b.type === "check-table" && b.id) prevMap[b.id] = b;
      });
    });
    let schemaWarn = false;
    next.tabs.forEach((t) => {
      (t.blocks || []).forEach((b) => {
        const old = prevMap[b.id];
        if (!old || b.type !== "check-table" || !old.rows || !b.rows) return;
        const oldByKey = {};
        old.rows.forEach((or, i) => {
          const k = checkRowKey(or) || "idx:" + i;
          oldByKey[k] = or;
        });
        b.rows.forEach((r, i) => {
          const k = checkRowKey(r) || "idx:" + i;
          let o = oldByKey[k];
          if (!o) o = old.rows.find((x) => String(x.no) === String(r.no));
          if (!o) return;

          // checked：本机会议态完整覆盖（含 false）
          if (typeof o.checked === "boolean") r.checked = o.checked;

          // 路径：仅当仍在新 pathOptions 内
          if (o.pathValue) {
            if (Array.isArray(r.pathOptions) && r.pathOptions.length) {
              const opts = pathOptionKeys(r);
              if (opts.includes(o.pathValue)) {
                r.pathValue = o.pathValue;
                r.checked = true;
              } else {
                schemaWarn = true;
              }
            } else {
              schemaWarn = true;
            }
          }

          // 多选：过滤非法 option
          if (Array.isArray(o.multiValues) && o.multiValues.length) {
            if (Array.isArray(r.multiOptions) && r.multiOptions.length) {
              const valid = new Set(multiOptionKeys(r));
              const kept = o.multiValues.filter((v) => valid.has(v));
              r.multiValues = kept;
              if (kept.length !== o.multiValues.length) schemaWarn = true;
              if (kept.length) r.checked = true;
            } else {
              schemaWarn = true;
            }
          }
          if (o.otherText != null && o.otherText !== "") {
            if (Array.isArray(r.multiOptions)) r.otherText = o.otherText;
          }

          // 费用：用户填过的字段覆盖
          if (o.feeFields && r.feeFields) {
            r.feeFields = Object.assign({}, r.feeFields, o.feeFields);
            if (o.checked) r.checked = true;
          } else if (o.feeFields && !r.feeFields) {
            schemaWarn = true;
          }

          // 负责人：owners 优先；兼容旧 ownerFields → owners[0]
          if (Array.isArray(r.owners)) {
            if (Array.isArray(o.owners) && o.owners.length) {
              r.owners = o.owners.map((x) => Object.assign({}, x));
              if (namedOwnersOf(r).length) r.checked = true;
            } else if (o.ownerFields && String(o.ownerFields.name || "").trim()) {
              if (!r.owners[0]) r.owners[0] = { name: "", dept: "", scope: "" };
              r.owners[0] = Object.assign({}, r.owners[0], {
                name: o.ownerFields.name || "",
                dept: o.ownerFields.dept || r.owners[0].dept || "",
                scope:
                  o.ownerFields.scope ||
                  o.ownerFields.backup ||
                  r.owners[0].scope ||
                  "",
              });
              r.checked = true;
            }
          } else if (o.ownerFields) {
            r.ownerFields = Object.assign({}, r.ownerFields || {}, o.ownerFields);
          }
        });
      });
    });
    if (schemaWarn) {
      try {
        toast("检测到内容结构更新，部分旧勾选已按新结构对齐", 2600);
      } catch (_) {}
    }
    return next;
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
        padding: 12,
        nodeSpacing: 32,
        rankSpacing: 40,
      },
      themeVariables: {
        fontFamily: "-apple-system, PingFang SC, Microsoft YaHei, sans-serif",
        fontSize: "16px",
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

  /** 流程图 SVG 铺满 host：裁掉空白 viewBox + meet 自适应放大 */
  function fitMermaidSvg(host, svgEl) {
    if (!host || !svgEl) return;
    try {
      svgEl.removeAttribute("width");
      svgEl.removeAttribute("height");
      svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svgEl.style.width = "100%";
      svgEl.style.height = "100%";
      svgEl.style.maxWidth = "100%";
      svgEl.style.maxHeight = "100%";
      svgEl.style.display = "block";
      // 下一帧按真实内容 bbox 收紧 viewBox，图更大
      requestAnimationFrame(() => {
        try {
          const bbox = svgEl.getBBox();
          if (!bbox || !(bbox.width > 0) || !(bbox.height > 0)) return;
          const padX = Math.max(16, bbox.width * 0.06);
          const padY = Math.max(16, bbox.height * 0.06);
          svgEl.setAttribute(
            "viewBox",
            [bbox.x - padX, bbox.y - padY, bbox.width + padX * 2, bbox.height + padY * 2].join(" ")
          );
        } catch (_) {}
      });
    } catch (_) {}
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
          // 自适应铺满容器（尤其 t3 双列做/不做）
          fitMermaidSvg(host, svgEl);
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
    const ids = content.tabs.map((x) => x.id);
    const prevIdx = ids.indexOf(activeTab);
    const nextIdx = ids.indexOf(id);
    if (dir === "left" || dir === "right") swipeDir = dir;
    else if (prevIdx >= 0 && nextIdx >= 0) swipeDir = nextIdx >= prevIdx ? "left" : "right";

    activeTab = id;
    if (document.body.classList.contains("is-mobile")) tapHaptic("light");
    // 切页前强制清残留，防止上一页 transform/opacity 挂着
    resetAllSwipeStyles();
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
    updatePagerChrome();
    await queueMermaid(id);
    syncCheckStatusFloat();
  }

  function go(delta, opts) {
    const ids = content.tabs.map((x) => x.id);
    const cur = ids.indexOf(activeTab);
    const next = cur + delta;
    if (next < 0 || next >= ids.length) {
      toast(next < 0 ? "已是第一页" : "已是最后一页");
      tapHaptic("warn");
      return;
    }
    activate(ids[next], delta > 0 ? "left" : "right", opts || null);
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

  /** 触屏左右滑翻页：跟手 + 邻页预览叠层 + 过阈吸附 / 回弹 */
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
      pendingGoTimer = null;

    /** hard=true：连同未完成的进位动画一起清干净（新滑打断时） */
    const cancelPendingGo = (hard) => {
      if (pendingGoTimer) {
        clearTimeout(pendingGoTimer);
        pendingGoTimer = null;
        if (hard) {
          peekEl = null;
          resetAllSwipeStyles();
        }
      }
    };

    const skipSel =
      "a,button,input,textarea,label,[contenteditable=true],.chk-btn,.path-chip,.multi-chip,.owner-fields,.owners-grid,.fee-fields,.multi-row,.path-row,.check-status,.detail-card";

    const activePanel = () => document.querySelector(".panel.active:not(.is-peek)");

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

    const clearDrag = (panel, animate) => {
      clearPeek();
      document.body.classList.remove("is-swiping");
      if (!panel) {
        resetAllSwipeStyles();
        return;
      }
      if (animate) {
        panel.style.transition =
          "transform 0.2s var(--ix-spring, cubic-bezier(0.2,0.9,0.3,1.1)), opacity 0.16s ease";
        panel.style.transform = "translateX(0)";
        panel.style.opacity = "1";
        setTimeout(() => {
          resetAllSwipeStyles();
        }, 220);
      } else {
        resetAllSwipeStyles();
      }
    };

    const applyDrag = (dx) => {
      const panel = activePanel();
      if (!panel || !content) return;
      const ids = content.tabs.map((t) => t.id);
      const idx = ids.indexOf(activeTab);
      const w = stage.clientWidth || window.innerWidth;
      let tx = dx;
      if ((idx <= 0 && dx > 0) || (idx >= ids.length - 1 && dx < 0)) tx = dx * 0.3;

      panel.style.transition = "none";
      panel.style.transform = "translateX(" + tx + "px)";
      panel.style.opacity = String(Math.max(0.55, 1 - Math.abs(tx) / 520));
      panel.style.zIndex = "3";

      // 邻页预览
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
      // 下一页从右侧露头 / 上一页从左侧
      if (dx < 0) peek.style.transform = "translateX(" + (w + tx) + "px)";
      else peek.style.transform = "translateX(" + (-w + tx) + "px)";
      peek.style.opacity = String(Math.min(1, 0.4 + Math.abs(tx) / w));
    };

    const onStart = (x, y) => {
      if (editing) return;
      // 新滑动硬打断未完成进位，避免双页残留
      cancelPendingGo(true);
      startX = x;
      startY = y;
      startT = Date.now();
      tracking = true;
      axis = null;
      dragging = false;
    };

    const onMove = (x, y, e) => {
      if (!tracking || editing) return;
      const dx = x - startX;
      const dy = y - startY;
      if (!axis) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        axis = Math.abs(dx) > Math.abs(dy) * 1.12 ? "h" : "v";
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
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      const pass = absX >= 52 || (absX >= 34 && dt < 280);
      if (!pass || absX < absY * 1.05) {
        clearDrag(panel, true);
        return;
      }
      const w = stage.clientWidth || window.innerWidth;
      const dir = dx < 0 ? 1 : -1;
      // 当前页滑出，peek 进位（保持 is-swiping 到切页完成，防止 CSS 回弹）
      document.body.classList.add("is-swiping");
      if (panel) {
        panel.style.transition =
          "transform 0.2s var(--ix-spring, cubic-bezier(0.2,0.9,0.3,1.1)), opacity 0.16s ease";
        panel.style.transform = "translateX(" + (dir > 0 ? -w : w) + "px)";
        panel.style.opacity = "0";
        panel.style.zIndex = "3";
      }
      if (peekEl) {
        peekEl.style.transition =
          "transform 0.2s var(--ix-spring, cubic-bezier(0.2,0.9,0.3,1.1)), opacity 0.16s ease";
        peekEl.style.transform = "translateX(0)";
        peekEl.style.opacity = "1";
        peekEl.style.zIndex = "4";
      }
      cancelPendingGo(false);
      pendingGoTimer = setTimeout(() => {
        pendingGoTimer = null;
        peekEl = null;
        // 先硬清残留，再切页（fromSwipe 跳过二次入场动画）
        resetAllSwipeStyles();
        go(dir, { fromSwipe: true });
      }, 200);
    };

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

    let mouseDown = false;
    stage.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target.closest(skipSel)) return;
      mouseDown = true;
      onStart(e.clientX, e.clientY);
    });
    stage.addEventListener("pointermove", (e) => {
      if (!mouseDown) return;
      onMove(e.clientX, e.clientY, null);
    });
    stage.addEventListener("pointerup", (e) => {
      if (!mouseDown) return;
      mouseDown = false;
      onEnd(e.clientX, e.clientY);
    });
    stage.addEventListener("pointercancel", () => {
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

    try {
      // C端默认拉最新；仅 ?edit=1 优先草稿
      await loadContent({ preferDraft: isEditQuery });
      // IndexedDB 在部分环境会挂起：超时后跳过，绝不挡首屏渲染
      fileHandle = await withTimeout(loadHandle(), 1500, null);
      if (fileHandle) setStatus("可一键保存", "ok");
      renderAll();
      wireToolbar();
      wireLogo();
      wireKeys();
      wireSwipe();
      wireCheckStatusFloat();
      startHotPoll();
      document.body.classList.toggle("is-check-page", activeTab === "t6");
      syncCheckStatusFloat();
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
