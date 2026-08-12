#!/usr/bin/env node
// Demo server: static files + /api/chat turn pipeline (ARCHITECTURE.md §3).
// Zero dependencies, Node >= 18. The browser never talks to LLM vendors directly
// (CORS + key custody, MODEL-APIS.md §3); this proxy is where the runtime
// harness lives — the same core modules a CloudBase function will import later.
//
// Usage:  node demo/serve.mjs [--port 8787]
// Keys:   two sources, and only two (ADR-0013 §4). The per-account encrypted
//         vault when KEYS_SECRET is set (ADR-0005; write-only via
//         PUT /api/me/keys/:provider, decrypted at call time), and env-seeded
//         platform keys (ENV_KEYS below). Precedence: account > env.
//         A `keys` field in a request body is IGNORED — it is dropped at the
//         endpoint before the pipeline can see it. The browser key path was
//         removed rather than gated: with an admin-provisioned whitelist there
//         is no legitimate user without a session, so the branch had no purpose,
//         and a branch that must stay correctly configured eventually is not.
//         Cost, accepted in that ADR: no paste-your-own-key offline demo. Local
//         development uses env keys.

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
import { applyDelta, absorbBlueprint, applyBlueprintDelta, applyPlanDelta, confirmBlueprintNode, createInitialState, STAGE_NAMES } from './src/engine.mjs';
import { buildPromptParts, cacheStableHistory, stageModuleName, profileSectionText } from './src/prompt-builder.mjs';
import { shouldSearch, buildQuery, runWebSearch, searchResultsToContext, supportsWebSearch } from './src/web-search.mjs';
import { checkScope, refusalTurn } from './src/scope-guard.mjs';
import { store } from './src/store.mjs';
import { deriveCourseTitle, normalizeSubject, TITLE_MAX, MATERIAL_KINDS } from './src/store/json-store.mjs';
import { shouldRegenTitle, buildTitleMessages, sanitizeTitle, TITLE_INTERVALS, TITLE_INTERVAL_DEFAULT } from './src/title-agent.mjs';
import { parseCookies, sessionCookie, clearSessionCookie, SESSION_COOKIE, displayNameError } from './src/auth-util.mjs';
import { vaultReady, encryptKey, decryptKey } from './src/key-vault.mjs';
import { createRateGate } from './src/rate-gate.mjs';
import { assertPublicHttpsUrl } from './src/net-guard.mjs';
import { containsCredential } from './src/redact.mjs';
import { appendAccess, pruneAccess, readAccess, RETENTION_DAYS } from './src/access-log.mjs';
import { loadFacts, captureMemoryFacts, rawMemoryFacts, touchFacts } from './src/memory-capture.mjs';
import { createLocalObjectStore, materialKey, validKey } from './src/storage/object-store.mjs';
import { intakeFile, ACCEPTED_MIME_TYPES } from './src/upload-intake.mjs';

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
// Which instance this is. The public deploy sets CHANNEL=public in its .env;
// everything else is the tunnel-only dev box. Read once, because two places
// make a security decision from it.
const CHANNEL = process.env.CHANNEL === 'public' ? 'public' : 'dev';
// Constant-time compare: hash both sides so lengths always match, then
// timingSafeEqual — a plain `===` leaks match-prefix timing.
const H = (s) => createHash('sha256').update(String(s)).digest();
function adminAuthorized(req) {
  if (!ADMIN_TOKEN) return true;
  const supplied = String(req.headers['x-admin-token'] || '');
  return timingSafeEqual(H(supplied), H(ADMIN_TOKEN))
    || timingSafeEqual(H(supplied.toLowerCase()), H(ADMIN_TOKEN_SHA256));
}

/**
 * A missing ADMIN_TOKEN used to mean 「open」 everywhere, which is right for the
 * dev box and catastrophic in public: one .env that lost the line publishes
 * /api/admin/export — every course, every message, every teacher — to anyone
 * who asks, over plain HTTP, with no error anywhere to notice.
 *
 * The server already knows which instance it is, so an absent token on the
 * public channel is a MISCONFIGURATION rather than a permission grant, and it
 * answers 503 (「this instance is not configured to serve this」) rather than
 * 401 (「try a password」). 401 would invite guessing at a door that has no lock.
 * @returns {{status: number, message: string}|null} null when the request may proceed
 */
function adminRefusal(req) {
  if (!ADMIN_TOKEN && CHANNEL === 'public') {
    return { status: 503, message: '管理控制台在本实例上未启用（服务器缺少 ADMIN_TOKEN）' };
  }
  if (!adminAuthorized(req)) return { status: 401, message: '密码不对，或还没有输入密码' };
  return null;
}

// ---------- per-account key vault (spec 2026-07-22, SECURITY.md) ----------
// KEYS_SECRET lives in the server .env. Missing/short secret disables the
// vault loudly: login still works, key-save answers 503, turns fall back to
// env keys only.
const KEYS_SECRET = process.env.KEYS_SECRET || '';
const VAULT_ON = vaultReady(KEYS_SECRET);

/** Serialized cap on `users.settings.profile`. A few KB is a generous 教师档案
 * and a poor place to store anything else. */
const PROFILE_MAX_BYTES = 4096;

/**
 * Strip every trace of client-supplied key material from a request body and
 * attach the account's own keys under a name the pipeline reads.
 *
 * ADR-0013 §4: keys come from the account vault and the env, nothing else. The
 * assignment is UNCONDITIONAL — a stale or hostile client that sends either
 * `keys` or `accountKeys` has both replaced here, at the boundary, before
 * anything downstream (runTurn, the title side-channel, the logs) can read it.
 * @param {Object} body    parsed request body, mutated in place
 * @param {string|null} userId
 */
async function withAccountKeys(body, userId) {
  delete body.keys;
  body.accountKeys = userId ? await accountKeys(userId) : {};
  return body;
}

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

/**
 * Clip to `max` CODE POINTS, not UTF-16 units.
 *
 * `scope_log.excerpt` carries `CHECK (length(excerpt) <= 60)`, and Postgres
 * `length()` counts characters. `.slice(0, 60)` counts UTF-16 units, so a
 * message containing an emoji or any astral character can pass the JavaScript
 * cap and be rejected by the database — and it can also cut a surrogate pair in
 * half. Two caps that count different things are one cap that sometimes lies.
 * @param {string} s @param {number} max
 */
const clipToChars = (s, max) => Array.from(String(s ?? '')).slice(0, max).join('');

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

// Scope shell enforcement (ADR-0012 §3). OFF by default: ship warn-only, read
// a week of would-refuse logs, then set SCOPE_ENFORCE=1.
const SCOPE_ENFORCE = process.env.SCOPE_ENFORCE === '1';

// ---------- admin access log (ADR-0013 §7) ----------
// The data root the JSON store already uses, so the access log files land
// beside the other auth data rather than in a second place nobody backs up.
// With DATABASE_URL set the store is PostgreSQL and this directory holds ONLY
// the access log — which is deliberate (DATABASE.md §2b): an audit trail living
// outside the database it audits is harder to quietly edit.
const DATA_DIR = process.env.DEMO_DATA_DIR || path.join(ROOT, '.data');

// ---------- uploaded files (ADR-0013 §6) ----------
// The bytes live under the data root, never under anything the static handler
// serves. `OBJECT_DIR` is checked explicitly at the bottom of the static
// handler as well — the dot-segment rule already covers the default `.data`
// layout, but DEMO_DATA_DIR can point anywhere and a second lock costs nothing.
const OBJECT_DIR = path.resolve(path.join(DATA_DIR, 'objects'));
const objectStore = createLocalObjectStore({ baseDir: OBJECT_DIR });

/** Read a positive megabyte setting from the env, else the default. */
const mb = (name, fallbackMb) => {
  const n = Number(process.env[name]);
  return (Number.isFinite(n) && n > 0 ? n : fallbackMb) * 1024 * 1024;
};
/** One file. Big enough for a phone photo or a 教案, small enough that a
 * mistake is not a disk. */
const UPLOAD_MAX_BYTES = mb('UPLOAD_MAX_MB', 10);
/** Everything ONE teacher may keep. Local disk is the pilot's storage and
 * ADR-0013 §6's objection to it is real — a full system disk stops PostgreSQL
 * and takes the service down — so the compensating controls ship WITH the
 * endpoint rather than after it. */
const UPLOAD_USER_BUDGET_BYTES = mb('UPLOAD_BUDGET_MB', 500);
/** Below this much free space, uploads are refused with a clear message
 * instead of filling the volume the database is on. */
const UPLOAD_DISK_FLOOR_BYTES = mb('UPLOAD_DISK_FLOOR_MB', 1024);

/**
 * Delete one stored object. Injected into `deleteCourse` / `eraseUser`, which
 * both take a deleter and have both been called WITHOUT one until now — the
 * store harvested the keys and serve.mjs logged an orphan warning.
 *
 * The moment real uploads exist that warning becomes a photograph of children
 * left in storage with no row pointing at it: undeletable, because the row was
 * the only record of the key. That is the exact failure ADR-0013 §6 names, so
 * the deleter lands in the same change as the endpoint.
 * @param {string} cosKey
 */
async function deleteObject(cosKey) {
  if (!validKey(cosKey)) {
    // A key this store cannot resolve is not ours to delete — say so loudly
    // rather than swallow it, because the alternative reading is「deleted」.
    console.warn(`[objects] refusing to delete an unrecognized key: ${String(cosKey).slice(0, 120)}`);
    return;
  }
  await objectStore.delete(cosKey);
}

/**
 * Record one admin content read. ADR-0013 §7 accepts full admin reach ONLY
 * because every read is recorded, so this is the compensating control itself,
 * not instrumentation.
 *
 * `admin_id` is 'console' until §8's session + role lands, because a shared
 * token resolves no user and 「someone with the token」 is the honest answer.
 * §8 says exactly that, and says it is a reason to land the log now.
 *
 * A write failure NEVER fails the request — refusing to show an admin a course
 * because a disk was full would be the wrong trade — but it is shouted into the
 * journal, because a silent audit log reads as 「nobody looked」.
 * @param {Object} row {action, course_id?, subject?, excerpt?}
 */
async function recordAccess(row) {
  try {
    await appendAccess(DATA_DIR, { admin_id: 'console', ...row });
  } catch (e) {
    console.error('[access-log] WRITE FAILED — this read is unrecorded:', e?.message ?? e);
  }
}

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
 *                          (json_object_prompt strategy). Address only: its key is
 *                          a vault entry under the provider id 'custom'.
 *
 * ASYNC BECAUSE `custom.baseURL` IS VALIDATED BEFORE IT CAN BE FETCHED.
 * This is the one place in the server where a caller names an address the
 * server will then request, which is the definition of a server-side
 * request-forgery surface — and the Lighthouse VM has both a metadata service
 * that hands out CAM credentials and a local PostgreSQL. `assertPublicHttpsUrl`
 * resolves the host and refuses anything internal (net-guard.mjs); it throws,
 * so an unsafe address never becomes a registry entry that something later
 * fetches. Every caller is already async.
 */
async function effectiveRegistry(req) {
  const registry = { ...PROVIDERS };
  if (req.custom?.baseURL && req.custom?.model) {
    registry.custom = {
      id: 'custom',
      label: req.custom.label || '自定义端点',
      baseURL: await assertPublicHttpsUrl(req.custom.baseURL),
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

// ---------- memory: the fact write path (ADR-0011, ADR-0013 §9) ----------
// The policy, the guards and the store writes live in memory-capture.mjs — in
// their own file because every rule there is a rule that can be satisfied by
// doing nothing, and a guard exercised only through a live vendor turn is a
// guard nobody ever proves. It takes the store as an argument so the tests run
// the SAME function against a scratch store.

// ---------- turn pipeline ----------

/**
 * Run one full turn: prompt → model (failover) → L2/L3 → L4 retry → engine apply.
 * @param {{state: Object, history: Array, message: string, provider: string, accountKeys?: Object}} req
 * @param {(event: string, data: Object) => void} emit  SSE progress
 */
async function runTurn(req, emit) {
  const state = req.state && req.state.course_id ? req.state : createInitialState(`course-${Date.now()}`);
  // Account vault over server env, and nothing else (ADR-0013 §4). `accountKeys`
  // is set by withAccountKeys() at the endpoint, never by the client; `req.keys`
  // is deliberately not read, so a stale client's key material is inert even if
  // it somehow reached this far.
  const keys = { ...ENV_KEYS, ...(req.accountKeys || {}) };
  const registry = await effectiveRegistry(req);
  const preferred = req.provider === 'mock' ? 'mock'
    : req.provider && registry[req.provider] ? req.provider : 'minimax';

  // Prompt assembly is shared with the demo UI (prompt-builder.mjs); the
  // optional 教师档案 travels as read-only context, never through state_delta.
  // Cache-friendly layout (2026-07-23): static rules first, history behind
  // them untouched, and the per-turn state snapshot as a second system
  // message just before the newest teacher message — so vendors' automatic
  // prefix caches survive across turns instead of being busted by the
  // snapshot changing inside messages[0].
  // `subject` is the engine-resolved turn subject (ADR-0010 §1) — 'course' or a
  // plan node id. It selects the focus band, whose header is what labels a
  // hypothesis body AS a hypothesis; without it a node body arrives as a flat
  // statement.
  //
  // `facts` is the always-on memory band (ADR-0011). THE THREE VALUES ARE
  // DIFFERENT ANSWERS AND MUST STAY DIFFERENT: an array renders the band, `[]`
  // renders both headers with no rows (this class genuinely has no recorded
  // constraints), and `null`/absent omits the band entirely (memory could not
  // be read on this path). The stateless /api/chat branch has no course and no
  // owner, so it passes nothing and the band is correctly absent rather than
  // falsely empty — see the loader in runCourseTurn for why coercing a read
  // failure into `[]` would be the dangerous direction.
  const { system: systemPrompt, stateNote } = await buildPromptParts(state, loadPrompt, {
    profile: req.profile,
    subject: req.subject,
    facts: req.facts,
  });
  const keptHistory = cacheStableHistory(req.history || []);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...keptHistory,
    { role: 'system', content: stateNote },
    { role: 'user', content: req.message },
  ];

  emit('status', { text: '正在阅读你的课程状态…', stage: state.stage, stageName: STAGE_NAMES[state.stage] });

  // Scope shell (ADR-0012 §3). Runs BEFORE the search and before the model call
  // — blocking afterwards would already have spent what the check exists to
  // save. Default is WARN-ONLY: the verdict is logged, nothing is blocked, so a
  // week of real logs can prove the rule before it can cost a teacher.
  // SCOPE_ENFORCE=1 flips it on.
  const scope = checkScope(req.message, state, { enforce: SCOPE_ENFORCE });
  if (scope.wouldRefuse) {
    console.warn(`[scope] ${scope.enforced ? 'refused' : 'would refuse'} (${scope.rule}): ${String(req.message).slice(0, 60)}`);
    emit('scope', { rule: scope.rule, enforced: scope.enforced, refused: scope.refuse });
    // Persisted HERE, not at one endpoint: every logged-in teacher goes through
    // /api/courses/:id/chat, so a log written only on the anonymous /api/chat
    // branch reads the wrong population — and the 范围护栏 tab is what the
    // SCOPE_ENFORCE=1 decision is made from (HANDOFF.md).
    await store.logScope({
      rule: scope.rule,
      enforced: scope.enforced,
      refused: scope.refuse,
      // Truncated at the caller too: the 60-char cap is an interface promise
      // (store.mjs), not an implementation detail of the JSON store.
      excerpt: clipToChars(String(req.message ?? ''), 60),
      userId: req.userId ?? null,
      // A failure here must not take the turn down, but it must not vanish
      // either: this log is the SOLE evidence base for the SCOPE_ENFORCE=1
      // decision, and an empty 范围护栏 tab reads as 「no off-purpose traffic」
      // rather than 「the writer is broken」. The Postgres tier has two real
      // failure paths (the excerpt CHECK, and the unattributed-row policy note
      // in pg-store), so this is not a theoretical branch.
    }).catch((e) => console.warn('[scope] log write failed:', e?.message ?? e));
  }
  if (scope.refuse) {
    const refusal = refusalTurn(state);
    emit('turn', {
      turn: refusal,
      state,
      wf_nodes: WF_NODES,
      // A refused turn never reached a model, so there was no citation to check.
      gate_report: { ok: true, violations: [], attempt: 0, degraded: false, citation_checked: false },
      provider: 'scope-guard',
      providerLabel: '范围护栏',
      usage: null,
      cache: null,
      guards: [],
      web_search: null,
      scope: { rule: scope.rule, refused: true },
      stageName: STAGE_NAMES[state.stage],
    });
    return;
  }

  // 联网搜索 (ADR-0012 §6): retrieval is a step WE run, before the model call,
  // with a query WE compose — so it stays course-bound and cannot become a
  // general query channel. Only GLM/Z.AI have a backend; everyone else reports
  // the capability as unavailable rather than pretending. Placed AFTER the
  // cached prefix and before the newest teacher message, like the state note,
  // so an occasional search never busts the conversation's prefix cache.
  let webSearch = null;
  const searchProvider = registry[preferred];
  if (shouldSearch(state, req.caps, searchProvider, req.message)) {
    const query = buildQuery(req.message, state);
    emit('status', { text: '正在联网查资料…' });
    const found = await runWebSearch(searchProvider, keys[preferred] || '', query);
    const context = found.ok ? searchResultsToContext(found.results, found.query) : '';
    if (context) messages.splice(messages.length - 1, 0, { role: 'system', content: context });
    // Observability duty (AGENTS.md): the search rides the turn record whether
    // it succeeded, found nothing, or failed — a silent search is unauditable
    // and its cost untraceable.
    webSearch = {
      query: found.query,
      engine: found.engine,
      provider: preferred,
      ok: found.ok,
      count: found.results.length,
      injected: Boolean(context),
      ms: found.ms,
      ...(found.error ? { error: found.error } : {}),
    };
    emit('web_search', webSearch);
  }

  const teacherText = String(req.message ?? '');

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
  // Whether the payload this loop accepted came out of mockTurn(). Declared
  // outside the loop because the apply step below needs it.
  let fromMock = false;
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
    // `fromMock` is set HERE, at the one place mockTurn() produces a payload,
    // and nowhere else — it is what licenses the `demo_sample` evidence
    // exemption (engine.evidenceIsGrounded). Derived from the payload's origin
    // rather than from `req.provider`, so a client claiming 'mock' cannot buy
    // the exemption for a vendor turn.
    let result;
    if (preferred === 'mock') {
      result = { payload: mockTurn(state, req.history || [], req.message, { profile: req.profile }), usage: null, provider: 'mock', errors: [] };
      fromMock = true;
    } else {
      result = await callWithFailover(preferred, keys, messages, { registry, onDelta });
      fromMock = false;
    }
    flushThink();
    const elapsedMs = Date.now() - t0;
    provider = result.provider;
    usage = result.usage;
    if (result.errors?.length) chainErrors = result.errors;

    const parsed = parseTurn(result.payload);
    // `teacherText` is what makes the citation rule real: without it a present
    // `confirmed_by_quote` is trusted, and the model can mint the teacher's own
    // words. Coerced rather than passed through, so an absent message reads as
    // an empty one (nothing can be quoted from it) instead of as "unchecked".
    // `resolveUploadRef` is forwarded to L3 and, below, to the apply step —
    // BOTH, or neither. harness.mjs threads it into the same
    // engine.evidenceIsGrounded the applier calls precisely so the two reach
    // the same verdict on the same row; a harness that grounds an upload the
    // applier then strips reports a turn legal that the ledger will mark.
    const violations = parsed.turn
      ? validateTurn(parsed.turn, state, {
        stylePref: req.profile?.stylePref,
        teacherText,
        mock: fromMock,
        resolveUploadRef: req.resolveUploadRef,
      })
      : parsed.violations;
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

    if (accepted) {
      turn = parsed.turn;
      // The memory channel (ADR-0011 §4). Read off the RAW payload rather than
      // the parsed turn: parseTurn rebuilds the turn from a fixed field list,
      // so a new optional field has to be picked up here or it is dropped
      // before anyone sees it. Attached to the turn object so it rides
      // `messages.turn_contract` into storage and the exports — the record of
      // what the model ASKED to remember, which stays true whether or not the
      // guards below let any of it through.
      turn.memory_facts = rawMemoryFacts(result.payload);
      break;
    }
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
    // Evidence must trace back to what she just wrote; a row the model minted
    // is kept but marked, and stops counting toward the stage gates.
    teacherText,
    // The `demo_sample` exemption belongs to the scripted walkthrough alone.
    mock: fromMock,
    // The owned-material lookup, built ONCE per turn in runCourseTurn from the
    // requesting teacher's own materials on THIS course. Absent on the
    // stateless /api/chat path, where there is no course and no owner — and an
    // absent resolver grounds nothing (engine.evidenceIsGrounded), which is the
    // closed direction.
    resolveUploadRef: req.resolveUploadRef,
  });
  allViolations.push(...applied.violations.map((v) => ({ ...v, attempt: 'apply' })));
  // Blueprint artifacts merge into the living mother plan (module-granularity
  // delta; engine owns versioning + escalation rules — ADR-0003 Phase 3).
  // KNOWN GAP, recorded rather than papered over: this whole-artifact channel
  // still escalates an existing module on any teacher turn (`teacherTurn`),
  // where the two delta appliers below now require her quoted words. Closing it
  // means teaching the scripted walkthrough (demo/src/mock.mjs) to emit
  // `confirmed_by_quote`, which is a change to a file this pass does not own.
  applied.state = absorbBlueprint(applied.state, turn, { teacherTurn: true }).state;
  const bpd = applyBlueprintDelta(applied.state, turn.blueprint_delta, { teacherText });
  applied.state = bpd.state;
  allViolations.push(...bpd.violations.map((v) => ({ ...v, attempt: 'apply' })));
  // The plan tree's write path. It used to be emitted, parsed, counted by the
  // harness — and then dropped on the floor here, which meant the born-confirmed
  // and uncited-confirmation guards inside applyPlanDelta never ran in
  // production, and no log line said the ops had been discarded.
  const pd = applyPlanDelta(applied.state, turn.plan_delta, { teacherText });
  applied.state = pd.state;
  allViolations.push(...pd.violations.map((v) => ({ ...v, attempt: 'apply' })));

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
    // `citation_checked` says whether the confirmations in this turn were
    // checked against the teacher's actual words or merely trusted. Without it
    // a `gate_report` reading ok is identical either way, and nobody
    // downstream — session log, admin export — can tell them apart.
    gate_report: { ok: !degraded, violations: allViolations, attempt, degraded, citation_checked: true },
    provider,
    providerLabel: provider === 'mock' ? '演示模式' : `${registry[provider]?.label ?? provider} · ${registry[provider]?.model ?? ''}`,
    usage,
    // Normalized prompt-cache report (null when the vendor sent none) and the
    // timeout-guard events of this turn — both render in the UI only when
    // present and only if the teacher's 回合进度显示 toggles allow.
    cache: cacheInfoFromUsage(usage),
    guards,
    // 联网搜索 report — null when the turn did not search. Rides the turn so
    // the drawer, the session log and the server exports all see what was
    // retrieved and what it cost (AGENTS.md observability duty).
    web_search: webSearch,
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

  // What this turn is about (ADR-0010 §1): 'course', or the node the teacher
  // opened. Taken from the request — the UI selection — and resolved BEFORE the
  // model runs, so nothing the model returns can reach it (§2: a model that
  // chooses its own subject chooses its own blast radius).
  const subject = normalizeSubject(body.subject);

  // Store roles are teacher/agent/system; the model pipeline speaks user/assistant.
  // The recent band stays the course's last 10 messages regardless of subject:
  // retention and context are separate decisions (ADR-0010 §1a), and what a node
  // turn should be seeded with — ancestor plans plus that node's recorded
  // revision reasons (ADR-0007) — is a context-builder change, not this one.
  const recent = await store.getMessages(courseId, { limit: 10 });
  const history = recent.map((m) => ({
    role: m.role === 'agent' ? 'assistant' : 'user',
    content: m.content,
  }));

  // The owned-material set, loaded ONCE and BEFORE the model runs, so nothing
  // in the turn can influence it. Scoped by teacher AND course: a ref naming
  // her own material on a different course still fails, because the evidence it
  // would ground belongs to this course's ledger.
  //
  // OWNERSHIP, NOT EXISTENCE. `listMaterialIds(userId, courseId)` filters by
  // owner AND course in both tiers (and by `materials_owner` RLS on the
  // Postgres one), so the set can only ever contain her rows on this course;
  // the resolver is then a membership test against that set. A resolver that
  // answered 「does this id exist」 would be a privacy leak and an
  // evidence-fabrication channel at the same time: any teacher could cite any
  // other teacher's upload as her own evidence. The course half matters too,
  // and is the quieter of the two — her own material from LAST term's course
  // is not a record of what happened in this one.
  let owned = new Set();
  try {
    owned = new Set((await store.listMaterialIds(userId, courseId)).map(String));
  } catch (e) {
    // Fail CLOSED: an unreadable material list grounds nothing, so an
    // `upload_ref` is treated as unverified and the evidence row is marked.
    console.warn('[materials] owned-list read failed — upload_ref grounds nothing this turn:', e?.message ?? e);
  }
  // Synchronous by construction: applyDelta and validateTurn are pure and must
  // stay so, which is why the lookup happens here and the predicate only
  // answers from what was already loaded.
  const resolveUploadRef = (ref) => owned.has(String(ref));

  // The memory band. `null` when the read failed — never `[]`; see loadFacts.
  const classId = course.class_id ?? null;
  const facts = await loadFacts(store, userId, courseId, classId);

  let captured = null;
  const wrap = (event, data) => { if (event === 'turn') captured = data; emit(event, data); };
  // `subject` and `userId` ride the same request object the pipeline already
  // takes: the subject selects the focus band, the user id puts this teacher's
  // scope verdicts in the 范围护栏 log next to the anonymous ones.
  await runTurn({
    ...body, subject, userId, facts, resolveUploadRef,
    state: course.course_state, history, message: body.message,
  }, wrap);

  // Persist only a real, accepted turn. append-only messages + gated state save.
  if (captured && captured.turn) {
    // Both rows carry the SAME request-owned subject. The reply is tagged with
    // it even if captured.turn carries a subject of its own — that stays inside
    // turn_contract as a faithful record of what the model said, and is read by
    // nobody.
    await store.appendMessage(courseId, { role: 'teacher', content: body.message, subject });
    await store.appendMessage(courseId, {
      role: 'agent',
      content: captured.turn.reply_markdown ?? '',
      subject,
      turn_contract: captured.turn, // full turn for faithful history re-render
      provider: captured.provider ?? null,
      provider_label: captured.providerLabel ?? null,
      usage: captured.usage ?? null,
      cache: captured.cache ?? null,
      guards: captured.guards?.length ? captured.guards : null,
      stage_name: captured.stageName ?? null,
    });
    let stateSaved = false;
    try {
      await store.saveState(courseId, captured.turn.state_delta ?? {}, captured.state, course.state_version);
      stateSaved = true;
    } catch { /* optimistic-lock conflict (not expected single-user); messages kept, state left */ }

    // ---- memory: file this turn's facts, AFTER the state that justifies them ----
    // Order is the rule, not a preference: a fact must never outlive the state
    // and the messages it came from. saveState failures are swallowed just
    // above, so extraction placed any higher would file memory for a turn that
    // was never persisted — and memory rides every future prompt, so that row
    // would outlast the thing it was supposed to describe.
    if (stateSaved) {
      const memory = await captureMemoryFacts(store, {
        userId,
        courseId,
        classId,
        teacherText: String(body.message ?? ''),
        candidates: captured.turn.memory_facts,
        facts,
      });
      // Every outcome is stated, including every refusal. The client turns
      // these into 记住了 receipts with 撤销 in the same tap — undo at the moment
      // of capture is what makes automatic extraction safe, because a wrong
      // fact has to die while she is still looking at it.
      if (memory.recorded.length || memory.refused.length || memory.archived.length || memory.notice) {
        emit('memory', memory);
        for (const r of memory.refused) {
          console.warn(`[memory] refused (${r.reason}): ${String(r.text).slice(0, 40)}`);
        }
      }
      // The facts that just rode this prompt are marked as used, so the cap
      // evicts what she never hits rather than what she hits most.
      await touchFacts(store, userId, (facts ?? []).filter((f) => !f.archived).map((f) => f.id));
    } else if (Array.isArray(captured.turn.memory_facts) && captured.turn.memory_facts.length) {
      console.warn('[memory] state was not saved — this turn\'s facts were NOT filed');
    }
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
              // Same two sources as the turn itself — the naming side-channel
              // is not a back door around ADR-0013 §4.
              const keys = { ...ENV_KEYS, ...(body.accountKeys || {}) };
              const registry = await effectiveRegistry(body);
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

// ---------- uploads: the ingest path ----------

/**
 * Read a request body with a hard ceiling.
 *
 * NEVER BUFFER FIRST AND CHECK AFTER. The declared `content-length` is checked
 * before a byte is read (that catches the honest 200MB photo immediately), and
 * the stream is counted as it arrives so a chunked body that lies about its
 * size still stops at the cap instead of at the memory limit. What we do hold
 * is bounded by the cap itself, which is what makes it safe to sniff and strip
 * the file in one piece.
 *
 * @param {import('node:http').IncomingMessage} req @param {number} max
 * @returns {Promise<{ok: true, bytes: Buffer}|{ok: false, reason: 'too_large'}>}
 */
async function readCappedBody(req, max) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) return { ok: false, reason: 'too_large' };
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) {
      req.destroy();
      return { ok: false, reason: 'too_large' };
    }
    chunks.push(chunk);
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

/** Bytes this teacher already holds, across every course. */
async function usedBytes(userId) {
  const rows = await store.listMaterials(userId);
  return rows.reduce((n, m) => n + (Number(m.size_bytes) || 0), 0);
}

/**
 * Serve one material's bytes. Shared by the owner route and the admin route so
 * the two cannot drift in what they send — only in who is allowed to ask, and
 * in whether the read is written to the access log.
 *
 * NO CACHING HEADERS, and `attachment` rather than inline: these bytes are a
 * photograph of children, so a shared browser must not keep them and a stray
 * link must not render them into a page.
 */
function streamMaterial(res, material) {
  if (!validKey(material.cos_key)) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, message: '文件不存在' }));
    return;
  }
  const stream = objectStore.get(material.cos_key);
  let opened = false;
  stream.on('error', () => {
    // A row whose object is gone is a broken link, not a server fault — and
    // saying 404 keeps it indistinguishable from 「not yours」.
    if (!opened) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, message: '文件不存在' }));
    } else res.destroy();
  });
  stream.once('open', () => {
    opened = true;
    res.writeHead(200, {
      'content-type': material.mime_type || 'application/octet-stream',
      'content-disposition': `attachment; filename="${material.id}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    stream.pipe(res);
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
    // Which providers this instance holds a platform key for is a target list,
    // and it was free to anyone who asked. A signed-out visitor cannot spend
    // those keys any more (/api/models needs a session), so it also has no
    // reason to know they exist: the flags now require a session, and the
    // client's key box only ever renders after login anyway.
    const healthMe = await sessionUser(req);
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
      channel: CHANNEL,
      // Per-account key vault available? True = the client offers a write-only
      // key box. False = there is no way to enter a key from a browser at all
      // (ADR-0013 §4 removed the localStorage path), only the server env — and
      // the client says that in words rather than showing a dead input.
      key_vault: VAULT_ON,
      providers: Object.entries(PROVIDERS)
        .filter(([, p]) => p.enabled !== false)
        .map(([id, p]) => ({ id, label: p.label, defaultModel: p.model, hasEnvKey: Boolean(healthMe) && Boolean(ENV_KEYS[id]) })),
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
          // DATABASE.md 「What we deliberately do NOT store」 puts this check at
          // the API layer: `users.settings` must not accept key-shaped values.
          // Nothing enforced it. The blast radius was contained (profileSectionText
          // allowlists the fields it injects, so a pasted key never reached a
          // vendor) but it would have sat at rest in the users table, ridden
          // GET /api/me, and shown up in the admin console's course listing.
          //
          // REFUSED, not masked: she needs to know her key did not save, and a
          // silently starred-out profile field teaches her the opposite.
          if (containsCredential(q.profile)) {
            return json(400, { ok: false, message: '档案里看起来有 API 密钥——密钥请填在「模型密钥」里，不要写进个人档案' });
          }
          // A bound on how much one account may park in a settings blob. Same
          // reasoning as the workbench caps: this field has no retention story
          // of its own, so it must not become storage.
          if (JSON.stringify(q.profile ?? null).length > PROFILE_MAX_BYTES) {
            return json(400, { ok: false, message: '个人档案太长了，请精简一些' });
          }
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
        // The deleter is injected: deleting a course deletes its objects
        // (ADR-0013 §6). Any key the store could not hand to it comes back in
        // the receipt and is LOGGED, never returned to the browser — an object
        // key is the address of a photograph of children.
        const removed = await store.deleteCourse(uid, courseId, { deleteObject });
        if (!removed.deleted) return json(404, { ok: false, message: '课程不存在' });
        if (removed.cos_keys.length && !removed.objects_deleted) {
          console.warn(`[cos] ${removed.cos_keys.length} object(s) from course ${courseId} still need deleting: ${removed.cos_keys.join(' ')}`);
        }
        return json(200, { ok: true, deleted: courseId });
      }
      // Ownership check for subresources: messages/chat must not leak across users.
      if (seg.length === 2) {
        const owned = await store.getCourse(uid, courseId);
        if (!owned) return json(404, { ok: false, message: '课程不存在' });
      }
      // PUT /api/courses/:id/workbench — mirror of the unsent 工作台 state
      // (card answers + the receipt ledger) so admin exports show
      // work-in-progress, not only what was sent. setWorkbench MERGES: an
      // absent key leaves that section alone.
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
      // PUT /api/courses/:id/class — bind this course to one of HER classes
      // (ADR-0011 §3). This is the binding `listFacts` resolves class-scope
      // memory through, so without it class facts are written and never read.
      //
      // THE CLASS IS RE-VERIFIED HERE even though `setCourseClass` verifies it
      // in both tiers. Foreign keys bypass row-level security, so no policy
      // checks the referenced class — and binding a stranger's class would pull
      // HER class-scope memory into HIS course, on every turn, forever. Two
      // checks for the one thing that has no lock of its own.
      if (seg.length === 2 && seg[1] === 'class' && req.method === 'PUT') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const q = body ? JSON.parse(body) : {};
        const classId = q.class_id == null || q.class_id === '' ? null : String(q.class_id);
        try {
          if (classId != null) {
            const mine = await store.listClasses(uid);
            if (!mine.some((k) => k.id === classId)) return json(404, { ok: false, message: '班级不存在' });
          }
          const bound = await store.setCourseClass(uid, courseId, classId);
          return json(200, { ok: true, course: bound });
        } catch (e) {
          return json(e.status ?? 500, { ok: false, message: e.message });
        }
      }
      // ---- uploads (ADR-0013 §6) ----
      // POST /api/courses/:id/materials — raw body, one file, content-type in
      // the header. No multipart parser: this repository has one dependency and
      // it is `pg`, and a hand-rolled multipart parser is a security surface in
      // exchange for a convenience the browser does not need (`fetch(url, {body:
      // file})` sends the bytes and the type on its own).
      //
      // THE ORDER IS BYTES, THEN ROW, and the catch undoes the bytes. A row
      // without an object is a broken link she can be told about; an object
      // without a row is a photograph of children that nothing points at, which
      // means nothing can ever delete it (ADR-0013 §6's named failure).
      if (seg.length === 2 && seg[1] === 'materials' && req.method === 'POST') {
        const free = await objectStore.freeBytes();
        if (free != null && free < UPLOAD_DISK_FLOOR_BYTES) {
          console.error(`[objects] refusing uploads: ${Math.round(free / 1048576)}MB free, floor is ${Math.round(UPLOAD_DISK_FLOOR_BYTES / 1048576)}MB`);
          return json(507, { ok: false, message: '服务器暂时没有存放空间了——请联系管理员' });
        }
        const body = await readCappedBody(req, UPLOAD_MAX_BYTES);
        if (!body.ok) {
          return json(413, { ok: false, message: `文件太大了——单个文件最多 ${Math.round(UPLOAD_MAX_BYTES / 1048576)}MB` });
        }
        if (!body.bytes.length) return json(400, { ok: false, message: '没有收到文件内容' });
        const used = await usedBytes(uid);
        if (used + body.bytes.length > UPLOAD_USER_BUDGET_BYTES) {
          return json(507, { ok: false, message: `你的上传空间用完了（上限 ${Math.round(UPLOAD_USER_BUDGET_BYTES / 1048576)}MB）——删掉一门旧课程可以腾出空间` });
        }
        // Identified by CONTENT. The filename and the declared type are both
        // teacher-supplied text, so both are hints; the magic bytes decide, and
        // anything the sniffer cannot name is refused rather than guessed at.
        const intake = intakeFile(body.bytes, req.headers['content-type']);
        if (!intake.ok) return json(415, { ok: false, reason: intake.reason, message: intake.message });

        // The kind defaults from the format and can be narrowed by the caller,
        // never widened past the store's allowlist. `contains_children` decides
        // retention and access rules, so a photo is assumed to contain children
        // unless the caller says otherwise — the safe direction is the stricter
        // one.
        const askedKind = url.searchParams.get('kind');
        const kind = MATERIAL_KINDS.includes(askedKind)
          ? askedKind
          : (intake.mime === 'image/jpeg' ? 'photo' : 'document');
        const childrenParam = url.searchParams.get('children');
        const containsChildren = childrenParam === null
          ? intake.mime === 'image/jpeg'
          : childrenParam !== '0' && childrenParam !== 'false';

        const key = materialKey(courseId, intake.ext);
        await objectStore.put(key, intake.bytes);
        let row;
        try {
          row = await store.recordMaterial(uid, courseId, {
            kind,
            mime_type: intake.mime,
            cos_key: key,
            size_bytes: intake.bytes.length,
            exif_stripped: intake.exif_stripped,
            contains_children: containsChildren,
          });
        } catch (e) {
          await objectStore.delete(key); // never leave bytes nothing points at
          return json(e.status ?? 500, { ok: false, message: e.message });
        }
        // The object key is NOT returned. It is the address of a photograph of
        // children, and the only way to read one back is a session-checked
        // handler that looks the ownership up again.
        return json(200, {
          ok: true,
          material: {
            id: row.id, kind: row.kind, mime_type: row.mime_type, size_bytes: row.size_bytes,
            exif_stripped: row.exif_stripped, contains_children: row.contains_children,
            created_at: row.created_at,
          },
        });
      }
      // GET /api/courses/:id/materials — her own uploads on this course. Keys
      // stripped, for the same reason.
      if (seg.length === 2 && seg[1] === 'materials' && req.method === 'GET') {
        const rows = await store.listMaterials(uid, courseId);
        return json(200, {
          ok: true,
          materials: rows.map((m) => ({
            id: m.id, kind: m.kind, mime_type: m.mime_type, size_bytes: m.size_bytes,
            exif_stripped: m.exif_stripped, contains_children: m.contains_children,
            created_at: m.created_at,
          })),
          limits: { file_max_bytes: UPLOAD_MAX_BYTES, user_budget_bytes: UPLOAD_USER_BUDGET_BYTES, accepted: ACCEPTED_MIME_TYPES },
        });
      }
      // GET /api/courses/:id/messages?before=&limit=&subject= — paged history.
      // No subject = the whole course log, so every existing caller is unchanged;
      // subject=<node id> is the node view (ADR-0010 §1), a filter over that one
      // log with the global ids intact.
      if (seg.length === 2 && seg[1] === 'messages' && req.method === 'GET') {
        const before = url.searchParams.get('before');
        const limit = url.searchParams.get('limit');
        const subject = url.searchParams.get('subject');
        const messages = await store.getMessages(courseId, {
          before: before != null ? Number(before) : undefined,
          limit: limit != null ? Number(limit) : undefined,
          subject: subject || undefined,
        });
        return json(200, { ok: true, messages });
      }
      // POST /api/courses/:id/chat — the turn endpoint, server-side state
      if (seg.length === 2 && seg[1] === 'chat' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const accept = req.headers.accept || '';
        const parsed = JSON.parse(body);
        // Key custody boundary: whatever the client sent under `keys` is dropped
        // here, and this account's own keys are attached (ADR-0013 §4).
        await withAccountKeys(parsed, uid);
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

  // ---------- memory + classes: the TEACHER plane (ADR-0011) ----------
  //
  // THERE IS NO CREATE ROUTE FOR A FACT, AND THERE MUST NEVER BE ONE. A fact is
  // EXTRACTED from something she said — `memory-capture.mjs` screens every
  // candidate against the closed taxonomy, requires the quote to occur in THIS
  // turn's teacher message, archives child claims on arrival and clamps the
  // scope. A `POST /api/memory` would skip all four in one call, and it would
  // also turn the memory viewer into a form: the teacher would be filling in
  // the state machine instead of talking to the agent (non-negotiable #2).
  // So these routes read, retire and widen what the conversation produced —
  // nothing here can bring a fact into being. `demo/tests/memory-routes.test.mjs`
  // pins that absence with a test, so an edit that adds one fails rather than
  // passing review.
  //
  // Every route is session-checked, scoped to `uid`, and runs on the ORDINARY
  // connection — never the admin plane. A foreign id and a missing id answer the
  // same 404 with the same body: a distinguishable response tells one teacher
  // that another teacher's fact exists.
  if (url.pathname === '/api/memory' || url.pathname.startsWith('/api/memory/')
      || url.pathname === '/api/classes' || url.pathname.startsWith('/api/classes/')) {
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    /** The one 404 body. Both 「not yours」 and 「not there」 use it, verbatim. */
    const notFound = () => json(404, { ok: false, message: '这条记忆不在了' });
    try {
      const me = await sessionUser(req);
      if (!me) return json(401, { ok: false, need_login: true, message: '请先登录' });
      const uid = me.id;
      const mem = url.pathname.startsWith('/api/memory')
        ? url.pathname.slice('/api/memory'.length).split('/').filter(Boolean).map(decodeURIComponent)
        : null;
      const cls = url.pathname.startsWith('/api/classes')
        ? url.pathname.slice('/api/classes'.length).split('/').filter(Boolean).map(decodeURIComponent)
        : null;

      // GET /api/memory?course_id=&include_archived=1 — what the agent is
      // currently carrying for this course: teacher scope, this course's class,
      // and this course. `include_archived` is the VIEWER's flag and nothing
      // else asks for it — the archived section is what stops a quiet drop from
      // being invisible, which is worse than the drop.
      if (mem && mem.length === 0 && req.method === 'GET') {
        const courseId = url.searchParams.get('course_id') || null;
        const includeArchived = url.searchParams.get('include_archived') === '1';
        // listFacts THROWS on a read failure and must never be coerced to [] —
        // an empty list reads as 「this class has no constraints」. The catch
        // below turns it into a 500, which the client shows as 「没读到」.
        const facts = await store.listFacts(uid, { courseId, includeArchived });
        const classes = await store.listClasses(uid);
        return json(200, { ok: true, facts, classes });
      }

      // POST /api/memory/:id/archive — her 忘掉.
      //
      // THE REASON IS SET HERE AND IS NOT READ OFF THE BODY. Archives already
      // carry 'child_claim' (a claim about children with no evidence) and 'cap'
      // (the standing ceiling evicted it). A teacher pressing 忘掉 is a THIRD
      // event, and when she later asks 「为什么它不记得了」 she deserves an answer
      // that says SHE retired it rather than one of ours. A body-supplied reason
      // would let one event wear another's explanation.
      if (mem && mem.length === 2 && mem[1] === 'archive' && req.method === 'POST') {
        const row = await store.archiveFact(uid, mem[0], { reason: 'teacher_removed' });
        if (!row) return notFound();
        return json(200, { ok: true, fact: row });
      }

      // POST /api/memory/:id/widen {to_scope, class_id} — her deliberate tap,
      // one rung: 课程 → 班级 → 我所有班.
      //
      // PROVENANCE STAYS ENGINE-SET. The body says WHERE TO, and nothing else:
      // `source`, `widened_from` and `widened_at` are all written by the store
      // (`widenFact`), and the ladder is enforced by the same screen both tiers
      // share. A payload claiming `source: 'teacher'` changes nothing, because
      // nothing here reads it.
      if (mem && mem.length === 2 && mem[1] === 'widen' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const q = body ? JSON.parse(body) : {};
        const toScope = String(q.to_scope ?? '');
        const classId = q.class_id == null || q.class_id === '' ? null : String(q.class_id);
        if (classId != null) {
          const mine = await store.listClasses(uid);
          if (!mine.some((k) => k.id === classId)) return json(404, { ok: false, message: '班级不存在' });
        }
        try {
          const row = await store.widenFact(uid, mem[0], toScope, { classId });
          if (!row) return notFound();
          return json(200, { ok: true, fact: row });
        } catch (e) {
          return json(e.status ?? 500, { ok: false, message: e.message });
        }
      }

      // GET /api/classes — her named classes. Drives 「ask which class only if
      // she has more than one」: with one class the answer is not a question.
      if (cls && cls.length === 0 && req.method === 'GET') {
        return json(200, { ok: true, classes: await store.listClasses(uid) });
      }

      // POST /api/classes {name, age_band, class_size, is_default} — a class
      // comes into existence by her NAMING one, which is why this takes a name
      // and nothing structural. It is not a manage-classes screen and there is
      // deliberately no DELETE: `facts.class_id` cascades, so deleting a class
      // would destroy every constraint she widened to it, with no archive row
      // and no notice.
      if (cls && cls.length === 0 && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const q = body ? JSON.parse(body) : {};
        try {
          const created = await store.createClass(uid, {
            name: q.name, ageBand: q.age_band ?? q.ageBand,
            classSize: q.class_size ?? q.classSize, isDefault: q.is_default ?? q.isDefault,
          });
          return json(200, { ok: true, class: created });
        } catch (e) {
          return json(e.status ?? 500, { ok: false, message: e.message });
        }
      }

      return json(405, { ok: false, message: 'method not allowed' });
    } catch (e) {
      return json(e.status ?? 500, { ok: false, message: e.message });
    }
  }

  // ---------- reading one uploaded file back ----------
  // GET /api/materials/:id/view — the ONLY way bytes leave this server on the
  // teacher path, and it is private by construction, four locks deep:
  //   1. the objects live outside the static root and are never served
  //      statically, so there is no URL to leak in the first place;
  //   2. this handler requires a session — there are no presigned URLs in the
  //      local tier at all, which removes that whole class of bug;
  //   3. the lookup is scoped to HER materials, so a foreign id is simply not
  //      in the set — and on the Postgres tier `materials_owner` means the row
  //      cannot even be SELECTed, so there is no `cos_key` to serve if this
  //      check were ever refactored away;
  //   4. admin reads go through a different endpoint, on the admin plane, and
  //      every one of them appends an access-log line.
  // A foreign id and a missing id answer the same 404: 「not yours」 and 「not
  // there」 must not be distinguishable, or the endpoint becomes an oracle for
  // which uploads exist.
  const viewMatch = url.pathname.match(/^\/api\/materials\/([^/]+)\/view$/);
  if (viewMatch && req.method === 'GET') {
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const me = await sessionUser(req);
    if (!me) return json(401, { ok: false, need_login: true, message: '请先登录' });
    const id = decodeURIComponent(viewMatch[1]);
    // `getMaterial` takes the user id, never a bare material id — the
    // 「authenticated is not authorised」 hazard the store records for its
    // course-id-only methods. It returns null rather than throwing for a
    // foreign or missing id, which is how both answer the same 404.
    const material = await store.getMaterial(me.id, id);
    if (!material) return json(404, { ok: false, message: '文件不存在' });
    return streamMaterial(res, material);
  }

  // List a provider's available models (proxied — the browser can't reach vendors directly).
  //
  // A SESSION IS REQUIRED. This endpoint takes a caller-supplied address, makes
  // the server fetch it, and hands the answer back — the shape of a
  // server-side request-forgery proxy. It used to do that for anyone on the
  // internet, spending the platform env key while it did. Two locks now, not
  // one: the session (below) and `assertPublicHttpsUrl` inside
  // effectiveRegistry, so a signed-in teacher cannot aim it at the metadata
  // service either.
  if (url.pathname === '/api/models' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const modelsMe = await sessionUser(req);
    if (!modelsMe) return json(401, { ok: false, need_login: true, message: '请先登录' });
    // Same gate as saving a key: this is the button next to that box, and an
    // unmetered vendor round-trip per click is a spend channel too.
    const v = await gate.use('keysave_user', modelsMe.id);
    if (v.limited) return json(429, { ok: false, retry_after: v.retryAfterSec, message: RATE_MSG });
    try {
      const q = JSON.parse(body);
      const registry = await effectiveRegistry({ ...q, provider: q.provider });
      const p = registry[q.provider];
      if (!p) throw new Error(`未知供应商：${q.provider}`);
      // A freshly typed key wins (the teacher is testing it), then the
      // account vault, then env. `q.key` is NOT the removed browser key path:
      // it can only be a key being typed into the vault box right now, on its
      // way to this same server — the client reads none back from storage.
      const acct = await accountKeys(modelsMe.id);
      const key = q.key || acct[q.provider] || ENV_KEYS[q.provider] || '';
      if (!key) throw new Error('缺少 API 密钥——先填密钥再获取模型列表');
      const models = await listModels(p, key);
      return json(200, { ok: true, provider: q.provider, defaultModel: p.model, models });
    } catch (e) {
      // `e.message` is already scrubbed of any upstream body by adapter.mjs —
      // reflecting one was how this endpoint turned into a read primitive for
      // whatever it had been pointed at.
      return json(200, { ok: false, message: e.message, status: e.status ?? 0 });
    }
  }

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const chatBody = JSON.parse(body);
    // THE STATELESS PATH GETS NEITHER MEMORY NOR AN UPLOAD RESOLVER, and both
    // omissions are written down rather than left to be rediscovered: there is
    // no course here, so there is no owner to scope facts to and nothing for an
    // `upload_ref` to be resolved against. Both fields are server-owned, so
    // they are stripped HERE — on the line after the body is parsed, before any
    // other code can read them. A client-supplied `facts` array would write
    // straight into the model's memory band; the closed direction for
    // `upload_ref` is 「grounds nothing」, which is what an absent resolver
    // already means (engine.evidenceIsGrounded).
    delete chatBody.facts;
    delete chatBody.resolveUploadRef;
    // Same quota discipline as the course endpoint. Without a session this
    // endpoint could otherwise burn env keys anonymously (per-IP quota); with
    // one, account keys ride along and the per-user quota applies.
    const chatMe = await sessionUser(req);
    // Same key-custody boundary as the course endpoint, and it runs whether or
    // not there is a session: a signed-out caller must have `keys` stripped too,
    // which is exactly the path ADR-0013 §4 removed (ADR-0013 §3: the whitelist
    // means a session-less caller is never a legitimate teacher).
    await withAccountKeys(chatBody, chatMe?.id ?? null);
    chatBody.userId = chatMe?.id ?? null; // so runTurn's scope row names her
    // Scope shell (ADR-0012 §3) is evaluated BEFORE the quota so a refused turn
    // costs the teacher nothing: it never reached a model, so it is not a model
    // turn. In warn-only mode nothing is refused, so quota behaves exactly as
    // before. The verdict is PERSISTED inside runTurn — one writer for both
    // endpoints, because a log fed by one of them describes the wrong
    // population.
    const chatScope = checkScope(chatBody.message, chatBody.state, { enforce: SCOPE_ENFORCE });
    if (chatBody.provider && chatBody.provider !== 'mock' && !chatScope.refuse) {
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
    const refusal = adminRefusal(req);
    if (refusal) {
      // Only a wrong PASSWORD feeds the brute-force counter. A 503 means there
      // is no password to guess, so counting it would let a misconfigured
      // instance rate-limit the operator who came to fix it.
      if (refusal.status === 401) await gate.record('admin_ip', adminIp);
      return json(refusal.status, { ok: false, message: refusal.message });
    }
    const seg = url.pathname.slice('/api/admin/'.length).split('/').filter(Boolean).map(decodeURIComponent);
    try {
      if (seg[0] === 'data' && req.method === 'GET') {
        const courses = await store.adminListCourses();
        // ADR-0013 §7: full admin reach is accepted BECAUSE every content read
        // is recorded. This listing carries titles, teacher names and profiles
        // across every account, so it is a content read. Awaited before the
        // response is written: a log appended after the bytes have left is a
        // log that can be skipped by a client that hangs up.
        await recordAccess({ action: 'read_course_list', excerpt: `${courses.length} 个课程` });
        return json(200, { ok: true, token_required: Boolean(ADMIN_TOKEN), courses });
      }
      // Scope shell log (ADR-0012 §3). Warn-only is only worth running if the
      // would-refuse rows get read before enforcement is switched on.
      if (seg[0] === 'scope' && req.method === 'GET') {
        const log = await store.listScope({ limit: Number(url.searchParams.get('limit')) || 200 });
        // Every row carries a 60-character excerpt of a teacher's message, so
        // reading this tab is reading teacher content.
        await recordAccess({ action: 'read_scope_log', excerpt: `${log.rows.length} 条` });
        return json(200, { ok: true, enforcing: SCOPE_ENFORCE, ...log });
      }
      // ---- the access log itself (ADR-0013 §7) ----
      // A log nobody can read is not an audit trail. Reading it is NOT itself
      // logged: an audit trail that audits its own reads grows without bound
      // and tells nobody anything new.
      if (seg[0] === 'access-log' && req.method === 'GET') {
        const rows = await readAccess(DATA_DIR, {
          from: url.searchParams.get('from') || undefined,
          to: url.searchParams.get('to') || undefined,
        });
        return json(200, { ok: true, retention_days: RETENTION_DAYS, rows: rows.slice(-1000) });
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
          // REVOKE — the third account state (ADR-0013 §11), and the one the
          // console could not reach until now. `disable` writes a status the
          // retention machinery never looks at: `dueForErasure` only ever sees
          // `revoked`, and it needs `revoked_at` to know when the window
          // opened. So a disabled account is data that stays forever with
          // nobody having decided that it should.
          //
          // REVOKING IS NOT DELETING, and that separation is the whole point:
          // login is refused, live sessions die, and every course, message and
          // upload stays exactly where it is — the kindergarten may still need
          // last year's curriculum. `store.revokeUser` writes its own audit row
          // (both tiers), so this endpoint does not add a second one.
          if (q.action === 'revoke') {
            const user = await store.revokeUser('console', targetId);
            return json(200, { ok: true, user });
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
          // `deleteUser` takes no deleter (the legacy signature), so the keys
          // come back and this is where they die. Without this an erased
          // teacher's uploads survive her rows — files nothing points at, which
          // means nothing can find them to delete either.
          let orphaned = 0;
          for (const key of gone.cos_keys ?? []) {
            if (!(await objectStore.delete(key))) orphaned += 1;
          }
          if (orphaned) console.warn(`[objects] ${orphaned} object(s) from erased user ${seg[1]} could not be deleted`);
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
        // The broadest read this server can perform: every course on the
        // instance, every message, every snapshot, in one file that then lives
        // on somebody's laptop. One row per export, before a byte is written.
        await recordAccess({ action: 'export_course', excerpt: `${courses.length} 个课程的完整记录` });
        // THE EXPORT DUTY (AGENTS.md). Three kinds of state ship in this
        // change, and state that only exists inside a widget is a defect, so
        // all three ride the export:
        //   · uploads — the row, never the bytes and never the object key;
        //   · memory facts — including archived rows and their reasons, or a
        //     wrong extraction is mysterious rather than diagnosable;
        //   · accounts — with `status` and `revoked_at`, because a revocation
        //     that no export records is a retention clock nobody can audit.
        // Failures are STATED, never coerced into an empty list: an export
        // reading `facts: []` would say 「nobody has remembered anything」,
        // which is a different and much more comfortable claim than 「the
        // memory could not be read」.
        const sidecar = async (fn) => {
          try { return { value: await fn(), error: null }; }
          catch (e) { return { value: null, error: String(e?.message ?? e) }; }
        };
        // `adminListFacts` caps at 1000 rows in both tiers, so asking for more
        // does not get more — it gets a quietly shortened export. Said out
        // loud instead: the flag below is set when the answer came back exactly
        // at the ceiling, because silent truncation is barred (AGENTS.md) and
        // an export that lost half the memory with no note is worse than one
        // that says it did.
        const FACT_EXPORT_MAX = 1000;
        const facts = await sidecar(() => store.adminListFacts({ limit: FACT_EXPORT_MAX }));
        const materials = await sidecar(async () => {
          const out = [];
          for (const c of courses) {
            for (const m of await store.listMaterials(c.user_id, c.id)) {
              // The object key stays server-side even here: an export lands on
              // a laptop, and the key is the address of a child's photograph.
              const { cos_key, ...rest } = m;
              out.push(rest);
            }
          }
          return out;
        });
        const users = await sidecar(() => store.listUsers());
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="demo-data.json"',
        });
        res.end(JSON.stringify({
          exported_at: new Date().toISOString(),
          courses,
          users: users.value,
          materials: materials.value,
          facts: facts.value,
          ...(facts.value?.length === FACT_EXPORT_MAX
            ? { facts_truncated: `只导出了最近 ${FACT_EXPORT_MAX} 条记忆——还有更早的没有包含在内` }
            : {}),
          ...(users.error || materials.error || facts.error
            ? { export_errors: { users: users.error, materials: materials.error, facts: facts.error } }
            : {}),
        }, null, 2));
        return;
      }
      // ---- memory facts, across teachers (ADR-0011 consequences) ----
      // The observability duty for memory: WHICH utterance produced WHICH
      // fact, archived rows and their reasons included. Cross-teacher reach on
      // the admin connection, so it is a content read and is logged like one.
      if (seg[0] === 'facts' && req.method === 'GET') {
        const rows = await store.adminListFacts({
          userId: url.searchParams.get('user_id') || null,
          courseId: url.searchParams.get('course_id') || null,
          limit: Number(url.searchParams.get('limit')) || 500,
        });
        await recordAccess({ action: 'read_facts', excerpt: `${rows.length} 条记忆` });
        return json(200, { ok: true, facts: rows });
      }
      // ---- one course's uploads, on the admin plane ----
      // ADR-0013 §7's reach is acceptable ONLY with the log, and an upload is
      // the most sensitive thing this console can reach, so both the listing
      // and the file itself append a row. The owner is resolved from the course
      // rather than trusted from the request — the console has no session to
      // scope by, so the course record is what says whose material this is.
      if (seg[0] === 'courses' && seg[1] && seg[2] === 'materials' && req.method === 'GET') {
        const course = await store.adminGetCourse(seg[1]);
        if (!course) return json(404, { ok: false, message: '课程不存在' });
        const rows = await store.listMaterials(course.user_id, seg[1]);
        if (seg.length === 3) {
          await recordAccess({ action: 'read_course', course_id: seg[1], excerpt: `${rows.length} 个上传文件` });
          return json(200, {
            ok: true,
            materials: rows.map(({ cos_key, ...rest }) => rest),
          });
        }
        if (seg.length === 5 && seg[4] === 'view') {
          const material = rows.find((m) => String(m.id) === seg[3]);
          if (!material) return json(404, { ok: false, message: '文件不存在' });
          // Awaited before a byte moves: a log appended after the response has
          // started is a log a client can skip by hanging up.
          await recordAccess({
            action: 'read_file', course_id: seg[1], subject: material.id,
            excerpt: `${material.kind} · ${material.mime_type}${material.contains_children ? ' · 含儿童影像' : ''}`,
          });
          return streamMaterial(res, material);
        }
        return json(404, { ok: false, message: 'not found' });
      }
      if (seg[0] === 'courses' && seg[1]) {
        if (req.method === 'GET') {
          const course = await store.adminGetCourse(seg[1]);
          if (!course) return json(404, { ok: false, message: '课程不存在' });
          // Messages, snapshots and the whole state document — child evidence
          // included. Two actions rather than one, because 「opened a course」
          // and 「read its conversation」 are the two ACCESS_ACTIONS the log
          // documents and this endpoint does both at once.
          await recordAccess({
            action: 'read_course', course_id: seg[1], subject: 'course',
            excerpt: `${course.title ?? ''} · ${course.messages?.length ?? 0} 条消息`,
          });
          return json(200, { ok: true, course });
        }
        if (req.method === 'DELETE') {
          const removed = await store.adminDelete(seg[1], { deleteObject });
          await store.audit('console', 'delete_course', null, {
            course_id: seg[1], deleted: removed.deleted, objects: removed.cos_keys.length,
          });
          if (removed.cos_keys.length && !removed.objects_deleted) {
            console.warn(`[cos] ${removed.cos_keys.length} object(s) from course ${seg[1]} still need deleting: ${removed.cos_keys.join(' ')}`);
          }
          return json(removed.deleted ? 200 : 404, removed.deleted ? { ok: true, deleted: seg[1] } : { ok: false, message: '课程不存在' });
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
  // The third lock, and the one that does not depend on where the data root
  // happens to be: uploaded objects are NEVER served statically. With the
  // default layout the dot-segment rule above already refuses `.data`, but
  // DEMO_DATA_DIR can point anywhere — including inside demo/ — and a
  // photograph of children must not become reachable by moving a directory.
  if (!filePath.startsWith(base + path.sep) || rel.split('/').some((seg) => seg.startsWith('.'))
      || filePath === OBJECT_DIR || filePath.startsWith(OBJECT_DIR + path.sep)) {
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
  // No third option to suggest any more (ADR-0013 §4): a key comes from this
  // process's env, or from a signed-in teacher's vault. Never from a browser.
  console.log(seeded.length
    ? `env keys detected: ${seeded.join(', ')}`
    : `no env keys — set one in .env, or sign in and save one to the account vault${VAULT_ON ? '' : ' (KEYS_SECRET unset: the vault is off)'}`);
  if (!existsSync(path.join(PROMPT_DIR, 'base.zh.md'))) console.warn('WARNING: prompts missing');
  // Loud, not subtle: on the public channel an absent ADMIN_TOKEN now REFUSES
  // /api/admin/* with 503 rather than opening it, and the operator has to be
  // told why the console stopped working.
  if (!ADMIN_TOKEN) {
    console.warn(CHANNEL === 'public'
      ? 'WARNING: CHANNEL=public with no ADMIN_TOKEN — /api/admin/* refuses every request (503). Set ADMIN_TOKEN in .env.'
      : 'admin console is OPEN (no ADMIN_TOKEN) — correct only on the tunnel-only dev instance');
  }
  // ADR-0013 §7: 90 days, then pruned. An audit log that grows forever becomes
  // its own liability, and the pilot runs one long-lived process, so startup is
  // the one moment that reliably happens.
  pruneAccess(DATA_DIR)
    .then((r) => { if (r.removed.length) console.log(`[access-log] pruned ${r.removed.length} file(s) older than ${r.cutoff}`); })
    .catch((e) => console.warn('[access-log] prune failed:', e?.message ?? e));
});
