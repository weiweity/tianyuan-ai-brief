(function bootstrapDecisionBrief() {
  "use strict";

  const isFileProtocol = location.protocol === "file:";
  const mermaidIntegrity =
    "sha384-qX9VvWkP79m/O121ZE6sOYp0nf/pldQgtvWDbkpzi+3mUo4Wn4Ix4cFzNPay3VaB";

  function showFatal(message) {
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
    panel.replaceChildren(heading, detail);
    stage.replaceChildren(panel);
  }

  function appendApp() {
    const app = document.createElement("script");
    app.src = isFileProtocol
      ? "./js/app.offline.bundle.js?v=3.1"
      : "./js/app.js?v=3.1";
    if (!isFileProtocol) app.type = "module";
    app.addEventListener("error", () => {
      showFatal(
        isFileProtocol
          ? "离线程序包缺失，请执行 npm run build:web 后重试。"
          : "应用脚本未能加载，请检查网络或部署文件。"
      );
    });
    document.body.appendChild(app);
  }

  const mermaid = document.createElement("script");
  mermaid.src = "./vendor/mermaid-10.9.6.min.js";
  if (!isFileProtocol) {
    mermaid.integrity = mermaidIntegrity;
    mermaid.crossOrigin = "anonymous";
    mermaid.referrerPolicy = "no-referrer";
  }
  mermaid.addEventListener("load", appendApp);
  mermaid.addEventListener("error", () => {
    showFatal("流程图运行时未能加载，请确认 docs/vendor 文件完整。");
  });
  document.head.appendChild(mermaid);
})();
