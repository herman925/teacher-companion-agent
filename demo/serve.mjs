#!/usr/bin/env node
// Demo server: static files + /api/chat turn pipeline (ARCHITECTURE.md §3).
// Zero dependencies, Node >= 18. The browser never talks to LLM vendors directly
// (CORS + key custody, MODEL-APIS.md §3); this proxy is where the runtime
// harness lives — the same core modules a CloudBase function will import later.
//
// Usage:  node demo/serve.mjs [--port 8787]
// Keys:   per-account encrypted vault when KEYS_SECRET is set (ADR-0005;
//         write-only via PUT /api/me/keys/:provider, injected at call time),
//         env-seeded platform keys (ENV_KEYS below), or per-request body keys
//         from the no-auth offline tier. Precedence: account > env > body.

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVIDERS, callWithFailover, listModels, cacheInfoFromUsage } from './src/adapter.mjs';
import { mockTurn } from './src/mock.mjs';
import { WF_NODES } from './src/wf-nodes.mjs';
import { parseTurn, validateTurn, violationFeedback, safeTemplate } from './src/harness.mjs';
import { applyDelta, absorbBlueprint, applyBlueprintDelta, confirmBlueprintNode, createInitialState, STAGE_NAMES } from './src/engine.mjs';
import { buildPromptParts, cacheStableHistory, stageModuleName, profileSectionText } from './src/prompt-builder.mjs';
import { store } from './src/store.mjs';
import { deriveCourseTitle, TITLE_MAX } from './src/store/json-store.mjs';
import { shouldRegenTitle, buildTitleMessages, sanitizeTitle, TITLE_INTERVALS, TITLE_INTERVAL_DEFAULT } from './src/title-agent.mjs';
import { parseCookies, sessionCookie, clearSessionCookie, SESSION_COOKIE, displayNameError } from './src/auth-util.mjs';
import { vaultReady, encryptKey, decryptKey } from './src/key-vault.mjs';
import { createRateGate } from './src/rate-gate.mjs';

// Auth (SECURITY.md): opaque session cookie → store lookup. Courses are scoped
// to the session user; no session = visitor (演示模式 only, /api/courses* 401s).
async function sessionUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const hit = await store.getSessionUser(token);
  return hit ? { ...hit.user, _token: token, _sid: hit.session.sid } : null;
}

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
// Constant-time compare: hash both sides so lengths always match, then
// timingSafeEqual — a plain `===` leaks match-prefix timing.
const H = (s) => createHash('sha256').update(String(s)).digest();
function adminAuthorized(req) {
  if (!ADMIN_TOKEN) return true;
  const supplied = String(req.headers['x-admin-token'] || '');
  return timingSafeEqual(H(supplied), H(ADMIN_TOKEN))
    || timingSafeEqual(H(supplied.toLowerCase()), H(ADMIN_TOKEN_SHA256));
}

// ---------- per-account key vault (spec 2026-07-22, SECURITY.md) ----------
// KEYS_SECRET lives in the server .env. Missing/short secret disables the
// vault loudly: login still works, key-save answers 503, turns fall back to
// env keys only.
const KEYS_SECRET = process.env.KEYS_SECRET || '';
const VAULT_ON = vaultReady(KEYS_SECRET);

/** Decrypted account keys for one user (server-internal — never serialized). */
async function accountKeys(userId) {
  if (!VAULT_ON || !userId) return {};
  const out = {};
  for (const [pid, blob] of Object.entries(await store.getUserKeys(userId))) {
    const v = decryptKey(KEYS_SECRET, blob);
    if (v) out[pid] = v; // undecryptable rows (rotated secret) read as absent
  }
  return out;
}

// ---------- rate-limit gate (persistent, server clock) ----------
const rateLimit = (name, fallback) => {
  const n = Number(process.env[`RATE_${name}`]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const RATE_POLICIES = {
  login_user: { limit: rateLimit('LOGIN_USER', 5), windowMs: 15 * 60_000 },
  login_ip: { limit: rateLimit('LOGIN_IP', 10), windowMs: 15 * 60_000 },
  login_device: { limit: rateLimit('LOGIN_DEVICE', 10), windowMs: 15 * 60_000 },
  login_global: { limit: rateLimit('LOGIN_GLOBAL', 60), windowMs: 60_000 },
  admin_ip: { limit: rateLimit('ADMIN_IP', 5), windowMs: 15 * 60_000 },
  password_user: { limit: rateLimit('PASSWORD_USER', 5), windowMs: 15 * 60_000 },
  turns_user: { limit: rateLimit('TURNS_HOUR', 30), windowMs: 60 * 60_000 },
  turns_user_day: { limit: rateLimit('TURNS_DAY', 200), windowMs: 24 * 60 * 60_000 },
  turns_ip: { limit: rateLimit('TURNS_HOUR', 30), windowMs: 60 * 60_000 },
  turns_ip_day: { limit: rateLimit('TURNS_DAY', 200), windowMs: 24 * 60 * 60_000 },
  keysave_user: { limit: rateLimit('KEYSAVE_USER', 20), windowMs: 60 * 60_000 },
};
const gate = createRateGate({
  load: () => store.loadRateState(),
  save: (s) => store.saveRateState(s),
  policies: RATE_POLICIES,
});

const RATE_MSG = '尝试次数过多，请稍后再试';

/** Best client address: first X-Forwarded-For hop (nginx) else the socket. */
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || 'unknown';
}

// Anonymous device cookie — third login-limit key (no PII, no fingerprint;
// spoofable, which is why it is a supplement to the per-username counter,
// never the defense).
const DEVICE_COOKIE = 'cst_dev';
function deviceCookieHeader(req) {
  if (parseCookies(req)[DEVICE_COOKIE]) return {};
  const id = createHash('sha256').update(`${Date.now()}${Math.random()}`).digest('hex').slice(0, 32);
  return { 'set-cookie': `${DEVICE_COOKIE}=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax` };
}

/** Model-turn quota check-and-record. @returns null when allowed, else 429 payload. */
async function turnQuota(userId, ip) {
  const kinds = userId
    ? [['turns_user', userId], ['turns_user_day', userId]]
    : [['turns_ip', ip], ['turns_ip_day', ip]];
  for (const [kind, key] of kinds) {
    const v = await gate.check(kind, key);
    if (v.limited) {
      console.warn(`[rate] turn quota tripped: ${kind} ${key}`);
      return { kind: 'rate_limited', retry_after: v.retryAfterSec, message: '本时段的对话次数已用完，请稍后再试' };
    }
  }
  for (const [kind, key] of kinds) await gate.use(kind, key);
  return null;
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
  // Cache-friendly layout (2026-07-23): static rules first, history behind
  // them untouched, and the per-turn state snapshot as a second system
  // message just before the newest teacher message — so vendors' automatic
  // prefix caches survive across turns instead of being busted by the
  // snapshot changing inside messages[0].
  const { system: systemPrompt, stateNote } = await buildPromptParts(state, loadPrompt, { profile: req.profile });
  const keptHistory = cacheStableHistory(req.history || []);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...keptHistory,
    { role: 'system', content: stateNote },
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
  const guards = []; // timeout-guard events across all attempts (adapter onDelta kind 'guard')

  while (attempt <= 2) {
    emit('status', { text: attempt === 1 ? '正在思考这一轮…' : '第一稿被护栏拦下，正在重写…' });
    // Snapshot the exact messages sent before the call (the array mutates on L4 retry).
    const sentMessages = debug ? messages.map((m) => ({ role: m.role, content: m.content })) : null;
    const t0 = Date.now();
    // Live progress out of the model stream (adapter onDelta): 'thinking' text
    // chunks batched ~300ms, 'progress' char counts throttled ~1s, TTFT once.
    // Doubles as an SSE heartbeat — long silent vendor calls no longer look
    // dead to the teacher or to any proxy read-timeout in front.
    emit('phase', { attempt }); // each attempt starts a fresh thinking panel client-side
    let thinkBuf = '';
    let lastThink = 0;
    let lastProgress = 0;
    const flushThink = () => { if (thinkBuf) { emit('thinking', { text: thinkBuf }); thinkBuf = ''; lastThink = Date.now(); } };
    const onDelta = (d) => {
      if (d.kind === 'first') emit('ttft', { ms: d.ms });
      else if (d.kind === 'thinking') { thinkBuf += d.text; if (Date.now() - lastThink > 300) flushThink(); }
      else if (d.kind === 'content' && Date.now() - lastProgress > 1000) { lastProgress = Date.now(); emit('progress', { chars: d.chars, elapsed_ms: Date.now() - t0 }); }
      // Timeout-guard events (idle/total cutoffs, the forced-answer retry):
      // forwarded live so the UI can say WHY, and kept for the turn record.
      else if (d.kind === 'guard') { flushThink(); guards.push(d); emit('guard', d); }
    };
    // 'mock' provider: scripted walkthrough through the SAME L2/L3/L4 pipeline.
    const result = preferred === 'mock'
      ? { payload: mockTurn(state, req.history || [], req.message, { profile: req.profile }), usage: null, provider: 'mock', errors: [] }
      : await callWithFailover(preferred, keys, messages, { registry, onDelta });
    flushThink();
    const elapsedMs = Date.now() - t0;
    provider = result.provider;
    usage = result.usage;
    if (result.errors?.length) chainErrors = result.errors;

    const parsed = parseTurn(result.payload);
    const violations = parsed.turn ? validateTurn(parsed.turn, state, { stylePref: req.profile?.stylePref }) : parsed.violations;
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
  // Blueprint artifacts merge into the living mother plan (module-granularity
  // delta; engine owns versioning + escalation rules — ADR-0003 Phase 3).
  applied.state = absorbBlueprint(applied.state, turn, { teacherTurn: true }).state;
  const bpd = applyBlueprintDelta(applied.state, turn.blueprint_delta, { teacherTurn: true });
  applied.state = bpd.state;
  allViolations.push(...bpd.violations.map((v) => ({ ...v, attempt: 'apply' })));

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
        state_note: stateNote, // sent as a second system message before the teacher's turn
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
    // Normalized prompt-cache report (null when the vendor sent none) and the
    // timeout-guard events of this turn — both render in the UI only when
    // present and only if the teacher's 回合进度显示 toggles allow.
    cache: cacheInfoFromUsage(usage),
    guards,
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
      cache: captured.cache ?? null,
      guards: captured.guards?.length ? captured.guards : null,
      stage_name: captured.stageName ?? null,
    });
    try {
      await store.saveState(courseId, captured.turn.state_delta ?? {}, captured.state, course.state_version);
    } catch { /* optimistic-lock conflict (not expected single-user); messages kept, state left */ }
    // Auto-title (DATABASE.md §4): the model's own theme extraction names the
    // course; a human rename (title_locked) always wins and is never overwritten.
    try {
      if (await store.isUntitled(courseId)) {
        const t = deriveCourseTitle(captured.state, body.message);
        if (t) {
          const renamed = await store.renameCourse(userId, courseId, t, { auto: true });
          emit('course', { id: courseId, title: renamed.title }); // client refreshes its rail row
        }
      }
    } catch { /* naming is cosmetic — never fail the turn over it */ }
    // Interval regen (title-agent harness, spec 2026-07-20): opt-in via
    // profile.autoTitle; every Nth teacher prompt a PLAIN side-channel
    // completion renames the course. renameCourse's auto guard keeps human
    // renames untouchable; any failure falls back to the theme heuristic.
    try {
      const cfg = body.profile?.autoTitle;
      if (cfg?.enabled) {
        const every = TITLE_INTERVALS.includes(Number(cfg.every)) ? Number(cfg.every) : TITLE_INTERVAL_DEFAULT;
        const all = await store.getMessages(courseId);
        const teacherTurns = all.filter((m) => m.role === 'teacher').length;
        if (shouldRegenTitle({ teacherTurns, every, enabled: true, titleLocked: false })) {
          let t = null;
          if (body.provider && body.provider !== 'mock') {
            try {
              const keys = { ...ENV_KEYS, ...(body.keys || {}) };
              const registry = effectiveRegistry(body);
              const msgs = buildTitleMessages(
                all.map((m) => ({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.content })),
                captured.state,
              );
              // 15s cap: this runs inside the turn's SSE tail — a slow naming
              // call must not hold the teacher's reply stream hostage.
              const r = await callWithFailover(body.provider, keys, msgs, { registry, plain: true, timeoutMs: 15000 });
              t = sanitizeTitle(typeof r.payload === 'string' ? r.payload : '');
            } catch { /* side-channel only — fall through to the heuristic */ }
          }
          if (!t) t = deriveCourseTitle(captured.state, body.message);
          if (t) {
            const renamed = await store.renameCourse(userId, courseId, t, { auto: true });
            emit('course', { id: courseId, title: renamed.title });
          }
        }
      }
    } catch { /* naming is cosmetic — never fail the turn over it */ }
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
      // Demo persistence tier is on when a server answers, but requires login
      // (SECURITY.md §3): without a session, /api/courses* answers 401 and the
      // client falls back to localStorage-only 演示模式.
      persistence: true,
      auth: true,
      // Deploy channel: the public instance sets CHANNEL=public in its .env,
      // which hides dev instruments (the debug spanner) in the UI.
      channel: process.env.CHANNEL === 'public' ? 'public' : 'dev',
      // Per-account key vault available? Client switches to write-only server
      // keys when true; false keeps the legacy localStorage path (honest note).
      key_vault: VAULT_ON,
      providers: Object.entries(PROVIDERS)
        .filter(([, p]) => p.enabled !== false)
        .map(([id, p]) => ({ id, label: p.label, defaultModel: p.model, hasEnvKey: Boolean(ENV_KEYS[id]) })),
    }));
    return;
  }

  // ---------- auth: login/logout, 用户中心 (SECURITY.md §2–§4) ----------
  if (url.pathname === '/api/auth/login' || url.pathname === '/api/auth/logout'
      || url.pathname === '/api/me' || url.pathname.startsWith('/api/me/')) {
    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify(obj));
    };
    const readBody = async () => {
      let body = '';
      for await (const chunk of req) body += chunk;
      return body ? JSON.parse(body) : {};
    };
    try {
      if (url.pathname === '/api/auth/login' && req.method === 'POST') {
        const q = await readBody();
        const uname = String(q.username ?? '').trim().toLowerCase();
        const ip = clientIp(req);
        const device = parseCookies(req)[DEVICE_COOKIE] || '';
        const devHdr = deviceCookieHeader(req);
        // Brute-force gate: username (the real defense — IP rotation doesn't
        // help a targeted attack), IP, device cookie, and a global circuit
        // breaker against spray attacks. One generic message — no oracle.
        const limitKeys = [
          ['login_user', uname], ['login_ip', ip],
          ...(device ? [['login_device', device]] : []),
          ['login_global', 'all'],
        ];
        for (const [kind, key] of limitKeys) {
          const v = await gate.check(kind, key);
          if (v.limited) {
            console.warn(`[rate] login blocked (${kind}) for ${JSON.stringify(uname.slice(0, 32))} from ${ip}`);
            return json(429, { ok: false, retry_after: v.retryAfterSec, message: RATE_MSG }, devHdr);
          }
        }
        const user = await store.verifyLogin(q.username, q.password);
        if (!user) {
          // Failed attempts were invisible in the journal, which made "temp
          // password doesn't work" reports undiagnosable. Username only — never
          // the password.
          for (const [kind, key] of limitKeys) await gate.record(kind, key);
          console.warn(`[auth] login failed for ${JSON.stringify(uname.slice(0, 32))} from ${ip}`);
          return json(401, { ok: false, message: '用户名或密码不对，或账号已停用' }, devHdr);
        }
        await gate.reset('login_user', uname);
        const { token } = await store.createSession(user.id, req.headers['user-agent']);
        const cookies = [sessionCookie(token), ...(devHdr['set-cookie'] ? [devHdr['set-cookie']] : [])];
        return json(200, { ok: true, user }, { 'set-cookie': cookies });
      }
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        const token = parseCookies(req)[SESSION_COOKIE];
        if (token) await store.revokeByToken(token);
        return json(200, { ok: true }, { 'set-cookie': clearSessionCookie() });
      }
      const me = await sessionUser(req);
      if (!me) return json(401, { ok: false, need_login: true, message: '请先登录' });
      if (url.pathname === '/api/me' && req.method === 'GET') {
        const { _token, _sid, ...user } = me;
        return json(200, { ok: true, user });
      }
      if (url.pathname === '/api/me' && req.method === 'PATCH') {
        const q = await readBody();
        if (q.display_name !== undefined) {
          const ruleError = displayNameError(q.display_name, { lastChangedAt: me.display_name_changed_at });
          if (ruleError) return json(400, { ok: false, message: ruleError });
          try {
            const user = await store.setDisplayName(me.id, q.display_name);
            return json(200, { ok: true, user });
          } catch (e) { return json(e.status ?? 500, { ok: false, message: e.message }); }
        }
        if (q.password) {
          // Old-password guessing is a brute-force surface too.
          const v = await gate.check('password_user', me.id);
          if (v.limited) return json(429, { ok: false, retry_after: v.retryAfterSec, message: RATE_MSG });
          try {
            await store.changePassword(me.id, q.password.old, q.password.new);
            await gate.reset('password_user', me.id);
            return json(200, { ok: true });
          } catch (e) {
            if (e.status === 403) await gate.record('password_user', me.id);
            return json(e.status ?? 500, { ok: false, message: e.message });
          }
        }
        if (q.profile !== undefined) {
          await store.saveUserProfile(me.id, q.profile);
          return json(200, { ok: true });
        }
        return json(400, { ok: false, message: '没有可更新的字段' });
      }
      // ---- per-account model keys (write-only vault; spec 2026-07-22) ----
      if (url.pathname === '/api/me/keys' && req.method === 'GET') {
        // Flags ONLY. No endpoint anywhere returns a key value.
        const flags = {};
        for (const pid of Object.keys(await store.getUserKeys(me.id))) flags[pid] = true;
        return json(200, { ok: true, keys: flags, vault: VAULT_ON });
      }
      const keyPath = url.pathname.match(/^\/api\/me\/keys\/([a-z0-9_-]+)$/);
      if (keyPath && req.method === 'PUT') {
        if (!VAULT_ON) return json(503, { ok: false, message: '服务器还没有配置密钥保管（KEYS_SECRET）——请联系管理员' });
        const pid = keyPath[1];
        if (!(pid in PROVIDERS) && pid !== 'custom') return json(400, { ok: false, message: '未知服务' });
        const v = await gate.use('keysave_user', me.id);
        if (v.limited) return json(429, { ok: false, retry_after: v.retryAfterSec, message: RATE_MSG });
        const q = await readBody();
        const val = String(q.key ?? '').trim();
        await store.setUserKey(me.id, pid, val ? encryptKey(KEYS_SECRET, val) : null);
        return json(200, { ok: true, provider: pid, configured: Boolean(val) });
      }
      if (url.pathname === '/api/me/sessions' && req.method === 'GET') {
        return json(200, { ok: true, sessions: await store.listSessions(me.id, me._token) });
      }
      const sidMatch = url.pathname.match(/^\/api\/me\/sessions\/([^/]+)$/);
      if (sidMatch && req.method === 'DELETE') {
        const gone = await store.revokeSession(me.id, decodeURIComponent(sidMatch[1]));
        return json(gone ? 200 : 404, { ok: gone });
      }
      return json(405, { ok: false, message: 'method not allowed' });
    } catch (e) {
      return json(500, { ok: false, message: e.message });
    }
  }

  // ---------- demo persistence tier: courses + server-side chat history ----------
  // Session-scoped (SECURITY.md §3): every query filters by the logged-in
  // user's id; visitors get 401 and the client degrades to 演示模式.
  if (url.pathname === '/api/courses' || url.pathname.startsWith('/api/courses/')) {
    const rest = url.pathname.slice('/api/courses'.length); // '' | '/:id' | '/:id/messages' | '/:id/chat'
    const seg = rest.split('/').filter(Boolean).map(decodeURIComponent);
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    try {
      const me = await sessionUser(req);
      if (!me) return json(401, { ok: false, need_login: true, message: '请先登录' });
      const uid = me.id;
      // GET /api/courses — list (the session user's only)
      if (seg.length === 0 && req.method === 'GET') {
        return json(200, { ok: true, courses: await store.listCourses(uid) });
      }
      // POST /api/courses — create (30-course quota enforced in the store)
      if (seg.length === 0 && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const q = body ? JSON.parse(body) : {};
        try {
          const course = await store.createCourse(uid, q.title);
          return json(200, { ok: true, course });
        } catch (e) {
          return json(e.status === 409 ? 409 : 500, { ok: false, message: e.message });
        }
      }
      const courseId = seg[0];
      // GET /api/courses/:id — course + current state document
      if (seg.length === 1 && req.method === 'GET') {
        const course = await store.getCourse(uid, courseId);
        if (!course) return json(404, { ok: false, message: '课程不存在' });
        return json(200, { ok: true, course });
      }
      // PATCH /api/courses/:id — rename (owner; human rename locks the title)
      if (seg.length === 1 && req.method === 'PATCH') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const q = body ? JSON.parse(body) : {};
        try {
          const course = await store.renameCourse(uid, courseId, q.title);
          return json(200, { ok: true, course });
        } catch (e) {
          return json(e.status ?? 500, { ok: false, message: e.message });
        }
      }
      // POST /api/courses/:id/blueprint/confirm — teacher ✓确认 (engine escalation channel)
      if (seg.length === 3 && seg[1] === 'blueprint' && seg[2] === 'confirm' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const q = body ? JSON.parse(body) : {};
        try {
          const blueprint = await store.confirmBlueprintNode(uid, courseId, String(q.node_id || ''), confirmBlueprintNode);
          return json(200, { ok: true, blueprint });
        } catch (e) {
          return json(e.status ?? 500, { ok: false, message: e.message });
        }
      }
      // DELETE /api/courses/:id — whole-course erasure (data-subject deletion)
      if (seg.length === 1 && req.method === 'DELETE') {
        const removed = await store.deleteCourse(uid, courseId);
        if (!removed) return json(404, { ok: false, message: '课程不存在' });
        return json(200, { ok: true, deleted: courseId });
      }
      // Ownership check for subresources: messages/chat must not leak across users.
      if (seg.length === 2) {
        const owned = await store.getCourse(uid, courseId);
        if (!owned) return json(404, { ok: false, message: '课程不存在' });
      }
      // PUT /api/courses/:id/workbench — mirror of the unsent 工作台 state
      // (批注 + card answers, §5c) so admin exports show work-in-progress.
      if (seg.length === 2 && seg[1] === 'workbench' && req.method === 'PUT') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const q = body ? JSON.parse(body) : {};
        try {
          const workbench = await store.setWorkbench(uid, courseId, q);
          return json(200, { ok: true, workbench });
        } catch (e) {
          return json(e.status ?? 500, { ok: false, message: e.message });
        }
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
        // Account keys override anything client-supplied; runTurn layers the
        // merged map over ENV_KEYS (precedence: account > env > body).
        parsed.keys = { ...(parsed.keys || {}), ...(await accountKeys(uid)) };
        // Spend protection: real-model turns count against the user's quota
        // (mock is free — it never leaves the process).
        if (parsed.provider && parsed.provider !== 'mock') {
          const refusal = await turnQuota(uid, clientIp(req));
          if (refusal) {
            if (accept.includes('application/json') && !accept.includes('text/event-stream')) {
              return json(200, { events: [{ event: 'error', data: refusal }] });
            }
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
            res.write(`event: error\ndata: ${JSON.stringify(refusal)}\n\n`);
            res.end();
            return;
          }
        }
        if (accept.includes('application/json') && !accept.includes('text/event-stream')) {
          const events = [];
          const emit = (event, data) => events.push({ event, data });
          try { await runCourseTurn(uid, courseId, parsed, emit); }
          catch (e) { emit('error', { kind: e.kind ?? 'internal', message: e.message, chain: e.chain ?? [] }); }
          return json(200, { events });
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        try { await runCourseTurn(uid, courseId, parsed, emit); }
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
      // A freshly typed key wins (the teacher is testing it), then the
      // account vault, then env.
      const modelsMe = await sessionUser(req);
      const acct = modelsMe ? await accountKeys(modelsMe.id) : {};
      const key = q.key || acct[q.provider] || ENV_KEYS[q.provider] || '';
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
    const chatBody = JSON.parse(body);
    // Same quota discipline as the course endpoint. Without a session this
    // endpoint could otherwise burn env keys anonymously (per-IP quota); with
    // one, account keys ride along and the per-user quota applies.
    const chatMe = await sessionUser(req);
    if (chatMe) chatBody.keys = { ...(chatBody.keys || {}), ...(await accountKeys(chatMe.id)) };
    if (chatBody.provider && chatBody.provider !== 'mock') {
      const refusal = await turnQuota(chatMe?.id ?? null, clientIp(req));
      if (refusal) {
        const accept0 = req.headers.accept || '';
        if (accept0.includes('application/json') && !accept0.includes('text/event-stream')) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ events: [{ event: 'error', data: refusal }] }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`event: error\ndata: ${JSON.stringify(refusal)}\n\n`);
        res.end();
        return;
      }
    }
    // Buffered mode (Accept: application/json, no event-stream): collect the SSE events
    // and return them as one JSON payload. Cross-origin / serverless deploys (e.g. Alibaba
    // FC) use this when response streaming is constrained; the browser replays the events.
    const accept = req.headers.accept || '';
    if (accept.includes('application/json') && !accept.includes('text/event-stream')) {
      const events = [];
      // Live-progress events (thinking/progress/ttft/phase) are pointless after
      // the fact and can be large — buffered replies carry only the outcome.
      const LIVE = new Set(['thinking', 'progress', 'ttft', 'phase']);
      const emit = (event, data) => { if (!LIVE.has(event)) events.push({ event, data }); };
      try {
        await runTurn(chatBody, emit);
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
      await runTurn(chatBody, emit);
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
    // Admin token brute-force gate (per-IP), checked before evaluating.
    const adminIp = clientIp(req);
    const adminGate = await gate.check('admin_ip', adminIp);
    if (adminGate.limited) {
      return json(429, { ok: false, retry_after: adminGate.retryAfterSec, message: RATE_MSG });
    }
    if (!adminAuthorized(req)) {
      await gate.record('admin_ip', adminIp);
      return json(401, { ok: false, message: '密码不对，或还没有输入密码' });
    }
    const seg = url.pathname.slice('/api/admin/'.length).split('/').filter(Boolean).map(decodeURIComponent);
    try {
      if (seg[0] === 'data' && req.method === 'GET') {
        return json(200, { ok: true, token_required: Boolean(ADMIN_TOKEN), courses: await store.adminListCourses() });
      }
      // ---- user management (SECURITY.md §4): every action audited ----
      if (seg[0] === 'users' && seg.length === 1 && req.method === 'GET') {
        return json(200, { ok: true, users: await store.listUsers() });
      }
      if (seg[0] === 'users' && seg.length === 1 && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const q = body ? JSON.parse(body) : {};
        try {
          const { user, temp_password } = await store.createUser({
            username: q.username, displayName: q.display_name, role: q.role, createdBy: 'console',
          });
          await store.audit('console', 'create_user', user.id, { username: user.username, role: user.role });
          return json(200, { ok: true, user, temp_password }); // temp password appears in this response ONLY
        } catch (e) { return json(e.status ?? 500, { ok: false, message: e.message }); }
      }
      if (seg[0] === 'users' && seg.length === 2 && req.method === 'PATCH') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const q = body ? JSON.parse(body) : {};
        const targetId = seg[1];
        try {
          if (q.action === 'reset_password') {
            const temp = await store.resetPassword(targetId);
            await store.audit('console', 'reset_password', targetId, null);
            return json(200, { ok: true, temp_password: temp });
          }
          if (q.action === 'disable' || q.action === 'enable') {
            const user = await store.updateUser(targetId, { status: q.action === 'disable' ? 'disabled' : 'active' });
            await store.audit('console', `${q.action}_user`, targetId, null);
            return json(200, { ok: true, user });
          }
          if (q.action === 'set_role' && ['admin', 'teacher'].includes(q.role)) {
            const user = await store.updateUser(targetId, { role: q.role });
            await store.audit('console', 'set_role', targetId, { role: q.role });
            return json(200, { ok: true, user });
          }
          return json(400, { ok: false, message: '未知操作' });
        } catch (e) { return json(e.status ?? 500, { ok: false, message: e.message }); }
      }
      if (seg[0] === 'users' && seg.length === 2 && req.method === 'DELETE') {
        try {
          const gone = await store.deleteUser(seg[1]);
          await store.audit('console', 'delete_user', seg[1], gone);
          return json(200, { ok: true, ...gone });
        } catch (e) { return json(e.status ?? 500, { ok: false, message: e.message }); }
      }
      if (seg[0] === 'audit' && req.method === 'GET') {
        return json(200, { ok: true, audit: await store.listAudit({ limit: 200 }) });
      }
      // ---- 限流 relief (spec 2026-07-22 §6): view + unlock, audited ----
      if (seg[0] === 'rate-limits' && seg.length === 1 && req.method === 'GET') {
        return json(200, { ok: true, limits: await gate.list() });
      }
      if (seg[0] === 'rate-limits' && seg.length === 2 && req.method === 'DELETE') {
        const removed = await gate.clearEntry(seg[1]);
        await store.audit('console', 'rate_limit_clear', null, { entry: seg[1] });
        return json(removed ? 200 : 404, removed ? { ok: true, cleared: seg[1] } : { ok: false, message: '条目不存在' });
      }
      if (seg[0] === 'rate-limits' && seg.length === 1 && req.method === 'DELETE') {
        await gate.clearAll();
        await store.audit('console', 'rate_limit_clear_all', null, null);
        return json(200, { ok: true });
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

  // static: demo/ files, plus /schema/ passthrough for the debug drawer.
  //
  // Containment is checked against the SERVED base, never the checkout root: the
  // old guard allowed anything under path.join(ROOT, '..'), so `GET /..%2f.env`
  // walked straight out of demo/ and served the checkout's .env — model keys,
  // DATABASE_URL, ADMIN_TOKEN (OPERATIONS.md §Deploying). decodeURIComponent runs
  // AFTER the URL parser has normalised dot-segments, so a %2f is still a live
  // separator at this point; resolve-then-verify is the only guard that holds.
  //
  // Dot-prefixed segments are refused outright. demo/.data sits INSIDE the served
  // root and holds live session tokens, password hashes and course records, so
  // containment alone would happily serve it — child-data non-negotiable #4.
  // Nothing legitimate under demo/ or harness/schema/ starts with a dot.
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const schema = rel.startsWith('/schema/');
  const base = path.resolve(schema ? path.join(ROOT, '..', 'harness') : ROOT);
  const filePath = path.resolve(path.join(base, rel));
  if (!filePath.startsWith(base + path.sep) || rel.split('/').some((seg) => seg.startsWith('.'))) {
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
  console.log(`小小探索家 demo → http://localhost:${PORT}`);
  console.log(seeded.length ? `env keys detected: ${seeded.join(', ')}` : 'no env keys — enter one in the UI settings drawer');
  if (!existsSync(path.join(PROMPT_DIR, 'base.zh.md'))) console.warn('WARNING: prompts missing');
});
