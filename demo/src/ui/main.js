// main.js — app logic for the 小小探索家 demo chat (JSDoc-typed ESM, no build
// step, ADR-0001). Talks to demo/serve.mjs over the /api/chat SSE protocol.
// State custody: course_state + transcript + provider choice live in
// localStorage. API keys: with a signed-in user on a vault-enabled backend
// (health.key_vault) they are WRITE-ONLY to the per-account server vault
// (ADR-0005) and never stored in this browser; only the no-backend
// static/offline tier keeps keys in localStorage ('cst.keys').

import { createInitialState, STAGE_NAMES } from '../engine.mjs';
import {
  renderTeacherMessage, renderAgentMessage, renderArtifactCard,
  renderQuestionBlock, renderQuestionCards, freezeQuestionCards,
  renderClosureCard, renderAwaitingNote,
  renderErrorNotice, renderDebug, renderWfTrace, el,
  renderBlueprintList, renderBlueprintMapView, renderBlueprintChip,
} from './render.js';
import { normalizeBlueprint, numberBlueprint, countUnconfirmed, packStagedMessage } from '../blueprint-util.mjs';
import { TITLE_INTERVALS, TITLE_INTERVAL_DEFAULT } from '../title-agent.mjs';
import { confirmBlueprintNode } from '../engine.mjs';
import { messageIn, cardIn, cardsIn, chipsIn, closureIn, fadeIn } from './motion.js';
import { runLocalMockTurn } from './local-turn.mjs';
import { buildSystemPrompt, stageModuleName, profileSectionText, STYLE_DIRECTIVES } from '../prompt-builder.mjs';
import { createLogStore, mountLogPanel, redactSecrets } from './session-log.mjs';

// ------------------------------------------------------------ persistence

const LS = {
  state: 'cst.state',
  transcript: 'cst.transcript',
  provider: 'cst.provider',
  keys: 'cst.keys',
  models: 'cst.models',
  custom: 'cst.custom',
  apiBase: 'cst.apiBase',
  devmode: 'cst.devmode',
  profile: 'cst.profile',
  logcfg: 'cst.logcfg',
  courseId: 'cst.courseId',   // pointer to the active server course (persistence tier)
  railPinned: 'cst.railPinned', // history rail pinned-open preference
  channels: 'cst.channels',   // per-family 线路 choice (国内/国际), {group: providerId}
  bpW: 'cst.bpW',             // blueprint panel width (desktop, px)
  bpTab: 'cst.bpTab',         // blueprint panel view: 'list' | 'map'
  bpHidden: 'cst.bpHidden',   // teacher chose to collapse the panel
  bpComments: 'cst.bpComments', // unsent per-node 批注, keyed by course
  turnMeta: 'cst.turnMeta',   // live turn-progress display toggles {timer, stats, thinking}
  qcards: 'cst.qcards',       // living question-card answer sets, keyed by course (§5c)
  wbTab: 'cst.wbTab',         // 工作台 top-level tab: 'bp' | 'cards'
  providerCaps: 'cst.providerCaps', // per-provider 深度思考/联网搜索 toggles (UI-only for now)
};

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full/blocked: demo keeps running in memory */ }
}

// ------------------------------------------------------------- app state

/** @type {Object} course_state (engine-owned shape) */
let courseState = load(LS.state, null) || createInitialState(`course-${Date.now()}`);
/**
 * Rich transcript. Entries: {role:'user', content} or
 * {role:'assistant', content, ev} where ev is the full "turn" SSE event.
 * @type {Array<Object>}
 */
let transcript = load(LS.transcript, []);
let provider = load(LS.provider, 'mock');
let apiKeys = load(LS.keys, {});

// ---- per-account key vault (spec 2026-07-22): when the backend advertises
// key_vault and a user is signed in, keys become WRITE-ONLY to the server —
// saved once, stored encrypted per-account, never readable back (flags only).
// localStorage keys are retired for this browser via the migration prompt.
let keyVaultOn = false;   // /api/health key_vault
let serverKeyFlags = {};  // { provider: true } — configured flags, never values

const serverKeyMode = () => Boolean(keyVaultOn && backendOnline && me);

async function loadServerKeyFlags() {
  if (!serverKeyMode()) { serverKeyFlags = {}; return; }
  try {
    const res = await fetch(apiUrl('/api/me/keys'));
    const data = res.ok ? await res.json() : null;
    serverKeyFlags = data?.keys ?? {};
  } catch { serverKeyFlags = {}; }
}

/** PUT one key to the account vault. Reports via note(); returns success. */
async function saveServerKey(pid, value, note) {
  try {
    const res = await fetch(apiUrl(`/api/me/keys/${pid}`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: value }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) {
      note(`保存太频繁，请约 ${Math.max(1, Math.ceil((data.retry_after ?? 60) / 60))} 分钟后再试`);
      return false;
    }
    if (!res.ok || !data.ok) { note(data.message || '保存失败，稍后再试'); return false; }
    if (data.configured) serverKeyFlags = { ...serverKeyFlags, [pid]: true };
    else { const { [pid]: gone, ...rest } = serverKeyFlags; serverKeyFlags = rest; }
    note(data.configured ? '已保存到你的账号（密钥不会再显示）' : '已从账号删除', true);
    logEvent('session', 'server_key_save', { provider: pid, configured: Boolean(data.configured) });
    return true;
  } catch { note('网络不通，稍后再试'); return false; }
}
/** Chosen model per provider id; absent = use the provider default. */
let modelChoices = load(LS.models, {});
/** OpenAI-compatible custom endpoint config. */
let customCfg = { baseURL: '', model: '', key: '', label: '', ...load(LS.custom, {}) };
/** 开发者模式: show wf_trace annotations + workflow map details. */
let devMode = Boolean(load(LS.devmode, false));

/** Session logger (debug drawer 「日志」 panel): every category defaults ON;
 * toggles persist in localStorage; entries are secret-redacted at append time. */
const logStore = createLogStore({
  loadConfig: () => load(LS.logcfg, null),
  saveConfig: (cfg) => save(LS.logcfg, cfg),
});
const logEvent = (cat, event, data) => logStore.log(cat, event, data);

/** 教师档案 (PRD §7.4 v1, local-only): read-only context, never model-writable.
 * ageBand mirrors classBands when exactly one band is chosen (mock uses it). */
let profile = {
  province: '', region: '', ageRange: '', teachYears: '', tenureYears: '',
  role: '', classBands: [], classSize: '', stylePref: '', ageBand: '',
  // title-agent harness config (spec 2026-07-20): rides in the profile so the
  // existing account sync carries it; the server reads profile.autoTitle.
  autoTitle: { enabled: false, every: TITLE_INTERVAL_DEFAULT },
  ...load(LS.profile, {}),
};
let profileSyncTimer = null;
function saveProfile() {
  save(LS.profile, profile);
  // Signed in → the profile follows the account (users.settings.profile).
  if (me) {
    clearTimeout(profileSyncTimer);
    profileSyncTimer = setTimeout(() => {
      fetch(apiUrl('/api/me'), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile }),
      }).catch(() => { /* offline blip — localStorage still holds it */ });
    }, 800);
  }
}
function profileIsEmpty() {
  // autoTitle is harness config, not 档案 content — it never counts as "filled".
  return !Object.entries(profile).some(([k, v]) => k !== 'autoTitle'
    && (Array.isArray(v) ? v.length : String(v ?? '').trim()));
}

/** Fixed choice lists for the 教师档案 pane (DESIGN.md §4). */
// 省→区县 dataset (vendored from province-city-china, MCA-derived; 港澳台 renamed
// 中国香港/中国澳门/中国台湾). Lazy-loaded; the pilot needs district precision (番禺区).
let REGIONS = null;
async function loadRegions() {
  if (REGIONS) return REGIONS;
  try {
    const res = await fetch('src/data/china-regions.json');
    REGIONS = res.ok ? await res.json() : {};
  } catch { REGIONS = {}; }
  return REGIONS;
}
const AGE_RANGES = ['25岁以下', '26–30岁', '31–40岁', '41–50岁', '50岁以上'];
const TEACH_YEARS = ['0–2年', '3–5年', '6–10年', '11–20年', '20年以上'];
const TENURE_YEARS = ['1年以内', '1–3年', '4–6年', '7–10年', '10年以上'];
const KG_ROLES = ['班主任', '配班教师', '保育员', '年级组长', '保教主任', '园内教研员', '副园长', '园长', '实习教师', '其他'];
const CLASS_BANDS = ['小班', '中班', '大班', '混龄'];
const RESPONSE_STYLES = Object.keys(STYLE_DIRECTIVES);
/** The profile as sent with requests (undefined when empty). An enabled
 * autoTitle still ships alone — the server's title harness needs it. */
function profileForRequest() {
  if (profileIsEmpty() && !profile.autoTitle?.enabled) return undefined;
  return { ...profile };
}

// Dev-mode prompt reconstruction (演示模式): fetch-backed cached prompt loader.
// The prompt files are static-served both locally and on GitHub Pages.
const promptFetchCache = new Map();
async function fetchPrompt(name) {
  if (!promptFetchCache.has(name)) {
    const res = await fetch(`src/prompts/${name}.zh.md`);
    if (!res.ok) throw new Error(`prompt ${name} 加载失败`);
    promptFetchCache.set(name, await res.text());
  }
  return promptFetchCache.get(name);
}

/** Rebuild the system prompt client-side for the debug drawer (mock path). */
async function buildMockPromptDebug(state, historyCount) {
  const prof = profileForRequest();
  const system = await buildSystemPrompt(state, fetchPrompt, { profile: prof });
  return {
    system,
    stage_module: stageModuleName(state),
    history_count: historyCount,
    profile_injected: Boolean(profileSectionText(prof)),
    source: 'mock-reconstructed',
    note: '该提示词为演示模式下的还原，未真实发送',
  };
}
/** Optional proxy base URL (e.g. an Alibaba FC endpoint). Empty = same-origin. */
let apiBase = (load(LS.apiBase, '') || '').replace(/\/+$/, '');
/** Whether a proxy answered /api/health (set by initProviders). */
let backendOnline = false;
/** Whether the backend offers the persistence tier (server-side chat history). */
let persistent = false;
/** Whether the backend requires login for persistence (SECURITY.md §3). */
let authRequired = false;
/** Deploy channel from /api/health: 'public' hides dev instruments (spanner). */
let backendChannel = 'dev';
/** Logged-in user (GET /api/me shape) or null = visitor. */
let me = null;
/** Active server course id (persistence tier); null = not loaded / offline. */
let activeCourseId = load(LS.courseId, null);
/** Persistence usable RIGHT NOW: capability + reachability + (login when required).
 * `persistent` alone is the server's capability flag — true even for a signed-out
 * visitor, who must stay on the localStorage 演示模式 path (SECURITY.md §3). */
function persistenceActive() {
  return persistent && backendOnline && !(authRequired && !me);
}
/** Brief list of the demo user's server courses, for the history rail. */
let coursesCache = [];
/** History rail state. */
let railPinned = Boolean(load(LS.railPinned, false));
let manageMode = false;
const selectedIds = new Set();
let pendingDeleteId = null; // single-row inline delete confirm
let renameId = null;        // rail row in inline-rename mode
/** Build an API URL against the configured base (empty = same-origin, local dev). */
const apiUrl = (p) => `${apiBase}${p}`;

let busy = false;
/** @type {string|null} message to resend on 重试 */
let pendingMessage = null;
/** @type {Object|null} last "turn" SSE event, for the debug drawer */
let lastEvent = null;
let lastTurnHadQuestion = false;

/** Local labels for entries /api/health does not describe. */
const LOCAL_LABELS = {
  mock: '演示模式（无需密钥）',
  custom: '自定义端点（OpenAI 兼容）',
};

/** Provider families that appear ONCE in the model dropdown; the mainland/
 * international channel is a separate 线路 selector (DESIGN.md §4). Planned
 * end-state per DATABASE.md open Q5: this whole zoo collapses to 官方服务
 * vs 自备密钥 (BYOK). */
const PROVIDER_GROUPS = {
  minimax: {
    label: 'MiniMax',
    channels: [['minimax', '国内（minimaxi.com）'], ['minimax-intl', '国际（minimax.io）']],
  },
  glm: {
    label: 'GLM（智谱 / Z.AI）',
    channels: [['glm', '国内（bigmodel.cn）'], ['zai', '国际·按量（Z.AI）'], ['zai-coding', '国际·Coding 订阅（Z.AI）']],
  },
};
/** Family a raw provider id belongs to, or null. */
function groupOf(id) {
  return Object.keys(PROVIDER_GROUPS).find((g) => PROVIDER_GROUPS[g].channels.some(([cid]) => cid === id)) ?? null;
}
/** Remembered 线路 per family, {group: providerId}. */
let channelChoice = load(LS.channels, {});

/** Per-provider capability toggles (深度思考 / 联网搜索). Persisted UI state
 * only for now — nothing consumes it yet; it will ride chat requests in a
 * later version (the drawer says so honestly). */
let providerCaps = load(LS.providerCaps, {});

/** 接入与服务 drawer presentation: short names + brand icon + 国内/国际
 * grouping. Display metadata only — provider truth stays in providerInfos.
 * `icon` is a filename stem under assets/providers/ (see that folder's
 * SOURCES.md); channels of one family share their family's icon. */
const DRAWER_META = {
  glm: { name: 'GLM 智谱', icon: 'glm', region: 'cn' },
  qwen: { name: 'Qwen', icon: 'qwen', region: 'cn' },
  minimax: { name: 'MiniMax 中国', icon: 'minimax', region: 'cn' },
  kimi: { name: 'Kimi', icon: 'kimi', region: 'cn' },
  zai: { name: 'Z.AI', icon: 'zai', region: 'intl' },
  'zai-coding': { name: 'Z.AI Coding', icon: 'zai', region: 'intl' },
  'minimax-intl': { name: 'MiniMax 国际', icon: 'minimax', region: 'intl' },
  // FreeModel.dev is a PAID aggregator on Singapore/global nodes — the name
  // says "free", the service is not, and it needs a key like everyone else.
  freemodel: { name: 'FreeModel', icon: 'freemodel', region: 'intl' },
  openrouter: { name: 'OpenRouter', icon: 'openrouter', region: 'intl' },
  kilocode: { name: 'Kilo', icon: 'kilocode', region: 'intl' },
  'opencode-zen': { name: 'OpenCode Zen', icon: 'opencode-zen', region: 'intl' },
};

/** Brand mark for a provider row/card. Static local SVG — no icon-API calls.
 * Providers without an icon (自定义端点, 演示模式) keep a geometric mark. */
function providerMark(id) {
  const icon = DRAWER_META[id]?.icon;
  const box = el('span', icon ? 'pmark img' : 'pmark pd');
  box.setAttribute('aria-hidden', 'true');
  if (icon) {
    const img = document.createElement('img');
    img.src = new URL(`./assets/providers/${icon}.svg`, import.meta.url).href;
    img.alt = '';
    img.loading = 'lazy';
    box.append(img);
  }
  return box;
}

/** 深度思考 support per provider: 'enabled' (teacher-controllable), 'auto'
 * (the service always thinks — shown on, locked), absent = unsupported. */
const CAP_THINKING = {
  glm: 'enabled', zai: 'enabled', 'zai-coding': 'enabled',
  minimax: 'auto', 'minimax-intl': 'auto',
};
/** 联网搜索 support. */
const CAP_WEBSEARCH = new Set(['glm', 'zai', 'zai-coding', 'kimi']);

/** 参考评级·随版本更新 — dot-scale档位 shown on both the 模型与服务 cards and
 * the 接入与服务 drawer rows (cost dots = 越多越省钱, per the pane legend). */
const MODEL_TRAITS = {
  'glm-5.2': { intel: 5, speed: 2, cost: 3 },
  'MiniMax-M3': { intel: 4, speed: 3, cost: 3 },
  'kimi-k2.6': { intel: 4, speed: 2, cost: 2 },
  'qwen-plus': { intel: 3, speed: 4, cost: 4 },
};
/** Family fallback so a version bump (glm-5.2 → glm-5.3) or an aggregator id
 * (z-ai/glm-4.7:free) keeps a 档位 instead of going blank. Unmatched ids —
 * 'auto', an unknown OpenRouter model — get NO rating rather than a guess. */
const FAMILY_TRAITS = [
  [/glm/i, { intel: 5, speed: 2, cost: 3 }],
  [/minimax/i, { intel: 4, speed: 3, cost: 3 }],
  [/kimi|moonshot/i, { intel: 4, speed: 2, cost: 2 }],
  [/qwen/i, { intel: 3, speed: 4, cost: 4 }],
];
/** 档位 for a model id, or null when we genuinely do not know. */
function traitsFor(model) {
  if (!model) return null;
  return MODEL_TRAITS[model] ?? FAMILY_TRAITS.find(([re]) => re.test(model))?.[1] ?? null;
}

/** Offline fallback when /api/health is unreachable (e.g. static hosting).
 * Must mirror the enabled providers in adapter.mjs PROVIDERS, so the dropdown
 * offers the same choices with or without a backend. */
const FALLBACK_PROVIDERS = [
  { id: 'minimax', label: 'MiniMax（中国 minimaxi.com）', defaultModel: '', hasEnvKey: false },
  { id: 'minimax-intl', label: 'MiniMax（国际 minimax.io）', defaultModel: '', hasEnvKey: false },
  { id: 'glm', label: 'GLM（智谱国内 bigmodel.cn）', defaultModel: '', hasEnvKey: false },
  { id: 'zai', label: 'GLM · Z.AI（国际，按量计费）', defaultModel: '', hasEnvKey: false },
  { id: 'zai-coding', label: 'GLM · Z.AI Coding Plan（国际，订阅额度）', defaultModel: '', hasEnvKey: false },
  { id: 'kimi', label: 'Kimi', defaultModel: '', hasEnvKey: false },
  { id: 'freemodel', label: 'FreeModel.dev', defaultModel: 'auto', hasEnvKey: false },
  { id: 'openrouter', label: 'OpenRouter', defaultModel: '', hasEnvKey: false },
  { id: 'kilocode', label: 'Kilo Gateway（kilo.ai）', defaultModel: '', hasEnvKey: false },
  { id: 'opencode-zen', label: 'OpenCode Zen（在线）', defaultModel: '', hasEnvKey: false },
];

/** @type {Array<{id: string, label: string, defaultModel: string, hasEnvKey: boolean}>} */
let providerInfos = FALLBACK_PROVIDERS;

function providerInfo(id) {
  return providerInfos.find((p) => p.id === id) ?? null;
}

/** Has the teacher (or the server env) actually set this provider up? Drives
 * both the drawer badge and which cards the 模型与服务 picker shows. */
function isConfigured(id) {
  if (id === 'custom') return Boolean(customCfg.baseURL);
  if (serverKeyMode()) return Boolean(serverKeyFlags[id] || providerInfo(id)?.hasEnvKey);
  return Boolean(apiKeys[id] || providerInfo(id)?.hasEnvKey);
}

const STARTERS = [
  '我想带中班孩子做醒狮',
  '我们班在做龙舟主题，想优化',
  '昨天孩子们做狮头卡住了，想聊聊下一步',
  '我有一堆照片想整理成课程故事',
  '我想要一份趁墟的亲子调查素材',
];

// ------------------------------------------------------------ dom handles

const $ = (sel) => document.querySelector(sel);
const messagesEl = $('#messages');
const inputEl = $('#input');
const sendBtn = $('#send');
const skipLink = $('#skip');
const statusLine = $('#status-line');
const statusText = $('#status-text');
const subtitleEl = $('#subtitle');
const settingsDrawer = $('#settings-drawer'); // the 用户中心 modal (controls everything)
const debugDrawer = $('#debug-drawer');
const debugBody = $('#debug-body');
const providerBox = $('#provider-box');

// ---------------------------------------------------------------- helpers

function updateHeader() {
  const name = courseState?.theme_resource?.name ? `${courseState.theme_resource.name}` : '新课程';
  const stage = STAGE_NAMES[courseState?.stage] ?? '';
  subtitleEl.textContent = `${name} · ${stage}`;
}

function updateSkipLink() {
  skipLink.classList.toggle('on', lastTurnHadQuestion && !busy);
}

function setStatus(text) {
  if (text) {
    // Trailing ellipsis becomes the breathing three-dot indicator — the one
    // permitted loop (DESIGN.md §6): it signals "working" and dies with the reply.
    const trimmed = text.replace(/[…⋯]+\s*$/, '');
    statusText.textContent = trimmed;
    if (trimmed !== text) {
      const dots = el('span', 'status-dots');
      dots.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 3; i += 1) dots.append(document.createElement('i'));
      statusText.append(dots);
    }
    statusLine.classList.add('on');
  } else {
    statusLine.classList.remove('on');
  }
}

// Live turn-progress display (this browser only): the waiting timer is on by
// default; stats (TTFT/字数/全程) and the streamed thinking panel are opt-in
// (用户中心 · 通用). feng feedback 2026-07-20: long silent turns read as broken.
let turnMeta = load(LS.turnMeta, {});
const turnMetaOn = (k) => ({ timer: true, stats: false, thinking: false, cache: true, guards: true, ...turnMeta })[k];

/** Teacher-readable line for one adapter guard event ('appearing if needed'). */
function guardNoteText(g) {
  const min = (ms) => Math.round((ms ?? 0) / 60000);
  if (g.event === 'forced_answer_retry') {
    return `思考超过 ${min(g.budget_ms)} 分钟：已切换为直接作答重试${g.draft_chars ? `（带回 ${g.draft_chars} 字思考草稿）` : ''}`;
  }
  if (g.event === 'idle_timeout') return `连续 ${Math.round((g.limit_ms ?? 0) / 1000)} 秒没有任何输出，连接已断开`;
  if (g.event === 'total_timeout') return `生成超过 ${min(g.limit_ms)} 分钟仍未完成，已停止`;
  return null;
}

/** Wire one in-flight turn's live progress: ticking timer beside the status
 * line, optional TTFT/char readouts, optional ChatGPT-style 思考过程 panel
 * streaming whatever reasoning the model exposes. Returns handlers for the
 * SSE events; end() tears everything down and leaves the 耗时 badge. */
function beginTurnMeta() {
  const t0 = Date.now();
  let ttftMs = null;
  let chars = 0;
  const meta = el('span', 'status-meta');
  statusLine.append(meta);
  const fmt = (ms) => {
    const s = Math.max(1, Math.round(ms / 1000));
    return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  };
  const renderMeta = () => {
    const bits = [];
    if (turnMetaOn('timer')) bits.push(`已等待 ${fmt(Date.now() - t0)}`);
    if (turnMetaOn('stats') && ttftMs != null) bits.push(`首字 ${(ttftMs / 1000).toFixed(1)} 秒`);
    if (turnMetaOn('stats') && chars > 0) bits.push(`已生成 ${chars} 字`);
    meta.textContent = bits.length ? bits.join(' · ') : '';
  };
  const tick = setInterval(renderMeta, 1000);
  renderMeta();

  let panel = null;
  let body = null;
  const ensurePanel = () => {
    if (!turnMetaOn('thinking')) return false;
    if (!panel) {
      panel = el('details', 'thinking-panel');
      panel.open = true;
      panel.append(el('summary', '', '思考过程'));
      body = el('div', 'thinking-body');
      panel.append(body);
      messagesEl.append(panel);
      scrollToEnd();
    }
    return true;
  };
  return {
    ttft(ms) { ttftMs = ms; renderMeta(); },
    progress(d) { chars = d.chars ?? 0; renderMeta(); },
    thinking(text) { if (ensurePanel()) body.append(text); },
    phase() { if (body) body.replaceChildren(); }, // L4 retry / failover: fresh pass, fresh panel
    guard(g) {
      logEvent('harness', 'timeout_guard', g);
      if (!turnMetaOn('guards')) return;
      const note = guardNoteText(g);
      if (note) { messagesEl.append(el('div', 'guard-note', note)); scrollToEnd(); }
    },
    end(gotTurn) {
      clearInterval(tick);
      meta.remove();
      if (panel) {
        if (body.textContent.trim()) { panel.open = false; panel.classList.add('done'); }
        else panel.remove();
      }
      if (gotTurn && turnMetaOn('stats')) {
        const bits = [];
        if (ttftMs != null) bits.push(`首字 ${(ttftMs / 1000).toFixed(1)} 秒`);
        bits.push(`全程 ${fmt(Date.now() - t0)}`);
        messagesEl.append(el('div', 'turn-meta-badge', bits.join(' · ')));
      }
    },
  };
}

function refreshDebug() {
  renderDebug(debugBody, { lastEvent, state: courseState });
}

/** Dev instruments (the debug spanner + Ctrl+`) are role-gated, not channel-forked:
 * dev/local channels always show them; the PUBLIC channel shows them only to a
 * signed-in role above teacher (admin) — so public and dev run identical code.
 * UI-gating only: the drawer reveals client-side state, never server secrets. */
function devInstrumentsAllowed() {
  return backendChannel !== 'public' || me?.role === 'admin';
}

function applyDevInstruments() {
  $('#btn-debug').hidden = !devInstrumentsAllowed();
}

function scrollToEnd() {
  requestAnimationFrame(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  });
}

function autogrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
}

/** ↻ on a teacher message: refill the composer with that text so the teacher
 * can tweak and resend without retyping. Never auto-sends. */
function fillComposer(text) {
  inputEl.value = text;
  autogrow();
  inputEl.focus();
}

function openDrawer(drawer) {
  for (const d of [settingsDrawer, debugDrawer]) d.classList.toggle('open', d === drawer && !d.classList.contains('open'));
}

function closeDrawers() {
  settingsDrawer.classList.remove('open');
  debugDrawer.classList.remove('open');
  // 接入与服务 drawer never outlives the modal.
  settingsDrawer.classList.remove('dev-open');
  const dp = document.querySelector('#dev-panel');
  if (dp) dp.hidden = true;
}

// -------------------------------------------------------------- rendering

function clearAwaitingNotes() {
  for (const node of messagesEl.querySelectorAll('.awaiting-note')) node.remove();
}

function removeWelcome() {
  const w = $('#welcome');
  if (w) w.remove();
}

function renderWelcome() {
  const box = el('div', 'welcome');
  box.id = 'welcome';
  box.append(el('h2', 'welcome-title', '我在，随时可以开始。'));
  box.append(el('p', 'welcome-note',
    '我是陪跑智能体，陪你把身边的本土资源慢慢长成孩子的课程。不用先准备什么材料——从一句话说起就可以，比如：'));
  const row = el('div', 'chip-row');
  for (const starter of STARTERS) {
    const chip = el('button', 'chip', starter);
    chip.type = 'button';
    row.append(chip);
  }
  box.append(row);
  messagesEl.append(box);
}

/**
 * Render one full agent turn (message → artifacts → question → closure →
 * awaiting note). Animation only for live turns, not restored history.
 * @param {Object} ev the "turn" SSE event
 * @param {{animate?: boolean}} [opts]
 */
function renderTurnGroup(ev, opts = {}) {
  const animate = opts.animate !== false;
  const { turn, gate_report: gate } = ev;
  const group = el('div', 'turn-group');

  const msg = renderAgentMessage(turn.reply_markdown, {
    // warn-level violations are recorded (debug drawer) but are not intercepts.
    interceptCount: gate?.violations?.filter((v) => v.action !== 'warn').length ?? 0,
    degraded: Boolean(gate?.degraded),
    onBadgeClick: () => { refreshDebug(); openDrawer(debugDrawer); },
  });
  group.append(msg);

  if (devMode && turn.wf_trace) group.append(renderWfTrace(turn.wf_trace));

  const cards = [];
  // Blueprint content lives ONLY in the workspace panel (spec 2026-07-20) —
  // chat gets a pointer chip; delta-only turns get one too.
  const bpArtifacts = (turn.artifacts ?? []).filter((a) => a.type === 'blueprint');
  const otherArtifacts = (turn.artifacts ?? []).filter((a) => a.type !== 'blueprint');
  if (otherArtifacts.length) {
    const wrap = el('div', 'artifacts');
    for (const artifact of otherArtifacts) {
      const card = renderArtifactCard(artifact);
      cards.push(card);
      wrap.append(card);
    }
    group.append(wrap);
  }
  if (bpArtifacts.length || (Array.isArray(turn.blueprint_delta) && turn.blueprint_delta.length)) {
    const bp = ev.state?.course_plan_blueprint;
    const chip = renderBlueprintChip({
      version: bp ? `v0.${bp.version}` : 'v0.1', // engine-owned numbering, same as the panel pill
      pending: bp ? countUnconfirmed(normalizeBlueprint({ modules: bp.modules }).modules) : 0,
      onOpen: openBlueprintPanel,
    });
    cards.push(chip);
    group.append(chip);
  }

  let questionEl = null;
  const cardQuestions = Array.isArray(turn.questions) && turn.questions.length
    ? turn.questions
    : (turn.question ? [turn.question] : []);
  if (cardQuestions.length >= 2) {
    // Freeze any earlier still-active card set: only the newest turn collects answers.
    for (const stale of messagesEl.querySelectorAll('.qcards:not(.submitted)')) freezeQuestionCards(stale);
    // Bind to the LIVING answer set when this is the active turn (§5c): the
    // chat carousel and the 工作台 queue then edit one shared state.
    const set = activeCardSet();
    const live = set && set.sig === cardSetSig(cardQuestions);
    questionEl = renderQuestionCards(cardQuestions, live ? {
      answers: set.answers,
      onChange: onCardChange,
      registerView: (fn) => cardViewSyncs.add(fn),
    } : {});
    group.append(questionEl);
  } else if (cardQuestions.length === 1) {
    questionEl = renderQuestionBlock(cardQuestions[0]);
    group.append(questionEl);
  }

  let closureEl = null;
  if (turn.closure_loop) {
    closureEl = renderClosureCard(turn.closure_loop);
    group.append(closureEl);
  }

  let awaitingEl = null;
  if (ev.state?.awaiting_feedback) {
    awaitingEl = renderAwaitingNote();
    group.append(awaitingEl);
  }

  messagesEl.append(group);

  if (animate) {
    messageIn(msg, 0, { from: 'left' }); // agent slides in from its side of the desk
    cards.forEach((card, i) => cardIn(card, i));
    if (questionEl) {
      // The question card deck is dealt from the agent's side of the desk.
      messageIn(questionEl, 0.12 + cards.length * 0.08, { from: 'left' });
      cardsIn(questionEl.querySelectorAll('.qcard'), 0.2 + cards.length * 0.08);
      chipsIn(questionEl.querySelectorAll('.chip'), 0.28 + cards.length * 0.08);
    }
    if (closureEl) closureIn(closureEl);
    if (awaitingEl) fadeIn(awaitingEl, 0.5);
  }
}

function replayTranscript() {
  cardViewSyncs.clear(); // stale DOM renderers must not receive sync nudges
  refreshBlueprintPanel(); // any path that re-renders the chat re-syncs the living plan
  messagesEl.replaceChildren();
  if (!transcript.length) {
    renderWelcome();
    return;
  }
  for (const entry of transcript) {
    if (entry.role === 'user') {
      messagesEl.append(renderTeacherMessage(entry.content, { onRetry: fillComposer }));
    } else if (entry.ev) {
      clearAwaitingNotes();
      renderTurnGroup(entry.ev, { animate: false });
    } else {
      messagesEl.append(renderAgentMessage(entry.content));
    }
  }
  const last = transcript[transcript.length - 1];
  lastEvent = last?.ev ?? null;
  lastTurnHadQuestion = Boolean(last?.ev?.turn?.question);
  // Historical question cards are read-only: only card sets living in the very
  // last turn-group may still collect answers, and only when the transcript
  // actually ends on an agent turn (an existing teacher reply closes them all).
  const groups = messagesEl.querySelectorAll('.turn-group');
  const lastGroup = groups[groups.length - 1] ?? null;
  const lastIsOpenAgentTurn = Boolean(last?.ev);
  for (const set of messagesEl.querySelectorAll('.qcards')) {
    if (!lastIsOpenAgentTurn || !lastGroup || !lastGroup.contains(set)) freezeQuestionCards(set);
  }
}

// ------------------------------------------------------------- SSE client

/**
 * Read a fetch Response as SSE, invoking onEvent(name, data) per event.
 * @param {Response} res
 * @param {(name: string, data: Object) => void} onEvent
 */
async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let name = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) name = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (!data) continue;
      try { onEvent(name, JSON.parse(data)); } catch { /* skip malformed frame */ }
    }
  }
}

// ------------------------------------------------------------- chat flow

/** Wire history for the API: prior turns as bare {role, content}. */
function wireHistory() {
  return transcript.map(({ role, content }) => ({ role, content }));
}

/**
 * Assemble the /api/chat body: provider + keys, a model override when the
 * teacher picked one that differs from the provider default, and the custom
 * endpoint config when provider === 'custom'.
 * @param {string} text
 */
function chatRequestBody(text) {
  const body = {
    state: courseState,
    history: wireHistory(),
    message: text,
    provider,
    // Vault mode: the server injects account keys itself — nothing rides the wire.
    keys: serverKeyMode() ? {} : { ...apiKeys },
  };
  const prof = profileForRequest();
  if (prof) body.profile = prof;
  if (devMode) body.debug = true;
  if (provider === 'custom') {
    body.custom = { baseURL: customCfg.baseURL, model: customCfg.model, label: customCfg.label || undefined };
    if (customCfg.key && !serverKeyMode()) body.keys.custom = customCfg.key;
  } else {
    const chosen = modelChoices[provider];
    if (chosen && chosen !== (providerInfo(provider)?.defaultModel ?? '')) body.model = chosen;
  }
  return body;
}

/** Persistence-tier body: server owns state + history, so ship neither. */
function courseChatRequestBody(text) {
  const { state, history, ...rest } = chatRequestBody(text);
  return rest;
}

/**
 * @param {string} message
 * @param {{isRetry?: boolean}} [opts]
 */
async function send(message, opts = {}) {
  const text = message.trim();
  if (!text || busy) return;
  busy = true;
  sendBtn.disabled = true;
  updateSkipLink();
  removeWelcome();
  pendingMessage = text;
  logEvent('user_input', opts.isRetry ? 'retry' : 'message', {
    text, provider, dev_mode: devMode, stage: courseState?.stage ?? null,
  });

  if (!opts.isRetry) {
    clearAwaitingNotes();
    const bubble = renderTeacherMessage(text, { onRetry: fillComposer });
    messagesEl.append(bubble);
    messageIn(bubble, 0, { from: 'right' }); // teacher slides in from their side
    scrollToEnd();
  }

  setStatus('正在联系陪跑智能体…');
  let gotTurn = false;
  const liveMeta = beginTurnMeta();

  const dispatch = (name, data) => {
    if (name === 'status') setStatus(data.text ?? '…');
    else if (name === 'ttft') liveMeta.ttft(data.ms);
    else if (name === 'progress') liveMeta.progress(data);
    else if (name === 'thinking') liveMeta.thinking(data.text ?? '');
    else if (name === 'phase') liveMeta.phase();
    else if (name === 'guard') liveMeta.guard(data);
    else if (name === 'turn') { gotTurn = true; handleTurn(text, data); }
    else if (name === 'course') {
      // server auto-titled the course (theme extracted) — update the rail row
      const hit = coursesCache.find((c) => c.id === data.id);
      if (hit) { hit.title = data.title; renderRail(); }
    }
    else if (name === 'error') {
      logEvent('error', 'turn_error', { message: data.message ?? '', kind: data.kind ?? '', chain: data.chain ?? [] });
      let msg = data.message || '这一轮没有走通。';
      // Quota refusal (spec 2026-07-22 §6): say when, in the same error card.
      if (data.kind === 'rate_limited' && data.retry_after) {
        msg += `（约 ${Math.max(1, Math.ceil(data.retry_after / 60))} 分钟后可再试）`;
      }
      showError(msg, data.chain);
    }
  };
  const simulate = async (label) => {
    const stateBefore = courseState;
    const wired = wireHistory();
    logEvent('api_out', 'local_mock_turn', {
      provider, label: label || '演示模式', history_count: wired.length, message: text,
    });
    const ev = runLocalMockTurn(stateBefore, wired, text, { profile: profileForRequest() });
    if (label) { ev.providerLabel = label; ev.simulated = true; }
    if (devMode) {
      // Attach BEFORE dispatch so the reconstructed prompt persists on the event.
      try { ev.prompt_debug = await buildMockPromptDebug(stateBefore, Math.min(wired.length, 24)); } catch { /* prompts unreachable — skip the annotation */ }
    }
    dispatch('turn', ev);
  };

  const needsBackend = provider !== 'mock';
  const haveBackend = backendOnline || Boolean(apiBase);
  const usePersistent = persistenceActive() && Boolean(activeCourseId);

  // POST one turn to a turn endpoint (persistent course chat or the stateless
  // /api/chat) and pump its SSE / buffered-JSON events through dispatch.
  const postTurn = async (url, requestBody) => {
    const crossOrigin = Boolean(apiBase);
    // The store redacts again on append; redacting here too keeps the raw keys
    // object from ever entering the logging path.
    logEvent('api_out', 'chat_request', {
      url, transport: crossOrigin ? 'buffered-json' : 'sse', body: redactSecrets(requestBody),
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: crossOrigin ? 'application/json' : 'text/event-stream',
      },
      body: JSON.stringify(requestBody),
    });
    if (!res.ok) throw new Error(`服务返回 ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const payload = await res.json();
      for (const { event, data } of payload.events || []) dispatch(event, data);
    } else if (res.body) {
      await readSSE(res, dispatch);
    } else {
      throw new Error('服务没有返回内容');
    }
    if (!gotTurn && !messagesEl.querySelector('.error-notice')) {
      showError('连接中断了，这一轮没有收到回复。');
    }
  };

  try {
    if (usePersistent) {
      // Persistence tier: every provider (mock included) runs on the server so
      // the turn is stored and history reloads from the server next visit.
      await postTurn(apiUrl(`/api/courses/${activeCourseId}/chat`), courseChatRequestBody(text));
    } else if (!needsBackend) {
      await simulate(null);
    } else if (!haveBackend) {
      showSimulatedNotice();
      await simulate(`模拟演示（后端未连接，未实际调用 ${providerInfo(provider)?.label ?? provider}）`);
    } else {
      await postTurn(apiUrl('/api/chat'), chatRequestBody(text));
    }
  } catch (err) {
    logEvent('error', 'request_failed', { message: err?.message ?? String(err), provider });
    if (needsBackend || usePersistent) {
      showSimulatedNotice();
      await simulate(`模拟演示（后端连接失败，未实际调用 ${providerInfo(provider)?.label ?? provider}）`);
    } else {
      showError(err?.message || '这一轮没有走通。');
    }
  } finally {
    busy = false;
    sendBtn.disabled = false;
    setStatus(null);
    liveMeta.end(gotTurn);
    updateSkipLink();
  }
}

/** @param {string} userText @param {Object} ev the "turn" SSE event */
function handleTurn(userText, ev) {
  const stageBefore = courseState?.stage ?? null;
  // API 返回: the reply + full round-trip detail when the server attached it
  // (api_debug arrives only in 开发者模式; usage/provider always).
  logEvent('api_in', 'turn', {
    provider: ev.provider ?? null,
    provider_label: ev.providerLabel ?? null,
    simulated: Boolean(ev.simulated),
    usage: ev.usage ?? null,
    cache: ev.cache ?? null,
    guards: ev.guards ?? [],
    reply_markdown: ev.turn?.reply_markdown ?? '',
    question: ev.turn?.question ?? null,
    artifacts: (ev.turn?.artifacts ?? []).map((a) => ({ type: a.type, title: a.title })),
    api_debug: ev.api_debug ?? null,
  });
  // 护栏: every gate report, including clean passes (attempt count matters).
  logEvent('harness', 'gate_report', {
    ok: ev.gate_report?.ok ?? null,
    attempt: ev.gate_report?.attempt ?? null,
    degraded: Boolean(ev.gate_report?.degraded),
    violations: ev.gate_report?.violations ?? [],
  });
  // 工作流: stage movement + node declarations + the state delta that drove them.
  logEvent('workflow', 'turn_progress', {
    stage_before: stageBefore,
    stage_after: ev.state?.stage ?? null,
    stage_name: ev.stageName ?? null,
    completed_nodes: ev.state?.completed_nodes ?? [],
    round_complete: Boolean(ev.turn?.round_complete),
    awaiting_feedback: Boolean(ev.state?.awaiting_feedback),
    state_delta: ev.turn?.state_delta ?? {},
    wf_trace: ev.turn?.wf_trace ?? null,
  });

  courseState = ev.state;
  lastEvent = ev;
  lastTurnHadQuestion = Boolean(ev.turn?.question);
  transcript.push(
    { role: 'user', content: userText },
    { role: 'assistant', content: ev.turn.reply_markdown, ev },
  );
  save(LS.state, courseState);
  save(LS.transcript, transcript);
  pendingMessage = null;
  // Living card set (§5c): a new agent turn with 2+ questions replaces the
  // active set; any other turn closes it (the conversation moved on).
  const evQuestions = Array.isArray(ev.turn?.questions) && ev.turn.questions.length
    ? ev.turn.questions
    : (ev.turn?.question ? [ev.turn.question] : []);
  if (evQuestions.length >= 2) {
    setActiveCardSet({
      sig: cardSetSig(evQuestions),
      questions: evQuestions,
      answers: evQuestions.map(() => ({ value: '', skipped: false, locked: false })),
    });
  } else {
    setActiveCardSet(null);
  }
  refreshBlueprintPanel();
  // Living-plan trace: absorbed blueprint versions surface in the debug JSON
  // export (session log) alongside the workflow events they rode in on.
  if (courseState?.course_plan_blueprint) {
    logEvent('workflow', 'blueprint', {
      version: courseState.course_plan_blueprint.version,
      display_version: courseState.course_plan_blueprint.display_version,
      modules: courseState.course_plan_blueprint.modules.map((m) => ({ id: m.id, status: m.status })),
    });
  }

  setStatus(null);
  renderTurnGroup(ev, { animate: true });
  // Prompt-cache readout, only when the vendor actually reported one and the
  // teacher hasn't switched it off (回合进度显示 · 提示缓存命中).
  if (ev.cache && turnMetaOn('cache')) {
    const { cached_tokens: c, prompt_tokens: p } = ev.cache;
    const pct = p ? `，命中 ${Math.round((c / p) * 100)}%` : '';
    messagesEl.append(el('div', 'turn-meta-badge cache-badge',
      c > 0 ? `提示缓存：命中 ${c} / ${p ?? '?'} tokens${pct}` : `提示缓存：本轮未命中（0 / ${p ?? '?'}）`));
  }
  updateHeader();
  refreshDebug();
  scrollToEnd();
}

function showSimulatedNotice() {
  for (const n of messagesEl.querySelectorAll('.sim-note')) n.remove();
  const note = el('div', 'awaiting-note sim-note',
    '后端未连接——这一轮是模拟演示（演示模式脚本，未调用真实模型）。要接真实模型，请在设置里填写服务器地址后重试。');
  messagesEl.append(note);
  fadeIn(note);
}

function showError(message, chain) {
  setStatus(null);
  const notice = renderErrorNotice(message, () => {
    if (pendingMessage) send(pendingMessage, { isRetry: true });
  }, { chain });
  messagesEl.append(notice);
  fadeIn(notice);
  scrollToEnd();
}

// -------------------------------------------------------------- settings

function saveKeys() { save(LS.keys, apiKeys); }
function saveModels() { save(LS.models, modelChoices); }
function saveCustom() { save(LS.custom, customCfg); }

/** Labeled <select> field factory (fixed choice lists; '' = 未选择).
 * opts.titles: per-option hover tooltips; opts.describe(v): live note under the select. */
function selectField(labelText, id, options, value, onChange, opts = {}) {
  const field = el('div', 'settings-field');
  const label = el('label', 'settings-label', labelText);
  const sel = el('select', 'settings-select');
  sel.id = id;
  label.htmlFor = id;
  for (const opt of ['', ...options]) {
    const o = el('option', '', opt || '未选择');
    o.value = opt;
    if (opt && opts.titles?.[opt]) o.title = opts.titles[opt];
    sel.append(o);
  }
  sel.value = options.includes(value) ? value : '';
  field.append(label, sel);
  let note = null;
  if (opts.describe) {
    note = el('p', 'settings-note');
    note.textContent = opts.describe(sel.value);
    field.append(note);
  }
  sel.addEventListener('change', () => {
    onChange(sel.value);
    if (note) note.textContent = opts.describe(sel.value);
  });
  return field;
}

/** Labeled input factory for the settings drawer. */
function settingsField(labelText, inputId, opts = {}) {
  const field = el('div', 'settings-field');
  const label = el('label', 'settings-label', labelText);
  if (opts.hint) label.append(el('span', 'env-key-hint', opts.hint));
  const input = el('input', 'settings-input');
  input.type = opts.type ?? 'text';
  input.autocomplete = 'off';
  if (opts.placeholder) input.placeholder = opts.placeholder;
  input.value = opts.value ?? '';
  input.addEventListener('input', () => opts.onInput?.(input.value));
  label.htmlFor = input.id = inputId;
  field.append(label, input);
  return { field, input };
}

/**
 * The model row: free-text input by default; 「获取模型列表」 swaps in a
 * <select> of ids fetched via POST /api/models (with a 「手动输入」 escape).
 * @param {string} id provider id ('custom' included)
 * @param {{ getModel: () => string, setModel: (m: string) => void,
 *           defaultModel: string, modelsBody: () => Object }} cfg
 */
function modelRow(id, cfg) {
  const wrap = el('div', 'settings-field');
  const label = el('label', 'settings-label', '模型');
  const row = el('div', 'model-row');
  const errorSlot = el('div', 'inline-error');
  errorSlot.hidden = true;

  const holder = el('span', 'model-holder');
  const fetchBtn = el('button', 'text-btn model-fetch', '获取模型列表');
  fetchBtn.type = 'button';
  const manualBtn = el('button', 'text-btn model-manual', '手动输入');
  manualBtn.type = 'button';
  manualBtn.hidden = true;

  const showError = (message) => {
    // textContent only — the backend message is model/vendor-derived.
    errorSlot.textContent = message;
    errorSlot.hidden = !message;
  };

  const mountInput = () => {
    const input = el('input', 'settings-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = cfg.defaultModel ? `默认 ${cfg.defaultModel}` : '模型 id';
    input.value = cfg.getModel();
    input.id = `model-${id}`;
    label.htmlFor = input.id;
    input.addEventListener('input', () => cfg.setModel(input.value.trim()));
    holder.replaceChildren(input);
    manualBtn.hidden = true;
  };

  const mountSelect = (models) => {
    const select = el('select', 'settings-select');
    select.id = `model-${id}`;
    label.htmlFor = select.id;
    const current = cfg.getModel() || cfg.defaultModel;
    const ids = models.includes(current) || !current ? models : [current, ...models];
    for (const m of ids) {
      const opt = el('option', '', m);
      opt.value = m;
      select.append(opt);
    }
    if (current) select.value = current;
    cfg.setModel(select.value);
    select.addEventListener('change', () => cfg.setModel(select.value));
    holder.replaceChildren(select);
    manualBtn.hidden = false;
  };

  fetchBtn.addEventListener('click', async () => {
    showError('');
    if (!backendOnline && !apiBase) {
      showError('没有后端：这是静态托管（如 GitHub Pages），拿不到模型列表。请先在上方「服务器地址」填写已部署的代理地址（见 docs/DEPLOY.md），或直接在下方手动输入模型 id；只想体验流程可选「演示模式」。');
      return;
    }
    fetchBtn.disabled = true;
    const idle = fetchBtn.textContent;
    fetchBtn.textContent = '获取中…';
    try {
      const res = await fetch(apiUrl('/api/models'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cfg.modelsBody()),
      });
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        showError('没连到后端（返回的不是 JSON，可能是静态托管的 404 页）。请检查「服务器地址」是否正确，或用「演示模式」。');
        return;
      }
      const data = await res.json();
      if (!data.ok) {
        showError(data.message || '获取失败');
      } else if (!data.models?.length) {
        showError('该服务没有返回可用模型');
      } else {
        mountSelect(data.models);
      }
    } catch (err) {
      showError(err?.message || '无法连接本地演示服务');
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = idle;
    }
  });

  manualBtn.addEventListener('click', mountInput);

  mountInput();
  row.append(holder, fetchBtn, manualBtn);
  wrap.append(label, row, errorSlot);
  return wrap;
}

/** Drawer-row summary: brand mark + short name + 配置 badge. Returns the
 * badge element so the key input can repaint it live. */
function drawerSummary(id, fallbackLabel) {
  const meta = DRAWER_META[id];
  const summary = el('summary', '');
  const badge = el('span', 'drawer-badge');
  summary.append(providerMark(id), el('span', 'drawer-name', meta?.name ?? fallbackLabel), badge);
  return { summary, badge };
}

/** 已配置/未配置 badge state for one provider row. Every provider needs a key
 * — including FreeModel.dev, whose name is a brand, not a price. */
function paintBadge(badge, id) {
  const configured = isConfigured(id);
  badge.className = `drawer-badge ${configured ? 'ok' : 'no'}`;
  badge.textContent = configured ? '已配置' : '未配置';
}

/** Every rendered 深度思考/联网搜索 switch, so flipping one repaints its twin
 * in the other panel (接入与服务 drawer ↔ 模型与服务 cards). Detached nodes are
 * dropped lazily on the next sync. */
const capSwitches = [];
function syncCapSwitches(pid, kind, on) {
  for (let i = capSwitches.length - 1; i >= 0; i -= 1) {
    const s = capSwitches[i];
    if (!s.el.isConnected) { capSwitches.splice(i, 1); continue; }
    if (s.pid === pid && s.kind === kind) s.el.checked = on;
  }
}

/** One 深度思考/联网搜索 switch row. Persists to cst.providerCaps; consumed
 * by nothing yet (the drawer's 即将生效 note states this honestly). Rendered in
 * BOTH panels — the drawer row and the model card — kept in sync by id. */
function capRow(pid, kind) {
  const row = el('div', 'cap-row');
  const name = kind === 'thinking' ? '深度思考' : '联网搜索';
  let desc;
  let disabled = false;
  let checked = Boolean(providerCaps[pid]?.[kind]);
  if (kind === 'thinking') {
    const mode = CAP_THINKING[pid];
    if (mode === 'auto') { desc = '该服务由模型自动思考'; disabled = true; checked = true; }
    else if (mode === 'enabled') { desc = '让模型多想一步，回答更稳，速度会慢一些'; }
    else { desc = '该模型暂不支持'; disabled = true; checked = false; }
  } else if (CAP_WEBSEARCH.has(pid)) {
    desc = '可查证最新资料 · 仅 GLM / Z.AI / Kimi 支持';
  } else {
    desc = '该服务暂不支持联网搜索'; disabled = true; checked = false;
  }
  const sw = document.createElement('input');
  sw.type = 'checkbox';
  sw.className = 'cap-switch';
  sw.checked = checked;
  sw.disabled = disabled;
  sw.setAttribute('aria-label', `${name}（${DRAWER_META[pid]?.name ?? pid}）`);
  if (!disabled) {
    // Prune detached twins here too, not only on toggle — every
    // buildModelsPane() re-render otherwise grows the registry by a few
    // dead nodes that nothing ever drops.
    for (let i = capSwitches.length - 1; i >= 0; i -= 1) {
      if (!capSwitches[i].el.isConnected) capSwitches.splice(i, 1);
    }
    capSwitches.push({ pid, kind, el: sw });
    sw.addEventListener('change', () => {
      providerCaps = { ...providerCaps, [pid]: { ...(providerCaps[pid] ?? {}), [kind]: sw.checked } };
      save(LS.providerCaps, providerCaps);
      logEvent('session', 'provider_cap_toggle', { provider: pid, cap: kind, on: sw.checked });
      syncCapSwitches(pid, kind, sw.checked);
    });
  }
  row.append(el('span', 'cap-name', name), el('span', 'cap-desc', desc), sw);
  return row;
}

/** One provider's config: key + model row + capability toggles inside a
 * collapsible drawer row (接入与服务). */
function providerSection(info) {
  const details = el('details', 'provider-config');
  details.dataset.id = info.id;
  const { summary, badge } = drawerSummary(info.id, info.label);
  paintBadge(badge, info.id);
  details.append(summary);

  // The picker only lists configured providers, so a key that appears or
  // disappears has to rebuild it — but only on the flip, not per keystroke.
  let configured = isConfigured(info.id);
  const refreshPicker = () => {
    const now = isConfigured(info.id);
    if (now !== configured) { configured = now; buildModelsPane(); }
  };

  const vaultMode = serverKeyMode();
  const keyNote = el('div', 'inline-error key-note');
  keyNote.hidden = true;
  const note = (msg, ok = false) => {
    keyNote.textContent = msg;
    keyNote.classList.toggle('ok-note', Boolean(ok));
    keyNote.hidden = !msg;
  };
  const { field: keyField, input: keyInput } = settingsField(
    'API 密钥',
    `key-${info.id}`,
    vaultMode ? {
      // Write-only vault field: never pre-filled, never readable back.
      type: 'password',
      hint: '密钥保存在你的账号里，保存后不再显示',
      placeholder: serverKeyFlags[info.id] ? '已保存——输入新密钥可替换' : '在这里粘贴密钥，回车保存',
      value: '',
    } : {
      type: 'password',
      hint: info.hasEnvKey ? '服务器已配密钥' : '',
      placeholder: info.hasEnvKey ? '可留空——使用服务器密钥' : '在这里粘贴密钥',
      value: apiKeys[info.id] ?? '',
      onInput: (v) => {
        if (v) apiKeys[info.id] = v;
        else delete apiKeys[info.id];
        saveKeys();
        paintBadge(badge, info.id);
        refreshPicker();
      },
    },
  );
  details.append(keyField);
  if (vaultMode) {
    const submitKey = async (value) => {
      const ok = await saveServerKey(info.id, value, note);
      if (ok) {
        keyInput.value = '';
        keyInput.placeholder = serverKeyFlags[info.id] ? '已保存——输入新密钥可替换' : '在这里粘贴密钥，回车保存';
        removeBtn.hidden = !serverKeyFlags[info.id];
        paintBadge(badge, info.id);
        refreshPicker();
      }
    };
    keyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && keyInput.value.trim()) { e.preventDefault(); submitKey(keyInput.value.trim()); }
    });
    keyInput.addEventListener('blur', () => { if (keyInput.value.trim()) submitKey(keyInput.value.trim()); });
    // Deletion is EXPLICIT — a stray empty blur must never wipe a saved key.
    const removeBtn = el('button', 'text-btn danger key-remove', '从账号删除此密钥');
    removeBtn.type = 'button';
    removeBtn.hidden = !serverKeyFlags[info.id];
    removeBtn.addEventListener('click', () => submitKey(''));
    details.append(removeBtn);
  }
  details.append(keyNote);

  const rates = ratesBlock(() => modelChoices[info.id] ?? info.defaultModel ?? '');

  details.append(modelRow(info.id, {
    defaultModel: info.defaultModel,
    getModel: () => modelChoices[info.id] ?? info.defaultModel ?? '',
    setModel: (m) => {
      if (m && m !== info.defaultModel) modelChoices[info.id] = m;
      else delete modelChoices[info.id];
      saveModels();
      rates.paint();
      if (isConfigured(info.id)) buildModelsPane(); // the card names the model
    },
    // Vault mode: a typed-but-unsaved key still works for the fetch; the
    // server falls back to the account vault, then env, when absent.
    modelsBody: () => ({ provider: info.id, key: (serverKeyMode() ? keyInput.value.trim() : apiKeys[info.id]) || undefined }),
  }));

  details.append(rates.node);
  details.append(capRow(info.id, 'thinking'));
  details.append(capRow(info.id, 'webSearch'));

  return details;
}

/** 参考评级 block that repaints from whatever model is currently chosen.
 * Same dots as the model cards, so 智能/速度/成本 lives in both panels. */
function ratesBlock(getModel) {
  const node = el('div', 'drawer-rates');
  const paint = () => {
    node.replaceChildren();
    const t = traitsFor(getModel());
    if (!t) {
      node.append(el('p', 'settings-note', '这个模型还没有参考评级。'));
      return;
    }
    node.append(el('span', 'drawer-rates-hd', '参考评级'));
    node.append(rateRow('智能', 'g', t.intel), rateRow('速度', 'p', t.speed), rateRow('成本', 'au', t.cost));
  };
  paint();
  return { node, paint };
}

/** The 自定义端点 (OpenAI-compatible) section. */
function customSection() {
  const details = el('details', 'provider-config');
  details.dataset.id = 'custom';
  const { summary, badge } = drawerSummary('custom', '自定义端点');
  paintBadge(badge, 'custom');
  details.append(summary);

  let configured = isConfigured('custom');
  const refreshPicker = () => {
    const now = isConfigured('custom');
    if (now !== configured) { configured = now; buildModelsPane(); }
  };

  const customVault = serverKeyMode();
  const fields = [
    ['baseURL', '接口地址（baseURL）', 'text', '如 https://api.example.com/v1'],
    // Vault mode stores the custom key per-account like every other provider.
    ...(customVault ? [] : [['key', 'API 密钥', 'password', '在这里粘贴密钥']]),
    ['label', '名称（可选）', 'text', '显示在调试信息里'],
  ];
  if (customVault) {
    const keyNote = el('div', 'inline-error key-note');
    keyNote.hidden = true;
    const note = (msg, ok = false) => {
      keyNote.textContent = msg;
      keyNote.classList.toggle('ok-note', Boolean(ok));
      keyNote.hidden = !msg;
    };
    const { field, input } = settingsField('API 密钥', 'custom-key', {
      type: 'password',
      hint: '密钥保存在你的账号里，保存后不再显示',
      placeholder: serverKeyFlags.custom ? '已保存——输入新密钥可替换' : '在这里粘贴密钥，回车保存',
      value: '',
    });
    const submitKey = async (value) => {
      const ok = await saveServerKey('custom', value, note);
      if (ok) {
        input.value = '';
        input.placeholder = serverKeyFlags.custom ? '已保存——输入新密钥可替换' : '在这里粘贴密钥，回车保存';
        paintBadge(badge, 'custom');
        refreshPicker();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) { e.preventDefault(); submitKey(input.value.trim()); }
    });
    input.addEventListener('blur', () => { if (input.value.trim()) submitKey(input.value.trim()); });
    details.append(field, keyNote);
  }
  for (const [prop, labelText, type, placeholder] of fields) {
    const { field } = settingsField(labelText, `custom-${prop}`, {
      type,
      placeholder,
      value: customCfg[prop] ?? '',
      onInput: (v) => {
        customCfg[prop] = v.trim();
        saveCustom();
        paintBadge(badge, 'custom');
        refreshPicker();
      },
    });
    details.append(field);
  }

  details.append(modelRow('custom', {
    defaultModel: '',
    getModel: () => customCfg.model ?? '',
    setModel: (m) => {
      customCfg.model = m;
      saveCustom();
      if (isConfigured('custom')) buildModelsPane();
    },
    modelsBody: () => ({
      provider: 'custom',
      key: customCfg.key || undefined,
      custom: { baseURL: customCfg.baseURL, model: customCfg.model || 'unknown' },
    }),
  }));

  return details;
}

// ------------------------------------------------------------ 外观 (theme)
// The head inline script resolved the theme pre-paint from the same key;
// here we own switching. 'system' follows prefers-color-scheme live.

const THEME_KEY = 'cst.theme';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function resolveTheme(choice) {
  return choice === 'light' || choice === 'dark' ? choice : (systemDark.matches ? 'dark' : 'light');
}

/** Apply + crossfade (DESIGN.md §6 register 2); fade skipped under reduced motion. */
function applyTheme(choice, { animate = true } = {}) {
  const root = document.documentElement;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (animate && !reduced) {
    root.classList.add('theme-fade');
    setTimeout(() => root.classList.remove('theme-fade'), 520);
  }
  root.dataset.theme = resolveTheme(choice);
}

systemDark.addEventListener('change', () => {
  const choice = localStorage.getItem(THEME_KEY);
  if (choice !== 'light' && choice !== 'dark') applyTheme('system');
});

/** 外观 select: 跟随系统 / 浅色 / 深色 (DESIGN.md §4 通用). */
function themeField() {
  const saved = localStorage.getItem(THEME_KEY);
  const current = saved === 'light' || saved === 'dark' ? saved : 'system';
  const field = el('div', 'settings-field');
  const label = el('label', 'settings-label', '外观');
  label.htmlFor = 'theme-select';
  const select = document.createElement('select');
  select.id = 'theme-select';
  select.className = 'settings-select';
  for (const [value, text] of [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    if (value === current) opt.selected = true;
    select.append(opt);
  }
  select.addEventListener('change', () => {
    localStorage.setItem(THEME_KEY, select.value);
    applyTheme(select.value);
    logEvent('session', 'theme_change', { choice: select.value });
  });
  field.append(label, select);
  return field;
}

/** 开发者模式 toggle: persists + replays the transcript so annotations (dis)appear. */
function devModeField() {
  const field = el('div', 'settings-field');
  const label = el('label', 'settings-label devmode-label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = 'devmode-toggle';
  box.checked = devMode;
  box.addEventListener('change', () => {
    logEvent('session', 'devmode_toggle', { on: box.checked });
    devMode = box.checked;
    save(LS.devmode, devMode);
    replayTranscript();
  });
  label.htmlFor = box.id;
  label.append(box, document.createTextNode('开发者模式（显示工作流节点与状态机信息）'));
  field.append(label);
  return field;
}

/** 教师档案 pane — optional, local-only (PRD §7.4 v1; field list DESIGN.md §4). */
function buildProfilePane(target) {
  const pane = target ?? $('#pane-profile');
  pane.replaceChildren();

  // 地区: two type-to-search inputs (native datalist) — the pilot targets
  // district precision (e.g. 广州市番禺区), so both levels are searchable.
  const provList = el('datalist', '');
  provList.id = 'province-options';
  const distList = el('datalist', '');
  distList.id = 'district-options';
  pane.append(provList, distList);

  const { field: provField, input: provInput } = settingsField('地区（省级，可输入搜索）', 'profile-province', {
    placeholder: '如 广东省 / 中国香港',
    value: profile.province ?? '',
    onInput: (v) => { profile.province = v.trim(); saveProfile(); fillDistricts(); },
  });
  provInput.setAttribute('list', 'province-options');
  pane.append(provField);

  const { field: regionField, input: distInput } = settingsField('市／区县（可输入搜索）', 'profile-region', {
    placeholder: '如 广州市番禺区',
    value: profile.region ?? '',
    onInput: (v) => { profile.region = v.trim(); saveProfile(); },
  });
  distInput.setAttribute('list', 'district-options');
  pane.append(regionField);

  const fillDistricts = () => {
    if (!REGIONS) return;
    distList.replaceChildren();
    const entries = REGIONS[profile.province] ?? [];
    for (const name of entries) {
      const o = el('option', '');
      o.value = name;
      distList.append(o);
    }
  };
  loadRegions().then((regions) => {
    provList.replaceChildren();
    for (const name of Object.keys(regions)) {
      const o = el('option', '');
      o.value = name;
      provList.append(o);
    }
    fillDistricts();
  });

  pane.append(selectField('年龄段（可选）', 'profile-agerange', AGE_RANGES, profile.ageRange ?? '', (v) => { profile.ageRange = v; saveProfile(); }));
  pane.append(selectField('教龄（总）', 'profile-teachyears', TEACH_YEARS, profile.teachYears ?? '', (v) => { profile.teachYears = v; saveProfile(); }));
  pane.append(selectField('本园年资', 'profile-tenure', TENURE_YEARS, profile.tenureYears ?? '', (v) => { profile.tenureYears = v; saveProfile(); }));
  pane.append(selectField('角色', 'profile-role', KG_ROLES, profile.role ?? '', (v) => { profile.role = v; saveProfile(); }));

  // 任教班级 — checkboxes, multiple allowed; ageBand mirrors a single choice
  // so the mock's light-touch 年段 interpolation keeps working.
  const bandsField = el('div', 'settings-field');
  bandsField.append(el('label', 'settings-label', '任教班级（可多选）'));
  const bandsRow = el('div', 'checkbox-row');
  const bands = Array.isArray(profile.classBands) ? profile.classBands : [];
  for (const band of CLASS_BANDS) {
    const lab = el('label', '');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = bands.includes(band);
    box.addEventListener('change', () => {
      const next = new Set(Array.isArray(profile.classBands) ? profile.classBands : []);
      if (box.checked) next.add(band); else next.delete(band);
      profile.classBands = CLASS_BANDS.filter((b) => next.has(b));
      profile.ageBand = profile.classBands.length === 1 ? profile.classBands[0] : '';
      saveProfile();
    });
    lab.append(box, document.createTextNode(band));
    bandsRow.append(lab);
  }
  bandsField.append(bandsRow);
  pane.append(bandsField);

  const { field: sizeField } = settingsField('班额', 'profile-classsize', {
    type: 'number',
    placeholder: '如 30',
    value: profile.classSize ?? '',
    onInput: (v) => { profile.classSize = v.trim(); saveProfile(); },
  });
  pane.append(sizeField);

  pane.append(selectField('回应风格', 'profile-style', RESPONSE_STYLES, profile.stylePref ?? '', (v) => { profile.stylePref = v; saveProfile(); }, {
    titles: STYLE_DIRECTIVES,
    describe: (v) => (v ? `会这样要求陪跑智能体：${STYLE_DIRECTIVES[v]}` : '选一个风格，陪跑智能体会按它回应你；下方会显示给模型的原话。'),
  }));

  // 自动更新课程名 (title-agent harness): default off; every N teacher prompts
  // a side-channel model call renames the course (human rename always wins).
  const at = { enabled: false, every: TITLE_INTERVAL_DEFAULT, ...(profile.autoTitle ?? {}) };
  const atField = el('div', 'settings-field');
  const atRow = el('div', 'checkbox-row');
  const atLab = el('label', '');
  const atBox = document.createElement('input');
  atBox.type = 'checkbox';
  atBox.checked = Boolean(at.enabled);
  atBox.addEventListener('change', () => {
    profile.autoTitle = { ...at, enabled: atBox.checked };
    at.enabled = atBox.checked;
    saveProfile();
  });
  atLab.append(atBox, document.createTextNode('自动更新课程名（AI 根据对话起名，手动改过名的课程不受影响）'));
  atRow.append(atLab);
  atField.append(el('label', 'settings-label', '课程名'), atRow);
  pane.append(atField);
  pane.append(selectField('每隔多少条你的消息更新一次', 'profile-autotitle-every',
    TITLE_INTERVALS.map(String), String(at.every ?? TITLE_INTERVAL_DEFAULT), (v) => {
      profile.autoTitle = { ...at, every: Number(v) || TITLE_INTERVAL_DEFAULT };
      at.every = profile.autoTitle.every;
      saveProfile();
    }));

  pane.append(el('p', 'settings-note', '档案只保存在这台设备，作为只读背景提供给陪跑智能体（不会写入课程状态）。将来有账号后，这一页会搬进「用户中心」。'));
}

/** 界面与体验 pane — 外观, 回合进度显示, 开发者模式 (relocated from the old 通用). */
function buildUiPane() {
  const pane = $('#pane-ui');
  pane.replaceChildren();

  pane.append(themeField());

  // 回合进度显示: what the teacher sees while a reply is generating. Persisted
  // per browser (localStorage), applies from the next turn.
  const metaField = el('div', 'settings-field');
  metaField.append(el('label', 'settings-label', '回合进度显示'));
  const metaDefs = [
    ['timer', '等待计时器（生成中显示已等待时间）'],
    ['stats', '生成统计（首字耗时、字数、全程用时）'],
    ['thinking', '显示模型思考过程（模型支持时流式展开）'],
    ['cache', '提示缓存命中（供应商返回缓存数据时显示）'],
    ['guards', '超时保护提示（思考超时改直接作答、断流、停止）'],
  ];
  for (const [key, text] of metaDefs) {
    const row = el('label', 'settings-check');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = turnMetaOn(key);
    cb.addEventListener('change', () => {
      turnMeta = { ...turnMeta, [key]: cb.checked };
      save(LS.turnMeta, turnMeta);
      logEvent('session', 'turn_meta_toggle', { key, on: cb.checked });
    });
    row.append(cb, ` ${text}`);
    metaField.append(row);
  }
  pane.append(metaField);

  pane.append(devModeField());
}

// ---- 接入与服务 developer drawer (beside the modal ≥1100px, sheet below) ----

function setDevPanel(open) {
  const panel = $('#dev-panel');
  if (!panel) return;
  panel.hidden = !open;
  settingsDrawer.classList.toggle('dev-open', open);
  const st = $('#devopen-state');
  if (st) st.textContent = open ? '已打开 · 收起' : '打开 →';
}

/** The provider a family card stands for right now: the remembered 线路 when
 * it is still configured, else the first channel the teacher DID configure. */
function familyTarget(fam) {
  const remembered = channelChoice[fam];
  if (remembered && isConfigured(remembered)) return remembered;
  const ids = PROVIDER_GROUPS[fam].channels.map(([id]) => id);
  return ids.find(isConfigured) ?? ids[0];
}

/** The provider a model card stands for right now. */
function cardTarget(card) {
  return card.family ? familyTarget(card.family) : card.provider;
}

/** Cards the 模型与服务 picker shows: exactly what the teacher configured, not
 * a fixed shortlist. Channels of one family collapse into a single card (the
 * 线路 select below picks which); 演示模式 is appended separately. */
function pickerCards() {
  const cards = [];
  const seenFamily = new Set();
  for (const info of providerInfos) {
    if (!isConfigured(info.id)) continue;
    const fam = groupOf(info.id);
    if (fam) {
      if (seenFamily.has(fam)) continue;
      seenFamily.add(fam);
      cards.push({ family: fam });
    } else {
      cards.push({ provider: info.id });
    }
  }
  if (isConfigured('custom')) cards.push({ provider: 'custom' });
  return cards;
}

/** 5-dot scale row for a model card. */
function rateRow(labelText, tone, filled) {
  const row = el('div', 'mcard-rate');
  row.append(el('span', 'mcard-rl', labelText));
  const dots = el('span', `mcard-dots ${tone}`);
  // The dots are decorative <i> marks; the value lives on the container so a
  // screen reader hears 「智能 4 / 5」 instead of nothing.
  dots.setAttribute('role', 'img');
  dots.setAttribute('aria-label', `${labelText} ${filled} / 5`);
  for (let i = 0; i < 5; i += 1) {
    const d = document.createElement('i');
    if (i < filled) d.className = 'f';
    dots.append(d);
  }
  row.append(dots);
  return row;
}

/** 模型与服务 pane — teacher-facing model cards + the 接入与服务 drawer handle.
 * Rebuilt whole on every provider change (cheap, keeps sel state honest). */
function buildModelsPane() {
  const pane = $('#pane-models');
  pane.replaceChildren();

  const head = el('div', 'pane-head');
  head.append(el('h3', 'pane-head-title', '模型与服务'));
  head.append(el('p', 'pane-head-sub', '选一个陪你备课的模型就好，随时可换。密钥等技术设置收在下方「接入与服务」里，日常用不到。'));
  pane.append(head);

  const secHd = el('div', 'sec-hd');
  const mark = el('span', 'sec-mark');
  mark.setAttribute('aria-hidden', 'true');
  secHd.append(mark, el('h4', 'sec-title', '使用哪个模型'), el('span', 'sec-hint', '参考评级'));
  pane.append(secHd);

  const grid = el('div', 'mgrid');
  const selectCard = (target) => {
    logEvent('session', 'provider_change', { from: provider, to: target, via: 'model-card' });
    provider = target;
    save(LS.provider, provider);
    syncOpenSection();
    buildModelsPane();
  };

  /** Shared card shell: brand mark + name + optional body, one pick button. */
  const shell = (target, sel, markId, title, subtitle) => {
    const box = el('div', `mcard${sel ? ' sel' : ''}`);
    const btn = el('button', 'mcard-pick');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(sel));
    if (sel) {
      const chk = el('span', 'mcard-chk');
      chk.setAttribute('aria-hidden', 'true');
      box.append(chk);
    }
    const row1 = el('div', 'mcard-row1');
    row1.append(providerMark(markId), el('span', 'mcard-name', title), el('span', 'mcard-prov', subtitle));
    btn.append(row1);
    btn.addEventListener('click', () => selectCard(target));
    box.append(btn);
    grid.append(box);
    return btn;
  };

  const cards = pickerCards();
  for (const card of cards) {
    // A selected family card MUST target the active provider, not the family's
    // remembered 线路 — otherwise the card names one channel's model, writes its
    // 深度思考/联网搜索 toggles to that channel's key, and contradicts the 线路
    // select below, all while the request uses a different channel. cardTarget
    // (the remembered/first-configured channel) is only for switching TO an
    // unselected family.
    const target = card.family && groupOf(provider) === card.family ? provider : cardTarget(card);
    const info = providerInfo(target);
    const model = target === 'custom'
      ? (customCfg.model || '')
      : (modelChoices[target] ?? info?.defaultModel ?? '');
    const provName = target === 'custom'
      ? (customCfg.label || '自定义端点')
      : (DRAWER_META[target]?.name ?? info?.label ?? target);
    const sel = card.family ? groupOf(provider) === card.family : provider === target;
    // The model id is the headline when we know it; otherwise the service is.
    const btn = shell(target, sel, target, model || provName, model ? provName : '未指定模型');
    const t = traitsFor(model);
    if (t) btn.append(rateRow('智能', 'g', t.intel), rateRow('速度', 'p', t.speed), rateRow('成本', 'au', t.cost));
    else btn.append(el('span', 'mcard-off-note', '这个模型还没有参考评级。'));
    // Same switches as the drawer row — either panel can flip them.
    const caps = el('div', 'mcard-caps');
    caps.append(capRow(target, 'thinking'), capRow(target, 'webSearch'));
    btn.parentElement.append(caps);
  }

  // 演示模式 card — mock must stay reachable without keys or network.
  {
    const btn = shell('mock', provider === 'mock', 'mock', '演示模式', '无需密钥');
    btn.parentElement.classList.add('mock');
    btn.append(el('span', 'mcard-desc', '不联网、不填密钥，用内置脚本体验完整流程。'));
  }
  pane.append(grid);

  if (!cards.length) {
    pane.append(el('p', 'settings-note',
      '还没有配置任何服务。在下方「接入与服务」里填好一个密钥，这里就会出现对应的模型卡。'));
  }

  pane.append(el('p', 'mcard-legend',
    '这里只列出你已配置的服务。评级是粗略档位，满 5 点：智能越高越会想，速度越高回得越快，成本点越多越省钱。仅供参考，随版本更新。'));

  // 当前使用: state is never hidden — the active provider can be one the
  // teacher never configured (a leftover choice, a key that was cleared), and
  // then no card represents it. Say so instead of showing nothing.
  if (provider !== 'mock') {
    const info = providerInfo(provider);
    const effModel = provider === 'custom'
      ? (customCfg.model || '')
      : (modelChoices[provider] ?? info?.defaultModel ?? '');
    const onACard = cards.some((c) => (c.family ? groupOf(provider) === c.family : provider === c.provider));
    if (!onACard) {
      const name = provider === 'custom'
        ? (customCfg.label || '自定义端点')
        : (DRAWER_META[provider]?.name ?? info?.label ?? provider);
      pane.append(el('p', 'settings-note model-current',
        `当前使用：${name}${effModel ? ` · ${effModel}` : ''}（在下方「接入与服务」里调整）`));
    }
  }

  // 线路: mainland/international switch for the selected family (existing
  // machinery — the family card follows whatever is chosen here).
  const g = groupOf(provider);
  if (g) {
    const channelField = el('div', 'settings-field channel-field');
    const chLabel = el('label', 'settings-label', '线路');
    const chSelect = el('select', 'settings-select');
    chSelect.id = 'channel-select';
    chLabel.htmlFor = chSelect.id;
    // Only 线路 the teacher configured (plus the active one, so the select
    // never silently drops the current choice).
    for (const [id, l] of PROVIDER_GROUPS[g].channels) {
      if (!isConfigured(id) && id !== provider) continue;
      const o = el('option', '', l);
      o.value = id;
      chSelect.append(o);
    }
    chSelect.value = provider;
    chSelect.addEventListener('change', () => {
      logEvent('session', 'provider_change', { from: provider, to: chSelect.value, channel: true });
      provider = chSelect.value;
      channelChoice[g] = provider;
      save(LS.channels, channelChoice);
      save(LS.provider, provider);
      syncOpenSection();
      buildModelsPane();
    });
    channelField.append(chLabel, chSelect);
    pane.append(channelField);
  }

  // 接入与服务 handle: the calm doorway to the developer drawer.
  const dev = el('button', 'devopen');
  dev.type = 'button';
  dev.setAttribute('aria-controls', 'dev-panel');
  const state = el('span', 'devopen-state', $('#dev-panel')?.hidden === false ? '已打开 · 收起' : '打开 →');
  state.id = 'devopen-state';
  dev.append(
    el('span', 'devopen-name', '接入与服务'),
    el('span', 'devtag', '开发者'),
    el('span', 'devopen-note', '配置密钥与端点，日常使用无需改动'),
    state,
  );
  dev.addEventListener('click', () => setDevPanel($('#dev-panel')?.hidden !== false));
  pane.append(dev);
}

/** 高级 corner of 模型服务 — the static-hosting-only server address. */
function buildProviderAdvanced() {
  const host = $('#provider-advanced');
  host.replaceChildren();
  const details = el('details', 'provider-config');
  details.dataset.id = 'advanced';
  details.append(el('summary', '', '高级：服务器地址'));
  const { field: apiField } = settingsField(
    '服务器地址',
    'api-base',
    {
      type: 'text',
      hint: backendOnline ? '当前后端在线（同源直连）' : '',
      placeholder: '如 https://xxxx.cn-shenzhen.fcapp.run',
      value: apiBase,
      onInput: (v) => { apiBase = v.replace(/\/+$/, ''); save(LS.apiBase, apiBase); },
    },
  );
  details.append(apiField);
  details.append(el('p', 'settings-note', '只有把界面放在静态托管（如 GitHub Pages）上时才需要填——告诉页面把请求发到哪个远程代理。通过隧道访问或在本机运行时请留空，页面会直接连同源后端。'));
  host.append(details);
}

/** Rebuild all settings panes; open the selected provider's drawer row.
 * (Name/signature stable — called from boot, login and initProviders.) */
function buildProviderSections() {
  providerBox.replaceChildren();
  // 国内/国际 grouping (接入与服务 drawer): DRAWER_META declaration order,
  // unknown future providers fall to the end of 国际服务.
  const order = Object.keys(DRAWER_META);
  const byMeta = (a, b) => {
    const ia = order.indexOf(a.id); const ib = order.indexOf(b.id);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
  };
  const cn = providerInfos.filter((p) => DRAWER_META[p.id]?.region === 'cn').sort(byMeta);
  const intl = providerInfos.filter((p) => DRAWER_META[p.id]?.region !== 'cn').sort(byMeta);
  if (cn.length) {
    providerBox.append(el('div', 'dev-group', '国内服务'));
    for (const info of cn) providerBox.append(providerSection(info));
  }
  providerBox.append(el('div', 'dev-group', '国际服务'));
  for (const info of intl) providerBox.append(providerSection(info));
  providerBox.append(customSection());
  syncOpenSection();
  buildProviderAdvanced();
  buildUiPane();
  buildModelsPane();
  // 用户中心 is the ONE home for everything now — the profile pane is always
  // real (signed-in it syncs to the account via saveProfile; local otherwise).
  buildProfilePane();
}

function syncOpenSection() {
  for (const d of providerBox.querySelectorAll('.provider-config')) {
    if (d.dataset.id === provider) d.open = true;
  }
}

async function initProviders() {
  backendOnline = false;
  try {
    const res = await fetch(apiUrl('/api/health'));
    if (res.ok) {
      const health = await res.json();
      if (Array.isArray(health.providers) && health.providers.every((p) => p && typeof p === 'object')) {
        providerInfos = health.providers;
      }
      persistent = Boolean(health.persistence);
      authRequired = Boolean(health.auth);
      backendChannel = health.channel === 'public' ? 'public' : 'dev';
      keyVaultOn = Boolean(health.key_vault);
      backendOnline = true;
    }
  } catch { /* offline from the API is fine — 演示模式 still works client-side */ }
  buildProviderSections();
}

// -------------------------------------------------- persistence tier (server)

/** Turn stored message rows (teacher/agent) into the rich transcript shape. */
function messagesToTranscript(rows) {
  const out = [];
  // Mirrors the engine's evidence gate: a 备课 round_complete (no child
  // evidence ingested yet) never showed the 等待回传 note live, so the
  // restored transcript must not show it either.
  let evidenceSeen = false;
  for (const m of rows) {
    if (m.role === 'agent') {
      const tc = m.turn_contract || { reply_markdown: m.content };
      if ((tc.state_delta?.children_evidence || []).length) evidenceSeen = true;
      out.push({
        role: 'assistant',
        content: m.content,
        ev: {
          turn: tc,
          gate_report: { ok: true, violations: [] },
          state: { awaiting_feedback: Boolean(tc.round_complete) && evidenceSeen },
          provider: m.provider ?? null,
          providerLabel: m.provider_label ?? null,
          stageName: m.stage_name ?? null,
        },
      });
    } else {
      out.push({ role: 'user', content: m.content });
    }
  }
  return out;
}

async function serverListCourses() {
  const res = await fetch(apiUrl('/api/courses'));
  if (!res.ok) throw new Error(`courses ${res.status}`);
  return (await res.json()).courses || [];
}
async function serverGetCourse(id) {
  const res = await fetch(apiUrl(`/api/courses/${id}`));
  if (!res.ok) return null;
  return (await res.json()).course ?? null;
}
async function serverGetMessages(id) {
  const res = await fetch(apiUrl(`/api/courses/${id}/messages`));
  if (!res.ok) return [];
  return (await res.json()).messages || [];
}
async function serverCreateCourse(title) {
  const res = await fetch(apiUrl('/api/courses'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.message || `创建课程失败 (${res.status})`);
  return data.course;
}
async function serverDeleteCourse(id) {
  const res = await fetch(apiUrl(`/api/courses/${id}`), { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.message || `删除失败 (${res.status})`);
  return true;
}

/** Pull a course's state + full history from the server into the live view. */
async function loadCourseFromServer(id) {
  const [course, msgs] = await Promise.all([serverGetCourse(id), serverGetMessages(id)]);
  if (course?.course_state) courseState = course.course_state;
  transcript = messagesToTranscript(msgs || []);
  lastEvent = null;
  lastTurnHadQuestion = Boolean(transcript[transcript.length - 1]?.ev?.turn?.question);
  save(LS.state, courseState);      // localStorage stays a cache of the active course
  save(LS.transcript, transcript);
}

/** Boot the persistence tier: choose (or create) the active course, load it. */
async function initCourseFromServer() {
  try {
    coursesCache = await serverListCourses();
    let target = coursesCache.find((c) => c.id === activeCourseId) || coursesCache[0];
    if (!target) {
      target = await serverCreateCourse();
      coursesCache = [target];
    }
    activeCourseId = target.id;
    save(LS.courseId, activeCourseId);
    await loadCourseFromServer(activeCourseId);
    logEvent('session', 'course_loaded', { course_id: activeCourseId, count: coursesCache.length });
  } catch (err) {
    // Persistence unusable — fall back to the stateless/localStorage path.
    persistent = false;
    logEvent('error', 'persistence_init_failed', { message: err?.message ?? String(err) });
  }
}

/** Switch the active course (history rail). Loads its history from the server. */
async function switchCourse(id) {
  if (id === activeCourseId) { if (!railPinned) closeRail(); return; }
  logEvent('session', 'switch_course', { from: activeCourseId, to: id });
  activeCourseId = id;
  save(LS.courseId, id);
  pendingMessage = null;
  document.body.classList.remove('bp-sheet');
  await loadCourseFromServer(id);
  replayTranscript();
  refreshBlueprintPanel();
  updateHeader();
  updateSkipLink();
  refreshDebug();
  renderRail();
  if (!railPinned) closeRail();
  scrollToEnd();
}

// ---------------------------------------------- 蓝图 workspace panel (§5b)
// The living mother plan: renders course_state.course_plan_blueprint — every
// pixel (numbering, collapse, map geometry) reconstructed client-side. Chat
// cards remain historical snapshots; this panel is always the latest version.

let bpTab = load(LS.bpTab, 'list');
let bpHidden = load(LS.bpHidden, false);
let bpRenderKey = ''; // courseId:version:tab — unchanged key skips the re-render, keeping fold/scroll state
let wbTab = load(LS.wbTab, 'bp'); // 工作台 top-level tab: 'bp' | 'cards'
let wbCardsRenderKey = ''; // course:sig — unchanged key keeps the queue's DOM (focus, scroll)

// -- living question-card answer set (§5c): ONE set per course (only the
// newest agent turn collects answers), shared by the chat carousel and the
// 工作台 queue. Survives reloads via localStorage.
let qcardSets = load(LS.qcards, {});
const cardViewSyncs = new Set(); // live renderers to repaint after a cross-view edit
function cardSetSig(questions) { return (questions || []).map((q) => q.text).join(''); }
function activeCardSet() { return qcardSets[commentCourseKey()] ?? null; }
function setActiveCardSet(set) {
  const key = commentCourseKey();
  if (set) qcardSets = { ...qcardSets, [key]: set };
  else { qcardSets = { ...qcardSets }; delete qcardSets[key]; }
  save(LS.qcards, qcardSets);
  wbCardsRenderKey = ''; // structure changed → queue must re-render
  cardViewSyncs.clear();
}
function onCardChange() {
  save(LS.qcards, qcardSets);
  for (const fn of cardViewSyncs) { try { fn(); } catch { /* view left the DOM */ } }
  refreshStageTray();
  refreshWorkbenchBadges();
  scheduleWorkbenchMirror();
}

/** Snapshot of the teacher's unsent 工作台 state — 批注 + living card
 * answers. Rides the session-log export and mirrors to the server (admin
 * exports must show work-in-progress, not only sent messages). */
function workbenchSnapshot() {
  const set = activeCardSet();
  return {
    blueprint_comments: Object.values(commentsForCourse()),
    question_cards: set ? {
      questions: set.questions.map((q) => ({ text: q.text, ...(q.why ? { why: q.why } : {}) })),
      answers: set.answers.map((a) => ({ value: a.value, skipped: Boolean(a.skipped), locked: Boolean(a.locked) })),
    } : null,
  };
}

// Debounced server mirror (persistence tier only): scratch state, fire-and-
// forget — offline failures are fine, localStorage stays the local truth.
let wbMirrorTimer = null;
function scheduleWorkbenchMirror() {
  if (!persistenceActive() || !activeCourseId) return;
  clearTimeout(wbMirrorTimer);
  wbMirrorTimer = setTimeout(async () => {
    try {
      await fetch(apiUrl(`/api/courses/${activeCourseId}/workbench`), {
        method: 'PUT', headers: { 'content-type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(workbenchSnapshot()),
      });
    } catch { /* offline: next edit reschedules */ }
  }, 800);
}

/** Reveal the 工作台 (chat chip / FAB click-through). Below the desktop
 * breakpoint it opens as the full-height sheet. */
function openBlueprintPanel(tab) {
  bpHidden = false;
  save(LS.bpHidden, false);
  if (tab === 'bp' || tab === 'cards') { wbTab = tab; save(LS.wbTab, wbTab); }
  if (!window.matchMedia('(min-width: 1100px)').matches) document.body.classList.add('bp-sheet');
  refreshBlueprintPanel();
}

/** Pending counts for badges: cards still needing the teacher (unlocked) and
 * blueprint nodes not yet confirmed. */
function workbenchPending() {
  const set = activeCardSet();
  const cards = set ? set.answers.filter((a) => !a.locked).length : 0;
  const bp = courseState?.course_plan_blueprint;
  const bpPending = bp?.modules?.length
    ? countUnconfirmed(normalizeBlueprint({ modules: bp.modules }).modules)
    : 0;
  return { cards, bpPending };
}
function refreshWorkbenchBadges() {
  const { cards, bpPending } = workbenchPending();
  const setBadge = (id, n) => {
    const b = $(id);
    if (!b) return;
    b.hidden = n === 0;
    b.textContent = String(n);
  };
  setBadge('#wb-cards-badge', cards);
  setBadge('#wb-bp-badge', bpPending);
  setBadge('#bp-fab-badge', cards + bpPending);
}

function refreshBlueprintPanel() {
  const panel = $('#bp-panel');
  const fab = $('#btn-blueprint');
  if (!panel || !fab) return;
  const bp = courseState?.course_plan_blueprint;
  const hasBp = Boolean(bp?.modules?.length);
  const cardSet = activeCardSet();
  const hasCards = Boolean(cardSet?.questions?.length);
  const has = hasBp || hasCards;
  document.body.classList.toggle('has-bp', has && !bpHidden);
  fab.hidden = !has;
  panel.hidden = !has || bpHidden;
  refreshWorkbenchBadges();
  refreshStageTray();
  if (!has) return;
  // Top-level 工作台 tabs: fall back to whichever side has content.
  if (wbTab === 'bp' && !hasBp) wbTab = 'cards';
  if (wbTab === 'cards' && !hasCards && hasBp) wbTab = 'bp';
  $('#wb-tab-bp')?.classList.toggle('active', wbTab === 'bp');
  $('#wb-tab-cards')?.classList.toggle('active', wbTab === 'cards');
  $('#bp-head-controls').hidden = wbTab !== 'bp';
  $('#bp-panel-body').hidden = wbTab !== 'bp';
  $('#wb-cards-body').hidden = wbTab !== 'cards';

  // 问题卡 queue — same living answers as the chat carousel, stacked list.
  if (wbTab === 'cards') {
    const cardsBody = $('#wb-cards-body');
    const cardsKey = `${commentCourseKey()}:${cardSet ? cardSet.sig : 'none'}`;
    if (cardsKey !== wbCardsRenderKey) {
      wbCardsRenderKey = cardsKey;
      if (hasCards) {
        cardsBody.replaceChildren(renderQuestionCards(cardSet.questions, {
          variant: 'queue',
          answers: cardSet.answers,
          onChange: onCardChange,
          registerView: (fn) => cardViewSyncs.add(fn),
        }));
      } else {
        cardsBody.replaceChildren(el('div', 'wb-empty', '这一轮没有需要回答的问题卡。'));
      }
    }
  }

  if (!hasBp) {
    $('#bp-panel-body').replaceChildren(el('div', 'wb-empty', '蓝图还没生成——和我聊聊你的主题，我先给你一版。'));
    bpRenderKey = '';
    return;
  }
  // 版本 pill: pure engine counter — v0.1, v0.2, v0.3… one step per revision
  // (absorb / ✓确认 / 批注 delta). The model's version string is advisory
  // only; display numbering is engine-owned (Herman 2026-07-21, ADR-0003).
  $('#bp-panel-version').textContent = `v0.${bp.version}`;
  const numbered = numberBlueprint(normalizeBlueprint({ modules: bp.modules }).modules);
  const desktopMap = window.matchMedia('(min-width: 880px)').matches;
  $('#bp-tab-map').hidden = !desktopMap;
  if (bpTab === 'map' && !desktopMap) bpTab = 'list';
  $('#bp-tab-list').classList.toggle('active', bpTab === 'list');
  $('#bp-tab-map').classList.toggle('active', bpTab === 'map');
  const key = `${courseState?.course_id}:${bp.version}:${bpTab}:${desktopMap}`;
  if (key === bpRenderKey) return; // same plan, same view → keep the teacher's fold/scroll state
  bpRenderKey = key;
  const body = $('#bp-panel-body');
  pruneOrphanComments(numbered);
  const opts = {
    onConfirm: confirmNode,
    posKey: courseState?.course_id,
    comments: Object.fromEntries(Object.entries(commentsForCourse()).map(([id, c]) => [id, c.text])),
    onCommentChange: setNodeComment,
  };
  body.replaceChildren(bpTab === 'map' ? renderBlueprintMapView(numbered, opts) : renderBlueprintList(numbered, opts));
  applyBpFilter();
}

// -- per-node 批注 (spec 2026-07-20): unsent comments live locally per course;
// they STAGE into the composer tray (§5c) and ride the next composer send as
// one packaged section the model answers with blueprint_delta refinements.
let bpComments = load(LS.bpComments, {});
function commentCourseKey() { return activeCourseId || courseState?.course_id || 'local'; }
function commentsForCourse() { return bpComments[commentCourseKey()] ?? {}; }
function setNodeComment(node, text) {
  const key = commentCourseKey();
  const bucket = { ...(bpComments[key] ?? {}) };
  if (String(text ?? '').trim()) bucket[node.id] = { id: node.id, number: node.number, title: node.title, text };
  else delete bucket[node.id];
  bpComments[key] = bucket;
  save(LS.bpComments, bpComments);
  refreshStageTray();
  scheduleWorkbenchMirror();
}
/** A node removed by a delta takes its unsent comment with it — an invisible
 * comment the bar still counts would be a lie the teacher can't act on. */
function pruneOrphanComments(numbered) {
  const known = new Set();
  const walk = (n) => { known.add(n.id); n.children.forEach(walk); };
  (numbered || []).forEach(walk);
  const key = commentCourseKey();
  const bucket = bpComments[key];
  if (!bucket) return;
  const kept = Object.fromEntries(Object.entries(bucket).filter(([id]) => known.has(id)));
  if (Object.keys(kept).length !== Object.keys(bucket).length) {
    bpComments[key] = kept;
    save(LS.bpComments, bpComments);
  }
}

// ---------------------------------------- staging tray + the only mouth (§5c)

/** Everything currently staged for the next composer send. */
function stagedPayload() {
  const set = activeCardSet();
  const lockedCount = set ? set.answers.filter((a) => a.locked).length : 0;
  const comments = Object.values(commentsForCourse());
  return { set, lockedCount, comments, total: lockedCount + comments.length };
}

function refreshStageTray() {
  const tray = $('#stage-tray');
  if (!tray) return;
  const { lockedCount, comments, total } = stagedPayload();
  tray.hidden = total === 0;
  sendBtn.classList.toggle('hold-send', total > 0);
  sendBtn.title = total > 0 ? '按住 1.2 秒发送（含待发内容）' : '发送';
  sendBtn.setAttribute('aria-label', sendBtn.title);
  if (total === 0) { tray.replaceChildren(); return; }
  tray.replaceChildren();
  tray.append(el('span', 'stage-tray-label', '待发'));
  if (lockedCount) {
    const chip = el('button', 'stage-chip', `${lockedCount} 张答卡`);
    chip.type = 'button';
    chip.title = '打开工作台查看已锁定的回答';
    chip.addEventListener('click', () => openBlueprintPanel('cards'));
    tray.append(chip);
  }
  if (comments.length) {
    const chip = el('button', 'stage-chip', `${comments.length} 条批注`);
    chip.type = 'button';
    chip.title = '打开工作台查看批注';
    chip.addEventListener('click', () => openBlueprintPanel('bp'));
    tray.append(chip);
  }
  tray.append(el('span', 'stage-tray-hint', '按住发送键一起发出'));
}

/** The composer send: packages staged card answers + 批注 + typed text into
 * ONE teacher message (§5c), consumes the staged sources, and hands off to
 * send(). Plain sends (nothing staged) pass straight through. */
function composerSend() {
  if (busy) return;
  const typed = inputEl.value;
  const { set, lockedCount, comments } = stagedPayload();
  const packed = packStagedMessage({
    cards: lockedCount ? set : null,
    comments,
    text: typed,
  });
  if (!packed) return;
  inputEl.value = '';
  autogrow();
  if (lockedCount || comments.length) {
    logEvent('user_input', 'staged_send', {
      locked_cards: lockedCount,
      comments: comments.length,
      node_ids: comments.map((r) => r.id),
      typed: Boolean(typed.trim()),
    });
  }
  if (lockedCount) {
    setActiveCardSet(null); // consumed — the batch now lives in the transcript
    for (const stale of messagesEl.querySelectorAll('.qcards:not(.submitted)')) freezeQuestionCards(stale);
  }
  if (comments.length) {
    bpComments = { ...bpComments, [commentCourseKey()]: {} };
    save(LS.bpComments, bpComments);
    bpRenderKey = ''; // re-render clears the 已批注 button states
  }
  refreshBlueprintPanel();
  // Mobile sheet: sending hands the floor back to the chat.
  document.body.classList.remove('bp-sheet');
  send(packed);
}

// Hold-to-send (§5c): with staged items the send button becomes a launch
// button — hold 1.2s, release early cancels. Keyboard: hold Enter (keydown
// starts, keyup cancels). Plain sends keep the ordinary single click.
const HOLD_MS = 1200;
let holdTimer = null;
let holdFired = false;
function holdStart() {
  if (busy || holdTimer) return;
  holdFired = false; // a new hold always owns its own completion click
  document.documentElement.style.setProperty('--hold-ms', `${HOLD_MS}ms`);
  sendBtn.classList.add('holding');
  holdTimer = setTimeout(() => {
    holdTimer = null;
    holdFired = true;
    sendBtn.classList.remove('holding');
    composerSend();
  }, HOLD_MS);
}
function holdCancel() {
  if (!holdTimer) return;
  clearTimeout(holdTimer);
  holdTimer = null;
  sendBtn.classList.remove('holding');
}

// -- status filter + bulk confirm (Herman: MS-Word-comments ergonomics) --
let bpFilter = null; // null = all, else a status key
function applyBpFilter() {
  const body = $('#bp-panel-body');
  if (!body) return;
  for (const rowEl of body.querySelectorAll('[data-status]')) {
    const show = !bpFilter || rowEl.dataset.status === bpFilter
      || Boolean(rowEl.querySelector(`[data-status="${bpFilter}"]`)); // keep branches containing matches
    rowEl.classList.toggle('bp-filtered-out', !show);
    if (bpFilter && rowEl.tagName === 'DETAILS' && show) rowEl.open = true; // reveal matches
  }
  for (const pill of document.querySelectorAll('.bp-filter-pill')) {
    pill.classList.toggle('active', pill.dataset.filter === String(bpFilter));
  }
  const bulk = $('#bp-bulk-confirm');
  if (bulk) {
    const visible = [...(body?.querySelectorAll('[data-status]:not(.bp-filtered-out)') ?? [])]
      .filter((e) => e.dataset.status !== 'confirmed').length;
    bulk.hidden = visible === 0;
    bulk.textContent = `✓确认可见 ${visible} 项`;
  }
}
async function bulkConfirmVisible() {
  const body = $('#bp-panel-body');
  const ids = [...(body?.querySelectorAll('.bp-list-view [data-status]:not(.bp-filtered-out)') ?? [])]
    .filter((e) => e.dataset.status !== 'confirmed')
    .map((e) => e.querySelector('.bp-confirm-btn'))
    .filter(Boolean);
  // Walk via the engine event per node — same custody as single clicks.
  const nodeIds = [...(body?.querySelectorAll('.bp-list-view [data-status]:not(.bp-filtered-out)') ?? [])]
    .filter((e) => e.dataset.status !== 'confirmed' && e.querySelector(':scope > .bp-leaf-line .bp-confirm-btn, :scope > summary .bp-confirm-btn'));
  void ids;
  for (const el2 of nodeIds) {
    const id = findNodeIdForRow(el2);
    if (id) await confirmNode(id);
  }
}
// Rows don't carry ids in the DOM yet — derive from the rendered number prefix.
function findNodeIdForRow(rowEl) {
  const num = rowEl.querySelector(':scope > .bp-leaf-line .bp-number, :scope > summary .bp-number')?.textContent;
  if (!num) return null;
  const bp = courseState?.course_plan_blueprint;
  if (!bp) return null;
  const numbered = numberBlueprint(normalizeBlueprint({ modules: bp.modules }).modules);
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.number === num) return n.id;
      const hit = walk(n.children);
      if (hit) return hit;
    }
    return null;
  };
  return walk(numbered);
}

/** Teacher ✓确认: the engine escalates locally (single source of truth), the
 * server mirrors it for persistent courses so history/exports agree. */
async function confirmNode(nodeId) {
  const r = confirmBlueprintNode(courseState, nodeId);
  if (!r.confirmed) return;
  courseState = r.state;
  save(LS.state, courseState);
  bpRenderKey = ''; // force the panel to re-render the new version
  refreshBlueprintPanel();
  logEvent('workflow', 'blueprint_confirm', { node_id: nodeId, version: courseState.course_plan_blueprint?.version });
  if (persistenceActive() && activeCourseId) {
    try {
      await fetch(apiUrl(`/api/courses/${activeCourseId}/blueprint/confirm`), {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ node_id: nodeId }),
      });
    } catch { /* offline: local state already holds the confirmation */ }
  }
}

function wireBlueprintPanel() {
  const panel = $('#bp-panel');
  if (!panel) return;
  // Panel sits under the sticky header — measure once (font/theme safe enough).
  const header = document.querySelector('.app-header');
  if (header) document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
  const setTab = (tab) => { bpTab = tab; save(LS.bpTab, tab); bpRenderKey = ''; refreshBlueprintPanel(); };
  for (const pill of document.querySelectorAll('.bp-filter-pill')) {
    pill.addEventListener('click', () => {
      bpFilter = bpFilter === pill.dataset.filter ? null : pill.dataset.filter;
      applyBpFilter();
    });
  }
  $('#bp-bulk-confirm')?.addEventListener('click', bulkConfirmVisible);
  $('#bp-tab-list').addEventListener('click', () => setTab('list'));
  $('#bp-tab-map').addEventListener('click', () => setTab('map'));
  // 工作台 top-level tabs (§5b): 蓝图 | 问题卡.
  const setWbTab = (tab) => { wbTab = tab; save(LS.wbTab, tab); refreshBlueprintPanel(); };
  $('#wb-tab-bp')?.addEventListener('click', () => setWbTab('bp'));
  $('#wb-tab-cards')?.addEventListener('click', () => setWbTab('cards'));
  // 图例 + 制作 modals (small paper cards; Esc / scrim / ✕ dismiss).
  const wireMini = (openBtnId, modalId) => {
    const modal = $(modalId);
    if (!modal) return;
    $(openBtnId)?.addEventListener('click', () => { modal.hidden = false; });
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('[data-close-mini]')) modal.hidden = true;
    });
  };
  wireMini('#bp-legend-btn', '#legend-modal');
  wireMini('#btn-craft', '#craft-modal');
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const m of document.querySelectorAll('.mini-modal-scrim:not([hidden])')) m.hidden = true;
  });
  $('#bp-panel-close').addEventListener('click', () => {
    bpHidden = true;
    save(LS.bpHidden, true);
    document.body.classList.remove('bp-sheet');
    refreshBlueprintPanel();
  });
  $('#btn-blueprint').addEventListener('click', () => {
    bpHidden = false;
    save(LS.bpHidden, false);
    // Under the desktop breakpoint the panel opens as a full-height sheet.
    if (!window.matchMedia('(min-width: 1100px)').matches) document.body.classList.toggle('bp-sheet');
    refreshBlueprintPanel();
  });
  // Resizable split (desktop): drag the left edge; width persists in
  // localStorage (survives reloads; resets only with site data / another
  // browser). Wider range since the panel became the 工作台 (§5b).
  const saved = Number(load(LS.bpW, 0));
  if (saved >= 300 && saved <= 880) document.documentElement.style.setProperty('--bp-w', `${saved}px`);
  const resizer = $('#bp-resizer');
  resizer.addEventListener('pointerdown', (down) => {
    down.preventDefault();
    resizer.setPointerCapture(down.pointerId);
    const move = (ev) => {
      if (!(ev.buttons & 1)) { up(); return; } // canceled drags never keep resizing on hover
      const w = Math.max(300, Math.min(880, window.innerWidth - ev.clientX));
      document.documentElement.style.setProperty('--bp-w', `${w}px`);
    };
    const up = () => {
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
      resizer.removeEventListener('pointercancel', up);
      resizer.removeEventListener('lostpointercapture', up);
      const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bp-w'), 10);
      if (w) save(LS.bpW, w);
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
    resizer.addEventListener('pointercancel', up);
    resizer.addEventListener('lostpointercapture', up);
  });
  window.matchMedia('(min-width: 1100px)').addEventListener('change', () => {
    document.body.classList.remove('bp-sheet');
    refreshBlueprintPanel();
  });
  // 880px gates the 导图 tab — keep it LIVE so narrowing mid-session drops to the list.
  window.matchMedia('(min-width: 880px)').addEventListener('change', refreshBlueprintPanel);
}

// -------------------------------------------------- history rail (UI surface)

function applyRailPinned() {
  document.body.classList.toggle('rail-pinned', railPinned);
  const pin = document.querySelector('#rail-pin');
  if (pin) pin.setAttribute('aria-pressed', String(railPinned));
}
function openRail() { document.body.classList.add('rail-open'); }
function closeRail() {
  document.body.classList.remove('rail-open');
  // Also cancel a hover-peek: a close triggered while the cursor is still over
  // the rail must actually close it, not leave it held open by the peek state.
  document.body.classList.remove('rail-peek');
  exitManageMode();
}

function resetDeleteArm() {
  const dsel = document.querySelector('#rail-del-selected');
  const dall = document.querySelector('#rail-del-all');
  if (dsel) { dsel.dataset.armed = ''; dsel.classList.remove('confirming'); }
  if (dall) { dall.dataset.armed = ''; dall.classList.remove('confirming'); dall.textContent = '全部删除'; }
  updateManageBar();
}
function exitManageMode() {
  if (!manageMode && !renameId) return;
  manageMode = false;
  selectedIds.clear();
  pendingDeleteId = null;
  renameId = null;
  renderRail();
}

function updateManageBar() {
  const dsel = document.querySelector('#rail-del-selected');
  if (dsel && dsel.dataset.armed !== '1') {
    dsel.disabled = selectedIds.size === 0;
    dsel.textContent = `删除所选${selectedIds.size ? ` (${selectedIds.size})` : ''}`;
  }
}

/** Render the rail's course list, delete affordances, and manage/normal footer. */
function renderRail() {
  const list = document.querySelector('#rail-list');
  if (!list) return;
  list.replaceChildren();
  if (!coursesCache.length) {
    list.append(el('div', 'rail-empty', '还没有课程。'));
  }
  for (const c of coursesCache) {
    const item = el('div', `rail-item${c.id === activeCourseId ? ' active' : ''}`);
    item.setAttribute('role', 'button');
    item.tabIndex = 0;

    if (manageMode) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'rail-check';
      cb.checked = selectedIds.has(c.id);
      cb.setAttribute('aria-label', `选择 ${c.title || '未命名课程'}`);
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        if (cb.checked) selectedIds.add(c.id); else selectedIds.delete(c.id);
        resetDeleteArm();
      });
      item.append(cb);
    } else {
      item.append(el('span', 'rail-item-dot'));
    }

    if (renameId === c.id) {
      // inline rename: Enter saves, Esc cancels; a human rename locks the title
      const input = el('input', 'rail-rename');
      input.value = c.title || '';
      input.maxLength = 16;
      input.setAttribute('aria-label', '课程名');
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('keydown', async (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          try {
            const res = await fetch(apiUrl(`/api/courses/${c.id}`), {
              method: 'PATCH', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ title: input.value }),
            });
            const data = await res.json();
            if (!data.ok) { showError(data.message || '改名失败'); return; }
            const hit = coursesCache.find((x) => x.id === c.id);
            if (hit) hit.title = data.course.title;
            renameId = null;
            renderRail();
            updateHeader();
          } catch (err2) { showError(err2?.message ?? '改名失败'); }
        } else if (e.key === 'Escape') { renameId = null; renderRail(); }
      });
      item.append(input);
      setTimeout(() => { input.focus(); input.select(); }, 0);
    } else {
      item.append(el('span', 'rail-item-title', c.title || '未命名课程'));
    }

    if (!manageMode && renameId !== c.id) {
      const ed = el('button', 'rail-edit', '✎');
      ed.type = 'button';
      ed.title = '重命名';
      ed.setAttribute('aria-label', `重命名 ${c.title || '未命名课程'}`);
      ed.addEventListener('click', (e) => {
        e.stopPropagation();
        pendingDeleteId = null;
        renameId = c.id;
        renderRail();
      });
      item.append(ed);

      const arming = pendingDeleteId === c.id;
      const del = el('button', `rail-del${arming ? ' confirming' : ''}`, arming ? '确定删除？' : '✕');
      del.type = 'button';
      del.title = '删除课程';
      del.setAttribute('aria-label', `删除 ${c.title || '未命名课程'}`);
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pendingDeleteId === c.id) deleteCourses([c.id]);
        else { pendingDeleteId = c.id; renderRail(); }
      });
      item.append(del);
    }

    const activate = () => {
      if (manageMode || renameId === c.id) return;
      if (pendingDeleteId || renameId) { pendingDeleteId = null; renameId = null; renderRail(); return; }
      switchCourse(c.id);
    };
    item.addEventListener('click', activate);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
    list.append(item);
  }

  const foot = document.querySelector('.rail-foot');
  const bar = document.querySelector('#rail-managebar');
  if (foot) foot.hidden = manageMode;
  if (bar) bar.hidden = !manageMode;
  resetDeleteArm();
}

/** Delete one or more courses; if the active course goes, move to another/new. */
async function deleteCourses(ids) {
  if (!ids.length) return;
  try {
    for (const id of ids) await serverDeleteCourse(id);
  } catch (err) {
    showError(err?.message || '删除失败。');
    return;
  }
  logEvent('session', 'delete_courses', { ids, count: ids.length });
  const deletedActive = ids.includes(activeCourseId);
  manageMode = false;
  selectedIds.clear();
  pendingDeleteId = null;
  try { coursesCache = await serverListCourses(); }
  catch { coursesCache = coursesCache.filter((c) => !ids.includes(c.id)); }

  if (deletedActive) {
    let target = coursesCache[0];
    if (!target) {
      target = await serverCreateCourse();
      coursesCache = [target];
    }
    activeCourseId = target.id;
    save(LS.courseId, activeCourseId);
    await loadCourseFromServer(activeCourseId);
    replayTranscript();
    updateHeader();
    updateSkipLink();
    refreshDebug();
  }
  renderRail();
}

// -------------------------------------------------- 用户中心 (SECURITY.md §2–§4)

async function fetchMe() {
  try {
    const res = await fetch(apiUrl('/api/me'));
    if (!res.ok) return null;
    return (await res.json()).user ?? null;
  } catch { return null; }
}

/** Bring the persistence tier up for the signed-in user (rail, server history). */
async function enablePersistence() {
  await initCourseFromServer();
  if (!persistent) return;
  document.body.classList.add('has-history');
  const hb = $('#btn-history');
  if (hb) hb.hidden = false;
  applyRailPinned();
  renderRail();
  replayTranscript();
  updateHeader();
  updateSkipLink();
  refreshDebug();
  scrollToEnd();
}

/** Field + button row for the account pane. */
function actionRow(inputEl2, btnLabel, onClick) {
  const row = el('div', 'model-row');
  const holder = el('span', 'model-holder');
  holder.append(inputEl2);
  const btn = el('button', 'text-btn', btnLabel);
  btn.type = 'button';
  btn.addEventListener('click', () => onClick(btn));
  row.append(holder, btn);
  return row;
}

function paneMsg() {
  const m = el('p', 'settings-note');
  m.setAttribute('role', 'status');
  return m;
}

/** Sign in and bring the signed-in UI up. Shared by the 用户中心 login pane and
 * the public-channel login gate. @returns {{ok: boolean, message?: string}} */
async function performLogin(username, password) {
  const res = await fetch(apiUrl('/api/auth/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (res.status === 429) {
    const retryAfter = Math.max(1, Number(data.retry_after) || 60);
    return {
      ok: false, retryAfter,
      message: `尝试次数过多，请约 ${Math.max(1, Math.ceil(retryAfter / 60))} 分钟后再试`,
    };
  }
  if (!data.ok) return { ok: false, message: data.message || '登录失败' };
  me = data.user;
  logEvent('session', 'login', { user: me.username });
  if (me.profile) { profile = { ...profile, ...me.profile }; save(LS.profile, profile); }
  await loadServerKeyFlags();
  buildProviderSections();
  applyDevInstruments(); // an admin logging in on public gains the spanner
  await enablePersistence();
  hideLoginGate();
  offerKeyMigration();
  return { ok: true };
}

// ---- localStorage-key migration (spec 2026-07-22: ask once, then purge).
// Never silently import — on a shared machine that would gift the previous
// person's keys to whoever logs in next, the exact leak this fixes.
function offerKeyMigration() {
  const localCount = Object.keys(apiKeys).length + (customCfg.key ? 1 : 0);
  if (!serverKeyMode() || !localCount || document.querySelector('.key-migrate')) return;
  const wrap = el('div', 'key-migrate');
  const card = el('div', 'key-migrate-card');
  card.append(el('h3', '', '此浏览器里存有模型密钥'));
  card.append(el('p', '', `发现 ${localCount} 个保存在本浏览器的 API 密钥。为避免同一台电脑上的其他账号看到或使用它们，密钥现在只保存在你的账号里。这些旧密钥要怎么处理？`));
  const purgeLocal = () => {
    apiKeys = {}; saveKeys();
    if (customCfg.key) { delete customCfg.key; saveCustom(); }
    buildProviderSections();
  };
  const actions = el('div', 'key-migrate-actions');
  const keep = el('button', 'text-btn', '保存到我的账号');
  const drop = el('button', 'text-btn danger', '仅清除');
  keep.type = drop.type = 'button';
  keep.addEventListener('click', async () => {
    keep.disabled = drop.disabled = true;
    keep.textContent = '保存中…';
    const entries = [...Object.entries(apiKeys), ...(customCfg.key ? [['custom', customCfg.key]] : [])];
    for (const [pid, v] of entries) {
      try {
        await fetch(apiUrl(`/api/me/keys/${pid}`), {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: v }),
        });
      } catch { /* one failed save must not strand the rest */ }
    }
    await loadServerKeyFlags();
    purgeLocal();
    logEvent('session', 'key_migration', { action: 'saved', count: entries.length });
    wrap.remove();
  });
  drop.addEventListener('click', () => {
    purgeLocal();
    logEvent('session', 'key_migration', { action: 'cleared', count: localCount });
    wrap.remove();
  });
  actions.append(keep, drop);
  card.append(actions);
  card.append(el('p', 'settings-note', '两种选择都会把密钥从此浏览器移除。'));
  wrap.append(card);
  document.body.append(wrap);
}

// Live lockout countdown on the login gate (spec 2026-07-22 §6): inline brick
// message, button disabled until the window opens again — no raw error pages.
let gateCountdownTimer = null;
function startGateCountdown(seconds) {
  clearInterval(gateCountdownTimer);
  const btn = $('#gate-login');
  const msg = $('#gate-msg');
  let left = Math.max(1, Math.round(seconds));
  const paint = () => {
    const m = Math.floor(left / 60);
    const s = left % 60;
    msg.textContent = `尝试次数过多——${m ? `${m} 分 ` : ''}${s} 秒后可再试`;
  };
  if (btn) btn.disabled = true;
  paint();
  gateCountdownTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(gateCountdownTimer);
      if (btn) btn.disabled = false;
      msg.textContent = '可以再试了。';
      return;
    }
    paint();
  }, 1000);
}

// ---- public-channel login gate (SECURITY.md §3): the public instance has no
// guest mode — an anonymous visitor sees only this, never the app. Dev/tunnel
// channels and offline/static hosting keep the 演示模式 path. Logout reloads
// the page, which re-runs boot and re-raises the gate.
function showLoginGate() {
  const gate = $('#login-gate');
  gate.hidden = false;
  const doGateLogin = async () => {
    $('#gate-msg').textContent = '登录中…';
    try {
      const result = await performLogin($('#gate-username').value.trim(), $('#gate-password').value);
      if (!result.ok) {
        if (result.retryAfter) startGateCountdown(result.retryAfter);
        else $('#gate-msg').textContent = result.message;
        return;
      }
      $('#gate-msg').textContent = '';
      if (me.must_change_password) openUserModal('account', '请先修改初始密码，再开始使用。');
    } catch (e) { $('#gate-msg').textContent = e?.message ?? '连接失败'; }
  };
  if (!gate.dataset.wired) {
    gate.dataset.wired = '1';
    $('#gate-login').addEventListener('click', doGateLogin);
    $('#gate-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doGateLogin(); });
    $('#gate-register').addEventListener('click', () => { $('#login-gate-form').hidden = true; $('#login-gate-signup').hidden = false; });
    $('#gate-back').addEventListener('click', () => { $('#login-gate-signup').hidden = true; $('#login-gate-form').hidden = false; });
  }
  $('#gate-username').focus();
}
function hideLoginGate() { const g = $('#login-gate'); if (g) g.hidden = true; }

/** Rebuild the 用户中心 modal for the current login state and open it. */
/** Old deep-link pane keys → the merged nav (nothing may 404). */
const PANE_ALIAS = { general: 'ui', providers: 'models', devices: 'account' };

/** Switch the 用户中心 modal to one pane (shared by nav clicks and deep links). */
function activateUserPane(key) {
  const k = PANE_ALIAS[key] ?? key;
  for (const b of document.querySelectorAll('#settings-nav button')) b.classList.toggle('on', b.dataset.pane === k);
  for (const p of document.querySelectorAll('.modal-pane')) p.classList.toggle('on', p.dataset.pane === k);
  // The developer drawer belongs to 模型与服务 — leaving that pane closes it.
  if (k !== 'models') setDevPanel(false);
}

/** 用户中心 controls everything: 账号与设备 + 教师档案 + 界面与体验 + 模型与服务.
 * The auth pane is rebuilt on every open (it depends on live auth state);
 * the settings panes are static and owned by buildProviderSections(). */
function openUserModal(startPane, notice) {
  const accountPane = $('#pane-account');
  accountPane.replaceChildren();

  const authAvailable = backendOnline && authRequired;
  const navAccount = $('#nav-account');
  navAccount.hidden = !authAvailable;
  navAccount.querySelector('.nav-title').textContent = me ? '账号与设备' : '登录';
  navAccount.querySelector('.nav-sub').textContent = me ? '昵称 · 密码 · 登录设备' : '账号由管理员创建';

  if (!authAvailable) {
    // offline / static hosting: no accounts — settings panes only
  } else if (!me) {
    // ---- signed out: login pane ----
    const pane = accountPane;
    const msg = paneMsg();
    const { field: userField, input: userInput } = settingsField('用户名', 'login-username', { placeholder: '账号由管理员创建', value: '' });
    const { field: pwField, input: pwInput } = settingsField('密码', 'login-password', { type: 'password', value: '' });
    const btn = el('button', 'text-btn', '登录');
    btn.type = 'button';
    const doLogin = async () => {
      msg.textContent = '登录中…';
      try {
        const result = await performLogin(userInput.value.trim(), pwInput.value);
        if (!result.ok) { msg.textContent = result.message; return; }
        if (me.must_change_password) openUserModal('account', '请先修改初始密码，再开始使用。');
        else closeDrawers();
      } catch (err2) { msg.textContent = err2?.message ?? '连接失败'; }
    };
    btn.addEventListener('click', doLogin);
    pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    pane.append(userField, pwField, btn, msg,
      el('p', 'settings-note', '没有账号？账号由管理员在数据管理台创建（首次登录后需要改密码）。不登录也可以用「演示模式」体验，对话只存在本机。'));
  } else {
    // ---- signed in: 账号与设备 (account + device list, one pane) ----
    const account = accountPane;

    const noticeEl = paneMsg();
    if (notice) noticeEl.textContent = notice;
    account.append(el('p', 'settings-note', `已登录：${me.username}${me.role === 'admin' ? '（管理员）' : ''}`), noticeEl);

    // display name (rules stated inline; server re-checks everything)
    const dnMsg = paneMsg();
    const dnInput = el('input', 'settings-input');
    dnInput.value = me.display_name ?? '';
    dnInput.id = 'account-displayname';
    const dnField = el('div', 'settings-field');
    const dnLabel = el('label', 'settings-label', '昵称（全站唯一，每 6 个月可改一次）');
    dnLabel.htmlFor = dnInput.id;
    dnField.append(dnLabel, actionRow(dnInput, '修改昵称', async () => {
      dnMsg.textContent = '…';
      const res = await fetch(apiUrl('/api/me'), {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ display_name: dnInput.value.trim() }),
      });
      const data = await res.json();
      if (data.ok) { me = data.user; dnMsg.textContent = '已更新。'; }
      else dnMsg.textContent = data.message || '修改失败';
    }), dnMsg);
    account.append(dnField);

    // password change
    const pwMsg = paneMsg();
    const mk = (labelText, id) => {
      const f = settingsField(labelText, id, { type: 'password', value: '' });
      account.append(f.field);
      return f.input;
    };
    const oldPw = mk(me.must_change_password ? '初始密码' : '旧密码', 'account-oldpw');
    const newPw = mk('新密码（至少 8 位）', 'account-newpw');
    const newPw2 = mk('再输一次新密码', 'account-newpw2');
    const pwBtn = el('button', 'text-btn', '修改密码');
    pwBtn.type = 'button';
    pwBtn.addEventListener('click', async () => {
      if (newPw.value !== newPw2.value) { pwMsg.textContent = '两次输入的新密码不一致'; return; }
      pwMsg.textContent = '…';
      const res = await fetch(apiUrl('/api/me'), {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: { old: oldPw.value, new: newPw.value } }),
      });
      const data = await res.json();
      if (data.ok) {
        pwMsg.textContent = '密码已修改。';
        me.must_change_password = false;
        oldPw.value = newPw.value = newPw2.value = '';
      } else pwMsg.textContent = data.message || '修改失败';
    });
    account.append(pwBtn, pwMsg);

    // devices — same pane, its own quiet section (账号与设备 merge)
    const devHd = el('div', 'sec-hd');
    const devMark = el('span', 'sec-mark');
    devMark.setAttribute('aria-hidden', 'true');
    devHd.append(devMark, el('h4', 'sec-title', '登录设备'));
    account.append(devHd);
    account.append(el('p', 'settings-note', '你的有效登录设备。退出某台设备后，那台设备需要重新登录。'));
    const list = el('div', 'course-list');
    account.append(list);
    fetch(apiUrl('/api/me/sessions')).then((r) => r.json()).then((data) => {
      list.replaceChildren();
      for (const s of data.sessions ?? []) {
        const row = el('div', 'rail-item');
        const label = `${s.current ? '本设备 · ' : ''}${(s.user_agent || '未知设备').slice(0, 40)}｜最近 ${String(s.last_seen_at).slice(0, 16).replace('T', ' ')}`;
        row.append(el('span', 'rail-item-title', label));
        if (!s.current) {
          const out = el('button', 'rail-del', '退出');
          out.style.opacity = 1;
          out.type = 'button';
          out.addEventListener('click', async () => {
            await fetch(apiUrl(`/api/me/sessions/${encodeURIComponent(s.sid)}`), { method: 'DELETE' });
            row.remove();
          });
          row.append(out);
        }
        list.append(row);
      }
      if (!(data.sessions ?? []).length) list.append(el('p', 'settings-note', '没有其他设备。'));
    }).catch(() => list.append(el('p', 'settings-note', '设备列表加载失败。')));

    const logoutBtn = el('button', 'text-btn danger', '退出登录');
    logoutBtn.type = 'button';
    logoutBtn.addEventListener('click', async () => {
      await fetch(apiUrl('/api/auth/logout'), { method: 'POST' }).catch(() => {});
      window.location.reload(); // clean teardown of the persistent UI
    });
    account.append(el('p', 'settings-note', '「教师档案」在左边一栏——填了会跟随你的账号，换设备也在。'), logoutBtn);
  }

  activateUserPane(startPane ?? (authAvailable ? 'account' : 'profile'));
  // Always OPEN (openDrawer toggles — a re-entrant call, e.g. the must-change
  // flow right after login, must never accidentally close the modal).
  debugDrawer.classList.remove('open');
  settingsDrawer.classList.add('open');
}

// ------------------------------------------------------------ new course

async function resetCourse() {
  // Persistence tier (signed in): a new course is a new server record, not a wipe — no confirm.
  // Visitors stay on the local-wipe path below; they must never hit the 401 courses API.
  if (persistenceActive()) {
    try {
      const course = await serverCreateCourse();
      coursesCache = [course, ...coursesCache];
      activeCourseId = course.id;
      save(LS.courseId, activeCourseId);
      logEvent('session', 'new_course', { previous_course: courseState?.course_id ?? null, course_id: activeCourseId });
      await loadCourseFromServer(activeCourseId);
      replayTranscript();
      updateHeader();
      updateSkipLink();
      refreshDebug();
      renderRail();
      if (!railPinned) closeRail();
      return;
    } catch (err) {
      showError(err?.message || '创建新课程失败。');
      return;
    }
  }
  // Offline / static hosting: local wipe (old behavior).
  const sure = window.confirm('开始新课程会清空当前对话和课程进度，确定吗？');
  if (!sure) return;
  logEvent('session', 'new_course', { previous_course: courseState?.course_id ?? null });
  courseState = createInitialState(`course-${Date.now()}`);
  document.body.classList.remove('bp-sheet');
  transcript = [];
  lastEvent = null;
  lastTurnHadQuestion = false;
  pendingMessage = null;
  save(LS.state, courseState);
  save(LS.transcript, transcript);
  replayTranscript();
  updateHeader();
  updateSkipLink();
  refreshDebug();
}

// ------------------------------------------------------------------ wiring

function wire() {
  // chips (starter + example answers): INSERT into the input, never auto-send
  messagesEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.classList.contains('qcard-chip')) return; // card chips fill their own card (render.js)
    inputEl.value = chip.textContent;
    autogrow();
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  });

  // Composer send (§5c): plain sends are a single click / Enter; with staged
  // items the button becomes press-and-hold (pointer or held Enter) — release
  // early cancels, the linear fill is the countdown.
  sendBtn.addEventListener('pointerdown', () => {
    if (stagedPayload().total > 0) holdStart();
  });
  for (const evName of ['pointerup', 'pointerleave', 'pointercancel']) {
    sendBtn.addEventListener(evName, holdCancel);
  }
  sendBtn.addEventListener('click', () => {
    if (holdFired) { holdFired = false; return; } // the hold already sent
    if (stagedPayload().total > 0) {
      setStatus('有待发内容——按住发送键 1.2 秒一起发出');
      setTimeout(() => setStatus(null), 2400);
      return;
    }
    composerSend();
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (stagedPayload().total > 0) { if (!e.repeat) holdStart(); return; } // hold Enter = same physics
      composerSend();
    }
  });
  inputEl.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') holdCancel();
  });
  inputEl.addEventListener('input', autogrow);

  skipLink.addEventListener('click', () => {
    // 先跳过 while content is staged must not orphan it: route through the
    // composer so locked answers/批注 ride along instead of being silently
    // replaced by the next question set. Explicit click, so no hold physics.
    if (stagedPayload().total > 0) {
      inputEl.value = [inputEl.value.trim(), '先跳过'].filter(Boolean).join('\n');
      composerSend();
    } else {
      send('先跳过');
    }
  });

  $('#btn-new').addEventListener('click', resetCourse);
  // Header theme toggle: one click flips light↔dark as an explicit choice
  // (跟随系统 remains available in 设置 · 通用). Icon swap is pure CSS.
  $('#btn-theme').addEventListener('click', () => {
    const next = resolveTheme(localStorage.getItem(THEME_KEY)) === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
    const sel = document.querySelector('#theme-select');
    if (sel) sel.value = next;
    logEvent('session', 'theme_change', { choice: next, via: 'header' });
  });
  $('#btn-debug').addEventListener('click', () => { refreshDebug(); openDrawer(debugDrawer); });
  $('#close-settings').addEventListener('click', closeDrawers);
  $('#close-debug').addEventListener('click', closeDrawers);
  $('#close-devpanel').addEventListener('click', () => setDevPanel(false));

  // 用户中心: left-nav pane switching + scrim click closes
  $('#settings-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pane]');
    if (btn) activateUserPane(btn.dataset.pane);
  });
  document.querySelector('[data-close-settings]').addEventListener('click', closeDrawers);
  $('#btn-user').addEventListener('click', () => openUserModal());

  // history rail: 历史 is a true toggle — pinned means "keep open", so
  // toggling while pinned unpins and closes rather than doing nothing.
  $('#btn-history').addEventListener('click', () => {
    if (railPinned) {
      railPinned = false;
      save(LS.railPinned, false);
      applyRailPinned();
      closeRail();
      return;
    }
    document.body.classList.toggle('rail-open');
    if (!document.body.classList.contains('rail-open')) exitManageMode();
  });
  $('#rail-pin').addEventListener('click', () => {
    railPinned = !railPinned;
    save(LS.railPinned, railPinned);
    applyRailPinned();
    logEvent('session', 'rail_pin', { pinned: railPinned });
  });
  $('#rail-new').addEventListener('click', () => resetCourse());
  $('#rail-manage').addEventListener('click', () => { manageMode = true; renderRail(); });
  $('#rail-manage-done').addEventListener('click', () => exitManageMode());
  // two-step bulk deletes (no modal dialog): arm on first click, delete on second.
  const armBulk = (btn, getIds) => {
    btn.addEventListener('click', () => {
      const ids = getIds();
      if (!ids.length) return;
      if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.classList.remove('confirming'); deleteCourses(ids); }
      else { resetDeleteArm(); btn.dataset.armed = '1'; btn.classList.add('confirming'); btn.textContent = `确定删除 ${ids.length} 个？`; }
    });
  };
  armBulk($('#rail-del-selected'), () => Array.from(selectedIds));
  armBulk($('#rail-del-all'), () => coursesCache.map((c) => c.id));
  // click-away closes an unpinned open rail
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('rail-open') || railPinned) return;
    if (e.target.closest('#history-rail') || e.target.closest('#btn-history')) return;
    closeRail();
  });
  // hover peek (body.rail-peek), JS-managed instead of CSS :hover so that a
  // click that closes the rail wins over the cursor still hovering it: enter
  // the left hot-zone to peek, leave the hot-zone/rail pair to unpeek.
  const hotzone = document.querySelector('#rail-hotzone');
  const railEl = document.querySelector('#history-rail');
  const unpeek = (e) => {
    const to = e.relatedTarget;
    if (to && (to.closest?.('#history-rail') || to.closest?.('#rail-hotzone'))) return;
    document.body.classList.remove('rail-peek');
  };
  hotzone.addEventListener('mouseenter', () => document.body.classList.add('rail-peek'));
  hotzone.addEventListener('mouseleave', unpeek);
  railEl.addEventListener('mouseleave', unpeek);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '`') {
      if (!devInstrumentsAllowed()) return; // role-gated dev instrument
      e.preventDefault();
      refreshDebug();
      openDrawer(debugDrawer);
    } else if (e.key === 'Escape') {
      closeDrawers();
      closeRail();
    }
  });

  // model-card + 线路 change handlers live in buildModelsPane (built there)
}

// -------------------------------------------------------------------- boot

function boot() {
  save(LS.state, courseState); // persist a fresh course on first visit
  wire();
  mountLogPanel($('#log-panel'), logStore, {
    getContext: () => ({
      provider,
      dev_mode: devMode,
      backend_online: backendOnline,
      api_base: apiBase || '(same-origin)',
      course_id: courseState?.course_id ?? null,
      stage: courseState?.stage ?? null,
      // 工作台 work-in-progress rides every export (Herman 2026-07-21):
      // unsent 批注 + the living card answers, not just what was sent.
      workbench: workbenchSnapshot(),
    }),
  });
  logEvent('session', 'boot', {
    provider, dev_mode: devMode, transcript_entries: transcript.length,
    course_id: courseState?.course_id ?? null, stage: courseState?.stage ?? null,
    // Full cst.providerCaps snapshot: the debug drawer / export otherwise
    // sees only toggle deltas and can't reconstruct pre-session state.
    provider_caps: providerCaps,
  });
  replayTranscript(); // instant render from the localStorage cache
  wireBlueprintPanel();
  refreshBlueprintPanel();
  updateHeader();
  updateSkipLink();
  refreshDebug();
  autogrow();
  window.scrollTo(0, document.body.scrollHeight);
  // Detect the backend, then (if it offers persistence) load server-side history
  // and re-render — the localStorage cache above kept first paint instant.
  initProviders().then(async () => {
    if (authRequired && backendOnline) {
      me = await fetchMe();
      if (me?.profile) { profile = { ...profile, ...me.profile }; save(LS.profile, profile); }
      logEvent('session', 'auth_state', { signed_in: Boolean(me), user: me?.username ?? null });
      if (me) {
        // Vault flags before the drawer rebuild — badges must reflect the account.
        await loadServerKeyFlags();
        buildProviderSections();
      }
    }
    applyDevInstruments(); // spanner: dev channels always; public = admin-only
    if (backendChannel === 'public' && authRequired && !me) {
      showLoginGate();                        // public: no guest mode — gate everything
      return;
    }
    if (!persistent) return;
    if (authRequired && !me) return;          // dev/tunnel visitor: localStorage-only 演示模式
    await enablePersistence();
    offerKeyMigration();
    if (me?.must_change_password) openUserModal('account', '请先修改初始密码，再开始使用。');
  });
}

boot();
