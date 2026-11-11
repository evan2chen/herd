(() => {
  'use strict';
  let run = JSON.parse(document.getElementById('herd-run').textContent);
  const live = document.body.dataset.live === 'true';
  const state = { view: 'overview', agent: null, at: null, zoom: 100, expanded: new Map(), hover: null };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = value => value == null ? 'unknown' : Number(value).toLocaleString('en-US');
  const compact = value => value == null ? 'unknown' : value >= 1000000 ? `${(value / 1000000).toFixed(1).replace(/\.0$/, '')}m` : value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k` : n(value);
  const duration = value => value == null ? 'unknown' : value < 60 ? `${Math.round(value)}s` : value < 3600 ? `${Math.floor(value / 60)}m ${Math.round(value % 60)}s` : `${Math.floor(value / 3600)}h ${Math.floor(value % 3600 / 60)}m`;
  const money = value => value == null ? 'unknown' : `$${value.toFixed(2)}`;
  const ms = value => value ? Date.parse(value) : NaN;
  const clock = value => value && Number.isFinite(ms(value)) ? new Date(value).toISOString().slice(11, 19) : 'unknown';
  const empty = message => `<div class="empty">${esc(message)}</div>`;
  const key = (...values) => values.join('|');
  const tip = (id, text) => `data-key="${esc(id)}" data-tip="${esc(text)}" tabindex="0"`;
  const active = agent => live && run.live && agent.activity && agent.activity.kind !== 'done';
  const status = agent => active(agent) ? agent.activity.kind : agent.state;
  const colors = { model: 'mauve', tool: 'blue', background: 'teal', idle: 'overlay', blocked: 'red', queued: 'yellow', read: 'blue', edit: 'green', test: 'yellow', build: 'peach', render: 'mauve', install: 'teal', git: 'peach', script: 'blue', cleanup: 'overlay', other: 'blue' };
  const color = segment => `var(--${(segment.kind === 'tool' && colors[segment.category]) || colors[segment.kind] || 'blue'})`;
  const badge = agent => `<span class="badge ${esc(status(agent))}"><i class="dot"></i>${esc(status(agent))}</span>`;
  const panel = (title, body, extra = '') => `<div class="panel"><div class="panel-title"><h2>${title}</h2>${extra}</div>${body}</div>`;
  const age = time => live ? Math.max(.4, 1 - Math.max(0, ms(run.window.end) - ms(time)) / Math.max(1, ms(run.window.end) - ms(run.window.start)) * .6) : .85;
  const bounds = () => {
    const start = ms(run.window.start);
    const end = Math.max(start + 1000, ms(run.window.end));
    const span = (end - start) * state.zoom / 100;
    const center = state.at ? ms(state.at) : end - span / 2;
    const from = Math.max(start, Math.min(end - span, center - span / 2));
    return [from, from + span];
  };
  const percent = value => Math.max(0, Math.min(100, value));
  const link = (agent, at, label = 'Inspect →') => `<button data-inspect="${esc(agent || '')}" data-at="${esc(at || '')}">${esc(label)}</button>`;
  const intro = (title, description) => `<div class="section-intro"><h2>${title}</h2><p>${description}</p></div>`;

  function reconcile(parent, source) {
    const old = [...parent.childNodes];
    const keyed = new Map(old.filter(node => node.nodeType === 1 && node.hasAttribute('data-key')).map(node => [node.getAttribute('data-key'), node]));
    const used = new Set();
    [...source.childNodes].forEach((next, index) => {
      const id = next.nodeType === 1 && next.getAttribute('data-key');
      let current = id ? keyed.get(id) : old[index];
      if (used.has(current) || current?.nodeType !== next.nodeType || current?.nodeName !== next.nodeName || (!id && current?.nodeType === 1 && current.hasAttribute('data-key'))) current = null;
      if (!current) current = next.cloneNode(true);
      else if (next.nodeType === 3) {
        if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
      } else {
        for (const attr of [...current.attributes]) if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
        for (const attr of [...next.attributes]) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
        if (current instanceof HTMLInputElement && current.value !== next.value) current.value = next.value;
        reconcile(current, next);
      }
      used.add(current);
      if (parent.childNodes[index] !== current) parent.insertBefore(current, parent.childNodes[index] || null);
    });
    for (const node of old) if (!used.has(node)) node.remove();
  }

  function put(id, html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    reconcile(document.getElementById(id), template.content);
  }

  function overview() {
    const t = run.totals;
    const tokenTotal = Object.values(t.tokens).reduce((sum, value) => sum + (value || 0), 0);
    const metrics = [
      ['Known cost', money(t.costUsd), t.costExact ? 'exact' : 'partial / estimated'],
      ['Tokens', compact(tokenTotal), 'input + output + cache'],
      ['Wall time', duration(t.wallSeconds), 'shared run window'],
      ['Agents', n(t.agents), live ? `${run.agents.filter(a => active(a)).length} active now` : 'recorded in snapshot'],
      ['Tool calls', n(t.toolCalls), 'across all providers'],
      ['Errors', n(t.errors), `${run.errorClusters.length} signatures`]
    ];
    const flags = [...run.flags].sort((a, b) => ({ error: 0, warn: 1, info: 2 }[a.severity] - { error: 0, warn: 1, info: 2 }[b.severity]));
    const quota = run.quota.map(q => {
      const known = q.startPercent != null && q.endPercent != null;
      const consumed = known ? q.startPercent - q.endPercent : null;
      return `<div class="quota-row" data-key="quota-${esc(q.provider)}"><div class="row"><strong>${esc(q.provider)}</strong><span>${known ? consumed < 0 ? 'window reset / replenished' : `${consumed.toFixed(1)} pp used` : 'unavailable'}</span></div><div class="bar"><i style="--amount:${known ? percent(consumed) : 0}%"></i></div><small>${q.startPercent ?? '?'}% → ${q.endPercent ?? '?'}% remaining</small></div>`;
    }).join('');
    return `<div class="metrics">${metrics.map(([label, value, hint]) => `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><small>${hint}</small></div>`).join('')}</div><div class="grid overview-grid">${panel('Attention queue', flags.length ? flags.map((f, i) => `<div class="flag" data-key="flag-${i}"><span class="badge ${esc(f.severity)}">${esc(f.severity)}</span><div>${esc(f.message)}<div class="flag-meta">${esc(f.kind.replaceAll('_', ' '))} · ${esc(f.agent || 'run-wide')}${f.at ? ` · ${clock(f.at)} UTC` : ''}</div></div>${link(f.agent, f.at)}</div>`).join('') : empty('No flags for this run'), `<span class="badge">${flags.length} flags</span>`)}<div>${panel('Provider quota', `<div class="panel-body">${quota || empty('Quota measurements unavailable')}<p class="muted" style="font-size:10px;margin-top:16px">Percentage points of remaining quota consumed. Resets are shown separately.</p></div>`)}<div style="margin-top:18px">${panel('Token ledger', `<div class="panel-body">${Object.entries(t.tokens).map(([name, count]) => `<div class="row"><span class="muted">${({ input: 'Input', output: 'Output', cacheRead: 'Cache read', cacheWrite: 'Cache write' })[name]}</span><span>${n(count)}</span></div>`).join('')}</div>`)}</div></div></div>`;
  }

  function histogram(rows, title, agent) {
    const max = Math.max(1, ...rows.map(row => row.count));
    return `<div><h3>${title}</h3>${rows.length ? rows.map(row => `<div class="hist-row" ${tip(key(agent.id, title, row.name || row.category), `${row.name || row.category}: ${n(row.count)} calls\n${duration(row.seconds)} · ${n(row.errors)} errors`)}><span>${esc(row.name || row.category)}</span><div class="bar"><i style="--amount:${row.count / max * 100}%"></i></div><span>${n(row.count)}</span></div>`).join('') : '<small>No calls recorded</small>'}</div>`;
  }

  function sparkline(agent) {
    const points = agent.context.series;
    if (!points.length) return '';
    const max = Math.max(1, ...points.map(p => p.size));
    const start = ms(points[0].at);
    const span = Math.max(1, ms(points.at(-1).at) - start);
    const path = points.map((p, i) => `${i ? 'H' : 'M'}${((ms(p.at) - start) / span * 86 + 2).toFixed(1)}${i ? 'V' : ','}${(40 - p.size / max * 36).toFixed(1)}`).join(' ');
    return `<svg class="sparkline" viewBox="0 0 90 44" aria-label="Context sparkline"><path d="${path}"/></svg>`;
  }

  function timelineSvg(agent, mini = false) {
    const [start, end] = mini ? [ms(run.window.start), Math.max(ms(run.window.start) + 1000, ms(run.window.end))] : bounds();
    const x = at => percent((ms(at) - start) / (end - start) * 100) * 10;
    const segments = agent.timeline.map((s, index) => {
      if (ms(s.end) < start || ms(s.start) > end) return '';
      const current = active(agent) && s.kind === agent.activity.kind && ms(s.start) <= ms(agent.activity.since) && ms(s.end) > ms(agent.activity.since);
      const text = `${agent.id}\n${s.label || s.tool || s.kind}${s.category ? ` · ${s.category}` : ''}\n${clock(s.start)} - ${clock(s.end)} UTC · ${duration((ms(s.end) - ms(s.start)) / 1000)}${current ? '\nCurrent operation' : ''}`;
      return `<rect ${tip(key('segment', agent.id, s.start, s.kind, index, mini), text)} class="chart-mark ${current ? 'pulse' : ''}" x="${x(s.start)}" y="${s.kind === 'background' ? 49 : 19}" width="${Math.max(2, x(s.end) - x(s.start))}" height="${s.kind === 'background' ? 5 : 23}" rx="2" fill="${color(s)}" opacity="${current ? 1 : age(s.end)}"/>`;
    }).join('');
    const prompts = agent.prompts.filter(at => ms(at) >= start && ms(at) <= end).map(at => `<path ${tip(key('prompt', agent.id, at, mini), `Prompt · ${clock(at)} UTC`)} class="tick chart-mark" d="M${x(at)} 6v8"/>`).join('');
    const focus = !mini && state.at && ms(state.at) >= start && ms(state.at) <= end ? `<path stroke="var(--peach)" stroke-dasharray="3 3" d="M${x(state.at)} 0v64"/>` : '';
    const current = active(agent) && ms(agent.activity.since) <= end && ms(run.window.end) >= start ? `<path class="live-edge pulse" d="M${Math.min(998, x(run.window.end))} 12v47"/><circle class="pulse" cx="${Math.min(996, x(run.window.end))}" cy="9" r="3" fill="var(--green)"/>` : '';
    return `<svg class="${mini ? 'strip' : ''}" viewBox="0 0 1000 66" preserveAspectRatio="none" aria-label="${esc(agent.id)} activity timeline"><path class="chart-grid" d="M250 0v64 M500 0v64 M750 0v64"/>${segments}${prompts}${focus}${current}</svg>`;
  }

  function agents() {
    return intro('Agent panes', 'Resources, work and current activity') + `<div class="grid agent-grid">${run.agents.map(agent => {
      const c = agent.context;
      const latest = c.series.at(-1)?.size ?? c.peak;
      const cost = agent.cost.usd == null ? agent.cost.quotaPercent == null ? 'Unknown' : `${agent.cost.quotaPercent}% quota` : money(agent.cost.usd);
      const activity = active(agent);
      return `<article class="panel agent-card ${state.agent === agent.id ? 'selected-agent' : ''}" data-key="agent-${esc(agent.id)}"><div class="panel-title"><h2 class="agent-id">${esc(agent.id)}</h2>${badge(agent)}</div><div class="panel-body"><h3 class="agent-task">${esc(agent.task)}</h3><div class="agent-sub">${esc(agent.provider)} / ${esc(agent.model || 'model unknown')} · ${esc(agent.tier)} · ${esc(agent.mode)} · ${n(agent.rounds)} rounds</div>${agent.segments.length > 1 ? `<div class="agent-sub">Failover: ${agent.segments.map(s => esc(s.provider)).join(' → ')}</div>` : ''}<div class="activity ${activity ? 'current' : ''}"><i class="dot ${activity ? 'pulse' : ''}"></i><span>${activity ? esc(agent.activity.label || agent.activity.kind) : `History · ${esc(agent.state)}`}</span>${activity ? `<small>since ${clock(agent.activity.since)}</small>` : ''}</div><div class="stats-pair"><div><div class="metric-label">${agent.cost.usd == null ? 'Quota / cost' : 'Cost'}</div><div class="cost">${cost}</div><small>${agent.cost.exact ? 'exact' : 'estimated / incomplete'} · ${compact(agent.tokens.input + agent.tokens.output + agent.tokens.cacheRead + agent.tokens.cacheWrite)} tokens${agent.tokens.exact ? '' : ' (partial)'}</small></div><div><div class="metric-label">Context · latest</div><div class="context-summary"><div><strong>${compact(latest)}</strong> <small>/ ${compact(c.window)}</small><div class="bar"><i class="${c.window && latest / c.window > .8 ? 'hot' : ''}" style="--amount:${c.window && latest != null ? percent(latest / c.window * 100) : 0}%"></i></div><small>peak ${compact(c.peak)}</small></div>${sparkline(agent)}</div>${!c.series.length ? '<small>No context samples available</small>' : ''}</div></div><div class="histograms">${histogram(agent.tools, 'Tools', agent)}${histogram(agent.shell, 'Shell categories', agent)}</div>${timelineSvg(agent, true)}<div class="row"><small>${duration(agent.time.model)} model · ${duration(agent.time.tool)} tools · ${duration(agent.time.idle)} idle</small><span class="${agent.errors ? 'error' : 'muted'}">${n(agent.errors)} errors</span></div></div></article>`;
    }).join('')}</div>${run.agents.length ? '' : empty('No agents have been queued yet')}`;
  }

  function timeline() {
    const [start, end] = bounds();
    const ticks = [0, .25, .5, .75, 1].map(f => clock(new Date(start + f * (end - start)).toISOString()).slice(0, 5));
    const legend = ['model', 'read', 'edit', 'test', 'background', 'idle', 'blocked', 'queued'].map(kind => `<span><i class="swatch" style="--swatch:var(--${colors[kind]})"></i>${kind}</span>`).join('');
    return intro('Shared timeline', 'UTC · prompt ticks above · background jobs below') + `<div class="toolbar"><label for="zoom">Visible window</label><input id="zoom" type="range" min="10" max="100" step="10" value="${state.zoom}"><span>${state.zoom}%</span><button data-reset>Reset range</button>${state.at ? `<span class="focus-time">Focus ${clock(state.at)} UTC ${esc(state.agent || '')}</span>` : ''}</div><div class="panel"><div class="timeline-grid"><div class="lane-name muted">Agent / provider</div><div class="axis" style="padding-right:16px">${ticks.map(t => `<span>${t}</span>`).join('')}</div>${run.agents.map(agent => `<div data-key="lane-name-${esc(agent.id)}" class="lane-name ${state.agent === agent.id ? 'focus-time' : ''}">${esc(agent.id)}<small>${esc(agent.provider)} · ${esc(status(agent))}</small></div><div data-key="lane-${esc(agent.id)}" class="lane">${timelineSvg(agent)}</div>`).join('')}</div>${run.agents.length ? '' : empty('No activity yet')}<div class="panel-body legend">${legend}<span><i style="color:var(--peach)">│</i>prompt</span><span><i class="dot working ${live ? 'pulse' : ''}"></i>current</span></div></div><p class="muted" style="font-size:10px;margin-top:12px">Hover or focus a segment for details. Older operations fade in live mode.</p>`;
  }

  function contextChart(agent) {
    const points = agent.context.series;
    if (!points.length) return empty('Context unavailable from this provider');
    const max = Math.max(1, agent.context.window || 0, agent.context.peak || 0, ...points.map(p => p.size));
    const start = ms(run.window.start);
    const span = Math.max(1000, ms(run.window.end) - start);
    const x = p => 48 + (ms(p.at) - start) / span * 510;
    const y = p => 142 - p.size / max * 115;
    const steps = points.map((p, i) => `${i ? 'H' : 'M'}${x(p).toFixed(1)}${i ? 'V' : ','}${y(p).toFixed(1)}`).join(' ');
    const jumps = points.map((p, i) => ({ p, delta: i ? p.size - points[i - 1].size : 0 })).filter(p => p.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 2);
    return `<svg class="context-chart" viewBox="0 0 590 170" role="group" aria-label="${esc(agent.id)} context over time"><path class="chart-grid" d="M48 27H558 M48 84H558 M48 142H558"/><text x="0" y="30">${compact(max)}</text><text x="0" y="88">${compact(max / 2)}</text><text x="25" y="146">0</text><path class="area" d="${steps} V142 H${x(points[0])}Z"/><path class="step" d="${steps}"/>${points.map((p, i) => `<circle ${tip(key('context', agent.id, p.at, i), `${clock(p.at)} UTC · ${n(p.size)} context tokens\n${i ? `Jump ${n(p.size - points[i - 1].size)}` : 'Initial sample'} · own ${n(p.own)} / tool ${n(p.tool)}\n${p.cause || 'Cause unavailable'}`)} class="chart-mark" cx="${x(p)}" cy="${y(p)}" r="4"/>`).join('')}${jumps.map(({ p, delta }, i) => `<text class="jump-label" x="${x(p)}" y="${Math.max(14, y(p) - 12 - i * 12)}" text-anchor="${x(p) > 480 ? 'end' : 'start'}">+${compact(delta)}</text>`).join('')}<text x="48" y="165">${clock(run.window.start)}</text><text x="558" y="165" text-anchor="end">${clock(run.window.end)} UTC</text></svg>`;
  }

  function contexts() {
    return intro('Context growth', 'Step lines per model request · hover for own / tool attribution') + `<div class="grid">${run.agents.map(agent => `<div class="panel" data-key="context-card-${esc(agent.id)}"><div class="panel-title"><h2>${esc(agent.id)}</h2><span class="badge">${esc(agent.provider)}</span></div><div class="panel-body">${contextChart(agent)}<div class="context-foot"><span>Peak ${compact(agent.context.peak)}</span><span>Window ${compact(agent.context.window)}</span></div></div></div>`).join('')}</div>${run.agents.length ? '' : empty('No context data yet')}`;
  }

  function currentFile(agent, path) {
    if (!active(agent) || !['tool', 'background'].includes(agent.activity.kind)) return false;
    const label = (agent.activity.label || '').replaceAll('\\', '/');
    return label.split(/[\s"'`():;,]+/).some(token => token === path || token.endsWith(`/${path}`));
  }

  function fileTree() {
    const root = { children: new Map(), path: '' };
    for (const file of run.files) {
      let node = root;
      const parts = file.path.split('/');
      parts.forEach((name, i) => {
        if (!node.children.has(name)) node.children.set(name, { name, path: parts.slice(0, i + 1).join('/'), children: new Map() });
        node = node.children.get(name);
      });
      node.file = file;
    }
    const aggregate = node => {
      node.counts = {};
      for (const child of node.children.values()) {
        aggregate(child);
        for (const [id, count] of Object.entries(child.counts)) {
          const target = node.counts[id] ||= { reads: 0, writes: 0 };
          target.reads += count.reads;
          target.writes += count.writes;
        }
      }
      if (node.file) node.counts = node.file.agents;
      node.overlap = Boolean(node.file && Object.values(node.counts).filter(c => c.writes > 0).length > 1) || [...node.children.values()].some(c => c.overlap);
    };
    aggregate(root);
    const rows = (node, depth) => [...node.children.values()].sort((a, b) => Number(Boolean(b.children.size)) - Number(Boolean(a.children.size)) || a.name.localeCompare(b.name)).map(child => {
      const dir = child.children.size > 0;
      const open = state.expanded.has(child.path) ? state.expanded.get(child.path) : Object.keys(child.counts).length > 1 || child.overlap;
      const overlap = !dir && child.overlap;
      const cells = run.agents.map(agent => {
        const counts = child.counts[agent.id];
        const current = dir ? run.files.some(file => file.path.startsWith(`${child.path}/`) && currentFile(agent, file.path)) : currentFile(agent, child.path);
        return `<td class="${current ? 'file-current' : ''}" ${tip(key('file', child.path, agent.id), `${child.path}\n${agent.id}: ${counts?.reads || 0} reads / ${counts?.writes || 0} writes${current ? dir ? '\nCurrent activity names a file inside this directory' : '\nCurrent activity names this path' : ''}`)}>${current ? '<i class="dot pulse"></i>' : ''}${counts ? `${counts.reads}r / ${counts.writes}w` : '<span class="muted">·</span>'}</td>`;
      }).join('');
      return `<tr data-key="tree-${esc(child.path)}" class="${overlap ? 'overlap' : ''}"><td class="file-name" style="--depth:${depth}">${dir ? `<button data-directory="${esc(child.path)}" aria-expanded="${open}">${open ? '▾' : '▸'} ${esc(child.name)}/</button>` : `${esc(child.name)}${overlap ? ' <span class="warn">◆</span>' : ''}`}</td>${cells}</tr>${dir && open ? rows(child, depth + 1) : ''}`;
    }).join('');
    return `<div class="tree-wrap" data-key="tree-scroll"><table class="tree"><thead><tr><th>Repository path</th>${run.agents.map(agent => `<th>${esc(agent.id)}</th>`).join('')}</tr></thead><tbody>${rows(root, 0)}</tbody></table>${run.files.length ? '' : empty('No file activity recorded')}</div>`;
  }

  function environments() {
    const groups = new Map();
    for (const agent of run.agents) {
      const path = agent.worktree || `unknown:${agent.id}`;
      if (!groups.has(path)) groups.set(path, []);
      groups.get(path).push(agent);
    }
    return intro('Environments', 'Worktree isolation and shared repository activity') + `<div class="grid worktrees">${[...groups].map(([path, agents]) => `<div class="panel" data-key="worktree-${esc(path)}"><div class="panel-title"><h2>${esc(agents[0].branch || 'Detached / unknown branch')}</h2><span class="badge">${esc([...new Set(agents.map(a => a.mode))].join(' + '))}</span></div><div class="panel-body"><div class="worktree-path">${esc(agents[0].worktree || 'No worktree recorded')}</div>${agents.map(a => `<div data-key="worktree-agent-${esc(a.id)}"><div class="row"><span class="agent-id">${esc(a.id)}</span><small>base ${esc(a.base || 'unknown')}</small></div><div class="scope">scope ${a.scope.length ? a.scope.map(esc).join(' · ') : 'not specified'}</div>${a.diff ? `<div style="margin-top:10px">${n(a.diff.files)} files <span class="diff-added">+${n(a.diff.added)}</span> <span class="diff-removed">-${n(a.diff.removed)}</span></div>${a.diff.outOfScope.length ? `<div class="out-of-scope">Outside scope: ${a.diff.outOfScope.map(esc).join(', ')}</div>` : '<small>All changed files within scope</small>'}` : '<small>Diff unavailable</small>'}</div>`).join('')}</div></div>`).join('')}</div>${panel('Merged file activity', fileTree() + '<div class="tree-key">r = reads · w = writes · ◆ multiple writers · green pulse = current activity names this path<br>Single-agent directories start collapsed. File counts are cumulative; the snapshot has no per-file history times.</div>', `<span class="badge">${run.files.length} paths</span>`)}`;
  }

  function errors() {
    return intro('Error signatures', 'Shared failures and recorded recovery') + (run.errorClusters.map((cluster, i) => `<div class="panel error-cluster" data-key="error-${i}"><div class="panel-title"><span class="badge error">${n(cluster.count)} occurrences</span><small>${esc(cluster.family)} · ${new Set(cluster.agents.map(a => a.id)).size} agents</small></div><div class="panel-body signature">${esc(cluster.signature)}</div>${cluster.agents.map((agent, j) => `<div class="recovery" data-key="recovery-${j}"><div>${link(agent.id, agent.at, agent.id)}<small>${clock(agent.at)} UTC</small></div><div>${agent.recovery ? esc(agent.recovery) : '<span class="muted">No recovery recorded</span>'}</div></div>`).join('')}</div>`).join('') || empty('No errors recorded'));
  }

  const renderers = { overview, agents, timeline, context: contexts, environments, errors };
  const tooltip = document.getElementById('tooltip');
  function refreshTooltip() {
    if (!state.hover) return;
    const target = [...document.querySelectorAll('[data-tip]')].find(node => node.dataset.key === state.hover.key && !node.closest('[hidden]'));
    if (!target) { tooltip.hidden = true; state.hover = null; return; }
    tooltip.textContent = target.dataset.tip;
    tooltip.hidden = false;
    tooltip.style.left = `${Math.max(12, Math.min(state.hover.x + 14, innerWidth - tooltip.offsetWidth - 12))}px`;
    tooltip.style.top = `${Math.max(12, Math.min(state.hover.y + 14, innerHeight - tooltip.offsetHeight - 12))}px`;
  }

  function render() {
    const scroll = [window.scrollX, window.scrollY];
    const scrollers = [...document.querySelectorAll('.tree-wrap,nav')].map(node => [node, node.scrollLeft, node.scrollTop]);
    put('run-heading', `<div class="heading"><div><div class="eyebrow">${live ? 'LIVE OBSERVABILITY' : 'SESSION ARCHIVE'} / ${esc(run.session)}</div><h1>${state.view === 'overview' ? 'Run overview' : ({ agents: 'Inside the agent panes', timeline: 'Every operation, in time', context: 'Where the context went', environments: 'One repo, many worktrees', errors: 'What went wrong' })[state.view]}</h1><div class="path">${esc(run.repo || 'Repository unavailable')}</div></div><div class="heading-meta">${esc(run.window.start?.slice(0, 10))}<br>${clock(run.window.start)} - ${clock(run.window.end)} UTC</div></div>`);
    put('rail-meta', `<div class="eyebrow">SESSION</div><b>${esc(run.session)}</b><div class="muted">${run.agents.length} agents<br>${duration(run.totals.wallSeconds)} elapsed</div>`);
    for (const [view, renderer] of Object.entries(renderers)) {
      const section = document.getElementById(`view-${view}`);
      section.hidden = view !== state.view;
      if (view === state.view) put(`view-${view}`, renderer());
    }
    document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-current', button.dataset.view === state.view ? 'page' : 'false'));
    put('footer', `<span>herd / ${esc(run.session)} · snapshot v${n(run.version)}</span><span>Updated ${clock(run.generatedAt)} UTC · ${live ? 'full snapshots via SSE' : 'self-contained / offline'}</span>`);
    for (const [node, left, top] of scrollers) { node.scrollLeft = left; node.scrollTop = top; }
    window.scrollTo(...scroll);
    refreshTooltip();
  }

  document.addEventListener('click', event => {
    const view = event.target.closest('[data-view]');
    const inspect = event.target.closest('[data-inspect]');
    const directory = event.target.closest('[data-directory]');
    if (view) { state.view = view.dataset.view; state.hover = null; tooltip.hidden = true; render(); }
    if (inspect) {
      state.agent = inspect.dataset.inspect || null;
      state.at = inspect.dataset.at || null;
      state.view = state.at ? 'timeline' : 'agents';
      state.zoom = 100;
      render();
      document.getElementById(`view-${state.view}`).scrollIntoView({ block: 'start' });
    }
    if (directory) { state.expanded.set(directory.dataset.directory, directory.getAttribute('aria-expanded') !== 'true'); render(); }
    if (event.target.closest('[data-reset]')) { state.zoom = 100; state.at = null; state.agent = null; render(); }
  });
  document.addEventListener('input', event => { if (event.target.id === 'zoom') { state.zoom = Number(event.target.value); render(); } });
  document.addEventListener('pointerover', event => {
    const target = event.target.closest('[data-tip]');
    if (target) { state.hover = { key: target.dataset.key, x: event.clientX, y: event.clientY }; refreshTooltip(); }
  });
  document.addEventListener('pointerout', event => {
    if (event.target.closest('[data-tip]') && !event.target.closest('[data-tip]').contains(event.relatedTarget)) { state.hover = null; tooltip.hidden = true; }
  });
  document.addEventListener('focusin', event => {
    const target = event.target.closest('[data-tip]');
    if (target) { const rect = target.getBoundingClientRect(); state.hover = { key: target.dataset.key, x: rect.left, y: rect.bottom }; refreshTooltip(); }
  });
  document.addEventListener('focusout', () => { state.hover = null; tooltip.hidden = true; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { state.hover = null; tooltip.hidden = true; } });
  render();
  if (live) {
    const indicator = document.getElementById('connection');
    const connection = (text, className) => { indicator.textContent = text; indicator.className = className; };
    const events = new EventSource('/events');
    events.addEventListener('open', () => connection('● Connected · awaiting snapshot', 'connected'));
    events.addEventListener('error', () => connection('● Reconnecting · showing last snapshot', 'retrying'));
    events.addEventListener('run', event => {
      try {
        const next = JSON.parse(event.data);
        if (next.version !== 1 || !Array.isArray(next.agents) || !next.window || !next.totals || !Array.isArray(next.files) || !Array.isArray(next.flags) || !Array.isArray(next.quota) || !Array.isArray(next.errorClusters)) throw new Error('Invalid snapshot');
        run = next;
        render();
        connection(`● Live · ${clock(run.generatedAt)} UTC`, 'connected');
      } catch {
        connection('● Snapshot unreadable · waiting for next update', 'retrying');
      }
    });
  }
})();
