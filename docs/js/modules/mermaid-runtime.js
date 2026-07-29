const MERMAID_CONFIG = Object.freeze({
  startOnLoad: false,
  theme: "base",
  securityLevel: "strict",
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

export function createMermaidRuntime({
  windowLike,
  documentLike,
  getBlock,
  getActiveTab,
  isEditing,
  sanitizeSvg,
}) {
  if (!windowLike || !documentLike) throw new TypeError("Mermaid runtime requires DOM");
  let ready = false;
  let lightboxWired = false;
  const rendered = new Set();
  const queryAll = (selector, root = documentLike) => [...root.querySelectorAll(selector)];

  async function ensure() {
    if (ready) return;
    if (!windowLike.mermaid) throw new Error("mermaid 未加载");
    windowLike.mermaid.initialize(MERMAID_CONFIG);
    ready = true;
  }

  function fitSvg(svgElement) {
    if (!svgElement) return;
    svgElement.removeAttribute("width");
    svgElement.removeAttribute("height");
    svgElement.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svgElement.classList.add("mermaid-fitted-svg");
    windowLike.requestAnimationFrame(() => {
      try {
        const box = svgElement.getBBox();
        if (!box || !(box.width > 0) || !(box.height > 0)) return;
        const paddingX = Math.max(16, box.width * 0.06);
        const paddingY = Math.max(16, box.height * 0.06);
        svgElement.setAttribute(
          "viewBox",
          [
            box.x - paddingX,
            box.y - paddingY,
            box.width + paddingX * 2,
            box.height + paddingY * 2,
          ].join(" ")
        );
      } catch {}
    });
  }

  function markZoomable(tabId) {
    const panel = documentLike.getElementById(tabId || getActiveTab());
    if (!panel) return;
    queryAll(".mermaid-host", panel).forEach((host) => {
      if (!host.querySelector("svg")) return;
      host.classList.add("is-zoomable");
      host.setAttribute("role", "button");
      host.setAttribute("tabindex", "0");
      host.setAttribute("aria-label", "单击放大流程图");
    });
  }

  async function queue(tabId) {
    if (isEditing()) return;
    await ensure();
    const panel = documentLike.getElementById(tabId);
    if (!panel) return;
    for (const host of queryAll(".mermaid-host", panel)) {
      const id = host.dataset.mermaidId;
      if (rendered.has(id)) continue;
      const block = getBlock(id);
      if (!block || !block.source) {
        const empty = documentLike.createElement("div");
        empty.className = "mermaid-empty";
        empty.textContent = "暂无流程图 · 编辑态可粘贴 mermaid";
        host.replaceChildren(empty);
        continue;
      }
      host.replaceChildren();
      try {
        const renderId = `mmd-${id.replace(/\W/g, "_")}-${Date.now()}`;
        const { svg } = await windowLike.mermaid.render(renderId, block.source);
        const safeSvg = sanitizeSvg(svg);
        if (!safeSvg) throw new Error("Mermaid 输出未通过 SVG 安全策略");
        host.innerHTML = safeSvg;
        const svgElement = host.querySelector("svg");
        if (!svgElement) throw new Error("Mermaid 未生成 SVG");
        svgElement.setAttribute("role", "img");
        const label = String(block.source).replace(/\s+/g, " ").trim().slice(0, 48);
        svgElement.setAttribute("aria-label", `流程图: ${label || id}`);
        fitSvg(svgElement);

        const description = documentLike.createElement("span");
        description.className = "mermaid-a11y";
        description.id = `mmd-desc-${id.replace(/\W/g, "_")}`;
        description.textContent = block.source;
        host.appendChild(description);
        svgElement.setAttribute("aria-describedby", description.id);
        rendered.add(id);
      } catch (error) {
        const message = documentLike.createElement("pre");
        message.className = "mermaid-error";
        message.textContent = `Mermaid 错误: ${error.message || error}`;
        host.replaceChildren(message);
      }
    }
    markZoomable(tabId);
  }

  function clear() {
    rendered.clear();
  }

  function wireLightbox() {
    if (lightboxWired) return;
    lightboxWired = true;
    const box = documentLike.querySelector("#diagram-lightbox");
    const stage = documentLike.querySelector("#diagram-lightbox-stage");
    const closeButton = documentLike.querySelector("#diagram-lightbox-close");
    if (!box || !stage) return;

    let lastTrigger = null;
    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let pinchStartDistance = 0;
    let pinchStartScale = 1;
    let panStart = null;
    let lastTapTime = 0;
    let startX = 0;
    let startY = 0;

    const viewport = () => stage.querySelector(".diagram-zoom-viewport");
    const clampPan = () => {
      const target = viewport();
      if (!target || scale <= 1) {
        translateX = 0;
        translateY = 0;
        return;
      }
      const rect = stage.getBoundingClientRect();
      const maxX = (rect.width * (scale - 1)) / 2 + rect.width * 0.15;
      const maxY = (rect.height * (scale - 1)) / 2 + rect.height * 0.15;
      translateX = Math.min(maxX, Math.max(-maxX, translateX));
      translateY = Math.min(maxY, Math.max(-maxY, translateY));
    };
    const applyTransform = (rubber = false) => {
      const target = viewport();
      if (!target) return;
      if (rubber) {
        scale = Math.min(5, Math.max(0.85, scale));
      } else {
        scale = Math.min(5, Math.max(1, scale));
        clampPan();
      }
      if (scale <= 1 && !rubber) {
        translateX = 0;
        translateY = 0;
      }
      target.style.transition =
        rubber || scale > 1
          ? "none"
          : "transform 0.18s cubic-bezier(0.25,0.1,0.25,1)";
      target.style.transform = `translate(${translateX}px,${translateY}px) scale(${scale})`;
    };
    const resetZoom = () => {
      scale = 1;
      translateX = 0;
      translateY = 0;
      applyTransform();
    };
    const close = () => {
      box.hidden = true;
      documentLike.body.classList.remove("is-lightbox");
      stage.replaceChildren();
      documentLike.body.style.overflow = "";
      resetZoom();
      if (lastTrigger && lastTrigger.focus) lastTrigger.focus();
      lastTrigger = null;
    };
    const openFrom = (host) => {
      if (isEditing() || documentLike.body.classList.contains("is-swiping")) return;
      const svg = host.querySelector("svg");
      if (!svg) return;
      lastTrigger = host;
      const wrapper = documentLike.createElement("div");
      wrapper.className = "diagram-zoom-viewport";
      const clone = svg.cloneNode(true);
      clone.removeAttribute("width");
      clone.removeAttribute("height");
      clone.classList.add("diagram-lightbox-svg");
      wrapper.appendChild(clone);
      const hint = documentLike.createElement("div");
      hint.className = "diagram-zoom-hint";
      hint.textContent = "双指缩放 · 双击放大/还原 · 单指拖移";
      stage.replaceChildren(wrapper, hint);
      resetZoom();
      box.hidden = false;
      documentLike.body.classList.add("is-lightbox");
      documentLike.body.style.overflow = "hidden";
      if (closeButton) closeButton.focus();
    };

    documentLike.addEventListener(
      "pointerdown",
      (event) => {
        const host = event.target.closest(".mermaid-host");
        if (!host || !box.hidden) return;
        startX = event.clientX;
        startY = event.clientY;
        host.dataset.tapCandidate = "true";
      },
      true
    );
    documentLike.addEventListener(
      "pointerup",
      (event) => {
        const host = event.target.closest(".mermaid-host");
        if (!host || host.dataset.tapCandidate !== "true") return;
        delete host.dataset.tapCandidate;
        if (Math.hypot(event.clientX - startX, event.clientY - startY) > 8) return;
        event.preventDefault();
        event.stopPropagation();
        openFrom(host);
      },
      true
    );
    if (closeButton) {
      closeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        close();
      });
    }
    box.addEventListener("click", (event) => {
      if (event.target === box) close();
    });

    const distance = (first, second) =>
      Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
    stage.addEventListener(
      "touchstart",
      (event) => {
        event.stopPropagation();
        if (event.touches.length === 2) {
          pinchStartDistance = distance(event.touches[0], event.touches[1]) || 1;
          pinchStartScale = scale;
          panStart = null;
        } else if (event.touches.length === 1 && scale > 1) {
          panStart = {
            x: event.touches[0].clientX - translateX,
            y: event.touches[0].clientY - translateY,
          };
        }
      },
      { passive: true }
    );
    stage.addEventListener(
      "touchmove",
      (event) => {
        event.stopPropagation();
        if (event.touches.length === 2) {
          if (event.cancelable) event.preventDefault();
          const currentDistance = distance(event.touches[0], event.touches[1]) || 1;
          scale = pinchStartScale * (currentDistance / pinchStartDistance);
          applyTransform(true);
        } else if (event.touches.length === 1 && panStart && scale > 1) {
          if (event.cancelable) event.preventDefault();
          translateX = event.touches[0].clientX - panStart.x;
          translateY = event.touches[0].clientY - panStart.y;
          applyTransform();
        }
      },
      { passive: false }
    );
    stage.addEventListener(
      "touchend",
      (event) => {
        event.stopPropagation();
        if (event.touches.length < 2) {
          pinchStartDistance = 0;
          if (scale < 1) resetZoom();
          else applyTransform();
        }
        if (event.touches.length === 0) panStart = null;
        if (event.changedTouches.length === 1 && event.touches.length === 0) {
          const now = Date.now();
          if (now - lastTapTime < 280) {
            if (scale > 1.05) resetZoom();
            else {
              scale = 2.2;
              applyTransform();
            }
            lastTapTime = 0;
          } else {
            lastTapTime = now;
          }
        }
      },
      { passive: true }
    );
    stage.addEventListener(
      "wheel",
      (event) => {
        if (box.hidden) return;
        event.preventDefault();
        event.stopPropagation();
        scale += event.deltaY > 0 ? -0.12 : 0.12;
        applyTransform();
      },
      { passive: false }
    );
    documentLike.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !box.hidden) close();
    });
  }

  return Object.freeze({ queue, clear, wireLightbox });
}
