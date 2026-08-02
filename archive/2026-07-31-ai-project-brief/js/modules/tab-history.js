function validTabIds(getTabIds) {
  const ids = typeof getTabIds === "function" ? getTabIds() : [];
  return Array.isArray(ids) ? ids.filter(Boolean).map(String) : [];
}

export function tabIdFromHash(hash, tabIds) {
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  const id = params.get("tab") || "";
  return tabIds.includes(id) ? id : "";
}

/**
 * 用 #tab=<id> 保存页签历史。push 只由用户导航触发；
 * popstate/hashchange 只还原 UI，不再写 history，避免回退递归。
 */
export function createTabHistory({ windowLike, getTabIds, onNavigate }) {
  let started = false;
  let restoringHash = "";

  const ids = () => validTabIds(getTabIds);
  const read = () => tabIdFromHash(windowLike.location.hash, ids());

  const write = (id, replace) => {
    const available = ids();
    if (!available.includes(id)) return false;
    const url = new URL(windowLike.location.href);
    url.hash = `tab=${encodeURIComponent(id)}`;
    if (url.href === windowLike.location.href && !replace) return false;
    const method = replace ? "replaceState" : "pushState";
    windowLike.history[method]({ aiBriefTab: id }, "", url.href);
    return true;
  };

  const restore = (event) => {
    const stateId = event?.state?.aiBriefTab || windowLike.history.state?.aiBriefTab || "";
    const id = read() || (ids().includes(stateId) ? stateId : "");
    if (!id || restoringHash === windowLike.location.hash) return;
    restoringHash = windowLike.location.hash;
    const release = () => {
      restoringHash = "";
    };
    if (typeof windowLike.queueMicrotask === "function") windowLike.queueMicrotask(release);
    else Promise.resolve().then(release);
    onNavigate(id, { fromHistory: true });
  };

  return {
    read,
    initialize(fallbackId) {
      const available = ids();
      const hash = String(windowLike.location.hash || "");
      const fromHash = read();
      const initial = fromHash || (available.includes(fallbackId) ? fallbackId : available[0]) || "";
      if (initial && (fromHash || !hash || hash.startsWith("#tab="))) write(initial, true);
      else if (initial) {
        windowLike.history.replaceState(
          { ...(windowLike.history.state || {}), aiBriefTab: initial },
          "",
          windowLike.location.href
        );
      }
      return initial;
    },
    push(id) {
      return write(id, false);
    },
    replace(id) {
      return write(id, true);
    },
    start() {
      if (started) return;
      started = true;
      windowLike.addEventListener("popstate", restore);
      windowLike.addEventListener("hashchange", restore);
    },
    stop() {
      if (!started) return;
      started = false;
      windowLike.removeEventListener("popstate", restore);
      windowLike.removeEventListener("hashchange", restore);
    },
  };
}
