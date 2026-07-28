// web-search.test.mjs — 联网搜索 wiring (ADR-0012 §6).
// Both directions everywhere: a rule that only ever fires is not a rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WEB_SEARCH_ENGINES,
  QUERY_MAX,
  supportsWebSearch,
  unavailableReason,
  shouldSearch,
  buildQuery,
  buildSearchBody,
  searchResultsToContext,
  runWebSearch,
} from '../src/web-search.mjs';

const GLM = { id: 'glm', baseURL: 'https://open.bigmodel.cn/api/paas/v4' };
const ZAI = { id: 'zai', baseURL: 'https://api.z.ai/api/paas/v4' };

// ---------- capability ----------

test('capability: GLM/Z.AI yes, MiniMax/Kimi no', () => {
  assert.equal(supportsWebSearch('glm'), true);
  assert.equal(supportsWebSearch('zai'), true);
  assert.equal(supportsWebSearch('zai-coding'), true);
  // MiniMax's chat API supports only tool type "function" — there is no
  // built-in search to switch on, and our tool_choice is forced to emit_turn.
  assert.equal(supportsWebSearch('minimax'), false);
  assert.equal(supportsWebSearch('minimax-intl'), false);
  // Kimi has a $web_search builtin but it is NOT wired; the UI must not claim it.
  assert.equal(supportsWebSearch('kimi'), false);
  assert.equal(supportsWebSearch(null), false);
  assert.equal(supportsWebSearch({ id: 'glm' }), true);
});

test('capability: engine ids differ between mainland and international', () => {
  // Verified 2026-07-29 against docs.bigmodel.cn / docs.z.ai. A vendor rename
  // should break here loudly rather than 400 at runtime.
  assert.equal(WEB_SEARCH_ENGINES.glm, 'search_std');
  assert.equal(WEB_SEARCH_ENGINES.zai, 'search-prime');
});

test('unavailable reason: explains and names a way forward, only when unsupported', () => {
  assert.equal(unavailableReason('glm'), '');
  const why = unavailableReason('minimax');
  assert.match(why, /GLM/);
  assert.ok(why.length > 8, '拒绝要说明原因，不能只说「不支持」');
});

// ---------- when it fires ----------

test('shouldSearch: fires on intake with the toggle on', () => {
  assert.equal(shouldSearch({ stage: 0 }, { webSearch: true }, GLM, '我想带中班做东乡龙舟'), true);
  assert.equal(shouldSearch({ stage: 1 }, { webSearch: true }, GLM, '我想带中班做东乡龙舟'), true);
});

test('shouldSearch: silent when the toggle is off', () => {
  assert.equal(shouldSearch({ stage: 0 }, { webSearch: false }, GLM, '我想带中班做东乡龙舟'), false);
  assert.equal(shouldSearch({ stage: 0 }, null, GLM, '我想带中班做东乡龙舟'), false);
});

test('shouldSearch: silent for providers with no backend, toggle regardless', () => {
  assert.equal(shouldSearch({ stage: 0 }, { webSearch: true }, { id: 'minimax' }, '东乡龙舟'), false);
  assert.equal(shouldSearch({ stage: 0 }, { webSearch: true }, { id: 'kimi' }, '东乡龙舟'), false);
});

test('shouldSearch: silent once past intake — a plan edit needs no search', () => {
  // 「改一下周二那个活动」 in stage 3 must not spend ¥0.01 fetching the web.
  assert.equal(shouldSearch({ stage: 2 }, { webSearch: true }, GLM, '改一下周二那个活动'), false);
  assert.equal(shouldSearch({ stage: 5 }, { webSearch: true }, GLM, '改一下周二那个活动'), false);
});

test('shouldSearch: silent on a message too short to be a query', () => {
  assert.equal(shouldSearch({ stage: 0 }, { webSearch: true }, GLM, '好'), false);
  assert.equal(shouldSearch({ stage: 0 }, { webSearch: true }, GLM, '   '), false);
});

// ---------- query composition ----------

test('buildQuery: we compose it, and it is capped at the vendor limit', () => {
  const long = '东'.repeat(200);
  assert.equal(buildQuery(long, null).length, QUERY_MAX);
  assert.equal(buildQuery('  我想做  东乡龙舟  ', null), '我想做 东乡龙舟');
});

test('buildQuery: prepends the theme only when the message omits it', () => {
  assert.equal(buildQuery('孩子们看过赛龙舟', { theme: '东乡龙舟' }), '东乡龙舟 孩子们看过赛龙舟');
  assert.equal(buildQuery('东乡龙舟怎么做', { theme: '东乡龙舟' }), '东乡龙舟怎么做');
});

// ---------- request shape ----------

test('buildSearchBody: pins the documented request shape per region', () => {
  assert.deepEqual(buildSearchBody(GLM, '东乡龙舟 历史'), {
    search_query: '东乡龙舟 历史',
    search_engine: 'search_std',
    search_intent: false,
    count: 5,
    content_size: 'medium',
  });
  assert.equal(buildSearchBody(ZAI, '东乡龙舟').search_engine, 'search-prime');
});

test('buildSearchBody: refuses a provider with no engine rather than guessing one', () => {
  assert.throws(() => buildSearchBody({ id: 'minimax' }, '东乡龙舟'), /no web search engine/);
});

// ---------- context rendering ----------

test('searchResultsToContext: carries sources and forbids fabricating child experience', () => {
  const ctx = searchResultsToContext([
    { title: '东乡龙舟的由来', content: '相传……', link: 'https://example.com/a', media: '某某网', publish_date: '2024-05-01' },
  ], '东乡龙舟');
  assert.match(ctx, /东乡龙舟的由来/);
  assert.match(ctx, /https:\/\/example\.com\/a/);
  assert.match(ctx, /说明来源/);
  // Non-negotiable #1 reaches the retrieval path too: fetched text is exactly
  // the sort of material that invites inventing what children did with it.
  assert.match(ctx, /不要写成儿童已经发生的经验/);
});

test('searchResultsToContext: empty in, empty out — nothing is injected', () => {
  assert.equal(searchResultsToContext([], '东乡龙舟'), '');
  assert.equal(searchResultsToContext(null, '东乡龙舟'), '');
  assert.equal(searchResultsToContext([{ link: 'https://x' }], '东乡龙舟'), '');
});

// ---------- the call ----------

test('runWebSearch: posts to ${baseURL}/web_search with bearer auth', async () => {
  let seen = null;
  const res = await runWebSearch(GLM, 'KEY', '东乡龙舟', {
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, json: async () => ({ search_result: [{ title: 'T', content: 'C' }] }) };
    },
  });
  assert.equal(seen.url, 'https://open.bigmodel.cn/api/paas/v4/web_search');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.authorization, 'Bearer KEY');
  assert.equal(JSON.parse(seen.init.body).search_engine, 'search_std');
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 1);
});

test('runWebSearch: a search outage never takes the turn down', async () => {
  const boom = await runWebSearch(GLM, 'KEY', '东乡龙舟', {
    fetchImpl: async () => { throw new Error('socket hang up'); },
  });
  assert.equal(boom.ok, false);
  assert.equal(boom.error, 'network');
  assert.deepEqual(boom.results, []);

  const http = await runWebSearch(GLM, 'KEY', '东乡龙舟', {
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
  });
  assert.equal(http.ok, false);
  assert.equal(http.error, 'http_429');

  const noKey = await runWebSearch(GLM, '', '东乡龙舟', {
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.error, 'no_key');
});
