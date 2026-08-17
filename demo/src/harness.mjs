// Runtime harness — L2 parse + L3 deterministic validators + L4 policy.
// Constrains the MODEL, never the teacher (AGENTS.md non-negotiable 2).
// Every rule here must have both-directions fixtures in demo/tests/.

import { WRITABLE as STATE_WRITABLE, evidenceIds, evidenceIsGrounded, stageGateError } from './engine.mjs';
import { walkPlan } from './plan-tsv.mjs';

/** Child-claim patterns: assertions that children HAVE discovered/felt/understood.
 * Exported because the same sentence is the same claim wherever it is written:
 * memory-scopes screens incoming facts with it, so a fabricated child reaction
 * cannot be filed as a class constraint and ride every future prompt. */
export const CHILD_CLAIM_RE = /(孩子们?|幼儿|儿童|全班|大家)(都|均|已经?|很)*(发现|理解|感受到|爱上|喜欢上?|学会|明白|掌握|着迷|兴奋)/;
/** Hedges that make a child-claim sentence legitimate without evidence. */
// 待现场确认 ⇄ 待现场验证: the corpus and blueprint-util's status gloss both
// write 「预设，待现场验证」, so accepting only 确认 made a node marked exactly as
// instructed read as an unmarked assertion. Both spellings mean the same thing.
const HEDGE_RE = /(可能|或许|也许|如果|假如|待现场(确认|验证)|建议.{0,6}观察|预计|设想|想象一下)/;

/** Adult-slogan lexicon — forbidden in child-facing content (spec §6). */
const ADULT_SLOGANS = ['传承精神', '弘扬传统文化', '弘扬文化', '文化责任', '文化自信', '民族精神', '爱国主义精神', '文化担当'];

/** Artifact fields that reach children (scanned for slogans). */
const CHILD_FACING_ARTIFACTS = new Set(['entry_card', 'experience_plan', 'interview_card', 'cycle_task']);

const CLOSURE_KEYS = ['do_now', 'materials', 'bring_back', 'i_will'];

/** The delta channels a turn can move provenance through. `plan_delta` is the
 * canonical one (ADR-0010 §6); `blueprint_delta` predates it and carries node
 * status the same way, so the citation rule has to watch both or the older
 * channel becomes the way around it. */
const DELTA_KEYS = ['plan_delta', 'blueprint_delta'];

/** Whitespace is not a citation difference: she typed 「就这样，确认」 and the
 * model may echo it spaced differently. Deliberately the same pair of squashes
 * as engine.citedNodeOf — if the two disagreed, the harness would report ops
 * the engine applies, or stay silent on ops it strips. */
const squashQuote = (s) => String(s ?? '').replace(/\s+/g, '');
/** Punctuation is the model's to normalize, not hers. */
const citationKey = (s) => String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
/** Does this quote occur in what she actually typed? */
const quoted = (said, quote) => squashQuote(said).includes(squashQuote(quote))
  || (Boolean(citationKey(quote)) && citationKey(said).includes(citationKey(quote)));

/** Sentences of prose, fenced code removed. */
function splitSentences(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/(?<=[。！？!?\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Sentences of a serialized artifact, where JSON punctuation is also a break:
 * a claim must not be assembled out of two fields that merely sit next to each
 * other in the blob. */
const jsonSentences = (text) => splitSentences(String(text ?? '').replace(/["{}[\],]/g, '。'));

/** The node text one delta op carries, per op, so a violation can name it. */
function deltaNodeEntries(turn) {
  const out = [];
  for (const key of DELTA_KEYS) {
    for (const op of Array.isArray(turn[key]) ? turn[key] : []) {
      if (!op || typeof op !== 'object' || !op.node) continue;
      const walk = (node, path) => {
        if (!node || typeof node !== 'object') return;
        out.push({ key, id: node.id || path, node, text: `${node.title ?? ''}。${node.body ?? ''}` });
        for (const c of Array.isArray(node.children) ? node.children : []) walk(c, c.id || path);
      };
      walk({ ...op.node, id: op.node.id || op.id }, op.id);
    }
  }
  return out;
}

/** Every id in one incoming op subtree whose status claims `confirmed`. */
function confirmedIdsIn(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.status === 'confirmed') out.push(node.id || '(未命名节点)');
  for (const c of Array.isArray(node.children) ? node.children : []) confirmedIdsIn(c, out);
  return out;
}

/** Class and course facts state a constraint as an absence — 「班上没有鼓」,
 * 「下雨就用不了户外场地」. This lifts the excluded THING out of that phrasing.
 *
 * Deliberately narrow, and it fails toward missing rather than inventing. The
 * item must end its clause, and a capture that starts with a verb is a phrase
 * rather than a thing (「孩子们没有见过龙舟」 must not turn 龙舟 into a banned
 * material). A missed exclusion costs one wrong suggestion she corrects once; a
 * false one refuses activities she could have run, which is the failure that
 * makes teachers stop trusting the memory at all.
 *
 * UNKNOWN, and not guessed here: there is no negation or paraphrase model in
 * this file, so 「园里的鼓坏了」 is not read as an exclusion. Widening belongs with
 * the extractor that writes the facts, where a model can read meaning — ADR-0011
 * §4 already puts canonicalization there. */
const EXCLUSION_RE = /(?:没有|用不了|不能用|缺)([^\s，。；、,.;：:!！?？]{1,6})(?=$|[\s，。；、,.;：:!！?？])/g;
/** Capture heads that mean the match is a verb phrase, not an item. */
const VERB_HEAD_RE = /^[见去做听说看来带玩学上下开试想到吃买找过发问答教读写走跑]/;
/** The activity NEEDS the item, as opposed to merely naming it. */
const NEED_RE = /(用|使用|准备|带|拿|敲|打|发给|每人|每组|摆|布置|需要|借)/;
/** The turn is talking ABOUT the constraint rather than walking into it —
 * 「班上没有鼓，我们改用木棒敲」 respects the fact and must stay silent. */
const CONSTRAINT_ACK_RE = /(没有|不用|改用|替代|代替|换成|用不了|不需要|无需|缺|避免|不必|如果有)/;

/** Items a fact excludes. Empty for facts that state no absence. */
function excludedItems(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(EXCLUSION_RE)) {
    if (!VERB_HEAD_RE.test(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * The turn's proposal surfaces, cut into short chunks.
 *
 * JSON punctuation counts as a chunk break: a need marker in an artifact's
 * `materials` must not attach to an item named three fields away in `notes`,
 * which is exactly how a whole-blob scan invents contradictions.
 *
 * KNOWN GAP, recorded rather than papered over: matching is substring, so a
 * one-character item like 鼓 also matches inside 鼓点 — 「准备一段鼓点录音」 needs no
 * drum but would fire. Fixing it by requiring a word boundary breaks the
 * canonical case this rule exists for (ADR-0011's 敲鼓感受节奏), so the gap
 * stands until facts carry a normalized item field.
 */
function proposalChunks(turn, blueprintNodeText) {
  const parts = [turn.reply_markdown, ...blueprintNodeText];
  for (const a of turn.artifacts) {
    if (!a || a.type === 'blueprint') continue; // blueprint nodes already arrive via blueprintNodeText
    parts.push(JSON.stringify(a.data ?? {}));
  }
  for (const key of DELTA_KEYS) {
    for (const op of Array.isArray(turn[key]) ? turn[key] : []) {
      if (op?.node) parts.push(`${op.node.title ?? ''}。${op.node.body ?? ''}`);
    }
  }
  return jsonSentences(parts.join('\n'));
}

// ---------------------------------------------------------------------------
// Stray-field salvage.
//
// A model that loses the shape of the contract does not fail loudly. On
// 2026-08-17 MiniMax described a nine-node plan in its prose, opened
// `plan_delta` with the month, closed the array one element in, and wrote the
// remaining eight nodes as top-level `"item": {…}` siblings. `JSON.parse` keeps
// only the LAST value of a repeated key, so eight nodes vanished between the
// wire and the parser with no error anywhere: the turn parsed, the gate passed
// clean, and the teacher saw one node under prose promising nine.
//
// The salvage below reads the raw text at depth 1 WITHOUT collapsing repeats,
// folds op-shaped strays into `plan_delta` and misplaced state fields into
// `state_delta`, and records a warn naming what it moved. It repairs shape, not
// meaning: an op is only accepted where the model already wrote a whole node.
// ---------------------------------------------------------------------------

/** Read a JSON string literal starting at `i` (which must be a quote). */
function readJsonString(s, i) {
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue; }
    if (s[j] === '"') return { text: s.slice(i, j + 1), end: j + 1 };
    j++;
  }
  return null;
}

/** Read one JSON value starting at `i`; returns its source span. */
function readJsonValue(s, i) {
  const c = s[i];
  if (c === '"') return readJsonString(s, i);
  if (c === '{' || c === '[') {
    const close = c === '{' ? '}' : ']';
    let depth = 0;
    let j = i;
    while (j < s.length) {
      const ch = s[j];
      if (ch === '"') {
        const str = readJsonString(s, j);
        if (!str) return null;
        j = str.end;
        continue;
      }
      if (ch === c) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return { text: s.slice(i, j + 1), end: j + 1 };
      }
      j++;
    }
    return null;
  }
  let j = i;
  while (j < s.length && s[j] !== ',' && s[j] !== '}') j++;
  return { text: s.slice(i, j).trim(), end: j };
}

/**
 * Depth-1 key/value pairs of a JSON object literal, in source order, with
 * repeats preserved. This is the whole point: `JSON.parse` silently keeps the
 * last value for a repeated key, which is precisely how the loss above happened.
 * Returns [] for anything that is not a plain object literal, and stops early
 * at the first malformation rather than guessing.
 * @returns {Array<{key: string, value: any}>}
 */
export function topLevelPairs(text) {
  const s = String(text ?? '').trim();
  if (s[0] !== '{') return [];
  const pairs = [];
  let i = 1;
  while (i < s.length) {
    while (i < s.length && (s[i] === ',' || /\s/.test(s[i]))) i++;
    if (s[i] === '}' || i >= s.length) break;
    if (s[i] !== '"') break;
    const key = readJsonString(s, i);
    if (!key) break;
    i = key.end;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] !== ':') break;
    i++;
    while (i < s.length && /\s/.test(s[i])) i++;
    const val = readJsonValue(s, i);
    if (!val) break;
    try {
      pairs.push({ key: JSON.parse(key.text), value: JSON.parse(val.text) });
    } catch {
      break;
    }
    i = val.end;
  }
  return pairs;
}

/** Does this value carry a whole plan-tree edit? Both an id and a node body —
 * an op-shaped fragment with neither is a guess we decline to make. */
function looksLikePlanOp(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
    && typeof v.id === 'string' && v.id.trim()
    && Boolean(v.node) && typeof v.node === 'object';
}

/** Top-level keys the contract defines. Anything else is a misplacement. */
const CONTRACT_KEYS = new Set([
  'reply_markdown', 'question', 'questions', 'artifacts', 'closure_loop',
  'plan_delta', 'blueprint_delta', 'state_delta', 'evidence_refs',
  'round_complete', 'wf_trace',
]);

/**
 * Recover plan ops and state fields the model wrote outside their channel.
 * @param {string|any} raw the turn payload as it arrived (only a string can carry repeats)
 * @param {Object} obj the parsed object
 * @returns {{ ops: Array, state: Object, moved: string[], dropped: string[] }}
 */
export function salvageStrayFields(raw, obj) {
  const pairs = typeof raw === 'string'
    ? topLevelPairs(extractJson(raw))
    : Object.entries(obj ?? {}).map(([key, value]) => ({ key, value }));
  const ops = [];
  const state = {};
  const moved = [];
  const dropped = [];
  const known = new Set((Array.isArray(obj?.plan_delta) ? obj.plan_delta : [])
    .map((op) => op && op.id).filter(Boolean));
  for (const { key, value } of pairs) {
    if (CONTRACT_KEYS.has(key)) continue;
    if (looksLikePlanOp(value)) {
      if (known.has(value.id)) continue;
      known.add(value.id);
      ops.push({ op: 'set', ...value });
      moved.push(`${key} → plan_delta（${value.id}）`);
      continue;
    }
    if (Array.isArray(value) && value.length && value.every(looksLikePlanOp)) {
      for (const v of value) {
        if (known.has(v.id)) continue;
        known.add(v.id);
        ops.push({ op: 'set', ...v });
        moved.push(`${key} → plan_delta（${v.id}）`);
      }
      continue;
    }
    if (STATE_WRITABLE.has(key)) {
      // state_delta wins: a field written in the right place is the model's
      // considered value, and the stray copy is the accident.
      if (obj?.state_delta && typeof obj.state_delta === 'object' && key in obj.state_delta) {
        dropped.push(key);
        continue;
      }
      state[key] = value;
      moved.push(`${key} → state_delta`);
      continue;
    }
    dropped.push(key);
  }
  return { ops, state, moved, dropped };
}

/**
 * L2: parse + structurally normalize the model's raw turn object.
 * @returns {{ turn: import('./types.mjs').Turn|null, violations: Array }}
 */
export function parseTurn(raw) {
  const violations = [];
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(extractJson(raw));
    } catch (e) {
      return { turn: null, violations: [{ kind: 'contract_parse', detail: `JSON 解析失败：${e.message}`, action: 'block' }] };
    }
  }
  if (!obj || typeof obj !== 'object' || typeof obj.reply_markdown !== 'string' || !obj.reply_markdown.trim()) {
    return { turn: null, violations: [{ kind: 'contract_parse', detail: 'reply_markdown 缺失或为空', action: 'block' }] };
  }
  // question ⇄ questions normalization: downstream always sees BOTH shapes —
  // `questions` as the canonical array, `question` as its first entry (legacy
  // single-question consumers: mock, UI focus logic, tests).
  const questions = Array.isArray(obj.questions)
    ? obj.questions.filter((q) => q && typeof q === 'object')
    : (obj.question && typeof obj.question === 'object' ? [obj.question] : []);
  const turn = {
    reply_markdown: obj.reply_markdown,
    question: questions[0] ?? null,
    questions,
    artifacts: Array.isArray(obj.artifacts) ? obj.artifacts : [],
    closure_loop: obj.closure_loop ?? null,
    state_delta: obj.state_delta && typeof obj.state_delta === 'object' ? obj.state_delta : {},
    evidence_refs: Array.isArray(obj.evidence_refs) ? obj.evidence_refs : [],
    round_complete: Boolean(obj.round_complete),
    // Node-granularity blueprint edits (optional; engine applies with the
    // same born-confirmed guard as artifact absorption).
    blueprint_delta: Array.isArray(obj.blueprint_delta) ? obj.blueprint_delta : [],
    // Node-granularity plan-tree edits — the model's only write path into the
    // plan tree (engine.applyPlanDelta). Carried through here because rule 6
    // below reads `confirmed_by_quote` off these ops: a channel the parser
    // dropped would be a channel the citation check could never see.
    plan_delta: Array.isArray(obj.plan_delta) ? obj.plan_delta : [],
    // Dev-facing workflow trace — passed through unvalidated (developer mode UI).
    wf_trace: obj.wf_trace && typeof obj.wf_trace === 'object' ? obj.wf_trace : null,
  };
  const stray = salvageStrayFields(raw, obj);
  if (stray.ops.length) turn.plan_delta = [...turn.plan_delta, ...stray.ops];
  if (Object.keys(stray.state).length) turn.state_delta = { ...turn.state_delta, ...stray.state };
  if (stray.moved.length) {
    violations.push({
      kind: 'contract_stray_field',
      detail: `模型把内容写在了契约字段之外，已归位：${stray.moved.join('；')}`,
      action: 'warn',
    });
  }
  if (stray.dropped.length) {
    violations.push({
      kind: 'contract_unknown_field',
      detail: `顶层出现契约以外的字段，已忽略：${stray.dropped.join('、')}`,
      action: 'warn',
    });
  }
  return { turn, violations };
}

/** Best-effort extraction of the outermost JSON object from prose-wrapped output. */
export function extractJson(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

/** Prose length above which 极简速览 gets a style warn (never a block). */
const TERSE_STYLE_MAX_CHARS = 1200;
/** Question-card count above which we record a warn — no hard cap by design:
 * the ceiling is decided later from pilot answered/skipped data. */
const QUESTIONS_WARN_ABOVE = 5;

/**
 * L3: deterministic validation of a parsed turn against current state.
 * `action` levels: block (L4 retry) · strip (engine drops the field) ·
 * warn (recorded + shown in dev drawer only — never retries, style checks live here).
 * @param {import('./types.mjs').Turn} turn
 * @param {Object} state current course_state
 * @param {{ stylePref?: string, teacherText?: string, facts?: Array<Object>,
 *          mock?: boolean, resolveUploadRef?: (ref: string) => boolean }} opts
 *   `stylePref` tunes warn-level style checks. `teacherText` is this turn's
 *   teacher message, so a quoted confirmation can be checked against words she
 *   actually said (rule 6); omitted, a present quote is trusted. `facts` are the
 *   memory rows already in front of the model (memory-scopes shape) — rule 7 is
 *   dormant without them. `mock` says this payload came from mockTurn() rather
 *   than a vendor, and `resolveUploadRef` answers whether an `upload_ref` names
 *   one of this teacher's own materials; both gate evidence grounding and
 *   neither may come off the model's own row (engine.evidenceIsGrounded).
 * @returns {import('./types.mjs').Violation[]}
 */
/** Canonical shape for blueprint-module comparison (rule 3c): id/title/body/
 * status/children only — a rationale touch-up alone does not count as change. */
function moduleShape(node) {
  return {
    id: node?.id ?? '', title: node?.title ?? '', body: node?.body ?? '', status: node?.status ?? '',
    children: (Array.isArray(node?.children) ? node.children : []).map(moduleShape),
  };
}
const shapeOf = (node) => JSON.stringify(moduleShape(node));

export function validateTurn(turn, state, opts = {}) {
  const violations = [];
  const questions = Array.isArray(turn.questions)
    ? turn.questions
    : (turn.question ? [turn.question] : []);

  // 1. Closure loop — ADVISORY since ADR-0012 §2. ADR-0008 §3 turned 回传 into an
  // invitation rather than a duty, so a round that ends without 「回来请告诉我
  // 什么」 is a turn that did not invite, not a defect: blocking it would force
  // the model to demand classroom feedback the teacher was never obliged to
  // give. Still reported, because the closure loop is what turns a plan into a
  // next step and the rate belongs in the session log where pilot data can
  // settle whether it needs re-tightening.
  if (turn.round_complete) {
    if (!turn.closure_loop) {
      violations.push({ kind: 'closure_missing', detail: 'round_complete 为 true 但缺少输出闭环——回传是邀请不是义务（ADR-0008 §3），仅记录，不拦截', action: 'warn' });
    } else {
      const missing = CLOSURE_KEYS.filter((k) => !String(turn.closure_loop[k] || '').trim());
      if (missing.length) {
        violations.push({ kind: 'closure_incomplete', detail: `输出闭环缺少要素：${missing.join('、')}——仅记录，不拦截`, action: 'warn' });
      }
    }
  }

  // 2. Question cards: every card complete (text + why + 2–3 examples); questions
  // live in cards, not prose. Count is uncapped — >5 records a warn so the
  // re-tightening decision is made on pilot data (DESIGN.md §4 问题卡).
  const incomplete = questions.filter(
    (q) => !String(q?.text ?? '').trim() || !Array.isArray(q?.examples) || q.examples.length < 2,
  );
  if (incomplete.length) {
    violations.push({ kind: 'question_no_examples', detail: `${incomplete.length} 张问题卡不完整——每张必须有 text 和 2–3 个示例答案`, action: 'block' });
  }
  if (questions.length) {
    const proseQuestions = countQuestionSentences(turn.reply_markdown);
    if (proseQuestions > 1) {
      violations.push({ kind: 'multi_question', detail: `正文中出现 ${proseQuestions} 个问句——问题必须放进 questions 问题卡，不写进正文`, action: 'block' });
    }
    if (questions.length > QUESTIONS_WARN_ABOVE) {
      violations.push({ kind: 'many_questions', detail: `本轮提出 ${questions.length} 张问题卡（>${QUESTIONS_WARN_ABOVE}）——未拦截，仅记录；教师跳卡率会说明上限该定在哪`, action: 'warn' });
    }
  } else if (!turn.round_complete && !turn.artifacts.length && countQuestionSentences(turn.reply_markdown) === 0) {
    // Anti-dead-end: a mid-round turn with no cards, no artifacts and no closure
    // leaves the teacher nothing to grab. Warn-level: pure Q&A answers are legitimate.
    violations.push({ kind: 'no_forward_handle', detail: '本轮既无问题卡、无产物、也未收尾——给教师留一个前进抓手：至少一张问题卡或一个开放式建议', action: 'warn' });
  }

  // 2b. Style proxies (warn only — style is persuasion, safety is law; DESIGN.md §4).
  const stylePref = String(opts.stylePref ?? '');
  if (stylePref.startsWith('极简速览')) {
    const proseLen = turn.reply_markdown.replace(/```[\s\S]*?```/g, '').length;
    if (proseLen > TERSE_STYLE_MAX_CHARS) {
      violations.push({ kind: 'style_mismatch', detail: `教师选了极简速览，但正文 ${proseLen} 字（>${TERSE_STYLE_MAX_CHARS}）——仅记录，不拦截`, action: 'warn' });
    }
  } else if (stylePref.startsWith('提问引导') && !questions.length && !turn.round_complete) {
    violations.push({ kind: 'style_mismatch', detail: '教师选了提问引导，但本轮没有提出任何问题——仅记录，不拦截', action: 'warn' });
  }

  // 3. Evidence-first: child-claims require refs into EXISTING or NEWLY-PROVIDED
  // evidence. Newly-provided counts only if the entry traces back to the
  // teacher's own message (engine.evidenceIsGrounded) — otherwise one turn
  // mints an entry, cites it, and licenses its own claim. Without
  // `opts.teacherText` there is nothing to trace against and every id counts,
  // the same dormancy the citation and memory rules keep.
  const teacherSaid = typeof opts.teacherText === 'string' ? opts.teacherText : null;
  // `mock` and `resolveUploadRef` are the two pieces of context the MODEL
  // cannot supply: whether mockTurn() produced this payload, and whether an
  // `upload_ref` names a material row this teacher owns. Forwarded verbatim so
  // L3 and the engine's apply step reach the same verdict on the same row —
  // a harness that grounds what applyDelta then strips is a harness reporting
  // a turn legal that the ledger will mark.
  const groundCtx = { mock: opts.mock === true, resolveUploadRef: opts.resolveUploadRef };
  const known = evidenceIds(state);
  for (const e of turn.state_delta?.children_evidence || []) {
    if (!e || !e.id) continue;
    if (teacherSaid !== null && !evidenceIsGrounded(e, teacherSaid, groundCtx)) {
      violations.push({
        kind: 'fabrication',
        detail: `本轮新增的证据 ${e.id} 在教师这条消息里找不到出处——证据要来自她说的话或她上传的东西，不能自己写一条再引用它`,
        action: 'strip',
      });
      continue;
    }
    known.add(e.id);
  }
  const badRefs = turn.evidence_refs.filter((id) => !known.has(id));
  if (badRefs.length) {
    violations.push({ kind: 'fabrication', detail: `evidence_refs 引用了不存在的证据条目：${badRefs.join('、')}`, action: 'block' });
  }
  // The scan covers the ARTIFACTS as well as the prose, because the artifact is
  // what she keeps: a bland reply carrying a 课程故事 that asserts what children
  // discovered is exactly the Stage-5 export CONTEXT.md defines as assembled
  // from recorded evidence, never from invention. Blueprint/plan node text is
  // excluded here and answered by the marking rule below instead — a 预设 may
  // say anything about children as long as it is visibly a 预设.
  const artifactClaims = turn.artifacts
    .filter((a) => a && a.type !== 'blueprint')
    .flatMap((a) => claimsIn(JSON.stringify(a.data ?? {})));
  const claims = [...findClaimSentences(turn.reply_markdown), ...artifactClaims];
  if (claims.length && turn.evidence_refs.length === 0) {
    violations.push({
      kind: 'fabrication',
      detail: `本轮断言儿童已有的反应/理解但未引用任何证据（evidence_refs 为空）。断言句：「${claims[0].slice(0, 40)}…」`,
      action: 'block',
    });
  }

  // 3b. Blueprint marking rules (ADR-0003) — DORMANT unless the turn carries a
  // blueprint artifact, so non-planning flows never meet them. Evidence
  // discipline for planning content is STATUS MARKING: a node whose text
  // asserts realized child reactions must be tagged hypothesis/pending_validation
  // (or hedged) — 预设 can say anything about children as long as it is
  // visibly a 预设. Density: blueprint turns keep ≤3 gap cards (warn).
  const blueprints = turn.artifacts.filter((a) => a && a.type === 'blueprint');
  // Blueprint node text is child-facing (the nodes become the actual course
  // activities), so it must meet the adult-slogan rule in section 4 too. The
  // rebalance (ADR-0003) makes the blueprint the whole deliverable, so a slogan
  // hiding in a node body would otherwise sail past non-negotiable #3. Collected
  // here during the walk we already do; consumed below.
  const blueprintNodeText = [];
  // The marking walk runs over EVERY node this turn writes, not just the ones
  // riding in an artifact: since ADR-0010 §6 the deltas are the primary write
  // channel into both trees, so an artifact-only walk leaves the main road
  // unwatched. Same rule, same wording, one helper.
  const unmarked = [];
  const markCheck = (node, label) => {
    const text = `${node.title ?? ''}。${node.body ?? ''}`;
    const tentative = node.status === 'hypothesis' || node.status === 'pending_validation';
    if (!tentative && CHILD_CLAIM_RE.test(text) && !HEDGE_RE.test(text)) unmarked.push(label);
    return text;
  };
  const deltaNodes = deltaNodeEntries(turn);
  const deltaNodeText = deltaNodes.map((e) => markCheck(e.node, `${e.key} ${e.id}`));
  if (blueprints.length) {
    const walk = (node, path) => {
      if (!node || typeof node !== 'object') return;
      blueprintNodeText.push(markCheck(node, path || node.id || '(未命名节点)'));
      for (const c of Array.isArray(node.children) ? node.children : []) walk(c, c.id || path);
    };
    for (const bp of blueprints) for (const m of (bp.data?.modules ?? [])) walk(m, m.id);
  }
  if (unmarked.length) {
    violations.push({
      kind: 'unmarked_hypothesis',
      detail: `节点把未发生的儿童反应写成事实且未标注（status 需为 hypothesis/pending_validation 或加「可能/预计」）：${unmarked.slice(0, 3).join('、')}`,
      action: 'block',
    });
  }
  if (blueprints.length) {
    if (questions.length > 3) {
      violations.push({
        kind: 'planning_question_density',
        detail: `蓝图轮提出 ${questions.length} 张问题卡（>3）——先交付后提问的密度约定；仅记录`,
        action: 'warn',
      });
    }
    // 3c. Delta discipline (token economics, 2026-07-20): resending the full
    // blueprint when most modules are byte-identical to state is the main
    // output-length bloat — small edits belong in blueprint_delta. Warn (not
    // block: a legit v0.2 refinement often keeps a couple of modules intact).
    const existing = new Map((state?.course_plan_blueprint?.modules ?? []).map((m) => [m.id, shapeOf(m)]));
    if (existing.size >= 2) {
      let unchanged = 0;
      let total = 0;
      for (const bp of blueprints) {
        for (const m of (bp.data?.modules ?? [])) {
          total += 1;
          if (existing.get(m.id) === shapeOf(m)) unchanged += 1;
        }
      }
      if (total >= 2 && unchanged / total >= 0.6) {
        violations.push({
          kind: 'blueprint_resend',
          detail: `重发的蓝图里 ${unchanged}/${total} 个模块与当前状态完全一致——小修改请用 blueprint_delta 按 id 定位，不要重发整图`,
          action: 'warn',
        });
      }
    }
  }

  // 4. Culture stays backstage: no adult slogans in child-facing artifacts or the closure loop.
  // adult_phrasings_to_avoid exists precisely to NAME forbidden slogans — exempt it.
  const childFacingText = [
    ...turn.artifacts
      .filter((a) => CHILD_FACING_ARTIFACTS.has(a.type))
      .map((a) => {
        const { adult_phrasings_to_avoid, ...rest } = a.data ?? {};
        return JSON.stringify(rest);
      }),
    ...blueprintNodeText, // blueprint nodes are child-facing script (ADR-0003)
    ...deltaNodeText, // and so is a node written straight through a delta
    turn.closure_loop ? CLOSURE_KEYS.map((k) => turn.closure_loop[k]).join(' ') : '',
  ].join(' ');
  for (const slogan of ADULT_SLOGANS) {
    if (childFacingText.includes(slogan)) {
      violations.push({ kind: 'adult_slogan', detail: `儿童侧内容出现成人口号「${slogan}」——必须转译为儿童可行动的小任务`, action: 'block' });
    }
  }

  // 5. Stage-gate legality (advisory here; engine strips on apply). Delta-aware:
  // prerequisites supplied by this SAME delta count toward the gate, mirroring
  // the engine's merged-candidate check (and rule 3's newly-provided evidence).
  if (typeof turn.state_delta?.stage === 'number') {
    const preview = { ...state };
    for (const [key, value] of Object.entries(turn.state_delta)) {
      if (key === 'stage') continue;
      // Evidence the engine will refuse to count must not open the gate here
      // either, or the harness reports legal what the apply step then strips.
      const merged = key === 'children_evidence' && teacherSaid !== null
        ? value.filter((e) => evidenceIsGrounded(e, teacherSaid, groundCtx))
        : value;
      preview[key] = Array.isArray(merged) && Array.isArray(preview[key]) ? [...preview[key], ...merged] : merged;
    }
    const err = stageGateError(preview, turn.state_delta.stage);
    if (err) violations.push({ kind: 'illegal_stage_jump', detail: err, action: 'strip' });
  }

  // 6. Confirmation needs the teacher's own words FROM THIS TURN (ADR-0010 §6).
  // The ✓确认 tick is gone, so the citation is the entire difference between
  // 「she approved this」 and 「the model decided she did」 — a node reading
  // `confirmed` is a claim about her, one rung below a claim about the children.
  // 「好的，我先看看」 must fail the citation test rather than quietly become a
  // record she never made. One quote confirms the ONE node its op addresses: it
  // does not travel to nested nodes riding along in the same op (the rule
  // engine.applyPlanDelta enforces on apply; this reports it before that).
  for (const key of DELTA_KEYS) {
    for (const op of Array.isArray(turn[key]) ? turn[key] : []) {
      if (!op || typeof op !== 'object' || !op.node) continue;
      const claimed = confirmedIdsIn({ ...op.node, id: op.node.id || op.id });
      if (!claimed.length) continue;
      const quote = typeof op.confirmed_by_quote === 'string' ? squashQuote(op.confirmed_by_quote) : '';
      // With no teacher text to check against we trust a present quote — the
      // same position the engine takes. A citation nobody can check is weak,
      // but refusing every confirmation when the caller omitted the message
      // would strip legitimate work for a reason that is our own plumbing.
      // Every production caller supplies it now (serve.mjs, ui/local-turn.mjs),
      // so in production this branch is dead and the check is the real one.
      const verified = Boolean(quote) && (teacherSaid === null || quoted(teacherSaid, op.confirmed_by_quote));
      const uncited = claimed.filter((id) => !(verified && id === op.id));
      if (!uncited.length) continue;
      const why = !quote
        ? '没有带上教师本轮的原话（confirmed_by_quote 缺失）'
        : (!verified
          ? `confirmed_by_quote「${op.confirmed_by_quote}」不在教师本轮的话里`
          : '一条原话只确认它指向的那一个节点，同一个 op 里的子节点不跟着升级');
      violations.push({
        kind: 'uncited_confirmation',
        detail: `${key} 把 ${uncited.join('、')} 升为 confirmed，但${why}——确认要引用教师原话，不能代她确认`,
        action: 'strip',
      });
    }
  }

  // 6b. Orphan plan ops (2026-08-17). A `set` naming a parent that neither
  // exists nor is created earlier in the same delta means the model believes it
  // wrote that parent and did not — the signature of a tree announced in prose
  // and half-delivered through the channel. engine.applyPlanDelta strips such an
  // op, correctly and silently; the teacher then reads about a two-week plan and
  // sees one node. Blocking here spends a retry to get the rest of the tree,
  // which is the only place the tree can still come from.
  const priorIds = new Set();
  if (state?.course_plan) {
    for (const { node } of walkPlan(state.course_plan)) priorIds.add(node.id);
  }
  const orphans = [];
  const madeHere = new Set();
  for (const op of Array.isArray(turn.plan_delta) ? turn.plan_delta : []) {
    if (!op || typeof op !== 'object' || !op.id) continue;
    if (op.op === 'set' && op.parent_id && !priorIds.has(op.parent_id) && !madeHere.has(op.parent_id)) {
      orphans.push(`${op.id}（父节点 ${op.parent_id}）`);
    }
    if (op.op === 'set') madeHere.add(op.id);
  }
  if (orphans.length) {
    violations.push({
      kind: 'plan_orphan',
      detail: `plan_delta 里这些节点的父节点不存在：${orphans.join('、')}——请把整棵树从上到下写进同一个 plan_delta（先父后子），正文里描述过的节点一个都不能少`,
      action: 'block',
    });
  }

  // 7. Memory contradiction (ADR-0011 §5). The assembler can put 「班上没有鼓」 in
  // front of the model on every turn, but only a check here can tell whether the
  // model then proposed 敲鼓感受节奏 anyway — the 「我早就跟你说过」 failure that
  // scoped memory exists to prevent. Dormant unless the caller supplies facts:
  // no facts, nothing to contradict, and a course with no memory yet is normal.
  const facts = (Array.isArray(opts.facts) ? opts.facts : []).filter((f) => f && !f.archived && f.text);
  if (facts.length) {
    const chunks = proposalChunks(turn, blueprintNodeText);
    for (const fact of facts) {
      let hit = null;
      for (const item of excludedItems(fact.text)) {
        const chunk = chunks.find((c) => c.includes(item) && NEED_RE.test(c) && !CONSTRAINT_ACK_RE.test(c));
        if (chunk) { hit = { item, chunk }; break; }
      }
      if (!hit) continue;
      // The fact is named in full, because feedback reading 「和记忆冲突」 leaves
      // the model guessing which of forty lines it broke.
      const said = fact.quote ? `，她的原话是「${fact.quote}」` : '';
      violations.push({
        kind: 'memory_contradiction',
        detail: `本轮的活动要用到「${hit.item}」，但${fact.scope ?? 'course'}记忆里记着「${fact.text}」${said}——换成班上真有的材料，或者先问她。冲突处：「${hit.chunk.slice(0, 40)}」`,
        action: 'strip',
      });
    }
  }

  return violations;
}

/** The assertions in a serialized artifact: same test as the prose scan, run on
 * JSON-aware chunks. Text shape differs; a claim is the same claim either way. */
function claimsIn(text) {
  return jsonSentences(text).filter((s) => CHILD_CLAIM_RE.test(s) && !HEDGE_RE.test(s));
}

/** Sentences in reply prose that assert realized child reactions, minus hedged
 * ones. Inline code is stripped first — the docs discuss forbidden phrasings by
 * quoting them, and a quoted example is not an assertion. */
export function findClaimSentences(markdown) {
  return splitSentences(String(markdown ?? '').replace(/`[^`]*`/g, ''))
    .filter((s) => CHILD_CLAIM_RE.test(s) && !HEDGE_RE.test(s));
}

/** Count interrogative sentences aimed at the teacher in reply prose.
 * Question marks inside closing quotes (”"』」）) are quoted speech — often a
 * child's question being cited — and don't count as asking the teacher. */
function countQuestionSentences(markdown) {
  const prose = markdown.replace(/```[\s\S]*?```/g, '');
  return (prose.match(/[？?](?=\s|$|[^”"』」)）])/g) || []).length;
}

/**
 * L4 policy: build the regeneration feedback message injected on first failure.
 */
export function violationFeedback(violations) {
  const lines = violations.filter((v) => v.action === 'block').map((v) => `- [${v.kind}] ${v.detail}`);
  return [
    '你上一次的输出违反了运行契约，已被拦截。违例清单：',
    ...lines,
    '请重新生成完整的 JSON 输出：修正上述所有问题，其余内容尽量保持。不要道歉，不要提及被拦截这件事。',
  ].join('\n');
}

/** L4 terminal fallback: the safe template when regeneration also fails.
 * Planning-lens variant: a course that already holds a blueprint must NOT be
 * asked for field facts — demanding 现场信息 mid-planning is itself the
 * planning-refusal defect ADR-0003 names. */
export function safeTemplate(state) {
  if (state?.course_plan_blueprint) {
    const question = {
      text: '蓝图里你最想先动哪一部分？',
      why: '这一轮我没能生成可靠的新内容，先把已有蓝图保持原样',
      examples: ['网络图的方向再收窄一点', '先把第 1 周的活动定下来', '暂时不动，我再想想'],
    };
    return {
      reply_markdown:
        '这一轮我想先稳一下：刚才没能生成可靠的新内容，你的蓝图保持原样，没有丢。\n\n' +
        '告诉我你最想先动蓝图的哪一部分，我们从那里继续。',
      question,
      questions: [question],
      artifacts: [],
      closure_loop: null,
      state_delta: {},
      evidence_refs: [],
      round_complete: false,
    };
  }
  const question = {
    text: '这一轮孩子实际做了什么、说了什么？',
    why: '我需要真实现场信息才能给出可靠的下一步',
    examples: ['孩子们围着龙舟模型看了很久，有人问桨为什么是弯的', '我们还没开展活动，先想听听准备建议'],
  };
  return {
    reply_markdown:
      '这一轮我想先放慢一点。为了不给你不可靠的内容，我需要再确认一次现场信息。\n\n' +
      '你可以用一两句话告诉我：这一轮孩子实际做了什么、说了什么。哪怕只有一句原话也很好。',
    question,
    questions: [question],
    artifacts: [],
    closure_loop: null,
    state_delta: {},
    evidence_refs: [],
    round_complete: false,
  };
}
