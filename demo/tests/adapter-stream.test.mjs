// Streaming adapter (onDelta): the SSE stream is accumulated back into the
// exact non-streaming completion shape, and progress flows out as deltas.
// Both directions per the harness discipline: thinking surfaces where the
// model provides it (reasoning_content AND <think> tags), the final payload
// is identical to the buffered path, and a plain non-stream call still works
// against the same stub without onDelta.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { callProvider } from '../src/adapter.mjs';

const MESSAGES = [{ role: 'user', content: '测试' }];

/** SSE stub emitting the given chunk objects, then [DONE]. Records the request body. */
function sseServer(chunks) {
  let lastBody = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastBody = JSON.parse(body);
      if (!lastBody.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '{"reply_markdown":"好"}' } }], usage: null }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      base: `http://127.0.0.1:${server.address().port}/v1`,
      getBody: () => lastBody,
    }));
  });
}

test('streamed reasoning_content + content rebuild the buffered result; deltas fire in order', async () => {
  const { server, base, getBody } = await sseServer([
    { choices: [{ delta: { reasoning_content: '先想一想' } }] },
    { choices: [{ delta: { content: '{"reply_' } }] },
    { choices: [{ delta: { content: 'markdown":"好"}' }, finish_reason: 'stop' }], usage: { total_tokens: 9 } },
  ]);
  try {
    const p = { id: 'zai', label: 'stub', baseURL: base, model: 'glm-5.2', jsonStrategy: 'json_schema' };
    const deltas = [];
    const r = await callProvider(p, 'k', MESSAGES, { onDelta: (d) => deltas.push(d) });
    assert.equal(r.payload, '{"reply_markdown":"好"}', 'payload identical to buffered path');
    assert.equal(r.usage.total_tokens, 9, 'usage taken from the final chunk');
    assert.equal(getBody().stream, true, 'request actually streamed');
    assert.equal(deltas[0].kind, 'first');
    assert.ok(deltas.some((d) => d.kind === 'thinking' && d.text === '先想一想'));
    assert.equal(deltas.filter((d) => d.kind === 'content').at(-1).chars, '{"reply_markdown":"好"}'.length);
  } finally { server.close(); }
});

test('<think> tags split into thinking deltas and are stripped from the payload (stripThinking)', async () => {
  const { server, base } = await sseServer([
    { choices: [{ delta: { content: '<think>推理' } }] },
    { choices: [{ delta: { content: '过程</think>{"reply_markdown":"好"}' }, finish_reason: 'stop' }] },
  ]);
  try {
    const p = { id: 'minimax', label: 'stub', baseURL: base, model: 'M3', jsonStrategy: 'tool_call', stripThinking: true };
    const deltas = [];
    const r = await callProvider(p, 'k', MESSAGES, { onDelta: (d) => deltas.push(d) });
    assert.equal(r.payload, '{"reply_markdown":"好"}', 'think block stripped from payload');
    assert.equal(deltas.filter((d) => d.kind === 'thinking').map((d) => d.text).join(''), '推理过程');
  } finally { server.close(); }
});

test('tool-call argument chunks accumulate into the tool_calls payload', async () => {
  const { server, base } = await sseServer([
    { choices: [{ delta: { tool_calls: [{ function: { name: 'emit_turn', arguments: '{"reply_' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ function: { arguments: 'markdown":"好"}' } }] }, finish_reason: 'tool_calls' }] },
  ]);
  try {
    const p = { id: 'minimax', label: 'stub', baseURL: base, model: 'M3', jsonStrategy: 'tool_call' };
    const deltas = [];
    const r = await callProvider(p, 'k', MESSAGES, { onDelta: (d) => deltas.push(d) });
    assert.equal(r.payload, '{"reply_markdown":"好"}', 'tool args accumulated');
    assert.ok(deltas.some((d) => d.kind === 'content'), 'args counted as progress');
  } finally { server.close(); }
});

test('without onDelta the call stays non-streaming (stream:false on the wire)', async () => {
  const { server, base, getBody } = await sseServer([]);
  try {
    const p = { id: 'zai', label: 'stub', baseURL: base, model: 'glm-5.2', jsonStrategy: 'json_schema' };
    const r = await callProvider(p, 'k', MESSAGES, {});
    assert.equal(r.payload, '{"reply_markdown":"好"}');
    assert.equal(getBody().stream, false);
  } finally { server.close(); }
});
