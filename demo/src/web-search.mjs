// web-search.mjs — 联网搜索 for the providers that actually have a backend.
//
// Design note (2026-07-29, ADR-0012 §6). Search is a step WE run, not a tool the
// model may call at will:
//
//   - MiniMax's OpenAI-compatible chat API supports exactly one tool type,
//     `function` — there is no built-in web search to switch on. Its search
//     product is a separate MCP server. Herman's call: GLM/Z.AI only, and every
//     other provider reports the capability as unavailable rather than pretending.
//   - Even on GLM, the in-chat `{type:"web_search"}` tool's interaction with
//     `response_format: json_schema` is undocumented, and our MiniMax path forces
//     `tool_choice` to `emit_turn`, which structurally forbids any other tool call.
//     The STANDALONE endpoint avoids all three problems.
//   - Because we compose the query, search cannot become a general-purpose
//     channel (the 长沙天气 case in ADR-0012). Retrieval stays course-bound.
//
// Endpoints verified 2026-07-29 against docs.bigmodel.cn and docs.z.ai:
//   mainland      POST https://open.bigmodel.cn/api/paas/v4/web_search
//   international POST https://api.z.ai/api/paas/v4/web_search
// Both are `${baseURL}/web_search`, Bearer auth, and return `search_result[]`.
// The engine NAMES differ between them — see WEB_SEARCH_ENGINES.

/**
 * Per-provider search engine id. Presence in this map IS the capability flag.
 * Mainland (bigmodel.cn) prices per call, 2026-07: search_std ¥0.01,
 * search_pro ¥0.03, search_pro_sogou / search_pro_quark ¥0.05. We default to
 * the cheapest — a teacher's 主题 lookup does not need the premium engine.
 * International (z.ai) publishes no per-call price; engine id is `search-prime`.
 */
export const WEB_SEARCH_ENGINES = {
  glm: 'search_std',
  zai: 'search-prime',
  'zai-coding': 'search-prime',
};

/** Mainland API rejects a longer query outright (documented max 70 chars). */
export const QUERY_MAX = 70;

/** How many results we ask for. Enough to summarize a 主题, small enough to stay cheap. */
export const RESULT_COUNT = 5;

/**
 * Whether this provider has a web-search backend at all.
 * @param {{id?: string}|string|null|undefined} provider provider object or id
 */
export function supportsWebSearch(provider) {
  const id = typeof provider === 'string' ? provider : provider?.id;
  return Boolean(id && Object.hasOwn(WEB_SEARCH_ENGINES, id));
}

/**
 * The teacher-facing reason a disabled toggle is disabled. Honest, specific,
 * and in the product register — never 「暂不支持」 with no explanation.
 * @param {{id?: string, label?: string}|string|null|undefined} provider
 */
export function unavailableReason(provider) {
  if (supportsWebSearch(provider)) return '';
  return '当前模型没有联网搜索能力，换成 GLM 或 Z.AI 就可以用。';
}

/**
 * Should this turn search? Deliberately narrow.
 *
 * Retrieval belongs to intake — Workflow v2 phase B, where the teacher names a
 * resource and the agent goes and reads about it. A turn like 「改一下周二那个
 * 活动」 needs no search, and firing on every turn would spend money to inject
 * noise into a planning conversation.
 *
 * @param {{stage?: number}|null|undefined} state
 * @param {{webSearch?: boolean}|null|undefined} caps per-provider toggles
 * @param {{id?: string}|string|null|undefined} provider
 * @param {string} message the teacher's message this turn
 */
export function shouldSearch(state, caps, provider, message) {
  if (!caps?.webSearch) return false;
  if (!supportsWebSearch(provider)) return false;
  const stage = Number(state?.stage ?? 0);
  if (!Number.isFinite(stage) || stage > 1) return false;
  return String(message ?? '').trim().length >= 4;
}

/**
 * Compose the search query from the teacher's message. We build it, so it stays
 * course-bound; the model never supplies a raw query.
 * @param {string} message
 * @param {{theme?: string}|null|undefined} state
 * @returns {string} trimmed to QUERY_MAX
 */
export function buildQuery(message, state) {
  const theme = String(state?.theme ?? '').trim();
  const text = String(message ?? '').replace(/\s+/g, ' ').trim();
  const q = theme && !text.includes(theme) ? `${theme} ${text}` : text;
  return q.slice(0, QUERY_MAX);
}

/**
 * Request body for the standalone endpoint. Pure — the shape is what the tests
 * pin, so a vendor change surfaces as a failing assertion rather than a silent
 * behavior drift.
 * @param {{id?: string}|string} provider
 * @param {string} query
 * @param {{count?: number}} [opts]
 */
export function buildSearchBody(provider, query, opts = {}) {
  const id = typeof provider === 'string' ? provider : provider?.id;
  const engine = WEB_SEARCH_ENGINES[id];
  if (!engine) throw new Error(`provider ${id} has no web search engine`);
  return {
    search_query: String(query).slice(0, QUERY_MAX),
    search_engine: engine,
    search_intent: false,
    count: opts.count ?? RESULT_COUNT,
    content_size: 'medium',
  };
}

/**
 * Render results into the context block the model reads. Marked as retrieved
 * material with sources, so the model can attribute rather than absorb —
 * fabricated provenance is the failure we are always guarding against, and
 * search results are exactly the kind of text that invites it.
 * @param {Array<{title?: string, content?: string, link?: string, media?: string, publish_date?: string}>} results
 * @param {string} query
 * @returns {string} '' when there is nothing worth injecting
 */
export function searchResultsToContext(results, query) {
  const rows = (Array.isArray(results) ? results : [])
    .filter((r) => r && (r.title || r.content))
    .map((r, i) => {
      const title = String(r.title ?? '').trim();
      const media = String(r.media ?? '').trim();
      const date = String(r.publish_date ?? '').trim();
      const link = String(r.link ?? '').trim();
      const body = String(r.content ?? '').replace(/\s+/g, ' ').trim();
      const head = [`${i + 1}. ${title || '（无标题）'}`, media, date].filter(Boolean).join(' · ');
      return [head, body, link].filter(Boolean).join('\n');
    });
  if (!rows.length) return '';
  return [
    `# 联网检索结果（关键词：${query}）`,
    '',
    '这些是刚检索到的公开资料，供你梳理主题背景使用。引用其中内容时说明来源；',
    '资料没提到的不要当作事实补写，更不要写成儿童已经发生的经验。',
    '',
    rows.join('\n\n'),
  ].join('\n');
}

/**
 * Call the standalone web-search endpoint. Never throws: search is an
 * enhancement, and a search outage must not take a teacher's planning turn
 * down with it. Failures come back as `{ok:false, error}` for the session log.
 *
 * @param {{id: string, baseURL: string}} provider
 * @param {string} apiKey
 * @param {string} query
 * @param {{count?: number, timeoutMs?: number, fetchImpl?: Function}} [opts]
 * @returns {Promise<{ok: boolean, results: Array, query: string, engine: string, ms: number, error?: string}>}
 */
export async function runWebSearch(provider, apiKey, query, opts = {}) {
  const started = Date.now();
  const engine = WEB_SEARCH_ENGINES[provider?.id] ?? '';
  const out = (extra) => ({ ok: false, results: [], query, engine, ms: Date.now() - started, ...extra });
  if (!engine) return out({ error: 'provider_unsupported' });
  if (!apiKey) return out({ error: 'no_key' });

  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
  try {
    const res = await doFetch(`${provider.baseURL.replace(/\/+$/, '')}/web_search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'user-agent': 'teacher-platform-demo/0.1',
      },
      body: JSON.stringify(buildSearchBody(provider, query, opts)),
      signal: controller.signal,
    });
    if (!res.ok) return out({ error: `http_${res.status}` });
    const data = await res.json();
    const results = Array.isArray(data?.search_result) ? data.search_result : [];
    return { ok: true, results, query, engine, ms: Date.now() - started };
  } catch (err) {
    return out({ error: err?.name === 'AbortError' ? 'timeout' : 'network' });
  } finally {
    clearTimeout(timer);
  }
}
