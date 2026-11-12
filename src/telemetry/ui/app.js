let run = JSON.parse(document.getElementById('herd-run').textContent);
const pageSize = 12;
const state = {
  view: 'overview', agent: null, at: null, zoom: 100, hover: null, page: 0,
  search: '', provider: '', status: '', sort: 'id', density: run.agents.length > 12 ? 'compact' : 'comfortable',
  fileSearch: '', treeLimit: 100, rootFiles: false, rootFilesCollapsed: false,
  expanded: new Set(), searchCollapsed: new Set(), fileDetails: new Set(), worktrees: new Set(),
  flags: new Set(), flagLimits: new Map(), errors: new Set(), recoveryLimits: new Map(), agentDetails: new Set()
};
const renderers = { overview, agents, timeline, context: contexts, environments, errors };
const titles = {
  overview: 'Run overview', agents: 'Inside the agent panes', timeline: 'Every operation, in time',
  context: 'Where the context went', environments: 'One repo, many worktrees', errors: 'What went wrong'
};
const tooltip = document.getElementById('tooltip');
const rendered = new Map();
let pendingFrame = null;

function updateAttributes(current, next) {
  for (const attribute of [...current.attributes]) {
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of [...next.attributes]) {
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  }
}

function matchingNode(current, next, id, used) {
  if (used.has(current) || current?.nodeType !== next.nodeType || current?.nodeName !== next.nodeName) return false;
  return Boolean(id || current.nodeType !== 1 || !current.hasAttribute('data-key'));
}

function reconcile(parent, source) {
  const old = [...parent.childNodes];
  const keyed = new Map(old.filter(node => node.nodeType === 1 && node.hasAttribute('data-key'))
    .map(node => [node.getAttribute('data-key'), node]));
  const used = new Set();
  [...source.childNodes].forEach((next, index) => {
    const id = next.nodeType === 1 && next.getAttribute('data-key');
    let current = id ? keyed.get(id) : old[index];
    if (!matchingNode(current, next, id, used)) current = null;
    if (!current) {
      current = next.cloneNode(true);
    } else if (next.nodeType === 3) {
      if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    } else {
      updateAttributes(current, next);
      if (current instanceof HTMLInputElement && current.value !== next.value) current.value = next.value;
      reconcile(current, next);
      if (current instanceof HTMLSelectElement && current.value !== next.value) current.value = next.value;
    }
    used.add(current);
    if (parent.childNodes[index] !== current) parent.insertBefore(current, parent.childNodes[index] || null);
  });
  for (const node of old) {
    if (!used.has(node)) node.remove();
  }
}

function put(id, html) {
  if (rendered.get(id) === html) return;
  const template = document.createElement('template');
  template.innerHTML = html;
  reconcile(document.getElementById(id), template.content);
  rendered.set(id, html);
}

function hideTooltip() {
  state.hover = null;
  tooltip.hidden = true;
}

function refreshTooltip() {
  if (!state.hover) return;
  const section = document.getElementById(`view-${state.view}`);
  const target = [...section.querySelectorAll('[data-tip]')].find(node => node.dataset.key === state.hover.key);
  if (!target) return hideTooltip();
  tooltip.textContent = target.dataset.tip;
  tooltip.hidden = false;
  tooltip.style.left = `${Math.max(12, Math.min(state.hover.x + 14, innerWidth - tooltip.offsetWidth - 12))}px`;
  tooltip.style.top = `${Math.max(12, Math.min(state.hover.y + 14, innerHeight - tooltip.offsetHeight - 12))}px`;
}

function renderHeading() {
  const mode = live ? 'LIVE OBSERVABILITY' : 'SESSION ARCHIVE';
  put('run-heading', `<div class="heading"><div>
    <div class="eyebrow">${mode} / ${esc(run.session)}</div><h1>${titles[state.view]}</h1>
    <div class="path">${esc(run.repo || 'Repository unavailable')}</div></div>
    <div class="heading-meta">${esc(run.window.start?.slice(0, 10))}<br>
      ${clock(run.window.start)} - ${clock(run.window.end)} UTC</div>
  </div>`);
  put('rail-meta', `<div class="eyebrow">SESSION</div><b>${esc(run.session)}</b>
    <div class="muted">${run.agents.length} agents<br>${duration(run.totals.wallSeconds)} elapsed</div>`);
  put('footer', `<span>herd / ${esc(run.session)} · snapshot v${n(run.version)}</span>
    <span>Updated ${clock(run.generatedAt)} UTC · ${live ? 'full snapshots via SSE' : 'self-contained / offline'}</span>`);
}

function render() {
  const scroll = [window.scrollX, window.scrollY];
  const scrollers = [...document.querySelectorAll('.tree-wrap,nav')]
    .map(node => [node, node.scrollLeft, node.scrollTop]);
  renderHeading();
  for (const view of Object.keys(renderers)) {
    document.getElementById(`view-${view}`).hidden = view !== state.view;
  }
  put(`view-${state.view}`, renderers[state.view]());
  document.querySelectorAll('[data-view]').forEach(button => {
    button.setAttribute('aria-current', button.dataset.view === state.view ? 'page' : 'false');
  });
  for (const [node, left, top] of scrollers) {
    node.scrollLeft = left;
    node.scrollTop = top;
  }
  window.scrollTo(...scroll);
  refreshTooltip();
}

function scheduleRender() {
  if (pendingFrame != null || document.hidden) return;
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = null;
    render();
  });
}

function switchView(view) {
  state.view = view;
  state.page = 0;
  hideTooltip();
}

function clearFilters() {
  state.search = '';
  state.provider = '';
  state.status = '';
  state.page = 0;
}

function inspectAgent(button) {
  state.agent = button.dataset.inspect || null;
  state.at = button.dataset.at || null;
  state.zoom = 100;
  clearFilters();
  switchView(state.at ? 'timeline' : 'agents');
  const agents = selectedAgents();
  const index = agents.findIndex(agent => agent.id === state.agent);
  state.page = Math.max(0, Math.floor(index / pageSize));
  if (state.agent) state.agentDetails.add(state.agent);
  render();
  const section = document.getElementById(`view-${state.view}`);
  const selector = state.view === 'agents' ? '.agent-card.selected-agent' : '.lane-name.focus-time';
  (section.querySelector(selector) || section).scrollIntoView({ block: 'center' });
}

function toggle(set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

function handleClick(event) {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  const data = button.dataset;
  if ('inspect' in data) return inspectAgent(button);
  if (data.view) switchView(data.view);
  if ('directory' in data) {
    toggle(state.fileSearch.trim() ? state.searchCollapsed : state.expanded, data.directory);
  }
  if (data.fileDetails) toggle(state.fileDetails, data.fileDetails);
  if (data.worktree) toggle(state.worktrees, data.worktree);
  if (data.flagKind) toggle(state.flags, data.flagKind);
  if (data.error) toggle(state.errors, data.error);
  if (data.agentDetails) toggle(state.agentDetails, data.agentDetails);
  if (data.moreFlags) {
    state.flagLimits.set(data.moreFlags, (state.flagLimits.get(data.moreFlags) || pageSize) + pageSize);
  }
  if (data.moreRecoveries) {
    state.recoveryLimits.set(data.moreRecoveries, (state.recoveryLimits.get(data.moreRecoveries) || pageSize) + pageSize);
  }
  if ('page' in data) {
    state.page = Math.max(0, Number(data.page));
    render();
    document.getElementById(`view-${state.view}`).scrollIntoView({ block: 'start' });
    return;
  }
  if ('clearFilters' in data) clearFilters();
  if ('collapseTree' in data) {
    state.expanded.clear();
    state.fileDetails.clear();
    state.fileSearch = '';
    state.rootFiles = false;
    state.treeLimit = 100;
  }
  if ('rootFiles' in data) {
    if (state.fileSearch.trim()) state.rootFilesCollapsed = !state.rootFilesCollapsed;
    else state.rootFiles = !state.rootFiles;
  }
  if ('moreFiles' in data) state.treeLimit += 100;
  if ('reset' in data) {
    state.zoom = 100;
    state.at = null;
    state.agent = null;
  }
  render();
}

function handleInput(event) {
  const input = event.target;
  if (input.id === 'zoom') {
    state.zoom = Number(input.value);
  } else if (input.dataset.control) {
    state[input.dataset.control] = input.value;
    state.page = 0;
    if (input.dataset.control === 'fileSearch') {
      state.treeLimit = 100;
      state.searchCollapsed.clear();
      state.rootFilesCollapsed = false;
    }
  } else {
    return;
  }
  hideTooltip();
  scheduleRender();
}

function bindInteractions() {
  document.addEventListener('click', handleClick);
  document.addEventListener('input', handleInput);
  document.addEventListener('visibilitychange', scheduleRender);
  document.addEventListener('pointerover', event => {
    const target = event.target.closest('[data-tip]');
    if (!target) return;
    state.hover = { key: target.dataset.key, x: event.clientX, y: event.clientY };
    refreshTooltip();
  });
  document.addEventListener('pointerout', event => {
    const target = event.target.closest('[data-tip]');
    if (target && !target.contains(event.relatedTarget)) hideTooltip();
  });
  document.addEventListener('focusin', event => {
    const target = event.target.closest('[data-tip]');
    if (!target) return;
    const rect = target.getBoundingClientRect();
    state.hover = { key: target.dataset.key, x: rect.left, y: rect.bottom };
    refreshTooltip();
  });
  document.addEventListener('focusout', hideTooltip);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hideTooltip();
  });
}

function validSnapshot(next) {
  const arrays = ['agents', 'files', 'flags', 'quota', 'errorClusters'];
  return next?.version === 1 && next.window && next.totals && arrays.every(name => Array.isArray(next[name]));
}

function connectLive() {
  const indicator = document.getElementById('connection');
  const connection = (text, className) => {
    indicator.textContent = text;
    indicator.className = className;
  };
  const events = new EventSource('/events');
  events.addEventListener('open', () => connection('● Connected · awaiting snapshot', 'connected'));
  events.addEventListener('error', () => connection('● Reconnecting · showing last snapshot', 'retrying'));
  events.addEventListener('run', event => {
    try {
      const next = JSON.parse(event.data);
      if (!validSnapshot(next)) throw new Error('Invalid snapshot');
      run = next;
      scheduleRender();
      connection(`● Live · ${clock(run.generatedAt)} UTC`, 'connected');
    } catch {
      connection('● Snapshot unreadable · waiting for next update', 'retrying');
    }
  });
}

bindInteractions();
render();
if (live) connectLive();
