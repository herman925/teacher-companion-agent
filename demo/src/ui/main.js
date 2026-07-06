// main.js — app logic for the 陪跑智能体 demo chat (JSDoc-typed ESM, no build
// step, ADR-0001). Talks to demo/serve.mjs over the /api/chat SSE protocol.
// State custody: course_state + transcript + provider choice + API keys live
// in localStorage; keys ('cst.keys') never leave the machine except in the
// /api/chat request body to the local demo server.

import { createInitialState, STAGE_NAMES } from '../engine.mjs';
import {
  renderTeacherMessage, renderAgentMessage, renderArtifactCard,
  renderQuestionBlock, renderClosureCard, renderAwaitingNote,
  renderErrorNotice, renderDebug, el,
} from './render.js';
import { messageIn, cardIn, chipsIn, closureIn, fadeIn } from './motion.js';
import { runLocalMockTurn } from './local-turn.mjs';

// ------------------------------------------------------------ persistence

const LS = {
  state: 'cst.state',
  transcript: 'cst.transcript',
  provider: 'cst.provider',
  keys: 'cst.keys',
  models: 'cst.models',
  custom: 'cst.custom',
  apiBase: 'cst.apiBase',
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

/** Offline fallback when /api/health is unreachable. */
const FALLBACK_PROVIDERS = [
  { id: 'minimax', label: 'MiniMax', defaultModel: '', hasEnvKey: false },
  { id: 'glm', label: 'GLM', defaultModel: '', hasEnvKey: false },
  { id: 'glm-flash', label: 'GLM-Flash', defaultModel: '', hasEnvKey: false },
  { id: 'kimi', label: 'Kimi', defaultModel: '', hasEnvKey: false },
];

/** @type {Array<{id: string, label: string, defaultModel: string, hasEnvKey: boolean}>} */
let providerInfos = FALLBACK_PROVIDERS;

function providerInfo(id) {
  return providerInfos.find((p) => p.id === id) ?? null;
}

const STARTERS = [
  '我想带中班孩子做醒狮',
  '我们班在做龙舟主题，想优化',
  '我有一堆照片想整理成课程故事',
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
  if (provider === 'custom') {
    body.custom = { baseURL: customCfg.baseURL, model: customCfg.model, label: customCfg.label || undefined };
    if (customCfg.key) body.keys.custom = customCfg.key;
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
    else if (name === 'error') showError(data.message || '这一轮没有走通。');
  };
  const simulate = (label) => {
    const ev = runLocalMockTurn(courseState, wireHistory(), text);
    if (label) { ev.providerLabel = label; ev.simulated = true; }
    dispatch('turn', ev);
  };

  const needsBackend = provider !== 'mock';
  const haveBackend = backendOnline || Boolean(apiBase);

  try {
    if (!needsBackend) {
      simulate(null);
    } else if (!haveBackend) {
      showSimulatedNotice();
      simulate(`模拟演示（后端未连接，未实际调用 ${providerInfo(provider)?.label ?? provider}）`);
    } else {
      const crossOrigin = Boolean(apiBase);
      const res = await fetch(apiUrl('/api/chat'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: crossOrigin ? 'application/json' : 'text/event-stream',
        },
        body: JSON.stringify(chatRequestBody(text)),
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
    if (needsBackend) {
      showSimulatedNotice();
      simulate(`模拟演示（后端连接失败，未实际调用 ${providerInfo(provider)?.label ?? provider}）`);
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

/** Rebuild the provider config sections; open the selected provider's one. */
function buildProviderSections() {
  providerBox.replaceChildren();
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
  for (const info of providerInfos) providerBox.append(providerSection(info));
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
    provider = providerSelect.value;
    save(LS.provider, provider);
    syncOpenSection();
  });
}

// -------------------------------------------------------------------- boot

function boot() {
  save(LS.state, courseState); // persist a fresh course on first visit
  wire();
  replayTranscript();
  updateHeader();
  updateSkipLink();
  refreshDebug();
  initProviders();
  autogrow();
  window.scrollTo(0, document.body.scrollHeight);
}

boot();
