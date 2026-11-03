import * as herdr from './herdr.js';

export function pruneOverflowTabs(ledger, anchor) {
  const tabs = new Map(herdr.tabList(anchor.workspace).map((tab) => [tab.tab_id, tab]));
  const closed = [];
  for (const tab of ledger.tabs) {
    const live = tabs.get(tab.tab_id);
    if (live?.pane_count === 0) herdr.tabClose(tab.tab_id);
    if (!live || live.pane_count === 0) closed.push(tab.label);
  }
  ledger.tabs = ledger.tabs.filter((tab) => !closed.includes(tab.label));
  return closed;
}

export function closePaneIfLive(anchor, paneId) {
  if (paneId && herdr.paneList(anchor.workspace).some((pane) => pane.pane_id === paneId)) herdr.paneClose(paneId);
}
