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
  const turn = {
    reply_markdown: obj.reply_markdown,
    question: obj.question ?? null,
    artifacts: Array.isArray(obj.artifacts) ? obj.artifacts : [],
    closure_loop: obj.closure_loop ?? null,
    state_delta: obj.state_delta && typeof obj.state_delta === 'object' ? obj.state_delta : {},
    evidence_refs: Array.isArray(obj.evidence_refs) ? obj.evidence_refs : [],
    round_complete: Boolean(obj.round_complete),
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

/**
 * L3: deterministic validation of a parsed turn against current state.
 * @param {import('./types.mjs').Turn} turn
 * @param {Object} state current course_state
 * @returns {import('./types.mjs').Violation[]}
 */
export function validateTurn(turn, state) {
  const violations = [];

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

  // 2. Screening contract: at most one question, and it must carry examples.
  if (turn.question) {
    if (!Array.isArray(turn.question.examples) || turn.question.examples.length < 2) {
      violations.push({ kind: 'question_no_examples', detail: '问题必须附 2–3 个示例答案', action: 'block' });
    }
    const extraQuestions = countQuestionSentences(turn.reply_markdown);
    if (extraQuestions > 2) {
      // question field + reply prose asking several more distinct questions = interrogation.
      violations.push({ kind: 'multi_question', detail: `正文中出现 ${extraQuestions} 个问句——建档/引导阶段一次只问一个聚焦问题`, action: 'block' });
    }
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

  // 5. Stage-gate legality (advisory here; engine strips on apply).
  if (typeof turn.state_delta?.stage === 'number') {
    const err = stageGateError(state, turn.state_delta.stage);
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

/** Count interrogative sentences aimed at the teacher in reply prose. */
function countQuestionSentences(markdown) {
  const prose = markdown.replace(/```[\s\S]*?```/g, '');
  return (prose.match(/[？?](?=\s|$|[^”"』)])/g) || []).length;
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

/** L4 terminal fallback: the safe template when regeneration also fails. */
export function safeTemplate(state) {
  return {
    reply_markdown:
      '这一轮我想先放慢一点。为了不给你不可靠的内容，我需要再确认一次现场信息。\n\n' +
      '你可以用一两句话告诉我：这一轮孩子实际做了什么、说了什么？哪怕只有一句原话也很好。',
    question: {
      text: '这一轮孩子实际做了什么、说了什么？',
      why: '我需要真实现场信息才能给出可靠的下一步',
      examples: ['孩子们围着龙舟模型看了很久，有人问桨为什么是弯的', '我们还没开展活动，先想听听准备建议'],
    },
    artifacts: [],
    closure_loop: null,
    state_delta: {},
    evidence_refs: [],
    round_complete: false,
  };
}
