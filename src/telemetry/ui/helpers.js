const live = document.body.dataset.live === 'true';
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
const n = value => value == null ? 'unknown' : Number(value).toLocaleString('en-US');
const money = value => value == null ? 'unknown' : `$${value.toFixed(2)}`;
const ms = value => value ? Date.parse(value) : NaN;
const clock = value => Number.isFinite(ms(value)) ? new Date(value).toISOString().slice(11, 19) : 'unknown';
const percent = value => Math.max(0, Math.min(100, value));
const key = (...values) => values.join('|');
const empty = message => `<div class="empty">${esc(message)}</div>`;
const tip = (id, text) => `data-key="${esc(id)}" data-tip="${esc(text)}" tabindex="0"`;
const active = agent => live && run.live && agent.activity && agent.activity.kind !== 'done';
const status = agent => active(agent) ? agent.activity.kind : agent.state;

function compact(value) {
  if (value == null) return 'unknown';
  if (value >= 1000000) return `${(value / 1000000).toFixed(1).replace(/\.0$/, '')}m`;
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return n(value);
}

function duration(value) {
  if (value == null) return 'unknown';
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
  return `${Math.floor(value / 3600)}h ${Math.floor(value % 3600 / 60)}m`;
}

function badge(agent) {
  return `<span class="badge ${esc(status(agent))}"><i class="dot"></i>${esc(status(agent))}</span>`;
}

function panel(title, body, extra = '') {
  return `<div class="panel">
    <div class="panel-title"><h2>${title}</h2>${extra}</div>${body}
  </div>`;
}

function intro(title, description) {
  return `<div class="section-intro"><h2>${title}</h2><p>${description}</p></div>`;
}

function link(agent, at, label = 'Inspect →') {
  return `<button data-inspect="${esc(agent || '')}" data-at="${esc(at || '')}">${esc(label)}</button>`;
}

function select(id, label, values, selected, allLabel) {
  const controlId = `${state.view}-${id}`;
  const options = values.map(([value, text]) =>
    `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(text)}</option>`
  ).join('');
  return `<label for="${controlId}">${label}</label><select id="${controlId}" data-control="${id}">
    ${allLabel ? `<option value="">${allLabel}</option>` : ''}${options}
  </select>`;
}

function selectedAgents() {
  const query = state.search.trim().toLowerCase();
  const agents = run.agents.filter(agent => {
    const matchesProvider = !state.provider || agent.provider === state.provider;
    const matchesStatus = !state.status || status(agent) === state.status;
    const matchesQuery = `${agent.id} ${agent.task} ${agent.model || ''}`.toLowerCase().includes(query);
    return matchesProvider && matchesStatus && matchesQuery;
  });
  const byId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });
  agents.sort((a, b) => {
    if (state.sort === 'errors') return b.errors - a.errors || byId(a, b);
    if (state.sort === 'cost') return (b.cost.usd ?? -1) - (a.cost.usd ?? -1) || byId(a, b);
    if (state.sort === 'provider') return a.provider.localeCompare(b.provider) || byId(a, b);
    if (state.sort === 'state') return status(a).localeCompare(status(b)) || byId(a, b);
    return byId(a, b);
  });
  return agents;
}

function agentControls(agents) {
  const providers = [...new Set(run.agents.map(agent => agent.provider))].sort();
  const statuses = [...new Set(run.agents.map(status))].sort();
  if (state.provider && !providers.includes(state.provider)) providers.push(state.provider);
  if (state.status && !statuses.includes(state.status)) statuses.push(state.status);
  const sorts = [['id', 'Agent ID'], ['state', 'State'], ['provider', 'Provider'], ['errors', 'Most errors'], ['cost', 'Highest cost']];
  return `<div class="toolbar agent-controls">
    <label for="${state.view}-search">Find agent</label>
    <input id="${state.view}-search" data-control="search" type="search"
      value="${esc(state.search)}" placeholder="ID, task or model">
    ${select('provider', 'Provider', providers.map(value => [value, value]), state.provider, 'All providers')}
    ${select('status', 'State', statuses.map(value => [value, value]), state.status, 'All states')}
    ${select('sort', 'Sort', sorts, state.sort)}
    ${select('density', 'Density', [['comfortable', 'Comfortable'], ['compact', 'Compact']], state.density)}
    <span role="status">${n(agents.length)} / ${n(run.agents.length)} agents</span>
    <button data-clear-filters>Clear filters</button>
  </div>`;
}

function pageItems(items) {
  const lastPage = Math.max(0, Math.ceil(items.length / pageSize) - 1);
  state.page = Math.min(state.page, lastPage);
  return items.slice(state.page * pageSize, (state.page + 1) * pageSize);
}

function pagination(items) {
  if (items.length <= pageSize) return '';
  return `<div class="toolbar pagination">
    <button data-page="${state.page - 1}" ${state.page === 0 ? 'disabled' : ''}>Previous</button>
    <span>Page ${state.page + 1} of ${Math.ceil(items.length / pageSize)} · ${pageSize} per page</span>
    <button data-page="${state.page + 1}" ${(state.page + 1) * pageSize >= items.length ? 'disabled' : ''}>Next</button>
  </div>`;
}
