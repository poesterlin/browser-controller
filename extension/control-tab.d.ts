export interface BrowserTab {
  id?: number;
  url?: string;
  active?: boolean;
  windowId?: number;
}

export function selectControlTab(
  tabs: BrowserTab[],
  controlTabId: number | null | undefined,
): BrowserTab | null;
