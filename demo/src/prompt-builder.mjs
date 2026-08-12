// prompt-builder.mjs — shared, pure system-prompt assembly (server + demo UI).
// Extracted from demo/serve.mjs so the SAME assembly runs on the server (fs
// loader) and in the browser (fetch loader, 开发者模式 prompt visibility).
// The prompt files in demo/src/prompts/ are read as-is and never modified.

import { toSkeletonTSV, ancestorsOf, walkPlan } from './plan-tsv.mjs';
import { factsToTSV, PROMPT_SCOPES } from './memory-scopes.mjs';
import {
  vectorToDirectives, describeVector, axisDirective, isReadableVector, defaultVector,
  EVIDENCE_INVARIANT,
} from './interaction-axes.mjs';

/** Stage → prompt module name (stage 4 reuses the stage3 module by design). */
export const STAGE_MODULE = { 0: 'stage0', 1: 'stage1', 2: 'stage2', 3: 'stage3', 4: 'stage3', 5: 'stage5' };

/** @param {Object} state @returns {string} the prompt module name for a state */
export function stageModuleName(state) {
  return STAGE_MODULE[state?.stage] ?? 'stage0';
}

const FENCE = '```';

/**
 * 回应风格 → the exact directive injected into the system prompt.
 *
 * THE FALLBACK, NOT THE MECHANISM, since 2026-08-13. ADR-0009 §1 replaced the
 * single selector with the six-axis vector, and `interactionSectionText` renders
 * that vector when the profile carries one. This map still runs — unchanged, to
 * the byte — for every profile that does not, which today is every profile that
 * exists: nothing writes `interaction_vector` yet. Deleting it would change the
 * behaviour of every shipped teacher on the day the vector lands, which is the
 * one thing the migration may not do （ADR-0009 consequences）.
 *
 * Single source of truth for the legacy path: the profile UI builds its choices
 * and its explanations from this map, so the teacher reads precisely what the
 * model is told.
 */
export const STYLE_DIRECTIVES = {
  '简洁要点（直接给做法）': '回应尽量精炼：先给可执行的做法，再用一两句话说明，不铺陈。',
  '温和鼓励（多肯定、慢慢来）': '先肯定教师已有的做法，语气温和，节奏放慢，一次只推进一小步。',
  '详细讲解（讲清为什么）': '把建议背后的原因讲清楚：为什么这样做、依据是什么、要注意什么。',
  '案例参照（多给真实例子）': '尽量用贴近幼儿园现场的具体例子来说明建议，让教师能直接对照。',
  '提问引导（先问再建议）': '先用一两个问题澄清现场情况，弄清楚了再给建议，不急着下结论。',
  '极简速览（电报体、越短越好）': '回应用电报体：先结论后原因，短句，删客套删铺陈；但活动步骤、材料清单、安全提醒、观察点必须完整列出，不因求短而漏项；对教师仍保持友善，不显得冷硬。',
  '蓝图共创（先给完整方案再一起改）': '教师提出计划类需求时，先依据已有信息给出尽量完整的整体方案（主题定位、阶段路径、活动组合、观察点），未发生的儿童反应一律标注「预设，待现场验证」，不写成已发生事实；每轮先交付内容，最多再问两三个关键问题；教师回传证据后，先对照原方案说明哪些保留、哪些调整，再给下一步。',
};

/**
 * Render the optional 教师档案 section (read-only context; NEVER state).
 * Returns '' when the profile is absent or has no filled fields.
 * v2 fields (all optional, DESIGN.md §4): province+region, ageRange,
 * teachYears, tenureYears, role, classBands[] (falls back to legacy ageBand),
 * classSize, stylePref.
 * @param {{province?: string, region?: string, ageRange?: string,
 *          teachYears?: string, tenureYears?: string, role?: string,
 *          classBands?: string[], ageBand?: string,
 *          classSize?: string|number, stylePref?: string}|null|undefined} profile
 */
export function profileSectionText(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const s = (v) => String(v ?? '').trim();
  const parts = [];
  const region = [s(profile.province), s(profile.region)].filter(Boolean).join('');
  if (region) parts.push(`地区：${region}`);
  if (s(profile.ageRange)) parts.push(`年龄段：${s(profile.ageRange)}`);
  if (s(profile.teachYears)) parts.push(`教龄：${s(profile.teachYears)}`);
  if (s(profile.tenureYears)) parts.push(`本园年资：${s(profile.tenureYears)}`);
  if (s(profile.role)) parts.push(`角色：${s(profile.role)}`);
  const bands = Array.isArray(profile.classBands) ? profile.classBands.map(s).filter(Boolean) : [];
  if (bands.length) parts.push(`任教班级：${bands.join('、')}`);
  else if (s(profile.ageBand)) parts.push(`年段：${s(profile.ageBand)}`);
  if (s(profile.classSize)) parts.push(`班额：${s(profile.classSize)}`);
  // ONE STYLE INSTRUCTION, NEVER TWO. When the profile carries a readable
  // vector, the six-axis block downstream IS the style instruction, and leaving
  // the preset sentence here too would hand the model two descriptions of how to
  // write — which is how a teacher who moved one handle finds nothing changed.
  // Free text is different in kind: 「喜欢户外和动手类活动」 is a CONTENT
  // preference the six axes cannot express, so it survives either way.
  const styleDirective = STYLE_DIRECTIVES[s(profile.stylePref)];
  if (styleDirective) { if (!isReadableVector(profile.interaction_vector)) parts.push(`回应风格：${styleDirective}`); }
  else if (s(profile.stylePref)) parts.push(`偏好：${s(profile.stylePref)}`);
  if (!parts.length) return '';
  return `教师档案（只读参考）：${parts.join('；')}。据此调整举例与语气，不要向教师复述档案内容。`;
}

/**
 * The interaction-axis band: the six axes of ADR-0009 §1 rendered as prose.
 *
 * WHY IT SITS IN THE CACHE-STABLE PREFIX, next to 教师档案 and not in the
 * volatile note. The stored vector is teacher-lifetime state: it moves when she
 * pins a handle or when inference nudges one — a handful of times in a career,
 * not once a turn. Putting it in the prefix costs one prefix rebuild on each of
 * those days （exactly what changing `stylePref` costs today）and nothing on
 * every other turn. Putting it in the note would spend ~700 volatile bytes per
 * turn, forever, to describe something that did not change.
 *
 * The genuinely volatile half — 「这次直接给我一版就好」 — is not here. It rides
 * `turnStyleNoteText` in the note, late, where it can differ every turn without
 * touching the prefix and where recency helps adherence. 后台判断稳定，前台表达
 * 灵活, split along the exact seam the cache cares about.
 *
 * Returns '' for a profile with no vector, or one this build cannot read whole
 * （see `isReadableVector`）— and in that case `profileSectionText` above has
 * kept the legacy 回应风格 line, so the model is never left with no style
 * instruction at all.
 *
 * @param {{interaction_vector?: Object}|null|undefined} profile
 * @returns {string}
 */
export function interactionSectionText(profile) {
  const vector = profile && typeof profile === 'object' ? profile.interaction_vector : null;
  return isReadableVector(vector) ? vectorToDirectives(vector) : '';
}

/** Section separator, shared by the system prompt and the per-turn note. */
const SECTION_SEP = '\n\n---\n\n';

/**
 * Assemble the full system prompt: base + contract + stage module + live
 * state snapshot (+ optional 教师档案 section). Byte-identical to the legacy
 * serve.mjs assembly when opts.profile is empty.
 * Kept for the debug drawer's mock reconstruction and prompt visibility;
 * real vendor requests use buildPromptParts so the volatile state snapshot
 * stops busting the vendors' automatic prefix caches. It takes the same opts
 * so the drawer shows the bands that were actually sent — a prompt-visibility
 * surface that shows less than the request did is worse than none.
 * @param {Object} state current course_state
 * @param {(name: string) => string|Promise<string>} loadPrompt injected loader
 * @param {{profile?: Object, subject?: string, facts?: Array<Object>}} [opts]
 * @returns {Promise<string>}
 */
export async function buildSystemPrompt(state, loadPrompt, opts = {}) {
  const base = await loadPrompt('base');
  const contract = await loadPrompt('contract');
  const stageDoc = await loadPrompt(stageModuleName(state));
  const sections = [
    base,
    contract,
    stageDoc,
    stateNoteText(state, opts),
  ];
  const profileText = profileSectionText(opts.profile);
  if (profileText) sections.push(profileText);
  const interactionText = interactionSectionText(opts.profile);
  if (interactionText) sections.push(interactionText);
  return sections.join(SECTION_SEP);
}

// ---------------- context bands (ADR-0007 §1, §4) ----------------
//
// A turn used to ship the whole world: `JSON.stringify(state, null, 1)`, every
// key on its own line, every node body inlined, no matter what the turn was
// about. The bands replace that with what this turn needs — and the tiering,
// not the format, is the larger half of the saving (ADR-0007 §4): TSV removes
// braces and quotes, addressing bodies instead of inlining them removes whole
// paragraphs of Chinese prose that tokenize the same in any format.
//
// THE MODEL NEVER PICKS ITS OWN BAND. The engine computes them from the turn
// subject. A node turn that needs something outside its bands asks for it in
// the reply; there is no silent full-state fallback, because a silent fallback
// makes the whole measurement meaningless.

/** Collapse to a single display line. Titles and summaries are display
 * strings; bodies are NOT run through this — see `ancestorSummary`. */
const line = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** What the snapshot says where the plan tree used to be. Shipping the tree as
 * pretty JSON *and* as a skeleton table would cost more than today, not less. */
const PLAN_IN_SKELETON = '见下方「课程计划骨架」表；节点正文经焦点带送达，不在快照里';

/** Newest revision reasons kept in the focus band. A node reopened weekly for a
 * term would otherwise grow its own band without bound. */
const REVISIONS_SHOWN = 8;

/**
 * The skeleton band: one row per plan node, titles and statuses only.
 * Always present once a plan exists — the model can address any part of the
 * month from it, and asks for the bodies it actually needs.
 * @param {{version?: string, roots?: Array}|null|undefined} plan `state.course_plan`
 * @returns {string} '' when there is no plan to render
 */
export function skeletonBandText(plan) {
  if (!plan || !Array.isArray(plan.roots) || !plan.roots.length) return '';
  return `# 课程计划骨架（只读；本表只有标题与状态，需要哪个节点的正文就在回复里说）\n\n${FENCE}tsv\n${toSkeletonTSV(plan)}\n${FENCE}`;
}

/** The heading every memory band starts with. Its own constant because the
 * assembler's ADR-0011 §5 assertion recognises the band by it — a heading edited
 * in one place and matched in another is how the assertion would quietly stop
 * asserting anything. */
const MEMORY_HEADING = '# 记忆（教师、班级与课程；每轮完整给出，不做筛选）';

/** What the band says when it has nothing to say. THE ENTIRE POINT OF ADR-0011
 * §5, in one sentence aimed at the model rather than at us: 「we looked」 and
 * 「we did not look」 must not read the same. Without it a zero-row band and an
 * absent band are the same evidence — and one of them means the class has no
 * constraints while the other means the constraints failed to load. */
const MEMORY_EMPTY_NOTE = '：查过了，这位教师、这个班、这门课目前都没有记下约束——是查过之后没有，不是没查';

/**
 * The memory band: teacher, class and course facts, EVERY TURN, whole.
 *
 * NOT RETRIEVED BY RELEVANCE, and that is the entire design. 「我们班没有鼓」
 * constrains every activity in every week; one retrieval miss two days later
 * offers her 敲鼓感受节奏 and reproduces 「我早就跟你说过」 — the exact failure the
 * class scope was created to prevent. A band that is always whole cannot miss.
 * Growth is bounded upstream by curation (`capFacts`, which says so out loud),
 * never by quietly dropping rows here.
 *
 * WIDEST FIRST (`PROMPT_SCOPES`, whose comment owns the reasoning): teacher,
 * then class, then course. Teacher scope is rendered because `widenScope` can
 * put a fact there by her deliberate tap, and a band that skipped it would
 * answer 「这对我带的每个班都成立」 by dropping the fact out of every future
 * prompt.
 *
 * THE TWO ABSENCES ARE DIFFERENT, AND BOTH ARE SPELLED OUT (ADR-0011 §5):
 *   - `null`/`undefined` — memory was NOT LOOKED UP on this path (or the lookup
 *     failed and the caller passed null, which `listFacts` is specified to make
 *     possible by throwing rather than returning []). The band is omitted
 *     entirely, so the model is told nothing about memory rather than told there
 *     is none.
 *   - an EMPTY ARRAY — memory WAS looked up and is genuinely empty. Every scope
 *     header renders, the count reads 0, and the heading says out loud that this
 *     is a result and not a gap.
 * A layer that coerces a failed load into `[]` therefore tells the model this
 * class has no constraints, which is the 「我早就跟你说过」 failure arriving
 * through an infrastructure fault. The two shapes are kept visibly different so
 * that mistake is a test failure rather than a support ticket.
 *
 * @param {Array<Object>|null|undefined} facts live and archived facts; archived
 *   ones are excluded by `factsToTSV`
 * @returns {string} '' only when facts were not supplied at all
 */
export function memoryBandText(facts) {
  if (facts == null) return '';
  const blocks = PROMPT_SCOPES.map((scope) => factsToTSV(facts, scope));
  // Every block is a header comment line, a column header line, then one line
  // per live fact — `flatten` strips tabs and newlines out of every cell, so a
  // fact can never span lines and this count cannot drift from the rows.
  const rows = blocks.reduce((n, b) => n + Math.max(0, b.split('\n').length - 2), 0);
  const heading = `${MEMORY_HEADING} · 共 ${rows} 条${rows ? '' : MEMORY_EMPTY_NOTE}`;
  return `${heading}\n\n${FENCE}tsv\n${blocks.join('\n\n')}\n${FENCE}`;
}

/**
 * 「这次直接给我一版就好」— the one-turn style override (ADR-0009 §2), and the
 * only part of the axis vector that belongs in the volatile note.
 *
 * WHY IT IS SPLIT FROM `interactionSectionText`. The stored vector is stable and
 * rides the cache-stable prefix; an override is by definition true for exactly
 * one turn. Rendering it in the prefix would invalidate the prefix on the
 * override turn AND again on the turn after it, twice per 「这次…」 — for a
 * sentence whose whole value is being read as 「right now」, which is what the
 * tail already does better.
 *
 * ONLY THE AXES THAT ACTUALLY MOVED A BAND. `turnOverride` marks an axis even
 * when the new value sits in the same band, and the band is what selects the
 * sentence — so an override from 4 to 5 says nothing new. Emitting it anyway
 * would spend volatile bytes to repeat an instruction the prefix already gave,
 * and would teach the model that this block is noise.
 *
 * ENDS WITH THE EVIDENCE INVARIANT, like every rendered axis block. This one
 * sits LATER in the assembled prompt than the prefix's copy, and axes such as
 * 主动性「主动提醒与挑战」 read like licence to fill gaps, so the clause has to be
 * downstream of the last directive rather than only of the first
 * (interaction-axes.mjs states that requirement; this is where it is honoured).
 *
 * @param {{interaction_vector?: Object}|null|undefined} profile the STORED
 *   profile, i.e. what the prefix already said
 * @param {Object|null|undefined} turnVector the render-only vector from
 *   `interaction-axes.turnOverride`
 * @returns {string} '' when there is no override, or none that changes a band
 */
export function turnStyleNoteText(profile, turnVector) {
  if (!isReadableVector(turnVector)) return '';
  const storedVector = profile && typeof profile === 'object' ? profile.interaction_vector : null;
  // No stored vector means the prefix rendered no axis block, so 「what the
  // model was already told」 is the default point — the same one the vector
  // module falls back to. Comparing against anything else would let an override
  // look like a no-op when it is not.
  const before = new Map(
    describeVector(isReadableVector(storedVector) ? storedVector : defaultVector()).map((r) => [r.axis, r]),
  );
  const lines = [];
  for (const row of describeVector(turnVector)) {
    if (!row.turnOverride) continue;
    if (before.get(row.axis)?.band === row.band) continue;
    lines.push(`${row.zh}：${axisDirective(row.axis, row.value)}`);
  }
  if (!lines.length) return '';
  return [
    '# 本轮临时表达调整（教师刚提出，只对这一轮有效；她的档案没有改）',
    '',
    ...lines,
    EVIDENCE_INVARIANT,
  ].join('\n');
}

/**
 * Find one node in a RAW (un-normalized) plan tree.
 *
 * Raw on purpose: `normalizePlan` rebuilds every node from a fixed field list,
 * so a node's summary and its revision history — the two things this band
 * exists to carry — would be normalized away before we could read them.
 * @returns {Object|null}
 */
function findPlanNode(plan, id) {
  if (!plan || !id) return null;
  for (const { node } of walkPlan(plan)) if (node?.id === id) return node;
  return null;
}

/**
 * An ancestor's contribution to the focus band: its summary, or its title alone.
 *
 * WE DO NOT CLIP A BODY INTO A SUMMARY. A body ending 「（预设，待现场验证）」 loses
 * exactly that qualifier at the clip, and a hypothesis that arrives in context
 * as a flat statement is non-negotiable #1 violated by formatting. A missing
 * summary says so instead.
 */
function ancestorSummary(node) {
  return line(node.summary) || '（尚无摘要）';
}

/**
 * The recorded reasons a node looks the way it does.
 *
 * FIELD NAME UNKNOWN at the plan layer: nothing writes it yet. ADR-0007 §5
 * fixes the ENTRY shape (`{version, at, by, reason, subject_node}`) but not the
 * property, and engine.mjs's `revision_log` belongs to the blueprint, not to a
 * plan node. Both names are read so whichever the engine settles on lands here.
 * Entries carrying no reason are dropped — an empty bullet teaches nothing and
 * still costs tokens.
 */
function revisionReasons(node) {
  const raw = Array.isArray(node.revisions) ? node.revisions
    : (Array.isArray(node.revision_log) ? node.revision_log : []);
  return raw
    .filter((r) => r && typeof r === 'object' && line(r.reason))
    .map((r) => ({ version: line(r.version ?? r.v), at: line(r.at), by: line(r.by), reason: line(r.reason) }));
}

/**
 * The focus band: the subject node's own body, its ancestors' summaries, and
 * its recorded revision reasons.
 *
 * NOT THE CONVERSATION THAT PRODUCED THEM (ADR-0007 §5). The artifact is the
 * memory: a node reopened two weeks later carries why it looks like this on
 * itself, instead of pointing at a chat turn that fell out of the window.
 *
 * Both status axes ride the header line. The band hands the model a body that
 * may describe children who have not met yet, so it must arrive labelled: a
 * `hypothesis` body read as a `confirmed` one is the failure this repository is
 * built around.
 *
 * @param {{version?: string, roots?: Array}|null|undefined} plan `state.course_plan`
 * @param {string|null|undefined} subject the turn's subject — a node id, or
 *   `'course'` for a course-level turn, which has no focus node
 * @returns {string} '' when the subject names no node in this plan
 */
export function focusBandText(plan, subject) {
  const node = findPlanNode(plan, typeof subject === 'string' ? subject.trim() : '');
  if (!node) return '';

  // Defaults mirror normalizePlan's, so the focus header and the skeleton row
  // for the same node can never disagree — and both default to the weaker claim.
  const status = line(node.status) || 'ai_suggestion';
  const work = line(node.work_status) || 'draft';
  const stale = node.stale_since ? `；待复查（自 ${line(node.stale_since)}${node.stale_reason ? `，因 ${line(node.stale_reason)}` : ''}）` : '';
  const out = [`# 焦点节点 ${node.id}「${line(node.title) || '未命名'}」（来源状态：${status}；工作状态：${work}${stale}）`];

  const chain = ancestorsOf(plan, node.id);
  if (chain.length) {
    out.push('', '## 上级脉络（只给摘要，不给正文）');
    for (const a of chain) out.push(`- ${a.id}「${line(a.title) || '未命名'}」：${ancestorSummary(a)}`);
  }

  out.push('', '## 本节点正文', String(node.body ?? '').trim() || '（尚无正文）');

  const revs = revisionReasons(node);
  if (revs.length) {
    const shown = revs.slice(-REVISIONS_SHOWN);
    const hidden = revs.length - shown.length;
    out.push('', '## 已记录的修订原因（旧到新）');
    // Say what was left out. Silent truncation is barred (AGENTS.md), and here
    // the omission is exactly the kind she would have wanted to see.
    if (hidden > 0) out.push(`（更早的 ${hidden} 条未列出，完整记录在节点上）`);
    for (const r of shown) {
      const stamp = [r.version && `v${r.version}`, r.at, r.by].filter(Boolean).join(' · ');
      out.push(`- ${stamp ? `${stamp}：` : ''}${r.reason}`);
    }
  }

  return out.join('\n');
}

/**
 * ADR-0011 §5's assertion, as its own function so it can be tested in the
 * direction that matters.
 *
 * §5 rejected a pre-send harness check for memory and asked for 「an assertion
 * inside the assembler plus a unit test, catching the regression where a
 * refactor silently stops appending memory」. Inline in `stateNoteText` it would
 * be untestable in the firing direction — today's `memoryBandText` returns a
 * band for every array, so no input can make it fire, which is precisely what a
 * tripwire for a FUTURE refactor should look like. Pulled out here, both
 * directions are ordinary arguments.
 *
 * It throws rather than warns. Memory fetched and then not shipped is a bug in
 * our own code, and the symptom it produces — the model offering 敲鼓感受节奏 to a
 * class with no drums — is indistinguishable from the feature never having been
 * built. A failed turn is loud; a silently memory-less prompt is 「我早就跟你说
 * 过」 with nothing on screen to explain it.
 *
 * @param {Array<string>} sections the note's assembled sections
 * @param {Array<Object>|null|undefined} facts what the caller passed as memory
 * @throws {Error} when memory was looked up and the band is not in the note
 */
export function assertMemoryBand(sections, facts) {
  if (!Array.isArray(facts)) return; // not looked up → correctly absent
  if (sections.some((s) => String(s).startsWith(MEMORY_HEADING))) return;
  throw new Error(
    'prompt-builder: memory was looked up but the 记忆 band is missing from the per-turn note '
    + '(ADR-0011 §5). A prompt assembled this way tells the model the class has no constraints.',
  );
}

/**
 * The volatile per-turn note: live state snapshot + pacing, then the skeleton,
 * memory, one-turn style and focus bands.
 *
 * BAND ORDER IS DELIBERATE, widest context first and most specific last:
 *   snapshot+pacing → 课程计划骨架 → 记忆 → 本轮临时表达调整 → 焦点节点
 * Focus sits last, nearest the teacher's newest message, for the same recency
 * reason this whole note is a trailing system message rather than part of the
 * prefix. The one-turn style override sits directly above it because it is the
 * only other thing here that is true of THIS turn alone.
 *
 * THE ADR-0011 §5 ASSERTION LIVES HERE. That section rejected a pre-send harness
 * check for memory and asked instead for 「an assertion inside the assembler plus
 * a unit test, catching the regression where a refactor silently stops appending
 * memory」. This is it, and it is deliberately a throw: memory having been looked
 * up and then not shipped is a bug in our own code, not a condition in the
 * world, and the symptom it produces downstream — the model offering 敲鼓感受节奏
 * to a class with no drums — is indistinguishable from the feature never having
 * been built. Failing the turn is loud; shipping a silently memory-less prompt
 * is 「我早就跟你说过」 with nothing on screen to explain it.
 *
 * DEGRADES TO THE BYTE. No `course_plan`, no `facts`, no `subject`, no override
 * → the output is exactly what it was before the bands existed. That is not
 * politeness to old fixtures: every caller that has not been taught about bands
 * yet keeps getting a whole, correct prompt rather than a quietly emptied one.
 *
 * @param {Object} state current course_state
 * @param {{subject?: string, facts?: Array<Object>, profile?: Object,
 *   turnVector?: Object}} [opts]
 * @returns {string}
 */
export function stateNoteText(state, opts = {}) {
  const skeleton = skeletonBandText(state?.course_plan);
  // The tree is in the skeleton now; leaving it in the snapshot too would ship
  // it twice. The key stays, pointing at where it went, so nothing reads as
  // "this course has no plan".
  const snapshot = JSON.stringify(skeleton ? { ...state, course_plan: PLAN_IN_SKELETON } : state, null, 1);
  const pacing = state.awaiting_feedback
    ? '当前 awaiting_feedback 为 true：上一轮已收尾，教师尚未回传现场反馈。若这条消息就是回传，先提取证据；若只是追问或要素材，就地支持，不虚构课堂进展。'
    : '';
  const sections = [`# 当前 course_state（只读快照）\n\n${FENCE}json\n${snapshot}\n${FENCE}\n\n${pacing}`];
  if (skeleton) sections.push(skeleton);
  const memory = memoryBandText(opts.facts);
  if (memory) sections.push(memory);
  const turnStyle = turnStyleNoteText(opts.profile, opts.turnVector);
  if (turnStyle) sections.push(turnStyle);
  const focus = focusBandText(state?.course_plan, opts.subject);
  if (focus) sections.push(focus);

  // ADR-0011 §5. Fires on exactly one condition: memory fetched, memory dropped.
  assertMemoryBand(sections, opts.facts);
  return sections.join(SECTION_SEP);
}

/**
 * Cache-friendly split of the same content (2026-07-23, prompt caching):
 * every provider we call runs AUTOMATIC prefix caching (MiniMax cache-hit
 * pricing, Kimi context caching, GLM implicit) — but a cache hit needs a
 * byte-stable token PREFIX, and the legacy assembly put the per-turn state
 * snapshot inside messages[0], invalidating the whole conversation every
 * turn. Split instead:
 *   - `system`: base + contract + stage module + 教师档案 — stable within a
 *     stage, so the static rules AND the whole conversation history behind
 *     them stay cache-hot;
 *   - `stateNote`: snapshot + pacing — injected as a SECOND system message
 *     just before the newest teacher message, where it can change freely
 *     without touching the prefix (and where recency helps adherence).
 * Same sections, same wording — only the placement differs.
 *
 * The split is also what makes the bands affordable (ADR-0007 §1): `system` is
 * the Rules band and must stay byte-stable, so the skeleton, memory and focus
 * bands all ride the note, where changing every turn costs nothing.
 *
 * THE AXIS VECTOR SPLITS ALONG THE SAME SEAM (2026-08-13, ADR-0009 §1/§2). The
 * STORED vector is teacher-lifetime state that moves a handful of times ever, so
 * it renders into `system` beside 教师档案 — one prefix rebuild on the day she
 * moves a handle, nothing on any other turn. The ONE-TURN override renders into
 * `stateNote`, because a sentence true for exactly one turn in the prefix would
 * cost two prefix rebuilds every time she uses it. 后台判断稳定，前台表达灵活,
 * cut where the cache can see it.
 *
 * @param {Object} state current course_state
 * @param {(name: string) => string|Promise<string>} loadPrompt injected loader
 * @param {{profile?: Object, subject?: string, facts?: Array<Object>,
 *   turnVector?: Object}} [opts]
 *   `profile` is read-only teacher context and carries `interaction_vector`
 *   (ADR-0009's storage slot) — no separate argument, so a caller that already
 *   passes a profile gets the axes for free.
 *   `subject` is the engine-owned turn subject — a plan node id, or `'course'`;
 *   the model never chooses it.
 *   `facts` are the teacher/class/course memory facts, ALWAYS the whole set
 *   (`store.listFacts`). Pass `null` when the lookup failed — never `[]`, which
 *   asserts to the model that there are no constraints.
 *   `turnVector` is `interaction-axes.turnOverride(...)`'s render-only vector for
 *   this turn, or absent.
 * @returns {Promise<{system: string, stateNote: string}>}
 */
export async function buildPromptParts(state, loadPrompt, opts = {}) {
  const base = await loadPrompt('base');
  const contract = await loadPrompt('contract');
  const stageDoc = await loadPrompt(stageModuleName(state));
  const sections = [base, contract, stageDoc];
  const profileText = profileSectionText(opts.profile);
  if (profileText) sections.push(profileText);
  const interactionText = interactionSectionText(opts.profile);
  if (interactionText) sections.push(interactionText);
  return { system: sections.join(SECTION_SEP), stateNote: stateNoteText(state, opts) };
}

/**
 * History window with cache hysteresis. A plain slice(-24) slides by 2 every
 * turn, moving the window start and re-tokenizing the whole tail each time.
 * Instead the start index advances in blocks of 12 messages (6 turns), so the
 * prefix stays byte-stable between jumps: the window holds 24–35 messages,
 * and 5 of every 6 turns are pure cache extensions.
 * @param {Array<{role: string, content: string}>} history
 */
export function cacheStableHistory(history) {
  const h = Array.isArray(history) ? history : [];
  if (h.length <= 36) return h.slice();
  return h.slice(Math.floor((h.length - 24) / 12) * 12);
}
