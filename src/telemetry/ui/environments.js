function activityPaths() {
  const paths = new Set();
  for (const agent of run.agents) {
    if (!active(agent) || !['tool', 'background'].includes(agent.activity.kind)) continue;
    const label = (agent.activity.label || '').replaceAll('\\', '/');
    for (const token of label.split(/[\s"'`():;,]+/)) {
      const parts = token.split('/');
      parts.forEach((part, index) => paths.add(parts.slice(index).join('/')));
    }
  }
  return paths;
}

function treeNode(name = '', path = '') {
  return { name, path, children: new Map(), counts: {}, files: 0, reads: 0, writes: 0, overlap: false };
}

function aggregateTree(node) {
  if (node.file) {
    node.counts = Object.fromEntries(Object.entries(node.file.agents).map(([id, count]) => [id, { ...count }]));
    node.files = 1;
    node.overlap = Object.values(node.counts).filter(count => count.writes > 0).length > 1;
  }
  for (const child of node.children.values()) {
    aggregateTree(child);
    node.files += child.files;
    node.overlap ||= child.overlap;
    for (const [id, count] of Object.entries(child.counts)) {
      const target = node.counts[id] ||= { reads: 0, writes: 0 };
      target.reads += count.reads;
      target.writes += count.writes;
    }
  }
  for (const count of Object.values(node.counts)) {
    node.reads += count.reads;
    node.writes += count.writes;
  }
}

function buildFileTree() {
  const root = treeNode();
  const query = state.fileSearch.trim().toLowerCase();
  for (const file of run.files) {
    if (!file.path.toLowerCase().includes(query)) continue;
    let node = root;
    const parts = file.path.split('/');
    parts.forEach((name, index) => {
      if (!node.children.has(name)) node.children.set(name, treeNode(name, parts.slice(0, index + 1).join('/')));
      node = node.children.get(name);
    });
    node.file = file;
  }
  aggregateTree(root);
  return root;
}

function currentPaths() {
  const paths = new Set();
  const activePaths = activityPaths();
  for (const file of run.files) {
    if (!activePaths.has(file.path)) continue;
    const parts = file.path.split('/');
    parts.forEach((name, index) => paths.add(parts.slice(0, index + 1).join('/')));
  }
  return paths;
}

function fileAgentDetails(node) {
  const agents = Object.entries(node.counts).map(([id, count]) => `<div class="row">
    ${link(id, null, id)}<span>${n(count.reads)}r / ${n(count.writes)}w</span>
  </div>`).join('');
  return `<tr data-key="file-detail-${esc(node.path)}"><td colspan="4">
    <div class="file-agents">${agents}</div>
  </td></tr>`;
}

function fileRow(node, depth, current) {
  const directory = node.children.size > 0;
  const open = directoryOpen(node.path);
  const details = state.fileDetails.has(node.path);
  const indicator = current.has(node.path) ? '<i class="dot pulse"></i>' : '';
  const name = directory
    ? `<button data-directory="${esc(node.path)}" aria-expanded="${open}">${open ? '▾' : '▸'} ${esc(node.name)}/</button>`
    : `${esc(node.name)}${node.overlap ? ' <span class="warn" title="Multiple writers">◆</span>' : ''}`;
  return `<tr data-key="tree-${esc(node.path)}" class="${node.overlap ? 'overlap' : ''}">
    <td class="file-name ${current.has(node.path) ? 'file-current' : ''}" style="--depth:${Math.min(depth, 8)}">
      ${indicator}${name}${directory ? `<small>${n(node.files)} files</small>` : ''}
    </td><td>${n(node.reads)}r</td><td>${n(node.writes)}w</td><td>
      <button data-file-details="${esc(node.path)}" aria-expanded="${details}" aria-label="Agents for ${esc(node.path)}">
        ${n(Object.keys(node.counts).length)} agents ${details ? '▾' : '▸'}
      </button>
    </td></tr>${details ? fileAgentDetails(node) : ''}`;
}

function directoryOpen(path) {
  return state.fileSearch.trim() ? !state.searchCollapsed.has(path) : state.expanded.has(path);
}

function rootFileGroup(root) {
  const files = treeNode();
  for (const [name, child] of root.children) {
    if (!child.children.size) files.children.set(name, child);
  }
  if (!files.children.size) return [];
  for (const child of files.children.values()) {
    files.files += child.files;
    files.reads += child.reads;
    files.writes += child.writes;
    for (const id of Object.keys(child.counts)) files.counts[id] = true;
  }
  const open = state.fileSearch.trim() ? !state.rootFilesCollapsed : state.rootFiles;
  const summary = `<tr data-key="root-files"><td>
    <button data-root-files aria-expanded="${open}">${open ? '▾' : '▸'} Files at repository root</button>
    <small>${n(files.files)} files</small></td><td>${n(files.reads)}r</td><td>${n(files.writes)}w</td>
    <td>${n(Object.keys(files.counts).length)} agents</td>
  </tr>`;
  const rows = [{ html: summary }];
  if (open) {
    for (const node of files.children.values()) rows.push({ node, depth: 1 });
  }
  return rows;
}

function fileRows(root, current) {
  const rows = rootFileGroup(root);
  const visit = (node, depth) => {
    const children = [...node.children.values()].sort((a, b) =>
      Number(Boolean(b.children.size)) - Number(Boolean(a.children.size)) || a.name.localeCompare(b.name)
    );
    for (const child of children) {
      if (node === root && !child.children.size) continue;
      rows.push({ node: child, depth });
      if (child.children.size && directoryOpen(child.path)) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  const html = rows.slice(0, state.treeLimit).map(row => row.html || fileRow(row.node, row.depth, current)).join('');
  return { html, total: rows.length };
}

function fileTree() {
  const root = buildFileTree();
  const rows = fileRows(root, currentPaths());
  const controls = `<div class="toolbar file-controls">
    <label for="fileSearch">Filter paths</label>
    <input id="fileSearch" data-control="fileSearch" type="search" value="${esc(state.fileSearch)}" placeholder="Directory or file">
    <span role="status">${n(root.files)} / ${n(run.files.length)} paths</span>
    <button data-collapse-tree>Collapse all</button>
  </div>`;
  return `${controls}<div class="tree-wrap" data-key="tree-scroll"><table class="tree">
    <thead><tr><th>Repository path</th><th>Reads</th><th>Writes</th><th>Agents</th></tr></thead>
    <tbody>${rows.html}</tbody>
  </table>${root.files ? '' : empty('No file paths match this filter')}</div>
    ${rows.total > state.treeLimit ? `<button class="show-more" data-more-files>
      Show next ${Math.min(100, rows.total - state.treeLimit)} rows (${n(state.treeLimit)} / ${n(rows.total)} visible)
    </button>` : ''}`;
}

function worktreeAgent(agent) {
  let diff = '<small>Diff unavailable</small>';
  if (agent.diff) {
    const scope = agent.diff.outOfScope.length
      ? `<div class="out-of-scope">Outside scope: ${agent.diff.outOfScope.map(esc).join(', ')}</div>`
      : '<small>All changed files within scope</small>';
    diff = `<div class="diff-summary">${n(agent.diff.files)} files
      <span class="diff-added">+${n(agent.diff.added)}</span><span class="diff-removed">-${n(agent.diff.removed)}</span>
    </div>${scope}`;
  }
  return `<div data-key="worktree-agent-${esc(agent.id)}">
    <div class="row"><span class="agent-id">${esc(agent.id)}</span><small>base ${esc(agent.base || 'unknown')}</small></div>
    <div class="scope">scope ${agent.scope.length ? agent.scope.map(esc).join(' · ') : 'not specified'}</div>${diff}
  </div>`;
}

function worktreeCard([path, agents]) {
  const open = state.worktrees.has(path);
  return `<div class="panel" data-key="worktree-${esc(path)}">
    <div class="panel-title"><h2>${esc(agents[0].branch || 'Detached / unknown branch')}</h2>
      <span class="badge">${esc([...new Set(agents.map(agent => agent.mode))].join(' + '))}</span>
    </div><div class="panel-body"><div class="worktree-path">${esc(agents[0].worktree || 'No worktree recorded')}</div>
      <button data-worktree="${esc(path)}" aria-expanded="${open}">
        ${open ? 'Hide' : 'Show'} ${n(agents.length)} agent${agents.length === 1 ? '' : 's'} · scope and diff
      </button>${open ? agents.map(worktreeAgent).join('') : ''}
    </div>
  </div>`;
}

function environments() {
  const groups = new Map();
  for (const agent of run.agents) {
    const path = agent.worktree || `unknown:${agent.id}`;
    if (!groups.has(path)) groups.set(path, []);
    groups.get(path).push(agent);
  }
  const note = `<div class="tree-key">r = reads · w = writes · ◆ multiple writers · green pulse = current activity names this path
    <br>Directories start collapsed. Counts are cumulative; the snapshot has no per-file history times.</div>`;
  return intro('Environments', 'Worktree isolation and shared repository activity')
    + panel('Merged file activity', fileTree() + note, `<span class="badge">${n(run.files.length)} paths</span>`)
    + `<div class="section-intro worktree-heading"><h2>Worktree isolation</h2><p>${n(groups.size)} environments</p></div>`
    + `<div class="grid worktrees">${[...groups].map(worktreeCard).join('')}</div>`;
}
