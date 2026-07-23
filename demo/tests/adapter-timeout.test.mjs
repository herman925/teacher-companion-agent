// Timeout physics (adapter): the idle timer cuts only a SILENT stream — a
// long productive generation lives past any flat deadline — while the total
// ceiling backstops a stream that never finishes, and a total timeout must
// not trigger an uninvited second marathon on the failover chain.
// Both directions per the harness discipline: each guard fires on its
// violating stub AND stays silent on a compliant one.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { callProvider, callWithFailover, AdapterError } from '../src/adapter.mjs';

const MESSAGES = [{ role: 'user', content: '测试' }];
const CHUNK = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const FINAL = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';

/** SSE stub driven by a handler(res) so each test scripts its own timing. */
function sseServer(handler) {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      handler(res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      base: `http://127.0.0.1:${server.address().port}/v1`,
      close: () => { server.closeAllConnections?.(); server.close(); },
    }));
  });
}

const stub = (base) => ({ id: 'zai', label: 'stub', baseURL: base, model: 'm', jsonStrategy: 'json_schema' });

test('idle timeout FIRES on a stream that goes silent after one chunk', async () => {
  const { close, base } = await sseServer((res) => {
    res.write(CHUNK('{"reply_'));
    // …then never speaks again.
  });
  try {
    await assert.rejects(
      callProvider(stub(base), 'k', MESSAGES, { onDelta: () => {}, idleTimeoutMs: 250, timeoutMs: 60000 }),
      (e) => e instanceof AdapterError && e.kind === 'timeout' && e.phase === 'idle' && e.message.includes('没有任何输出'),
    );
  } finally { close(); }
});

test('idle timeout STAYS SILENT while chunks keep arriving, even past the idle window in total', async () => {
  const { close, base } = await sseServer((res) => {
    // 6 drips × 100ms = 600ms total, far past the 250ms idle window — but no
    // single GAP exceeds it, so the generation must complete untouched.
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      if (i < 6) res.write(CHUNK(i === 1 ? '{"reply_' : 'x'));
      else { res.write(CHUNK('markdown":"好"}')); res.write(FINAL); res.end(); clearInterval(t); }
    }, 100);
  });
  try {
    const r = await callProvider(stub(base), 'k', MESSAGES, { onDelta: () => {}, idleTimeoutMs: 250, timeoutMs: 60000 });
    assert.ok(String(r.payload).endsWith('"好"}'), 'slow-but-alive stream completes');
  } finally { close(); }
});

test('total ceiling FIRES even while the stream keeps babbling', async () => {
  const { close, base } = await sseServer((res) => {
    const t = setInterval(() => res.write(CHUNK('废话')), 50);
    res.on('close', () => clearInterval(t));
  });
  try {
    await assert.rejects(
      callProvider(stub(base), 'k', MESSAGES, { onDelta: () => {}, idleTimeoutMs: 60000, timeoutMs: 400 }),
      (e) => e instanceof AdapterError && e.kind === 'timeout' && e.phase === 'total',
    );
  } finally { close(); }
});

test('failover chain STOPS after a total timeout instead of starting a second marathon', async () => {
  const babble = await sseServer((res) => {
    const t = setInterval(() => res.write(CHUNK('废话')), 50);
    res.on('close', () => clearInterval(t));
  });
  let secondHit = false;
  const good = await sseServer((res) => { secondHit = true; res.write(FINAL); res.end(); });
  try {
    const registry = {
      glm: { ...stub(babble.base), id: 'glm' },
      minimax: { ...stub(good.base), id: 'minimax' },
    };
    await assert.rejects(
      callWithFailover('glm', { glm: 'k', minimax: 'k' }, MESSAGES, {
        registry, onDelta: () => {}, idleTimeoutMs: 60000, timeoutMs: 400,
      }),
      (e) => e.chain?.length === 1 && e.chain[0].kind === 'timeout',
    );
    assert.equal(secondHit, false, 'no provider is tried after a 30-min-class timeout');
  } finally { babble.close(); good.close(); }
});

test('an idle-silent PRIMARY node hops to the alternate node and succeeds', async () => {
  const dead = await sseServer((res) => { res.write(CHUNK('半')); });
  const good = await sseServer((res) => { res.write(CHUNK('{"reply_markdown":"好"}')); res.write(FINAL); res.end(); });
  try {
    const p = { ...stub(dead.base), altBaseURLs: [good.base] };
    const r = await callProvider(p, 'k', MESSAGES, { onDelta: () => {}, idleTimeoutMs: 250, timeoutMs: 60000 });
    assert.equal(r.base_url_used, good.base, 'alternate node answered');
    assert.equal(r.payload, '{"reply_markdown":"好"}');
  } finally { dead.close(); good.close(); }
});
