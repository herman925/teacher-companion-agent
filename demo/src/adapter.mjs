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
  glm: {
    id: 'glm',
    label: 'GLM（智谱国内 bigmodel.cn）',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.2',
    jsonStrategy: 'json_schema',
    enabled: true,
  },
  zai: {
    id: 'zai',
    label: 'GLM · Z.AI（国际，按量计费）',
    baseURL: 'https://api.z.ai/api/paas/v4',
    model: 'glm-5.2',
    jsonStrategy: 'json_schema',
    enabled: true,
  },
  'zai-coding': {
    id: 'zai-coding',
    label: 'GLM · Z.AI Coding Plan（国际，订阅额度）',
    baseURL: 'https://api.z.ai/api/coding/paas/v4',
    model: 'glm-5.2',
    jsonStrategy: 'json_schema',
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
  freemodel: {
    id: 'freemodel',
    label: 'FreeModel.dev',
    baseURL: 'https://api.freemodel.dev/v1',
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
 */
export function buildRequest(p, messages) {
  const body = { model: p.model, messages: [...messages], temperature: 0.6, stream: false };
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

/**
 * Call one provider once. Node 18+ global fetch.
 * @returns {Promise<{payload: string|Object, usage: Object|null}>}
 */
export async function callProvider(p, apiKey, messages, { timeoutMs = 180000 } = {}) {
  const body = buildRequest(p, messages);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${p.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    throw new AdapterError('network', `无法连接 ${p.label}：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AdapterError('http', `${p.label} 返回 ${res.status}：${text.slice(0, 300)}`, res.status);
  }
  const completion = await res.json();
  return { payload: extractPayload(p, completion), usage: completion.usage ?? null };
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
      headers: { authorization: `Bearer ${apiKey}` },
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
