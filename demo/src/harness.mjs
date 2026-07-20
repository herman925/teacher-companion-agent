// Runtime harness — L2 parse + L3 deterministic validators + L4 policy.
// Constrains the MODEL, never the teacher (AGENTS.md non-negotiable 2).
// Every rule here must have both-directions fixtures in demo/tests/.

import { evidenceIds, stageGateError } from './engine.mjs';

/** Child-claim patterns: assertions that children HAVE discovered/felt/understood. */
const CHILD_CLAIM_RE = /(孩子们?|幼儿|儿童|全班|大家)(都|均|已经?|很)*(发现|理解|感受到|爱上|喜欢上?|学会|明白|掌握|着迷|兴奋)/;
/** Hedges that make a child-claim sentence legitimate without evidence. */
const HEDGE_RE = /(可能|或许|也许|如果|假如|待现场确认|建议.{0,6}观察|预计|设想|想象一下)/;

/** Adult-slogan lexicon — forbidden in child-facing content (spec §6). */
const ADULT_SLOGANS = ['传承精神', '弘扬传统文化', '弘扬文化', '文化责任', '文化自信', '民族精神', '爱国主义精神', '文化担当'];

/** Artifact fields that reach children (scanned for slogans). */
const CHILD_FACING_ARTIFACTS = new Set(['entry_card', 'experience_plan', 'interview_card', 'cycle_task']);

const CLOSURE_KEYS = ['do_now', 'materials', 'bring_back', 'i_will'];

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
    // Dev-facing workflow trace — passed through unvalidated (developer mode UI).
    wf_trace: obj.wf_trace && typeof obj.wf_trace === 'object' ? obj.wf_trace : null,
  };
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
 * @param {{ stylePref?: string }} opts teacher profile bits that tune warn-level checks
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

  // 1. Closure loop: required and four-part when a round completes.
  if (turn.round_complete) {
    if (!turn.closure_loop) {
      violations.push({ kind: 'closure_missing', detail: 'round_complete 为 true 但缺少输出闭环', action: 'block' });
    } else {
      const missing = CLOSURE_KEYS.filter((k) => !String(turn.closure_loop[k] || '').trim());
      if (missing.length) {
        violations.push({ kind: 'closure_incomplete', detail: `输出闭环缺少要素：${missing.join('、')}`, action: 'block' });
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

  // 3. Evidence-first: child-claims require refs into EXISTING or NEWLY-PROVIDED evidence.
  const known = evidenceIds(state);
  for (const e of turn.state_delta?.children_evidence || []) if (e && e.id) known.add(e.id);
  const badRefs = turn.evidence_refs.filter((id) => !known.has(id));
  if (badRefs.length) {
    violations.push({ kind: 'fabrication', detail: `evidence_refs 引用了不存在的证据条目：${badRefs.join('、')}`, action: 'block' });
  }
  const claims = findClaimSentences(turn.reply_markdown);
  if (claims.length && turn.evidence_refs.length === 0) {
    violations.push({
      kind: 'fabrication',
      detail: `正文断言儿童已有的反应/理解但未引用任何证据（evidence_refs 为空）。断言句：「${claims[0].slice(0, 40)}…」`,
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
  if (blueprints.length) {
    const offenders = [];
    const walk = (node, path) => {
      if (!node || typeof node !== 'object') return;
      const text = `${node.title ?? ''}。${node.body ?? ''}`;
      const tentative = node.status === 'hypothesis' || node.status === 'pending_validation';
      if (!tentative && CHILD_CLAIM_RE.test(text) && !HEDGE_RE.test(text)) {
        offenders.push(path || node.id || '(未命名节点)');
      }
      for (const c of Array.isArray(node.children) ? node.children : []) walk(c, c.id || path);
    };
    for (const bp of blueprints) for (const m of (bp.data?.modules ?? [])) walk(m, m.id);
    if (offenders.length) {
      violations.push({
        kind: 'unmarked_hypothesis',
        detail: `蓝图节点把未发生的儿童反应写成事实且未标注（status 需为 hypothesis/pending_validation 或加「可能/预计」）：${offenders.slice(0, 3).join('、')}`,
        action: 'block',
      });
    }
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
      preview[key] = Array.isArray(value) && Array.isArray(preview[key]) ? [...preview[key], ...value] : value;
    }
    const err = stageGateError(preview, turn.state_delta.stage);
    if (err) violations.push({ kind: 'illegal_stage_jump', detail: err, action: 'strip' });
  }

  return violations;
}

/** Sentences in reply prose that assert realized child reactions, minus hedged ones. */
export function findClaimSentences(markdown) {
  const prose = markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  return prose
    .split(/(?<=[。！？!?\n])/)
    .map((s) => s.trim())
    .filter((s) => s && CHILD_CLAIM_RE.test(s) && !HEDGE_RE.test(s));
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
