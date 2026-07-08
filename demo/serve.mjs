#!/usr/bin/env node
// Demo server: static files + /api/chat turn pipeline (ARCHITECTURE.md §3).
// Zero dependencies, Node >= 18. The browser never talks to LLM vendors directly
// (CORS + key custody, MODEL-APIS.md §3); this proxy is where the runtime
// harness lives — the same core modules a CloudBase function will import later.
//
// Usage:  node demo/serve.mjs [--port 8787]
// Keys:   entered in the UI per session (sent per-request, held only in memory),
//         or seeded via env: MINIMAX_API_KEY / GLM_API_KEY / KIMI_API_KEY / QWEN_API_KEY.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVIDERS, callWithFailover, listModels } from './src/adapter.mjs';
import { mockTurn } from './src/mock.mjs';
import { parseTurn, validateTurn, violationFeedback, safeTemplate } from './src/harness.mjs';
import { applyDelta, createInitialState, STAGE_NAMES } from './src/engine.mjs';
import { buildSystemPrompt, stageModuleName, profileSectionText } from './src/prompt-builder.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Port precedence: FC_SERVER_PORT (Alibaba FC web function) > --port > 8787; FC needs 0.0.0.0.
const PORT = Number(process.env.FC_SERVER_PORT) || Number(process.env.PORT) || Number(process.argv[process.argv.indexOf('--port') + 1]) || 8787;
const HOST = (process.env.FC_SERVER_PORT || process.env.PORT) ? '0.0.0.0' : (process.env.HOST || '127.0.0.1');

const ENV_KEYS = {
  minimax: process.env.MINIMAX_API_KEY || '',
  glm: process.env.GLM_API_KEY || '',
  'glm-flash': process.env.GLM_API_KEY || '',
  kimi: process.env.KIMI_API_KEY || '',
  qwen: process.env.QWEN_API_KEY || '',
};

// ---------- prompt assembly ----------

const PROMPT_DIR = path.join(ROOT, 'src', 'prompts');
const promptCache = new Map();
function loadPrompt(name) {
  if (!promptCache.has(name)) {
    promptCache.set(name, readFileSync(path.join(PROMPT_DIR, `${name}.zh.md`), 'utf8'));
  }
  return promptCache.get(name);
}

// ---------- provider configuration (per-request overrides) ----------

/**
 * Build the effective provider registry for one request.
 * Supported overrides (all optional, from the settings drawer):
 *   req.model            — model id override for the preferred provider
 *   req.custom           — { baseURL, model, label? } OpenAI-compatible custom endpoint
 *                          (json_object_prompt strategy; key under keys.custom)
 *   req.opencode         — { baseURL?, model? } OpenCode local server overrides
 *                          (session API; optional server password under keys.opencode)
 */
function effectiveRegistry(req) {
  const registry = { ...PROVIDERS };
  if (req.custom?.baseURL && req.custom?.model) {
    registry.custom = {
      id: 'custom',
      label: req.custom.label || '自定义端点',
      baseURL: String(req.custom.baseURL).replace(/\/+$/, ''),
      model: req.custom.model,
      jsonStrategy: 'json_object_prompt',
      enabled: true,
    };
  }
  if (req.opencode && registry.opencode) {
    registry.opencode = {
      ...registry.opencode,
      ...(req.opencode.baseURL ? { baseURL: String(req.opencode.baseURL).replace(/\/+$/, '') } : {}),
      ...(req.opencode.model ? { model: req.opencode.model } : {}),
    };
  }
  const preferred = req.provider;
  if (req.model && registry[preferred] && preferred !== 'custom') {
    registry[preferred] = { ...registry[preferred], model: req.model };
  }
  return registry;
}

// ---------- turn pipeline ----------

/**
 * Run one full turn: prompt → model (failover) → L2/L3 → L4 retry → engine apply.
 * @param {{state: Object, history: Array, message: string, provider: string, keys: Object}} req
 * @param {(event: string, data: Object) => void} emit  SSE progress
 */
async function runTurn(req, emit) {
  const state = req.state && req.state.course_id ? req.state : createInitialState(`course-${Date.now()}`);
  const keys = { ...ENV_KEYS, ...(req.keys || {}) };
  const registry = effectiveRegistry(req);
  const preferred = req.provider === 'mock' ? 'mock'
    : req.provider && registry[req.provider] ? req.provider : 'minimax';

  // Prompt assembly is shared with the demo UI (prompt-builder.mjs); the
  // optional 教师档案 travels as read-only context, never through state_delta.
  const systemPrompt = await buildSystemPrompt(state, loadPrompt, { profile: req.profile });
  const keptHistory = (req.history || []).slice(-24);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...keptHistory,
    { role: 'user', content: req.message },
  ];

  emit('status', { text: '正在阅读你的课程状态…', stage: state.stage, stageName: STAGE_NAMES[state.stage] });

  let attempt = 1;
  let degraded = false;
  let turn = null;
  let allViolations = [];
  let provider = preferred;
  let usage = null;

  while (attempt <= 2) {
    emit('status', { text: attempt === 1 ? '正在思考这一轮…' : '第一稿被护栏拦下，正在重写…' });
    // 'mock' provider: scripted walkthrough through the SAME L2/L3/L4 pipeline.
    const result = preferred === 'mock'
      ? { payload: mockTurn(state, req.history || [], req.message, { profile: req.profile }), usage: null, provider: 'mock' }
      : await callWithFailover(preferred, keys, messages, { registry });
    provider = result.provider;
    usage = result.usage;

    const parsed = parseTurn(result.payload);
    const violations = parsed.turn ? validateTurn(parsed.turn, state) : parsed.violations;
    const blocking = violations.filter((v) => v.action === 'block');
    allViolations.push(...violations.map((v) => ({ ...v, attempt })));

    if (parsed.turn && blocking.length === 0) {
      turn = parsed.turn;
      break;
    }
    if (attempt === 2) {
      turn = safeTemplate(state); // L4 terminal fallback
      degraded = true;
      break;
    }
    // L4: inject violation report and regenerate once.
    messages.push(
      { role: 'assistant', content: typeof result.payload === 'string' ? result.payload : JSON.stringify(result.payload) },
      { role: 'user', content: violationFeedback(blocking.length ? blocking : violations) },
    );
    attempt += 1;
  }

  const applied = applyDelta(state, turn.state_delta, {
    roundComplete: turn.round_complete,
    teacherTurn: true,
  });
  allViolations.push(...applied.violations.map((v) => ({ ...v, attempt: 'apply' })));

  emit('turn', {
    turn,
    state: applied.state,
    // Dev-mode prompt visibility: full system prompt, only on request.
    ...(req.debug === true ? {
      prompt_debug: {
        system: systemPrompt,
        stage_module: stageModuleName(state),
        history_count: keptHistory.length,
        profile_injected: Boolean(profileSectionText(req.profile)),
        source: 'server',
      },
    } : {}),
    gate_report: { ok: !degraded, violations: allViolations, attempt, degraded },
    provider,
    providerLabel: provider === 'mock' ? '演示模式' : `${registry[provider]?.label ?? provider} · ${registry[provider]?.model ?? ''}`,
    usage,
    stageName: STAGE_NAMES[applied.state.stage],
  });
}

// ---------- http plumbing ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS: the static UI (e.g. GitHub Pages) and this proxy (e.g. Alibaba FC) can be
  // different origins. Set permissive headers on every response + answer preflight.
  res.setHeader('access-control-allow-origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,accept');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      providers: Object.entries(PROVIDERS)
        .filter(([, p]) => p.enabled !== false)
        .map(([id, p]) => ({ id, label: p.label, defaultModel: p.model, hasEnvKey: Boolean(ENV_KEYS[id]) })),
    }));
    return;
  }

  // List a provider's available models (proxied — the browser can't reach vendors directly).
  if (url.pathname === '/api/models' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.writeHead(200, { 'content-type': 'application/json' });
    try {
      const q = JSON.parse(body);
      const registry = effectiveRegistry({ ...q, provider: q.provider });
      const p = registry[q.provider];
      if (!p) throw new Error(`未知供应商：${q.provider}`);
      const key = q.key || ENV_KEYS[q.provider] || '';
      // OpenCode holds model keys itself; its server password is optional.
      if (!key && p.kind !== 'opencode') throw new Error('缺少 API 密钥——先填密钥再获取模型列表');
      const models = await listModels(p, key);
      res.end(JSON.stringify({ ok: true, provider: q.provider, defaultModel: p.model, models }));
    } catch (e) {
      res.end(JSON.stringify({ ok: false, message: e.message, status: e.status ?? 0 }));
    }
    return;
  }

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    // Buffered mode (Accept: application/json, no event-stream): collect the SSE events
    // and return them as one JSON payload. Cross-origin / serverless deploys (e.g. Alibaba
    // FC) use this when response streaming is constrained; the browser replays the events.
    const accept = req.headers.accept || '';
    if (accept.includes('application/json') && !accept.includes('text/event-stream')) {
      const events = [];
      const emit = (event, data) => events.push({ event, data });
      try {
        await runTurn(JSON.parse(body), emit);
      } catch (e) {
        emit('error', { kind: e.kind ?? 'internal', message: e.message, chain: e.chain ?? [] });
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ events }));
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      await runTurn(JSON.parse(body), emit);
    } catch (e) {
      emit('error', { kind: e.kind ?? 'internal', message: e.message, chain: e.chain ?? [] });
    }
    res.end();
    return;
  }

  // static: demo/ files, plus /schema/ passthrough for the debug drawer
  let filePath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  if (filePath.startsWith('/schema/')) {
    filePath = path.join(ROOT, '..', 'harness', filePath);
  } else {
    filePath = path.join(ROOT, filePath);
  }
  if (!path.resolve(filePath).startsWith(path.resolve(path.join(ROOT, '..')))) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

server.listen(PORT, HOST, () => {
  const seeded = Object.entries(ENV_KEYS).filter(([, v]) => v).map(([k]) => k);
  console.log(`陪跑智能体 demo → http://localhost:${PORT}`);
  console.log(seeded.length ? `env keys detected: ${seeded.join(', ')}` : 'no env keys — enter one in the UI settings drawer');
  if (!existsSync(path.join(PROMPT_DIR, 'base.zh.md'))) console.warn('WARNING: prompts missing');
});
