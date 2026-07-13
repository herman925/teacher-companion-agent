// Provider-internal node failover (altBaseURLs, e.g. FreeModel.dev tier
// nodes) — both directions: an unreachable primary hops to the alternate and
// the result reports the node actually used; an auth failure (401) does NOT
// hop (same key everywhere — retrying other nodes would only mask the cause);
// and with no altBaseURLs the behaviour is unchanged single-shot.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { callProvider, AdapterError } from '../src/adapter.mjs';

const MESSAGES = [{ role: 'user', content: '测试' }];

/** Minimal OpenAI-compatible stub; behaviour switches on `mode`. */
function stubServer(mode) {
  const server = http.createServer((req, res) => {
    if (mode === '401') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"bad key"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: '{"reply_markdown":"好"}' } }],
      usage: { total_tokens: 5 },
    }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      base: `http://127.0.0.1:${server.address().port}/v1`,
    }));
  });
}

test('unreachable primary hops to the alternate node and reports base_url_used', async () => {
  const { server, base } = await stubServer('ok');
  try {
    const p = {
      id: 'freemodel', label: 'FreeModel-测试',
      baseURL: 'http://127.0.0.1:1/v1', // nothing listens here
      altBaseURLs: [base],
      model: 'auto', jsonStrategy: 'json_object_prompt',
    };
    const r = await callProvider(p, 'test-key', MESSAGES, { timeoutMs: 5000 });
    assert.equal(r.base_url_used, base);
    assert.equal(typeof r.payload, 'string');
    assert.equal(r.usage.total_tokens, 5);
  } finally {
    server.close();
  }
});

test('auth failure (401) does not hop — surfaces immediately from the primary', async () => {
  const primary = await stubServer('401');
  const alternate = await stubServer('ok');
  try {
    const p = {
      id: 'freemodel', label: 'FreeModel-测试',
      baseURL: primary.base,
      altBaseURLs: [alternate.base],
      model: 'auto', jsonStrategy: 'json_object_prompt',
    };
    await assert.rejects(
      callProvider(p, 'bad-key', MESSAGES, { timeoutMs: 5000 }),
      (err) => {
        assert.ok(err instanceof AdapterError);
        assert.equal(err.status, 401);
        assert.ok(err.message.includes(primary.base), 'error names the node that answered');
        return true;
      },
    );
  } finally {
    primary.server.close();
    alternate.server.close();
  }
});

test('no altBaseURLs → single-shot, unchanged error shape', async () => {
  const p = {
    id: 'x', label: 'X-测试',
    baseURL: 'http://127.0.0.1:1/v1',
    model: 'm', jsonStrategy: 'json_object_prompt',
  };
  await assert.rejects(
    callProvider(p, 'k', MESSAGES, { timeoutMs: 3000 }),
    (err) => err instanceof AdapterError && err.kind === 'network',
  );
});
