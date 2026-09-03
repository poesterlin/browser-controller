export function selectControlTab(tabs, controlTabId) {
  if (!Number.isInteger(controlTabId)) return null;
  return tabs.find((tab) => tab.id === controlTabId) ?? null;
}
