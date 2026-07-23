// Provider-agnostic model adapter (docs/MODEL-APIS.md §4 is normative).
// One OpenAI-compatible client; per-provider JSON strategy + quirk handling.
// Runs in Node (serve.mjs). Keys never touch the repo.

/** @type {Record<string, import('./types.mjs').ProviderConfig>} */
export const PROVIDERS = {
  // MiniMax runs two separate platforms with separate keys/balances:
  // mainland (minimaxi.com) and international (minimax.io). Same API shape.
  minimax: {
    id: 'minimax',
    label: 'MiniMax（中国 minimaxi.com）',
    baseURL: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-M3',
    jsonStrategy: 'tool_call',
    stripThinking: true,
    enabled: true,
  },
  'minimax-intl': {
    id: 'minimax-intl',
    label: 'MiniMax（国际 minimax.io）',
    baseURL: 'https://api.minimax.io/v1',
    model: 'MiniMax-M3',
    jsonStrategy: 'tool_call',
    stripThinking: true,
    enabled: true,
  },
  // GLM likewise: 智谱 mainland (bigmodel.cn) vs Z.AI international (z.ai) are
  // DIFFERENT platforms with different keys/balances — a Z.AI key gets 429
  // 余额不足 on bigmodel.cn. Z.AI Coding Plan subscriptions bill only through
  // the dedicated coding endpoint (…/api/coding/paas/v4), not the general one.
  // disableThinking: request-body patch for the forced-answer retry (thinking
  // budget exceeded). GLM-5.x thinks by DEFAULT; the documented off-switch is
  // thinking:{type:"disabled"} (docs.bigmodel.cn thinking-mode, 2026-07).
  glm: {
    id: 'glm',
    label: 'GLM（智谱国内 bigmodel.cn）',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.2',
    jsonStrategy: 'json_schema',
    disableThinking: { thinking: { type: 'disabled' } },
    enabled: true,
  },
  zai: {
    id: 'zai',
    label: 'GLM · Z.AI（国际，按量计费）',
    baseURL: 'https://api.z.ai/api/paas/v4',
    model: 'glm-5.2',
    jsonStrategy: 'json_schema',
    disableThinking: { thinking: { type: 'disabled' } },
    enabled: true,
  },
  'zai-coding': {
    id: 'zai-coding',
    label: 'GLM · Z.AI Coding Plan（国际，订阅额度）',
    baseURL: 'https://api.z.ai/api/coding/paas/v4',
    model: 'glm-5.2',
    jsonStrategy: 'json_schema',
    disableThinking: { thinking: { type: 'disabled' } },
    enabled: true,
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi k2.6',
    baseURL: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
    jsonStrategy: 'json_object_prompt',
    enabled: true,
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen (qwen-plus)',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    jsonStrategy: 'json_object_prompt',
    enabled: false, // evaluation flag (PRD user story 24)
  },
  // FreeModel.dev (freemodel.dev/dashboard/docs): OpenAI-compatible relay,
  // Bearer key (fe_oa_…) from the dashboard; model "auto" lets it route, or
  // pick a concrete id via 获取模型列表 (/v1/models is supported).
  // FreeModel publishes several OpenAI-format nodes: openai-t0
  // (api.freemodel.dev, all tiers) plus the T1+/T2+ Singapore nodes. The
  // primary works for every account; the alternates are tried AUTOMATICALLY
  // when the primary is down or throttled (altBaseURLs, see callProvider).
  // Its Anthropic-format nodes (cc./api-cc.freemodel.dev, /v1/messages) are
  // a different wire format — not used here. To PIN a premium node instead,
  // use 自定义端点 with e.g. https://vip-sg.freemodel.dev/v1.
  freemodel: {
    id: 'freemodel',
    label: 'FreeModel.dev',
    baseURL: 'https://api.freemodel.dev/v1',
    altBaseURLs: ['https://vip-sg.freemodel.dev/v1', 'https://api-t2-sg.freemodel.dev/v1'],
    model: 'auto',
    jsonStrategy: 'json_object_prompt',
    enabled: true,
  },
  // OpenRouter (openrouter.ai): OpenAI-compatible aggregator; key from
  // openrouter.ai/keys. Model left blank — pick one via 获取模型列表.
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    model: '',
    jsonStrategy: 'json_object_prompt',
    enabled: true,
  },
  // Kilo Gateway (app.kilo.ai): OpenRouter-compatible endpoint, one key for
  // many models incl. free tiers (z-ai/glm-4.7:free, minimax/minimax-m2.1:free…).
  kilocode: {
    id: 'kilocode',
    label: 'Kilo Gateway（kilo.ai）',
    baseURL: 'https://api.kilo.ai/api/openrouter',
    model: '',
    jsonStrategy: 'json_object_prompt',
    enabled: true,
  },
  // OpenCode Zen (opencode.ai/docs/zen): a hosted, OpenAI-compatible gateway —
  // just a normal cloud provider. Bearer API key from opencode.ai/auth; five
  // free models (deepseek-v4-flash-free, big-pickle, mimo-v2.5-free, …) plus
  // pay-as-you-go for the rest. Model left blank — pick one via 获取模型列表.
  'opencode-zen': {
    id: 'opencode-zen',
    label: 'OpenCode Zen（在线）',
    baseURL: 'https://opencode.ai/zen/v1',
    model: '',
    jsonStrategy: 'json_object_prompt',
    enabled: true,
  },
};

/** Default failover chain (MODEL-APIS.md recommendation). */
export const FAILOVER = ['minimax', 'glm', 'kimi'];

/** JSON Schema of the turn contract, used verbatim for GLM json_schema and as the MiniMax tool schema. */
export const TURN_SCHEMA = {
  type: 'object',
  required: ['reply_markdown', 'state_delta', 'round_complete'],
  properties: {
    reply_markdown: { type: 'string' },
    question: {
      type: ['object', 'null'],
      properties: {
        text: { type: 'string' },
        why: { type: 'string' },
        examples: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 },
      },
      required: ['text', 'why', 'examples'],
    },
    // Multi-question turns: preferred over `question` when there is more than
    // one thing to ask. Deliberately uncapped (count is a warn, not a block —
    // re-tighten on pilot data). parseTurn normalizes question ⇄ questions.
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['text', 'why', 'examples'],
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          why: { type: 'string' },
          examples: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 },
          input: { type: 'string', enum: ['choice', 'text', 'both'] },
          required: { type: 'boolean' },
        },
      },
    },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'title', 'data'],
        properties: {
          type: { type: 'string', enum: ['entry_card', 'fit_screening', 'experience_plan', 'interview_card', 'question_pool', 'driving_questions', 'cycle_task', 'story_fragment'] },
          title: { type: 'string' },
          data: { type: 'object' },
        },
      },
    },
    closure_loop: {
      type: ['object', 'null'],
      properties: {
        do_now: { type: 'string' }, materials: { type: 'string' },
        bring_back: { type: 'string' }, i_will: { type: 'string' },
      },
      required: ['do_now', 'materials', 'bring_back', 'i_will'],
    },
    state_delta: { type: 'object' },
    evidence_refs: { type: 'array', items: { type: 'string' } },
    round_complete: { type: 'boolean' },
  },
};

/**
 * Build the chat-completions request body for a provider.
 * @param {import('./types.mjs').ProviderConfig} p
 * @param {Array<{role: string, content: string}>} messages
 * @param {{plain?: boolean}} [opts] plain: skip the turn-contract JSON strategy —
 *   side-channel calls (title-agent) want a bare text completion.
 */
export function buildRequest(p, messages, opts = {}) {
  const body = { model: p.model, messages: [...messages], temperature: 0.6, stream: false };
  if (opts.plain) return body;
  switch (p.jsonStrategy) {
    case 'json_schema':
      body.response_format = { type: 'json_schema', json_schema: { name: 'turn', schema: TURN_SCHEMA } };
      break;
    case 'tool_call':
      body.tools = [{
        type: 'function',
        function: { name: 'emit_turn', description: '输出本轮的完整结构化回复', parameters: TURN_SCHEMA },
      }];
      body.tool_choice = { type: 'function', function: { name: 'emit_turn' } };
      break;
    case 'json_object_prompt':
      body.response_format = { type: 'json_object' };
      // Vendors require the word "JSON" in the prompt; contract.zh.md already includes
      // the schema, and the last system message re-pins it:
      body.messages = [...messages, { role: 'system', content: '记住：只输出符合契约的 JSON 对象，不要输出任何 JSON 以外的文字。' }];
      break;
  }
  return body;
}

/**
 * Extract the raw turn payload (string or object) from a completion response.
 * Handles MiniMax interleaved thinking and tool-call vs content shapes.
 */
export function extractPayload(p, completion) {
  const choice = completion?.choices?.[0];
  if (!choice) throw new AdapterError('empty_completion', '模型未返回任何选择');
  if (choice.finish_reason === 'content_filter') {
    throw new AdapterError('content_filter', '内容被供应商安全过滤拦截');
  }
  const msg = choice.message ?? {};
  const toolCall = msg.tool_calls?.[0];
  if (toolCall?.function?.arguments) return toolCall.function.arguments;
  let content = typeof msg.content === 'string' ? msg.content : '';
  if (p.stripThinking) {
    content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
  if (!content) throw new AdapterError('empty_completion', '模型返回内容为空');
  return content;
}

export class AdapterError extends Error {
  /** @param {"content_filter"|"http"|"network"|"empty_completion"} kind */
  constructor(kind, message, status = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

// Node's global fetch (undici) sends no User-Agent; Z.AI's coding endpoint
// rejects UA-less requests with a misleading 429 code 1305 ("temporarily
// overloaded"). Any honest UA passes, so always send one.
const USER_AGENT = 'teacher-platform-demo/0.1';

/** One POST to a node's /chat/completions; throws AdapterError on any failure.
 * With onDelta the request streams (stream:true) and progress flows out as
 * onDelta({kind:'first'|'thinking'|'content', …}); the RESULT is identical to
 * the non-streaming path — chunks are accumulated and go through the same
 * extractPayload, so the harness never knows the difference.
 * Three timers, three failure modes (all AdapterError kind 'timeout', .phase set):
 *   - idle (streaming only): every vendor byte re-arms it, so a long
 *     PRODUCTIVE generation is never cut — only a stream that stops talking.
 *   - thinking (streaming only): fires when the model has produced ONLY
 *     reasoning and no answer content within the budget — the caller
 *     (callProvider) catches this phase and retries with thinking disabled,
 *     the closest an open API gets to ChatGPT's "answer now" (their button
 *     works because OpenAI owns the decoding loop; chat/completions has no
 *     mid-request steer channel, so we abort-and-redirect instead).
 *   - total: hard ceiling backstop; without onDelta it is the only guard,
 *     because a buffered call gives no progress signal to watch. */
async function callNode(p, base, apiKey, body, timeoutMs, onDelta, idleTimeoutMs, thinkingBudgetMs) {
  const ctl = new AbortController();
  let timedOut = null; // 'total' | 'idle' | 'thinking'
  const hardTimer = setTimeout(() => { timedOut = 'total'; ctl.abort(); }, timeoutMs);
  let idleTimer = null;
  const armIdle = onDelta && idleTimeoutMs
    ? () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { timedOut = 'idle'; ctl.abort(); }, idleTimeoutMs); }
    : null;
  // Thinking budget: armed until the FIRST answer-content delta (tool args
  // count; <think> interior does not). A model reasoning past it gets cut for
  // the forced-answer retry; a model already answering is never touched. The
  // reasoning streamed so far is KEPT (err.thinkingSoFar) so the retry can
  // hand the model its own draft back instead of rethinking from zero.
  let thinkTimer = null;
  let thinkingLog = '';
  let wrappedDelta = onDelta;
  if (onDelta && thinkingBudgetMs) {
    thinkTimer = setTimeout(() => { timedOut = 'thinking'; ctl.abort(); }, thinkingBudgetMs);
    wrappedDelta = (d) => {
      if (d.kind === 'content' && thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; }
      else if (d.kind === 'thinking' && thinkTimer) thinkingLog += d.text;
      onDelta(d);
    };
  }
  let res;
  try {
    armIdle?.();
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, 'user-agent': USER_AGENT },
      body: JSON.stringify(onDelta ? { ...body, stream: true } : body),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AdapterError('http', `${p.label}（${base}）返回 ${res.status}：${text.slice(0, 300)}`, res.status);
    }
    const completion = onDelta ? await readStream(p, res, wrappedDelta, armIdle) : await res.json();
    return { payload: extractPayload(p, completion), usage: completion.usage ?? null, base_url_used: base };
  } catch (e) {
    if (e instanceof AdapterError) throw e;
    if (timedOut) {
      const err = new AdapterError('timeout',
        timedOut === 'idle'
          ? `${p.label}（${base}）连续 ${Math.round(idleTimeoutMs / 1000)} 秒没有任何输出，已断开——服务可能卡住了，可再试一次或换个服务`
          : timedOut === 'thinking'
            ? `${p.label}（${base}）思考了 ${Math.round(thinkingBudgetMs / 60000)} 分钟还没开始作答，已切断并要求直接作答`
            : `${p.label}（${base}）生成超过 ${Math.round(timeoutMs / 60000)} 分钟仍未完成，已停止`);
      err.phase = timedOut;
      if (timedOut === 'thinking') err.thinkingSoFar = thinkingLog;
      // Guard events surface through the SAME delta channel as progress, so
      // the UI can show WHY a stream ended without waiting for the error path
      // (a thinking cutoff is followed by a retry, not an error).
      if (timedOut !== 'thinking') {
        onDelta?.({ kind: 'guard', event: `${timedOut}_timeout`, limit_ms: timedOut === 'idle' ? idleTimeoutMs : timeoutMs });
      }
      throw err;
    }
    throw new AdapterError('network', `无法连接 ${p.label}（${base}）：${e.message}`);
  } finally {
    clearTimeout(hardTimer);
    clearTimeout(idleTimer);
    clearTimeout(thinkTimer);
  }
}

/**
 * Read an OpenAI-compatible SSE stream and rebuild the non-streaming
 * completion shape. Universal across our providers; the only per-model
 * difference is where thinking lives, and both shapes are handled:
 *   - delta.reasoning_content  (GLM / Z.AI, some aggregator models)
 *   - <think>…</think> inside delta.content (MiniMax M3 — stripThinking set)
 * Tool-call argument chunks count as content progress (raw JSON args are not
 * teacher-facing thinking). Usage is whatever the final chunk carries.
 */
async function readStream(p, res, onDelta, onBytes) {
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let toolArgs = '';
  let toolName = '';
  let usage = null;
  let finishReason = null;
  let sawFirst = false;
  let inThink = false; // <think> scanner state for stripThinking providers
  const t0 = Date.now();

  const feed = (data) => {
    let chunk;
    try { chunk = JSON.parse(data); } catch { return; }
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (!sawFirst && (delta.content || delta.reasoning_content || delta.tool_calls)) {
      sawFirst = true;
      onDelta({ kind: 'first', ms: Date.now() - t0 });
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      onDelta({ kind: 'thinking', text: delta.reasoning_content });
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      if (p.stripThinking) {
        // Forward the inside of <think>…</think> as thinking, the rest as content.
        let text = delta.content;
        while (text) {
          if (inThink) {
            const end = text.indexOf('</think>');
            if (end === -1) { onDelta({ kind: 'thinking', text }); text = ''; }
            else { onDelta({ kind: 'thinking', text: text.slice(0, end) }); text = text.slice(end + 8); inThink = false; }
          } else {
            const start = text.indexOf('<think>');
            if (start === -1) { onDelta({ kind: 'content', chars: content.length }); text = ''; }
            else { text = text.slice(start + 7); inThink = true; }
          }
        }
      } else {
        onDelta({ kind: 'content', chars: content.length });
      }
    }
    const tc = delta.tool_calls?.[0];
    if (tc?.function) {
      if (tc.function.name) toolName = tc.function.name;
      if (tc.function.arguments) {
        toolArgs += tc.function.arguments;
        onDelta({ kind: 'content', chars: toolArgs.length });
      }
    }
  };

  for await (const part of res.body) {
    onBytes?.(); // any vendor byte re-arms the caller's idle timer
    buf += decoder.decode(part, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      feed(data);
    }
  }

  const message = { content };
  if (toolArgs) message.tool_calls = [{ type: 'function', function: { name: toolName || 'emit_turn', arguments: toolArgs } }];
  return { choices: [{ message, finish_reason: finishReason }], usage };
}

/**
 * Normalize the vendor-specific cached-token report out of a usage object.
 * Shapes seen in the wild: OpenAI-compat `prompt_tokens_details.cached_tokens`
 * (GLM/Kimi follow this), DeepSeek-style `prompt_cache_hit_tokens`, bare
 * `cached_tokens`. Returns null when the vendor reported nothing — the UI
 * shows cache info only when it exists ("appearing if needed").
 */
export function cacheInfoFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const cached = usage.prompt_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens
    ?? usage.cached_tokens
    ?? null;
  if (cached == null || typeof cached !== 'number') return null;
  return { cached_tokens: cached, prompt_tokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null };
}

/** Node failures worth retrying on an alternate node of the SAME provider:
 * unreachable, throttled, server-side, or a stream that went silent (idle
 * timeout, cheap to have waited) — NOT auth errors (same key everywhere) and
 * NOT a total-ceiling timeout (that wait must not be paid twice). */
function nodeHopWorthy(e) {
  return e.kind === 'network'
    || (e.kind === 'http' && (e.status === 429 || e.status >= 500))
    || (e.kind === 'timeout' && e.phase === 'idle');
}

/**
 * Call one provider once. Node 18+ global fetch. Providers with `altBaseURLs`
 * (e.g. FreeModel.dev's tier nodes) fail over across their own nodes
 * automatically when the primary is down/throttled; the node actually used is
 * returned as `base_url_used` so the debug drawer / session log can show it.
 * @returns {Promise<{payload: string|Object, usage: Object|null, base_url_used: string}>}
 */
// Timeouts (2026-07-23, tuned with Herman): the graceful guard is the IDLE
// timer — while the vendor keeps streaming bytes the call lives, however long
// it runs; only a silent stream is cut (120s covers real inter-token gaps and
// stays far below the public nginx 660s read window, whose clock our SSE
// progress events keep resetting client-side). The THINKING budget (5 min) is
// the "answer now" analog: a model that reasons past it without producing any
// answer content gets one forced-answer retry — thinking disabled where the
// vendor has a switch (disableThinking), plus its OWN captured draft handed
// back so the burned minutes aren't wasted. The total ceiling (10 min) is a
// WALL-CLOCK budget across both attempts (5 thinking + ~5 forced answer),
// and the only guard on non-streaming calls.
export async function callProvider(p, apiKey, messages, { timeoutMs = 600000, idleTimeoutMs = 120000, thinkingBudgetMs = 300000, plain = false, onDelta = null } = {}) {
  const t0 = Date.now();
  const tryBases = async (body, budget, ceiling) => {
    const bases = [p.baseURL, ...(Array.isArray(p.altBaseURLs) ? p.altBaseURLs : [])];
    let lastErr = null;
    for (const base of bases) {
      try {
        return await callNode(p, base, apiKey, body, ceiling, onDelta, idleTimeoutMs, budget);
      } catch (e) {
        lastErr = e;
        if (!(e instanceof AdapterError) || !nodeHopWorthy(e) || base === bases[bases.length - 1]) throw e;
      }
    }
    throw lastErr; // unreachable; loop always returns or throws
  };

  const body = buildRequest(p, messages, { plain });
  try {
    return await tryBases(body, thinkingBudgetMs, timeoutMs);
  } catch (e) {
    if (!(e instanceof AdapterError) || e.phase !== 'thinking') throw e;
    // Forced answer, once. The retry is a NEW request (no way to steer the
    // aborted one), but not from zero: the reasoning streamed before the cut
    // rides along (tail-truncated — the end of a draft is its most decided
    // part), so the model resumes instead of rethinking. No budget on the
    // retry; idle still guards it; the ceiling is whatever wall-clock remains.
    const draft = String(e.thinkingSoFar ?? '').slice(-6000);
    onDelta?.({ kind: 'guard', event: 'forced_answer_retry', budget_ms: thinkingBudgetMs, draft_chars: draft.length });
    const nudge = draft
      ? `思考时间已用完。下面是你已完成的思考草稿（直接采用其结论，不要重新推理）：\n${draft}\n——现在立刻直接输出最终回复。`
      : '思考时间已用完：不要再推理，立刻直接输出最终回复。';
    const forced = {
      ...body,
      ...(p.disableThinking ?? {}),
      messages: [...body.messages, { role: 'system', content: nudge }],
    };
    return await tryBases(forced, 0, Math.max(timeoutMs - (Date.now() - t0), 60000));
  }
}

/**
 * List models from a provider's OpenAI-compatible /models endpoint.
 * @returns {Promise<string[]>} model ids, sorted
 */
export async function listModels(p, apiKey, { timeoutMs = 20000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${p.baseURL}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, 'user-agent': USER_AGENT },
      signal: ctl.signal,
    });
  } catch (e) {
    throw new AdapterError('network', `无法连接 ${p.label ?? p.baseURL}：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AdapterError('http', `${p.label ?? p.baseURL} 返回 ${res.status}：${text.slice(0, 200)}`, res.status);
  }
  const body = await res.json();
  const ids = (Array.isArray(body?.data) ? body.data : [])
    .map((m) => m?.id)
    .filter((id) => typeof id === 'string');
  return [...new Set(ids)].sort();
}

/**
 * Call with failover: try `preferred`, then the FAILOVER chain, skipping
 * providers without a key. Returns the first success.
 * @param {Record<string,string>} keys  providerId → apiKey
 * @param {{ timeoutMs?: number, registry?: Record<string, import('./types.mjs').ProviderConfig> }} opts
 *   opts.registry lets the caller extend/override PROVIDERS (model override, custom endpoint).
 */
export async function callWithFailover(preferred, keys, messages, opts = {}) {
  const registry = opts.registry ?? PROVIDERS;
  const chain = [preferred, ...FAILOVER.filter((id) => id !== preferred)];
  const errors = [];
  for (const id of chain) {
    const p = registry[id];
    if (!p || p.enabled === false || !keys[id]) continue;
    try {
      const r = await callProvider(p, keys[id], messages, opts);
      return { ...r, provider: id, errors };
    } catch (e) {
      errors.push({ provider: id, kind: e.kind ?? 'unknown', message: e.message });
      // content_filter and 4xx auth errors: try the next provider; anything else too —
      // the chain is short and the demo favors resilience over precision.
      // EXCEPT a total-ceiling timeout: 30 minutes are already burned; starting
      // another marathon uninvited is worse than handing the teacher the retry.
      if (e.kind === 'timeout' && e.phase === 'total') break;
    }
  }
  // Nothing was even attempted (every provider skipped for lack of a key) reads
  // very differently from "everything was tried and failed" — say which it was.
  const err = errors.length
    ? new AdapterError('network', `所有可用供应商都失败了：${errors.map((e) => `${e.provider}(${e.kind})`).join('，')}。点开「失败详情」看具体原因。`)
    : new AdapterError('network', '没有可尝试的供应商：所选服务与备选链都没有 API 密钥。请在设置里填写至少一个密钥，或改用演示模式。');
  err.chain = errors;
  throw err;
}
