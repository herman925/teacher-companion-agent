// scope-guard.mjs — the scope shell (ADR-0012 §3/§4).
//
// This tool builds preschool theme-inquiry courses. Asking it for the weather in
// Changsha is off-purpose, and every such turn burns money we pay for — the case
// is real, not hypothetical (冯浩然 did exactly that through web search).
//
// The check runs BEFORE the model call: that is the whole point, since blocking
// afterwards has already spent what the check exists to save. It is the one
// legitimate pre-send gate — unlike checking that our own assembler included
// memory (ADR-0011 §5), there is a real condition in the world to test here.
//
// THE HARD PART, and why this is not a keyword filter. ADR-0012 §4:
//   「长沙今天天气怎么样」            → out of scope
//   「明天下雨的话，周二那个户外龙舟活动怎么办」 → course work, must pass
// Both are about weather. What separates them is that the second references her
// course. So we need TWO signals and refuse only when they agree:
//   A. does this touch her course at all?      (theme, node id, domain words)
//   B. is this a bare off-domain query?        (weather / markets / code / …)
// Refuse only when A is absent AND B is present. Requiring B to be positively
// present is what lets 「你好」 through on a brand-new course with no state.
//
// The asymmetry that governs every judgement call here: a false block costs a
// user, a false pass costs one turn of tokens. When in doubt, let it through.

/**
 * Signal A vocabulary — words that mean "this is about her course work".
 * Deliberately broad: over-matching here only ever ALLOWS a turn.
 */
const COURSE_TERMS = [
  // the work itself
  '课程', '主题', '探究', '计划', '月计划', '周计划', '日计划', '教案', '方案', '活动',
  '环创', '材料', '家长', '亲子', '目标', '评价', '观察', '记录', '证据', '故事',
  // the people and the setting
  '孩子', '幼儿', '儿童', '小朋友', '班', '小班', '中班', '大班', '园', '幼儿园', '老师', '教师',
  // organization types (stage1-workflow-v1.0)
  '集体教学', '小组教学', '个别指导', '自主游戏', '区角',
  // time words teachers plan in
  '这周', '下周', '本周', '上周', '第一周', '第二周', '第三周', '第四周', '这个月', '下个月',
];

/**
 * Signal B — bare off-domain query shapes. Each entry must be specific enough
 * that it would not appear inside a genuine planning question. These are
 * matched only when NO course signal is present, so they can afford to be
 * ordinary words.
 */
const OFF_DOMAIN = [
  { rule: 'weather', re: /(天气|气温|下雨吗|会不会下雨|温度多少|weather|forecast)/i },
  { rule: 'markets', re: /(股票|股价|基金|汇率|比特币|加密货币|涨了|跌了|stock price|exchange rate)/i },
  { rule: 'news', re: /(新闻|头条|热搜|今日要闻|发生了什么大事)/i },
  { rule: 'sport', re: /(比分|赛程|球赛|世界杯|奥运会|谁赢了)/i },
  { rule: 'code', re: /(写(一)?个?(脚本|程序|代码|函数)|python|javascript|java\b|sql|正则表达式|报错怎么解决)/i },
  { rule: 'chitchat', re: /(讲个笑话|陪我聊天|你是谁开发的|你用的什么模型|你有感情吗)/i },
  { rule: 'general_help', re: /(帮我写(一封)?(简历|辞职信|情书|检讨书)|订(机票|酒店|外卖)|推荐(餐厅|电影|电视剧))/i },
];

/** A node id like 3.2.1 — an unmistakable reference to her own plan. */
const NODE_ID_RE = /\b\d+(\.\d+){1,3}\b/;

/**
 * Signal A: does this message touch her course?
 * @param {string} message
 * @param {{theme?: string, course_plan_blueprint?: Object}|null|undefined} state
 */
export function hasCourseSignal(message, state) {
  const text = String(message ?? '');
  if (!text.trim()) return false;
  if (NODE_ID_RE.test(text)) return true;
  const theme = String(state?.theme ?? '').trim();
  if (theme && text.includes(theme)) return true;
  return COURSE_TERMS.some((t) => text.includes(t));
}

/**
 * Signal B: is this a bare off-domain query?
 * @param {string} message
 * @returns {string} the matched rule name, or '' when nothing matched
 */
export function offDomainRule(message) {
  const text = String(message ?? '');
  for (const { rule, re } of OFF_DOMAIN) if (re.test(text)) return rule;
  return '';
}

/**
 * The scope decision for one inbound message.
 *
 * @param {string} message
 * @param {Object|null|undefined} state
 * @param {{enforce?: boolean}} [opts] enforce=false (default) is WARN-ONLY:
 *   the verdict is reported and logged, but `refuse` stays false so nothing is
 *   blocked. Ship warn-only, read a week of real logs, then enforce — that
 *   turns §4's guesswork into evidence before it can cost a user.
 * @returns {{refuse: boolean, wouldRefuse: boolean, rule: string, enforced: boolean}}
 */
export function checkScope(message, state, opts = {}) {
  const enforce = opts.enforce === true;
  const rule = offDomainRule(message);
  const wouldRefuse = Boolean(rule) && !hasCourseSignal(message, state);
  return { refuse: enforce && wouldRefuse, wouldRefuse, rule: wouldRefuse ? rule : '', enforced: enforce };
}

/**
 * The refusal, shaped as an ordinary turn so the UI renders it like any other
 * agent message — not an error page. Costs no model call.
 *
 * Register per DESIGN.md §7: warm, concrete, never 请注意 / 系统提示. It names
 * what the tool does and offers the nearest useful thing, so a teacher who
 * wandered off-purpose is pointed home rather than told off.
 *
 * @param {Object|null|undefined} state
 * @returns {{reply_markdown: string, question: null, artifacts: Array, closure_loop: null, state_delta: Object, evidence_refs: Array, round_complete: boolean}}
 */
export function refusalTurn(state) {
  const theme = String(state?.theme ?? '').trim();
  const back = theme
    ? `我们回到「${theme}」吧——你想先看哪一周？`
    : '你想带孩子做什么主题？说个大概方向就行，我来帮你往下想。';
  return {
    reply_markdown: `这个我帮不上忙，我只会做幼儿园的主题探究课程——月计划、周计划、每个活动怎么开展。\n\n${back}`,
    question: null,
    artifacts: [],
    closure_loop: null,
    state_delta: {},
    evidence_refs: [],
    round_complete: false,
  };
}
