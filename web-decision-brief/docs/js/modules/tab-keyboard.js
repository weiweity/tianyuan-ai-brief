const TAB_KEYS = new Set(["ArrowRight", "ArrowLeft", "Home", "End"]);

/**
 * WAI-ARIA Tabs 自动激活键盘模型：选中页签与焦点始终同步。
 */
export function handleTablistKeydown(event, tabIds, activate, documentLike) {
  const focusedTab = event.target.closest && event.target.closest('[role="tab"]');
  if (!focusedTab || !TAB_KEYS.has(event.key) || !tabIds.length) return false;

  event.preventDefault();
  const focusedIndex = Math.max(0, tabIds.indexOf(focusedTab.dataset.tab));
  let nextIndex = focusedIndex;
  if (event.key === "ArrowRight") nextIndex = (focusedIndex + 1) % tabIds.length;
  else if (event.key === "ArrowLeft") nextIndex = (focusedIndex - 1 + tabIds.length) % tabIds.length;
  else if (event.key === "Home") nextIndex = 0;
  else nextIndex = tabIds.length - 1;

  const nextId = tabIds[nextIndex];
  const direction = event.key === "ArrowLeft" || event.key === "Home" ? "right" : "left";
  void activate(nextId, direction);
  const nextTab = documentLike.getElementById(`tab-${nextId}`);
  if (nextTab) nextTab.focus();
  return true;
}
