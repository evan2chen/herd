import { readFileSync } from 'node:fs';

const style = readFileSync(new URL('./ui/style.css', import.meta.url), 'utf8');
const scripts = ['helpers.js', 'charts.js', 'views.js', 'environments.js', 'app.js'];
const app = `(() => {\n'use strict';\n${scripts.map(name =>
  readFileSync(new URL(`./ui/${name}`, import.meta.url), 'utf8')
).join('\n')}\n})();`;
const views = ['overview', 'agents', 'timeline', 'context', 'environments', 'errors'];

export function renderPage(run, { live = false } = {}) {
  const data = JSON.stringify(run).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><link rel="icon" href="data:,"><title>herd / run ${live ? 'dashboard' : 'recap'}</title><style>${style}</style></head>
<body data-live="${live}"><header><div class="brand"><b>h<span>erd</span></b><span class="divider">/</span><span>${live ? 'live workspace' : 'run recap'}</span></div><div id="connection" role="status">${live ? 'Connecting' : 'Offline snapshot'}</div></header>
<div class="shell"><aside><div class="eyebrow">RUN EXPLORER</div><nav aria-label="Run views">${views.map((view, i) => `<button data-view="${view}" aria-controls="view-${view}" aria-current="${i === 0 ? 'page' : 'false'}"><span class="nav-number">0${i + 1}</span>${view[0].toUpperCase() + view.slice(1)}</button>`).join('')}</nav><div id="rail-meta"></div><div class="rail-note">One run.<br>Every agent.<br>Shared visibility.</div></aside>
<main><div id="run-heading"></div>${views.map((view, i) => `<section id="view-${view}" aria-label="${view}" ${i ? 'hidden' : ''}></section>`).join('')}<footer id="footer"></footer></main></div><div id="tooltip" role="tooltip" hidden></div><noscript>This dashboard needs JavaScript to display the embedded run snapshot.</noscript>
<script type="application/json" id="herd-run">${data}</script><script>${app}</script></body></html>`;
}
