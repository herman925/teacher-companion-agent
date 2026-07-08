// Provider-agnostic model adapter (docs/MODEL-APIS.md §4 is normative).
// One OpenAI-compatible client; per-provider JSON strategy + quirk handling.
// Runs in Node (serve.mjs). Keys never touch the repo.

/** @type {Record<string, import('./types.mjs').ProviderConfig>} */
export const PROVIDERS = {
  minimax: {
    id: 'minimax',
    label: 'MiniMax-M3',
    baseURL: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-M3',
    jsonStrategy: 'tool_call',
    stripThinking: true,
    enabled: true,
  },
  glm: {
    id: 'glm',
    label: 'GLM-5.2',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.2',
    jsonStrategy: 'json_schema',
    enabled: true,
  },
  'glm-flash': {
    id: 'glm-flash',
    label: 'GLM-4.7-Flash（免费）',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.7-flash',
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
  // OpenCode local server (opencode.ai/docs/server): a session-based API, NOT
  // OpenAI /chat/completions. `opencode serve` proxies whatever models the user
  // has authed (Zen free tier, or their own MiniMax/GLM/… keys). We drive it
  // through the same turn contract via json_object_prompt — its json_schema
  // `format` refused several models in testing, so we rely on the prompt.
  // `model` is "providerID/modelID" (opencode's two-part identifier).
  opencode: {
    id: 'opencode',
    label: 'OpenCode（本地）',
    baseURL: 'http://127.0.0.1:4096',
    model: 'opencode/deepseek-v4-flash-free',
    kind: 'opencode',
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
 * Split OpenCode's two-part "providerID/modelID" identifier.
 * @returns {{ providerID: string, modelID: string }}
 */
function splitOpencodeModel(model) {
  const idx = String(model).indexOf('/');
  if (idx <= 0 || idx === String(model).length - 1) {
    throw new AdapterError('http', `OpenCode 模型需写成 providerID/modelID，当前：${model}`);
  }
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

/** Optional Basic-auth header when the OpenCode server runs with a password. */
function opencodeHeaders(apiKey) {
  const h = { 'content-type': 'application/json' };
  if (apiKey) h.authorization = `Basic ${Buffer.from(`opencode:${apiKey}`).toString('base64')}`;
  return h;
}

/**
 * Call the OpenCode local server for one turn (opencode.ai/docs/server):
 * create a session, POST one message, read the assistant text parts.
 * The session is stateless from our side — we resend the flattened transcript
 * each turn, mirroring how the OpenAI-compatible path works.
 * @returns {Promise<{payload: string, usage: Object|null}>}
 */
async function callOpencode(p, apiKey, messages, { timeoutMs = 180000 } = {}) {
  const base = p.baseURL.replace(/\/+$/, '');
  const { providerID, modelID } = splitOpencodeModel(p.model);
  const headers = opencodeHeaders(apiKey);

  // System-role messages carry the contract; fold in the json_object_prompt
  // reinforcement (OpenCode has no response_format we can rely on here).
  const system = [
    ...messages.filter((m) => m.role === 'system').map((m) => m.content),
    '记住：只输出符合契约的 JSON 对象，不要输出任何 JSON 以外的文字。',
  ].join('\n\n');
  const transcript = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'assistant' ? '【助手上一轮】' : '【教师】'}\n${m.content}`)
    .join('\n\n');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let res = await fetch(`${base}/session`, {
      method: 'POST', headers, body: JSON.stringify({ title: '陪跑 demo' }), signal: ctl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new AdapterError('http', `OpenCode 建会话失败 ${res.status}：${t.slice(0, 200)}`, res.status);
    }
    const session = await res.json();
    if (!session?.id) throw new AdapterError('http', 'OpenCode 未返回会话 id');

    const body = {
      model: { providerID, modelID },
      system,
      tools: {}, // don't let the coding agent reach for file tools during a chat turn
      parts: [{ type: 'text', text: transcript || '（无内容）' }],
    };
    res = await fetch(`${base}/session/${session.id}/message`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new AdapterError('http', `OpenCode 返回 ${res.status}：${t.slice(0, 300)}`, res.status);
    }
    const data = await res.json();
    // The model call can fail inside a 200 envelope (info.error), e.g. a disabled model.
    const modelErr = data?.info?.error;
    if (modelErr) {
      const detail = modelErr.data?.message || modelErr.name || 'unknown';
      throw new AdapterError('http', `OpenCode 模型报错：${detail}`, modelErr.data?.statusCode ?? 0);
    }
    const text = (Array.isArray(data?.parts) ? data.parts : [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim();
    if (!text) throw new AdapterError('empty_completion', 'OpenCode 未返回文本');
    const tk = data?.info?.tokens;
    const usage = tk ? {
      prompt_tokens: tk.input ?? 0,
      completion_tokens: tk.output ?? 0,
      total_tokens: (tk.input ?? 0) + (tk.output ?? 0),
    } : null;
    return { payload: text, usage };
  } catch (e) {
    if (e instanceof AdapterError) throw e;
    if (e.name === 'AbortError') throw new AdapterError('network', `OpenCode 请求超时（>${Math.round(timeoutMs / 1000)}s）`);
    throw new AdapterError('network', `无法连接 OpenCode（${base}）：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call one provider once. Node 18+ global fetch.
 * @returns {Promise<{payload: string|Object, usage: Object|null}>}
 */
export async function callProvider(p, apiKey, messages, { timeoutMs = 180000 } = {}) {
  if (p.kind === 'opencode') return callOpencode(p, apiKey, messages, { timeoutMs });
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
  if (p.kind === 'opencode') return listOpencodeModels(p, apiKey, { timeoutMs });
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
 * List models from an OpenCode server's /config/providers, flattened to the
 * "providerID/modelID" ids the message API expects.
 * @returns {Promise<string[]>}
 */
async function listOpencodeModels(p, apiKey, { timeoutMs = 20000 } = {}) {
  const base = p.baseURL.replace(/\/+$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${base}/config/providers`, { headers: opencodeHeaders(apiKey), signal: ctl.signal });
  } catch (e) {
    throw new AdapterError('network', `无法连接 OpenCode（${base}）：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AdapterError('http', `OpenCode 返回 ${res.status}：${text.slice(0, 200)}`, res.status);
  }
  const body = await res.json();
  const ids = [];
  for (const prov of Array.isArray(body?.providers) ? body.providers : []) {
    for (const modelID of Object.keys(prov?.models ?? {})) ids.push(`${prov.id}/${modelID}`);
  }
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
    // OpenCode holds the model keys itself — the server auth password is optional.
    if (!p || p.enabled === false || (p.kind !== 'opencode' && !keys[id])) continue;
    try {
      const r = await callProvider(p, keys[id], messages, opts);
      return { ...r, provider: id, errors };
    } catch (e) {
      errors.push({ provider: id, kind: e.kind ?? 'unknown', message: e.message });
      // content_filter and 4xx auth errors: try the next provider; anything else too —
      // the chain is short and the demo favors resilience over precision.
    }
  }
  const err = new AdapterError('network', `所有可用供应商都失败了：${errors.map((e) => `${e.provider}(${e.kind})`).join('，')}`);
  err.chain = errors;
  throw err;
}
