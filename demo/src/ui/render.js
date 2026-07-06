// render.js — pure-DOM renderers for messages, artifacts, closure loop, debug.
// Every piece of model-derived text passes through sanitizeMarkdown()/sanitizeInline()
// before any innerHTML write: HTML is escaped first, then a minimal markdown
// subset (bold/italic/headings/lists/breaks) is applied. No raw HTML passthrough.
// JSDoc-typed ESM, no build step (ADR-0001). Typedefs: demo/src/types.mjs.

import { STAGE_NAMES } from '../engine.mjs';
import { WF_NODES } from '../wf-nodes.mjs';

// ---------------------------------------------------------------- sanitizer

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** @param {unknown} s @returns {string} HTML-escaped text */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Inline subset only: **bold**, *italic*. Input must already be escaped. */
function applyInline(escaped) {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>');
}

/**
 * Sanitize a single line of model text for inline innerHTML use.
 * @param {unknown} text
 * @returns {string} safe HTML (escaped, bold/italic only)
 */
export function sanitizeInline(text) {
  return applyInline(escapeHtml(text));
}

/**
 * Sanitize model markdown into safe HTML: escape everything, then apply a
 * minimal subset — headings, unordered/ordered lists, bold, italic, breaks.
 * No links, no raw HTML passthrough.
 * @param {unknown} md
 * @returns {string} safe HTML
 */
export function sanitizeMarkdown(md) {
  const lines = escapeHtml(md).split(/\r?\n/);
  const out = [];
  /** @type {{tag: string, items: string[]}|null} */
  let list = null;
  /** @type {string[]} */
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push('<p>' + para.map(applyInline).join('<br>') + '</p>');
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>` + list.items.map((i) => '<li>' + applyInline(i) + '</li>').join('') + `</${list.tag}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      flushPara(); flushList();
      const level = Math.min(h[1].length + 2, 5); // h3..h5 under card/page titles
      out.push(`<h${level}>` + applyInline(h[2]) + `</h${level}>`);
      continue;
    }
    const ul = line.match(/^[-*•]\s+(.+)$/);
    if (ul) {
      flushPara();
      if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
      list.items.push(ul[1]);
      continue;
    }
    const ol = line.match(/^\d+[.、)）]\s*(.+)$/);
    if (ol) {
      flushPara();
      if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
      list.items.push(ol[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  return out.join('');
}

// ------------------------------------------------------------- DOM helpers

/**
 * @param {string} tag
 * @param {string} [cls]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------- messages

/**
 * Right-aligned teacher message (plain text, never HTML).
 * @param {string} text
 */
export function renderTeacherMessage(text) {
  return el('div', 'teacher-msg', text);
}

/**
 * Agent reply block. Adds the muted-brick refusal rule when degraded and a
 * compact harness badge when the runtime harness intercepted anything.
 * @param {string} markdown  turn.reply_markdown
 * @param {{interceptCount?: number, degraded?: boolean, onBadgeClick?: () => void}} [opts]
 */
export function renderAgentMessage(markdown, opts = {}) {
  const wrap = el('div', 'agent-msg' + (opts.degraded ? ' degraded' : ''));
  if (opts.degraded) {
    wrap.append(el('div', 'refusal-note', '这一轮的初稿没有通过护栏检查，下面是稳妥版本；细节在调试抽屉里。'));
  }
  const body = el('div', 'agent-body');
  body.innerHTML = sanitizeMarkdown(markdown);
  wrap.append(body);
  const count = opts.interceptCount ?? 0;
  if (count > 0 || opts.degraded) {
    const badge = el('button', 'harness-badge', `harness: ${count} 拦截${opts.degraded ? ' · 已降级' : ''}`);
    badge.type = 'button';
    badge.title = '打开调试抽屉查看拦截详情';
    if (opts.onBadgeClick) badge.addEventListener('click', opts.onBadgeClick);
    wrap.append(badge);
  }
  return wrap;
}

// ---------------------------------------------------------------- artifacts

/** Seal-tag labels for artifact types (DESIGN.md §4). */
const ARTIFACT_SEALS = {
  entry_card: '切口卡',
  fit_screening: '适配筛查',
  experience_plan: '体验方案',
  interview_card: '访谈卡',
  question_pool: '问题池',
  driving_questions: '驱动问题',
  cycle_task: '任务卡',
  story_fragment: '课程故事',
};

/** Known data-field labels; unknown fields fall back to the raw key. */
const FIELD_LABELS = {
  original_theme: '原始主题',
  initial_goal: '初步意图',
  child_entry_points: '儿童入口',
  perceivable_content: '可感知的内容',
  deepening_directions: '可深化的方向',
  first_experience: '第一轮体验',
  adult_phrasings_to_avoid: '避免的成人话术',
  judgment: '判定',
  judgment_zh: '判定结果',
  reasons: '判断依据',
  suggested_intensity: '建议推进强度',
  purpose: '这一轮为什么做',
  arrangement: '怎么安排',
  observation_focus: '观察重点',
  safety: '安全提示',
  representation_after: '回来后的表征',
  representation: '表征建议',
  for_children: '孩子可以问',
  for_adults: '老师可以问',
  promising: '有潜力的问题',
  excluded: '暂不采用',
  candidates: '候选',
  note: '说明',
  child_question: '抛给孩子的问题',
  flow: '流程',
  materials: '材料',
  teacher_role: '教师角色',
  origin: '缘起',
  question_birth: '问题的诞生',
  first_action: '第一次行动',
  gaps: '待补的缺口',
  question: '问题',
  category: '类别',
  evidence: '证据',
  evidence_refs: '证据',
  cultural_hint_backstage: '文化线索（只给你看）',
  reason: '原因',
  text: '问题',
  recommended: '推荐',
  why: '理由',
  chapters: '章节骨架',
  chapter: '章节',
  content: '内容',
  available: '已有材料',
  narrative_spine: '叙事主线',
};

/** Strings carrying these markers render as provisional (待现场确认, §4). */
const PROVISIONAL_RE = /待现场确认|待核实|需要核实|暂不明确|拿不准/;

/**
 * Render a scalar model value as an inline element (sanitized).
 * @param {unknown} v
 */
function renderScalar(v) {
  if (typeof v === 'boolean') return el('span', '', v ? '是' : '否');
  const span = document.createElement('span');
  span.innerHTML = sanitizeInline(v);
  if (typeof v === 'string' && PROVISIONAL_RE.test(v)) {
    span.classList.add('provisional');
    const holder = document.createElement('span');
    holder.append(span, Object.assign(el('span', 'tag-pending', '待现场确认'), { title: '现场验证后再定' }));
    return holder;
  }
  return span;
}

/**
 * Recursive generic value renderer: arrays → lists, objects → label/value
 * rows, scalars → sanitized inline text.
 * @param {unknown} v
 * @returns {HTMLElement}
 */
function renderValue(v) {
  if (v === null || v === undefined) return el('span', '', '—');
  if (Array.isArray(v)) {
    const listEl = el('ul', 'artifact-list');
    for (const item of v) {
      const li = el('li');
      li.append(renderValue(item));
      listEl.append(li);
    }
    return listEl;
  }
  if (typeof v === 'object') {
    const box = el('div', 'artifact-obj');
    for (const [key, val] of Object.entries(v)) {
      const row = el('div', 'artifact-row');
      row.append(el('span', 'artifact-key', (FIELD_LABELS[key] ?? key) + '：'));
      row.append(renderValue(val));
      box.append(row);
    }
    return box;
  }
  return renderScalar(v);
}

/**
 * Cream artifact card: serif title + persimmon seal tag + labeled sections.
 * @param {import('../types.mjs').TurnArtifact|Object} artifact
 */
export function renderArtifactCard(artifact) {
  const card = el('article', 'artifact-card');
  const head = el('header', 'artifact-head');
  head.append(el('span', 'artifact-seal', ARTIFACT_SEALS[artifact.type] ?? '卡片'));
  head.append(el('h3', 'artifact-title', artifact.title ?? ''));
  card.append(head);
  for (const [key, val] of Object.entries(artifact.data ?? {})) {
    const section = el('div', 'artifact-section');
    section.append(el('div', 'artifact-label', FIELD_LABELS[key] ?? key));
    section.append(renderValue(val));
    card.append(section);
  }
  return card;
}

// ----------------------------------------------------------- question block

/**
 * The one focused question + why + example chips. Chips only INSERT their
 * text into the input (wired by the caller) — never auto-send.
 * @param {import('../types.mjs').TurnQuestion} q
 */
export function renderQuestionBlock(q) {
  const root = el('div', 'question-block');
  const line = el('div', 'question-line');
  line.append(el('span', 'question-marker', '问'));
  const text = el('span', 'question-text');
  text.innerHTML = sanitizeInline(q.text);
  line.append(text);
  root.append(line);
  if (q.why) root.append(el('div', 'question-why', '—— ' + q.why));
  const row = el('div', 'chip-row');
  for (const example of q.examples ?? []) {
    const chip = el('button', 'chip', example);
    chip.type = 'button';
    row.append(chip);
  }
  root.append(row);
  return root;
}

// -------------------------------------------------------- closure-loop card

const CLOSURE_ROWS = [
  ['do_now', '本轮可以去做'],
  ['materials', '建议素材'],
  ['bring_back', '回来告诉我'],
  ['i_will', '我会继续帮你'],
];

/**
 * SVG gold number-in-circle (stroke is drawn in by motion.js).
 * Static markup + an internal integer — no model data enters this template.
 * @param {number} n
 */
function goldCircle(n) {
  const holder = document.createElement('span');
  holder.innerHTML =
    '<svg viewBox="0 0 28 28" class="gold-circle" aria-hidden="true">'
    + '<circle cx="14" cy="14" r="12"></circle>'
    + `<text x="14" y="18" text-anchor="middle">${Math.trunc(n)}</text>`
    + '</svg>';
  return holder.firstChild;
}

/**
 * The round-ending signature card. Gold lives here and nowhere else.
 * @param {import('../types.mjs').ClosureLoop} closure
 */
export function renderClosureCard(closure) {
  const card = el('section', 'closure-card');
  CLOSURE_ROWS.forEach(([key, label], i) => {
    const row = el('div', 'closure-row');
    row.append(goldCircle(i + 1));
    const body = el('div', 'closure-body');
    body.append(el('div', 'closure-label', label));
    const text = el('div', 'closure-text');
    text.innerHTML = sanitizeInline(closure?.[key] ?? '—');
    body.append(text);
    row.append(body);
    card.append(row);
  });
  return card;
}

// ------------------------------------------------------------ small pieces

/** Quiet centered status shown while course_state.awaiting_feedback. */
export function renderAwaitingNote() {
  return el('div', 'awaiting-note', '等待你带回现场反馈');
}

/**
 * Muted-brick error notice with a retry affordance.
 * @param {string} message
 * @param {() => void} onRetry
 */
export function renderErrorNotice(message, onRetry) {
  const box = el('div', 'error-notice');
  box.append(el('p', '', message || '这一轮没有走通，稍等片刻再试一次。'));
  const btn = el('button', 'retry-btn', '重试');
  btn.type = 'button';
  btn.addEventListener('click', () => {
    box.remove();
    onRetry();
  });
  box.append(btn);
  return box;
}

// ------------------------------------------------- developer mode: wf_trace

/**
 * Dev-facing workflow annotation under an agent message (开发者模式 only).
 * Text-only rendering — all values pass through textContent, no innerHTML.
 * @param {{mode?: string, stage?: number, nodes?: Array<{id: string, name?: string, apply?: string}>, principles?: string[], state_notes?: string}} wfTrace
 */
export function renderWfTrace(wfTrace) {
  const details = el('details', 'wf-trace');
  const ids = (wfTrace.nodes ?? []).map((n) => n?.id).filter(Boolean).join(' ');
  details.append(el('summary', '', `阶段${wfTrace.stage ?? '—'} · ${ids || '（无节点）'}`));
  const body = el('div', 'wf-trace-body');
  if (wfTrace.mode) body.append(el('div', 'wf-trace-line', `模式：${wfTrace.mode}`));
  for (const node of wfTrace.nodes ?? []) {
    if (!node) continue;
    const line = el('div', 'wf-trace-node');
    line.append(el('span', 'wf-trace-id', `${node.id ?? ''} ${node.name ?? ''}`.trim()));
    if (node.apply) line.append(document.createTextNode(` — ${node.apply}`));
    body.append(line);
  }
  if (wfTrace.principles?.length) body.append(el('div', 'wf-trace-line', `原则：${wfTrace.principles.join('、')}`));
  if (wfTrace.state_notes) body.append(el('div', 'wf-trace-line', `状态：${wfTrace.state_notes}`));
  details.append(body);
  return details;
}

// -------------------------------------------------------------- debug drawer

function debugSection(heading, node) {
  const section = el('div', 'debug-section');
  section.append(el('div', 'debug-heading', heading));
  section.append(node);
  return section;
}

function pre(value) {
  const node = el('pre');
  node.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return node;
}

/**
 * Repaint the debug drawer body: stage, gate report, last state_delta,
 * full course_state (collapsible), provider + usage.
 * @param {HTMLElement} container
 * @param {{lastEvent: Object|null, state: Object|null}} info
 */
export function renderDebug(container, info) {
  container.replaceChildren();
  const ev = info?.lastEvent ?? null;

  container.append(debugSection('stage', el('div', '', ev?.stageName ?? (info?.state ? `阶段 ${info.state.stage}` : '（还没有轮次）'))));

  const gate = ev?.gate_report;
  if (gate) {
    const list = el('div');
    if (!gate.violations?.length) {
      list.append(el('div', 'debug-ok', `ok · attempt ${gate.attempt}${gate.degraded ? ' · DEGRADED' : ''}`));
    } else {
      list.append(el('div', gate.degraded ? 'debug-violation' : 'debug-ok',
        `${gate.violations.length} violation(s) · attempt ${gate.attempt}${gate.degraded ? ' · DEGRADED (safe template)' : ''}`));
      for (const v of gate.violations) {
        const line = el('div', 'debug-violation');
        const kind = el('span', 'v-kind', `[${v.attempt ?? '?'}] ${v.kind}`);
        line.append(kind, document.createTextNode(` (${v.action ?? '—'}) ${v.detail ?? ''}`));
        list.append(line);
      }
    }
    container.append(debugSection('gate_report', list));
  }

  if (ev?.turn) {
    container.append(debugSection('state_delta（本轮）', pre(ev.turn.state_delta ?? {})));
  }

  if (info?.state) {
    const details = el('details');
    details.append(el('summary', '', 'course_state（展开）'));
    details.append(pre(info.state));
    container.append(debugSection('course_state', details));

    const map = el('div', 'wf-map');
    const done = new Set(info.state.completed_nodes || []);
    for (let stage = 0; stage <= 5; stage += 1) {
      const stageBox = el('div', 'wf-map-stage' + (info.state.stage === stage ? ' current' : ''));
      stageBox.append(el('div', 'wf-map-stage-title', STAGE_NAMES[stage]));
      for (const node of WF_NODES.filter((n) => n.stage === stage)) {
        const isDone = done.has(node.id);
        stageBox.append(el('div', 'wf-map-node' + (isDone ? ' done' : ''), `${isDone ? '✓' : '·'} ${node.id} ${node.name}`));
      }
      map.append(stageBox);
    }
    container.append(debugSection('工作流地图', map));
  }

  if (ev) {
    const usage = ev.usage
      ? Object.entries(ev.usage).map(([k, v]) => `${k}=${v}`).join(' · ')
      : 'usage: —';
    container.append(debugSection('provider', el('div', '', `${ev.providerLabel ?? ev.provider ?? '—'} · ${usage}`)));
  }
}
