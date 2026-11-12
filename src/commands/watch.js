import http from 'node:http';
import { loadConfig } from '../config.js';
import { anchorContext } from '../context.js';
import { EXIT, HerdError } from '../errors.js';
import { print, printError } from '../output.js';
import { renderPage } from '../telemetry/page.js';
import { createLiveRun } from '../telemetry/run.js';

export const summary = 'Serve a live dashboard of this session';
export const usage = 'herd watch [--port <n>]';
export const options = { port: { type: 'string' } };

export async function startWatch({ anchor, config = loadConfig(), port = 0, liveRun = createLiveRun({ anchor, config }), pollIntervalMs = 1000, pingIntervalMs = 15000 }) {
  if (!/^\d+$/.test(String(port)) || !Number.isInteger(Number(port)) || Number(port) > 65535) {
    throw new HerdError('invalid_port', 'port must be an integer from 0 to 65535', { exitCode: EXIT.usage, help: [usage] });
  }
  let snapshot = await liveRun.refresh();
  let pending = null;
  let poll = null;
  let ping = null;
  let closed = false;
  const clients = new Set();
  const event = () => `event: run\ndata: ${JSON.stringify(snapshot)}\n\n`;
  const stopPolling = () => {
    clearInterval(poll);
    clearInterval(ping);
    poll = null;
    ping = null;
  };
  const refresh = () => {
    pending ??= liveRun.refresh().then((next) => {
      if (next) {
        snapshot = next;
        for (const client of clients) client.write(event());
      }
    }).finally(() => { pending = null; });
    return pending;
  };
  const reportError = (err) => printError(new HerdError('watch_refresh_failed', err.message, { help: ['Check session data; watch will retry while clients are connected'] }));
  const schedule = () => {
    if (closed || !clients.size || poll) return;
    poll = setInterval(() => {
      void refresh().catch(reportError);
    }, pollIntervalMs);
    ping ??= setInterval(() => {
      for (const client of clients) client.write(': ping\n\n');
    }, pingIntervalMs);
  };
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' || !['/', '/events'].includes(request.url)) {
        response.writeHead(404).end('Not found');
        return;
      }
      await refresh();
      if (closed || response.destroyed) return;
      if (request.url === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(renderPage(snapshot, { live: true }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      response.write(event());
      clients.add(response);
      response.on('close', () => {
        clients.delete(response);
        if (!clients.size) stopPolling();
      });
      schedule();
    } catch (err) {
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Could not refresh the run');
      else response.end();
      reportError(err);
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(port), '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (err) {
    throw new HerdError('watch_listen_failed', `Could not start dashboard: ${err.message}`, { help: ['Try `herd watch --port 0` to use an available port'] });
  }
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    close() {
      closed = true;
      stopPolling();
      for (const client of clients) client.end();
      clients.clear();
      return new Promise((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

export async function run(values) {
  const dashboard = await startWatch({ anchor: anchorContext(), port: values.port ?? 0 });
  const stop = () => { void dashboard.close().catch(printError); };
  process.once('SIGINT', stop);
  dashboard.server.once('close', () => process.removeListener('SIGINT', stop));
  print({ url: dashboard.url, help: ['Press Ctrl+C to stop the dashboard'] });
}
