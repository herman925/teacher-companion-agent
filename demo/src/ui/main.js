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

// ------------------------------------------------------------ persistence

const LS = {
  state: 'cst.state',
  transcript: 'cst.transcript',
  provider: 'cst.provider',
  keys: 'cst.keys',
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

let busy = false;
/** @type {string|null} message to resend on 重试 */
let pendingMessage = null;
/** @type {Object|null} last "turn" SSE event, for the debug drawer */
let lastEvent = null;
let lastTurnHadQuestion = false;

const PROVIDER_LABELS = {
  mock: '演示模式（无需密钥）',
  minimax: 'MiniMax-M3',
  glm: 'GLM-5.2',
  'glm-flash': 'GLM-4.7-Flash（免费）',
  kimi: 'Kimi k2.6',
  qwen: 'Qwen（qwen-plus）',
};

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
const keysBox = $('#keys-box');

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

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        state: courseState,
        history: wireHistory(),
        message: text,
        provider,
        keys: apiKeys,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`服务返回 ${res.status}`);

    await readSSE(res, (name, data) => {
      if (name === 'status') {
        setStatus(data.text ?? '…');
      } else if (name === 'turn') {
        gotTurn = true;
        handleTurn(text, data);
      } else if (name === 'error') {
        showError(data.message || '这一轮没有走通。');
      }
    });
    if (!gotTurn && !messagesEl.querySelector('.error-notice')) {
      showError('连接中断了，这一轮没有收到回复。');
    }
  } catch (err) {
    showError(err?.message || '无法连接本地演示服务。');
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

function providerOptions(ids) {
  providerSelect.replaceChildren();
  for (const id of ids) {
    const opt = el('option', '', PROVIDER_LABELS[id] ?? id);
    opt.value = id;
    providerSelect.append(opt);
  }
  if (!ids.includes(provider)) provider = 'mock';
  providerSelect.value = provider;
}

function buildKeyInputs(ids) {
  keysBox.replaceChildren();
  for (const id of ids) {
    if (id === 'mock') continue;
    const field = el('div', 'settings-field');
    const label = el('label', 'settings-label', `${PROVIDER_LABELS[id] ?? id} API 密钥`);
    const input = el('input', 'settings-input');
    input.type = 'password';
    input.placeholder = '留空则使用服务端环境变量（如已配置）';
    input.autocomplete = 'off';
    input.value = apiKeys[id] ?? '';
    input.addEventListener('input', () => {
      if (input.value) apiKeys[id] = input.value;
      else delete apiKeys[id];
      save(LS.keys, apiKeys);
    });
    label.htmlFor = input.id = `key-${id}`;
    field.append(label, input);
    keysBox.append(field);
  }
}

async function initProviders() {
  let ids = ['mock', 'minimax', 'glm', 'glm-flash', 'kimi'];
  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      const health = await res.json();
      if (Array.isArray(health.providers)) ids = ['mock', ...health.providers];
    }
  } catch { /* offline from the API is fine — mock list stands */ }
  providerOptions(ids);
  buildKeyInputs(ids);
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
