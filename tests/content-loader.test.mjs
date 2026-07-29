import test from "node:test";
import assert from "node:assert/strict";

import { createContentLoader } from "../docs/js/modules/content-loader.js";
import { sha256 } from "../docs/js/modules/decision-model.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function response(body, { json = false } = {}) {
  return {
    ok: true,
    text: async () => body,
    json: async () => (json ? body : JSON.parse(body)),
  };
}

function fixture() {
  const content = {
    version: "test",
    decisionSchemaVersion: 2,
    meta: { title: "测试" },
    tabs: Array.from({ length: 7 }, (_, i) => {
      const id = `t${i + 1}`;
      return {
        id,
        title: `第 ${i + 1} 页`,
        blocks:
          id === "t6"
            ? [
                {
                  id: "t6.check",
                  type: "check-table",
                  rows: [
                    {
                      rowId: "agent-path",
                      no: "1A",
                      html: "Agent path",
                      checked: false,
                      projectId: "agent",
                      pathOptions: ["A", "B", "C"],
                    },
                    {
                      rowId: "filing-path",
                      no: "1B",
                      html: "Filing path",
                      checked: false,
                      projectId: "filing",
                      pathOptions: ["A", "B", "C"],
                    },
                    {
                      rowId: "agent-owner",
                      no: "3A",
                      html: "Agent owner",
                      checked: false,
                      kind: "owner",
                      projectId: "agent",
                      owners: [{ name: "", dept: "", scope: "" }],
                    },
                    {
                      rowId: "filing-owner",
                      no: "3B",
                      html: "Filing owner",
                      checked: false,
                      kind: "owner",
                      projectId: "filing",
                      owners: [{ name: "", dept: "", scope: "" }],
                    },
                    {
                      rowId: "fee",
                      no: "2",
                      html: "Fee",
                      checked: false,
                      kind: "fee",
                      feeFields: { total: "1", monthCap: "1", allCap: "1" },
                    },
                    {
                      rowId: "stop",
                      no: "5",
                      html: "Stop",
                      checked: false,
                      kind: "stop-authority",
                    },
                  ],
                },
              ]
            : [],
      };
    }),
  };
  const text = JSON.stringify(content);
  const manifest = {
    releaseId: "test-release",
    decisionSchemaVersion: 2,
    contentVersion: "test",
    contentSha256: sha256(text),
  };
  return { content, text, manifest };
}

test("内容加载器按 manifest SHA 取正文、校验并保存可信快照", async () => {
  const { content, text, manifest } = fixture();
  const requests = [];
  const storage = memoryStorage();
  const windowLike = {
    AbortController,
    setTimeout,
    clearTimeout,
    localStorage: storage,
    fetch: async (url) => {
      requests.push(url);
      return url.includes("release.json")
        ? response(manifest, { json: true })
        : response(text);
    },
  };
  const loader = createContentLoader({
    windowLike,
    isFileProtocol: false,
    isAuthorMode: () => false,
    sanitizeContent: (value) => structuredClone(value),
    sha256,
    expectedReleaseId: manifest.releaseId,
    cacheKey: "lkg",
  });

  const loaded = await loader.fetchContent();
  assert.deepEqual(loaded.content, content);
  assert.equal(loaded.manifest.contentSha256, manifest.contentSha256);
  assert.match(requests[1], new RegExp(`content\\.json\\?sha=${manifest.contentSha256}`));
  assert.deepEqual(loader.readLastKnownGood().content, content);
});

test("正文 SHA 不一致时消费者拒绝混版，作者态仍可预览源码", async () => {
  const { text, manifest } = fixture();
  const mismatched = `${text}\n`;
  const base = {
    AbortController,
    setTimeout,
    clearTimeout,
    localStorage: memoryStorage(),
    fetch: async () => response(mismatched),
  };
  const create = (author) =>
    createContentLoader({
      windowLike: base,
      isFileProtocol: false,
      isAuthorMode: () => author,
      sanitizeContent: (value) => value,
      sha256,
      expectedReleaseId: manifest.releaseId,
    });

  await assert.rejects(create(false).fetchContent(manifest), /完整性校验失败/);
  assert.equal((await create(true).fetchContent(manifest)).content.version, "test");
});

test("挂起请求按时中止，已有可信快照仍可读取", async () => {
  const { content, text, manifest } = fixture();
  const storage = memoryStorage();
  storage.setItem("lkg", JSON.stringify({ manifest, rawText: text }));
  const windowLike = {
    AbortController,
    setTimeout,
    clearTimeout,
    localStorage: storage,
    fetch: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  };
  const loader = createContentLoader({
    windowLike,
    isFileProtocol: false,
    isAuthorMode: () => false,
    sanitizeContent: (value) => structuredClone(value),
    sha256,
    expectedReleaseId: manifest.releaseId,
    cacheKey: "lkg",
    manifestTimeoutMs: 15,
  });

  await assert.rejects(loader.fetchManifest(), /请求超时/);
  assert.deepEqual(loader.readLastKnownGood().content, JSON.parse(text));
});

test("篡改过的 LKG 与旧壳/新 manifest 混版均被拒绝", async () => {
  const { content, text, manifest } = fixture();
  const storage = memoryStorage();
  const windowLike = {
    AbortController,
    setTimeout,
    clearTimeout,
    localStorage: storage,
    fetch: async () => {
      throw new Error("unused");
    },
  };
  const create = (expectedReleaseId) =>
    createContentLoader({
      windowLike,
      isFileProtocol: false,
      isAuthorMode: () => false,
      sanitizeContent: (value) => structuredClone(value),
      sha256,
      expectedReleaseId,
      cacheKey: "lkg",
    });

  const tampered = structuredClone(content);
  tampered.tabs[0].title = "篡改后的决策文案";
  storage.setItem("lkg", JSON.stringify({ manifest, rawText: JSON.stringify(tampered) }));
  assert.equal(create(manifest.releaseId).readLastKnownGood(), null);

  storage.setItem("lkg", JSON.stringify({ manifest, rawText: text }));
  assert.equal(create("old-shell-release").readLastKnownGood(), null);
  await assert.rejects(
    create("old-shell-release").fetchContent(manifest),
    /页面与内容发布版本不一致/
  );
});

test("轮询可识别新 release，但旧页面仍禁止直接加载新 release 正文", async () => {
  const { manifest } = fixture();
  const nextManifest = { ...manifest, releaseId: "next-release" };
  const windowLike = {
    AbortController,
    setTimeout,
    clearTimeout,
    localStorage: memoryStorage(),
    fetch: async (url) =>
      url.includes("release.json")
        ? response(nextManifest, { json: true })
        : response("unused"),
  };
  const loader = createContentLoader({
    windowLike,
    isFileProtocol: false,
    isAuthorMode: () => false,
    sanitizeContent: (value) => structuredClone(value),
    sha256,
    expectedReleaseId: manifest.releaseId,
  });

  assert.deepEqual(
    await loader.fetchManifest({ allowReleaseMismatch: true }),
    nextManifest,
    "轮询必须能区分新发布与弱网故障"
  );
  await assert.rejects(loader.fetchManifest(), /页面与内容发布版本不一致/);
  await assert.rejects(loader.fetchContent(nextManifest), /页面与内容发布版本不一致/);
});

test("SHA 正确但结构错误的误发布不会覆盖最后可信快照", async () => {
  const { content, text, manifest } = fixture();
  const invalidContent = { ...content, tabs: content.tabs.slice(0, 6) };
  const invalidText = JSON.stringify(invalidContent);
  const invalidManifest = { ...manifest, contentSha256: sha256(invalidText) };
  const storage = memoryStorage();
  const originalCache = JSON.stringify({ manifest, rawText: text });
  storage.setItem("lkg", originalCache);
  const loader = createContentLoader({
    windowLike: {
      AbortController,
      setTimeout,
      clearTimeout,
      localStorage: storage,
      fetch: async () => response(invalidText),
    },
    isFileProtocol: false,
    isAuthorMode: () => false,
    sanitizeContent: (value) => structuredClone(value),
    sha256,
    expectedReleaseId: manifest.releaseId,
    cacheKey: "lkg",
  });

  await assert.rejects(loader.fetchContent(invalidManifest), /正文结构或版本无效/);
  assert.equal(storage.getItem("lkg"), originalCache, "错误正文不得污染 LKG");
  assert.deepEqual(loader.readLastKnownGood().content, content);
});

test("七个空页签、重复页签或非数组 blocks 均不能毒化 LKG", async () => {
  const { content, text, manifest } = fixture();
  const invalidValues = [
    { ...content, tabs: Array(7).fill(null) },
    {
      ...content,
      tabs: content.tabs.map((tab, index) =>
        index === 1 ? { ...tab, id: "t1" } : structuredClone(tab)
      ),
    },
    {
      ...content,
      tabs: content.tabs.map((tab, index) =>
        index === 3 ? { ...tab, blocks: "not-an-array" } : structuredClone(tab)
      ),
    },
  ];

  for (const invalidContent of invalidValues) {
    const invalidText = JSON.stringify(invalidContent);
    const invalidManifest = { ...manifest, contentSha256: sha256(invalidText) };
    const storage = memoryStorage();
    const originalCache = JSON.stringify({ manifest, rawText: text });
    storage.setItem("lkg", originalCache);
    const loader = createContentLoader({
      windowLike: {
        AbortController,
        setTimeout,
        clearTimeout,
        localStorage: storage,
        fetch: async () => response(invalidText),
      },
      isFileProtocol: false,
      isAuthorMode: () => false,
      sanitizeContent: (value) => structuredClone(value),
      sha256,
      expectedReleaseId: manifest.releaseId,
      expectedDecisionSchemaVersion: 2,
      cacheKey: "lkg",
    });

    await assert.rejects(loader.fetchContent(invalidManifest), /结构无效/);
    assert.equal(storage.getItem("lkg"), originalCache);
    assert.deepEqual(loader.readLastKnownGood().content, content);
  }
});

test("空表格行、错误 headers 和错误 do/dont 均在缓存前被拒绝", async () => {
  const { content, text, manifest } = fixture();
  const withNullRow = structuredClone(content);
  withNullRow.tabs[0].blocks = [
    {
      id: "t1.kpi",
      type: "kv-table",
      rows: [null],
    },
  ];
  const withBadHeaders = structuredClone(content);
  withBadHeaders.tabs[0].blocks = [
    {
      id: "t1.gate",
      type: "gate-table",
      headers: "not-an-array",
      rows: [{ gate: "门禁", html: "标准" }],
    },
  ];
  const withBadDoDont = structuredClone(content);
  withBadDoDont.tabs[0].blocks = [
    {
      id: "t1.do",
      type: "do-dont",
      do: "not-an-array",
      dont: ["安全"],
    },
  ];

  for (const invalidContent of [withNullRow, withBadHeaders, withBadDoDont]) {
    const invalidText = JSON.stringify(invalidContent);
    const invalidManifest = { ...manifest, contentSha256: sha256(invalidText) };
    const storage = memoryStorage();
    const originalCache = JSON.stringify({ manifest, rawText: text });
    storage.setItem("lkg", originalCache);
    const loader = createContentLoader({
      windowLike: {
        AbortController,
        setTimeout,
        clearTimeout,
        localStorage: storage,
        fetch: async () => response(invalidText),
      },
      isFileProtocol: false,
      isAuthorMode: () => false,
      sanitizeContent: (value) => structuredClone(value),
      sha256,
      expectedReleaseId: manifest.releaseId,
      expectedDecisionSchemaVersion: 2,
      cacheKey: "lkg",
    });
    await assert.rejects(loader.fetchContent(invalidManifest), /结构无效/);
    assert.equal(storage.getItem("lkg"), originalCache);
    assert.deepEqual(loader.readLastKnownGood().content, content);
  }
});

test("meta 展示字段必须是字符串，不能在 renderHeader 阶段崩溃", async () => {
  const { content, text, manifest } = fixture();
  const invalidContent = structuredClone(content);
  invalidContent.meta.from = { bad: true };
  const invalidText = JSON.stringify(invalidContent);
  const invalidManifest = { ...manifest, contentSha256: sha256(invalidText) };
  const storage = memoryStorage();
  const originalCache = JSON.stringify({ manifest, rawText: text });
  storage.setItem("lkg", originalCache);
  const loader = createContentLoader({
    windowLike: {
      AbortController,
      setTimeout,
      clearTimeout,
      localStorage: storage,
      fetch: async () => response(invalidText),
    },
    isFileProtocol: false,
    isAuthorMode: () => false,
    sanitizeContent: (value) => structuredClone(value),
    sha256,
    expectedReleaseId: manifest.releaseId,
    expectedDecisionSchemaVersion: 2,
    cacheKey: "lkg",
  });

  await assert.rejects(loader.fetchContent(invalidManifest), /正文结构或版本无效/);
  assert.equal(storage.getItem("lkg"), originalCache);
  assert.deepEqual(loader.readLastKnownGood().content, content);
});
