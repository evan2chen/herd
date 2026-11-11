const colors = {
  model: 'mauve', tool: 'blue', background: 'teal', idle: 'overlay', blocked: 'red', queued: 'yellow',
  read: 'blue', edit: 'green', test: 'yellow', build: 'peach', render: 'mauve', install: 'teal',
  git: 'peach', script: 'blue', cleanup: 'overlay', other: 'blue'
};

function color(segment) {
  const name = (segment.kind === 'tool' && colors[segment.category]) || colors[segment.kind] || 'blue';
  return `var(--${name})`;
}

function age(time) {
  if (!live) return .85;
  const elapsed = Math.max(0, ms(run.window.end) - ms(time));
  const span = Math.max(1, ms(run.window.end) - ms(run.window.start));
  return Math.max(.4, 1 - elapsed / span * .6);
}

function bounds() {
  const start = ms(run.window.start);
  const end = Math.max(start + 1000, ms(run.window.end));
  const span = (end - start) * state.zoom / 100;
  const center = state.at ? ms(state.at) : end - span / 2;
  const from = Math.max(start, Math.min(end - span, center - span / 2));
  return [from, from + span];
}

function histogram(rows, title, agent) {
  const max = Math.max(1, ...rows.map(row => row.count));
  const bars = rows.map(row => {
    const name = row.name || row.category;
    const text = `${name}: ${n(row.count)} calls\n${duration(row.seconds)} · ${n(row.errors)} errors`;
    return `<div class="hist-row" ${tip(key(agent.id, title, name), text)}>
      <span>${esc(name)}</span><div class="bar"><i style="--amount:${row.count / max * 100}%"></i></div>
      <span>${n(row.count)}</span>
    </div>`;
  }).join('');
  return `<div><h3>${title}</h3>${bars || '<small>No calls recorded</small>'}</div>`;
}

function stepPath(points, x, y) {
  return points.map((point, index) => {
    const command = index ? 'H' : 'M';
    const separator = index ? 'V' : ',';
    return `${command}${x(point).toFixed(1)}${separator}${y(point).toFixed(1)}`;
  }).join(' ');
}

function sparkline(agent) {
  const points = agent.context.series;
  if (!points.length) return '';
  const max = Math.max(1, ...points.map(point => point.size));
  const start = ms(points[0].at);
  const span = Math.max(1, ms(points.at(-1).at) - start);
  const path = stepPath(points, point => (ms(point.at) - start) / span * 86 + 2, point => 40 - point.size / max * 36);
  return `<svg class="sparkline" viewBox="0 0 90 44" aria-label="Context sparkline"><path d="${path}"/></svg>`;
}

function timelineSegment(agent, segment, index, mini, start, end, x) {
  if (ms(segment.end) < start || ms(segment.start) > end) return '';
  const current = active(agent) && segment.kind === agent.activity.kind
    && ms(segment.start) <= ms(agent.activity.since) && ms(segment.end) > ms(agent.activity.since);
  const category = segment.category ? ` · ${segment.category}` : '';
  const seconds = (ms(segment.end) - ms(segment.start)) / 1000;
  const text = `${agent.id}\n${segment.label || segment.tool || segment.kind}${category}\n`
    + `${clock(segment.start)} - ${clock(segment.end)} UTC · ${duration(seconds)}`
    + (current ? '\nCurrent operation' : '');
  const background = segment.kind === 'background';
  return `<rect ${tip(key('segment', agent.id, segment.start, segment.kind, index, mini), text)}
    class="chart-mark ${current ? 'pulse' : ''}" x="${x(segment.start)}" y="${background ? 49 : 19}"
    width="${Math.max(2, x(segment.end) - x(segment.start))}" height="${background ? 5 : 23}"
    rx="2" fill="${color(segment)}" opacity="${current ? 1 : age(segment.end)}"/>`;
}

function timelineSvg(agent, mini = false) {
  const startOfRun = ms(run.window.start);
  const fullRange = [startOfRun, Math.max(startOfRun + 1000, ms(run.window.end))];
  const [start, end] = mini ? fullRange : bounds();
  const x = at => percent((ms(at) - start) / (end - start) * 100) * 10;
  const segments = agent.timeline.map((segment, index) =>
    timelineSegment(agent, segment, index, mini, start, end, x)
  ).join('');
  const prompts = agent.prompts.filter(at => ms(at) >= start && ms(at) <= end).map(at =>
    `<path ${tip(key('prompt', agent.id, at, mini), `Prompt · ${clock(at)} UTC`)}
      class="tick chart-mark" d="M${x(at)} 6v8"/>`
  ).join('');
  const focused = !mini && state.at && ms(state.at) >= start && ms(state.at) <= end;
  const focus = focused
    ? `<path stroke="var(--peach)" stroke-dasharray="3 3" d="M${x(state.at)} 0v64"/>` : '';
  const current = active(agent) && ms(agent.activity.since) <= end && ms(run.window.end) >= start;
  const edge = current ? `<path class="live-edge pulse" d="M${Math.min(998, x(run.window.end))} 12v47"/>
    <circle class="pulse" cx="${Math.min(996, x(run.window.end))}" cy="9" r="3" fill="var(--green)"/>` : '';
  return `<svg class="${mini ? 'strip' : ''}" viewBox="0 0 1000 66" preserveAspectRatio="none"
    aria-label="${esc(agent.id)} activity timeline">
    <path class="chart-grid" d="M250 0v64 M500 0v64 M750 0v64"/>${segments}${prompts}${focus}${edge}
  </svg>`;
}

function contextPoint(agent, point, index, x, y) {
  const jump = index ? `Jump ${n(point.size - agent.context.series[index - 1].size)}` : 'Initial sample';
  const text = `${clock(point.at)} UTC · ${n(point.size)} context tokens\n`
    + `${jump} · own ${n(point.own)} / tool ${n(point.tool)}\n${point.cause || 'Cause unavailable'}`;
  return `<circle ${tip(key('context', agent.id, point.at, index), text)}
    class="chart-mark" cx="${x(point)}" cy="${y(point)}" r="4"/>`;
}

function contextChart(agent) {
  const points = agent.context.series;
  if (!points.length) return empty('Context unavailable from this provider');
  const max = Math.max(1, agent.context.window || 0, agent.context.peak || 0, ...points.map(point => point.size));
  const start = ms(run.window.start);
  const span = Math.max(1000, ms(run.window.end) - start);
  const x = point => 48 + (ms(point.at) - start) / span * 510;
  const y = point => 142 - point.size / max * 115;
  const steps = stepPath(points, x, y);
  const jumps = points.map((point, index) => ({ point, delta: index ? point.size - points[index - 1].size : 0 }))
    .filter(item => item.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 2);
  const labels = jumps.map(({ point, delta }, index) =>
    `<text class="jump-label" x="${x(point)}" y="${Math.max(14, y(point) - 12 - index * 12)}"
      text-anchor="${x(point) > 480 ? 'end' : 'start'}">+${compact(delta)}</text>`
  ).join('');
  return `<svg class="context-chart" viewBox="0 0 590 170" role="group"
    aria-label="${esc(agent.id)} context over time">
    <path class="chart-grid" d="M48 27H558 M48 84H558 M48 142H558"/>
    <text x="0" y="30">${compact(max)}</text><text x="0" y="88">${compact(max / 2)}</text><text x="25" y="146">0</text>
    <path class="area" d="${steps} V142 H${x(points[0])}Z"/><path class="step" d="${steps}"/>
    ${points.map((point, index) => contextPoint(agent, point, index, x, y)).join('')}${labels}
    <text x="48" y="165">${clock(run.window.start)}</text>
    <text x="558" y="165" text-anchor="end">${clock(run.window.end)} UTC</text>
  </svg>`;
}
