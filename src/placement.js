const CELL_ASPECT = 2.2;

export function chooseSplit(layoutPanes, anchorPaneId) {
  const [target] = [...layoutPanes].sort((a, b) => {
    const areaDiff = b.rect.width * b.rect.height - a.rect.width * a.rect.height;
    if (areaDiff !== 0) return areaDiff;
    return Number(a.pane_id === anchorPaneId) - Number(b.pane_id === anchorPaneId);
  });
  const direction = target.rect.width >= target.rect.height * CELL_ASPECT ? 'right' : 'down';
  return { pane: target.pane_id, direction };
}

export function chooseTab(candidateTabIds, paneCounts, maxPanes) {
  return candidateTabIds.find((tabId) => (paneCounts.get(tabId) ?? 0) < maxPanes) ?? null;
}

export function nextOverflowLabel(existingLabels) {
  let n = 2;
  while (existingLabels.includes(`herd-${n}`)) n += 1;
  return `herd-${n}`;
}
