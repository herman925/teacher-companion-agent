// main.js — app logic for the 陪跑智能体 demo chat (JSDoc-typed ESM, no build
// step, ADR-0001). Talks to demo/serve.mjs over the /api/chat SSE protocol.
// State custody: course_state + transcript + provider choice + API keys live
// in localStorage; keys ('cst.keys') never leave the machine except in the
// /api/chat request body to the local demo server.

import { createInitialState, STAGE_NAMES } from '../engine.mjs';
import {
  renderTeacherMessage, renderAgentMessage, renderArtifactCard,
  renderQuestionBlock, renderClosureCard, renderAwaitingNote,
  renderErrorNotice, renderDebug, renderWfTrace, el,
} from './render.js';
import { messageIn, cardIn, chipsIn, closureIn, fadeIn } from './motion.js';
import { runLocalMockTurn } from './local-turn.mjs';
import { buildSystemPrompt, stageModuleName, profileSectionText } from '../prompt-builder.mjs';
import { createLogStore, mountLogPanel, redactSecrets } from './session-log.mjs';

// ------------------------------------------------------------ persistence

const LS = {
  state: 'cst.state',
  transcript: 'cst.transcript',
  provider: 'cst.provider',
  keys: 'cst.keys',
  models: 'cst.models',
  custom: 'cst.custom',
  opencode: 'cst.opencode',
  apiBase: 'cst.apiBase',
  devmode: 'cst.devmode',
  profile: 'cst.profile',
  logcfg: 'cst.logcfg',
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
/** Chosen model per provider id; absent = use the provider default. */
let modelChoices = load(LS.models, {});
/** OpenAI-compatible custom endpoint config. */
let customCfg = { baseURL: '', model: '', key: '', label: '', ...load(LS.custom, {}) };
/** OpenCode local server config (session API; key = optional server password). */
let opencodeCfg = { baseURL: 'http://127.0.0.1:4096', model: '', key: '', ...load(LS.opencode, {}) };
/** 开发者模式: show wf_trace annotations + workflow map details. */
let devMode = Boolean(load(LS.devmode, false));

/** Session logger (debug drawer 「日志」 panel): every category defaults ON;
 * toggles persist in localStorage; entries are secret-redacted at append time. */
const logStore = createLogStore({
  loadConfig: () => load(LS.logcfg, null),
  saveConfig: (cfg) => save(LS.logcfg, cfg),
});
const logEvent = (cat, event, data) => logStore.log(cat, event, data);

/** 教师档案 (PRD §7.4 v1, local-only): read-only context, never model-writable. */
let profile = { region: '', ageBand: '', classSize: '', stylePref: '', ...load(LS.profile, {}) };
function saveProfile() { save(LS.profile, profile); }
function profileIsEmpty() {
  return !(String(profile.region || '').trim() || String(profile.ageBand || '').trim()
    || String(profile.classSize || '').trim() || String(profile.stylePref || '').trim());
}
/** The profile as sent with requests (undefined when empty). */
function profileForRequest() { return profileIsEmpty() ? undefined : { ...profile }; }

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

/** Offline fallback when /api/health is unreachable (e.g. static hosting).
 * Must mirror the enabled providers in adapter.mjs PROVIDERS, so the dropdown
 * offers the same choices with or without a backend. */
const FALLBACK_PROVIDERS = [
  { id: 'minimax', label: 'MiniMax', defaultModel: '', hasEnvKey: false },
  { id: 'glm', label: 'GLM', defaultModel: '', hasEnvKey: false },
  { id: 'glm-flash', label: 'GLM-Flash', defaultModel: '', hasEnvKey: false },
  { id: 'kimi', label: 'Kimi', defaultModel: '', hasEnvKey: false },
  { id: 'opencode-zen', label: 'OpenCode Zen（在线）', defaultModel: '', hasEnvKey: false },
  { id: 'opencode', label: 'OpenCode（本地）', defaultModel: 'opencode/deepseek-v4-flash-free', hasEnvKey: false },
];

/** @type {Array<{id: string, label: string, defaultModel: string, hasEnvKey: boolean}>} */
let providerInfos = FALLBACK_PROVIDERS;

function providerInfo(id) {
  return providerInfos.find((p) => p.id === id) ?? null;
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
const settingsDrawer = $('#settings-drawer');
const debugDrawer = $('#debug-drawer');
const debugBody = $('#debug-body');
const providerSelect = $('#provider-select');
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
    statusText.textContent = text;
    statusLine.classList.add('on');
  } else {
    statusLine.classList.remove('on');
  }
}

function refreshDebug() {
  renderDebug(debugBody, { lastEvent, state: courseState });
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

function openDrawer(drawer) {
  for (const d of [settingsDrawer, debugDrawer]) d.classList.toggle('open', d === drawer && !d.classList.contains('open'));
}

function closeDrawers() {
  settingsDrawer.classList.remove('open');
  debugDrawer.classList.remove('open');
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
    interceptCount: gate?.violations?.length ?? 0,
    degraded: Boolean(gate?.degraded),
    onBadgeClick: () => { refreshDebug(); openDrawer(debugDrawer); },
  });
  group.append(msg);

  if (devMode && turn.wf_trace) group.append(renderWfTrace(turn.wf_trace));

  const cards = [];
  if (turn.artifacts?.length) {
    const wrap = el('div', 'artifacts');
    for (const artifact of turn.artifacts) {
      const card = renderArtifactCard(artifact);
      cards.push(card);
      wrap.append(card);
    }
    group.append(wrap);
  }

  let questionEl = null;
  if (turn.question) {
    questionEl = renderQuestionBlock(turn.question);
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
    messageIn(msg);
    cards.forEach((card, i) => cardIn(card, i));
    if (questionEl) {
      messageIn(questionEl, 0.12 + cards.length * 0.08);
      chipsIn(questionEl.querySelectorAll('.chip'), 0.28 + cards.length * 0.08);
    }
    if (closureEl) closureIn(closureEl);
    if (awaitingEl) fadeIn(awaitingEl, 0.5);
  }
}

function replayTranscript() {
  messagesEl.replaceChildren();
  if (!transcript.length) {
    renderWelcome();
    return;
  }
  for (const entry of transcript) {
    if (entry.role === 'user') {
      messagesEl.append(renderTeacherMessage(entry.content));
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
    keys: { ...apiKeys },
  };
  const prof = profileForRequest();
  if (prof) body.profile = prof;
  if (devMode) body.debug = true;
  if (provider === 'custom') {
    body.custom = { baseURL: customCfg.baseURL, model: customCfg.model, label: customCfg.label || undefined };
    if (customCfg.key) body.keys.custom = customCfg.key;
  } else if (provider === 'opencode') {
    body.opencode = { baseURL: opencodeCfg.baseURL, model: opencodeCfg.model || undefined };
    if (opencodeCfg.key) body.keys.opencode = opencodeCfg.key;
  } else {
    const chosen = modelChoices[provider];
    if (chosen && chosen !== (providerInfo(provider)?.defaultModel ?? '')) body.model = chosen;
  }
  return body;
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
    const bubble = renderTeacherMessage(text);
    messagesEl.append(bubble);
    messageIn(bubble);
    scrollToEnd();
  }

  setStatus('正在联系陪跑智能体…');
  let gotTurn = false;

  const dispatch = (name, data) => {
    if (name === 'status') setStatus(data.text ?? '…');
    else if (name === 'turn') { gotTurn = true; handleTurn(text, data); }
    else if (name === 'error') {
      logEvent('error', 'turn_error', { message: data.message ?? '', kind: data.kind ?? '', chain: data.chain ?? [] });
      showError(data.message || '这一轮没有走通。');
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

  try {
    if (!needsBackend) {
      await simulate(null);
    } else if (!haveBackend) {
      showSimulatedNotice();
      await simulate(`模拟演示（后端未连接，未实际调用 ${providerInfo(provider)?.label ?? provider}）`);
    } else {
      const crossOrigin = Boolean(apiBase);
      const requestBody = chatRequestBody(text);
      // The store redacts again on append; redacting here too keeps the raw
      // keys object from ever entering the logging path.
      logEvent('api_out', 'chat_request', {
        url: apiUrl('/api/chat'),
        transport: crossOrigin ? 'buffered-json' : 'sse',
        body: redactSecrets(requestBody),
      });
      const res = await fetch(apiUrl('/api/chat'), {
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
    }
  } catch (err) {
    logEvent('error', 'request_failed', { message: err?.message ?? String(err), provider });
    if (needsBackend) {
      showSimulatedNotice();
      await simulate(`模拟演示（后端连接失败，未实际调用 ${providerInfo(provider)?.label ?? provider}）`);
    } else {
      showError(err?.message || '这一轮没有走通。');
    }
  } finally {
    busy = false;
    sendBtn.disabled = false;
    setStatus(null);
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

  setStatus(null);
  renderTurnGroup(ev, { animate: true });
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

function showError(message) {
  setStatus(null);
  const notice = renderErrorNotice(message, () => {
    if (pendingMessage) send(pendingMessage, { isRetry: true });
  });
  messagesEl.append(notice);
  fadeIn(notice);
  scrollToEnd();
}

// -------------------------------------------------------------- settings

function saveKeys() { save(LS.keys, apiKeys); }
function saveModels() { save(LS.models, modelChoices); }
function saveCustom() { save(LS.custom, customCfg); }
function saveOpencode() { save(LS.opencode, opencodeCfg); }

function providerOptions() {
  const ids = ['mock', ...providerInfos.map((p) => p.id), 'custom'];
  providerSelect.replaceChildren();
  for (const id of ids) {
    const opt = el('option', '', LOCAL_LABELS[id] ?? providerInfo(id)?.label ?? id);
    opt.value = id;
    providerSelect.append(opt);
  }
  if (!ids.includes(provider)) provider = 'mock';
  providerSelect.value = provider;
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

/** One provider's config: key + model row inside a collapsible section. */
function providerSection(info) {
  const details = el('details', 'provider-config');
  details.dataset.id = info.id;
  const summary = el('summary', '', info.label);
  details.append(summary);

  const { field: keyField } = settingsField(
    'API 密钥',
    `key-${info.id}`,
    {
      type: 'password',
      hint: info.hasEnvKey ? '服务器已配密钥' : '',
      placeholder: info.hasEnvKey ? '可留空——使用服务器密钥' : '在这里粘贴密钥',
      value: apiKeys[info.id] ?? '',
      onInput: (v) => {
        if (v) apiKeys[info.id] = v;
        else delete apiKeys[info.id];
        saveKeys();
      },
    },
  );
  details.append(keyField);

  details.append(modelRow(info.id, {
    defaultModel: info.defaultModel,
    getModel: () => modelChoices[info.id] ?? info.defaultModel ?? '',
    setModel: (m) => {
      if (m && m !== info.defaultModel) modelChoices[info.id] = m;
      else delete modelChoices[info.id];
      saveModels();
    },
    modelsBody: () => ({ provider: info.id, key: apiKeys[info.id] || undefined }),
  }));

  return details;
}

/** The 自定义端点 (OpenAI-compatible) section. */
function customSection() {
  const details = el('details', 'provider-config');
  details.dataset.id = 'custom';
  details.append(el('summary', '', LOCAL_LABELS.custom));

  const fields = [
    ['baseURL', '接口地址（baseURL）', 'text', '如 https://api.example.com/v1'],
    ['key', 'API 密钥', 'password', '在这里粘贴密钥'],
    ['label', '名称（可选）', 'text', '显示在调试信息里'],
  ];
  for (const [prop, labelText, type, placeholder] of fields) {
    const { field } = settingsField(labelText, `custom-${prop}`, {
      type,
      placeholder,
      value: customCfg[prop] ?? '',
      onInput: (v) => { customCfg[prop] = v.trim(); saveCustom(); },
    });
    details.append(field);
  }

  details.append(modelRow('custom', {
    defaultModel: '',
    getModel: () => customCfg.model ?? '',
    setModel: (m) => { customCfg.model = m; saveCustom(); },
    modelsBody: () => ({
      provider: 'custom',
      key: customCfg.key || undefined,
      custom: { baseURL: customCfg.baseURL, model: customCfg.model || 'unknown' },
    }),
  }));

  return details;
}

/**
 * OpenCode local-server section. Unlike a vendor, OpenCode holds the model keys
 * itself (`opencode serve`), so the "key" field is an optional server password.
 * The model row talks to /config/providers via /api/models.
 * @param {{id:string,label:string,defaultModel:string}} info
 */
function opencodeSection(info) {
  const details = el('details', 'provider-config');
  details.dataset.id = 'opencode';
  details.append(el('summary', '', info.label));

  details.append(el('p', 'settings-note',
    '先在另一个终端运行 opencode serve（默认 http://127.0.0.1:4096），再选择模型。模型密钥由 OpenCode 自己保管，不经过本机浏览器。'));

  const fields = [
    ['baseURL', '服务地址（baseURL）', 'text', '如 http://127.0.0.1:4096'],
    ['key', '服务密码（可选）', 'password', '仅当 opencode serve 设了密码时填写'],
  ];
  for (const [prop, labelText, type, placeholder] of fields) {
    const { field } = settingsField(labelText, `opencode-${prop}`, {
      type,
      placeholder,
      value: opencodeCfg[prop] ?? '',
      onInput: (v) => { opencodeCfg[prop] = v.trim(); saveOpencode(); },
    });
    details.append(field);
  }

  details.append(modelRow('opencode', {
    defaultModel: info.defaultModel,
    getModel: () => opencodeCfg.model || info.defaultModel || '',
    setModel: (m) => {
      if (m && m !== info.defaultModel) opencodeCfg.model = m;
      else opencodeCfg.model = '';
      saveOpencode();
    },
    modelsBody: () => ({
      provider: 'opencode',
      opencode: { baseURL: opencodeCfg.baseURL },
      key: opencodeCfg.key || undefined,
    }),
  }));

  return details;
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

/** 教师档案 section — optional, local-only (PRD §7.4 v1 personalization). */
function profileSection() {
  const details = el('details', 'provider-config');
  details.dataset.id = 'profile';
  details.append(el('summary', '', '教师档案（可选，只存本机）'));

  const { field: regionField } = settingsField('地区', 'profile-region', {
    placeholder: '如 广州市番禺区',
    value: profile.region ?? '',
    onInput: (v) => { profile.region = v.trim(); saveProfile(); },
  });
  details.append(regionField);

  const ageField = el('div', 'settings-field');
  const ageLabel = el('label', 'settings-label', '年段');
  const ageSelect = el('select', 'settings-select');
  ageSelect.id = 'profile-ageband';
  ageLabel.htmlFor = ageSelect.id;
  for (const band of ['', '小班', '中班', '大班', '混龄']) {
    const opt = el('option', '', band || '未选择');
    opt.value = band;
    ageSelect.append(opt);
  }
  ageSelect.value = profile.ageBand ?? '';
  ageSelect.addEventListener('change', () => { profile.ageBand = ageSelect.value; saveProfile(); });
  ageField.append(ageLabel, ageSelect);
  details.append(ageField);

  const { field: sizeField } = settingsField('班额', 'profile-classsize', {
    type: 'number',
    placeholder: '如 30',
    value: profile.classSize ?? '',
    onInput: (v) => { profile.classSize = v.trim(); saveProfile(); },
  });
  details.append(sizeField);

  const { field: styleField } = settingsField('风格偏好', 'profile-style', {
    placeholder: '如 喜欢户外和动手类活动',
    value: profile.stylePref ?? '',
    onInput: (v) => { profile.stylePref = v.trim(); saveProfile(); },
  });
  details.append(styleField);

  details.append(el('p', 'settings-note', '档案只保存在这台设备；只有在填写了服务器地址后才会随请求发送；不会写入课程状态。'));
  return details;
}

/** Rebuild the provider config sections; open the selected provider's one. */
function buildProviderSections() {
  providerBox.replaceChildren();
  providerBox.append(devModeField());
  providerBox.append(profileSection());
  const { field: apiField } = settingsField(
    '服务器地址（可选）',
    'api-base',
    {
      type: 'text',
      hint: backendOnline ? '本地服务在线' : '留空＝本机；填服务器地址可接真实模型',
      placeholder: '如 https://xxxx.cn-shenzhen.fcapp.run',
      value: apiBase,
      onInput: (v) => { apiBase = v.replace(/\/+$/, ''); save(LS.apiBase, apiBase); },
    },
  );
  providerBox.append(apiField);
  for (const info of providerInfos) {
    providerBox.append(info.id === 'opencode' ? opencodeSection(info) : providerSection(info));
  }
  providerBox.append(customSection());
  syncOpenSection();
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
      backendOnline = true;
    }
  } catch { /* offline from the API is fine — 演示模式 still works client-side */ }
  providerOptions();
  buildProviderSections();
}

// ------------------------------------------------------------ new course

function resetCourse() {
  const sure = window.confirm('开始新课程会清空当前对话和课程进度，确定吗？');
  if (!sure) return;
  logEvent('session', 'new_course', { previous_course: courseState?.course_id ?? null });
  courseState = createInitialState(`course-${Date.now()}`);
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
    inputEl.value = chip.textContent;
    autogrow();
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  });

  sendBtn.addEventListener('click', () => {
    const text = inputEl.value;
    inputEl.value = '';
    autogrow();
    send(text);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const text = inputEl.value;
      inputEl.value = '';
      autogrow();
      send(text);
    }
  });
  inputEl.addEventListener('input', autogrow);

  skipLink.addEventListener('click', () => send('先跳过'));

  $('#btn-new').addEventListener('click', resetCourse);
  $('#btn-settings').addEventListener('click', () => openDrawer(settingsDrawer));
  $('#btn-debug').addEventListener('click', () => { refreshDebug(); openDrawer(debugDrawer); });
  $('#close-settings').addEventListener('click', closeDrawers);
  $('#close-debug').addEventListener('click', closeDrawers);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '`') {
      e.preventDefault();
      refreshDebug();
      openDrawer(debugDrawer);
    } else if (e.key === 'Escape') {
      closeDrawers();
    }
  });

  providerSelect.addEventListener('change', () => {
    logEvent('session', 'provider_change', { from: provider, to: providerSelect.value });
    provider = providerSelect.value;
    save(LS.provider, provider);
    syncOpenSection();
  });
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
    }),
  });
  logEvent('session', 'boot', {
    provider, dev_mode: devMode, transcript_entries: transcript.length,
    course_id: courseState?.course_id ?? null, stage: courseState?.stage ?? null,
  });
  replayTranscript();
  updateHeader();
  updateSkipLink();
  refreshDebug();
  initProviders();
  autogrow();
  window.scrollTo(0, document.body.scrollHeight);
}

boot();
