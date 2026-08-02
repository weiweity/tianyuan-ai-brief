import createDOMPurify from "../../vendor/dompurify-3.4.12.es.mjs";

const ALLOWED_TAGS = Object.freeze(["b", "strong", "em", "i", "br", "span", "div"]);
const ALLOWED_ATTR = Object.freeze(["class", "aria-hidden"]);
const ALLOWED_CLASSES = new Set(["flow-step", "flow-arrow", "line"]);
const SAFE_DATA_IMAGE =
  /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const SAFE_RELATIVE_ASSET = /^(?:\.\/)?assets\/[a-z0-9_./@+~()-]+$/i;
const SAFE_HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

function hasUnsafeCss(value) {
  const css = String(value || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .toLowerCase();
  if (
    /[@\\]/.test(css) ||
    /(?:expression|behavior|-moz-binding)\s*[:(]/.test(css) ||
    /(?:javascript|data|https?|file)\s*:/.test(css)
  ) {
    return true;
  }
  const urls = css.matchAll(/url\s*\(\s*([^)]*?)\s*\)/g);
  for (const match of urls) {
    const target = String(match[1] || "")
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (!/^#[a-z0-9_.:-]+$/i.test(target)) return true;
  }
  return false;
}

export function createHtmlPolicy(windowLike) {
  if (!windowLike || !windowLike.document) {
    throw new TypeError("HTML policy requires a Window-like document");
  }
  const purifier = createDOMPurify(windowLike);
  const svgPurifier = createDOMPurify(windowLike);
  purifier.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName === "class") {
      const allowed = String(data.attrValue || "")
        .split(/\s+/)
        .filter((name) => ALLOWED_CLASSES.has(name));
      if (allowed.length) data.attrValue = allowed.join(" ");
      else data.keepAttr = false;
    }
    if (data.attrName === "aria-hidden") {
      data.attrValue = data.attrValue === "true" ? "true" : "false";
    }
  });
  svgPurifier.addHook("uponSanitizeAttribute", (_node, data) => {
    const name = String(data.attrName || "").toLowerCase();
    if (/^on/.test(name)) {
      data.keepAttr = false;
      return;
    }
    if (/url\s*\(/i.test(String(data.attrValue || "")) && hasUnsafeCss(data.attrValue)) {
      data.keepAttr = false;
      return;
    }
    if (name === "href" || name === "xlink:href") {
      const target = String(data.attrValue || "").trim();
      if (!target.startsWith("#")) data.keepAttr = false;
    }
    if (name === "style" && hasUnsafeCss(data.attrValue)) {
      data.keepAttr = false;
    }
  });
  svgPurifier.addHook("uponSanitizeElement", (node, data) => {
    if (String(data.tagName || "").toLowerCase() === "style" && hasUnsafeCss(node.textContent)) {
      node.textContent = "";
    }
  });

  const sanitizeRichHtml = (value) =>
    purifier.sanitize(String(value == null ? "" : value), {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: true,
      KEEP_CONTENT: true,
      RETURN_TRUSTED_TYPE: false,
    });

  const sanitizeSvg = (value) => {
    const clean = svgPurifier.sanitize(String(value == null ? "" : value), {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ["script", "iframe", "object", "embed", "foreignObject"],
      ALLOW_DATA_ATTR: false,
      RETURN_TRUSTED_TYPE: false,
    });
    return /^\s*<svg[\s>]/i.test(clean) ? clean : "";
  };

  const sanitizeAssetUrl = (value, fallback = "") => {
    const candidate = String(value == null ? "" : value).trim();
    const pathSegments = candidate.split("/");
    if (
      SAFE_DATA_IMAGE.test(candidate) ||
      (SAFE_RELATIVE_ASSET.test(candidate) &&
        !/[\u0000-\u001f\u007f\\]/.test(candidate) &&
        !candidate.startsWith("//") &&
        !pathSegments.includes(".."))
    ) {
      return candidate;
    }
    return fallback;
  };

  const sanitizeBrandColor = (value, fallback = "#EBE6EF") => {
    const candidate = String(value == null ? "" : value).trim();
    return SAFE_HEX_COLOR.test(candidate) ? candidate : fallback;
  };

  const sanitizeContent = (input) => {
    const copy =
      typeof structuredClone === "function"
        ? structuredClone(input)
        : JSON.parse(JSON.stringify(input));

    const walk = (value, key = "") => {
      if (Array.isArray(value)) {
        value.forEach((item) => walk(item));
        return;
      }
      if (!value || typeof value !== "object") return;
      Object.entries(value).forEach(([childKey, childValue]) => {
        if (typeof childValue === "string" && childKey === "html") {
          value[childKey] = sanitizeRichHtml(childValue);
        } else if (
          typeof childValue === "string" &&
          key === "meta" &&
          childKey === "footerRight"
        ) {
          value[childKey] = sanitizeRichHtml(childValue);
        } else if (
          typeof childValue === "string" &&
          (childKey === "src" || (key === "meta" && childKey === "logo"))
        ) {
          value[childKey] = sanitizeAssetUrl(childValue);
        } else if (
          typeof childValue === "string" &&
          key === "meta" &&
          childKey === "logoDataUrl"
        ) {
          value[childKey] = sanitizeAssetUrl(childValue);
        } else if (
          typeof childValue === "string" &&
          key === "meta" &&
          childKey === "brand"
        ) {
          value[childKey] = sanitizeBrandColor(childValue);
        } else {
          walk(childValue, childKey);
        }
      });
    };
    walk(copy);
    return copy;
  };

  return Object.freeze({
    sanitizeRichHtml,
    sanitizeSvg,
    sanitizeAssetUrl,
    sanitizeBrandColor,
    sanitizeContent,
  });
}

const browserPolicy =
  typeof globalThis.window !== "undefined" && globalThis.window.document
    ? createHtmlPolicy(globalThis.window)
    : null;

function requireBrowserPolicy() {
  if (!browserPolicy) throw new Error("Browser HTML policy is unavailable");
  return browserPolicy;
}

export const sanitizeRichHtml = (value) => requireBrowserPolicy().sanitizeRichHtml(value);
export const sanitizeSvg = (value) => requireBrowserPolicy().sanitizeSvg(value);
export const sanitizeAssetUrl = (value, fallback) =>
  requireBrowserPolicy().sanitizeAssetUrl(value, fallback);
export const sanitizeBrandColor = (value, fallback) =>
  requireBrowserPolicy().sanitizeBrandColor(value, fallback);
export const sanitizeContent = (value) => requireBrowserPolicy().sanitizeContent(value);
