// render.js — pure-DOM renderers for messages, artifacts, closure loop, debug.
// Every piece of model-derived text passes through sanitizeMarkdown()/sanitizeInline()
// before any innerHTML write: HTML is escaped first, then a minimal markdown
// subset (bold/italic/headings/lists/breaks) is applied. No raw HTML passthrough.
// JSDoc-typed ESM, no build step (ADR-0001). Typedefs: demo/src/types.mjs.

import { STAGE_NAMES } from '../engine.mjs';
import { WF_NODES, NODE_PREREQS } from '../wf-nodes.mjs';
import { BLUEPRINT_STATUS, normalizeBlueprint, numberBlueprint } from '../blueprint-util.mjs';
import { numberPlan } from '../plan-tsv.mjs';
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
 * @param {{onRetry?: (text: string) => void}} [opts] onRetry adds the ↻ affordance:
 *   it refills the composer with this text (edit-then-resend, never auto-send) —
 *   deliberately NOT a history-rewriting regenerate (the message log is append-only
 *   and every turn has applied state_delta; replacing turns needs an ADR).
 */
export function renderTeacherMessage(text, opts = {}) {
  const wrap = el('div', 'teacher-msg', text);
  if (opts.onRetry) {
    const btn = el('button', 'msg-retry', '↻');
    btn.type = 'button';
    btn.title = '放回输入框，改一改再发';
    btn.setAttribute('aria-label', '把这条消息放回输入框重新发送');
    btn.addEventListener('click', () => opts.onRetry(text));
    wrap.append(btn);
  }
  return wrap;
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
  // 文化育人价值复盘 rides story_fragment.data rather than a card of its own —
  // `culture_review` was never a legal artifact type (adapter TURN_SCHEMA).
  culture_review: '文化育人价值复盘（只给你看）',
  core_resource: '核心资源',
  initial_relation: '起点关系',
  evidence_of_change: '变化的证据',
  ladder_position: '文化目标阶梯位置',
  usable_statement: '可以这样说',
};

/** Strings carrying these markers render as provisional (§4).
 * 待现场确认 ⇄ 待现场验证: the corpus writes 验证, so matching only 确认 left a
 * node hedged exactly as instructed rendering as a settled assertion — the same
 * drift harness.mjs HEDGE_RE carried. */
const PROVISIONAL_RE = /待现场(确认|验证)|待核实|需要核实|暂不明确|拿不准/;

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

  // Card = list snapshot only. The 导图 and the LIVING plan moved to the
  // workspace panel (DESIGN.md §5b) — the in-card toggle retired with it;
  // chat cards remain historical snapshots of the turn that produced them.
  card.append(renderBlueprintList(numbered));

  const legend = el('div', 'bp-legend');
  for (const [key, label] of Object.entries(BLUEPRINT_STATUS)) {
    legend.append(el('span', `bp-chip bp-${key}`, label));
  }
  card.append(legend);
  return card;
}

/** Provenance detail block (DESIGN.md §5b). Team feedback 2026-07-20: terse
 * labels (依据/假设) read as jargon — the frame is now the teacher's own
 * questions, and each row renders as a full sentence, not a fragment. */
function renderRationale(rationale) {
  const box = el('div', 'bp-rationale');
  const row = (label, text) => {
    const r = el('div', 'bp-rationale-row');
    r.append(el('span', 'bp-rationale-label', label));
    const v = el('span', 'bp-rationale-text');
    v.innerHTML = sanitizeInline(text);
    r.append(v);
    box.append(r);
  };
  for (const h of rationale.heard ?? []) row('你说过', `「${h.quote}」`);
  if (rationale.assumed) row('我据此猜', rationale.assumed);
  if (rationale.pedagogy) row('为什么这样安排', rationale.pedagogy);
  if (rationale.profile_basis) row('来自你的档案', rationale.profile_basis);
  if (rationale.adjust) row('不合适怎么调', rationale.adjust);
  return box;
}

/**
 * Chat-side blueprint pointer chip (spec 2026-07-20): the blueprint itself
 * lives ONLY in the workspace panel; chat gets a one-line pointer with the
 * version, the outstanding count, and a click-through that opens the panel.
 * @param {{version: string, pending: number, onOpen?: () => void}} p
 */
export function renderBlueprintChip({ version, pending, onOpen }) {
  const chip = el('button', 'bp-chat-chip');
  chip.type = 'button';
  chip.append(el('span', 'artifact-seal', ARTIFACT_SEALS.blueprint));
  // Display-cap the model-authored version string — a rambling version must
  // not blow up the one-line chip.
  chip.append(el('span', 'bp-chat-chip-text', `预设蓝图 ${[...String(version)].slice(0, 20).join('')} 已更新`));
  if (pending > 0) chip.append(el('span', 'bp-chat-chip-pending', `${pending} 项待确认`));
  // The panel is read-only now (ADR-0010 §3/§6): pointing her at a 确认 action
  // that no longer exists would be worse than either interaction model.
  chip.append(el('span', 'bp-chat-chip-cta', '去工作台看看 →'));
  if (onOpen) chip.addEventListener('click', onOpen);
  return chip;
}

/**
 * Collapsible numbered outline over a numbered blueprint tree — shared by the
 * chat card (snapshot) and the 课程资料 section of the read-only 工作台.
 *
 * READ-ONLY (ADR-0010 §3/§6): ✓确认 and 批注 were removed with their surfaces,
 * and this renderer has no input path left — no callback opts, nothing to
 * re-arm by passing one.
 */
export function renderBlueprintList(numbered) {
  const listView = el('div', 'bp-list-view');
  for (const mod of numbered || []) listView.append(renderBlueprintNode(mod, true));
  return listView;
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
    const gutter = el('span', 'bp-gutter');
    gutter.append(chip);
    line.append(title, gutter);
    row.dataset.status = node.status;
    row.append(line);
    if (node.body) {
      const body = el('div', 'bp-body');
      body.innerHTML = sanitizeMarkdown(node.body);
      row.append(body);
    }
    if (node.rationale) row.append(renderRationale(node.rationale));
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
  const gutter = el('span', 'bp-gutter');
  gutter.append(chip);
  if (pending > 0) gutter.append(el('span', 'bp-rollup', `${pending} 项待确认`));
  summary.append(title, gutter);
  details.dataset.status = node.status;
  details.append(summary);
  if (node.body) {
    const body = el('div', 'bp-body');
    body.innerHTML = sanitizeMarkdown(node.body);
    details.append(body);
  }
  if (node.rationale) details.append(renderRationale(node.rationale));
  for (const child of node.children) details.append(renderBlueprintNode(child, false));
  return details;
}

// --------------------------------------------------------- 课程计划树 (plan)
//
// Workflow v2 (ADR-0010): the plan tree IS the theme network map — 月计划 (a
// PHASE of 2–5 weeks, never a calendar month) → 周计划 → 活动, an activity's
// date(s) rendered as a FIELD on its row. There is no day level: plan-tsv's
// PLAN_KINDS is the whole vocabulary, and a fourth kind would silently
// re-parent every activity in the skeleton the model reads each turn.
//
// The panel these render into is READ-ONLY (ADR-0010 §3). Opening a node's
// conversation on the LEFT, folding a branch and zooming the 导图 are the only
// three interactions; nothing here confirms, comments, filters or transmits.
//
// Numbering is reconstructed CLIENT-SIDE from plan-tsv's numberPlan — the same
// discipline as numberBlueprint (ADR-0003 amendment 5): the model never writes
// a display number, so renumbering can never be a model-visible change.

/**
 * Work status — where a node sits in the teacher's process. A SEPARATE axis
 * from provenance, and encoded in a different CHANNEL on purpose: hue belongs
 * to provenance alone (--status-truth/teacher/ai/guess), so work_status speaks
 * in shape and glyph instead. Merging the two would let 「她正在改」 read as
 * 「没跟孩子核对过」. Deliberately NOT added to BLUEPRINT_STATUS.
 * @type {Readonly<Record<string, {glyph: string, label: string}>>}
 */
export const PLAN_WORK_STATUS = Object.freeze({
  draft: { glyph: '草', label: '草稿' },
  adjusting: { glyph: '改', label: '调整中' },
  needs_review: { glyph: '复', label: '等你复看' },
  settled: { glyph: '定', label: '已定稿' },
});

/** Zoom bounds for the 导图 view. Scale lives in cst.planZoom; clamping here
 * as well means a corrupted stored value cannot render an unreadable tree. */
const PLAN_ZOOM_MIN = 0.5;
const PLAN_ZOOM_MAX = 2;

/** Provenance is 「有多确定」; work status is 「做到哪一步」. The two sentences
 * are written once and reused by the badges, the tally and the legend, so the
 * encodings cannot drift apart between renderers. */
const PLAN_AXIS_TITLES = { prov: '这一项有多确定', work: '这一项做到哪一步' };

/** Nodes not yet confirmed in a subtree, INCLUDING the node itself — the same
 * arithmetic the blueprint rollup uses, so a collapsed branch and an expanded
 * one never disagree about what is outstanding. Provenance only: staleness and
 * work status are other axes and never enter this count. */
function planPending(node) {
  let n = node?.status && node.status !== 'confirmed' ? 1 : 0;
  for (const child of node?.children ?? []) n += planPending(child);
  return n;
}

/** An activity's date field: one date, or a~b for a run of two days. Dates are
 * display strings on the row — never a level, never a container. */
function planDatesText(node) {
  const dates = (node?.dates ?? []).filter(Boolean);
  if (!dates.length) return '';
  return dates.length === 1 ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`;
}

/**
 * The badge cluster for one node: both status axes as two distinguishable
 * elements, plus the message count, the 待复查 mark and the branch rollup.
 * Exported on its own so main.js and the tests can assert the two axes render
 * as two elements without reaching into the tree renderer.
 * @param {Object} node a normalized plan node
 * @param {{messageCount?: number, rollup?: {pending: number}, stale?: boolean}} [opts]
 * @returns {DocumentFragment}
 */
export function renderPlanBadges(node, opts = {}) {
  const frag = document.createDocumentFragment();

  // Channel 1 — provenance. Owns hue; label text is BLUEPRINT_STATUS's, so the
  // plan and the blueprint can never call the same status two different things.
  const status = BLUEPRINT_STATUS[node?.status] ? node.status : 'ai_suggestion';
  const prov = el('span', 'plan-badge plan-badge-prov', BLUEPRINT_STATUS[status]);
  prov.dataset.status = status;
  prov.title = `${PLAN_AXIS_TITLES.prov}：${BLUEPRINT_STATUS[status]}`;
  frag.append(prov);

  // Channel 2 — work status. Square corners, hairline outline, glyph prefix,
  // no status hue (styles.css owns the shapes; the data attribute is the hook).
  const workKey = PLAN_WORK_STATUS[node?.work_status] ? node.work_status : 'draft';
  const work = PLAN_WORK_STATUS[workKey];
  const workEl = el('span', 'plan-badge plan-badge-work');
  workEl.dataset.work = workKey;
  workEl.title = `${PLAN_AXIS_TITLES.work}：${work.label}`;
  workEl.append(el('span', 'plan-badge-work-glyph', work.glyph), document.createTextNode(work.label));
  frag.append(workEl);

  // A node nobody has discussed shows nothing at all (ADR-0010 §8).
  const msgs = Math.trunc(Number(opts.messageCount) || 0);
  if (msgs > 0) {
    const badge = el('span', 'plan-badge plan-badge-msgs', `${msgs} 条`);
    badge.dataset.count = String(msgs);
    badge.title = `这一项下面已经聊过 ${msgs} 条`;
    frag.append(badge);
  }

  // 待复查 carries its own reason (ADR-0007 §5): a badge saying only 待复查 is
  // a puzzle she has to solve before she can judge it.
  if (opts.stale || node?.stale_since) {
    const stale = el('span', 'plan-badge plan-badge-stale', '待复查');
    stale.title = node?.stale_reason
      ? `待复查：${node.stale_reason}`
      : '待复查：上游有改动，这一项还没回头看过';
    frag.append(stale);
  }

  const pending = Math.trunc(Number(opts.rollup?.pending) || 0);
  if (pending > 0) frag.append(el('span', 'plan-rollup', `${pending} 项待确认`));

  return frag;
}

/** One plan node → <details class="plan-node plan-branch"> or a leaf row. */
function renderPlanNode(node, ctx) {
  const branch = (node.children ?? []).length > 0;
  const host = branch ? document.createElement('details') : el('div', 'plan-node plan-leaf');
  if (branch) {
    host.className = 'plan-node plan-branch';
    host.open = !ctx.folded.has(node.id);
  }
  // Two attributes, never merged: data-status carries provenance, data-work
  // carries work status. A CSS change that collapsed them into one would erase
  // the distinction the whole two-axis rule exists to keep.
  host.dataset.nodeId = node.id;
  host.dataset.kind = node.kind;
  host.dataset.status = BLUEPRINT_STATUS[node.status] ? node.status : 'ai_suggestion';
  host.dataset.work = PLAN_WORK_STATUS[node.work_status] ? node.work_status : 'draft';
  host.dataset.stale = node.stale_since ? 'true' : 'false';
  if (ctx.openNodeId && ctx.openNodeId === node.id) host.classList.add('is-open');

  const line = branch ? document.createElement('summary') : el('div');
  line.className = 'plan-node-line';
  line.append(el('span', 'plan-num', ctx.numbers.get(node.id) ?? ''));

  // The ONLY node-level action on the panel: open that node's conversation on
  // the left. Transmits nothing (ADR-0010 §3).
  const open = el('button', 'plan-open-btn');
  open.type = 'button';
  open.dataset.nodeId = node.id;
  open.innerHTML = sanitizeInline(node.title || '（未命名）');
  open.setAttribute('aria-label', `打开「${node.title || '未命名'}」的对话`);
  open.addEventListener('click', (ev) => {
    ev.stopPropagation();  // on a <summary> a click would otherwise also fold
    ev.preventDefault();
    ctx.onOpenNode?.(node.id);
  });
  line.append(open);

  const dates = node.kind === 'activity' ? planDatesText(node) : '';
  if (dates) line.append(el('span', 'plan-dates', dates));

  const badges = el('span', 'plan-badges');
  badges.append(renderPlanBadges(node, {
    messageCount: ctx.messageCounts[node.id],
    rollup: branch ? { pending: planPending(node) } : null,
  }));
  line.append(badges);
  host.append(line);

  if (branch) {
    // `toggle` fires after the browser has already moved `open`, so the fold set
    // main.js persists is read off the DOM rather than guessed from the click.
    //
    // It also fires ASYNCHRONOUSLY: setting `open` above queues a toggle that
    // lands on this listener even though it was attached afterwards. Without the
    // seen-state guard every branch that opens by default would report a fold
    // change on first paint — a write to cst.planFold, and a render loop in any
    // caller that repaints when the fold set changes.
    let seenOpen = host.open;
    host.addEventListener('toggle', () => {
      if (host.open === seenOpen) return;
      seenOpen = host.open;
      ctx.onToggleFold?.(node.id, !host.open);
    });
    for (const child of node.children) host.append(renderPlanNode(child, ctx));
  }
  return host;
}

/**
 * The living course_plan tree — 月计划 → 周计划 → 活动, read-only.
 *
 * Bodies deliberately do not render here: the tree is the skeleton the teacher
 * scans, and a node's body, rationale and staleness reason live in the left
 * node view (renderNodeDetail), one node at a time.
 *
 * @param {{version?: string|number, roots?: Array}} plan already through normalizePlan()
 * @param {{
 *   numbers?: Map<string, string>, view?: 'list'|'map', openNodeId?: string|null,
 *   folded?: Set<string>, messageCounts?: Record<string, number>, zoom?: number,
 *   onOpenNode?: (nodeId: string) => void,
 *   onToggleFold?: (nodeId: string, folded: boolean) => void,
 * }} [opts]
 *
 * The contract's `posKey` and `onZoom` are deliberately NOT accepted: 导图 is
 * this same DOM under a CSS scale, so there are no node positions to cache,
 * and the ＋／－／100% buttons live in the panel head where main.js owns them
 * (a renderer that is re-created on every repaint is the wrong owner for a
 * control that must survive one).
 * @returns {HTMLElement} .plan-tree[data-view]
 */
export function renderPlanTree(plan, opts = {}) {
  const view = opts.view === 'map' ? 'map' : 'list';
  const tree = el('div', 'plan-tree');
  tree.dataset.view = view;
  const ctx = {
    numbers: opts.numbers instanceof Map ? opts.numbers : numberPlan(plan),
    folded: opts.folded instanceof Set ? opts.folded : new Set(),
    messageCounts: opts.messageCounts ?? {},
    openNodeId: opts.openNodeId ?? null,
    onOpenNode: opts.onOpenNode,
    onToggleFold: opts.onToggleFold,
  };
  // 导图 is a real node-and-edge DIAGRAM (renderPlanMap), not this list under a
  // CSS scale. The two are different tools: the list is for reading a branch in
  // order, the map is for seeing the shape of the whole course at once, which is
  // the thing a 主题网络图 exists to show. Read-only is satisfied by removing the
  // popover's write affordances — clicking a node opens its conversation on the
  // LEFT — not by removing the diagram.
  if (view === 'map') return renderPlanMap(plan, { ...opts, numbers: ctx.numbers });
  for (const root of plan?.roots ?? []) tree.append(renderPlanNode(root, ctx));
  return tree;
}

// ------------------------------------------------------------- 导图 (map view)

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Find a node by id in a numbered tree — the layout returns flat boxes and
 * drops the fields the tooltip needs (work_status, staleness). */
function findInTree(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    const hit = findInTree(n.children, id);
    if (hit) return hit;
  }
  return null;
}

/** id → {x,y} of the last layout, per map key: a rebuilt map GLIDES (FLIP) from
 * where the nodes were instead of re-growing from nothing on every repaint. */
const MAP_POS_CACHE = new Map();

/**
 * Adapt the plan tree to the shape layoutBlueprintMap reads (numberBlueprint
 * output): number inlined on each node, and a `rollup` of what is still
 * unsettled beneath it so a collapsed branch can still show its badge.
 * @param {Array} nodes plan nodes
 * @param {Map<string,string>} numbers
 */
function toMapNodes(nodes, numbers) {
  return (nodes ?? []).map((n) => {
    const children = toMapNodes(n.children, numbers);
    const rollup = { hypothesis: 0, pending_validation: 0, ai_suggestion: 0 };
    for (const c of children) {
      if (c.status in rollup) rollup[c.status] += 1;
      for (const k of Object.keys(rollup)) rollup[k] += c.rollup?.[k] ?? 0;
    }
    return {
      id: n.id, number: numbers.get(n.id) ?? '', title: n.title ?? '', body: n.body ?? '',
      status: n.status ?? 'ai_suggestion', kind: n.kind ?? '', work_status: n.work_status ?? '',
      stale_since: n.stale_since, children, rollup,
    };
  });
}

/**
 * The 主题网络图: the course plan as a horizontal tidy tree of boxes and edges.
 *
 * READ-ONLY (ADR-0010 §3). The old blueprint map opened a detail popover that
 * carried ✓确认 and 批注 buttons; those affordances are what a read-only panel
 * must not have, so a node click now opens that node's conversation on the LEFT
 * instead. Folding and zooming stay — both are ways of looking, not writing.
 *
 * @param {{version?: string|number, roots?: Array}} plan already through normalizePlan()
 * @param {{numbers?: Map<string,string>, folded?: Set<string>, openNodeId?: string|null,
 *   zoom?: number, mapKey?: string, onOpenNode?: (id: string) => void,
 *   onToggleFold?: (id: string, folded: boolean) => void}} [opts]
 * @returns {HTMLElement} .plan-map
 */
export function renderPlanMap(plan, opts = {}) {
  const numbers = opts.numbers instanceof Map ? opts.numbers : numberPlan(plan);
  const numbered = toMapNodes(plan?.roots ?? [], numbers);
  const wrap = el('div', 'plan-map');
  const scroller = el('div', 'plan-map-scroll');
  wrap.append(scroller);
  const zoom = Math.min(PLAN_ZOOM_MAX, Math.max(PLAN_ZOOM_MIN, Number(opts.zoom) || 1));
  wrap.style.setProperty('--plan-zoom', String(zoom));

  // Collapse state is the CALLER's (it persists in cst.planFold and is shared
  // with the list view, so switching representation keeps her shape).
  const collapsed = opts.folded instanceof Set ? new Set(opts.folded) : new Set();
  const cached = opts.mapKey ? MAP_POS_CACHE.get(opts.mapKey) : null;
  let first = !cached;
  let prevPos = cached || new Map();

  const draw = () => {
    const { nodes, edges, width, height } = layoutBlueprintMap(numbered, collapsed);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.classList.add('plan-map-svg');
    if (first) svg.classList.add('plan-map-enter');

    edges.forEach((e, i) => {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', edgePath(e));
      // Dash carries meaning: only the edge INTO an unverified child is dashed,
      // mirroring the node, so tentative reads as tentative at the connector too.
      const tentative = e.toStatus === 'hypothesis' || e.toStatus === 'pending_validation';
      path.setAttribute('class', `plan-edge${tentative ? ' plan-edge-hyp' : ''}`);
      if (first && !tentative) {
        path.setAttribute('pathLength', '1');
        path.classList.add('plan-edge-draw');
        path.style.animationDelay = `${Math.min(i * 45 + 120, 1020)}ms`;
      }
      svg.append(path);
    });

    nodes.forEach((n, i) => {
      const src = findInTree(numbered, n.id);
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', `plan-mnode plan-m-${n.status}`
        + (n.childCount ? ' plan-m-branch' : '')
        + (src?.stale_since ? ' plan-m-stale' : '')
        + (opts.openNodeId === n.id ? ' plan-m-open' : ''));
      g.setAttribute('transform', `translate(${n.x} ${n.y})`);
      // Inner group carries ALL motion (entry + FLIP); the outer g's transform
      // attribute does positioning and CSS must never touch it.
      const gi = document.createElementNS(SVG_NS, 'g');
      gi.setAttribute('class', 'plan-mnode-in');
      if (first) gi.style.animationDelay = `${Math.min(i * 45, 900)}ms`;

      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('width', n.w);
      rect.setAttribute('height', n.h);
      rect.setAttribute('rx', 8);
      gi.append(rect);

      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', 10);
      text.setAttribute('y', n.h / 2 + 4.5);
      const num = document.createElementNS(SVG_NS, 'tspan');
      num.setAttribute('class', 'plan-mnum');
      num.textContent = n.number;
      const title = document.createElementNS(SVG_NS, 'tspan');
      title.setAttribute('dx', '5');
      title.textContent = n.label;
      text.append(num, title);
      gi.append(text);

      // The full title, both axes and the staleness reason live in the tooltip:
      // the box shows a truncated label, and a teacher must be able to read the
      // whole thing without opening anything.
      const tip = document.createElementNS(SVG_NS, 'title');
      const axes = [BLUEPRINT_STATUS[n.status], PLAN_WORK_STATUS[src?.work_status]?.label].filter(Boolean).join(' · ');
      tip.textContent = `${n.number} ${n.title}\n${axes}`
        + (n.childCount ? `（${n.childCount} 项${n.collapsed ? '，已折叠' : ''}）` : '')
        + (src?.stale_since ? '\n上游改过，待复查' : '');
      gi.append(tip);

      if (n.collapsed && n.childCount) {
        const badge = document.createElementNS(SVG_NS, 'text');
        badge.setAttribute('x', n.w + 6);
        badge.setAttribute('y', n.h / 2 + 4);
        badge.setAttribute('class', `plan-fold-badge${n.pending === 0 ? ' plan-fold-ok' : ''}`);
        badge.textContent = n.pending === 0 ? '已齐' : `+${n.childCount}`;
        gi.append(badge);
      }

      g.append(gi);
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      const open = () => opts.onOpenNode?.(n.id);
      g.setAttribute('aria-label', `${n.number} ${n.title}：打开这个节点的对话`);

      if (n.childCount) {
        g.setAttribute('aria-expanded', String(!n.collapsed));
        const toggleFold = () => {
          const nowFolded = !collapsed.has(n.id);
          if (nowFolded) collapsed.add(n.id); else collapsed.delete(n.id);
          opts.onToggleFold?.(n.id, nowFolded);
          draw();
        };
        // Dedicated fold affordance at the node's right edge; the node body
        // opens the conversation. Two targets, two different things.
        const hit = document.createElementNS(SVG_NS, 'g');
        hit.setAttribute('class', 'plan-fold-hit');
        hit.setAttribute('transform', `translate(${n.w - 13} ${n.h / 2})`);
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('r', 8);
        const glyph = document.createElementNS(SVG_NS, 'text');
        glyph.setAttribute('text-anchor', 'middle');
        glyph.setAttribute('y', 3.5);
        glyph.textContent = n.collapsed ? '＋' : '－';
        hit.append(circle, glyph);
        hit.addEventListener('click', (ev) => { ev.stopPropagation(); toggleFold(); });
        gi.append(hit);
        g.addEventListener('click', open);
        g.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); open(); }
          if (ev.key === ' ') { ev.preventDefault(); toggleFold(); }
        });
      } else {
        g.addEventListener('click', open);
        g.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
        });
      }
      svg.append(g);

      // FLIP: persisting nodes glide from their previous position instead of
      // snapping, so the deterministic reflow after a fold stays legible.
      const prev = prevPos.get(n.id);
      if (!first && prev && (prev.x !== n.x || prev.y !== n.y)) {
        gi.style.transform = `translate(${prev.x - n.x}px, ${prev.y - n.y}px)`;
        requestAnimationFrame(() => {
          gi.classList.add('plan-flip');
          gi.style.transform = '';
        });
      } else if (!first) {
        gi.classList.add('plan-node-appear');
      }
    });

    prevPos = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    if (opts.mapKey) MAP_POS_CACHE.set(opts.mapKey, prevPos);
    scroller.replaceChildren(svg);
    first = false;
  };
  draw();
  return wrap;
}

/**
 * READ-ONLY provenance + work tally for the panel head. Non-interactive spans
 * only — filtering died with the read-only rule, and a pill that looks like a
 * button on a panel that cannot be clicked is a lie about the surface.
 * @param {{confirmed?: number, teacher_preset?: number, ai_suggestion?: number,
 *   hypothesis?: number, pending_validation?: number, stale?: number,
 *   needs_review?: number}} [counts]
 * @returns {HTMLElement} #plan-tally
 */
export function renderPlanTally(counts = {}) {
  const row = el('div', 'plan-tally');
  row.id = 'plan-tally';
  const num = (v) => Math.trunc(Number(v) || 0);

  const provGroup = el('span', 'plan-tally-group');
  // The four named states always render (a zero 已确认 is information too);
  // 待现场验证 joins them only when something actually carries it, so the
  // common case stays a four-pill row.
  const provKeys = ['confirmed', 'teacher_preset', 'ai_suggestion', 'hypothesis'];
  if (num(counts.pending_validation) > 0) provKeys.push('pending_validation');
  for (const key of provKeys) {
    const pill = el('span', 'plan-tally-pill', `${BLUEPRINT_STATUS[key]} ${num(counts[key])}`);
    pill.dataset.status = key;
    pill.title = `${PLAN_AXIS_TITLES.prov}：${BLUEPRINT_STATUS[key]}`;
    provGroup.append(pill);
  }
  row.append(provGroup);

  // Second group, visually separated: the work/staleness channel. 待复查 is not
  // a work status — it is a staleness mark — so it carries its own attribute.
  const workGroup = el('span', 'plan-tally-group plan-tally-flags');
  const review = el('span', 'plan-tally-pill plan-tally-work', `${PLAN_WORK_STATUS.needs_review.label} ${num(counts.needs_review)}`);
  review.dataset.work = 'needs_review';
  review.title = `${PLAN_AXIS_TITLES.work}：${PLAN_WORK_STATUS.needs_review.label}`;
  const stale = el('span', 'plan-tally-pill plan-tally-flag', `待复查 ${num(counts.stale)}`);
  stale.dataset.flag = 'stale';
  stale.title = '上游改动可能牵动了这些项，还没回头看过';
  workGroup.append(review, stale);
  row.append(workGroup);
  return row;
}

/** One legend row: the real badge element beside one spoken-register sentence,
 * so the modal explains the encoding by SHOWING it. */
function legendRow(badge, text) {
  const li = el('li', 'legend-row');
  li.append(badge, el('span', 'legend-text', text));
  return li;
}

/**
 * 图例 body — one source for both axes, so the encodings cannot drift apart
 * between the tree, the tally and the modal that explains them.
 * @returns {HTMLElement} <ul class="legend-list">
 */
export function renderPlanLegend() {
  const list = el('ul', 'legend-list');

  list.append(el('li', 'legend-section', PLAN_AXIS_TITLES.prov));
  const provText = {
    // Honest about BOTH write paths. The plan tree really does check the
    // quote (applyPlanDelta + citedNodeOf); 课程资料 escalates a pre-existing
    // node on any teacher turn with no citation (engine.mjs absorbBlueprint,
    // the KNOWN GAP recorded at serve.mjs). One sentence must not vouch for
    // two rules — claiming her consent is the same class of assertion
    // non-negotiable #1 exists to stop.
    confirmed: '计划树里的这一枚，是我引用了你的原话才标上的。课程资料里的那一枚还没有逐句核对，看到它请当成「我以为你点头了」——不对就说一声。',
    teacher_preset: '你自己定的安排，我原样保留。',
    ai_suggestion: '我提的建议，你还没表态。',
    hypothesis: '我按经验猜的，边框是虚线——要到现场看过才算数。',
    pending_validation: '已经写下来了，但要等你在班上试过再定。',
  };
  for (const [key, label] of Object.entries(BLUEPRINT_STATUS)) {
    const badge = el('span', 'plan-badge plan-badge-prov', label);
    badge.dataset.status = key;
    list.append(legendRow(badge, provText[key]));
  }

  list.append(el('li', 'legend-section', PLAN_AXIS_TITLES.work));
  const workText = {
    draft: '刚写下来，随时可以推翻。',
    adjusting: '正在改，还没停当。',
    needs_review: '下面的内容变过了，这一层的说法要请你再看一眼。',
    settled: '你说过就这样了。',
  };
  for (const [key, meta] of Object.entries(PLAN_WORK_STATUS)) {
    const badge = el('span', 'plan-badge plan-badge-work');
    badge.dataset.work = key;
    badge.append(el('span', 'plan-badge-work-glyph', meta.glyph), document.createTextNode(meta.label));
    list.append(legendRow(badge, workText[key]));
  }

  list.append(el('li', 'legend-section', '另外两种记号'));
  list.append(legendRow(el('span', 'plan-badge plan-badge-stale', '待复查'),
    '上游改动可能牵动了这一项，牌子上写着改的是什么。跟着改、我自己改、这样就行，三种做法里做一种，它才消失。'));
  const msgs = el('span', 'plan-badge plan-badge-msgs', '3 条');
  msgs.dataset.count = '3';
  list.append(legendRow(msgs, '这一项下面已经聊过几条。没聊过的不显示数字。'));
  return list;
}

/**
 * 最近处理 strip — a time-ordered row of nodes she has just been in, whose only
 * action is opening that node's conversation again.
 * @param {Array<{id: string, number?: string, title?: string, at?: string}>} entries
 * @param {{activeId?: string|null, onOpenNode?: (nodeId: string) => void}} [opts]
 * @returns {HTMLElement} #plan-recent (empty and hidden when there is nothing yet)
 */
export function renderRecentStrip(entries, opts = {}) {
  const strip = el('div', 'plan-recent');
  strip.id = 'plan-recent';
  const rows = (Array.isArray(entries) ? entries : []).filter((e) => e && e.id).slice(0, 8);
  // A fresh course gets no 「这里还没有内容」 furniture — an empty strip is
  // simply not there.
  if (!rows.length) {
    strip.hidden = true;
    return strip;
  }
  strip.append(el('span', 'plan-recent-label', '最近处理'));
  for (const row of rows) {
    // textContent, not innerHTML: a chip is one short line and needs no markup,
    // so the model-derived title never reaches a parser at all.
    const title = String(row.title ?? '').trim() || '未命名';
    const chip = el('button', 'plan-recent-chip', `${row.number ? `${row.number} ` : ''}${[...title].slice(0, 16).join('')}`);
    chip.type = 'button';
    chip.dataset.nodeId = row.id;
    chip.title = `${row.number ? `${row.number} ` : ''}${title}`;
    if (opts.activeId && opts.activeId === row.id) {
      chip.classList.add('is-open');
      chip.setAttribute('aria-current', 'true');
    }
    chip.addEventListener('click', () => opts.onOpenNode?.(row.id));
    strip.append(chip);
  }
  return strip;
}

/**
 * The LEFT-panel node view: everything stored about one node, rendered from
 * stored data only. No model call, nothing invented — a field we do not have
 * gets an honest empty state instead of a plausible sentence.
 *
 * The greeting is NOT part of this element: it is passed in only so the call
 * site can see that it is screen furniture, and main.js renders it into
 * #node-greeting where it is never logged, never sent and never exported.
 *
 * @param {Object} node the normalized plan node
 * @param {{number?: string, ancestors?: Array<{id: string, number?: string, title?: string}>,
 *   greeting?: string, related?: Array<{id: string, number?: string, title?: string}>,
 *   onOpenNode?: (nodeId: string) => void, onClose?: () => void}} [opts]
 * @returns {HTMLElement} .node-detail
 */
export function renderNodeDetail(node, opts = {}) {
  const root = el('div', 'node-detail');
  root.dataset.nodeId = node?.id ?? '';
  root.dataset.kind = node?.kind ?? '';

  const crumbs = el('div', 'node-detail-crumbs');
  for (const a of opts.ancestors ?? []) {
    const btn = el('button', 'node-crumb', `${a.number ? `${a.number} ` : ''}${String(a.title ?? '').trim() || '未命名'}`);
    btn.type = 'button';
    btn.dataset.nodeId = a.id;
    btn.addEventListener('click', () => opts.onOpenNode?.(a.id));
    crumbs.append(btn, el('span', 'node-crumb-sep', '›'));
  }
  if (crumbs.childElementCount) root.append(crumbs);

  const head = el('div', 'node-detail-head');
  head.append(el('span', 'plan-num', opts.number ?? ''));
  const title = el('h2', 'node-detail-title');
  title.innerHTML = sanitizeInline(node?.title || '（未命名）');
  head.append(title);
  const badges = el('span', 'plan-badges');
  badges.append(renderPlanBadges(node ?? {}, { stale: Boolean(node?.stale_since) }));
  head.append(badges);
  if (opts.onClose) {
    const close = el('button', 'node-detail-close', '返回整门课的对话');
    close.type = 'button';
    close.addEventListener('click', () => opts.onClose());
    head.append(close);
  }
  root.append(head);

  // Stored fields, each rendered only when it is actually there.
  const meta = el('div', 'node-detail-meta');
  const metaRow = (label, value) => {
    const r = el('div', 'node-detail-meta-row');
    r.append(el('span', 'node-detail-meta-label', label), el('span', 'node-detail-meta-value', value));
    meta.append(r);
  };
  const dates = planDatesText(node);
  if (dates) metaRow('时间', dates);
  if (node?.org_type) metaRow('组织形式', node.org_type);
  if (node?.stale_since) {
    metaRow('待复查', node.stale_reason
      ? `${node.stale_reason}（自 ${node.stale_since} 起）`
      : `上游改动可能牵动了这一项（自 ${node.stale_since} 起）`);
  }
  if (meta.childElementCount) root.append(meta);

  if (node?.summary) {
    const summary = el('div', 'node-detail-summary');
    summary.innerHTML = sanitizeInline(node.summary);
    root.append(summary);
  }

  const body = el('div', 'node-detail-body');
  body.innerHTML = node?.body
    ? sanitizeMarkdown(node.body)
    : '<p><em>这一项还没有展开说明。</em></p>';
  root.append(body);

  // The five-part 你说过／我据此猜／… block, from stored rationale only. Plan
  // nodes carry no `rationale` field — contract.zh.md puts a plan node's 依据
  // in its body, and normalizePlan drops anything else — so on the plan tree
  // this is the empty state, which says where 依据 actually lives instead of
  // promising a field nothing can fill. Its absence is stated rather than
  // papered over: an invented 「你说过」 is exactly the
  // fabrication non-negotiable #1 forbids.
  if (node?.rationale) root.append(renderRationale(node.rationale));
  else root.append(el('div', 'node-detail-empty', '计划节点没有单独的依据栏——为什么这样安排，写在上面的正文里。正文里没说清楚的，在下面的对话里问我，我把正文补上。'));

  const related = (opts.related ?? []).filter((r) => r && r.id);
  if (related.length) {
    const box = el('div', 'node-detail-related');
    box.append(el('span', 'node-detail-related-label', '相关的项'));
    for (const r of related) {
      const btn = el('button', 'node-related-chip', `${r.number ? `${r.number} ` : ''}${String(r.title ?? '').trim() || '未命名'}`);
      btn.type = 'button';
      btn.dataset.nodeId = r.id;
      btn.addEventListener('click', () => opts.onOpenNode?.(r.id));
      box.append(btn);
    }
    root.append(box);
  }
  return root;
}

/**
 * Randomised node greetings — screen furniture above the composer in node mode.
 *
 * Exported as data plus a pure picker precisely so it is obvious at the call
 * site that this string is NOT agent speech: it is never appended to the
 * transcript, never passed to logEvent, never put in a request body and never
 * exported. The `node_opened` session-log event carries the observability duty
 * instead (ADR-0010 §8).
 * @type {ReadonlyArray<string>}
 */
export const NODE_GREETINGS = Object.freeze([
  '我们来看「{title}」这一段。',
  '「{title}」——想从哪儿说起都行。',
  '打开了「{title}」，你想改哪一处？',
  '这一项是「{title}」，你说，我记。',
  '「{title}」在这儿了，慢慢来。',
  '来聊「{title}」。哪里不合适，直接说。',
  '「{title}」——要不要先看看当初为什么这么排？',
  '我把「{title}」调出来了，你先说想法。',
  '这一段是「{title}」，改动只落在它身上。',
  '「{title}」，我们一句一句捋。',
]);

/** Stable small hash so a seedless pick is deterministic per node title — a
 * node that greets differently on every repaint reads as a glitch, and a test
 * cannot pin a Math.random(). */
function greetingHash(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) % 100003;
  return h;
}

/**
 * One greeting for one node. Deterministic: same title (and same seed) in, same
 * sentence out. Callers wanting variety across opens pass a seed of their own.
 * @param {string} nodeTitle
 * @param {number} [seed]
 * @returns {string}
 */
export function pickGreeting(nodeTitle, seed) {
  const title = String(nodeTitle ?? '').trim() || '这一项';
  const base = Number.isFinite(Number(seed)) ? Math.trunc(Number(seed)) : greetingHash(title);
  const i = ((base % NODE_GREETINGS.length) + NODE_GREETINGS.length) % NODE_GREETINGS.length;
  return NODE_GREETINGS[i].split('{title}').join(title);
}

// ------------------------------------------------------------------ receipts
//
// Every state-changing turn says what it wrote (ADR-0010 §7): a toast with undo
// at the moment, plus one compact line under that turn's reply. Both are
// EVENTS, not messages — composed from the engine's own parts, never from the
// model's prose, never pushed into the transcript, never sent back to the model.

/** Default wording per part kind. `label` from the caller wins, so the engine
 * can say 「周2 已改」 where a generic count would be vaguer than the truth. */
const RECEIPT_KIND_TEXT = {
  memory: (n) => `记住了 ${n} 条`,
  confirm: (n) => `已确认 ${n} 处`,
  edit: (n) => `已改 ${n} 处`,
};

/** One receipt part → one phrase. textContent all the way down: a part label
 * may quote a node title, and a receipt is the one line that must never be a
 * place where model text meets a parser. */
function receiptPartText(part) {
  const count = Math.trunc(Number(part?.count) || 0);
  const label = String(part?.label ?? '').trim();
  if (label) return label;
  const fn = RECEIPT_KIND_TEXT[part?.kind];
  return fn ? fn(count) : `写入 ${count} 项`;
}

/** The whole receipt as one line: 「记住了 1 条 · 已确认 2 处 · 周2 已改」. */
function receiptLineText(receipt) {
  const parts = (receipt?.parts ?? []).filter(Boolean).map(receiptPartText).filter(Boolean);
  return parts.length ? parts.join(' · ') : '这一轮没有改动记录';
}

/**
 * The compact per-turn receipt line under a turn's reply.
 *
 * Re-rendered from cst.receipts on replay, so an undone receipt must READ as
 * undone — struck, with the undo gone — rather than quietly offering to undo
 * something twice.
 * @param {{id: string, at?: string, parts?: Array<{kind?: string, count?: number, label?: string, node_ids?: string[]}>,
 *   undoable?: boolean, undone?: boolean}} receipt
 * @param {{onUndo?: (receiptId: string) => void, onDetail?: (receiptId: string) => void}} [opts]
 * @returns {HTMLElement} .turn-receipt
 */
export function renderTurnReceipt(receipt, opts = {}) {
  const row = el('div', 'turn-receipt');
  row.dataset.receiptId = receipt?.id ?? '';
  if (receipt?.undone) row.classList.add('is-undone');
  row.append(el('span', 'receipt-line', receiptLineText(receipt)));
  if (opts.onDetail) {
    const detail = el('button', 'receipt-detail-btn', '看改了什么');
    detail.type = 'button';
    detail.addEventListener('click', () => opts.onDetail(receipt.id));
    row.append(detail);
  }
  if (receipt?.undone) {
    row.append(el('span', 'receipt-undone-note', '已撤销'));
  } else if (receipt?.undoable && opts.onUndo) {
    const undo = el('button', 'receipt-undo', '撤销');
    undo.type = 'button';
    undo.addEventListener('click', () => opts.onUndo(receipt.id));
    row.append(undo);
  }
  return row;
}

/**
 * The same receipt as a transient toast. The renderer stays DOM-pure: main.js
 * owns #toast-host and the dismissal timer, so nothing here schedules work that
 * would outlive the element.
 * @param {Parameters<typeof renderTurnReceipt>[0]} receipt
 * @param {{onUndo?: (receiptId: string) => void, onDismiss?: (receiptId: string) => void,
 *   timeoutMs?: number}} [opts]
 * @returns {HTMLElement} .receipt-toast
 */
export function renderReceiptToast(receipt, opts = {}) {
  const toast = el('div', 'receipt-toast');
  toast.dataset.receiptId = receipt?.id ?? '';
  toast.setAttribute('role', 'status');
  // The timeout is the caller's to run; it rides as a custom property only so a
  // progress hairline in styles.css can match the real dismissal.
  const ms = Math.trunc(Number(opts.timeoutMs) || 0);
  if (ms > 0) toast.style.setProperty('--receipt-timeout', `${ms}ms`);
  toast.append(el('span', 'receipt-line', receiptLineText(receipt)));
  if (opts.onUndo && !receipt?.undone) {
    const undo = el('button', 'receipt-undo', '撤销');
    undo.type = 'button';
    undo.addEventListener('click', () => opts.onUndo(receipt.id));
    toast.append(undo);
  }
  if (opts.onDismiss) {
    const close = el('button', 'receipt-toast-close', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', '收起这条提示');
    close.addEventListener('click', () => opts.onDismiss(receipt.id));
    toast.append(close);
  }
  return toast;
}

// ------------------------------------------------------------------ step zero

// The checklist ROWS and the course_state derivation behind them live in
// plan-view.mjs (STEP_ZERO_ITEMS / stepZeroStatus): they are pure logic with a
// non-negotiable riding on them — 已知 must mean the teacher said it — and that
// belongs somewhere a test can reach, not in a DOM factory.

/**
 * The 「看看做出来是什么样」 sample. FROZEN and module-level so a test can pin
 * it: it contains ZERO child-observation-shaped text — no children's words, no
 * discoveries, no interests, no reactions. A sample that showed invented child
 * evidence would teach the teacher that this tool fabricates it.
 * @type {string}
 */
export const STEP_ZERO_SAMPLE = [
  '月计划 · 走进老街的手艺（3 周）',
  '  周1 先去看一看',
  '    活动 逛一逛老街，找会手艺的铺子    5月11日',
  '    活动 把看到的画下来，摆一个小展台  5月13日',
  '  周2 动手试一试',
  '    活动 请一位老师傅来班里做一次      5月19日',
  '    活动 用班里的材料仿着做一做        5月21日',
  '  周3 说给别人听',
  '    活动 布置一个小小的展览            5月26日',
  '',
  '每一项都带两个记号：一个说它有多确定，一个说它做到哪一步。',
  '上面是示例，不是你的课程。',
].join('\n');

/**
 * Step zero — what the panel shows before a plan exists: what this workbench
 * is, a LIVE checklist of what has been understood so far, and a collapsed
 * sample for the teacher who wants to see the shape of the thing first.
 *
 * Every row comes from the caller's derivation of course_state; a 「已知」 row
 * may show the teacher's own recorded value, and a missing row shows its label
 * and invents nothing.
 * @param {{items?: Array<{key: string, label: string, known?: boolean, value?: string}>}} status
 * @param {{headline?: string, onSampleOpen?: () => void}} [opts]
 * @returns {HTMLElement} #plan-step-zero
 */
export function renderStepZero(status, opts = {}) {
  const root = el('div', 'step-zero');
  root.id = 'plan-step-zero';
  root.append(el('div', 'step-zero-headline', opts.headline || '这块面板会长出你的课程计划'));
  root.append(el('p', 'step-zero-lead',
    '现在还空着。我们在左边聊，下面这几件事清楚了，月计划、周计划和活动就会一条条出现在这里。'));

  const list = el('ul', 'step-zero-checklist');
  list.id = 'step-zero-checklist';
  for (const item of status?.items ?? []) {
    const li = el('li', 'checklist-item');
    li.dataset.key = item.key ?? '';
    li.dataset.state = item.known ? 'known' : 'missing';
    li.append(el('span', 'checklist-mark', item.known ? '已知' : '待聊'));
    li.append(el('span', 'checklist-label', item.label ?? item.key ?? ''));
    // Only a known row may carry a value, and the value is hers — textContent,
    // clipped, never markdown.
    if (item.known && item.value) {
      li.append(el('span', 'checklist-value', [...String(item.value)].slice(0, 60).join('')));
    }
    list.append(li);
  }
  root.append(list);

  const sample = document.createElement('details');
  sample.className = 'step-zero-sample';
  sample.id = 'step-zero-sample';
  sample.append(el('summary', '', '看看做出来是什么样'));
  sample.append(el('pre', 'step-zero-sample-body', STEP_ZERO_SAMPLE));
  if (opts.onSampleOpen) sample.addEventListener('toggle', () => { if (sample.open) opts.onSampleOpen(); });
  root.append(sample);
  return root;
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
 * carries 2+ questions: horizontal scroll-snap track of cards (swipe / ‹ › /
 * segments) and a 查看全部 stacked-list toggle for the review-everything pass.
 * Cards have no send of their own: per-card 确认 locks an answer into the
 * shared staged batch (§5c) and the composer packages the whole set into one
 * teacher message — skipped cards report as 跳过 (a skip is information too).
 * Chips fill their own card's answer field (insert, never auto-send).
 * @param {Array<import('../types.mjs').TurnQuestion>} questions
 * @param {{ answers?: Array<{value: string, skipped: boolean, locked: boolean}>, onChange?: () => void }} opts
 */
export function renderQuestionCards(questions, opts = {}) {
  const root = el('div', 'qcards');
  const track = el('div', 'qcards-track');
  root.append(track);

  // Answer state is owned by main.js (DESIGN.md §5c) so the living answers
  // survive a re-render; the 问题卡 tab and its second 'queue' renderer are
  // gone (ADR-0010 §3) — cards have ONE renderer now. Each entry:
  // {value, skipped, locked} — locked = 确认-staged into the composer tray.
  const answers = opts.answers ?? questions.map(() => ({ value: '', skipped: false, locked: false }));
  const notify = () => opts.onChange?.();

  const counter = el('span', 'qcards-count');
  const hint = el('span', 'qcards-hint', '锁定的回答会从下方输入框一起发送');

  const cardCtl = []; // per-card {card, input, lockBtn, skipBtn} for state→DOM sync
  let segs = null;    // segmented progress bar

  const refresh = () => {
    const answered = answers.filter((a) => a.value.trim() || (a.locked && a.skipped)).length;
    const locked = answers.filter((a) => a.locked).length;
    counter.textContent = `已答 ${answered} / 共 ${questions.length}${locked ? ` · 已锁定 ${locked}` : ''}`;
    answers.forEach((a, i) => {
      const ctl = cardCtl[i];
      if (ctl) {
        ctl.card.classList.toggle('skipped', a.skipped);
        ctl.card.classList.toggle('locked', Boolean(a.locked));
        ctl.lockBtn.textContent = a.locked ? '已锁定 · 点按修改' : '确认';
        ctl.lockBtn.disabled = !a.locked && !a.value.trim() && !a.skipped;
        ctl.skipBtn.textContent = a.skipped ? '恢复作答' : '这题先跳过';
      }
      const seg = segs?.children[i];
      if (!seg) return;
      seg.classList.toggle('done', Boolean(a.value.trim() || (a.locked && a.skipped)));
      seg.classList.toggle('skipped', a.skipped);
      seg.classList.toggle('locked', Boolean(a.locked));
    });
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
        answers[i] = { value: example, skipped: false, locked: false };
        refresh();
        notify();
        input.focus();
      });
      chipRow.append(chip);
    }
    card.append(chipRow);

    const input = el('textarea', 'qcard-input');
    input.rows = 2;
    input.placeholder = '写你的回答，或点上面的示例改一改';
    input.value = answers[i]?.value ?? '';
    input.addEventListener('input', () => {
      // Editing a locked card unlocks it — it leaves the staged batch until
      // confirmed again (§5c).
      answers[i] = { value: input.value, skipped: false, locked: false };
      refresh();
      notify();
    });
    card.append(input);

    const foot = el('div', 'qcard-foot');
    const skip = el('button', 'qcard-skip', '这题先跳过');
    skip.type = 'button';
    skip.addEventListener('click', () => {
      const on = !answers[i].skipped;
      // An explicit skip is information too — it stages as locked 跳过. The
      // typed draft survives in `value` so 恢复作答 brings it back; packing
      // reports locked+skipped as 跳过 regardless of value.
      answers[i] = on
        ? { value: input.value, skipped: true, locked: true }
        : { ...answers[i], skipped: false, locked: false };
      input.value = on ? '' : answers[i].value;
      refresh();
      notify();
    });
    const lock = el('button', 'qcard-lock', '确认');
    lock.type = 'button';
    lock.title = '锁定这个回答，随下一次发送一起提交';
    lock.addEventListener('click', () => {
      const a = answers[i];
      if (a.locked) answers[i] = { ...a, locked: false };
      else if (a.value.trim() || a.skipped) answers[i] = { ...a, locked: true };
      refresh();
      notify();
    });
    foot.append(skip, lock);
    card.append(foot);

    cardCtl.push({ card, input, lockBtn: lock, skipBtn: skip });
    track.append(card);
  });

  // Cross-view sync: when the OTHER renderer edits the shared answers, this
  // one repaints from state (skipping a textarea the teacher is typing in).
  const syncFromState = () => {
    answers.forEach((a, i) => {
      const ctl = cardCtl[i];
      if (ctl && document.activeElement !== ctl.input && ctl.input.value !== (a.value ?? '')) {
        ctl.input.value = a.value ?? '';
      }
    });
    refresh();
  };
  opts.registerView?.(syncFromState);

  // nav: ‹ [segmented answer-progress bar] › + 查看全部. The segments replace
  // the old dots: one wide clickable segment per card, filled when answered,
  // hollow when pending, hatched when skipped, ringed when in view — progress
  // AND position in one strip loud enough to say "there are more cards".
  {
    const nav = el('div', 'qcards-nav');
    const prev = el('button', 'qcards-arrow', '‹');
    prev.type = 'button';
    prev.setAttribute('aria-label', '上一张');
    const next = el('button', 'qcards-arrow', '›');
    next.type = 'button';
    next.setAttribute('aria-label', '下一张');
    segs = el('div', 'qcards-segs');
    segs.setAttribute('role', 'tablist');
    questions.forEach((_, i) => {
      const seg = el('button', 'qcards-seg');
      seg.type = 'button';
      seg.setAttribute('aria-label', `第 ${i + 1} 张，共 ${questions.length} 张`);
      seg.append(el('span', 'qcards-seg-num', String(i + 1)));
      seg.addEventListener('click', () => scrollToCard(i));
      segs.append(seg);
    });
    const listToggle = el('button', 'qcards-list-toggle', '查看全部');
    listToggle.type = 'button';
    nav.append(prev, segs, next, listToggle);
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
    const markSeg = () => {
      const idx = focusedIndex();
      [...segs.children].forEach((d, i) => d.classList.toggle('on', i === idx));
    };
    track.addEventListener('scroll', () => requestAnimationFrame(markSeg), { passive: true });
    markSeg();

    listToggle.addEventListener('click', () => {
      const listed = root.classList.toggle('as-list');
      listToggle.textContent = listed ? '收起为卡片' : '查看全部';
      nav.classList.toggle('list-mode', listed);
    });
  }

  // Status bar — the cards themselves never send (§5c: the composer is the
  // only mouth). The counter + hint replace the old 一起发送 button.
  const bar = el('div', 'qcards-bar');
  bar.append(counter, hint);
  root.append(bar);

  refresh();
  return root;
}

/** Disable answering (chips, inputs, skip, lock) but keep review navigation
 * (arrows / dots / 查看全部) alive — a submitted set can still be re-read. */
function freezeAnswerControls(rootEl) {
  for (const control of rootEl.querySelectorAll('.qcard button, .qcard textarea')) {
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
    // Two light provenances, visually distinct: ⚙ = engine-verified (computed
    // from blueprint absorption — cannot be faked by the model), ✓ = the model
    // claimed it in completed_nodes. An honest map says which is which.
    const engineLit = new Set(info.state.engine_lit_nodes || []);
    for (let stage = 0; stage <= 5; stage += 1) {
      const stageBox = el('div', 'wf-map-stage' + (info.state.stage === stage ? ' current' : ''));
      stageBox.append(el('div', 'wf-map-stage-title', STAGE_NAMES[stage]));
      for (const node of WF_NODES.filter((n) => n.stage === stage)) {
        const isDone = done.has(node.id);
        const byEngine = engineLit.has(node.id);
        const prereqs = NODE_PREREQS[node.id] || [];
        const hint = !isDone && prereqs.length ? ` ←${prereqs.join(' ')}` : '';
        const mark = byEngine ? '⚙' : isDone ? '✓' : '·';
        stageBox.append(el('div', 'wf-map-node' + (isDone ? ' done' : '') + (byEngine ? ' engine' : ''), `${mark} ${node.id} ${node.name}${hint}`));
      }
      map.append(stageBox);
    }
    map.append(el('div', 'wf-map-legend', '⚙ 引擎核验（由蓝图吸收自动点亮，模型无法伪造） · ✓ 模型自报 · ← 前置节点'));
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
      ? Object.entries(ev.usage).map(([k, v]) => `${k}=${v && typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')
      : 'usage: —';
    const lines = [el('div', '', `${ev.providerLabel ?? ev.provider ?? '—'} · ${usage}`)];
    if (ev.cache) {
      const pct = ev.cache.prompt_tokens ? ` (${Math.round((ev.cache.cached_tokens / ev.cache.prompt_tokens) * 100)}%)` : '';
      lines.push(el('div', '', `prompt cache: ${ev.cache.cached_tokens} / ${ev.cache.prompt_tokens ?? '?'}${pct}`));
    }
    for (const g of ev.guards ?? []) {
      lines.push(el('div', '', `guard: ${g.event}${g.budget_ms ? ` budget=${g.budget_ms}ms` : ''}${g.limit_ms ? ` limit=${g.limit_ms}ms` : ''}${g.draft_chars ? ` draft=${g.draft_chars}字` : ''}`));
    }
    const wrap = el('div', '');
    for (const l of lines) wrap.append(l);
    container.append(debugSection('provider', wrap));
  }
}
