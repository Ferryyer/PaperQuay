import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMineruCommands } = require('../electron/backend/mineruCommands.cjs');

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
});
const task = { code: 0, data: { task_id: 'task-1', file_url: 'https://uploads.example/paper' } };
const done = { code: 0, data: { state: 'done', markdown_url: 'https://downloads.example/full.md' } };

async function withParse(t, fetcher, options = {}, mineruSession) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'paperquay-mineru-test-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const pdfPath = path.join(directory, 'paper.pdf');
  await fsp.writeFile(pdfPath, '%PDF-1.7\n%%EOF');
  const events = [];
  const commands = createMineruCommands({
    appPaths: { mineruCacheDir: directory },
    mineruFetch: fetcher,
    mineruSession,
  });
  const run = () => commands.run_mineru_light_parse({
    options: { pdfPath, pollIntervalSecs: 1, timeoutSecs: 5, ...options },
    requestId: 'request-1',
  }, { sender: { isDestroyed: () => false, send: (...args) => events.push(args) } });
  return { run, events, directory, pdfPath };
}

test('MinerU requests use a dedicated direct session, not the default session', async (t) => {
  const proxySettings = [];
  const urls = [];
  const mineruSession = {
    async setProxy(settings) { proxySettings.push(settings); },
    async fetch(url) { urls.push(url); return json({ message: 'unavailable' }, 503); },
  };
  const { run } = await withParse(t, null, {}, mineruSession);
  await assert.rejects(run(), /HTTP 503/);
  assert.deepEqual(proxySettings, [{ mode: 'direct' }]);
  assert.deepEqual(urls, ['https://mineru.net/api/v1/agent/parse/file']);
});

test('light parse uploads, polls, downloads, and caches the real Markdown without a token', async (t) => {
  const calls = [];
  const responses = [json(task), new Response(null, { status: 200 }), json(done), new Response('# Paper\nText')];
  const { run, events } = await withParse(t, async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    return responses.shift();
  });
  const result = await run();

  assert.deepEqual(calls.map(({ url, method }) => [url, method]), [
    ['https://mineru.net/api/v1/agent/parse/file', 'POST'],
    ['https://uploads.example/paper', 'PUT'],
    ['https://mineru.net/api/v1/agent/parse/task-1', 'GET'],
    ['https://downloads.example/full.md', 'GET'],
  ]);
  assert.match(String(calls[1].body), /%PDF-1.7/);
  assert.equal(result.markdownText, '# Paper\nText');
  assert.equal(await fsp.readFile(result.markdownPath, 'utf8'), '# Paper\nText');
  assert.deepEqual(events.map((event) => event[2].state), ['submitting', 'uploading', 'done']);
});

test('light parse surfaces external service failure without uploading', async (t) => {
  let calls = 0;
  const { run } = await withParse(t, async () => {
    calls += 1;
    return json({ message: 'service unavailable' }, 503);
  });
  await assert.rejects(run(), /MinerU lightweight upload URL HTTP 503/);
  assert.equal(calls, 1);
});

test('light parse surfaces rate limits when submitting', async (t) => {
  const { run } = await withParse(t, async () => json({ message: 'too many requests' }, 429));
  await assert.rejects(run(), /MinerU lightweight upload URL HTTP 429/);
});

test('light parse surfaces rate limits from the status endpoint', async (t) => {
  const responses = [json(task), new Response(null, { status: 200 }), json({ message: 'rate limited' }, 429)];
  const { run } = await withParse(t, async () => responses.shift());
  await assert.rejects(run(), /MinerU lightweight status HTTP 429/);
});

test('light parse surfaces an unsuccessful parse task', async (t) => {
  const responses = [json(task), new Response(null, { status: 200 }), json({ code: 0, data: { state: 'failed', err_msg: 'parse failed upstream' } })];
  const { run } = await withParse(t, async () => responses.shift());
  await assert.rejects(run(), /parse failed upstream/);
});

test('light parse does not cache a failed Markdown download', async (t) => {
  const responses = [json(task), new Response(null, { status: 200 }), json(done), new Response('bad gateway', { status: 502 })];
  const { run, directory } = await withParse(t, async () => responses.shift());
  await assert.rejects(run(), /markdown download failed: HTTP 502/);
  assert.deepEqual(await fsp.readdir(directory), ['paper.pdf']);
});

test('light parse times out while an external request is stalled', async (t) => {
  const { run } = await withParse(t, (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }), { timeoutSecs: 0.02 });
  await assert.rejects(run(), /MinerU lightweight parse timed out/);
});

test('light parse times out when the service never finishes parsing', async (t) => {
  const responses = [json(task), new Response(null, { status: 200 })];
  const { run } = await withParse(t, async () => responses.shift() ?? json({ code: 0, data: { state: 'running' } }), {
    timeoutSecs: 0.02,
  });
  await assert.rejects(run(), /MinerU lightweight parse timed out/);
});
