(function bootstrapDecisionBrief() {
  "use strict";

  const isFileProtocol = location.protocol === "file:";
  const releaseId = document.documentElement.dataset.release || "dev";
  const mermaidIntegrity =
    "sha384-Asq0U/k3ZZtwxNKq9h/GDVcCNBdm7qVwU38pyYd6T6SFoxYzjByOvTckozijf+j0";
  let bootFinished = false;
  let mermaidLoadPromise = null;

  function showFatal(message) {
    bootFinished = true;
    const title = document.querySelector("#doc-title");
    const stage = document.querySelector("#stage");
    if (title) title.textContent = "加载失败";
    if (!stage) return;
    const panel = document.createElement("div");
    panel.className = "boot-error";
    const heading = document.createElement("h2");
    heading.textContent = "页面启动失败";
    const detail = document.createElement("p");
    detail.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "boot-retry";
    retry.textContent = "重新加载";
    retry.addEventListener("click", () => location.reload());
    panel.replaceChildren(heading, detail, retry);
    stage.replaceChildren(panel);
  }

  function appendApp() {
    const app = document.createElement("script");
    app.src = isFileProtocol
      ? `./js/app.offline.bundle.js?v=${encodeURIComponent(releaseId)}`
      : `./js/app.bundle.js?v=${encodeURIComponent(releaseId)}`;
    app.addEventListener("error", () => {
      showFatal(
        isFileProtocol
          ? "离线程序包缺失，请执行 npm run build:web 后重试。"
          : "应用脚本未能加载，请检查网络或部署文件。"
      );
    });
    document.body.appendChild(app);
  }

  function startMermaid() {
    if (globalThis.mermaid) return Promise.resolve(globalThis.mermaid);
    if (mermaidLoadPromise) return mermaidLoadPromise;
    mermaidLoadPromise = new Promise((resolve) => {
      const mermaid = document.createElement("script");
      mermaid.src = `./vendor/mermaid-10.9.6.min.js?v=${encodeURIComponent(releaseId)}`;
      if (!isFileProtocol) {
        mermaid.integrity = mermaidIntegrity;
        mermaid.crossOrigin = "anonymous";
        mermaid.referrerPolicy = "no-referrer";
      }
      mermaid.addEventListener("load", () => {
        resolve(globalThis.mermaid || null);
        window.dispatchEvent(new Event("ai-brief:mermaid-ready"));
      });
      mermaid.addEventListener("error", () => {
        mermaidLoadPromise = null;
        resolve(null);
        window.dispatchEvent(new Event("ai-brief:mermaid-error"));
      });
      document.head.appendChild(mermaid);
    });
    globalThis.__AI_BRIEF_MERMAID_READY__ = mermaidLoadPromise;
    return mermaidLoadPromise;
  }
  globalThis.__AI_BRIEF_LOAD_MERMAID__ = startMermaid;

  function scheduleMermaidWarmup() {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(startMermaid, { timeout: 1800 });
    } else {
      window.setTimeout(startMermaid, 500);
    }
  }

  window.addEventListener("ai-brief:need-mermaid", startMermaid);
  window.addEventListener(
    "ai-brief:booted",
    () => {
      bootFinished = true;
      scheduleMermaidWarmup();
    },
    { once: true }
  );
  window.setTimeout(() => {
    if (!bootFinished) {
      showFatal("应用启动超时，请检查网络后重新加载。流程图失败不应阻塞正文。");
    }
  }, 10000);

  // 正文应用与 3MB 流程图库并行加载；慢网时先展示可读内容。
  appendApp();
})();
