// main.js — app logic for the 小小探索家 demo chat (JSDoc-typed ESM, no build
// step, ADR-0001). Talks to demo/serve.mjs over the /api/chat SSE protocol.
// State custody: course_state + transcript + provider choice live in
// localStorage. API keys never do. ADR-0013 §4 removed the browser key path
// outright: a key is WRITE-ONLY to the per-account server vault (ADR-0005) or
// it comes from the server env, and no request this file builds carries key
// material under any code path. The cost, accepted in that ADR: the
// paste-your-own-key offline demo is gone; local development uses env keys.

import { createInitialState, STAGE_NAMES } from '../engine.mjs';
import {
  renderTeacherMessage, renderAgentMessage, renderArtifactCard,
  renderQuestionBlock, renderQuestionCards, freezeQuestionCards,
  renderClosureCard, renderAwaitingNote,
  renderErrorNotice, renderDebug, renderWfTrace, el,
  renderBlueprintList, renderBlueprintChip,
  renderPlanTree, renderPlanTally, renderPlanLegend, renderRecentStrip,
  renderNodeDetail, renderStepZero, renderTurnReceipt, renderReceiptToast,
  pickGreeting,
  renderMemoryView, renderClassChoice, renderClassHeader, renderAxisHandles, renderLanding,
} from './render.js';
import {
  groupMemory, shouldAskClass, silentClassBinding, correctionPrompt,
  axisHandleRows, axisChangeEvent, memorySnapshot,
} from './memory-view.mjs';
import { landingModel } from './landing-view.mjs';
import {
  PRESET_VECTORS, vectorFromPreset, pinAxis, unpinAxis, defaultVector, isReadableVector,
} from '../interaction-axes.mjs';
import {
  planViewModel, planRenderKey, toggleFold,
  messageCountsBySubject, recentNodes, mergeRecent, summarizeTurnReceipt,
  normalizeSubject, resolveSubject, filterBySubject, nodeContext,
  stepZeroStatus, COURSE_SUBJECT, RECENT_MAX,
} from './plan-view.mjs';
import { normalizeBlueprint, numberBlueprint, countUnconfirmed, packStagedMessage } from '../blueprint-util.mjs';
import { TITLE_INTERVALS, TITLE_INTERVAL_DEFAULT } from '../title-agent.mjs';
import { messageIn, cardIn, cardsIn, chipsIn, closureIn, fadeIn } from './motion.js';
import { runLocalMockTurn } from './local-turn.mjs';
import { buildSystemPrompt, stageModuleName, profileSectionText, STYLE_DIRECTIVES } from '../prompt-builder.mjs';
import { supportsWebSearch, unavailableReason } from '../web-search.mjs';
import { createLogStore, mountLogPanel, redactSecrets } from './session-log.mjs';

// ------------------------------------------------------------ persistence

const LS = {
  state: 'cst.state',
  transcript: 'cst.transcript',
  provider: 'cst.provider',
  models: 'cst.models',
  custom: 'cst.custom',
  apiBase: 'cst.apiBase',
  devmode: 'cst.devmode',
  profile: 'cst.profile',
  logcfg: 'cst.logcfg',
  courseId: 'cst.courseId',   // pointer to the active server course (persistence tier)
  railPinned: 'cst.railPinned', // history rail pinned-open preference
  channels: 'cst.channels',   // per-family 线路 choice (国内/国际), {group: providerId}
  bpW: 'cst.bpW',             // 工作台 panel width (desktop, px)
  bpTab: 'cst.bpTab',         // 工作台 representation: 'list' | 'map'
  bpHidden: 'cst.bpHidden',   // teacher chose to collapse the panel
  turnMeta: 'cst.turnMeta',   // live turn-progress display toggles {timer, stats, thinking}
  qcards: 'cst.qcards',       // living question-card answer sets, keyed by course (§5c)
  providerCaps: 'cst.providerCaps', // per-provider 深度思考/联网搜索 toggles (UI-only for now)
  // ---- Workflow v2 (ADR-0010) ----
  subject: 'cst.subject',     // {course: nodeId|'course'} — which conversation she is in
  nodeRecent: 'cst.nodeRecent', // {course: [{id, number, title, at}]} — 最近处理 strip
  planFold: 'cst.planFold',   // {course: [nodeId]} — collapsed branches (view state)
  planZoom: 'cst.planZoom',   // {course: number} — 导图 scale (view state)
  receipts: 'cst.receipts',   // {course: [receipt]} — the per-turn receipt ledger
};

// Pure view state whose surface was removed with the 问题卡 tab (ADR-0010 §3).
// Purged on load for the same reason the legacy key store is: code that no
// longer reads a key can never clean it up later. Nothing here is content.
const RETIRED_VIEW_KEYS = ['cst.wbTab'];
/** Where unsent 批注 go when the 批注 surface is removed. NOT deleted — the
 * text in there is the teacher's, typed and never sent, and the one thing worse
 * than a dead feature is a dead feature that quietly ate her words. Renamed so
 * this build stops writing it, kept so it can still be read out. */
const RESCUED_COMMENTS = 'cst.bpComments.rescued';

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

// Keys this build no longer writes, and must not leave behind. Deleting the
// code that reads 'cst.keys' would otherwise leave the secrets sitting in the
// browser forever — on a shared staffroom machine that is the exact leak
// ADR-0013 §4 closes. Purged on load, once, before anything else reads storage.
const LEGACY_KEY_STORE = 'cst.keys';
function purgeLegacyKeyStorage() {
  let purged = 0;
  try {
    if (localStorage.getItem(LEGACY_KEY_STORE) != null) {
      localStorage.removeItem(LEGACY_KEY_STORE);
      purged += 1;
    }
    // The custom endpoint kept its key inside the 'cst.custom' blob, not in
    // 'cst.keys' — same removal, different hiding place.
    const raw = localStorage.getItem(LS.custom);
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg && typeof cfg === 'object' && 'key' in cfg) {
        delete cfg.key;
        localStorage.setItem(LS.custom, JSON.stringify(cfg));
        purged += 1;
      }
    }
  } catch { /* storage blocked or the blob is unparseable: nothing to purge */ }
  return purged;
}
const purgedLegacyKeys = purgeLegacyKeyStorage();

/**
 * Retire the surfaces ADR-0010 §3/§6 removed, WITHOUT eating teacher content.
 * View-only keys go; the unsent-批注 bucket is renamed rather than deleted and
 * its rows are handed back so the app can show them to her. She typed those
 * words for a button that no longer exists — that is our problem to hand back,
 * not hers to lose.
 *
 * Read back from the RENAMED key too, not only from the original: the notice is
 * not a one-shot. Before this, the first reload after the migration rescued
 * nothing (the source key was already gone) and the .rescued key had no reader
 * anywhere in the repo — a dead key holding the teacher's words.
 * @returns {Array<{course: string, number: string, title: string, text: string}>}
 */
function retireRemovedSurfaces() {
  const rescued = [];
  const harvest = (raw) => {
    const blob = JSON.parse(raw);
    for (const [course, bucket] of Object.entries(blob && typeof blob === 'object' ? blob : {})) {
      for (const row of Object.values(bucket && typeof bucket === 'object' ? bucket : {})) {
        if (row && String(row.text ?? '').trim()) {
          rescued.push({ course, number: String(row.number ?? ''), title: String(row.title ?? ''), text: String(row.text) });
        }
      }
    }
  };
  try {
    for (const key of RETIRED_VIEW_KEYS) localStorage.removeItem(key);
    const raw = localStorage.getItem('cst.bpComments');
    if (raw) {
      harvest(raw);
      if (rescued.length) localStorage.setItem(RESCUED_COMMENTS, raw);
      localStorage.removeItem('cst.bpComments');
    } else {
      const kept = localStorage.getItem(RESCUED_COMMENTS);
      if (kept) harvest(kept);
    }
  } catch { /* storage blocked or unparseable: nothing to retire */ }
  return rescued;
}
let rescuedComments = retireRemovedSurfaces();
/** Her explicit 「收好了」 is the only thing that drops the rescued text — a
 * timer or a navigation dropping it is the app eating her words on a delay. */
function dismissRescuedComments() {
  rescuedComments = [];
  try { localStorage.removeItem(RESCUED_COMMENTS); } catch { /* storage blocked */ }
  logEvent('session', 'rescued_blueprint_comments_dismissed', {});
  for (const node of messagesEl.querySelectorAll('.rescued-comments')) node.remove();
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

// ---- per-account key vault (ADR-0005; sole key path since ADR-0013 §4): when
// the backend advertises key_vault and a user is signed in, a typed key is
// WRITE-ONLY to the server — saved once, stored encrypted per-account, never
// readable back (flags only). There is no second path any more: when this is
// false the browser simply has nowhere to put a key, and the drawer says so.
let keyVaultOn = false;   // /api/health key_vault
let serverKeyFlags = {};  // { provider: true } — configured flags, never values

/** Can this browser hand a key to the account vault? (Not "which key path" —
 * there is only one.) False = the server env is the only remaining source. */
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
/** OpenAI-compatible custom endpoint config. No `key` field: the custom
 * endpoint's key lives in the account vault under the provider id 'custom',
 * like every other provider (ADR-0013 §4). */
let customCfg = { baseURL: '', model: '', label: '', ...load(LS.custom, {}) };
/** 开发者模式: show wf_trace annotations + workflow map details. */
let devMode = Boolean(load(LS.devmode, false));

/** Session logger (debug drawer 「日志」 panel): every category defaults ON;
 * toggles persist in localStorage; entries are secret-redacted at append time. */
const logStore = createLogStore({
  loadConfig: () => load(LS.logcfg, null),
  saveConfig: (cfg) => save(LS.logcfg, cfg),
});
const logEvent = (cat, event, data) => logStore.log(cat, event, data);
// Observable, per AGENTS.md: a purge that leaves no trace is indistinguishable
// from a purge that never ran. Count only — never the values that were removed.
if (purgedLegacyKeys) logEvent('session', 'legacy_key_storage_purged', { entries: purgedLegacyKeys });

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
// ---------------------------------------------- 记忆 + 班级 (ADR-0011, server-owned)
//
// DELIBERATELY NOT CACHED IN localStorage, unlike course_state and the
// transcript. A fact is a sentence about a real class of real children, and
// this app runs on shared staffroom machines; keeping a copy on disk here would
// be a retention decision nobody made, in a browser that has no erasure path.
// The server holds them, this holds what the last read returned, and a reload
// asks again.
//
// `null` IS NOT `[]`, and the difference is load-bearing all the way down. The
// store's listFacts THROWS rather than returning an empty list precisely so a
// read failure stays distinguishable from a teacher who has said nothing
// memorable; if this coerced a failure into `[]` the viewer would tell her the
// agent remembers nothing, which is the 「我早就跟你说过」 failure produced by an
// outage instead of by a missing feature.
/** @type {Array<Object>|null} last successful read, or null (未读到 / 没读) */
let memoryFacts = null;
/** Teacher-readable reason the last read failed; '' when it did not. */
let memoryError = '';
/** @type {Array<Object>} her named classes (server-owned, same custody). */
let myClasses = [];
/** The class the ACTIVE course is bound to, off the course record. */
let courseClassId = null;
/** Her explicit 「先不选」 for this course — session-only on purpose: it is a
 * dismissal, not a decision, and persisting it would silently stop asking. */
const classAskDismissed = new Set();

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
/**
 * The bucket key every per-course client store is filed under (question-card
 * answers, subject, 最近处理, fold set, zoom, receipts). Defined HERE, above
 * every consumer, because it used to live inside the 批注 block: deleting that
 * block wholesale would have taken the question-card system's course key with
 * it and cards would have silently started reading the wrong bucket — no error,
 * wrong answers restored.
 */
function courseKey() { return activeCourseId || courseState?.course_id || 'local'; }
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
  deepseek: { name: 'DeepSeek', icon: 'deepseek', region: 'cn' },
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

/** 参考评级·随版本更新 — dot-scale档位 shown on both the 模型与服务 cards and
 * the 接入与服务 drawer rows (cost dots = 越多越省钱, per the pane legend). */
const MODEL_TRAITS = {
  'glm-5.2': { intel: 5, speed: 2, cost: 3 },
  'MiniMax-M3': { intel: 4, speed: 3, cost: 3 },
  'kimi-k2.6': { intel: 4, speed: 2, cost: 2 },
  'qwen-plus': { intel: 3, speed: 4, cost: 4 },
  // DeepSeek's own split: -pro is the capable one, -flash trades depth for
  // speed and price. Both are cheap by mainland standards, which is the whole
  // reason a teacher would pick them.
  'deepseek-v4-pro': { intel: 5, speed: 2, cost: 4 },
  'deepseek-v4-flash': { intel: 3, speed: 5, cost: 5 },
};
/** Family fallback so a version bump (glm-5.2 → glm-5.3) or an aggregator id
 * (z-ai/glm-4.7:free) keeps a 档位 instead of going blank. Unmatched ids —
 * 'auto', an unknown OpenRouter model — get NO rating rather than a guess. */
const FAMILY_TRAITS = [
  [/glm/i, { intel: 5, speed: 2, cost: 3 }],
  [/minimax/i, { intel: 4, speed: 3, cost: 3 }],
  [/kimi|moonshot/i, { intel: 4, speed: 2, cost: 2 }],
  [/deepseek.*flash/i, { intel: 3, speed: 5, cost: 5 }],
  [/deepseek/i, { intel: 5, speed: 2, cost: 4 }],
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
  { id: 'deepseek', label: 'DeepSeek（deepseek.com）', defaultModel: 'deepseek-v4-pro', hasEnvKey: false },
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
  // Both sources are the server's word: the account vault's presence flag, or
  // an env key the health endpoint reported. This browser knows of no third.
  // serverKeyFlags is empty outside vault mode, so that case falls to hasEnvKey.
  return Boolean(serverKeyFlags[id] || providerInfo(id)?.hasEnvKey);
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
  // The drawer sees the memory and the six axes too (AGENTS.md observability
  // duty): both are state the agent carries into every prompt, and state that a
  // developer cannot see live is state nobody can diagnose.
  const ctx = memoryContext();
  renderDebug(debugBody, {
    lastEvent,
    state: courseState,
    axes: axisHandleRows(currentVector()),
    memory: { ...ctx.memory, classes: ctx.classes, vector_readable: ctx.interaction_vector.readable },
  });
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

/**
 * The entry fork (ADR-0010): 「帮我想想做什么」 or 「我已经有想法了」.
 *
 * The fork sets the OPENING, not the product — both paths converge on the same
 * conversation by turn three, and neither creates a second kind of course. The
 * first sends one plain message; the second opens the composer with the
 * examples still on screen, because a teacher who already has an idea should be
 * typing it, not choosing from a menu of ours.
 */
function renderWelcome() {
  const box = el('div', 'welcome');
  box.id = 'welcome';
  box.append(el('h2', 'welcome-title', '我在，随时可以开始。'));
  box.append(el('p', 'welcome-note',
    '我是陪跑智能体，陪你把身边的本土资源慢慢长成孩子的课程。不用先准备什么材料——两条路都行：'));

  const fork = el('div', 'entry-fork');
  const askMe = el('button', 'entry-fork-btn', '帮我想想做什么');
  askMe.type = 'button';
  askMe.addEventListener('click', () => {
    logEvent('user_input', 'entry_fork', { choice: 'help_me_think' });
    send('帮我想想做什么。我们班还没定主题，你先问我几句吧。');
  });
  const haveIdea = el('button', 'entry-fork-btn', '我已经有想法了');
  haveIdea.type = 'button';
  haveIdea.addEventListener('click', () => {
    logEvent('user_input', 'entry_fork', { choice: 'have_idea' });
    inputEl.placeholder = '说说你的想法——想做什么主题，班里是什么情况都行';
    inputEl.focus();
  });
  fork.append(askMe, haveIdea);
  box.append(fork);
  box.append(el('p', 'welcome-note entry-fork-hint', '直接在下面说就行，比如：'));

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
 * @param {{animate?: boolean, turnIndex?: number}} [opts] turnIndex ties this
 *   group to its receipt line (ADR-0010 §7)
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

  // The receipt line: what this turn WROTE. An event, not a message — it is
  // re-rendered from cst.receipts on every replay and never enters `transcript`.
  if (typeof opts.turnIndex === 'number') appendTurnReceipt(group, opts.turnIndex);

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

/**
 * Render the transcript for the conversation currently open.
 *
 * ONE LOG, FILTERED (ADR-0010 §1). In node mode this shows only the rows filed
 * under that node; at course level it shows everything, including rows written
 * inside a node — the course view IS the log, and node views are windows onto
 * it. Rows written before subjects existed read as course-level, so there is no
 * migration and no gap in history.
 */
function replayTranscript() {
  cardViewSyncs.clear(); // stale DOM renderers must not receive sync nudges
  refreshBlueprintPanel(); // any path that re-renders the chat re-syncs the living plan
  messagesEl.replaceChildren();
  refreshClassHeader();
  refreshLanding();
  if (!transcript.length) {
    renderWelcome();
    maybeAskClass();
    showRescuedComments();
    return;
  }
  const subject = activeSubject();
  const shown = filterBySubject(transcript, subject);
  if (!shown.length) {
    messagesEl.append(el('div', 'awaiting-note',
      '这一项下面还没有聊过。在下面说一句，就从这里开始。'));
  }
  // Indices are into the FULL transcript: a receipt belongs to the turn that
  // produced it, whichever view is on screen.
  const indexOf = new Map(transcript.map((entry, i) => [entry, i]));
  for (const entry of shown) {
    if (entry.role === 'user') {
      messagesEl.append(renderTeacherMessage(entry.content, { onRetry: fillComposer }));
    } else if (entry.ev) {
      clearAwaitingNotes();
      renderTurnGroup(entry.ev, { animate: false, turnIndex: indexOf.get(entry) });
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
  // In a FILTERED view the last rendered group may not be the last transcript
  // entry, so the live set is recognised by identity, not by position.
  const lastShown = shown[shown.length - 1];
  const groups = messagesEl.querySelectorAll('.turn-group');
  const lastGroup = groups[groups.length - 1] ?? null;
  const lastIsOpenAgentTurn = Boolean(last?.ev) && lastShown === last;
  for (const set of messagesEl.querySelectorAll('.qcards')) {
    if (!lastIsOpenAgentTurn || !lastGroup || !lastGroup.contains(set)) freezeQuestionCards(set);
  }
  // The class question sits at the END of the conversation, where the next turn
  // is, rather than at the top where it would read as a gate on entry.
  maybeAskClass();
  showRescuedComments();
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
 * Assemble the /api/chat body: which provider to use, a model override when the
 * teacher picked one that differs from the provider default, and the custom
 * endpoint config when provider === 'custom'.
 *
 * NO KEY MATERIAL, on any branch (ADR-0013 §4). The server resolves the key
 * from the account vault, then its env; the browser only names the provider.
 * A `keys` field must never reappear here — demo/tests/key-custody.test.mjs
 * executes this function and inspects what it builds.
 * @param {string} text
 */
function chatRequestBody(text) {
  const body = {
    state: courseState,
    history: wireHistory(),
    message: text,
    provider,
    // WHICH CONVERSATION THIS TURN BELONGS TO (ADR-0010 §1). The server stores
    // it on the message row and prompt-builder renders the focus band from it.
    // Until this line existed every row was course-level, the focus band never
    // rendered in production, and node conversations could not be filtered
    // after a reload — the feature read as broken while every unit test passed.
    subject: activeSubject(),
  };
  const prof = profileForRequest();
  if (prof) body.profile = prof;
  if (devMode) body.debug = true;
  // Per-provider capability toggles. 联网搜索 is live for GLM/Z.AI (the server
  // runs the retrieval itself, ADR-0012 §6); 深度思考 still rides along unread.
  const caps = providerCaps[provider];
  if (caps && (caps.webSearch || caps.thinking)) body.caps = { ...caps };
  if (provider === 'custom') {
    // Address and model only. The custom endpoint's key is a vault entry under
    // the id 'custom'; the server pairs the two.
    body.custom = { baseURL: customCfg.baseURL, model: customCfg.model, label: customCfg.label || undefined };
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
    else if (name === 'memory') handleMemoryEvent(data);
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
    // The body carries no key material any more (ADR-0013 §4), but the redactor
    // stays: it is the belt to that braces, and it costs one call.
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

  // Snapshot BEFORE the turn lands: applyPlanDelta is forward-only and there is
  // no inverse, so undo restores this rather than recomputing anything.
  const stateBefore = structuredClone(courseState);
  courseState = ev.state;
  lastEvent = ev;
  lastTurnHadQuestion = Boolean(ev.turn?.question);
  // Both rows carry the subject so a localStorage-only course can be filtered
  // too. Rows written before this build have none, and read as course-level.
  const subject = activeSubject();
  transcript.push(
    { role: 'user', content: userText, subject },
    { role: 'assistant', content: ev.turn.reply_markdown, ev, subject },
  );
  const assistantIndex = transcript.length - 1;
  save(LS.state, courseState);
  save(LS.transcript, transcript);
  pendingMessage = null;
  // The receipt for this turn: engine-derived, or nothing at all when the turn
  // only talked.
  issueReceipt(stateBefore, courseState, assistantIndex);
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
  renderTurnGroup(ev, { animate: true, turnIndex: assistantIndex });
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

/**
 * The `memory` SSE event: what this turn filed, refused and archived.
 *
 * WHAT SHE SEES, AND WHY IT IS NOT EVERYTHING. A capture gets a receipt with
 * 撤销 in the same tap, because undo at the moment of capture is what makes
 * automatic extraction safe — a wrong fact has to die while she is still looking
 * at it. An archive is STATED, never silent: a child-claim archive says why in
 * the agent's own words, a cap archive shows capFacts' own notice.
 *
 * REFUSALS GO TO THE LOG, NOT TO A TOAST, and that is a deliberate line. A
 * refusal here is the server declining something the MODEL proposed and she
 * never asked for; she holds no belief about it that could go wrong, so a toast
 * would be teaching her our internals instead of answering a question she has.
 * Every one is logged (category 「记忆与画像」) and counted in the drawer, so
 * nothing is swallowed — it is just not shouted.
 * @param {{recorded?: Array, refused?: Array, archived?: Array, notice?: string}} memory
 */
function handleMemoryEvent(memory) {
  const recorded = memory?.recorded ?? [];
  const refused = memory?.refused ?? [];
  const archived = memory?.archived ?? [];
  logEvent('memory', 'memory_turn', {
    recorded: recorded.map((r) => ({ id: r.id, kind: r.kind, text: r.text, action: r.action })),
    refused: refused.map((r) => ({ reason: r.reason, text: r.text })),
    archived: archived.map((r) => ({ id: r.id, kind: r.kind, text: r.text, reason: r.reason })),
    notice: memory?.notice ?? '',
  });
  for (const row of recorded) {
    if (row.action !== 'added' || !row.id) continue;
    memoryToast(`记住了：${row.text}`, {
      onUndo: () => forgetFact({ id: row.id, kind: row.kind, text: row.text, scope: 'course' }, { via: 'receipt_undo', repaint: false }),
    });
  }
  for (const row of archived) {
    memoryToast(row.message || '这一条记下了，但没有进记忆');
  }
  // The server just changed what it is carrying — re-read rather than patch a
  // local copy, so the pane and the export show the record.
  loadMemory().then(() => { buildMemoryPane(); refreshDebug(); });
}

/** A memory receipt as a toast. Uses the receipt renderer so 记住了 looks like
 * every other 「this turn wrote something」 line (ADR-0010 §7), with `label`
 * carrying the sentence. */
function memoryToast(label, opts = {}) {
  const host = $('#toast-host');
  if (!host) return;
  const receipt = {
    id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    parts: [{ kind: 'memory', label }],
    undoable: Boolean(opts.onUndo),
  };
  const toast = renderReceiptToast(receipt, {
    timeoutMs: TOAST_MS,
    onUndo: opts.onUndo ? () => { opts.onUndo(); toast.remove(); } : undefined,
    onDismiss: () => toast.remove(),
  });
  host.append(toast);
  setTimeout(() => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 200);
  }, TOAST_MS);
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

/** One 深度思考/联网搜索 switch row. Persists to cst.providerCaps and rides the
 * turn as `body.caps`. 联网搜索 is LIVE for the providers in web-search.mjs
 * (server-side retrieval, ADR-0012 §6); 深度思考 is still consumed by nothing.
 * Rendered in BOTH panels — the drawer row and the model card — kept in sync. */
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
  } else if (supportsWebSearch(pid)) {
    // LIVE since 2026-07-29 (ADR-0012 §6): the server runs the retrieval itself
    // before the model call, with a query it composes, and only while the course
    // is still taking shape — so it reads the resource for you rather than
    // becoming a general search box.
    desc = '开始一个新主题时，先帮你查一遍公开资料';
  } else {
    desc = unavailableReason(pid); disabled = true; checked = false;
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

/**
 * Why there is no key box right now, in one plain sentence.
 *
 * ADR-0013 §4 removed the browser key path, so when the account vault is out of
 * reach a key simply cannot be entered here. Saying that is the point: silently
 * showing a dead input, or a 未配置 badge with no explanation, is the "degrade
 * quietly" behaviour the ADR is against.
 * @param {boolean} hasEnvKey  the server already holds a platform key for this provider
 */
function keyPathNote(hasEnvKey) {
  if (hasEnvKey) return '服务器已经配好这个服务的密钥，可以直接使用。';
  if (!backendOnline) return '这个页面没有连上后端，密钥只保存在服务器上的账号里，所以这里无法填写。想体验完整流程请选「演示模式」。';
  if (!me) return '密钥只保存在你的账号里。请先登录，登录后可以在这里填写。';
  if (!keyVaultOn) return '这台服务器还没有开启账号密钥保管，只能使用服务器已经配好的服务。请联系管理员。';
  return '这个服务现在没有可用的密钥。';
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

  // The account vault is the only place a typed key can go. Without it there is
  // no input at all — not a disabled one, not one that quietly writes to this
  // browser (ADR-0013 §4).
  const vaultMode = serverKeyMode();
  /** Live value of the vault box, for the 获取模型 probe. Always '' without one. */
  let typedKey = () => '';
  if (!vaultMode) {
    details.append(el('p', 'settings-note', keyPathNote(info.hasEnvKey)));
  } else {
    const keyNote = el('div', 'inline-error key-note');
    keyNote.hidden = true;
    const note = (msg, ok = false) => {
      keyNote.textContent = msg;
      keyNote.classList.toggle('ok-note', Boolean(ok));
      keyNote.hidden = !msg;
    };
    const { field: keyField, input: keyInput } = settingsField('API 密钥', `key-${info.id}`, {
      // Write-only vault field: never pre-filled, never readable back.
      type: 'password',
      hint: '密钥保存在你的账号里，保存后不再显示',
      placeholder: serverKeyFlags[info.id] ? '已保存——输入新密钥可替换' : '在这里粘贴密钥，回车保存',
      value: '',
    });
    typedKey = () => keyInput.value.trim();
    details.append(keyField);
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
    details.append(removeBtn, keyNote);
  }

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
    // A key typed into the vault box but not yet saved still works for this
    // probe — it is on its way to our own server either way, and never came
    // from browser storage. Absent, the server falls back to the vault, then
    // env; with no key anywhere it answers 缺少 API 密钥 rather than guessing.
    modelsBody: () => ({ provider: info.id, key: typedKey() || undefined }),
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

  // The custom endpoint's key is a vault entry under the id 'custom' — the same
  // single path as every other provider (ADR-0013 §4). Address and label are
  // configuration, not secrets, so those stay local.
  const customVault = serverKeyMode();
  /** Live value of the vault box, for the 获取模型 probe. Always '' without one. */
  let typedKey = () => '';
  const fields = [
    ['baseURL', '接口地址（baseURL）', 'text', '如 https://api.example.com/v1'],
    ['label', '名称（可选）', 'text', '显示在调试信息里'],
  ];
  if (!customVault) {
    details.append(el('p', 'settings-note', keyPathNote(false)));
  } else {
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
    typedKey = () => input.value.trim();
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
      // Same rule as every other provider: only a key the teacher is typing
      // into the vault box right now, never one read back from this browser.
      key: typedKey() || undefined,
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

  // ---- 回应风格: the seven presets as a SHORTCUT, then the six handles ----
  //
  // The presets are a migration promise, not a mode (ADR-0009 §1): a teacher
  // already on 极简速览 must behave identically until she touches a handle. So
  // picking one still writes `stylePref` — the legacy prompt line and the
  // harness's style proxies both read it — AND pins all six axes at once, which
  // is what a named choice actually is.
  pane.append(selectField('回应风格（先选个大方向）', 'profile-style', RESPONSE_STYLES, profile.stylePref ?? '', (v) => {
    const before = currentVector();
    profile.stylePref = v;
    const next = v ? vectorFromPreset(v) : null;
    if (next) profile.interaction_vector = next;
    saveProfile();
    logEvent('memory', 'axis_preset', {
      preset: v,
      axes: next ? Object.keys(PRESET_VECTORS[v].axes).map((a) => axisChangeEvent(a, before, next, { signal: 'preset_chosen' })) : [],
    });
    buildProfilePane(pane);
    refreshDebug();
  }, {
    titles: STYLE_DIRECTIVES,
    describe: (v) => (v ? `会这样要求陪跑智能体：${STYLE_DIRECTIVES[v]}` : '选一个大方向，下面六项会跟着动；也可以只调下面某一项。'),
  }));

  // The six handles. THE PANE OPENS SHOWING WHAT THE AGENT ALREADY BELIEVES AND
  // WHY — that is what makes moving one a correction of a stated belief rather
  // than the completion of an empty form (ADR-0009 §4). Nothing is written until
  // she moves something: see currentVector() for why the derived value stays
  // derived.
  const axisField = el('div', 'settings-field');
  axisField.append(el('label', 'settings-label', '细调：六项互动偏好'));
  axisField.append(el('p', 'settings-note',
    '下面每一项都写着现在是什么、这个判断是哪来的。看着不对就拨一下——拨过的那一项我不再自己改，除非你交回给我。'));
  axisField.append(renderAxisHandles(axisHandleRows(currentVector()), {
    onSet: (axis, value) => {
      const before = currentVector();
      const after = pinAxis(before, axis, value);
      profile.interaction_vector = after;
      saveProfile();
      // The audit trail behind the profiling: axis, from, to, source,
      // confidence and the signal. An agent that profiles its user and cannot
      // show its work is a trust defect regardless of accuracy.
      logEvent('memory', 'axis_pinned', axisChangeEvent(axis, before, after, { signal: 'teacher_set_handle' }));
      buildProfilePane(pane);
      refreshDebug();
    },
    onUnpin: (axis) => {
      const before = currentVector();
      const after = unpinAxis(before, axis);
      profile.interaction_vector = after;
      saveProfile();
      logEvent('memory', 'axis_unpinned', axisChangeEvent(axis, before, after, { signal: 'teacher_released_handle' }));
      buildProfilePane(pane);
      refreshDebug();
    },
  }));
  pane.append(axisField);

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
    // Two different empty states, and conflating them is the quiet-degrade
    // failure ADR-0013 §4 warns about: 「go fill in a key」 is useless advice
    // when this browser has nowhere to put one.
    pane.append(el('p', 'settings-note', serverKeyMode()
      ? '还没有配置任何服务。在下方「接入与服务」里填好一个密钥，这里就会出现对应的模型卡。'
      : '还没有可用的服务。密钥只保存在服务器上的账号里，这个浏览器不再保存密钥——请先登录，或请管理员在服务器上配好密钥。现在可以用「演示模式」体验完整流程。'));
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
        // The store has carried `subject` since ADR-0010; rows written before
        // it default to course level via normalizeSubject, so old history needs
        // no migration and never disappears from the course view.
        subject: normalizeSubject(m.subject),
        ev: {
          turn: tc,
          gate_report: { ok: true, violations: [] },
          state: { awaiting_feedback: Boolean(tc.round_complete) && evidenceSeen },
          provider: m.provider ?? null,
          providerLabel: m.provider_label ?? null,
          usage: m.usage ?? null,
          cache: m.cache ?? null,
          guards: m.guards ?? [],
          stageName: m.stage_name ?? null,
        },
      });
    } else {
      out.push({ role: 'user', content: m.content, subject: normalizeSubject(m.subject) });
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
  // WHICH CLASS THIS COURSE IS FOR comes off the course record, never off a
  // cached guess: it decides which class-scope memory the turn can see, so a
  // stale value would show her constraints that are not in this course's prompt.
  courseClassId = course?.class_id ?? null;
  landingDismissed = false;   // a different course is a different landing
  await loadMemory();
  transcript = messagesToTranscript(msgs || []);
  lastEvent = null;
  lastTurnHadQuestion = Boolean(transcript[transcript.length - 1]?.ev?.turn?.question);
  save(LS.state, courseState);      // localStorage stays a cache of the active course
  save(LS.transcript, transcript);
  planKey = '';                     // a different plan is a different panel
  applyNodeMode();                  // the stored subject may not exist in THIS plan
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

// ------------------------------------------- 记忆 + 班级 wiring (ADR-0011)
//
// EVERY NETWORK CALL FOR THIS FEATURE LIVES IN THIS BLOCK. The renderers are
// DOM-pure and memory-view.mjs is pure logic; one place that talks to the server
// is what keeps the 「null is not []」 rule enforceable, because there is exactly
// one place that could break it.

/** The vector the pane and the prompt both read.
 *
 * DERIVED FOR DISPLAY, NOT WRITTEN. Nothing persists a vector until she moves a
 * handle: the seven presets are a migration promise (ADR-0009 §1 — a teacher on
 * 极简速览 must behave identically until she touches something), and writing a
 * vector on first paint would quietly convert every stored profile into a new
 * representation whose failure mode nobody has seen yet. */
function currentVector() {
  if (isReadableVector(profile.interaction_vector)) return profile.interaction_vector;
  return (profile.stylePref && vectorFromPreset(profile.stylePref)) || defaultVector();
}

/** Everything the debug drawer and the export need to say what the agent is
 * carrying right now — counts and provenance, never fact bodies (the session-log
 * events already carry those). */
function memoryContext() {
  return memorySnapshot({
    facts: memoryFacts,
    vector: currentVector(),
    classes: myClasses,
    courseClassId,
  });
}

/**
 * Read this course's memory and her class list.
 *
 * A FAILURE LEAVES `memoryFacts` NULL AND SAYS SO. It is never set to `[]` on
 * any path in this function — see the state declaration for why that is a
 * security property rather than an assertion aid.
 */
/** Said in one place so the pane, the drawer and the log cannot disagree about
 * what the no-backend tier actually offers. */
const MEMORY_NEEDS_ACCOUNT = '记忆要有账号才存得住。现在是演示模式，对话只留在这台机器上，我不会记住班里的条件。';

async function loadMemory() {
  if (!persistenceActive() || !activeCourseId) {
    memoryFacts = null;
    memoryError = '';   // not a failure: buildMemoryPane states the tier instead
    myClasses = [];
    return;
  }
  try {
    const res = await fetch(apiUrl(`/api/memory?course_id=${encodeURIComponent(activeCourseId)}&include_archived=1`), { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.message || `服务返回 ${res.status}`);
    memoryFacts = Array.isArray(data.facts) ? data.facts : null;
    myClasses = Array.isArray(data.classes) ? data.classes : [];
    memoryError = memoryFacts ? '' : '这次没读到记忆（不是没有，是没读到）。';
    logEvent('memory', 'memory_loaded', memoryContext());
  } catch (err) {
    memoryFacts = null;
    memoryError = '这次没读到记忆。不是「没有记住什么」，是没读到——过一会儿再看看。';
    logEvent('error', 'memory_load_failed', { course_id: activeCourseId, message: err?.message ?? String(err) });
  }
}

/** POST one memory mutation; reload afterwards so the page shows the record
 * rather than an optimistic guess about it. */
async function memoryPost(path, body) {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.message || `服务返回 ${res.status}`);
  return data;
}

/** 忘掉 — an archive, never a delete (there is no delete grant, by design), so
 * the row stays visible in 已归档 with 「你让我忘掉的」 beside it. */
async function forgetFact(fact, opts = {}) {
  try {
    const data = await memoryPost(`/api/memory/${encodeURIComponent(fact.id)}/archive`);
    logEvent('memory', 'memory_forgotten', {
      fact_id: fact.id, kind: fact.kind, scope: fact.scope, text: fact.text, via: opts.via ?? 'viewer',
    });
    await loadMemory();
    if (opts.repaint !== false) buildMemoryPane();
    return data.fact ?? null;
  } catch (err) {
    logEvent('error', 'memory_forget_failed', { fact_id: fact?.id ?? null, message: err?.message ?? String(err) });
    if (opts.repaint !== false) buildMemoryPane(String(err?.message ?? '这一下没成功，稍后再试。'));
    return null;
  }
}

/** 扩大 — one rung, and the rung came from `widenOffer`, so the button that
 * exists and the step the server accepts cannot disagree. */
async function widenFactTo(fact, offer) {
  try {
    await memoryPost(`/api/memory/${encodeURIComponent(fact.id)}/widen`, {
      to_scope: offer.to, class_id: offer.classId,
    });
    logEvent('memory', 'memory_widened', {
      fact_id: fact.id, from: fact.scope, to: offer.to, class_id: offer.classId, text: fact.text,
    });
    await loadMemory();
    buildMemoryPane();
  } catch (err) {
    logEvent('error', 'memory_widen_failed', { fact_id: fact?.id ?? null, to: offer?.to ?? '', message: err?.message ?? String(err) });
    buildMemoryPane(String(err?.message ?? '这一下没成功，稍后再试。'));
  }
}

/** 改一下 — hands a sentence to the composer and gets out of the way. There is
 * no update method behind this and there must not be one: a fact carries her own
 * words as its quote, so a correction has to be said, not typed into a field
 * (memory-view.mjs records the full reasoning). */
function startFactCorrection(fact) {
  closeDrawers();
  fillComposer(correctionPrompt(fact));
  logEvent('memory', 'memory_correction_started', { fact_id: fact.id, kind: fact.kind, text: fact.text });
}

/** The 记忆 pane. Rebuilt on every open and after every mutation, because it
 * shows a server record and a stale copy of a record is a claim. */
function buildMemoryPane(errorOverride) {
  const pane = $('#pane-memory');
  if (!pane) return;
  const bound = myClasses.find((k) => k.id === courseClassId) ?? null;
  const grouped = groupMemory(memoryFacts);
  pane.replaceChildren(renderMemoryView(grouped, {
    classId: courseClassId,
    className: bound?.name ?? '',
    // On the no-backend tier there is no memory to fail at reading. Saying
    // 「没读到」 there would report a fault that did not happen and would send her
    // looking for a problem she cannot fix; this states the tier instead.
    unavailable: persistenceActive() ? '' : MEMORY_NEEDS_ACCOUNT,
    error: errorOverride || memoryError || '',
    onForget: (fact) => forgetFact(fact),
    onWiden: (fact, offer) => widenFactTo(fact, offer),
    onCorrect: startFactCorrection,
    note: bound
      ? `这门课记在「${bound.name}」名下。扩大到班级的条目，这个班的其他课程也会带上。`
      : '这门课还没有认到某个班上。认了之后，班上的条件换一门课也还算数。',
  }));
}

// ---- classes: bound silently at one, asked only at two or more ----

/** PUT the binding and mirror it locally. Returns true on success. */
async function bindCourseClass(classId, via) {
  if (!persistenceActive() || !activeCourseId) return false;
  try {
    const res = await fetch(apiUrl(`/api/courses/${activeCourseId}/class`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ class_id: classId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.message || `服务返回 ${res.status}`);
    courseClassId = data.course?.class_id ?? classId;
    logEvent('memory', 'course_class_bound', { course_id: activeCourseId, class_id: courseClassId, via });
    await loadMemory();   // class-scope memory only becomes readable once bound
    return true;
  } catch (err) {
    logEvent('error', 'course_class_bind_failed', { course_id: activeCourseId, class_id: classId, message: err?.message ?? String(err) });
    return false;
  }
}

/**
 * The class question, asked ONLY when it is a real question.
 *
 * One class binds silently — a teacher with one class being asked which class
 * this is would be filling in a field the system already knows, which is the
 * form-filling this product exists not to do (non-negotiable #2). Zero classes
 * is silent too: there is nothing to pick, and there is deliberately no
 * 新建班级 control, because a class comes into being by her NAMING one in
 * conversation (ADR-0011 §3).
 */
function maybeAskClass() {
  if (!persistenceActive() || !activeCourseId) return;
  const course = { class_id: courseClassId };
  const silent = silentClassBinding(myClasses, course);
  if (silent) { bindCourseClass(silent, 'silent_single_class').then(() => refreshClassHeader()); return; }
  if (!shouldAskClass(myClasses, course)) return;
  if (classAskDismissed.has(courseKey())) return;
  if (activeSubject() !== COURSE_SUBJECT) return;   // a node conversation is not where a course gets its class
  messagesEl.append(renderClassChoice(myClasses, {
    onPick: async (classId) => {
      const ok = await bindCourseClass(classId, 'picker');
      if (ok) { refreshClassHeader(); replayTranscript(); }
    },
    onSkip: () => {
      classAskDismissed.add(courseKey());
      logEvent('memory', 'course_class_skipped', { course_id: activeCourseId });
      replayTranscript();
    },
  }));
}

/** The header states which class this course is for — a fact she can tap, never
 * a question. Hidden when there is nothing true to say. */
function refreshClassHeader() {
  const host = $('#class-header-slot');
  if (!host) return;
  const bound = courseClassId ? myClasses.find((k) => k.id === courseClassId) : null;
  if (!bound) { host.replaceChildren(); host.hidden = true; return; }
  host.replaceChildren(renderClassHeader({ id: bound.id, name: bound.name }, {
    onChange: myClasses.length > 1 ? () => {
      classAskDismissed.delete(courseKey());
      courseClassId = null;
      replayTranscript();
    } : undefined,
  }));
  host.hidden = false;
}

// ---- the landing (mobile): what she sees depends on where the course is ----

const LANDING_MQ = window.matchMedia('(max-width: 1099px)');
/** Session-only, deliberately: a dismissal is not a decision, and persisting it
 * would silently stop answering 「今天要做什么」 for good. */
let landingDismissed = false;
let lastLandingSig = '';

/**
 * Paint the landing card.
 *
 * MOBILE ONLY, and only for a course that has actually started. On desktop the
 * 工作台 already sits beside the conversation, so a second copy of the same
 * information would be noise; and `fork` mode is not drawn here at all because
 * renderWelcome() already IS the entry fork — two forks on one screen is the app
 * asking the same question twice.
 */
function refreshLanding() {
  const host = $('#landing');
  if (!host) return;
  const landing = landingModel(courseState, { transcript });
  const hide = landingDismissed
    || !LANDING_MQ.matches
    || landing.mode === 'fork'
    || activeSubject() !== COURSE_SUBJECT;
  if (hide) { host.hidden = true; host.replaceChildren(); return; }
  // The step-zero rows come from the SAME derivation the 工作台 checklist uses,
  // so the phone and the panel can never disagree about what is still unknown —
  // and 已知 still means the teacher said it, because that gate lives inside
  // stepZeroStatus rather than in either renderer.
  const missing = landing.mode === 'step_zero'
    ? stepZeroStatus(courseState).items.filter((i) => !i.known).map((i) => ({ key: i.key, label: i.label }))
    : [];
  host.replaceChildren(renderLanding(landing, {
    missing,
    recent: landing.mode === 'plan' ? recentStripEntries() : [],
    onOpenNode: (id) => setSubject(id, { from: 'landing' }),
    onContinue: () => inputEl.focus(),
    onOpenPanel: () => openBlueprintPanel(),
    onDismiss: () => {
      landingDismissed = true;
      logEvent('workflow', 'landing_dismissed', { mode: landing.mode });
      refreshLanding();
    },
  }));
  host.hidden = false;
  // One line per real change — the observability duty for a surface that is
  // screen furniture and is stored nowhere else.
  const sig = [landing.mode, landing.today.length, landing.overdue.length, landing.undated,
    missing.map((m) => m.key).join(',')].join('|');
  if (sig !== lastLandingSig) {
    lastLandingSig = sig;
    logEvent('workflow', 'landing_shown', {
      mode: landing.mode,
      today: landing.today.length,
      overdue: landing.overdue.length,
      next_in_days: landing.next?.days ?? null,
      undated: landing.undated,
      missing: missing.map((m) => m.key),
      plan_version: landing.version,
    });
  }
}

// ------------------------------------------------ 工作台 (ADR-0010, Workflow v2)
// The living 课程计划树: renders course_state.course_plan — 月计划（2–5 周的一
// 段，不是自然月）→ 周计划 → 活动, with an activity's date as a FIELD on its
// row. Numbering, fold state and the two status axes are all reconstructed
// client-side (plan-view.mjs derives, render.js draws, this file wires).
//
// THE PANEL IS READ-ONLY. Three interactions and no more: open a node's
// conversation on the left, fold a branch, zoom 导图. There is no ✓确认, no
// 批注, no filter, no bulk action and no tab — every one of those was an input
// surface on a surface that does not take input (ADR-0010 §3/§6). What replaced
// them lives in the conversation: citation-backed confirmation, node
// conversations, and the pending-card strip above the composer.

let bpTab = load(LS.bpTab, 'list');
let bpHidden = load(LS.bpHidden, false);
/** Digest of everything the panel DRAWS — not `course:version:tab`. The old key
 * missed every change that did not bump the version (a 待复查 badge appearing, a
 * message count going 0 → 1, the open-node highlight moving), so the panel
 * simply did not repaint. planRenderKey() owns the digest; this holds the last
 * one rendered. */
let planKey = '';

// -- per-course client stores (all keyed by courseKey(), all Workflow v2) --
/** {[course]: nodeId|'course'} — the conversation she is in. Written ONLY from
 * a UI selection (a node click, a recent chip, the chip's ✕); never from model
 * output. Persisted so a reload returns her to the node she was reading. */
let subjectByCourse = load(LS.subject, {});
/** {[course]: [{id, number, title, at}]} — the 最近处理 strip, newest first. */
let nodeRecent = load(LS.nodeRecent, {});
/** {[course]: [nodeId]} — collapsed branches. VIEW STATE, deliberately not
 * exported: it carries no teacher decision and no course content, and is fully
 * reconstructible from the tree (same class as cst.bpW). */
let planFold = load(LS.planFold, {});
/** {[course]: number} — 导图 scale, 0.5–2.0. View state, same reasoning. */
let planZoom = load(LS.planZoom, {});
/** {[course]: [receipt]} — the receipt ledger behind the toast and the per-turn
 * line. Each entry may carry `state_before`, a structuredClone of course_state
 * taken BEFORE the turn was applied, because applyPlanDelta is forward-only and
 * undo must restore rather than recompute. Only the newest few keep it. */
let receiptsByCourse = load(LS.receipts, {});
/** How many receipts keep their `state_before` snapshot. Older ones keep the
 * summary (the record survives) and drop the state (the memory does not). */
const RECEIPT_SNAPSHOT_KEEP = 10;

// -- living question-card answer set (§5c): ONE set per course (only the
// newest agent turn collects answers). The 问题卡 TAB is gone; the cards
// themselves live on in the conversation with a pending strip above the
// composer. Survives reloads via localStorage.
let qcardSets = load(LS.qcards, {});
const cardViewSyncs = new Set(); // live renderers to repaint after a cross-view edit
function cardSetSig(questions) { return (questions || []).map((q) => q.text).join(''); }
function activeCardSet() { return qcardSets[courseKey()] ?? null; }
function setActiveCardSet(set) {
  const key = courseKey();
  if (set) qcardSets = { ...qcardSets, [key]: set };
  else { qcardSets = { ...qcardSets }; delete qcardSets[key]; }
  save(LS.qcards, qcardSets);
  cardViewSyncs.clear();
}
function onCardChange() {
  save(LS.qcards, qcardSets);
  for (const fn of cardViewSyncs) { try { fn(); } catch { /* view left the DOM */ } }
  refreshStageTray();
  refreshPendingStrip();
  refreshWorkbenchBadges();
  scheduleWorkbenchMirror();
}

// ------------------------------------------------------------- subject (§1)

/** The subject this browser has selected for the active course, dropped back to
 * course level when it points at a node the plan no longer has (a stale id
 * would filter the transcript to nothing and file her next message where nobody
 * will look). */
function activeSubject() {
  return resolveSubject(subjectByCourse[courseKey()], courseState?.course_plan);
}
/** Node ids → how many local transcript rows are filed under each. Entries
 * written before subjects existed default to 'course' (normalizeSubject), so
 * there is no migration. */
function subjectCounts() {
  return messageCountsBySubject(transcript);
}

/**
 * Switch the conversation the left panel is showing.
 * `to` is a node id or COURSE_SUBJECT. Nothing here transmits: the subject
 * rides the NEXT send, and the transcript re-renders as a filtered view of the
 * one log (ADR-0010 §1 — node conversations are views, never second threads).
 * @param {string} to
 * @param {{from?: string, scroll?: boolean}} [opts]
 */
function setSubject(to, opts = {}) {
  const key = courseKey();
  const want = resolveSubject(to, courseState?.course_plan);
  const before = activeSubject();
  subjectByCourse = { ...subjectByCourse, [key]: want };
  save(LS.subject, subjectByCourse);
  if (want === COURSE_SUBJECT) {
    if (before !== COURSE_SUBJECT) logEvent('workflow', 'subject_change', { from: before, to: want });
  } else {
    const ctx = nodeContext(courseState?.course_plan, want);
    logEvent('workflow', 'node_opened', {
      course_id: courseState?.course_id ?? null,
      node_id: want,
      number: ctx?.number ?? '',
      from: opts.from ?? 'panel',
    });
    if (ctx) {
      nodeRecent = {
        ...nodeRecent,
        [key]: mergeRecent(nodeRecent[key], {
          id: want, number: ctx.number, title: ctx.node.title, at: new Date().toISOString(),
        }, { limit: RECENT_MAX }),
      };
      save(LS.nodeRecent, nodeRecent);
    }
  }
  planKey = ''; // the open-node highlight and the recent strip both moved
  applyNodeMode();
  replayTranscript();
  refreshBlueprintPanel();
  if (opts.scroll !== false) scrollToEnd();
}

/** Paint everything that depends on WHICH conversation is open: the node view
 * above the transcript, the composer's subject chip, the static greeting. */
function applyNodeMode() {
  const subject = activeSubject();
  const inNode = subject !== COURSE_SUBJECT;
  document.body.classList.toggle('node-mode', inNode);
  const view = $('#node-view');
  const body = $('#node-view-body');
  const chip = $('#subject-chip');
  const chipTitle = $('#subject-chip-title');
  const greeting = $('#node-greeting');
  if (!inNode) {
    if (view) view.hidden = true;
    if (body) body.replaceChildren();
    if (chip) chip.hidden = true;
    if (greeting) { greeting.hidden = true; greeting.textContent = ''; }
    return;
  }
  const ctx = nodeContext(courseState?.course_plan, subject);
  if (!ctx) { setSubject(COURSE_SUBJECT, { from: 'missing_node' }); return; }
  if (view) view.hidden = false;
  if (body) {
    // ctx.node is the NORMALIZED node and that is all there is: a plan node
    // has no `rationale` field (contract.zh.md puts its 依据 in the body, and
    // normalizePlan drops every other key), so there is no raw copy to go
    // looking for.
    body.replaceChildren(renderNodeDetail(ctx.node, {
      number: ctx.number,
      ancestors: ctx.ancestors,
      related: relatedNodes(subject),
      onOpenNode: (id) => setSubject(id, { from: 'node_view' }),
      // onClose deliberately NOT passed: #node-view-close in index.html is the
      // one close affordance, and two of them is two things to keep in sync.
    }));
  }
  if (chip && chipTitle) {
    chipTitle.textContent = `${ctx.number} ${ctx.node.title || '未命名'}`;
    chip.hidden = false;
  }
  if (greeting) {
    // SCREEN FURNITURE. Set here and nowhere else: never appended to the
    // transcript, never handed to logEvent, never put in a request body, never
    // exported. The node_opened event above is what makes the open observable.
    greeting.textContent = pickGreeting(ctx.node.title, greetingSeed);
    greeting.hidden = false;
  }
}
/** Rotates so a re-open greets differently; seeded (not Math.random) so a given
 * open is reproducible within the session. */
let greetingSeed = 0;

/** Siblings of a node — the cheapest honest 「相关的项」: they are in the plan,
 * so nothing here is inferred. */
function relatedNodes(nodeId) {
  const model = planViewModel(courseState);
  const me2 = model.byId.get(nodeId);
  if (!me2) return [];
  return model.nodes
    .filter((n) => n.parentId === me2.parentId && n.id !== nodeId)
    .slice(0, 6)
    .map((n) => ({ id: n.id, number: n.number, title: n.title }));
}

// ------------------------------------------------------- step zero checklist
//
// The derivation itself is stepZeroStatus() in plan-view.mjs: pure, tested, and
// gated on teacher_resource_intent.confidence so a row reads 已知 only when the
// TEACHER said it. Everything below is the observability half.

let lastStepZeroSig = '';
/** One session-log line per real change, so a developer can see what the agent
 * believes it has — and, more to the point, what it does not. */
function logStepZero(status) {
  const known = status.items.filter((i) => i.known).map((i) => i.key);
  const missing = status.items.filter((i) => !i.known).map((i) => i.key);
  const sig = `${known.join(',')}|${missing.join(',')}`;
  if (sig === lastStepZeroSig) return;
  lastStepZeroSig = sig;
  logEvent('workflow', 'step_zero_status', { known, missing });
}

// ------------------------------------------------------------- the panel

/** Snapshot of the teacher's unsent 工作台 state. Rides the session-log export
 * and mirrors to the server (admin exports must show work-in-progress, not only
 * what was sent). 批注 left with its surface; receipts and the navigation trail
 * joined in its place. */
function workbenchSnapshot() {
  const set = activeCardSet();
  const key = courseKey();
  return {
    question_cards: set ? {
      questions: set.questions.map((q) => ({ text: q.text, ...(q.why ? { why: q.why } : {}) })),
      answers: set.answers.map((a) => ({ value: a.value, skipped: Boolean(a.skipped), locked: Boolean(a.locked) })),
    } : null,
    // Summaries only: `state_before` is a state snapshot, not a record, and has
    // no business in an export or on the wire.
    receipts: (receiptsByCourse[key] ?? []).map(({ state_before: _drop, ...r }) => r),
    // Client-only by design: a per-browser navigation trail, not course content.
    // The server can already derive a truer version from message subjects plus
    // course_plan.revision_log, so mirroring it would be a second, worse copy.
    recent_nodes: nodeRecent[key] ?? [],
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

/** Reveal the 工作台 (FAB / chat chip click-through). Below the desktop
 * breakpoint it opens as the full-height sheet. */
function openBlueprintPanel() {
  bpHidden = false;
  save(LS.bpHidden, false);
  if (!window.matchMedia('(min-width: 1100px)').matches) document.body.classList.add('bp-sheet');
  refreshBlueprintPanel();
}

/** What the mobile edge badge counts: plan nodes still unconfirmed plus nodes
 * marked 待复查. The unanswered-card count moved to #pending-strip. */
function workbenchPending() {
  const { tally } = planViewModel(courseState);
  const set = activeCardSet();
  return {
    cards: set ? set.answers.filter((a) => !a.locked).length : 0,
    planPending: tally.pending,
    stale: tally.stale,
  };
}
function refreshWorkbenchBadges() {
  const { planPending, stale } = workbenchPending();
  const b = $('#bp-fab-badge');
  if (!b) return;
  const n = planPending + stale;
  b.hidden = n === 0;
  b.textContent = String(n);
}

/** 待回答的问题卡 counter + jump-back — the slim strip that replaced the tab. */
function refreshPendingStrip() {
  const strip = $('#pending-strip');
  if (!strip) return;
  const set = activeCardSet();
  const n = set ? set.answers.filter((a) => !a.locked).length : 0;
  strip.hidden = n === 0;
  const count = $('#pending-count');
  if (count) count.textContent = `还有 ${n} 张问题卡等你回答`;
}
function jumpToPendingCards() {
  const sets = messagesEl.querySelectorAll('.qcards:not(.submitted)');
  const target = sets[sets.length - 1];
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function refreshBlueprintPanel() {
  const panel = $('#bp-panel');
  const fab = $('#btn-blueprint');
  if (!panel || !fab) return;
  // The 工作台 is permanent now: with no plan yet it shows step zero, which is
  // the thing that explains what the panel is for. It is never empty furniture.
  document.body.classList.toggle('has-bp', !bpHidden);
  fab.hidden = false;
  panel.hidden = bpHidden;
  refreshWorkbenchBadges();
  refreshStageTray();
  refreshPendingStrip();
  if (bpHidden) return;

  const key = courseKey();
  const folded = new Set(planFold[key] ?? []);
  const openNodeId = activeSubject() === COURSE_SUBJECT ? null : activeSubject();
  const model = planViewModel(courseState, {
    messageCounts: subjectCounts(),
    folded,
    openNodeId,
  });

  // 版本 pill: the PLAN's engine-owned counter (course_plan.version), not the
  // blueprint's — they are two trees and two counters.
  $('#plan-version').textContent = model.hasPlan ? `v0.${model.version}` : '';

  const desktopMap = window.matchMedia('(min-width: 880px)').matches;
  $('#plan-tab-map').hidden = !desktopMap;
  if (bpTab === 'map' && !desktopMap) bpTab = 'list';
  const viewable = model.hasPlan;
  $('#plan-view-toggle').hidden = !viewable;
  $('#plan-tab-list').classList.toggle('active', bpTab === 'list');
  $('#plan-tab-map').classList.toggle('active', bpTab === 'map');
  const zoomBox = $('#plan-zoom');
  const zoom = clampZoom(planZoom[key]);
  zoomBox.hidden = !(viewable && bpTab === 'map');
  $('#plan-zoom-reset').textContent = `${Math.round(zoom * 100)}%`;

  const tallyHost = $('#plan-head-controls');
  if (model.hasPlan) tallyHost.replaceChildren(renderPlanTally(model.tally));
  else tallyHost.replaceChildren();

  const bp = courseState?.course_plan_blueprint;
  const hasBp = Boolean(bp?.modules?.length);
  const nextKey = planRenderKey(model, {
    view: bpTab,
    openNodeId,
    extra: [key, zoom, desktopMap, hasBp ? bp.version : 'nobp', (nodeRecent[key] ?? []).map((r) => r.id).join(','),
      model.hasPlan ? '' : JSON.stringify(stepZeroStatus(courseState).items.map((i) => `${i.key}:${i.known ? 1 : 0}`))].join('~'),
  });
  if (nextKey === planKey) return; // nothing drawn has changed → keep her scroll
  planKey = nextKey;

  const body = $('#bp-panel-body');
  if (!model.hasPlan) {
    const status = stepZeroStatus(courseState);
    logStepZero(status);
    body.replaceChildren(renderStepZero(status, {
      onSampleOpen: () => logEvent('workflow', 'step_zero_sample_opened', {}),
    }));
    if (hasBp) body.append(renderCourseMaterials(bp));
    return;
  }

  body.replaceChildren(renderRecentStrip(recentStripEntries(), {
    activeId: openNodeId,
    onOpenNode: (id) => setSubject(id, { from: 'recent' }),
  }));
  body.append(renderPlanTree(model.plan, {
    numbers: model.numbers,
    view: bpTab,
    openNodeId,
    folded,
    messageCounts: subjectCounts(),
    zoom,
    // Per-course key for the 导图 FLIP cache: a repaint glides nodes from where
    // they were instead of re-growing the whole diagram, but only within the
    // same course — positions from another course's tree mean nothing here.
    mapKey: key,
    onOpenNode: (id) => setSubject(id, { from: 'plan' }),
    onToggleFold: (id, isFolded) => {
      planFold = { ...planFold, [courseKey()]: toggleFold(planFold[courseKey()], id, isFolded) };
      save(LS.planFold, planFold);
      planKey = ''; // the fold signature is part of the key; let it repaint next pass
    },
  }));
  if (hasBp) body.append(renderCourseMaterials(bp));
}

/** 课程资料: the blueprint spine, read-only, under the plan tree. It still
 * drives state, so leaving it invisible to the teacher would be the silent
 * orphaning ADR-0010 warns about — but it is not an input surface any more, so
 * it renders with NO onConfirm and NO onCommentChange. */
function renderCourseMaterials(bp) {
  const box = document.createElement('details');
  box.className = 'plan-materials';
  box.open = false;
  const numbered = numberBlueprint(normalizeBlueprint({ modules: bp.modules }).modules);
  box.append(el('summary', '', `课程资料 · 预设蓝图 v0.${bp.version}（${countUnconfirmed(numbered)} 项待确认）`));
  // Said here, next to the badges it describes, and in the 图例 too. The plan
  // tree's 已确认 is quote-checked (applyPlanDelta + confirmed_by_quote); this
  // tree's is not — absorbBlueprint still escalates a pre-existing node on any
  // teacher turn (the KNOWN GAP recorded at serve.mjs). Until that closes, the
  // app must not let a badge speak for her.
  box.append(el('div', 'plan-materials-note',
    '这里的「已确认」是我按对话推的，没有逐句核对你的原话。看着不对，在下面说一声就行。'));
  box.append(renderBlueprintList(numbered));
  return box;
}

/** 最近处理: the nodes she opened (this browser) merged with the ones the plan's
 * own revision log says were edited. Opening is not editing, which is why the
 * two sources are merged rather than one replacing the other. */
function recentStripEntries() {
  const key = courseKey();
  let list = nodeRecent[key] ?? [];
  for (const entry of recentNodes(courseState?.course_plan, { limit: RECENT_MAX })) {
    if (!list.some((r) => r.id === entry.id)) list = [...list, entry];
  }
  // Titles/numbers move with the plan; a chip must show what the tree shows.
  const model = planViewModel(courseState);
  return list
    .map((r) => {
      const row = model.byId.get(r.id);
      return row ? { ...r, number: row.number, title: row.title } : null;
    })
    .filter(Boolean)
    .slice(0, RECENT_MAX);
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
/** Rounded to two places: 0.1 steps otherwise accumulate float noise into a
 * persisted value (1.2000000000000002), which then rides the export. */
const clampZoom = (v) => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(v) || 1)) * 100) / 100;
function setPlanZoom(scale) {
  const key = courseKey();
  planZoom = { ...planZoom, [key]: clampZoom(scale) };
  save(LS.planZoom, planZoom);
  planKey = '';
  refreshBlueprintPanel();
}

// ---------------------------------------------------------- receipts (§7)
//
// Every turn that WROTE something says so: a toast with undo at the moment, and
// one compact line under that turn's reply. Both are composed from the engine's
// own record (plan before, plan after, revision log) — never from the model's
// prose — and a turn that only talked produces neither.

function receiptsFor(key) { return receiptsByCourse[key] ?? []; }
function saveReceipts(key, list) {
  // Older entries keep their summary and drop their state snapshot: the record
  // survives, the memory cost does not.
  const trimmed = list.map((r, i) => (i < RECEIPT_SNAPSHOT_KEEP ? r : (({ state_before: _d, ...rest }) => rest)(r)));
  receiptsByCourse = { ...receiptsByCourse, [key]: trimmed.slice(0, 40) };
  save(LS.receipts, receiptsByCourse);
  scheduleWorkbenchMirror();
}

/**
 * Build, record and show the receipt for one turn.
 * @param {Object} before course_state as it stood BEFORE the turn was applied
 * @param {Object} after course_state after
 * @param {number} turnIndex transcript index of the assistant entry
 */
function issueReceipt(before, after, turnIndex) {
  const receipt = summarizeTurnReceipt(before, after, {
    id: `r-${Date.now()}-${turnIndex}`,
    at: new Date().toISOString(),
    turnIndex,
  });
  if (!receipt) return null;
  // Undo restores a snapshot; on the persistence tier the server holds the
  // course record and there is no route to restore it, so offering an undo
  // there would desync the two silently. Honest until that route exists.
  receipt.undoable = !persistenceActive();
  receipt.state_before = before;
  const key = courseKey();
  saveReceipts(key, [receipt, ...receiptsFor(key)]);
  logEvent('workflow', 'receipt_issued', {
    receipt_id: receipt.id,
    parts: receipt.parts.map((p) => ({ kind: p.kind, count: p.count, node_ids: p.node_ids ?? [] })),
    undoable: receipt.undoable,
  });
  showReceiptToast(receipt);
  return receipt;
}

const TOAST_MS = 8000;
function showReceiptToast(receipt) {
  const host = $('#toast-host');
  if (!host) return;
  const toast = renderReceiptToast(receipt, {
    timeoutMs: TOAST_MS,
    onUndo: receipt.undoable ? (id) => { undoReceipt(id); toast.remove(); } : undefined,
    onDismiss: () => toast.remove(),
  });
  host.append(toast);
  setTimeout(() => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 200);
  }, TOAST_MS);
}

/** Undo: restore the snapshot taken before the turn. There is no inverse of
 * applyPlanDelta (it is forward-only), so this restores rather than recomputes. */
function undoReceipt(receiptId) {
  const key = courseKey();
  const list = receiptsFor(key);
  const hit = list.find((r) => r.id === receiptId);
  if (!hit || hit.undone || !hit.state_before) return;
  courseState = hit.state_before;
  save(LS.state, courseState);
  saveReceipts(key, list.map((r) => (r.id === receiptId ? { ...r, undone: true, state_before: null } : r)));
  logEvent('workflow', 'receipt_undone', {
    receipt_id: receiptId,
    restored_plan_version: courseState?.course_plan?.version ?? null,
  });
  planKey = '';
  applyNodeMode();
  replayTranscript();
  refreshDebug();
}

/** The compact line under a turn's reply. An EVENT, not a message: appended
 * inside .turn-group, re-rendered on replay from cst.receipts, never pushed
 * into the transcript array and never sent to the model. */
function appendTurnReceipt(group, turnIndex) {
  const receipt = receiptsFor(courseKey()).find((r) => r.turn_index === turnIndex);
  if (!receipt) return;
  group.append(renderTurnReceipt(receipt, {
    onUndo: receipt.undoable && !receipt.undone && receipt.state_before ? undoReceipt : undefined,
  }));
}

// ---------------------------------------- staging tray + the only mouth (§5c)

/** Everything currently staged for the next composer send. 批注 left with its
 * surface; card answers are what remains, and hold-to-send still guards them. */
function stagedPayload() {
  const set = activeCardSet();
  const lockedCount = set ? set.answers.filter((a) => a.locked).length : 0;
  return { set, lockedCount, total: lockedCount };
}

function refreshStageTray() {
  const tray = $('#stage-tray');
  if (!tray) return;
  const { lockedCount, total } = stagedPayload();
  tray.hidden = total === 0;
  sendBtn.classList.toggle('hold-send', total > 0);
  sendBtn.title = total > 0 ? '按住 1.2 秒发送（含待发内容）' : '发送';
  sendBtn.setAttribute('aria-label', sendBtn.title);
  if (total === 0) { tray.replaceChildren(); return; }
  tray.replaceChildren();
  tray.append(el('span', 'stage-tray-label', '待发'));
  const chip = el('button', 'stage-chip', `${lockedCount} 张答卡`);
  chip.type = 'button';
  chip.title = '回到对话里的问题卡';
  chip.addEventListener('click', jumpToPendingCards);
  tray.append(chip);
  tray.append(el('span', 'stage-tray-hint', '按住发送键一起发出'));
}

/** The composer send: packages staged card answers + typed text into ONE
 * teacher message (§5c), consumes the staged sources, and hands off to send().
 * Plain sends (nothing staged) pass straight through. */
function composerSend() {
  if (busy) return;
  const typed = inputEl.value;
  const { set, lockedCount } = stagedPayload();
  const packed = packStagedMessage({
    cards: lockedCount ? set : null,
    text: typed,
  });
  if (!packed) return;
  inputEl.value = '';
  autogrow();
  if (lockedCount) {
    logEvent('user_input', 'staged_send', { locked_cards: lockedCount, typed: Boolean(typed.trim()) });
    setActiveCardSet(null); // consumed — the batch now lives in the transcript
    for (const stale of messagesEl.querySelectorAll('.qcards:not(.submitted)')) freezeQuestionCards(stale);
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

function wireBlueprintPanel() {
  const panel = $('#bp-panel');
  if (!panel) return;
  // Panel sits under the sticky header — measure once (font/theme safe enough).
  const header = document.querySelector('.app-header');
  if (header) document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
  // 列表 | 导图 is a REPRESENTATION switch, not input — one of the three
  // interactions a read-only panel is allowed (ADR-0010 §3).
  const setTab = (tab) => { bpTab = tab; save(LS.bpTab, tab); planKey = ''; refreshBlueprintPanel(); };
  $('#plan-tab-list').addEventListener('click', () => setTab('list'));
  $('#plan-tab-map').addEventListener('click', () => setTab('map'));
  // Zoom — the third and last permitted panel interaction.
  $('#plan-zoom-out').addEventListener('click', () => setPlanZoom(clampZoom(planZoom[courseKey()]) - 0.1));
  $('#plan-zoom-in').addEventListener('click', () => setPlanZoom(clampZoom(planZoom[courseKey()]) + 0.1));
  $('#plan-zoom-reset').addEventListener('click', () => setPlanZoom(1));
  // 图例 body is generated once, from the same table the badges read, so the
  // tree, the tally and the modal cannot drift apart about what a mark means.
  $('#legend-list')?.replaceWith(renderPlanLegend());
  // 图例 + 制作 modals (small paper cards; Esc / scrim / ✕ dismiss).
  const wireMini = (openBtnId, modalId) => {
    const modal = $(modalId);
    if (!modal) return;
    $(openBtnId)?.addEventListener('click', () => { modal.hidden = false; });
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('[data-close-mini]')) modal.hidden = true;
    });
  };
  wireMini('#plan-legend-btn', '#legend-modal');
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
  // Upper bound follows the panel becoming the primary surface (2026-08-13):
  // 880px could not express "the plan takes most of the screen" on a wide
  // monitor, so a teacher who dragged it wide got it clipped back. A saved
  // width outside the range is IGNORED rather than clamped — it belongs to an
  // older layout, and the new default is a better guess than a rounded relic.
  const saved = Number(load(LS.bpW, 0));
  if (saved >= 300 && saved <= 1600) document.documentElement.style.setProperty('--bp-w', `${saved}px`);
  const resizer = $('#bp-resizer');
  resizer.addEventListener('pointerdown', (down) => {
    down.preventDefault();
    resizer.setPointerCapture(down.pointerId);
    const move = (ev) => {
      if (!(ev.buttons & 1)) { up(); return; } // canceled drags never keep resizing on hover
      // Leave at least a readable strip of chat: the panel may dominate, but a
      // conversation squeezed under ~360px stops being usable to type into.
      const w = Math.max(300, Math.min(Math.max(520, window.innerWidth - 360), window.innerWidth - ev.clientX));
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
  return { ok: true };
}

// The 「此浏览器里存有模型密钥」 migration card lived here. It is gone with the
// browser key path it existed to drain (ADR-0013 §4): there is no local key to
// offer any more. Anything left over from an older build is deleted without
// asking, by purgeLegacyKeyStorage() at load — an unasked-for deletion of a
// secret is the safe direction, and re-uploading it would need this browser to
// read key material back, which is precisely what was removed.

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
  // 记忆 shows a SERVER record, so it is re-read on every open — a stale copy of
  // a record is a claim, and this is the one page whose whole job is to be
  // checkable against what the agent actually carries.
  buildMemoryPane();
  if (persistenceActive()) loadMemory().then(() => buildMemoryPane());

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
  planKey = '';
  applyNodeMode(); // a new course starts at course level, whatever the last one was
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

  // ---- Workflow v2: node mode, the subject chip, the pending-card strip ----
  // Every one of these RETURNS or NAVIGATES. None of them sends.
  $('#node-view-close').addEventListener('click', () => setSubject(COURSE_SUBJECT, { from: 'node_close' }));
  $('#subject-chip-x').addEventListener('click', () => setSubject(COURSE_SUBJECT, { from: 'chip' }));
  $('#pending-jump').addEventListener('click', jumpToPendingCards);

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

  // The landing is a mobile surface: rotating a tablet across the breakpoint
  // must add or remove it, not leave a card from the other layout on screen.
  const onLandingMq = () => refreshLanding();
  if (LANDING_MQ.addEventListener) LANDING_MQ.addEventListener('change', onLandingMq);
  else LANDING_MQ.addListener(onLandingMq); // older WebKit (mainland Android browsers)

  // model-card + 线路 change handlers live in buildModelsPane (built there)
}

/** One log line per session, however many replays repaint the notice. */
let rescuedLogged = false;
/**
 * Hand back any 批注 that were typed and never sent before the 批注 surface was
 * removed (ADR-0010 §3). Deleting them quietly would be the app eating her
 * words, which is exactly what a tool that asks teachers to type in it must
 * never do.
 *
 * Re-appended at the END of every replay, not once at boot: replayTranscript()
 * clears #messages, and it runs on every node open, every course switch and
 * every dev-mode toggle. Shown once at boot, the notice vanished the first time
 * she clicked a node on the panel — the primary new interaction — and the text
 * was only recoverable from devtools after that. It leaves when she says so.
 */
function showRescuedComments() {
  if (!rescuedComments.length) return;
  if (!rescuedLogged) {
    rescuedLogged = true;
    logEvent('session', 'rescued_blueprint_comments', {
      count: rescuedComments.length,
      courses: [...new Set(rescuedComments.map((r) => r.course))].length,
    });
  }
  const box = el('div', 'awaiting-note rescued-comments');
  box.append(el('div', '', '「批注」这个功能改成了直接和我对话——每一项都可以点开单独聊。下面是你之前写过、还没发出的批注，原样留在这里，需要的话直接复制到输入框：'));
  for (const row of rescuedComments) {
    box.append(el('div', 'rescued-comment', `${row.number} ${row.title}：${row.text}`));
  }
  const done = el('button', 'text-btn rescued-dismiss', '收好了，不用再提醒');
  done.type = 'button';
  done.addEventListener('click', dismissRescuedComments);
  box.append(done);
  messagesEl.append(box);
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
      // Which conversation the export was taken from (ADR-0010 §1). Without it
      // a node-mode export reads as a course-level one with holes in it.
      subject: (() => {
        const s = activeSubject();
        return { active: s, node_title: s === COURSE_SUBJECT ? null : (nodeContext(courseState?.course_plan, s)?.node.title ?? null) };
      })(),
      // 工作台 work-in-progress rides every export (Herman 2026-07-21): the
      // living card answers, the receipt ledger and the 最近处理 trail — not
      // only what was sent. cst.planFold and cst.planZoom deliberately stay
      // out: view state, no teacher decision in it, reconstructible from the
      // tree (same class as cst.bpW, which has never been exported either).
      workbench: workbenchSnapshot(),
      // 记忆 + 六轴画像 (AGENTS.md export duty). Counts, scopes and archive
      // reasons — never fact bodies: the `memory` category's own events already
      // carry the text, and repeating every body here would duplicate teacher
      // content for no extra diagnostic power. `memory.loaded: false` is stated
      // rather than omitted, because an absent key reads as 「the feature is
      // off」 and this is 「it ran and could not read」.
      memory: memoryContext(),
    }),
  });
  logEvent('session', 'boot', {
    provider, dev_mode: devMode, transcript_entries: transcript.length,
    course_id: courseState?.course_id ?? null, stage: courseState?.stage ?? null,
    // Full cst.providerCaps snapshot: the debug drawer / export otherwise
    // sees only toggle deltas and can't reconstruct pre-session state.
    provider_caps: providerCaps,
  });
  applyNodeMode();    // before the first replay: it decides what the replay filters to
  replayTranscript(); // instant render from the localStorage cache (also repaints the 批注 hand-back)
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
    if (me?.must_change_password) openUserModal('account', '请先修改初始密码，再开始使用。');
  });
}

boot();
