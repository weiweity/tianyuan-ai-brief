import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { clearMeetingBlockState } from "../docs/js/modules/meeting-state.js";
import { createTabHistory, tabIdFromHash } from "../docs/js/modules/tab-history.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

function fakeWindow(initialUrl) {
  let current = new URL(initialUrl);
  let cursor = 0;
  let entries = [{ url: current.href, state: null }];
  const listeners = new Map();
  const emit = (type) => {
    for (const listener of listeners.get(type) || []) listener({ type, state: history.state });
  };
  const setCurrent = (url) => {
    current = new URL(url, current);
  };
  const location = {};
  Object.defineProperties(location, {
    href: { get: () => current.href },
    hash: { get: () => current.hash },
  });
  const history = {
    get length() {
      return entries.length;
    },
    get state() {
      return entries[cursor].state;
    },
    pushState(state, _title, url) {
      entries = entries.slice(0, cursor + 1);
      entries.push({ url: new URL(url, current).href, state });
      cursor += 1;
      setCurrent(entries[cursor].url);
    },
    replaceState(state, _title, url) {
      entries[cursor] = { url: new URL(url, current).href, state };
      setCurrent(entries[cursor].url);
    },
    back() {
      if (cursor === 0) return;
      cursor -= 1;
      setCurrent(entries[cursor].url);
      emit("popstate");
      emit("hashchange");
    },
    forward() {
      if (cursor >= entries.length - 1) return;
      cursor += 1;
      setCurrent(entries[cursor].url);
      emit("popstate");
      emit("hashchange");
    },
  };
  return {
    location,
    history,
    queueMicrotask,
    addEventListener(type, listener) {
      const bucket = listeners.get(type) || [];
      bucket.push(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter((item) => item !== listener));
    },
  };
}

test("历史页首屏强标识非当前 SSOT，并提供两个现行本地入口", async () => {
  const [index, content] = await Promise.all([
    read("docs/index.html"),
    read("docs/data/content.json").then(JSON.parse),
  ]);
  assert.match(index, /class="archive-guard"/);
  assert.match(index, /历史快照 · 非当前 SSOT/);
  assert.match(index, /2026-07-31 已收尾/);
  assert.match(index, /\.\.\/\.\.\/business-docs\/01-客服Agent项目\/07-客服Agent立项PRD\.html/);
  assert.match(index, /\.\.\/\.\.\/business-docs\/01-客服Agent项目\/08-客服Agent立项执行中心\.html/);
  assert.match(content.meta.title, /历史快照/);
  assert.match(content.meta.subtitle, /非当前项目 SSOT/);
  assert.match(content.meta.roleLine, /已收尾/);
  assert.equal(content.version, "5.25.1");
});

test("导航提示区分桌面键盘与手机触控能力", async () => {
  const [index, css] = await Promise.all([read("docs/index.html"), read("docs/css/app.css")]);
  assert.match(index, /nav-hint-desktop">点击页签或 ← → 翻页/);
  assert.match(index, /nav-hint-touch">左右滑翻页/);
  assert.match(css, /\.nav-hint-touch\s*\{\s*display:\s*none;/s);
  assert.match(css, /@media \(max-width:\s*640px\)[\s\S]*?\.nav-hint-desktop\s*\{\s*display:\s*none;/);
  assert.match(css, /@media \(max-width:\s*640px\)[\s\S]*?\.nav-hint-touch\s*\{\s*display:\s*inline;/);
});

test("清空会议状态同时清 path、checked、fee、owner 且不修改输入", () => {
  const block = {
    id: "t6.check",
    rows: [
      { rowId: "path", checked: true, pathOptions: ["A", "B", "C"], pathValue: "A" },
      {
        rowId: "fee",
        checked: true,
        feeFields: { total: "3000", monthCap: "1000", allCap: "3000", otherNote: "已批" },
      },
      {
        rowId: "owner",
        checked: true,
        owners: [{ name: "甲", dept: "客服部", scope: "MVP-A" }],
      },
      {
        rowId: "legacy-owner",
        checked: true,
        ownerFields: { name: "乙", dept: "客服部", scope: "复核", backup: "丙" },
      },
      {
        rowId: "multi",
        checked: true,
        multiOptions: ["agent", "other"],
        multiValues: ["other"],
        otherText: "其他项目",
      },
    ],
  };
  const before = structuredClone(block);
  const cleared = clearMeetingBlockState(block);

  assert.deepEqual(block, before, "清空必须返回新对象");
  assert.notEqual(cleared, block);
  assert.equal(cleared.rows.every((row) => row.checked === false), true);
  assert.equal(cleared.rows[0].pathValue, "");
  assert.deepEqual(cleared.rows[1].feeFields, {
    total: "",
    monthCap: "",
    allCap: "",
    otherNote: "",
  });
  assert.deepEqual(cleared.rows[2].owners, [{ name: "", dept: "", scope: "" }]);
  assert.deepEqual(cleared.rows[3].ownerFields, { name: "", dept: "", scope: "", backup: "" });
  assert.deepEqual(cleared.rows[4].multiValues, []);
  assert.equal(cleared.rows[4].otherText, "");
});

test("Tab/arrow/swipe 共用稳定 hash，Back/Forward 只还原而不递归写历史", async () => {
  const windowLike = fakeWindow("https://example.test/brief?audit=1");
  const restored = [];
  const history = createTabHistory({
    windowLike,
    getTabIds: () => ["t1", "t2", "t3"],
    onNavigate: (id, options) => restored.push({ id, options }),
  });

  assert.equal(history.initialize("t1"), "t1");
  assert.equal(windowLike.location.hash, "#tab=t1");
  history.start();
  assert.equal(history.push("t2"), true);
  assert.equal(history.push("t3"), true);
  assert.equal(history.push("t3"), false, "同页不得重复入栈");
  assert.equal(windowLike.history.length, 3);

  windowLike.history.back();
  await Promise.resolve();
  assert.deepEqual(restored, [{ id: "t2", options: { fromHistory: true } }]);
  assert.equal(windowLike.history.length, 3, "Back 不得触发新 push");

  windowLike.history.forward();
  await Promise.resolve();
  assert.deepEqual(restored.at(-1), { id: "t3", options: { fromHistory: true } });
  assert.equal(windowLike.history.length, 3, "Forward 不得触发新 push");
  history.stop();
});

test("hash 只接受已知 Tab，不抢占 #stage 等页内锚点", () => {
  assert.equal(tabIdFromHash("#tab=t6", ["t1", "t6"]), "t6");
  assert.equal(tabIdFromHash("#tab=unknown", ["t1", "t6"]), "");
  assert.equal(tabIdFromHash("#stage", ["t1", "t6"]), "");

  const windowLike = fakeWindow("https://example.test/brief#stage");
  const restored = [];
  const history = createTabHistory({
    windowLike,
    getTabIds: () => ["t1", "t6"],
    onNavigate: (id) => restored.push(id),
  });
  assert.equal(history.initialize("t1"), "t1");
  assert.equal(windowLike.location.hash, "#stage");
  history.start();
  history.push("t6");
  windowLike.history.back();
  assert.equal(windowLike.location.hash, "#stage");
  assert.deepEqual(restored, ["t1"]);
  history.stop();
});

test("app.js 保持 UI 编排边界，新状态逻辑留在独立模块", async () => {
  const app = await read("docs/js/app.js");
  assert.ok(app.split("\n").length < 2700, `app.js 行数过高：${app.split("\n").length}`);
  assert.match(app, /\.\/modules\/tab-history\.js/);
  assert.match(app, /clearMeetingBlockState/);
  assert.match(
    app,
    /Object\.assign\(block, clearMeetingBlockState\(block\)\);\s*if \(!saveDraft\(\)\) \{ Object\.assign\(block, JSON\.parse\(previousBlock\)\)/,
    "清空必须持久化空值；存储失败时恢复原状态，不能假报成功"
  );
  assert.match(app, /费用 \/ cap、说明和负责人/);
  assert.match(app, /opts && opts\.fromHistory/);
});
