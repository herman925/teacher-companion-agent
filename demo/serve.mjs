#!/usr/bin/env node
// Demo server: static files + /api/chat turn pipeline (ARCHITECTURE.md §3).
// Zero dependencies, Node >= 18. The browser never talks to LLM vendors directly
// (CORS + key custody, MODEL-APIS.md §3); this proxy is where the runtime
// harness lives — the same core modules a CloudBase function will import later.
//
// Usage:  node demo/serve.mjs [--port 8787]
// Keys:   entered in the UI per session (sent per-request, held only in memory),
//         or seeded via env — see ENV_KEYS below (MINIMAX_API_KEY, ZAI_API_KEY,
//         GLM_API_KEY, OPENROUTER_API_KEY, FREEMODEL_API_KEY, KILO_API_KEY, …).

import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVIDERS, callWithFailover, listModels } from './src/adapter.mjs';
import { mockTurn } from './src/mock.mjs';
import { WF_NODES } from './src/wf-nodes.mjs';
import { parseTurn, validateTurn, violationFeedback, safeTemplate } from './src/harness.mjs';
import { applyDelta, createInitialState, STAGE_NAMES } from './src/engine.mjs';
import { buildSystemPrompt, stageModuleName, profileSectionText } from './src/prompt-builder.mjs';
import { store } from './src/store.mjs';

// Demo persistence tier (DATABASE.md §4): single hard-coded user, no auth.
// Real auth + per-teacher scoping is the v1 persistence-layer build.
const DEMO_USER = 'demo';

// Admin console password. When ADMIN_TOKEN is set, /api/admin/* requires the
// x-admin-token header to carry the SHA-256 hex of the password (what the
// console page sends — the plaintext never travels from the page) or the
// plaintext itself (curl convenience). Unset = open, which is correct ONLY on
// the dev instance: it is reachable solely through the SSH tunnel, and the
// tunnel is the (machine) authentication. Planned: retire the password path,
// authorized-machine access only (OPERATIONS.md). The password itself lives in
// the server .env — never in the repo (AGENTS.md non-negotiable 5).
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ADMIN_TOKEN_SHA256 = ADMIN_TOKEN ? createHash('sha256').update(ADMIN_TOKEN).digest('hex') : '';
function adminAuthorized(req) {
  if (!ADMIN_TOKEN) return true;
  const supplied = String(req.headers['x-admin-token'] || '');
  return supplied === ADMIN_TOKEN || supplied.toLowerCase() === ADMIN_TOKEN_SHA256;
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Port precedence: FC_SERVER_PORT (Alibaba FC web function) > --port > 8787; FC needs 0.0.0.0.
const PORT = Number(process.env.FC_SERVER_PORT) || Number(process.env.PORT) || Number(process.argv[process.argv.indexOf('--port') + 1]) || 8787;
const HOST = (process.env.FC_SERVER_PORT || process.env.PORT) ? '0.0.0.0' : (process.env.HOST || '127.0.0.1');

const ENV_KEYS = {
  minimax: process.env.MINIMAX_API_KEY || '',
  'minimax-intl': process.env.MINIMAX_INTL_API_KEY || '',
  glm: process.env.GLM_API_KEY || '',
  zai: process.env.ZAI_API_KEY || '',
  'zai-coding': process.env.ZAI_API_KEY || '',
  kimi: process.env.KIMI_API_KEY || '',
  qwen: process.env.QWEN_API_KEY || '',
  freemodel: process.env.FREEMODEL_API_KEY || '',
  openrouter: process.env.OPENROUTER_API_KEY || '',
  kilocode: process.env.KILO_API_KEY || '',
  'opencode-zen': process.env.OPENCODE_API_KEY || '',
};

// ---------- prompt assembly ----------

const WF_NAME = Object.fromEntries(WF_NODES.map((n) => [n.id, n.name]));

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
  const debug = req.debug === true;
  // Full API round-trip log (dev-mode only): what left, what came back, and the
  // harness verdict on each attempt. Never gated behind the model — pure transparency.
  const apiAttempts = [];
  let chainErrors = [];

  while (attempt <= 2) {
    emit('status', { text: attempt === 1 ? '正在思考这一轮…' : '第一稿被护栏拦下，正在重写…' });
    // Snapshot the exact messages sent before the call (the array mutates on L4 retry).
    const sentMessages = debug ? messages.map((m) => ({ role: m.role, content: m.content })) : null;
    const t0 = Date.now();
    // 'mock' provider: scripted walkthrough through the SAME L2/L3/L4 pipeline.
    const result = preferred === 'mock'
      ? { payload: mockTurn(state, req.history || [], req.message, { profile: req.profile }), usage: null, provider: 'mock', errors: [] }
      : await callWithFailover(preferred, keys, messages, { registry });
    const elapsedMs = Date.now() - t0;
    provider = result.provider;
    usage = result.usage;
    if (result.errors?.length) chainErrors = result.errors;

    const parsed = parseTurn(result.payload);
    const violations = parsed.turn ? validateTurn(parsed.turn, state) : parsed.violations;
    const blocking = violations.filter((v) => v.action === 'block');
    allViolations.push(...violations.map((v) => ({ ...v, attempt })));

    const accepted = Boolean(parsed.turn) && blocking.length === 0;
    let feedback = null;
    let decision;
    if (accepted) decision = 'accepted';
    else if (attempt === 2) decision = 'degraded';
    else { decision = 'retried'; feedback = violationFeedback(blocking.length ? blocking : violations); }

    if (debug) {
      const p = registry[result.provider] ?? {};
      apiAttempts.push({
        attempt,
        provider: result.provider,
        // base_url_used: the node that actually answered (providers with
        // altBaseURLs, e.g. FreeModel tier nodes, hop automatically).
        endpoint: `${result.base_url_used ?? p.baseURL ?? ''}/chat/completions`,
        model: p.model ?? '',
        strategy: p.jsonStrategy ?? '',
        request_messages: sentMessages,
        response_raw: typeof result.payload === 'string' ? result.payload : JSON.stringify(result.payload, null, 2),
        usage: result.usage ?? null,
        elapsed_ms: elapsedMs,
        parsed_ok: Boolean(parsed.turn),
        violations: violations.map((v) => ({ kind: v.kind, action: v.action, detail: v.detail })),
        blocking_count: blocking.length,
        decision,
        feedback_injected: feedback,
      });
    }

    if (accepted) { turn = parsed.turn; break; }
    if (attempt === 2) { turn = safeTemplate(state); degraded = true; break; } // L4 terminal fallback
    // L4: inject violation report and regenerate once.
    messages.push(
      { role: 'assistant', content: typeof result.payload === 'string' ? result.payload : JSON.stringify(result.payload) },
      { role: 'user', content: feedback },
    );
    attempt += 1;
  }

  const applied = applyDelta(state, turn.state_delta, {
    roundComplete: turn.round_complete,
    teacherTurn: true,
  });
  allViolations.push(...applied.violations.map((v) => ({ ...v, attempt: 'apply' })));

  // Dev-mode wf_trace: if the model didn't emit its own trace, synthesize one
  // from the nodes it declared this turn (state_delta.completed_nodes). Makes the
  // 工作流地图 / node annotations reflect real turns, and honestly reports when
  // the model declared no nodes at all.
  if (debug && turn && !turn.wf_trace) {
    const declared = Array.isArray(turn.state_delta?.completed_nodes) ? turn.state_delta.completed_nodes : [];
    turn.wf_trace = {
      stage: applied.state.stage,
      mode: applied.state.teacher_mode,
      nodes: declared.map((id) => ({ id, name: WF_NAME[id] ?? id })),
      state_notes: declared.length
        ? '（server 依据本轮 completed_nodes 合成）'
        : '本轮模型未申报完成任何 WF 节点（completed_nodes 为空）——工作流地图不会前进。',
      synthesized: true,
    };
  }

  emit('turn', {
    turn,
    state: applied.state,
    // Dev-mode prompt visibility: full system prompt, only on request.
    ...(debug ? {
      prompt_debug: {
        system: systemPrompt,
        stage_module: stageModuleName(state),
        history_count: keptHistory.length,
        profile_injected: Boolean(profileSectionText(req.profile)),
        source: 'server',
      },
      api_debug: {
        provider,
        model: registry[provider]?.model ?? '',
        base_url: registry[provider]?.baseURL ?? '',
        kind: registry[provider]?.kind ?? 'openai',
        chain_errors: chainErrors,
        attempts: apiAttempts,
      },
    } : {}),
    gate_report: { ok: !degraded, violations: allViolations, attempt, degraded },
    provider,
    providerLabel: provider === 'mock' ? '演示模式' : `${registry[provider]?.label ?? provider} · ${registry[provider]?.model ?? ''}`,
    usage,
    stageName: STAGE_NAMES[applied.state.stage],
  });
}

/**
 * Persistent turn (DATABASE.md §4): server owns state + history.
 * Loads the course's state and last 10 messages from the store, runs the SAME
 * pipeline, then appends both message rows and saves the new state (with the
 * checkpoint snapshot). Emits the identical SSE events as /api/chat.
 */
async function runCourseTurn(userId, courseId, body, emit) {
  const course = await store.getCourse(userId, courseId);
  if (!course) { emit('error', { kind: 'not_found', message: '课程不存在' }); return; }

  // Store roles are teacher/agent/system; the model pipeline speaks user/assistant.
  const recent = await store.getMessages(courseId, { limit: 10 });
  const history = recent.map((m) => ({
    role: m.role === 'agent' ? 'assistant' : 'user',
    content: m.content,
  }));

  let captured = null;
  const wrap = (event, data) => { if (event === 'turn') captured = data; emit(event, data); };
  await runTurn({ ...body, state: course.course_state, history, message: body.message }, wrap);

  // Persist only a real, accepted turn. append-only messages + gated state save.
  if (captured && captured.turn) {
    await store.appendMessage(courseId, { role: 'teacher', content: body.message });
    await store.appendMessage(courseId, {
      role: 'agent',
      content: captured.turn.reply_markdown ?? '',
      turn_contract: captured.turn, // full turn for faithful history re-render
      provider: captured.provider ?? null,
      provider_label: captured.providerLabel ?? null,
      usage: captured.usage ?? null,
      stage_name: captured.stageName ?? null,
    });
    try {
      await store.saveState(courseId, captured.turn.state_delta ?? {}, captured.state, course.state_version);
    } catch { /* optimistic-lock conflict (not expected single-user); messages kept, state left */ }
  }
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
      // Demo persistence tier is always on when a server answers (DATABASE.md §4).
      persistence: true,
      user: DEMO_USER,
      providers: Object.entries(PROVIDERS)
        .filter(([, p]) => p.enabled !== false)
        .map(([id, p]) => ({ id, label: p.label, defaultModel: p.model, hasEnvKey: Boolean(ENV_KEYS[id]) })),
    }));
    return;
  }

  // ---------- demo persistence tier: courses + server-side chat history ----------
  // Single demo user (DEMO_USER); no auth this tier. Maps to DATABASE.md courses/messages.
  if (url.pathname === '/api/courses' || url.pathname.startsWith('/api/courses/')) {
    const rest = url.pathname.slice('/api/courses'.length); // '' | '/:id' | '/:id/messages' | '/:id/chat'
    const seg = rest.split('/').filter(Boolean).map(decodeURIComponent);
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    try {
      // GET /api/courses — list
      if (seg.length === 0 && req.method === 'GET') {
        return json(200, { ok: true, courses: await store.listCourses(DEMO_USER) });
      }
      // POST /api/courses — create (30-course quota enforced in the store)
      if (seg.length === 0 && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const q = body ? JSON.parse(body) : {};
        try {
          const course = await store.createCourse(DEMO_USER, q.title);
          return json(200, { ok: true, course });
        } catch (e) {
          return json(e.status === 409 ? 409 : 500, { ok: false, message: e.message });
        }
      }
      const courseId = seg[0];
      // GET /api/courses/:id — course + current state document
      if (seg.length === 1 && req.method === 'GET') {
        const course = await store.getCourse(DEMO_USER, courseId);
        if (!course) return json(404, { ok: false, message: '课程不存在' });
        return json(200, { ok: true, course });
      }
      // DELETE /api/courses/:id — whole-course erasure (data-subject deletion)
      if (seg.length === 1 && req.method === 'DELETE') {
        const removed = await store.deleteCourse(DEMO_USER, courseId);
        if (!removed) return json(404, { ok: false, message: '课程不存在' });
        return json(200, { ok: true, deleted: courseId });
      }
      // GET /api/courses/:id/messages?before=&limit= — paged history
      if (seg.length === 2 && seg[1] === 'messages' && req.method === 'GET') {
        const before = url.searchParams.get('before');
        const limit = url.searchParams.get('limit');
        const messages = await store.getMessages(courseId, {
          before: before != null ? Number(before) : undefined,
          limit: limit != null ? Number(limit) : undefined,
        });
        return json(200, { ok: true, messages });
      }
      // POST /api/courses/:id/chat — the turn endpoint, server-side state
      if (seg.length === 2 && seg[1] === 'chat' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const accept = req.headers.accept || '';
        const parsed = JSON.parse(body);
        if (accept.includes('application/json') && !accept.includes('text/event-stream')) {
          const events = [];
          const emit = (event, data) => events.push({ event, data });
          try { await runCourseTurn(DEMO_USER, courseId, parsed, emit); }
          catch (e) { emit('error', { kind: e.kind ?? 'internal', message: e.message, chain: e.chain ?? [] }); }
          return json(200, { events });
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        try { await runCourseTurn(DEMO_USER, courseId, parsed, emit); }
        catch (e) { emit('error', { kind: e.kind ?? 'internal', message: e.message, chain: e.chain ?? [] }); }
        res.end();
        return;
      }
      return json(405, { ok: false, message: 'method not allowed' });
    } catch (e) {
      return json(500, { ok: false, message: e.message });
    }
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
      if (!key) throw new Error('缺少 API 密钥——先填密钥再获取模型列表');
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

  // ---------- admin console (token-gated data inspector, admin.html) ----------
  if (url.pathname === '/admin' || url.pathname.startsWith('/api/admin/')) {
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    // The page itself is public (it only holds the token prompt + JS); the API is gated.
    if (url.pathname === '/admin') {
      try {
        const html = await readFile(path.join(ROOT, 'admin.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(html);
      } catch { res.writeHead(404); res.end('admin.html missing'); }
      return;
    }
    if (!adminAuthorized(req)) {
      return json(401, { ok: false, message: '密码不对，或还没有输入密码' });
    }
    const seg = url.pathname.slice('/api/admin/'.length).split('/').filter(Boolean).map(decodeURIComponent);
    try {
      if (seg[0] === 'data' && req.method === 'GET') {
        return json(200, { ok: true, token_required: Boolean(ADMIN_TOKEN), courses: await store.adminListCourses() });
      }
      if (seg[0] === 'export' && req.method === 'GET') {
        const courses = await store.adminExportAll();
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="demo-data.json"',
        });
        res.end(JSON.stringify({ exported_at: new Date().toISOString(), courses }, null, 2));
        return;
      }
      if (seg[0] === 'courses' && seg[1]) {
        if (req.method === 'GET') {
          const course = await store.adminGetCourse(seg[1]);
          if (!course) return json(404, { ok: false, message: '课程不存在' });
          return json(200, { ok: true, course });
        }
        if (req.method === 'DELETE') {
          const removed = await store.adminDelete(seg[1]);
          return json(removed ? 200 : 404, removed ? { ok: true, deleted: seg[1] } : { ok: false, message: '课程不存在' });
        }
      }
      return json(405, { ok: false, message: 'method not allowed' });
    } catch (e) { return json(500, { ok: false, message: e.message }); }
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
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      // Dev server: never let the browser serve stale UI modules after a code
      // update — heuristic caching bit us (old main.js next to a new server).
      'cache-control': 'no-cache',
    });
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
