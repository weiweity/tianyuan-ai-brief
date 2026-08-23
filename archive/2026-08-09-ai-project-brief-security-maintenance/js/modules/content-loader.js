const EXPECTED_TAB_IDS = Object.freeze(["t1", "t2", "t3", "t4", "t5", "t6", "t7"]);
const KNOWN_BLOCK_TYPES = new Set([
  "callout",
  "kv-table",
  "gate-table",
  "check-table",
  "mermaid",
  "image",
  "do-dont",
  "detail-card",
]);
const isRecord = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export function createContentLoader({
  windowLike,
  isFileProtocol,
  isAuthorMode,
  sanitizeContent,
  sha256,
  expectedReleaseId = "",
  expectedDecisionSchemaVersion = 0,
  cacheKey = "ai-brief-content-lkg-v1",
  contentTimeoutMs = 6000,
  manifestTimeoutMs = 3500,
}) {
  if (!windowLike || typeof sanitizeContent !== "function" || typeof sha256 !== "function") {
    throw new TypeError("Content loader requires window, sanitizer and sha256");
  }

  async function fetchWithTimeout(url, timeoutMs, init = {}) {
    const controller = new windowLike.AbortController();
    const timer = windowLike.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await windowLike.fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
      }
      throw error;
    } finally {
      windowLike.clearTimeout(timer);
    }
  }

  function validateManifest(value, { enforceRelease = true } = {}) {
    if (
      !value ||
      typeof value.releaseId !== "string" ||
      !Number.isInteger(Number(value.decisionSchemaVersion || 0)) ||
      Number(value.decisionSchemaVersion || 0) < 1 ||
      !/^[a-f0-9]{64}$/i.test(value.contentSha256 || "")
    ) {
      throw new Error("release.json 格式无效");
    }
    if (enforceRelease && expectedReleaseId && value.releaseId !== expectedReleaseId) {
      throw new Error("页面与内容发布版本不一致，请强制刷新");
    }
    return value;
  }

  async function fetchManifest({ allowReleaseMismatch = false } = {}) {
    if (isFileProtocol) {
      return validateManifest(windowLike.__AI_BRIEF_OFFLINE_META__, {
        enforceRelease: !allowReleaseMismatch,
      });
    }
    const response = await fetchWithTimeout("./data/release.json", manifestTimeoutMs, {
      cache: "no-cache",
    });
    if (!response.ok) throw new Error("无法加载 release.json");
    return validateManifest(await response.json(), {
      enforceRelease: !allowReleaseMismatch,
    });
  }

  function cacheLastKnownGood(manifest, rawText) {
    try {
      windowLike.localStorage.setItem(
        cacheKey,
        JSON.stringify({ manifest, rawText, cachedAt: new Date().toISOString() })
      );
    } catch (_) {}
  }

  function validateContent(manifest, value) {
    const content = sanitizeContent(value);
    const tabs = content && content.tabs;
    if (
      !isRecord(content) ||
      !isRecord(content.meta) ||
      typeof content.meta.title !== "string" ||
      [
        "from",
        "to",
        "subtitle",
        "logo",
        "logoDataUrl",
        "brand",
        "roleLine",
        "footerLeft",
        "footerRight",
      ].some(
        (field) => content.meta[field] != null && typeof content.meta[field] !== "string"
      ) ||
      typeof content.version !== "string" ||
      !Array.isArray(tabs) ||
      tabs.length !== EXPECTED_TAB_IDS.length ||
      Number(content.decisionSchemaVersion || 0) < 1 ||
      (expectedDecisionSchemaVersion &&
        Number(content.decisionSchemaVersion) !== expectedDecisionSchemaVersion) ||
      (manifest.decisionSchemaVersion &&
        Number(content.decisionSchemaVersion) !== Number(manifest.decisionSchemaVersion)) ||
      (manifest.contentVersion && content.version !== manifest.contentVersion)
    ) {
      throw new Error("正文结构或版本无效");
    }

    const tabIds = tabs.map((tab) => (tab && typeof tab.id === "string" ? tab.id : ""));
    if (tabIds.join(",") !== EXPECTED_TAB_IDS.join(",")) {
      throw new Error("正文页签结构无效");
    }
    const blockIds = new Set();
    for (const tab of tabs) {
      if (
        !isRecord(tab) ||
        typeof tab.title !== "string" ||
        !Array.isArray(tab.blocks) ||
        (tab.layout != null && !["stack", "split", "fill"].includes(tab.layout))
      ) {
        throw new Error("正文页签结构无效");
      }
      for (const block of tab.blocks) {
        if (
          !isRecord(block) ||
          typeof block.id !== "string" ||
          !block.id ||
          blockIds.has(block.id) ||
          !KNOWN_BLOCK_TYPES.has(block.type) ||
          (block.slot != null && !["main", "side"].includes(block.slot)) ||
          (block.headers != null && !isStringArray(block.headers))
        ) {
          throw new Error("正文区块结构无效");
        }
        blockIds.add(block.id);
        const needsRows = ["kv-table", "gate-table", "check-table", "detail-card"].includes(
          block.type
        );
        if (
          needsRows &&
          (!Array.isArray(block.rows) || !block.rows.every((row) => isRecord(row)))
        ) {
          throw new Error("正文表格结构无效");
        }
        if (block.type === "callout" && typeof block.html !== "string") {
          throw new Error("提示区块结构无效");
        }
        if (
          block.type === "kv-table" &&
          !block.rows.every(
            (row) => typeof row.key === "string" && typeof row.html === "string"
          )
        ) {
          throw new Error("键值表结构无效");
        }
        if (
          block.type === "gate-table" &&
          !block.rows.every(
            (row) => typeof row.gate === "string" && typeof row.html === "string"
          )
        ) {
          throw new Error("门禁表结构无效");
        }
        if (
          block.type === "check-table" &&
          !block.rows.every(
            (row) =>
              typeof row.no === "string" &&
              typeof row.html === "string" &&
              typeof row.checked === "boolean" &&
              (row.pathOptions == null || isStringArray(row.pathOptions)) &&
              (row.multiOptions == null || isStringArray(row.multiOptions)) &&
              (row.owners == null ||
                (Array.isArray(row.owners) && row.owners.every((owner) => isRecord(owner)))) &&
              (row.ownerFields == null || isRecord(row.ownerFields)) &&
              (row.feeFields == null || isRecord(row.feeFields))
          )
        ) {
          throw new Error("确认表结构无效");
        }
        if (
          block.type === "detail-card" &&
          !block.rows.every(
            (row) =>
              typeof row.sector === "string" &&
              [row.whyOpen, row.whyNot, row.reason].every((item) => typeof item === "string")
          )
        ) {
          throw new Error("部门详情结构无效");
        }
        if (
          block.type === "do-dont" &&
          (!isStringArray(block.do) || !isStringArray(block.dont))
        ) {
          throw new Error("做与不做结构无效");
        }
        if (
          block.type === "mermaid" &&
          (typeof block.source !== "string" ||
            (block.compactItems != null &&
              (!Array.isArray(block.compactItems) ||
                !block.compactItems.every(
                  (item) =>
                    isRecord(item) &&
                    typeof item.label === "string" &&
                    typeof item.text === "string"
                ))))
        ) {
          throw new Error("流程图结构无效");
        }
        if (
          block.type === "image" &&
          (typeof block.src !== "string" || typeof block.alt !== "string")
        ) {
          throw new Error("图片结构无效");
        }
      }
    }

    const decisionBlock = tabs
      .find((tab) => tab.id === "t6")
      .blocks.find((block) => block.type === "check-table");
    const decisionRows = decisionBlock && decisionBlock.rows;
    if (!Array.isArray(decisionRows) || !decisionRows.length) {
      throw new Error("执行补录结构无效");
    }
    const rowIds = decisionRows.map((row) =>
      row && typeof row.rowId === "string" ? row.rowId : ""
    );
    if (rowIds.some((id) => !id) || new Set(rowIds).size !== rowIds.length) {
      throw new Error("执行补录行标识无效");
    }
    const pathRows = decisionRows.filter(
      (row) => row && row.projectId && Array.isArray(row.pathOptions)
    );
    const projectIds = pathRows.map((row) => row.projectId);
    const pathsValid =
      pathRows.length === 1 &&
      new Set(projectIds).size === projectIds.length &&
      pathRows.every(
        (row) =>
          row.pathOptions.length === 3 &&
          ["A", "B", "C"].every((path) => row.pathOptions.includes(path))
      );
    const ownerProjects = new Set(
      decisionRows
        .filter((row) => row && row.kind === "owner" && row.projectId)
        .map((row) => row.projectId)
    );
    const hasFee = decisionRows.some(
      (row) => row && row.kind === "fee" && row.feeFields
    );
    const hasStopAuthority = decisionRows.some(
      (row) => row && row.kind === "stop-authority"
    );
    if (
      !pathsValid ||
      !projectIds.every((projectId) => ownerProjects.has(projectId)) ||
      !hasFee ||
      !hasStopAuthority
    ) {
      throw new Error("执行补录门禁结构无效");
    }
    return content;
  }

  function readLastKnownGood() {
    try {
      const cached = JSON.parse(windowLike.localStorage.getItem(cacheKey) || "null");
      const manifest = validateManifest(cached && cached.manifest);
      const rawText = cached && cached.rawText;
      if (typeof rawText !== "string" || sha256(rawText) !== manifest.contentSha256) {
        throw new Error("缓存正文完整性校验失败");
      }
      const content = validateContent(manifest, JSON.parse(rawText));
      return { manifest, content };
    } catch (_) {
      try {
        windowLike.localStorage.removeItem(cacheKey);
      } catch (_) {}
      return null;
    }
  }

  async function fetchContent(manifestHint) {
    if (isFileProtocol) {
      const embedded = windowLike.__AI_BRIEF_EMBEDDED_CONTENT__;
      if (!embedded || !Array.isArray(embedded.tabs)) {
        throw new Error("离线内容快照缺失，请执行 npm run build:web 后重试");
      }
      const manifest = await fetchManifest();
      return {
        manifest,
        content: validateContent(manifest, embedded),
      };
    }

    const manifest = manifestHint ? validateManifest(manifestHint) : await fetchManifest();
    const url = `./data/content.json?sha=${encodeURIComponent(manifest.contentSha256)}`;
    const response = await fetchWithTimeout(url, contentTimeoutMs, { cache: "default" });
    if (!response.ok) throw new Error("无法加载 data/content.json");
    const text = await response.text();
    const isVerified = sha256(text) === manifest.contentSha256;
    if (!isVerified && !isAuthorMode()) {
      throw new Error("内容完整性校验失败，请刷新后重试");
    }
    const content = validateContent(manifest, JSON.parse(text));
    if (isVerified) cacheLastKnownGood(manifest, text);
    return { manifest, content };
  }

  return Object.freeze({
    fetchManifest,
    fetchContent,
    readLastKnownGood,
  });
}
