const severityOrder = { error: 0, warn: 1, info: 2 };

function metricCards() {
  const totals = run.totals;
  const tokenTotal = Object.values(totals.tokens).reduce((sum, value) => sum + (value || 0), 0);
  const agentHint = live ? `${run.agents.filter(active).length} active now` : 'recorded in snapshot';
  const metrics = [
    ['Known cost', money(totals.costUsd), totals.costExact ? 'exact' : 'partial / estimated'],
    ['Tokens', compact(tokenTotal), 'input + output + cache'],
    ['Wall time', duration(totals.wallSeconds), 'shared run window'],
    ['Agents', n(totals.agents), agentHint],
    ['Tool calls', n(totals.toolCalls), 'across all providers'],
    ['Errors', n(totals.errors), `${run.errorClusters.length} signatures`]
  ];
  return `<div class="metrics">${metrics.map(([label, value, hint]) => `<div class="metric">
    <div class="metric-label">${label}</div><div class="metric-value">${value}</div><small>${hint}</small>
  </div>`).join('')}</div>`;
}

function flagRow(flag, index) {
  const time = flag.at ? ` · ${clock(flag.at)} UTC` : '';
  return `<div class="flag" data-key="flag-${index}">
    <span class="badge ${esc(flag.severity)}">${esc(flag.severity)}</span>
    <div>${esc(flag.message)}<div class="flag-meta">${esc(flag.agent || 'run-wide')}${time}</div></div>
    ${link(flag.agent, flag.at)}
  </div>`;
}

function flagGroups() {
  const groups = new Map();
  for (const flag of run.flags) {
    if (!groups.has(flag.kind)) groups.set(flag.kind, []);
    groups.get(flag.kind).push(flag);
  }
  const ordered = [...groups].sort((a, b) => {
    const rank = flags => Math.min(...flags.map(flag => severityOrder[flag.severity] ?? 2));
    return rank(a[1]) - rank(b[1]) || a[0].localeCompare(b[0]);
  });
  return ordered.map(([kind, flags]) => {
    flags.sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2));
    const open = state.flags.has(kind);
    const limit = state.flagLimits.get(kind) || pageSize;
    const severity = flags[0].severity;
    const contents = open ? flags.slice(0, limit).map(flagRow).join('') : '';
    const more = open && flags.length > limit
      ? `<button class="show-more" data-more-flags="${esc(kind)}">Show next ${Math.min(pageSize, flags.length - limit)}</button>`
      : '';
    return `<div class="flag-group" data-key="flag-group-${esc(kind)}">
      <button class="group-toggle" data-flag-kind="${esc(kind)}" aria-expanded="${open}">
        <span>${open ? '▾' : '▸'} ${esc(kind.replaceAll('_', ' '))}</span>
        <span class="badge ${esc(severity)}">${n(flags.length)}</span>
      </button>${contents}${more}
    </div>`;
  }).join('') || empty('No flags for this run');
}

function quotaRow(quota) {
  const known = quota.startPercent != null && quota.endPercent != null;
  const consumed = known ? quota.startPercent - quota.endPercent : null;
  let label = 'unavailable';
  if (known) label = consumed < 0 ? 'window reset / replenished' : `${consumed.toFixed(1)} pp used`;
  return `<div class="quota-row" data-key="quota-${esc(quota.provider)}">
    <div class="row"><strong>${esc(quota.provider)}</strong><span>${label}</span></div>
    <div class="bar"><i style="--amount:${known ? percent(consumed) : 0}%"></i></div>
    <small>${quota.startPercent ?? '?'}% → ${quota.endPercent ?? '?'}% remaining</small>
  </div>`;
}

function tokenLedger() {
  const labels = { input: 'Input', output: 'Output', cacheRead: 'Cache read', cacheWrite: 'Cache write' };
  const rows = Object.entries(run.totals.tokens).map(([name, count]) =>
    `<div class="row"><span class="muted">${labels[name]}</span><span>${n(count)}</span></div>`
  ).join('');
  return panel('Token ledger', `<div class="panel-body">${rows}</div>`);
}

function overview() {
  const quota = run.quota.map(quotaRow).join('') || empty('Quota measurements unavailable');
  const quotaPanel = panel('Provider quota', `<div class="panel-body">${quota}
    <p class="help-text">Percentage points of remaining quota consumed. Resets are shown separately.</p>
  </div>`);
  const flags = panel('Attention queue', flagGroups(), `<span class="badge">${n(run.flags.length)} flags</span>`);
  return `${metricCards()}<div class="grid overview-grid">${flags}
    <div>${quotaPanel}<div class="ledger">${tokenLedger()}</div></div>
  </div>`;
}

function agentActivity(agent) {
  const current = active(agent);
  const label = current ? esc(agent.activity.label || agent.activity.kind) : `History · ${esc(agent.state)}`;
  return `<div class="activity ${current ? 'current' : ''}">
    <i class="dot ${current ? 'pulse' : ''}"></i><span>${label}</span>
    ${current ? `<small>since ${clock(agent.activity.since)}</small>` : ''}
  </div>`;
}

function agentCost(agent) {
  let cost = money(agent.cost.usd);
  if (agent.cost.usd == null && agent.cost.quotaPercent != null) cost = `${agent.cost.quotaPercent}% quota`;
  const tokens = agent.tokens;
  const tokenTotal = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return `<div><div class="metric-label">${agent.cost.usd == null ? 'Quota / cost' : 'Cost'}</div>
    <div class="cost">${cost}</div>
    <small>${agent.cost.exact ? 'exact' : 'estimated / incomplete'} · ${compact(tokenTotal)} tokens
      ${tokens.exact ? '' : '(partial)'}</small>
  </div>`;
}

function agentContext(agent) {
  const context = agent.context;
  const latest = context.series.at(-1)?.size ?? context.peak;
  const amount = context.window && latest != null ? percent(latest / context.window * 100) : 0;
  return `<div><div class="metric-label">Context · latest</div><div class="context-summary"><div>
    <strong>${compact(latest)}</strong> <small>/ ${compact(context.window)}</small>
    <div class="bar"><i class="${amount > 80 ? 'hot' : ''}" style="--amount:${amount}%"></i></div>
    <small>peak ${compact(context.peak)}</small></div>${sparkline(agent)}</div>
    ${context.series.length ? '' : '<small>No context samples available</small>'}
  </div>`;
}

function agentDetails(agent) {
  return `<div class="histograms">
    ${histogram(agent.tools, 'Tools', agent)}${histogram(agent.shell, 'Shell categories', agent)}
  </div>${timelineSvg(agent, true)}<div class="row">
    <small>${duration(agent.time.model)} model · ${duration(agent.time.tool)} tools · ${duration(agent.time.idle)} idle</small>
    <span class="${agent.errors ? 'error' : 'muted'}">${n(agent.errors)} errors</span>
  </div>`;
}

function agentCard(agent) {
  const compactMode = state.density === 'compact';
  const open = !compactMode || state.agentDetails.has(agent.id);
  const failover = agent.segments.length > 1
    ? `<div class="agent-sub">Failover: ${agent.segments.map(segment => esc(segment.provider)).join(' → ')}</div>` : '';
  return `<article class="panel agent-card ${state.agent === agent.id ? 'selected-agent' : ''}"
    data-key="agent-${esc(agent.id)}">
    <div class="panel-title"><h2 class="agent-id">${esc(agent.id)}</h2>${badge(agent)}</div>
    <div class="panel-body"><h3 class="agent-task">${esc(agent.task)}</h3>
      <div class="agent-sub">${esc(agent.provider)} / ${esc(agent.model || 'model unknown')} ·
        ${esc(agent.tier)} · ${esc(agent.mode)} · ${n(agent.rounds)} rounds</div>${failover}
      ${agentActivity(agent)}<div class="stats-pair">${agentCost(agent)}${agentContext(agent)}</div>
      ${compactMode ? `<button class="details-toggle" data-agent-details="${esc(agent.id)}" aria-expanded="${open}">
        ${open ? 'Hide' : 'Show'} tools and timeline · ${n(agent.errors)} errors</button>` : ''}
      ${open ? agentDetails(agent) : ''}
    </div>
  </article>`;
}

function agents() {
  const filtered = selectedAgents();
  const items = pageItems(filtered);
  return intro('Agent panes', 'Resources, work and current activity') + agentControls(filtered)
    + pagination(filtered)
    + `<div class="grid agent-grid ${state.density}">${items.map(agentCard).join('')}</div>`
    + (items.length ? '' : empty('No agents match these filters')) + pagination(filtered);
}

function timelineLane(agent) {
  return `<div data-key="lane-name-${esc(agent.id)}" class="lane-name ${state.agent === agent.id ? 'focus-time' : ''}">
    ${esc(agent.id)}<small>${esc(agent.provider)} · ${esc(status(agent))}</small>
  </div><div data-key="lane-${esc(agent.id)}" class="lane">${timelineSvg(agent)}</div>`;
}

function timelineLegend() {
  const kinds = ['model', 'read', 'edit', 'test', 'background', 'idle', 'blocked', 'queued'];
  const legend = kinds.map(kind =>
    `<span><i class="swatch" style="--swatch:var(--${colors[kind]})"></i>${kind}</span>`
  ).join('');
  return `<div class="panel-body legend">${legend}<span><i style="color:var(--peach)">│</i>prompt</span>
    <span><i class="dot working ${live ? 'pulse' : ''}"></i>current</span>
  </div>`;
}

function timeline() {
  const filtered = selectedAgents();
  const items = pageItems(filtered);
  const [start, end] = bounds();
  const ticks = [0, .25, .5, .75, 1].map(fraction =>
    `<span>${clock(new Date(start + fraction * (end - start)).toISOString()).slice(0, 5)}</span>`
  ).join('');
  const focus = state.at ? `<span class="focus-time">Focus ${clock(state.at)} UTC ${esc(state.agent || '')}</span>` : '';
  return intro('Shared timeline', 'UTC · prompt ticks above · background jobs below') + agentControls(filtered)
    + pagination(filtered) + `
    <div class="toolbar"><label for="zoom">Visible window</label>
      <input id="zoom" type="range" min="10" max="100" step="10" value="${state.zoom}">
      <span>${state.zoom}%</span><button data-reset>Reset range</button>${focus}
    </div><div class="panel"><div class="timeline-grid ${state.density}">
      <div class="lane-name muted">Agent / provider</div><div class="axis">${ticks}</div>
      ${items.map(timelineLane).join('')}</div>
      ${items.length ? '' : empty('No agents match these filters')}${timelineLegend()}
    </div>${pagination(filtered)}<p class="help-text">Hover or focus a segment for details. Older operations fade in live mode.</p>`;
}

function contextCard(agent) {
  return `<div class="panel" data-key="context-card-${esc(agent.id)}">
    <div class="panel-title"><h2>${esc(agent.id)}</h2><span class="badge">${esc(agent.provider)}</span></div>
    <div class="panel-body">${contextChart(agent)}<div class="context-foot">
      <span>Peak ${compact(agent.context.peak)}</span><span>Window ${compact(agent.context.window)}</span>
    </div></div>
  </div>`;
}

function contexts() {
  const filtered = selectedAgents();
  const items = pageItems(filtered);
  return intro('Context growth', 'Step lines per model request · hover for own / tool attribution') + agentControls(filtered)
    + pagination(filtered)
    + `<div class="grid">${items.map(contextCard).join('')}</div>`
    + (items.length ? '' : empty('No agents match these filters')) + pagination(filtered);
}

function recoveryRow(agent, index) {
  return `<div class="recovery" data-key="recovery-${index}">
    <div>${link(agent.id, agent.at, agent.id)}<small>${clock(agent.at)} UTC</small></div>
    <div>${agent.recovery ? esc(agent.recovery) : '<span class="muted">No recovery recorded</span>'}</div>
  </div>`;
}

function errorCluster(cluster, index) {
  const open = state.errors.has(cluster.signature);
  const limit = state.recoveryLimits.get(cluster.signature) || pageSize;
  const more = open && cluster.agents.length > limit
    ? `<button class="show-more" data-more-recoveries="${esc(cluster.signature)}">Show more recoveries</button>` : '';
  return `<div class="panel error-cluster" data-key="error-${index}">
    <div class="panel-title"><span class="badge error">${n(cluster.count)} occurrences</span>
      <small>${esc(cluster.family)} · ${new Set(cluster.agents.map(agent => agent.id)).size} agents</small>
    </div><div class="panel-body signature">${esc(cluster.signature)}</div>
    <button class="group-toggle" data-error="${esc(cluster.signature)}" aria-expanded="${open}">
      ${open ? '▾ Hide' : '▸ Show'} recovery details (${n(cluster.agents.length)})
    </button>${open ? cluster.agents.slice(0, limit).map(recoveryRow).join('') : ''}${more}
  </div>`;
}

function errors() {
  return intro('Error signatures', 'Shared failures and recorded recovery')
    + (run.errorClusters.map(errorCluster).join('') || empty('No errors recorded'));
}
