// render.js — pure-DOM renderers for messages, artifacts, closure loop, debug.
// Every piece of model-derived text passes through sanitizeMarkdown()/sanitizeInline()
// before any innerHTML write: HTML is escaped first, then a minimal markdown
// subset (bold/italic/headings/lists/breaks) is applied. No raw HTML passthrough.
// JSDoc-typed ESM, no build step (ADR-0001). Typedefs: demo/src/types.mjs.

import { STAGE_NAMES } from '../engine.mjs';
import { WF_NODES, NODE_PREREQS } from '../wf-nodes.mjs';
import { BLUEPRINT_STATUS, normalizeBlueprint, numberBlueprint } from '../blueprint-util.mjs';
import { layoutBlueprintMap, edgePath } from '../blueprint-map-layout.mjs';

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
  blueprint: '预设蓝图',
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
  if (artifact.type === 'blueprint') return renderBlueprintCard(artifact);
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

// ---------------------------------------------------------------- blueprint

/**
 * 预设蓝图 card: the model sends a semantic tree (stable ids + provenance
 * status); numbering and collapse are reconstructed HERE, deterministically,
 * client-side (ADR-0003 amendment 5 — the model never writes display numbers).
 * Modules render as <details> (open by default); nested branches collapse
 * unless they carry unverified content, so thin/unconfirmed spots stay visible.
 * @param {import('../types.mjs').TurnArtifact|Object} artifact
 */
export function renderBlueprintCard(artifact) {
  const { version, modules } = normalizeBlueprint(artifact.data);
  const numbered = numberBlueprint(modules);
  const card = el('article', 'artifact-card blueprint-card');
  const head = el('header', 'artifact-head');
  head.append(el('span', 'artifact-seal', ARTIFACT_SEALS.blueprint));
  head.append(el('h3', 'artifact-title', artifact.title ?? '阶段一预设蓝图'));
  head.append(el('span', 'bp-version', version));
  card.append(head);

  const listView = el('div', 'bp-list-view');
  for (const mod of numbered) listView.append(renderBlueprintNode(mod, true));
  card.append(listView);

  // 导图 view: PC only (mobile keeps the list — DESIGN.md §4). Same tree,
  // second renderer; the list stays the source of truth for interaction.
  // The media query is LIVE: crossing 880px shows/hides the toggle and drops
  // back to the list, so a resized window never strands a map-only card.
  if (numbered.length && typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(min-width: 880px)');
    const toggle = el('div', 'bp-view-toggle');
    const btnList = el('button', 'bp-view-btn active', '列表');
    const btnMap = el('button', 'bp-view-btn', '导图');
    btnList.type = btnMap.type = 'button';
    toggle.append(btnList, btnMap);
    head.insertBefore(toggle, head.querySelector('.bp-version'));
    let mapView = null;
    const show = (map) => {
      btnList.classList.toggle('active', !map);
      btnMap.classList.toggle('active', map);
      listView.hidden = map;
      if (map && !mapView) {
        mapView = renderBlueprintMapView(numbered);
        card.insertBefore(mapView, listView.nextSibling);
      }
      if (mapView) mapView.hidden = !map;
    };
    btnList.addEventListener('click', () => show(false));
    btnMap.addEventListener('click', () => show(true));
    const applyMq = () => {
      toggle.hidden = !mq.matches;
      if (!mq.matches) show(false); // narrow screens always fall back to the list
    };
    applyMq();
    mq.addEventListener('change', applyMq);
  }

  const legend = el('div', 'bp-legend');
  for (const [key, label] of Object.entries(BLUEPRINT_STATUS)) {
    legend.append(el('span', `bp-chip bp-${key}`, label));
  }
  card.append(legend);
  return card;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 导图 view: deterministic SVG tidy tree over the SAME numbered tree the list
 * renders — geometry from blueprint-map-layout (pure), zero dependencies,
 * all client-side. Click a parent node to fold/unfold its branch; collapse
 * state lives here (UI state), never in the data. First render grows in with
 * a stagger (feedback register); re-layouts after a fold are instant.
 */
function renderBlueprintMapView(numbered) {
  const wrap = el('div', 'bp-map');
  const scroller = el('div', 'bp-map-scroll');
  wrap.append(scroller);
  const collapsed = new Set();
  let first = true;
  const draw = () => {
    const { nodes, edges, width, height } = layoutBlueprintMap(numbered, collapsed);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.classList.add('bp-map-svg');
    if (first) svg.classList.add('bp-map-enter');
    for (const e of edges) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', edgePath(e));
      path.setAttribute('class', 'bp-edge');
      svg.append(path);
    }
    nodes.forEach((n, i) => {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', `bp-mnode bp-m-${n.status}${n.childCount ? ' bp-m-branch' : ''}`);
      g.setAttribute('transform', `translate(${n.x} ${n.y})`);
      if (first) g.style.animationDelay = `${Math.min(i * 45, 900)}ms`;
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('width', n.w);
      rect.setAttribute('height', n.h);
      rect.setAttribute('rx', 8);
      g.append(rect);
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', n.w / 2);
      text.setAttribute('y', n.h / 2 + 4.5);
      text.setAttribute('text-anchor', 'middle');
      text.textContent = n.label;
      g.append(text);
      const tip = document.createElementNS(SVG_NS, 'title');
      tip.textContent = `${n.number} ${n.title}${n.childCount ? `（${n.childCount} 项${n.collapsed ? '，已折叠' : ''}）` : ''}`;
      g.append(tip);
      if (n.collapsed && n.childCount) {
        const badge = document.createElementNS(SVG_NS, 'text');
        badge.setAttribute('x', n.w + 6);
        badge.setAttribute('y', n.h / 2 + 4);
        badge.setAttribute('class', 'bp-fold-badge');
        badge.textContent = `+${n.childCount}`;
        g.append(badge);
      }
      if (n.childCount) {
        g.setAttribute('tabindex', '0');
        g.setAttribute('role', 'button');
        g.setAttribute('aria-expanded', String(!n.collapsed));
        const toggleFold = () => {
          if (collapsed.has(n.id)) collapsed.delete(n.id); else collapsed.add(n.id);
          draw();
        };
        g.addEventListener('click', toggleFold);
        g.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleFold(); }
        });
      }
      svg.append(g);
    });
    scroller.replaceChildren(svg);
    first = false;
  };
  draw();
  return wrap;
}

/** One blueprint node → <details> (has children) or leaf row. */
function renderBlueprintNode(node, isModule) {
  const chip = el('span', `bp-chip bp-${node.status}`, BLUEPRINT_STATUS[node.status]);
  if (!node.children.length) {
    const row = el('div', 'bp-leaf');
    const line = el('div', 'bp-leaf-line');
    line.append(el('span', 'bp-number', node.number));
    const title = el('span', 'bp-node-title');
    title.innerHTML = sanitizeInline(node.title);
    line.append(title, chip);
    row.append(line);
    if (node.body) {
      const body = el('div', 'bp-body');
      body.innerHTML = sanitizeMarkdown(node.body);
      row.append(body);
    }
    return row;
  }
  const details = document.createElement('details');
  details.className = isModule ? 'bp-module' : 'bp-branch';
  const pending = node.rollup.hypothesis + node.rollup.ai_suggestion;
  // Modules stay open; sub-branches open only when something inside still
  // needs the teacher's eye — collapse-state doubles as the 亮灯 board.
  details.open = isModule || pending > 0;
  const summary = document.createElement('summary');
  summary.append(el('span', 'bp-number', node.number));
  const title = el('span', 'bp-node-title');
  title.innerHTML = sanitizeInline(node.title);
  summary.append(title, chip);
  if (pending > 0) summary.append(el('span', 'bp-rollup', `${pending} 项待确认`));
  details.append(summary);
  if (node.body) {
    const body = el('div', 'bp-body');
    body.innerHTML = sanitizeMarkdown(node.body);
    details.append(body);
  }
  for (const child of node.children) details.append(renderBlueprintNode(child, false));
  return details;
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

// ------------------------------------------------------ question cards (问题卡)

/**
 * Multi-question cue-card carousel (DESIGN.md §4 问题卡). Rendered when a turn
 * carries 2+ questions: horizontal scroll-snap track of cards (swipe / ‹ › / dots),
 * a 查看全部 stacked-list toggle for the review-everything pass, and one submit
 * bar that packages every answer into a SINGLE teacher message via onSubmit —
 * skipped cards are reported as 跳过 (a skip is information too).
 * Chips fill their own card's answer field (insert, never auto-send).
 * @param {Array<import('../types.mjs').TurnQuestion>} questions
 * @param {{ onSubmit?: (packed: string, meta: {total: number, answered: number, skipped: number}) => void }} opts
 */
export function renderQuestionCards(questions, opts = {}) {
  const root = el('div', 'qcards');
  const track = el('div', 'qcards-track');
  root.append(track);

  const answers = questions.map(() => ({ value: '', skipped: false }));

  const counter = el('span', 'qcards-count');
  const submitBtn = el('button', 'qcards-submit-btn', '一起发送');
  submitBtn.type = 'button';

  const refresh = () => {
    const answered = answers.filter((a) => a.value.trim()).length;
    counter.textContent = `已答 ${answered} / 共 ${questions.length}`;
    submitBtn.disabled = answered === 0 || root.classList.contains('submitted');
  };

  questions.forEach((q, i) => {
    const card = el('article', 'qcard');
    const head = el('div', 'qcard-head');
    head.append(el('span', 'question-marker', '问'));
    head.append(el('span', 'qcard-index', `${i + 1} / ${questions.length}`));
    card.append(head);
    const text = el('div', 'qcard-text');
    text.innerHTML = sanitizeInline(q.text);
    card.append(text);
    if (q.why) card.append(el('div', 'question-why', '—— ' + q.why));

    const chipRow = el('div', 'chip-row');
    for (const example of q.examples ?? []) {
      const chip = el('button', 'chip qcard-chip', example);
      chip.type = 'button';
      chip.addEventListener('click', () => {
        input.value = example;
        answers[i] = { value: example, skipped: false };
        card.classList.remove('skipped');
        refresh();
        input.focus();
      });
      chipRow.append(chip);
    }
    card.append(chipRow);

    const input = el('textarea', 'qcard-input');
    input.rows = 2;
    input.placeholder = '写你的回答，或点上面的示例改一改';
    input.addEventListener('input', () => {
      answers[i] = { value: input.value, skipped: false };
      card.classList.remove('skipped');
      refresh();
    });
    card.append(input);

    const skip = el('button', 'qcard-skip', '这题先跳过');
    skip.type = 'button';
    skip.addEventListener('click', () => {
      const on = !answers[i].skipped;
      answers[i] = { value: on ? '' : input.value, skipped: on };
      if (on) input.value = '';
      card.classList.toggle('skipped', on);
      refresh();
    });
    card.append(skip);

    track.append(card);
  });

  // nav: ‹ dots › + 查看全部
  const nav = el('div', 'qcards-nav');
  const prev = el('button', 'qcards-arrow', '‹');
  prev.type = 'button';
  prev.setAttribute('aria-label', '上一张');
  const next = el('button', 'qcards-arrow', '›');
  next.type = 'button';
  next.setAttribute('aria-label', '下一张');
  const dots = el('div', 'qcards-dots');
  questions.forEach((_, i) => {
    const dot = el('button', 'qcards-dot');
    dot.type = 'button';
    dot.setAttribute('aria-label', `第 ${i + 1} 张`);
    dot.addEventListener('click', () => scrollToCard(i));
    dots.append(dot);
  });
  const listToggle = el('button', 'qcards-list-toggle', '查看全部');
  listToggle.type = 'button';
  nav.append(prev, dots, next, listToggle);
  root.append(nav);

  const cardAt = (i) => track.children[i];
  const cardLeft = (card) => card.offsetLeft - track.offsetLeft;
  const scrollToCard = (i) => {
    const card = cardAt(Math.max(0, Math.min(questions.length - 1, i)));
    if (card) track.scrollTo({ left: cardLeft(card), behavior: 'smooth' });
  };
  // Nearest card by actual offset — exact regardless of gap/width rounding.
  const focusedIndex = () => {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < track.children.length; i += 1) {
      const dist = Math.abs(cardLeft(track.children[i]) - track.scrollLeft);
      if (dist < bestDist) { best = i; bestDist = dist; }
    }
    return best;
  };
  prev.addEventListener('click', () => scrollToCard(focusedIndex() - 1));
  next.addEventListener('click', () => scrollToCard(focusedIndex() + 1));
  const markDot = () => {
    const idx = focusedIndex();
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i === idx));
  };
  track.addEventListener('scroll', () => requestAnimationFrame(markDot), { passive: true });
  markDot();

  listToggle.addEventListener('click', () => {
    const listed = root.classList.toggle('as-list');
    listToggle.textContent = listed ? '收起为卡片' : '查看全部';
    nav.classList.toggle('list-mode', listed);
  });

  // submit bar
  const bar = el('div', 'qcards-bar');
  bar.append(counter, submitBtn);
  root.append(bar);
  submitBtn.addEventListener('click', () => {
    if (submitBtn.disabled) return;
    const lines = questions.map((q, i) => {
      const a = answers[i];
      const answer = a.value.trim() ? a.value.trim() : '（跳过）';
      return `${i + 1}. 「${q.text}」：${answer}`;
    });
    const answered = answers.filter((a) => a.value.trim()).length;
    root.classList.add('submitted');
    freezeAnswerControls(root);
    opts.onSubmit?.(`【问题卡回复】\n${lines.join('\n')}`, {
      total: questions.length,
      answered,
      skipped: questions.length - answered,
    });
  });

  refresh();
  return root;
}

/** Disable answering (chips, inputs, skip, submit) but keep review navigation
 * (arrows / dots / 查看全部) alive — a submitted set can still be re-read. */
function freezeAnswerControls(rootEl) {
  for (const control of rootEl.querySelectorAll('.qcard button, .qcard textarea, .qcards-submit-btn')) {
    control.disabled = true;
  }
}

/** Freeze a rendered qcards block (historical turns replay read-only). */
export function freezeQuestionCards(rootEl) {
  rootEl.classList.add('submitted');
  freezeAnswerControls(rootEl);
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
 * Muted-brick error notice with a retry affordance. When the failover chain
 * carried per-provider failures, they render as an expandable 失败详情 list
 * (textContent only — vendor error bodies are untrusted), so the teacher sees
 * WHY (限流/密钥/服务端错误) instead of just a provider id.
 * @param {string} message
 * @param {() => void} onRetry
 * @param {{chain?: Array<{provider?: string, kind?: string, message?: string}>}} [opts]
 */
export function renderErrorNotice(message, onRetry, opts = {}) {
  const box = el('div', 'error-notice');
  box.append(el('p', '', message || '这一轮没有走通，稍等片刻再试一次。'));
  const chain = Array.isArray(opts.chain) ? opts.chain.filter(Boolean) : [];
  if (chain.length) {
    const details = el('details', 'error-chain');
    details.append(el('summary', '', '失败详情'));
    for (const e of chain) {
      details.append(el('div', 'error-chain-line',
        `${e.provider ?? '—'}（${e.kind ?? 'unknown'}）：${e.message ?? ''}`));
    }
    box.append(details);
  }
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

function debugSection(heading, node, { span = false } = {}) {
  const section = el('div', 'debug-section' + (span ? ' debug-span' : ''));
  section.append(el('div', 'debug-heading', heading));
  section.append(node);
  return section;
}

function pre(value) {
  const node = el('pre');
  node.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return node;
}

/** Render one API round-trip attempt: request messages, raw response, harness verdict. */
function apiAttemptBlock(a) {
  const box = el('div', 'api-attempt');
  const decClass = a.decision === 'accepted' ? 'debug-ok'
    : a.decision === 'degraded' ? 'debug-violation' : 'api-retry';
  box.append(el('div', 'api-attempt-head',
    `尝试 ${a.attempt} · ${a.provider ?? '—'} · ${a.model ?? ''} · ${a.strategy ?? ''} · ${a.elapsed_ms ?? 0}ms`));
  box.append(el('div', 'api-endpoint', `POST ${a.endpoint ?? '—'}`));

  // Request: one collapsible per message (system prompt is the first).
  const reqD = el('details');
  reqD.append(el('summary', '', `发送 messages（${(a.request_messages ?? []).length}）`));
  for (const m of a.request_messages ?? []) {
    const md = el('details', 'api-msg');
    md.append(el('summary', '', `${m.role} · ${String(m.content ?? '').length} 字符`));
    md.append(pre(m.content ?? ''));
    reqD.append(md);
  }
  box.append(reqD);

  // Raw response exactly as the model returned it (before parse).
  const respD = el('details');
  respD.append(el('summary', '', 'API 原始响应（raw）'));
  respD.append(pre(a.response_raw ?? '（空）'));
  box.append(respD);

  // Harness verdict for this attempt.
  const verdict = el('div', 'api-verdict');
  verdict.append(el('span', decClass,
    `${a.parsed_ok ? '可解析' : '解析失败'} · ${a.blocking_count ?? 0} 个阻断 · 判定：${a.decision ?? '—'}`));
  box.append(verdict);
  for (const v of a.violations ?? []) {
    const line = el('div', 'debug-violation');
    line.append(el('span', 'v-kind', v.kind), document.createTextNode(` (${v.action ?? '—'}) ${v.detail ?? ''}`));
    box.append(line);
  }
  if (a.feedback_injected) {
    const fbD = el('details', 'api-feedback');
    fbD.append(el('summary', '', '注入的护栏反馈（L4 重写指令）'));
    fbD.append(pre(a.feedback_injected));
    box.append(fbD);
  }
  return box;
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

  // API round-trip(s): what left, what came back, and the harness verdict.
  if (ev?.api_debug) {
    const ad = ev.api_debug;
    const box = el('div');
    const meta = [
      `${ad.provider ?? '—'}`,
      ad.model ? `model ${ad.model}` : '',
      ad.base_url || '',
      `${(ad.attempts ?? []).length} 次尝试`,
    ].filter(Boolean).join(' · ');
    box.append(el('div', 'api-meta', meta));
    if (ad.chain_errors?.length) {
      const ce = el('div', 'api-chain-errors');
      ce.append(el('div', 'prompt-note', '失败切换记录（failover）：'));
      for (const e of ad.chain_errors) {
        ce.append(el('div', 'debug-violation', `${e.provider}（${e.kind}）${e.message ?? ''}`));
      }
      box.append(ce);
    }
    for (const a of ad.attempts ?? []) box.append(apiAttemptBlock(a));
    container.append(debugSection('API 往返（本轮）', box, { span: true }));
  }

  if (info?.state) {
    const details = el('details');
    details.append(el('summary', '', 'course_state（展开）'));
    details.append(pre(info.state));
    container.append(debugSection('course_state', details, { span: true }));

    const map = el('div', 'wf-map');
    const done = new Set(info.state.completed_nodes || []);
    for (let stage = 0; stage <= 5; stage += 1) {
      const stageBox = el('div', 'wf-map-stage' + (info.state.stage === stage ? ' current' : ''));
      stageBox.append(el('div', 'wf-map-stage-title', STAGE_NAMES[stage]));
      for (const node of WF_NODES.filter((n) => n.stage === stage)) {
        const isDone = done.has(node.id);
        const prereqs = NODE_PREREQS[node.id] || [];
        const hint = !isDone && prereqs.length ? ` ←${prereqs.join(' ')}` : '';
        stageBox.append(el('div', 'wf-map-node' + (isDone ? ' done' : ''), `${isDone ? '✓' : '·'} ${node.id} ${node.name}${hint}`));
      }
      map.append(stageBox);
    }
    container.append(debugSection('工作流地图', map, { span: true }));
  }

  // Dev-mode prompt visibility: full system prompt for this turn (if captured).
  if (ev?.prompt_debug) {
    const pd = ev.prompt_debug;
    const box = el('div');
    const meta = [
      '模块 ' + (pd.stage_module ?? '—'),
      String((pd.system ?? '').length) + ' 字符',
      'history ' + (pd.history_count ?? 0),
      '档案注入 ' + (pd.profile_injected ? '是' : '否'),
      pd.source ?? '',
    ].filter(Boolean).join(' · ');
    box.append(el('div', 'prompt-meta', meta));
    if (pd.note) box.append(el('div', 'prompt-note', pd.note));
    const promptDetails = el('details');
    promptDetails.append(el('summary', '', '完整 system 提示词（展开）'));
    const promptPre = pre(pd.system ?? '');
    promptPre.classList.add('prompt-pre');
    promptDetails.append(promptPre);
    box.append(promptDetails);
    container.append(debugSection('提示词（本轮）', box, { span: true }));
  }

  if (ev) {
    const usage = ev.usage
      ? Object.entries(ev.usage).map(([k, v]) => `${k}=${v}`).join(' · ')
      : 'usage: —';
    container.append(debugSection('provider', el('div', '', `${ev.providerLabel ?? ev.provider ?? '—'} · ${usage}`)));
  }
}
