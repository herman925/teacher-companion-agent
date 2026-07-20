// Mock provider — scripted, contract-compliant walkthroughs of the §7 loop,
// keyed off course_state（状态机优先：路由只看状态，不看轮数）. WF01 入口识别
// classifies the FIRST message into one of five teacher modes; each mode is a
// distinct flow touching different V1.3 workflow nodes, and every turn carries
// a dev-facing wf_trace annotation (developer mode UI). Every canned turn MUST
// pass validateTurn + the stage gates: the mock goes through the same
// L2/L3 pipeline as real providers — no special casing.

import { WF_NODES } from './wf-nodes.mjs';

/** Teacher-mode labels used in wf_trace. */
const MODE_LABELS = {
  from_zero: '从零陪跑',
  optimize_existing: '已有主题优化',
  story_export: '课程故事整理',
  mid_course: '过程中续聊',
  material_support: '素材支持',
};

/** Build a wf_trace block（dev-facing; parseTurn passes it through unvalidated）. */
function trace(mode, stage, nodes, principles, stateNotes) {
  return { mode: MODE_LABELS[mode] ?? mode, stage, nodes, principles, state_notes: stateNotes };
}

/**
 * @param {Object} state current course_state
 * @param {Array} history prior chat messages
 * @param {string} message the teacher's message
 * @returns {Object} a turn-contract object (see contract.zh.md)
 */
export function mockTurn(state, history, message, opts = {}) {
  // 蓝图批注 (spec 2026-07-20): a packaged per-node comment message answers
  // with blueprint_delta refinements, whatever mode the course is in.
  if (/^【蓝图批注】/.test(message) && state.course_plan_blueprint?.modules?.length) {
    return turnBlueprintComments(state, message);
  }
  // WF01 has not run yet → entry recognition on first contact (状态机优先).
  if (!(state.completed_nodes || []).includes('WF01')) return turnEntry(message, opts);
  switch (state.teacher_mode) {
    case 'optimize_existing': return optimizeFlow(state, history, message);
    case 'story_export': return storyFlow(state, history, message);
    case 'mid_course': return midCourseFlow(state, history, message);
    case 'material_support': return materialFlow(state, history, message);
    default: return fromZeroFlow(state, history, message);
  }
}

// ------------------------------------------------------------ WF01 入口识别

function classifyEntry(message) {
  if (/照片|课程故事|整理.*故事|故事.*整理/.test(message)) return 'story_export';
  if (/优化|已有|在做.*主题|想改进/.test(message)) return 'optimize_existing';
  if (/上一轮|昨天|今天.*(孩子|幼儿)|卡住|卡在|反馈/.test(message)) return 'mid_course';
  if (/素材|海报|涂色|调查表|环创/.test(message)) return 'material_support';
  return 'from_zero';
}

function turnEntry(message, opts = {}) {
  switch (classifyEntry(message)) {
    case 'story_export': return turnStoryEntry();
    case 'optimize_existing': return turnOptimizeEntry();
    case 'mid_course': return turnMidCourseEntry();
    case 'material_support': return turnMaterialEntry(message);
    default:
      // 蓝图共创 IS the default from_zero journey (ADR-0003 amendment 2 +
      // Herman 2026-07-20: teachers should never need magic words to get the
      // blueprint) — every fresh theme entry opens with a full-skeleton v0.1.
      return turnBlueprintRound1(message, opts);
  }
}

function detectResource(message) {
  return /龙舟/.test(message) ? '龙舟' : /趁墟/.test(message) ? '趁墟' : /祠堂/.test(message) ? '祠堂' : '醒狮';
}

// ---------------------------------------------- awaiting-phase discrimination

/** Strong field-feedback signal; hard evidence markers bypass the length check. */
/** A packaged question-card reply quotes the QUESTIONS back (`N. 「…」：answer`).
 * Strip those quoted titles (and skip markers) so content gates test only what
 * the teacher actually wrote — otherwise every packaged reply matches 「」. */
function answersOnly(message) {
  return String(message)
    .replace(/^【问题卡回复】\s*/m, '')
    .replace(/^\d+[.、]\s*「[^」]*」：/gm, '')
    .replace(/（跳过）/g, '');
}

function hasFieldFeedback(message) {
  const m = answersOnly(message);
  if (/「|」|原话/.test(m)) return true;
  return /(说|问|画|拍|停留|围|模仿|盯着|照片|卡住)/.test(m) && m.length > 20;
}

/** Did the teacher's message plausibly carry 儿童原话? (same gate the flows use) */
function hasChildWords(message) {
  const m = answersOnly(message);
  return /说|问|「|原话/.test(m) && m.length > 10;
}

/**
 * Compose two scripted turns into one — the batch-answer fast path: when a
 * packaged question-card reply already carries what the NEXT turn would have
 * asked for, both turns' work lands in a single round (多问一答 → 一次点亮多节点).
 * Artifacts/deltas/traces concat; reply/question/closure and the stage proposal
 * are chosen explicitly by the caller (stage jumps >1 are illegal — engine gate).
 */
function mergeTurns(a, b, { reply, stage, note }) {
  const delta = { ...a.state_delta };
  for (const [key, value] of Object.entries(b.state_delta || {})) {
    delta[key] = Array.isArray(value) && Array.isArray(delta[key]) ? [...delta[key], ...value] : value;
  }
  if (stage !== undefined) delta.stage = stage; else delete delta.stage;
  return {
    reply_markdown: reply,
    question: b.question ?? null,
    ...(b.questions ? { questions: b.questions } : {}),
    artifacts: [...(a.artifacts || []), ...(b.artifacts || [])],
    closure_loop: b.closure_loop ?? null,
    state_delta: delta,
    evidence_refs: [...new Set([...(a.evidence_refs || []), ...(b.evidence_refs || [])])],
    round_complete: b.round_complete,
    wf_trace: {
      ...a.wf_trace,
      nodes: [...(a.wf_trace?.nodes || []), ...(b.wf_trace?.nodes || [])],
      principles: [...new Set([...(a.wf_trace?.principles || []), ...(b.wf_trace?.principles || [])])],
      state_notes: note ?? a.wf_trace?.state_notes ?? '',
    },
  };
}

/** In-place support request while a round is out in the field (WF22). */
function wantsInPlaceSupport(message) {
  return /素材|预案|铺垫|家长|打印/.test(message);
}

/** Prior assistant turns matching markerRe — nudge bookkeeping, no hidden state. */
function priorTurnsMatching(history, markerRe) {
  return (history || []).filter((m) => m && m.role === 'assistant' && markerRe.test(String(m.content || ''))).length;
}

/**
 * Deterministic reply-variant picker: counts prior assistant turns matching
 * markerRe and cycles through count variants — consecutive nudges never
 * repeat verbatim, and no hidden state is needed (derived from history alone).
 */
function replyVariant(history, markerRe, count) {
  return priorTurnsMatching(history, markerRe) % count;
}

// 筛选对准模型，不对准老师（PRD 核心论点）：等待关卡最多温柔追问两次。
// 第三次起，无论老师怎么回，都当作现场反馈接住，剧本继续走——演示绝不死锁。
const MAX_NUDGES = 2;

// ======================================================== 从零陪跑 from_zero

function fromZeroFlow(state, history, message) {
  // Blueprint round 2: round 1 delivered the maps (marker in history), the
  // teacher has replied (confirmation or card answers) → full 预设包.
  if (!state.resource_entry_card && priorTurnsMatching(history, BLUEPRINT_MARKER) >= 1) {
    return turnBlueprintRound2(state, history, message);
  }
  // The pivotal direction pick can arrive AFTER round 2 (it was asked there):
  // escalate the map through the normal artifact channel — the engine's merge
  // keeps the branches and the teacher-reply rule makes confirmed legal.
  const mapModule = state.course_plan_blueprint?.modules?.find((m) => m.id === 'network_map');
  if (mapModule && mapModule.status !== 'confirmed' && /方向|来源|故事|场景|制作|材料|问题/.test(message)) {
    return turnDirectionPickAck(state, message);
  }
  if (!state.resource_entry_card) return turnEntryCard();
  if (!(state.children_evidence || []).length) return turnAwaitOrIngest(state, history, message);
  if (!(state.driving_question || {}).text) return turnPickDrivingQuestion(state, message);
  if (!state.story_materials && /课程故事|故事/.test(message)) return turnStoryFragment(state);
  if ((state.cycle_history || []).length < 2) {
    if (hasFieldFeedback(message)) return turnSecondCycleReview();
    if (wantsInPlaceSupport(message)) return turnInPlaceSupport();
    if (priorTurnsMatching(history, CYCLE_NUDGE_MARKER) >= MAX_NUDGES) return turnSecondCycleReview();
    return turnCycleWaitNudge(history);
  }
  return turnHorizon('from_zero', state, history, message);
}

// ---------------------------------------------- 预设蓝图 planning fast path

const BLUEPRINT_MARKER = /阶段一预设蓝图/;

/** Shorthand blueprint node. */
function bpNode(id, title, body, status = 'ai_suggestion', children = []) {
  return { id, title, body, status, children };
}

/**
 * Round 1（ADR-0003 两轮交付）: deliver 主题判断 + 五步总览 + 两张网络 first,
 * then ask ≤3 gap cards. No display numbers in data — the UI numbers the tree.
 */
function turnBlueprintRound1(message, opts = {}) {
  const resource = detectResource(message);
  const band = opts.profile && String(opts.profile.ageBand || '').trim() ? String(opts.profile.ageBand).trim() : '中班';
  const blueprint = {
    type: 'blueprint',
    title: `阶段一预设蓝图（${resource}·${band}）`,
    data: {
      version: 'v0.1',
      modules: [
        {
          ...bpNode('theme_judgment', '主题判断', `「${resource}」贴近本地生活、有真实场域和人物，适合先做一轮主题探究；若后续孩子的问题持续冒出来、装不下了，再考虑往项目化分支发展，不急着现在定。`),
          rationale: {
            heard: [{ quote: message.slice(0, 40) }],
            assumed: `你没有说明想走多深，先按最常见的主题探究定位`,
            pedagogy: '主题探究是大多数幼儿园的真实起点；项目化只在儿童问题装不下预设时才有必要（枫版定位）',
          },
        },
        bpNode('five_steps', '五步总览（2–3 周）', '预先计划 → 建立共同经验 → 发掘已有知识 → 发展想探究的问题 → 布置探索环境。五步不严格分先后，都属于阶段一。为什么先盘已知：幼儿园教育基于经验——孩子早就知道的，不必重教，要在已知之上拔高。', 'ai_suggestion', [
          bpNode('five_steps.evidence', '每步留下什么', '网络图与方向确认；活动照片与儿童原话；「我们已经知道的」记录（清单／网络图／KWL 都行）；问题墙照片；环创与材料清单。'),
        ]),
        bpNode('network_map', '主题预设网络图（教师备课用）', '围绕主题的可探究方向，供你筛选教育价值。两个误区都别踩：极左是完全不预设、走到哪算哪；极右是全按预设硬做、无视孩子的问题——网络图给了不等于照搬。', 'ai_suggestion', [
          bpNode('network_map.origin', `${resource}的来源与故事`, '它从哪里来、和本地的关系。', 'ai_suggestion'),
          bpNode('network_map.scene', '真实场景', `去看一次真实的${resource}活动／场地。`, 'ai_suggestion'),
          bpNode('network_map.making', '制作与材料', '它是怎么做出来的、用了什么材料。', 'ai_suggestion'),
          {
            ...bpNode('network_map.child_questions', '幼儿可能提出的问题', `孩子可能会问：它为什么长这样、谁在做${resource}、我们能不能自己试一试。`, 'hypothesis'),
            rationale: {
              assumed: `按${band}孩子的一般兴趣预判的问题方向`,
              pedagogy: '为什么类与身份模仿类问题在这个年龄段最常见（问题池六分类）',
              profile_basis: `教师档案：${band}`,
            },
          },
        ]),
        bpNode('depth_network', '资源深度网络（防浅表化）', '四层都转成孩子可感知、可操作的小任务，不做符号展示。', 'ai_suggestion', [
          bpNode('depth_network.wuxiang', '物象层', '看、听、摸、比较：外形、声音、动作。', 'ai_suggestion'),
          bpNode('depth_network.tiyan', '体验层', '模仿、游戏、材料尝试：配合与节奏。', 'ai_suggestion'),
          bpNode('depth_network.guanxi', '关系层', '它和家人、社区、生活的联系：访谈、走访。', 'ai_suggestion'),
          bpNode('depth_network.yiyi', '意义层', '孩子可能慢慢多一点亲近和表达——这一层等现场验证，不预写结论。', 'hypothesis'),
        ]),
        // 完整画面从第一轮就在（骨架先立起来，薄处可见地薄）：下游模块以
        // hypothesis 粗线条占位，教师确认网络方向后第二轮才细化成 v0.2。
        bpNode('week_plan', '2–3 周计划（待细化）', '大致节奏：第 1 周共同经验，第 2 周已知与问题墙，第 3 周聚焦调整。确认网络方向后我再按你的资源和班况排细。', 'hypothesis'),
        bpNode('activity_pack', '活动方案包（待细化）', '五类组织形式各一个方向：集体教学、小组教学、个别指导、自主游戏·环创、亲子活动。细案随第二轮给出。', 'hypothesis'),
        bpNode('environment', '环境与材料（待细化）', '材料清单、给家长的一封信、问题墙——都会在第二轮给到可直接取用的版本。', 'hypothesis'),
      ],
    },
  };
  // 必答缺口清单（锋版 WF-01 intake）：主题、年龄段/班额、可用资源、预计周期、
  // 输出形式。已经从消息或档案里读到的，静默亮灯跳过——绝不重复问（≤3 张）。
  const durationKnown = /([一两三四1-9])\s*个?\s*(月|周|星期)/.test(message);
  const formatKnown = /月计划|周计划|日计划/.test(message);
  const classKnown = Boolean(opts.profile && String(opts.profile.classSize || '').trim()) || /\d+\s*个?\s*(孩子|人|幼儿)/.test(message);
  // 资源意图 (WF03b heart): auto-extracted when the teacher already told us WHY.
  const intentKnown = /因为|想让|希望|见过|看热闹|试试|园里想|正好/.test(message);
  const gapCards = [
    !intentKnown && {
      id: 'q-bp-intent',
      text: `用大白话说说，为什么想带孩子做${resource}`,
      why: '你的资源意图决定网络图往哪边偏——说不清也没关系',
      examples: [`园附近每年都有${resource}活动，孩子们其实见过，但只是看热闹`, '园里想做本土文化课程，我自己也想试试', '说不清楚，你先按这个资源给我几个方向'],
    },
    {
      id: 'q-bp-resources',
      text: `园里或周边有哪些能用上的${resource}资源`,
      why: '真实人物和场地会显著改变网络图的重心',
      examples: [`附近有${resource}队/传承人，可以约参观`, '园里有相关道具和图书角材料', '暂时想不到，先按通用方案来'],
    },
    !durationKnown && {
      id: 'q-bp-duration',
      text: '这个主题你打算做多久',
      why: '周期决定五步怎么铺、计划排几周',
      examples: ['做一个月', '先试两三周看看', '园里统一安排，还没定'],
    },
    !formatKnown && {
      id: 'q-bp-format',
      text: '最后想要什么形式的计划',
      why: '我会把活动直接排进你要的格式',
      examples: ['月计划一张表', '按周计划来', '先给大纲，格式以后再说'],
    },
    !classKnown && {
      id: 'q-bp-class',
      text: '班里大概多少个孩子',
      why: '班额影响小组活动和材料的量',
      examples: ['30 个左右', '20 出头', '混龄班，人数不固定'],
    },
  ].filter(Boolean).slice(0, 3);
  return {
    reply_markdown:
      `好，我先把「${resource}」的阶段一预设蓝图整理给你——主题判断、五步路径、两张网络图做了细案，后面的周计划、活动包和环境模块也先立了骨架（标「待细化」），你第一眼就能看到全貌。标「预设·待验证」的是我按${band}孩子的一般特点预判的，不当作已发生的事实。\n\n你可以直接在方向上删改；下面几件事补上后，我就把骨架部分细化成完整预设包。`,
    question: gapCards[0],
    questions: gapCards,
    artifacts: [blueprint],
    closure_loop: null,
    state_delta: {
      teacher_mode: 'from_zero',
      theme_resource: { name: resource },
      completed_nodes: ['WF01', 'WF02'],
      pending_confirmations: [{ path: 'course_plan_blueprint.network_map', reason: 'awaiting_choice', note: '网络图方向待教师筛选' }],
    },
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('from_zero', 0, [
      { id: 'WF01', name: '入口识别', apply: '计划类请求→预设蓝图先行（先交付，后提问）' },
      { id: 'WF02', name: '信息补全', apply: '静默提取主题与年段；只用两张问题卡问关键缺口' },
    ], ['先给完整方案再一起改', '预设必须标注'], '蓝图 v0.1 交付；stage 保持0'),
  };
}

/**
 * Round 2: teacher confirmed/answered → full 预设包 v0.2 + 切口卡状态落库；
 * network modules escalate to teacher_preset/confirmed only because the
 * teacher's reply confirmed them（教师确认，不是模型自封）.
 */
/** Per-resource concrete materials — a shopping list a 保育员 can act on
 * (pedagogy-panel finding: generic lists are not 可直接取用). */
const RESOURCE_MATERIALS = {
  醒狮: '红布与彩带、纸箱狮头半成品×4、小鼓或锣 1 面、绒球、狮身彩绘用大笔与颜料',
  龙舟: '大纸箱船身×2、纸板船桨、若干小鼓、彩绳、防水布（旱地划船用）',
  趁墟: '摊位小桌布×4、玩具秤与篮子、自制纸币卡、当地特产实物或图片、叫卖牌',
  祠堂: '祠堂照片放大图、可拼搭的积木梁柱、灯笼半成品、族谱式大画纸、瓦当拓印材料',
};

// ------------------------------------------------ 蓝图批注 → delta refinement

/** Parse packaged 批注 lines: `N. 「1.2 标题」(id: node_id)：批注内容`. */
export function parseBlueprintComments(message) {
  const rows = [];
  for (const m of String(message).matchAll(/^\d+[.、]\s*「([^」]*)」\(id:\s*([^)]+)\)：(.+)$/gm)) {
    rows.push({ label: m[1].trim(), id: m[2].trim(), text: m[3].trim() });
  }
  return rows;
}

function turnBlueprintComments(state, message) {
  const rows = parseBlueprintComments(message);
  const known = new Set();
  const walk = (n) => { known.add(n.id); (n.children || []).forEach(walk); };
  (state.course_plan_blueprint?.modules || []).forEach(walk);
  const hits = rows.filter((r) => known.has(r.id));
  const delta = hits.map((r) => ({
    op: 'update',
    id: r.id,
    node: { body: `已按你的批注调整：${r.text}。原方向里仍可用的部分保留，不合适的部分替换。`, status: 'teacher_preset' },
  }));
  const lines = hits.map((r, i) => `${i + 1}. 「${r.label}」：收到。已按批注更新该节点，方向以你的现场判断为准。`);
  return {
    reply_markdown: hits.length
      ? `你的 ${hits.length} 条批注我逐条处理了：\n\n${lines.join('\n')}\n\n改动都落在右侧蓝图面板对应节点里，贴不贴你的想法请到面板里核对；不对的地方继续批注，认可的直接点确认。`
      : '这批批注没有对上蓝图里的节点（蓝图可能已更新过版本）。请在面板里对着最新版本重新批注一次。',
    questions: [],
    artifacts: [],
    blueprint_delta: delta,
    closure_loop: null,
    state_delta: {},
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace(state.teacher_mode || 'from_zero', state.stage ?? 0, [],
      ['先给完整方案再一起改', '预设必须标注'], `蓝图批注 ${hits.length} 条 → blueprint_delta 更新`),
  };
}

function turnBlueprintRound2(state, history, message) {
  const resource = (state.theme_resource || {}).name || '醒狮';
  const materials = RESOURCE_MATERIALS[resource] || RESOURCE_MATERIALS['醒狮'];
  // Metabolize what the teacher actually said (panel finding: quoted-but-ignored):
  const month = /一个月|1\s*个月|四周|4\s*周/.test(message);
  const sizeMatch = message.match(/(\d+)\s*个?\s*(孩子|人|幼儿)/);
  const classSize = sizeMatch ? Number(sizeMatch[1]) : null;
  const groupNote = classSize ? `班里 ${classSize} 个孩子：体验角每次 6–8 人轮流，小组活动分 ${Math.ceil(classSize / 8)} 组进行。` : '体验角每次 6–8 人轮流。';
  // The pivotal REAL choice (panel finding: intake answers ≠ direction confirmation):
  // the map only escalates when the teacher actually picks directions.
  const pickedDirections = /方向|来源|故事|场景|制作|材料|问题/.test(message);
  const weekKids = [
    bpNode('week_plan.w1', '第 1 周：建立共同经验', `集体：一起看一场${resource}（视频或现场，完整教案见活动方案包）；环创：教室里开${resource}体验角。${groupNote}`, 'ai_suggestion'),
    bpNode('week_plan.w2', '第 2 周：发掘已知（多通道）与问题墙', '「我们已经知道的」不止靠说：集体讨论记录清单＋自选表征——画出来、搭出来、演出来（画纸/积木/角色区三个通道同时开放）。问题墙上墙，游戏中随手记孩子的问题。', 'ai_suggestion'),
    bpNode('week_plan.w3', '第 3 周：聚焦与调整', '按问题墙的密集处调整活动重心，为下一阶段筛有潜力的问题。', 'ai_suggestion'),
  ];
  if (month) weekKids.push(bpNode('week_plan.w4', '第 4 周：小结与回望', '和孩子一起回看问题墙的 KWHL：我们知道了什么、还想知道什么——为下个阶段留好接口。', 'ai_suggestion'));
  const blueprint = {
    type: 'blueprint',
    title: `阶段一完整预设包（${resource}）`,
    data: {
      version: 'v0.2',
      modules: [
        {
          ...bpNode('network_map', '主题预设网络图', pickedDirections
            ? '按你点选的方向收拢；你补充的资源已并入关系层。'
            : '方向还没定——下面问题卡里选 2–3 个最贴近你们班的，网络图就按它收拢。', pickedDirections ? 'confirmed' : 'teacher_preset'),
          rationale: { heard: [{ quote: message.slice(0, 40) }] },
        },
        bpNode('week_plan', month ? '4 周计划' : '2–3 周计划', '', 'ai_suggestion', weekKids),
        bpNode('activity_pack', '活动方案包（五类组织形式）', '幼儿园的活动组织形式就这五类。第 1 周的两个已展开成完整教案；其余先给方向和「换个玩法」——预设是给你选择的起点，不是唯一答案。', 'ai_suggestion', [
          bpNode('activity_pack.jiti', `集体教学 · 看一场${resource}（完整教案）`, `目的：建立共同经验。\n流程（约 20 分钟）：① 3 分钟入场，提一个悬念问题「等下看的时候，找一样你最想摸一摸的东西」② 8 分钟观看片段 ③ 7 分钟围坐讨论：你看到了什么／哪里最想试试／有什么想不明白 ④ 2 分钟收束：把想不明白的记到问题墙。\n材料：${resource}影像片段（现场更好）、问题墙便签。\n安全：观看区坐垫定位，避免起身拥挤。\n观察点：谁在反复提问、谁盯着某个细节不放。\n活动后表征：回教室画「我印象最深的一样东西」。\n换个玩法：共读一本相关绘本，让孩子指认见过的部分。`, 'ai_suggestion'),
          bpNode('activity_pack.xiaozu', `小组教学 · ${resource === '醒狮' ? '狮头狮尾配合走' : '齐心协力小任务'}`, `目的：体验主题里的配合与节奏（主题内的合作，不做泛化游戏）。\n流程（每组约 10 分钟）：两人一前一后披一块布，前面的带路后面的跟，走过 3 个小障碍；走完换位。\n材料：大块软布×每组 1、地面障碍垫。\n安全：软布只到腰高、不遮脸；地面清空；教师全程在侧。\n观察点：合作卡点与商量方式——谁提出了办法。\n换个玩法：不给障碍路线，由小组自己商量摆。`, 'ai_suggestion'),
          bpNode('activity_pack.gebie', '个别指导', '对特别着迷或还在观望的孩子做一对一跟随记录。目的：看见个体差异——最活跃的和还在观望的都是信息。观察点：观望的孩子在看什么。', 'ai_suggestion'),
          bpNode('activity_pack.youxi', '自主游戏·环创', `${resource}体验角持续开放（${groupNote}）。目的：让兴趣自己长出来。观察点：停留时长与自发语言。换个玩法：把材料换成半成品，看孩子怎么补全。`, 'ai_suggestion'),
          bpNode('activity_pack.qinzi', '亲子活动', `请家长带孩子看一次真实${resource}，或采访见过的长辈（附访谈三问：您第一次见是什么时候／最难忘哪一次／能教孩子一个小动作吗）。目的：把经验连到家庭与社区。换个玩法：亲子手工任务，做一个小${resource}带回班里。`, 'ai_suggestion'),
        ]),
        bpNode('environment', '环境与材料', '', 'ai_suggestion', [
          bpNode('environment.list', `材料清单（${resource} 专用，可直接交给保育员）`, `${materials}；另备：记录便签、画纸、粗头笔。`, 'ai_suggestion'),
          bpNode('environment.letter', '给家长的一封信（全文，可直接打印）', `亲爱的家长：\n近期班里开始「${resource}」主题探究。想请您帮两件小事：① 如果家里有和${resource}有关的物件、照片或小视频，请让孩子带来和大家分享（我们会好好保管）；② 周末如果路过相关的场景，停下来看两分钟，听听孩子说什么，把最有意思的一句话记在联系本上。不需要提前教知识——孩子自己的发现最珍贵。谢谢！\n——${resource}主题项目组`, 'ai_suggestion'),
          bpNode('environment.wall', '问题墙 + 主题墙（KWHL）', '孩子的问题要进环境、贴上墙。主题墙按 KWHL 分四栏：知道什么、想知道什么、如何去知道、学会了什么——最后一栏留到复盘再填。旁边留一格「材料工坊」放半成品，随时可取。', 'ai_suggestion'),
        ]),
        bpNode('feedback_card', '轻量回传（3 分钟）', '回来告诉我：儿童原话一两句、作品或问题墙照片、你最困惑的一点。回传是为了优化计划，不是为了解锁下一步。', 'ai_suggestion'),
        bpNode('signal_note', '项目化信号提醒', '若同一问题反复出现、孩子开始说「我们可以做／试」、你的预设装不下他们的问题——这是可以往项目式探究发展的信号，到时我会提醒你，也可以不切换。', 'hypothesis'),
      ],
    },
  };
  const directionCard = pickedDirections ? null : {
    id: 'q-bp-directions',
    text: '网络图的方向里，先聚焦哪 2–3 个',
    why: '这是你的教育价值筛选——选了，网络图才算你的',
    examples: ['来源与故事＋真实场景', '制作与材料——孩子最爱动手', '先看孩子的问题再定'],
  };
  return {
    reply_markdown: pickedDirections
      ? `收到。对照上一版：网络图按你点选的方向收拢，你补充的信息我并进了计划${month ? '（按一个月排成 4 周）' : ''}。第 1 周的两个活动展开成了完整教案，家长信全文和${resource}专用材料清单可以直接取用。\n\n先按第 1 周做起来，不用等一切都齐。`
      : `收到，你补充的信息我并进了计划${month ? '（按一个月排成 4 周）' : ''}。第 1 周的两个活动展开成了完整教案，家长信全文和${resource}专用材料清单可以直接取用。\n\n还差一个只有你能做的判断：网络图先聚焦哪几个方向——下面的卡片选一下，选了它才算你的计划。`,
    question: directionCard,
    questions: directionCard ? [directionCard] : [],
    artifacts: [blueprint],
    closure_loop: {
      do_now: '按第 1 周安排开展 1–2 个建立共同经验的活动',
      materials: '材料清单与给家长的一封信（草稿）都在预设包里，可直接取用',
      bring_back: '儿童原话一两句、活动或问题墙照片、你最困惑的一点',
      i_will: '对照蓝图说明哪些预设成立、哪些要调整，更新到 v0.3 并给下一轮建议',
    },
    state_delta: {
      stage: 1, // proposal — this same delta supplies the gate's prerequisites
      theme_fit_level: 'theme_inquiry',
      completed_nodes: ['WF02b', 'WF03b', 'WF04', 'WF04b'],
      resource_entry_card: {
        original_theme: resource,
        initial_goal: '先做一轮主题探究，观察孩子被什么抓住',
        child_entry_points: ['真实场景入口', '声音与动作入口', '制作材料入口'],
        perceivable_content: ['外形与声音', '配合的动作', '真实人物与场地'],
        deepening_directions: ['关系层：家人与社区', '意义层：亲近与表达（待现场确认）'],
        first_experience: `一起看一场真实的${resource}`,
        adult_phrasings_to_avoid: ['传承精神', '弘扬传统文化'],
      },
    },
    evidence_refs: [],
    round_complete: true,
    wf_trace: trace('from_zero', 0, [
      { id: 'WF02b', name: '主题适配性筛查', apply: '判定 theme_inquiry：先做一轮主题探究' },
      { id: 'WF03b', name: '资源意图确认', apply: '教师回复即确认——三问静默亮灯，不逐轮追问' },
      { id: 'WF04', name: '主题网络', apply: '网络图经教师确认，状态升级 confirmed' },
      { id: 'WF04b', name: '资源深度网络', apply: '四层并入预设包，意义层保持待验证' },
    ], ['先给完整方案再一起改', '回传为了优化不为解锁'], '完整预设包 v0.2；awaiting_feedback 置 true'),
  };
}

/** Teacher picked network-map directions after round 2 — the one judgment
 * only she can make. A childless update: the engine merge keeps the branches. */
function turnDirectionPickAck(state, message) {
  const resource = (state.theme_resource || {}).name || '醒狮';
  return {
    reply_markdown:
      `好，网络图按你点的方向收拢——这个筛选只有你能做，现在这份计划才算你的。方向外的分支我留着不删：孩子的问题冒出来时随时可以捡回来。\n\n接下来就按第 1 周开始，回传卡见。`,
    question: null,
    questions: [],
    artifacts: [{
      type: 'blueprint',
      title: `主题预设网络图（已按你的方向确认）`,
      data: {
        version: 'v0.2',
        modules: [{
          id: 'network_map', title: '主题预设网络图', status: 'confirmed',
          body: '按你点选的方向收拢；未选分支保留备用，不删。',
          rationale: { heard: [{ quote: message.slice(0, 40) }] },
        }],
      },
    }],
    closure_loop: null,
    state_delta: { completed_nodes: ['WF04'] },
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('from_zero', state.stage ?? 1, [
      { id: 'WF04', name: '主题网络', apply: '教师点选方向——网络图升级 confirmed，分支保留' },
    ], ['方向筛选是教师唯一不可代劳的判断'], `网络图 confirmed；${resource} 蓝图版本随之递增`),
  };
}

function turnEntryCard() {
  return {
    reply_markdown:
      '明白了。你的想法里已经有两个很好的线索：孩子们**见过**这个资源（有真实场域），你希望他们**不止于看热闹**（有意图方向）。我把它整理成一张资源课程化切口卡，你只要标出最认可的儿童入口。\n\n同时我判断了一下这个主题适合走到哪一步、第一轮可以怎么做，还把资源摊开成一张深度网络图——孩子能看见什么、能体验什么、能和谁发生关系、往后可能多一点什么感受——都在下面的卡片里。',
    question: {
      text: '三个儿童入口里，哪一个最像你们班孩子会扑上去的？',
      why: '第一轮体验只做一个入口，做透比做全重要',
      examples: ['声音入口——他们平时听到鼓声就会围过去', '狮头入口——班里孩子对面具类的东西一直很着迷', '我拿不准，先按你推荐的来'],
    },
    artifacts: [
      {
        type: 'entry_card',
        title: '资源课程化切口卡 · 醒狮',
        data: {
          original_theme: '醒狮',
          initial_goal: '让孩子从看热闹到真实接触，多一点亲近和好奇',
          child_entry_points: ['鼓点声音：听、拍、模仿节奏', '狮头狮被：看、摸、掂重量', '醒狮队的人：看训练、问问题'],
          perceivable_content: ['鼓/锣/镲的声音层次', '狮头的眼睛会眨', '舞狮人的马步和汗水'],
          deepening_directions: ['狮头是怎么做出来的', '为什么节日要醒狮', '孩子能不能自己舞一段'],
          first_experience: '到附近武馆或社区看一次真实训练（不是表演），孩子自由停留观察',
          adult_phrasings_to_avoid: ['传统文化瑰宝', '非遗传承', '民族精神'],
        },
      },
      {
        type: 'fit_screening',
        title: '主题适配性筛查',
        data: {
          judgment: 'theme_inquiry',
          judgment_zh: '主题探究型（有项目化潜力，待儿童反应验证）',
          reasons: ['有真实场域和真实人物可接触', '资源可感知层次丰富（声音/物件/动作）', '公共交付可能性暂不明确——不急着定项目'],
          suggested_intensity: '先做一轮真实体验＋一轮问题收集，再判断要不要长成项目',
        },
      },
      {
        type: 'depth_network',
        title: '资源深度网络图 · 醒狮（教师后台）',
        data: {
          physical_layer: {
            see: ['狮头、狮被、鼓锣镲', '舞狮人的马步与动作', '训练场里的声音层次'],
            task: '现场自由停留观察，回园画「我看到的醒狮」',
          },
          experience_layer: {
            do: ['拍一段鼓点节奏', '掂一掂狮头的重量', '学一个马步动作'],
            task: '每人选一样试一次，记下谁试了什么、停了多久',
          },
          relation_layer: {
            connect: ['舞狮师傅', '看过醒狮的家人长辈', '家门口的节日场景'],
            task: '用访谈卡问一个真人，把答案带回来讲给同伴听',
          },
          meaning_layer: {
            hints: ['亲近与好奇', '一起做成一件事的热闹', '对家门口活动的归属感'],
            task: '仅作教师后台观察线索，待现场确认——不向孩子讲授',
            caution: '没有证据之前只能说「可能」',
          },
          depth_risk: '若只停在物象层看热闹，主题容易做浅——第一轮体验后，看孩子把哪条线索接走再决定往哪层走',
        },
      },
      {
        type: 'experience_plan',
        title: '第一轮体验：看一次真实的醒狮训练',
        data: {
          purpose: '补「近距离感知」经验：声音、物件、人（此前只有远看的热闹经验）',
          arrangement: '联系附近武馆/社区醒狮队，选训练日（非表演日）带孩子观摩30分钟',
          observation_focus: ['孩子在哪里停留最久', '孩子模仿了什么动作', '孩子问出/嘟囔了什么'],
          safety: '与鼓保持距离防惊吓；提前告知孩子可以捂耳朵',
          representation_after: '回园画「我看到的醒狮」，想问的问题贴上问题墙',
        },
      },
      {
        type: 'interview_card',
        title: '真实人物访谈卡 · 舞狮师傅',
        data: {
          for_children: ['狮子的眼睛为什么会眨？', '你在狮子里面看得见路吗？', '鼓打错了狮子会怎么样？'],
          for_adults: ['孩子们可以摸一摸狮头吗？有什么讲究？', '师傅小时候是怎么开始学的？', '训练里最难的一步是什么？'],
          representation: '访谈后让孩子用画或符号记下「师傅说的最有意思的一句话」',
        },
      },
    ],
    closure_loop: {
      do_now: '联系醒狮队，带孩子看一次真实训练，让他们自由停留、自由问',
      materials: '打印访谈卡；准备手机拍孩子的停留点和原话',
      bring_back: '孩子的3句原话、停留最久的2个点、几张照片，以及你观察到的1个意外反应',
      i_will: '我会把孩子的真实问题整理成问题池，并标出背后的文化可能性（只给你看，不给孩子讲）',
    },
    state_delta: {
      teacher_resource_intent: {
        why_this_resource: '孩子见过但只是看热闹，希望多一点真实接触',
        first_contact_idea: '看真实训练',
        hoped_feeling: '亲近和好奇，而不只是知道',
        confidence: 'teacher_stated',
      },
      resource_entry_card: {
        original_theme: '醒狮',
        initial_goal: '从看热闹到真实接触',
        child_entry_points: ['鼓点声音', '狮头狮被', '醒狮队的人'],
        perceivable_content: ['鼓声层次', '狮头细节', '舞狮人动作'],
        deepening_directions: ['狮头制作', '节日语境', '亲身尝试'],
        first_experience: '看一次真实训练',
        adult_phrasings_to_avoid: ['传统文化瑰宝', '非遗传承'],
      },
      theme_fit_level: 'theme_inquiry',
      completed_nodes: ['WF02b', 'WF03b', 'WF04b'],
      stage: 1,
    },
    evidence_refs: [],
    round_complete: true,
    wf_trace: trace('from_zero', 0, [
      { id: 'WF03b', name: '资源意图确认与课程可能性启发', apply: '教师意图落成切口卡的三个儿童入口' },
      { id: 'WF02b', name: '主题探究适配性筛查', apply: '判定主题探究型，项目化留待儿童反应验证' },
      { id: 'WF04b', name: '资源深度网络图', apply: '切口卡展开为物象/体验/关系/意义四层，意义层仅教师后台' },
      { id: 'WF05', name: '建立共同经验（真实体验活动）', apply: '第一轮体验计划：看一次真实训练' },
      { id: 'WF05b', name: '真实人物与生活场景访谈任务', apply: '生成舞狮师傅访谈卡（孩子问＋老师问）' },
    ], ['教师资源意图优先', '阶段判断优先', '输出闭环固定'], '写入 resource_entry_card、theme_fit_level 与深度网络；stage 提议 0→1（引擎按门槛放行）'),
  };
}

function turnAwaitOrIngest(state, history, message) {
  // Discrimination order: explicit entry-choice answers win over the feedback
  // heuristic (choice chips contain words like 围/说), but hard evidence
  // markers (「」/原话/照片) always route to ingest — never swallow the field.
  const choice = matchEntryChoice(message);
  if (choice && message.length <= 40 && !/「|」|原话|照片/.test(message)) return turnEntryChoice(state, choice);
  if (hasFieldFeedback(message)) return turnIngestFeedback();
  if (wantsInPlaceSupport(message)) return turnInPlaceSupport();
  if (priorTurnsMatching(history, NUDGE_MARKER) >= MAX_NUDGES) return turnIngestFeedback();
  return turnAwaitNudge(history);
}

function turnIngestFeedback() {
  return {
    reply_markdown:
      '这轮反馈非常有料——尤其是你注意到孩子们**自己开始模仿马步**，这比任何提问都真实。我把这些都记进证据里了。\n\n从证据看，孩子现在的问题主要围着「狮头这个物件」和「里面的人」转，这正是好的探究起点。下面是我整理的问题池，你确认一下哪些是孩子真实说过的。',
    question: {
      text: '问题池里的问题，哪些是孩子的原话，哪些是你事后概括的？',
      why: '真实儿童问题才能推导核心驱动问题，成人概括要单独标记',
      examples: ['前三个都是原话，最后一个是我概括的', '都是原话，我尽量没有加工', '有两个我记不清了，下次我当场记下来'],
    },
    artifacts: [
      {
        type: 'question_pool',
        title: '儿童问题池（第一轮体验后）',
        data: {
          promising: [
            { question: '狮子的眼睛为什么会眨？', category: 'why', evidence: 'ev-words-1', cultural_hint_backstage: '狮头机关是手艺——可能的生活经验入口：谁做的狮头、怎么做的。儿童小任务：去问师傅「眼睛是谁装上去的」。' },
            { question: '我能进到狮子里面吗？', category: 'identity_imitation', evidence: 'ev-words-2', cultural_hint_backstage: '身份模仿是参与文化的起点。儿童小任务：让师傅演示狮被里两人怎么配合，孩子两人一组试试「一个当头一个当尾」。' },
            { question: '鼓为什么有时候快有时候慢？', category: 'why', evidence: 'ev-words-3', cultural_hint_backstage: '鼓点是醒狮的语言（可能）。儿童小任务：录两段不同的鼓点，回班里对比拍一拍。' },
          ],
          excluded: [{ question: '醒狮文化有什么意义？', reason: '无儿童证据——成人化问题，剔除' }],
        },
      },
      {
        type: 'driving_questions',
        title: '候选核心驱动问题',
        data: {
          candidates: [
            { text: '我们怎样排一段自己的小醒狮，让弟弟妹妹们看懂并且不害怕？', recommended: true, why: '儿童性和行动性最强，受众真实（小班）' },
            { text: '我们怎样弄清楚狮头的眼睛是怎么眨的，并做一个会眨眼的狮头？', recommended: false, why: '工程性强，但材料门槛需要核实' },
          ],
          note: '两个都来自孩子的真实问题；选哪个，听你和孩子的',
        },
      },
    ],
    closure_loop: {
      do_now: '把问题池贴回问题墙，让孩子看到自己的问题被认真对待；和孩子聊聊两个候选问题哪个更想做',
      materials: '问题墙卡片模板（我可以下轮生成）',
      bring_back: '孩子选了哪个问题、为什么；三类儿童观察各一句；三句聚焦反馈（第三句可以参考：「下一轮该进入行动尝试了吗？」）',
      i_will: '根据孩子的选择生成第一轮协作行动方案和观察重点',
    },
    state_delta: {
      children_evidence: [
        { id: 'ev-words-1', kind: 'child_words', content: '狮子的眼睛为什么会眨？', child_ref: '男孩A', round: 1, recorded_at: 'round1' },
        { id: 'ev-words-2', kind: 'child_words', content: '我能进到狮子里面吗？', child_ref: '女孩B', round: 1, recorded_at: 'round1' },
        { id: 'ev-words-3', kind: 'child_words', content: '鼓为什么有时候快有时候慢？', child_ref: '男孩C', round: 1, recorded_at: 'round1' },
        { id: 'ev-behavior-1', kind: 'behavior', content: '五六个孩子自发模仿马步，持续约十分钟', round: 1, recorded_at: 'round1' },
        { id: 'ev-dwell-1', kind: 'dwell_point', content: '狮头存放架前停留最久，反复看眼睛的机关', round: 1, recorded_at: 'round1' },
      ],
      child_question_pool: [
        { question: '狮子的眼睛为什么会眨？', category: 'why', evidence_refs: ['ev-words-1'], potential: 'promising' },
        { question: '我能进到狮子里面吗？', category: 'identity_imitation', evidence_refs: ['ev-words-2'], potential: 'promising' },
        { question: '鼓为什么有时候快有时候慢？', category: 'why', evidence_refs: ['ev-words-3'], potential: 'promising' },
      ],
      driving_question: {
        candidates: ['我们怎样排一段自己的小醒狮，让弟弟妹妹们看懂并且不害怕？', '我们怎样弄清楚狮头的眼睛是怎么眨的，并做一个会眨眼的狮头？'],
      },
      child_learning_stage: 'question_generation',
      completed_nodes: ['WF05', 'WF05b', 'WF06', 'WF07', 'WF07b', 'WF08'],
    },
    evidence_refs: ['ev-words-1', 'ev-words-2', 'ev-words-3', 'ev-behavior-1', 'ev-dwell-1'],
    round_complete: true,
    wf_trace: trace('from_zero', 1, [
      { id: 'WF06', name: '发掘幼儿已有相关知识', apply: '现场反馈（原话/行为/停留点）入证据账本' },
      { id: 'WF07', name: '儿童问题池整理', apply: '三个真问题入池，成人化问题剔除' },
      { id: 'WF07b', name: '儿童问题背后的文化可能性提示', apply: '每个问题附后台文化线索（只给教师看）' },
      { id: 'WF08b', name: '核心驱动问题推导（阶段2边界）', apply: '从真实问题推出两个候选，教师与孩子选' },
    ], ['证据优先', '儿童真实反应驱动调整', '文化可能性后台提示'], '写入 children_evidence、child_question_pool 与 driving_question 候选'),
  };
}

function turnStoryFragment(state) {
  return {
    reply_markdown:
      '到这里，你手上其实已经攒下了一段真实的课程故事开头。我根据已有证据整理了一个片段——注意我只写了有证据的部分，还没发生的部分标了缺口。',
    question: null,
    artifacts: [
      {
        type: 'story_fragment',
        title: '课程故事片段 · 醒狮（草稿）',
        data: {
          origin: '教师带孩子看了一次真实的醒狮训练，起点不是教案，而是孩子在狮头架前挪不动的脚步。',
          question_birth: '「狮子的眼睛为什么会眨？」「我能进到狮子里面吗？」——问题墙上最先亮起来的，是物件和身份两类真问题。',
          first_action: '孩子们决定排一段自己的小醒狮给弟弟妹妹看。第一次排练，配合是最大的卡点——而这正是下一轮的起点。',
          gaps: ['排练现场照片与录像', '弟弟妹妹观看后的真实反馈', '教师本轮反思一段'],
        },
      },
    ],
    closure_loop: {
      do_now: '按缺口清单补两张照片和一段反思，不用长',
      materials: '课程故事图文模板（可导出）',
      bring_back: '补齐的材料，或告诉我哪些暂时补不了',
      i_will: '把片段扩成可用于园本汇报的初稿',
    },
    state_delta: {
      story_materials: { gaps: ['排练现场照片与录像', '受众反馈', '教师反思'], narrative_spine: '从看热闹到自己排一段小醒狮' },
      completed_nodes: ['WF28', 'WF29'],
    },
    evidence_refs: (state.children_evidence || []).slice(0, 2).map((e) => e.id),
    round_complete: true,
    wf_trace: trace('from_zero', 2, [
      { id: 'WF28', name: '材料完整性检查', apply: '只用已有证据成稿，缺口如实列出不虚构' },
      { id: 'WF29', name: '叙事主线提炼', apply: '主线：从看热闹到自己排一段小醒狮' },
    ], ['证据优先', '输出闭环固定'], '写入 story_materials（含缺口清单）；stage 不动，等材料补齐再谈导出'),
  };
}

// ================================================ 已有主题优化 optimize_existing

function optimizeFlow(state, history, message) {
  if (!state.resource_entry_card) {
    // Batch fast path: the entry's two question cards answered together —
    // 家底 AND 原话 in one packaged reply — backfill and evidence land in one turn.
    if (hasChildWords(message)) return turnOptimizeBackfillWithEvidence();
    return turnOptimizeBackfill();
  }
  if (!(state.children_evidence || []).length) {
    // 证据优先: only ingest when the message plausibly carries 原话.
    if (hasChildWords(message)) return turnOptimizeEvidence();
    if (priorTurnsMatching(history, OPTIMIZE_WAIT_MARKER) >= MAX_NUDGES) return turnOptimizeEvidence();
    return turnOptimizeWait(history);
  }
  if (!(state.driving_question || {}).text) return turnOptimizePick(state, message);
  return turnHorizon('optimize_existing', state, history, message);
}

/** Batch fast path: 回填建档 + 原话入池 in one turn (entry cards answered together). */
function turnOptimizeBackfillWithEvidence() {
  return mergeTurns(turnOptimizeBackfill(), turnOptimizeEvidence(), {
    reply:
      '家底和原话一次到齐——我把两步并成一轮做完。\n\n**回填建档**：主题网络接进课程档案，切口卡和适配性筛查在下面两张卡里，确认方向就行。\n\n**证据先行**：三句原话质量都很高——特别是「想自己做一条会浮的龙舟」，里面已经藏着行动性和公共性。「兴趣散」的判断可以修正了：从证据看，孩子的注意力集中在「船怎么浮、怎么动」这类构造问题上，只是原来的主题网络没有接住它。\n\n下面还有整理后的儿童问题池和收紧的核心驱动问题候选。等孩子选定问题，目标与评估轴心就能进入下一轮。',
    stage: 1, // 0→1 by the backfill; 0→2 would be an illegal jump — pick 阶段 advances later
    note: '批量作答快车道：回填 resource_entry_card + children_evidence + 问题池 + 驱动问题候选同轮入账；stage 提议 0→1，阶段2 等教师选定驱动问题再提',
  });
}

function turnOptimizeEntry() {
  return {
    reply_markdown:
      '好——已经在做的主题不用推倒重来，我们从你手上已有的东西接着长。下面两张卡把家底带给我：都答上的话，建档和证据整理我一轮就能做完。',
    question: {
      text: '你们现在手上已经有什么，做到哪一步了？',
      why: '先摸清已有底子，才不会给你重复的建议',
      examples: ['有主题网络，但孩子兴趣散', '做了两周活动，不知道下一步', '有活动照片和作品，没整理'],
    },
    questions: [
      {
        id: 'q-assets',
        text: '你们现在手上已经有什么，做到哪一步了？',
        why: '先摸清已有底子，才不会给你重复的建议',
        examples: ['有主题网络，但孩子兴趣散', '做了两周活动，不知道下一步', '有活动照片和作品，没整理'],
      },
      {
        id: 'q-words',
        text: '这段时间里，孩子说过哪几句让你印象深的话？',
        why: '证据优先——有原话，优化方向就从证据里长，答不上先跳过',
        examples: ['有孩子问龙舟为什么要有鼓', '有孩子说想自己做一条会浮的龙舟', '记不清了，我翻翻记录再补'],
      },
    ],
    artifacts: [],
    closure_loop: null,
    state_delta: { teacher_mode: 'optimize_existing', completed_nodes: ['WF01', 'WF02'] },
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('optimize_existing', 0, [
      { id: 'WF01', name: '入口识别', apply: '首条消息判定为已有主题优化模式' },
      { id: 'WF02', name: '信息补全', apply: '一个聚焦问题摸清已有家底，不开表单' },
    ], ['状态机优先', '教师资源意图优先'], '写入 teacher_mode=optimize_existing；先补档再优化'),
  };
}

function turnOptimizeBackfill() {
  return {
    reply_markdown:
      '明白。主题网络是现成的资产，我按「已有主题回填」把它接进课程档案——原始主题、教师意图、适配判断都补上了，下面两张卡你确认方向就行。\n\n接下来是关键一步：**兴趣散，不能靠成人猜原因**。要收紧方向，我需要孩子的真实反应做依据——没有证据，任何优化都只是换一版成人方案。',
    question: {
      text: '这两周里，孩子说过哪几句让你印象深的话？两三句原话就够。',
      why: '证据优先——先有儿童真实反应，才能收紧核心驱动问题和目标',
      examples: ['有孩子问龙舟为什么要有鼓', '有孩子说想自己做一条会浮的龙舟', '孩子们围着龙头看了很久，说像狮子头'],
    },
    artifacts: [
      {
        type: 'entry_card',
        title: '资源课程化切口卡 · 龙舟（已有主题回填）',
        data: {
          original_theme: '龙舟（开展两周，回填建档）',
          initial_goal: '把已开展两周的主题从活动堆里理出探究主线',
          child_entry_points: ['龙舟的鼓与号子', '船体与桨的构造', '划龙舟的人'],
          perceivable_content: ['鼓点节奏', '船头龙眼与彩绘', '桨叶入水的动作'],
          deepening_directions: ['龙舟怎么才能浮而不翻', '为什么要一起划', '孩子能不能造一条自己的小龙舟'],
          first_experience: '已开展两周——本轮不新增体验，先回收儿童真实反应',
          adult_phrasings_to_avoid: ['传统文化瑰宝', '非遗传承'],
        },
      },
      {
        type: 'fit_screening',
        title: '主题适配性筛查（回填）',
        data: {
          judgment: 'theme_inquiry',
          judgment_zh: '主题探究型（已有活动基础，探究主线待儿童证据收紧）',
          reasons: ['有真实场域与两周活动经验', '可感知层次丰富（声音/构造/动作）', '兴趣散的原因未知——待儿童证据判断'],
          suggested_intensity: '先回收一轮儿童原话，再决定收口方向',
        },
      },
    ],
    closure_loop: {
      do_now: '翻一翻这两周的活动记录，把孩子的原话挑两三句出来',
      materials: '不用新材料——手机备忘录或便签记录原话即可',
      bring_back: '两三句儿童原话，注明是谁、在什么情境说的',
      i_will: '我会把原话整理成儿童问题池，并给出收紧后的核心驱动问题候选',
    },
    state_delta: {
      theme_resource: { name: '龙舟' },
      teacher_resource_intent: {
        why_this_resource: '主题已开展两周，想优化而不是推倒重来',
        current_status: '有主题网络，孩子兴趣散',
        confidence: 'teacher_stated',
      },
      resource_entry_card: {
        original_theme: '龙舟',
        backfilled: '已有主题回填',
        initial_goal: '从活动堆里理出探究主线',
        child_entry_points: ['鼓与号子', '船体与桨', '划龙舟的人'],
        first_experience: '已有两周活动经验',
      },
      theme_fit_level: 'theme_inquiry',
      completed_nodes: ['WF02b', 'WF03b', 'WF04'],
      stage: 1,
    },
    evidence_refs: [],
    round_complete: true,
    wf_trace: trace('optimize_existing', 0, [
      { id: 'WF02b', name: '主题探究适配性筛查', apply: '回填判定：主题探究型，收口方向待证据' },
      { id: 'WF03b', name: '资源意图确认与课程可能性启发', apply: '已有主题回填成切口卡，不推倒重来' },
      { id: 'WF04', name: '主题预设网络图（教师备课用）', apply: '现成的主题网络作为预备资产接入档案' },
    ], ['状态机优先', '证据优先', '教师资源意图优先'], '回填 resource_entry_card 与 theme_fit_level；stage 提议 0→1（回填后门槛满足）'),
  };
}

function turnOptimizeEvidence() {
  return {
    reply_markdown:
      '三句原话质量都很高——特别是「想自己做一条会浮的龙舟」，里面已经藏着行动性和公共性。\n\n「兴趣散」的判断可以修正了：从证据看，孩子的注意力不是散，而是集中在「船怎么浮、怎么动」这类构造问题上，只是原来的主题网络没有接住它。\n\n下面是整理后的儿童问题池和收紧的核心驱动问题候选。等孩子选定问题，目标与评估轴心就可以进入下一轮。',
    question: null,
    artifacts: [
      {
        type: 'question_pool',
        title: '儿童问题池（两周活动回收）',
        data: {
          promising: [
            { question: '龙舟为什么要有鼓？', category: 'why', evidence: 'ev-lz-1', cultural_hint_backstage: '鼓是划手的共同节拍——可能的生活经验入口：请一位划过龙舟的家长带孩子听真实鼓点。' },
            { question: '我们能自己做一条会浮的龙舟吗？', category: 'can_we', evidence: 'ev-lz-2', cultural_hint_backstage: '造物是参与的起点。儿童小任务：用不同材料放进水盆试沉浮。' },
            { question: '龙头为什么像狮子头？', category: 'why', evidence: 'ev-lz-3', cultural_hint_backstage: '本地龙头样式各村有差异（待现场确认）——儿童小任务：对比两张不同龙头的照片找不同。' },
          ],
          excluded: [{ question: '龙舟比赛有什么意义？', reason: '无儿童证据——成人化问题，剔除' }],
        },
      },
      {
        type: 'driving_questions',
        title: '收紧后的候选核心驱动问题',
        data: {
          candidates: [
            { text: '我们怎样做一条放进水里不会翻的小龙舟？', recommended: true, why: '直接来自孩子原话，行动性强、结果可检验' },
            { text: '我们怎样让全班的桨跟着鼓点一起动起来？', recommended: false, why: '指向合作与节奏，需要更多现场验证' },
          ],
          note: '两个都从孩子的真实问题收紧而来；选哪个，听你和孩子的',
        },
      },
    ],
    closure_loop: {
      do_now: '把问题池贴回问题墙，和孩子聊聊两个候选问题哪个更想做',
      materials: '问题墙卡片模板（下轮可以生成打印版）',
      bring_back: '孩子选了哪个问题、为什么；顺手带一件这两周的孩子作品或照片',
      i_will: '根据孩子的选择梳理目标与评估轴心——先定核心理解目标，再对四维展开',
    },
    state_delta: {
      children_evidence: [
        { id: 'ev-lz-1', kind: 'child_words', content: '龙舟为什么要有鼓？', child_ref: '男孩A', round: 1, recorded_at: 'backfill' },
        { id: 'ev-lz-2', kind: 'child_words', content: '想自己做一条会浮的龙舟', child_ref: '女孩B', round: 1, recorded_at: 'backfill' },
        { id: 'ev-lz-3', kind: 'child_words', content: '龙头看起来像狮子头', child_ref: '男孩C', round: 1, recorded_at: 'backfill' },
      ],
      child_question_pool: [
        { question: '龙舟为什么要有鼓？', category: 'why', evidence_refs: ['ev-lz-1'], potential: 'promising' },
        { question: '我们能自己做一条会浮的龙舟吗？', category: 'can_we', evidence_refs: ['ev-lz-2'], potential: 'promising' },
        { question: '龙头为什么像狮子头？', category: 'why', evidence_refs: ['ev-lz-3'], potential: 'promising' },
      ],
      driving_question: {
        candidates: ['我们怎样做一条放进水里不会翻的小龙舟？', '我们怎样让全班的桨跟着鼓点一起动起来？'],
      },
      child_learning_stage: 'question_generation',
      completed_nodes: ['WF06', 'WF07', 'WF07b', 'WF08'],
      stage: 2,
    },
    evidence_refs: ['ev-lz-1', 'ev-lz-2', 'ev-lz-3'],
    round_complete: true,
    wf_trace: trace('optimize_existing', 1, [
      { id: 'WF06', name: '发掘幼儿已有相关知识', apply: '两周活动里的儿童原话入证据账本' },
      { id: 'WF07', name: '儿童问题池整理', apply: '原话整理入池，「兴趣散」被证据修正' },
      { id: 'WF07b', name: '儿童问题背后的文化可能性提示', apply: '每个问题附后台文化线索（不讲给孩子）' },
      { id: 'WF08b', name: '核心驱动问题推导（阶段2边界）', apply: '从真实问题收紧出两个候选' },
    ], ['证据优先', '儿童真实反应驱动调整', '文化可能性后台提示'], '写入 children_evidence 与 driving_question 候选；stage 提议 1→2（证据与候选同轮入账）'),
  };
}

// ================================================== 课程故事整理 story_export

function storyFlow(state, history, message) {
  if (!state.story_materials) {
    // Batch fast path: entry cards answered together (材料底子 AND 原话) —
    // materials inventory and narrative spine land in one turn.
    if (hasChildWords(message)) return turnStoryMaterialsWithSpine();
    return turnStoryMaterials();
  }
  if (state.stage < 5) {
    // The spine needs real 原话 — a nudge or 记不全 answer must not fabricate.
    if (/说|「|原话/.test(answersOnly(message))) return turnStorySpine();
    if (priorTurnsMatching(history, STORY_WAIT_MARKER) >= MAX_NUDGES) return turnStorySpine();
    return turnStoryWait(history);
  }
  const delivered = (state.completed_nodes || []).includes('WF30');
  if (delivered && /顺序|换.*原话|换章眼|调整/.test(message)) return turnStoryAdjust(state, history);
  if (!delivered) {
    if (!(state.story_materials || {}).export_version) return turnStoryVersion(state, message);
    return turnStoryExpand(state); // whatever comes next, deliver what was promised
  }
  return turnHorizon('story_export', state, history, message);
}

function turnStoryEntry() {
  return {
    reply_markdown:
      '好，我们把这堆照片整理成一个立得住的课程故事。第一步不是动笔，而是盘点材料——有什么、缺什么，缺的部分如实标注，不虚构。\n\n下面两张卡把材料底子带给我：原话也答得上的话，盘点和叙事主线我一轮就能出。',
    question: {
      text: '这堆照片主要拍的是什么？',
      why: '材料完整性检查是课程故事的第一步，主线要从真实材料里长出来',
      examples: ['主要是活动过程照片', '有孩子的作品和涂鸦', '还有几段采访视频'],
    },
    questions: [
      {
        id: 'q-materials',
        text: '这堆照片主要拍的是什么？',
        why: '材料完整性检查是课程故事的第一步，主线要从真实材料里长出来',
        examples: ['主要是活动过程照片', '有孩子的作品和涂鸦', '还有几段采访视频'],
      },
      {
        id: 'q-words',
        text: '你还记得孩子当时说过哪几句话吗？',
        why: '故事的主线要用孩子的声音立起来——记不全先跳过，回头补也行',
        examples: ['有孩子说：这是我们一起做出来的', '有孩子说：下次我还想再做一遍', '记不全了，我回去问问搭班老师和家长'],
      },
    ],
    artifacts: [],
    closure_loop: null,
    state_delta: { teacher_mode: 'story_export', completed_nodes: ['WF01'] },
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('story_export', 0, [
      { id: 'WF01', name: '入口识别', apply: '首条消息判定为课程故事整理模式' },
      { id: 'WF28', name: '材料完整性检查', apply: '下一轮按材料清单盘点缺口，先问不猜' },
    ], ['状态机优先', '证据优先'], '写入 teacher_mode=story_export；stage 保持0，材料没盘点前不跳导出'),
  };
}

function turnStoryMaterials() {
  return {
    reply_markdown:
      '按材料完整性检查过了一遍，现在的账是这样：\n\n**已有**：活动过程照片、孩子的作品和涂鸦、采访视频片段——都已记入证据账本。\n\n**缺**：儿童原话记录、卡点与转折的记录、教师反思。\n\n缺的部分我不会替你编。三样缺口里，儿童原话最要紧——课程故事的主线要用孩子的声音立起来，不能全是成人视角。',
    question: {
      text: '你还记得孩子当时说过哪几句话吗？给我两三句原话就够。',
      why: '没有儿童原话，故事只剩成人叙述——先补最要紧的缺口',
      examples: ['有孩子说：这是我们一起做出来的', '有孩子说：下次我还想再做一遍', '记不全了，我回去问问搭班老师和家长'],
    },
    artifacts: [],
    closure_loop: {
      do_now: '回忆并记下两三句孩子原话，问问搭班老师和家长也可以',
      materials: '缺口清单（本轮已列出：儿童原话、卡点记录、教师反思）',
      bring_back: '两三句儿童原话，能注明是谁、在什么情境说的更好',
      i_will: '拿到原话我就提炼叙事主线，用孩子的声音立起章节骨架',
    },
    state_delta: {
      story_materials: {
        available: ['活动过程照片', '孩子作品与涂鸦', '采访视频片段'],
        gaps: ['儿童原话记录', '卡点与转折记录', '教师反思'],
        narrative_spine: null,
      },
      children_evidence: [
        { id: 'ev-st-photo-1', kind: 'photo', content: '活动过程照片一批：孩子们分组动手制作', round: 1, recorded_at: 'backfill' },
        { id: 'ev-st-work-1', kind: 'work', content: '孩子作品与涂鸦一批：主题相关的画和手工', round: 1, recorded_at: 'backfill' },
        { id: 'ev-st-video-1', kind: 'video', content: '采访视频片段：孩子对着镜头介绍自己做的东西', round: 1, recorded_at: 'backfill' },
      ],
      completed_nodes: ['WF28'],
    },
    evidence_refs: ['ev-st-photo-1', 'ev-st-work-1', 'ev-st-video-1'],
    round_complete: true,
    wf_trace: trace('story_export', 0, [
      { id: 'WF28', name: '材料完整性检查', apply: '照片、作品、视频入账，三项缺口如实列出' },
    ], ['证据优先', '输出闭环固定'], '写入 story_materials 与三条材料证据；stage 保持0——原话没到，不跳导出'),
  };
}

/** Batch fast path: 材料盘点 + 叙事主线 in one turn (entry cards answered together). */
function turnStoryMaterialsWithSpine() {
  return mergeTurns(turnStoryMaterials(), turnStorySpine(), {
    reply:
      '材料底子和原话一次到齐——盘点和主线我并成一轮做完。\n\n**材料的账**：照片、作品、采访视频都已记入证据账本；缺口还剩卡点与转折记录、教师反思，我在卡片里如实标注，不填空话。\n\n**叙事主线**：孩子的声音够立骨架了。下面这版主线只用了有证据的部分，「这是我们一起做出来的」做章眼，「下次我还想再做一遍」收尾。',
    stage: 5, // 0→5 is the one legal long jump (导出), and the evidence ledger is non-empty
    note: '批量作答快车道：材料证据 + 儿童原话 + 叙事主线同轮入账；stage 提议 0→5（证据账本非空，导出跳转合法）；缺口如实保留',
  });
}

function turnStorySpine() {
  return {
    reply_markdown:
      '原话到位，主线立得起来了。下面这版叙事主线只用了有证据的部分；目标与评估对照那一块还有缺口，我在卡片里如实标注，不填空话。',
    question: {
      text: '导出想先做哪个版本？',
      why: '不同读者需要不同的详略和口吻，一次做一版',
      examples: ['完整案例版', '汇报摘要版', '公众号版'],
    },
    artifacts: [
      {
        type: 'story_fragment',
        title: '课程故事叙事主线（草稿）',
        data: {
          origin: '起点不是教案，而是一批真实的过程照片——孩子们分组动手做东西的样子先于任何文字记录。',
          chapters: [
            { chapter: '一、我们动手做', content: '过程照片里孩子分组制作的场景开场', evidence: 'ev-st-photo-1' },
            { chapter: '二、这是我们一起做出来的', content: '以这句原话为章眼，配孩子作品与涂鸦', evidence: 'ev-st-words-1' },
            { chapter: '三、对着镜头说', content: '采访视频片段：孩子自己介绍自己的作品', evidence: 'ev-st-video-1' },
            { chapter: '四、下次我还想再做一遍', content: '以这句原话收尾，指向下一轮课程的种子', evidence: 'ev-st-words-2' },
          ],
          gaps: ['目标与评估对照：当时的目标记录缺失，建议补一段教师回忆', '卡点与转折记录仍空缺——有就补，没有就在文中如实说明'],
        },
      },
    ],
    closure_loop: null,
    state_delta: {
      children_evidence: [
        { id: 'ev-st-words-1', kind: 'child_words', content: '这是我们一起做出来的', round: 1, recorded_at: 'backfill' },
        { id: 'ev-st-words-2', kind: 'child_words', content: '下次我还想再做一遍', round: 1, recorded_at: 'backfill' },
      ],
      story_materials: {
        available: ['活动过程照片', '孩子作品与涂鸦', '采访视频片段', '儿童原话两句'],
        gaps: ['卡点与转折记录', '教师反思', '目标与评估对照'],
        narrative_spine: '从动手做到自己讲——用两句儿童原话立起首尾',
      },
      completed_nodes: ['WF29', 'WF31'],
      stage: 5,
    },
    evidence_refs: ['ev-st-words-1', 'ev-st-words-2'],
    round_complete: false,
    wf_trace: trace('story_export', 0, [
      { id: 'WF29', name: '叙事主线提炼', apply: '四章骨架，每章都锚定一条证据' },
      { id: 'WF31', name: '目标与评估对照', apply: '对照存在缺口，已如实标注不虚构' },
      { id: 'WF30', name: '图文结构生成', apply: '等版本确认后再排图文结构' },
    ], ['证据优先', '状态机优先'], 'stage 提议 0→5（证据账本非空，跳转到导出合法）；缺口保留在 story_materials'),
  };
}

// ==================================================== 过程中续聊 mid_course

function midCourseFlow(state, history, message) {
  if (!(state.children_evidence || []).length) {
    const m = answersOnly(message);
    if (/卡|试|做|说|问|指挥|活跃/.test(m) && m.length > 15) return turnMidCourseReview();
    if (priorTurnsMatching(history, MIDCOURSE_WAIT_MARKER) >= MAX_NUDGES) return turnMidCourseReview();
    return turnMidCourseWait(history);
  }
  if ((state.cycle_history || []).length < 2) {
    if (hasFieldFeedback(message)) return turnMidCourseSecond();
    if (priorTurnsMatching(history, MIDCOURSE_HOLD_MARKER) >= MAX_NUDGES) return turnMidCourseSecond();
    return turnMidCourseHold(history);
  }
  return turnHorizon('mid_course', state, history, message);
}

function turnMidCourseEntry() {
  // 三句聚焦反馈 as three question cards — the spec's three-sentence intake IS
  // a natural multi-question turn; the teacher answers all at once and the
  // packaged reply lets the next turn light several nodes together.
  const whatCard = {
    id: 'q-what',
    text: '孩子们做了什么？',
    why: '有一句现场信息，卡壳复盘就能开工',
    examples: ['孩子们试了纸箱做狮头，卡在固定不住', '分组画了龙舟，有两组一直在争谁画龙头'],
  };
  const whoCard = {
    id: 'q-who',
    text: '谁的表现最让你在意？',
    why: '差异观察是下一轮分组和支架的依据',
    examples: ['最活跃的是小宇，一直在指挥别人', '有两个孩子全程只看不动手'],
  };
  const judgeCard = {
    id: 'q-judge',
    text: '你现在最想判断什么？',
    why: '这轮我优先回答你最急的判断',
    examples: ['下一轮该分组还是集体', '要不要把家长资源引进来'],
  };
  return {
    reply_markdown:
      '收到。按流程我会先读你的课程档案再接话——但这个演示会话里档案是空的，真实使用中不会让你重复回忆已经记录过的东西。这里先快速补档：下面三张卡把昨天的现场带给我就够，答不全也没关系。',
    question: whatCard,
    questions: [whatCard, whoCard, judgeCard],
    artifacts: [],
    closure_loop: null,
    state_delta: { teacher_mode: 'mid_course', completed_nodes: ['WF01'] },
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('mid_course', 0, [
      { id: 'WF01', name: '入口识别', apply: '首条消息判定为过程中续聊模式' },
    ], ['状态机优先'], '档案为空，先补档——0→3 跳转非法，这轮如实停在阶段0建档'),
  };
}

function turnMidCourseReview() {
  return {
    reply_markdown:
      '先回答你第三句里要判断的事：**这一轮建议分组**。理由就在你带来的现场里——「固定不住」是个真卡点，分组各试一种固定办法，能让更多孩子的手动起来，而不是集体等一个答案。\n\n关于小宇：他在指挥别人，这不一定是问题——可能是组织力的萌芽，也可能挤占了同伴的尝试机会，建议下一轮重点观察他在小组里的角色变化，先不打断。\n\n从这两条证据看，孩子们可能正走到尝试探究阶段（待现场确认）：已经从「想做」进到「做了但卡住」，这正是复盘的好时机。下面是下一轮的循环任务卡。',
    question: null,
    artifacts: [
      {
        type: 'cycle_task',
        title: '协作行动 · 下一轮：狮头怎么才能稳稳待住？',
        data: {
          child_question: '把问题抛回给孩子：「狮头总是固定不住，我们有什么办法让它稳稳待在头上？」',
          flow: ['分组各试一种固定办法（宽胶带/麻绳/卡槽）', '每组展示自己最稳的一种', '互相试戴检验，记下会掉的时刻', '把最好用的办法画下来贴上问题墙'],
          materials: '纸箱、宽胶带、麻绳、晾衣夹，每组一筐',
          observation_focus: ['谁提出了新固定办法', '小宇在小组里的角色有没有变化', '卡住时孩子先找老师还是先互相商量'],
          teacher_role: '不给标准答案；小宇的指挥先观察不打断，看小组机制会不会自然分流',
        },
      },
    ],
    closure_loop: {
      do_now: '把固定问题抛回给孩子，分组各试一种办法',
      materials: '固定材料筐（宽胶带、麻绳、晾衣夹），每组一筐',
      bring_back: '每组的办法和一句原话；小宇这轮做了什么；有没有组自己解决了卡点',
      i_will: '我会根据各组结果判断项目化信号，并给出下一轮循环建议',
    },
    state_delta: {
      children_evidence: [
        { id: 'ev-mc-1', kind: 'behavior', content: '孩子们用纸箱试做狮头，卡在狮头固定不住', round: 1, recorded_at: 'teacher_recall' },
        { id: 'ev-mc-2', kind: 'behavior', content: '小宇全程最活跃，主要在指挥其他孩子操作', child_ref: '小宇', round: 1, recorded_at: 'teacher_recall' },
      ],
      child_participation_difference: [
        { round: 1, profile: 'director', child_ref: '小宇', observation: '偏好指挥而非动手，需观察是否挤占同伴的尝试机会' },
      ],
      teacher_focus_feedback: [
        { round: 1, what_happened: '纸箱狮头固定不住', who_stood_out: '小宇（指挥型参与）', to_judge: '下一轮分组还是集体' },
      ],
      cycle_history: [
        { round: 1, phase: 'stuck_review', sub_question: '狮头怎么才能稳稳待住？', agent_judgment: '分组尝试' },
      ],
      child_learning_stage: 'trial_inquiry',
      completed_nodes: ['WF20', 'WF20b', 'WF20d', 'WF21'],
    },
    evidence_refs: ['ev-mc-1', 'ev-mc-2'],
    round_complete: true,
    wf_trace: trace('mid_course', 0, [
      { id: 'WF20', name: '卡壳复盘', apply: '「固定不住」定性为真卡点，转成下一轮探究' },
      { id: 'WF20b', name: '儿童学习阶段识别', apply: '按证据推测尝试探究阶段（留待现场确认）' },
      { id: 'WF20d', name: '儿童差异观察与教师聚焦反馈', apply: '小宇的指挥型参与入差异记录；教师三句反馈入账' },
      { id: 'WF21', name: '下一轮循环与项目化信号提醒', apply: '先答教师要判断的问题（分组），再给循环任务卡' },
    ], ['证据优先', '儿童真实反应驱动调整', '状态机优先'], '证据与聚焦反馈已入账；stage 保持0——真实使用会带完整档案，0→3 跳转非法，演示中如实不跳'),
  };
}

// ================================================= 素材支持 material_support

function materialFlow(state, history, message) {
  const n = (history || []).filter((m) => m && m.role === 'assistant' && /定稿要点|可选加项|随时把两三件/.test(String(m.content || ''))).length;
  if (n === 0) return turnMaterialDeliver(state);
  if (n === 1) return turnMaterialVariantB(state);
  if (n === 2) return turnMaterialVariantC(state);
  return turnHorizon('material_support', state, history, message);
}

function turnMaterialEntry(message) {
  const resource = detectResource(message);
  return {
    reply_markdown:
      `素材支持可以直接出，不需要先建完整的课程档案。先给你一版「${resource}亲子调查表」的文字底稿（图文排版稍后再说，先把内容定住）：\n\n**${resource}亲子调查表（文字版）**\n1. 和爸爸妈妈一起去的时候，找到一样你最想再看一次的东西，把它画下来。\n2. 问一位摊主或师傅：这样东西是从哪里来的。记住一个答案，回来讲给大家听。\n3. 你在那里听到了什么声音，回来学给小朋友听。\n\n**使用建议**：孩子口述、家长代笔或孩子自己画都可以，不要求写长文字；回收后把孩子带回的问题贴上问题墙。\n\n再给你一条后台文化线索（不用讲给孩子）：${resource}的时间与地点规律本身就是本地生活的节奏，如果有孩子追问「为什么是今天、为什么在这里」，那就是一个很好的课程入口。`,
    question: {
      text: '这份素材打算用在什么场景？',
      why: '场景不同，问题的口吻和数量会不一样',
      examples: ['给家长的调查表', '布置墙面的问题墙', '采访附近店主的提纲'],
    },
    questions: [
      {
        id: 'q-scene',
        text: '这份素材打算用在什么场景？',
        why: '场景不同，问题的口吻和数量会不一样',
        examples: ['给家长的调查表', '布置墙面的问题墙', '采访附近店主的提纲'],
      },
      {
        id: 'q-band',
        text: '打算给哪个年段的孩子用？',
        why: '年段决定问题的数量和口吻——小班要更短更具体',
        examples: ['小班', '中班', '大班'],
      },
    ],
    artifacts: [],
    closure_loop: null,
    state_delta: { teacher_mode: 'material_support', theme_resource: { name: resource }, completed_nodes: ['WF01', 'WF22'] },
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('material_support', 0, [
      { id: 'WF01', name: '入口识别', apply: '首条消息判定为素材支持模式' },
      { id: 'WF22', name: '素材与资源支持', apply: '文字底稿直接给出，AI 绘图已延后到文字版之后' },
    ], ['状态机优先', '文化可能性后台提示'], '写入 teacher_mode=material_support；素材支持不改动课程阶段'),
  };
}

function turnMaterialDeliver(state) {
  return {
    reply_markdown:
      '好，按这个场景我把底稿再收一收：\n\n**定稿要点**\n- 问题保持三个以内，孩子记得住；\n- 每个问题都带一个「回来之后做什么」（画下来、讲给大家听、学给小朋友听），素材才会回流到班级里；\n- 表头留一行给孩子写名字或画自己的记号。\n\n需要改口吻、换问题，或者加一版店主访谈提纲，直接说就行。',
    question: null,
    artifacts: [],
    closure_loop: {
      do_now: '把调查表誊抄或打印发给家长，赶最近一次外出就能用',
      materials: '亲子调查表文字版（本轮已给出，可直接使用）',
      bring_back: '孩子带回的画、原话和问题，挑两三件给我看看',
      i_will: '把孩子带回的问题整理进儿童问题池——如果你愿意，这份素材可以长成一个课程入口',
    },
    state_delta: { completed_nodes: ['WF22'] },
    evidence_refs: [],
    round_complete: true,
    wf_trace: trace('material_support', state.stage ?? 0, [
      { id: 'WF22', name: '素材与资源支持', apply: '按教师选定的场景定稿文字素材' },
      { id: 'WF07', name: '儿童问题池整理', apply: '预备：孩子带回的问题可入儿童问题池' },
    ], ['文化可能性后台提示', '输出闭环固定'], '素材支持不写课程阶段；输出闭环固定照常收尾'),
  };
}

// ===================================== awaiting-phase turns (等待期不装死)
// Function declarations hoist, so these can live after the flows that call
// them. Every turn here carries a wf_trace whose state_notes explains an
// empty delta — the state machine must never LOOK dead in the debug drawer.

/** Map an awaiting-phase message onto one of the entry-card choices (WF03b). */
function matchEntryChoice(message) {
  const explicit = /入口|拿不准|按你推荐|你推荐|推荐的来/.test(message);
  const shortHint = message.length <= 15 && /狮头|面具|声音|鼓/.test(message);
  if (!explicit && !shortHint) return null;
  if (/狮头|面具/.test(message)) return '狮头入口';
  if (/声音|鼓/.test(message)) return '声音入口';
  if (/师傅|醒狮队|里面的人/.test(message)) return '真实人物入口';
  return '推荐入口';
}

/** Entry-specific adaptation of the first experience (WF09 战术性环境支持). */
const ENTRY_ADAPT = {
  '狮头入口': {
    chosen: '狮头入口',
    ack: '好，就从狮头入口进——面具类的东西孩子能直接看、摸、掂，这个入口很扎实。第一轮体验安排不变（还是去看真实训练），观察重点按狮头调整：',
    focus: ['孩子最先凑近狮头的哪个部位', '有没有人想摸、想掂重量、想戴', '孩子对眼睛机关说了什么（记原话）'],
    tail: '访谈卡建议让孩子优先问狮头的问题：眼睛为什么会眨、毛是什么做的、狮头重不重。',
  },
  '声音入口': {
    chosen: '声音入口',
    ack: '好，就从声音入口进——鼓点是全场都能参与的入口，门槛最低。第一轮体验安排不变（还是去看真实训练），观察重点按声音调整：',
    focus: ['听到鼓声孩子是捂耳朵还是凑近', '谁开始跟着拍、跺脚、点头', '孩子问了什么关于声音的问题（记原话）'],
    tail: '访谈卡建议让孩子优先问鼓的问题：鼓为什么有快有慢、打错了狮子会怎么样。',
  },
  '真实人物入口': {
    chosen: '真实人物入口',
    ack: '好，就从「醒狮队的人」这个入口进——真实人物最能引出真问题。第一轮体验安排不变（还是去看真实训练），观察重点按人调整：',
    focus: ['孩子盯着谁看得最久', '孩子敢不敢靠近、敢不敢开口问', '孩子对师傅说了什么（记原话）'],
    tail: '访谈卡整卡可用，建议孩子先问「你在狮子里面看得见路吗」。',
  },
  '推荐入口': {
    chosen: '声音入口（按推荐）',
    ack: '拿不准很正常，那按我的推荐先走声音入口——门槛最低、全场都能参与，现场再看孩子的反应换挡。观察重点：',
    focus: ['听到鼓声孩子是捂耳朵还是凑近', '谁开始跟着拍、跺脚、点头', '停留最久的点在哪里'],
    tail: '访谈卡先带着备用；如果孩子被狮头吸走了，就顺势换入口——跟着孩子走。',
  },
};

/** WF03b confirmation: the chosen entry is acknowledged AND written to state. */
function turnEntryChoice(state, choice) {
  const adapt = ENTRY_ADAPT[choice];
  return {
    reply_markdown:
      `${adapt.ack}\n\n- ${adapt.focus.join('\n- ')}\n\n${adapt.tail}\n\n这个选择我已经记进切口卡。其他安排不变——等你从现场回来。`,
    question: null,
    artifacts: [],
    closure_loop: null,
    state_delta: {
      resource_entry_card: { ...(state.resource_entry_card || {}), chosen_entry: adapt.chosen, entry_observation_focus: adapt.focus },
      completed_nodes: ['WF09'],
    },
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('from_zero', state.stage ?? 1, [
      { id: 'WF03b', name: '资源意图确认与课程可能性启发', apply: `教师选定儿童入口：${adapt.chosen}` },
      { id: 'WF09', name: '阶段一回传与动态调整', apply: '按所选入口调整观察重点与访谈优先级' },
    ], ['教师资源意图优先'], `写入 resource_entry_card.chosen_entry=${adapt.chosen}；其余照旧等待现场回传`),
  };
}

/** WF22 就地支持 while the round is out in the field — no fabricated progress. */
function turnInPlaceSupport() {
  return {
    reply_markdown:
      '就地支持，马上给——这些不需要等现场。\n\n**给家长的知会话术（可直接发班级群）**\n「本周我们计划带孩子去看一次醒狮队的日常训练（不是表演）。孩子只观察、不上场，全程有老师看护；对声音敏感的孩子可以捂耳朵或站远一点。回来后我们会请孩子画下看到的东西。」\n\n**访谈卡使用说明**\n- 出发前把「孩子可以问」的三个问题念给孩子听一遍就好，不要求背；\n- 现场谁想问谁问，问不出也不勉强——把没问出口的问题带回问题墙。\n\n课堂进展我不催也不编，等你带回孩子的真实反应。',
    question: null,
    artifacts: [],
    closure_loop: null,
    state_delta: { completed_nodes: ['WF22'] },
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('from_zero', 1, [
      { id: 'WF22', name: '素材与资源支持', apply: '等待期就地支持：家长知会话术＋访谈卡使用说明' },
    ], ['输出闭环固定', '教师资源意图优先'], '本轮仅追加 WF22 节点记录，无课程状态写入（等待现场回传，就地支持）'),
  };
}

const NUDGE_MARKER = /把进度摊开|我还在这里/;
const OPTIMIZE_WAIT_MARKER = /先把档案的账摊开|行为线索入手/;
const STORY_WAIT_MARKER = /想不全很正常|视频里往往就有/;
const MIDCOURSE_WAIT_MARKER = /三句话随时补|先回我一句/;
const CYCLE_NUDGE_MARKER = /排练试起来|一小步一小步/;
const MIDCOURSE_HOLD_MARKER = /各组的结果|先发一个卡点/;

/** Status-report nudge: never repeats verbatim, never plays dead. */
function turnAwaitNudge(history) {
  const v = replyVariant(history, NUDGE_MARKER, 2);
  const reply = v === 0
    ? '不急，我先把进度摊开给你看。\n\n**已完成**：入口识别、资源课程化切口卡、适配性筛查、第一轮体验计划、访谈卡。\n**等你带回**：孩子的两三句原话、停留最久的点、几张照片。\n\n等待期间我也能就地帮忙：比如一段给家长的知会话术，或者把访谈卡改成孩子能看的图文版说明。说一声就给。'
    : '我还在这里，随时接得住。如果是卡在准备环节——比如还没约到醒狮队、家长有顾虑、想先在班里做点铺垫——直接说，我出预案。如果已经去过现场了，哪怕只记得一句孩子的原话，也先发我这一句。';
  return {
    reply_markdown: reply,
    question: {
      text: '现场回来后，最先想告诉我的一句是什么？',
      why: '一句孩子的原话或一个现场片段，就够我接住下一步',
      examples: [
        '孩子们围着狮头看了很久，有人问「眼睛为什么会眨」',
        '还没去成，想先要一段给家长的知会话术',
      ],
    },
    artifacts: [],
    closure_loop: null,
    state_delta: {},
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('from_zero', 1, [
      { id: 'WF05', name: '建立共同经验（真实体验活动）', apply: v === 0 ? '状态机进度汇报＋两个就地支持选项' : '换一种问法接住教师，不重复上一轮' },
    ], ['状态机优先', '输出闭环固定'], '本轮无状态写入（等待现场回传，就地支持）'),
  };
}

/** optimize_existing wait: evidence-first, no fabricated 原话. */
function turnOptimizeWait(history) {
  const v = replyVariant(history, OPTIMIZE_WAIT_MARKER, 2);
  const reply = v === 0
    ? '不急，先把档案的账摊开：切口卡（已有主题回填）和适配性筛查都已入档，现在缺的只有一样——孩子的两三句原话。翻活动记录、问搭班老师、看活动照片旁的备注都可以。等待期间想先要问题墙卡片模板的文字稿，说一声就给。'
    : '我还在这里。原话一时找不齐的话，也可以从行为线索入手：告诉我这两周孩子最常聚在哪个角落、反复摆弄什么材料，我们先用行为证据把方向粗对一下，原话之后再补。';
  return {
    reply_markdown: reply,
    question: {
      text: '翻记录时找到的第一句孩子原话是什么？',
      why: '有一两句原话，优化方向就能从证据里长出来',
      examples: [
        '有孩子问龙舟为什么要有鼓，还有孩子说想自己做一条',
        '照片备注里记了一句「我们的龙舟会浮吗」',
      ],
    },
    artifacts: [],
    closure_loop: null,
    state_delta: {},
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('optimize_existing', 1, [
      { id: 'WF06', name: '发掘幼儿已有相关知识', apply: '等待儿童原话回收，不虚构证据' },
    ], ['证据优先', '状态机优先'], '本轮无状态写入（等待儿童原话回传，就地支持）'),
  };
}

/** story_export wait: gaps stay honest, point to where 原话 can be found. */
function turnStoryWait(history) {
  const v = replyVariant(history, STORY_WAIT_MARKER, 2);
  const reply = v === 0
    ? '想不全很正常，不用硬凑。已入账的材料不会丢：过程照片、作品涂鸦、采访视频，缺口清单也都在。原话可以慢慢找——问搭班老师、问家长，或者翻一翻采访视频，孩子对着镜头讲的话就是最好的原话。'
    : '再给你一条捷径：采访视频里往往就有现成的原话。挑一段视频听一遍，把孩子讲的一两句敲给我就行——有这一两句，叙事主线就能立起来。';
  return {
    reply_markdown: reply,
    question: {
      text: '视频或记录里，孩子讲过的哪一句最打动你？',
      why: '有一两句原话，叙事主线就能立起来',
      examples: [
        '有孩子说这是我们一起做出来的',
        '视频里有孩子讲「下次还想再做一遍」',
      ],
    },
    artifacts: [],
    closure_loop: null,
    state_delta: {},
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('story_export', 0, [
      { id: 'WF28', name: '材料完整性检查', apply: '缺口保持如实——不虚构原话，指路去找' },
    ], ['证据优先', '状态机优先'], '本轮无状态写入（等待儿童原话回传，就地支持）'),
  };
}

/** mid_course wait: the 三句聚焦反馈 can arrive one sentence at a time. */
function turnMidCourseWait(history) {
  const v = replyVariant(history, MIDCOURSE_WAIT_MARKER, 2);
  const reply = v === 0
    ? '不着急，三句话随时补，不用一次说全：孩子们做了什么、谁的表现最让你在意、你现在最想判断什么。哪怕只发第一句，我也能先接住。'
    : '我还在这里。现场太忙的话，先回我一句就行：昨天具体卡在哪一步？有了这一句，卡壳复盘就能开工。';
  return {
    reply_markdown: reply,
    question: {
      text: '三句里先补哪一句都行——孩子们做了什么？',
      why: '有一句现场信息，卡壳复盘就能开工',
      examples: [
        '孩子们试了纸箱做狮头，卡在固定不住',
        '最活跃的是小宇，一直在指挥别人不动手',
      ],
    },
    artifacts: [],
    closure_loop: null,
    state_delta: {},
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('mid_course', 0, [
      { id: 'WF20', name: '卡壳复盘', apply: '等待三句聚焦反馈，先不下判断' },
    ], ['证据优先', '状态机优先'], '本轮无状态写入（等待三句聚焦反馈，就地支持）'),
  };
}

/** material_support second-nudge variant: optional add-ons, no repetition. */
function turnMaterialVariantB(state) {
  return {
    reply_markdown:
      '这版内容不动，再给你两个可选加项：\n\n一、**问题墙版**——把三个问题放大成墙面标题，下面留白让孩子把带回的答案画上去；\n二、**店主访谈提纲版**——三个问题换成孩子当面问摊主的口吻，配一句给带队老师的提醒。\n\n要哪一版说一声，文字稿马上给。',
    question: null,
    artifacts: [],
    closure_loop: null,
    state_delta: {},
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('material_support', state.stage ?? 0, [
      { id: 'WF22', name: '素材与资源支持', apply: '追加两个可选加项，不重复上一轮定稿' },
    ], ['文化可能性后台提示', '输出闭环固定'], '本轮无状态写入（素材支持不动课程状态）'),
  };
}

/** material_support third-nudge variant: hand back the initiative briefly. */
function turnMaterialVariantC(state) {
  return {
    reply_markdown:
      '收到。这份素材随时可以继续调整——直接说要改哪里（口吻、问题数量、加访谈提纲版）就行。孩子把东西带回来之后，也随时把两三件发我看看，我们把它们接进儿童问题池。',
    question: null,
    artifacts: [],
    closure_loop: null,
    state_delta: {},
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('material_support', state.stage ?? 0, [
      { id: 'WF22', name: '素材与资源支持', apply: '保持素材可调整，等待孩子带回的真实反应' },
    ], ['文化可能性后台提示', '输出闭环固定'], '本轮无状态写入（素材支持不动课程状态）'),
  };
}

// ===================================== round-3 turns: 每条线走到真正的交付

/**
 * from_zero: the teacher picks a driving-question candidate — ANY answer is
 * accepted (眼睛/机关 wording selects the engineering candidate, everything
 * else the performance candidate). Writes the choice + WF10 goals sketch +
 * the first cycle task; stage 1→2 legally in the same delta.
 */
function turnPickDrivingQuestion(state, message) {
  const eye = /眨|眼睛|机关|会眨眼/.test(message);
  const Q_PERF = '我们怎样排一段自己的小醒狮，让弟弟妹妹们看懂并且不害怕？';
  const Q_EYE = '我们怎样弄清楚狮头的眼睛是怎么眨的，并做一个会眨眼的狮头？';
  const chosen = eye ? Q_EYE : Q_PERF;
  const core = eye
    ? '幼儿能够逐渐理解：会动的东西背后有结构和机关，可以观察、猜想、再动手验证'
    : '幼儿能够逐渐理解：一场让别人看懂的表演，需要商量、分工和反复练习';
  const grasps = eye
    ? { audience: '全班同伴和来访的家长', product: '一个孩子自己做的会眨眼的纸狮头', standards: ['眼睛真的能动吗', '别人看得懂机关吗', '我们自己想再改哪里'] }
    : { audience: '小班弟弟妹妹', product: '一段孩子自己排的小醒狮', standards: ['弟弟妹妹看懂了吗', '有没有人害怕', '我们自己想再改哪里'] };
  const task = eye
    ? {
      type: 'cycle_task',
      title: '协作行动 · 第1轮：狮子的眼睛是怎么动的？',
      data: {
        child_question: '把核心问题抛给孩子：「狮子的眼睛是怎么动起来的？我们先画猜想，再想办法验证。」',
        flow: ['每人画一张「我猜眼睛里面是这样的」猜想图', '把猜想贴上墙，互相讲给同伴听', '去问师傅或看训练录像找线索', '用纸箱和绳子试做第一版'],
        materials: '纸箱、粗绳、胶带、画纸；竹签类尖物由老师保管',
        observation_focus: ['谁的猜想最大胆', '孩子卡在哪个结构点', '谁开始互相帮忙'],
        teacher_role: '先收猜想不给答案；工具使用全程看护',
      },
    }
    : {
      type: 'cycle_task',
      title: '协作行动 · 第1轮：我们的小醒狮怎么排？',
      data: {
        child_question: '把核心问题抛给孩子：「要让弟弟妹妹看懂又不害怕，我们的醒狮要有什么？」',
        flow: ['孩子头脑风暴（全收不筛）', '贴纸投票选第一个要排的段落', '两人一组试「一头一尾」配合', '排练一小段并录像'],
        materials: '大布/床单（狮被替代）、纸箱（狮头雏形）、鼓或塑料桶',
        observation_focus: ['孩子怎么分工、怎么协商', '卡住的点（配合？节奏？）', '谁提出了新办法'],
        teacher_role: '提供材料和安全，不示范「标准动作」，孩子卡住先让他们自己商量',
      },
    };
  return {
    reply_markdown: eye
      ? '好，那就跟着孩子对狮头机关的好奇走：核心驱动问题定为「狮头的眼睛是怎么眨的」。先回应一句判断：**可以进入行动尝试了**——孩子在狮头架前反复看眼睛机关的停留，就是最好的起点证据。\n\n下面是第一轮协作行动的小任务卡。记住：先收猜想，不给答案。'
      : '好，那我们跟着孩子的选择走。先回应你上轮最关心的问题：**是的，可以进入行动尝试了**——证据是孩子已经从「看和问」走到「自发模仿」（男孩A他们的马步），这是典型的尝试探究前兆。\n\n下面是第一轮协作行动的小任务卡。记住：这轮先不追求像不像，重要的是让孩子自己决定「我们的小醒狮」怎么排。',
    question: null,
    artifacts: [task],
    closure_loop: {
      do_now: '把核心问题抛给孩子，收集所有想法后让孩子自己选先做哪一步',
      materials: '方案记录表和投票贴纸（下轮我可以生成打印版）',
      bring_back: '孩子的方案原话和选择结果；第一轮尝试中的1个卡点；三类儿童观察',
      i_will: '和你一起把卡点变成下一轮探究，并判断是否出现项目化信号',
    },
    state_delta: {
      driving_question: {
        text: chosen,
        candidates: (state.driving_question || {}).candidates || [Q_PERF, Q_EYE],
        validation: { child_appropriate: true, authentic: true, actionable: true, public_relevance: true, cultural_possibility: true },
        chosen_by_teacher: true,
      },
      goals_assessment_axis: { core_understanding: core, cultural_ladder_target: 'affection', grasps },
      cycle_history: [{ round: 1, phase: 'collect_ideas', sub_question: eye ? '眼睛里面是什么样的？' : '我们的小醒狮要有什么？', agent_judgment: '进入行动尝试' }],
      child_learning_stage: 'trial_inquiry',
      completed_nodes: ['WF10', 'WF17', 'WF18'],
      stage: 2,
    },
    evidence_refs: eye ? ['ev-dwell-1', 'ev-words-1'] : ['ev-behavior-1'],
    round_complete: true,
    wf_trace: trace('from_zero', 1, [
      { id: 'WF08b', name: '核心驱动问题推导（阶段2边界）', apply: `教师选定：${chosen.slice(0, 18)}…（任一候选都接住）` },
      { id: 'WF10', name: '核心概念性理解目标', apply: '目标轴心先立核心理解（轻量版），四维随后展开' },
      { id: 'WF17', name: '大问题拆解', apply: '核心驱动问题拆成本轮子问题' },
      { id: 'WF18', name: '收集儿童解决方案', apply: '任务卡：先收孩子的想法，不筛不评' },
    ], ['儿童真实反应驱动调整', '阶段判断优先', '输出闭环固定'], '写入 driving_question 定稿与 goals_assessment_axis；stage 提议 1→2'),
  };
}

/** from_zero waiting between cycle rounds: varied, never dead. */
function turnCycleWaitNudge(history) {
  const v = replyVariant(history, CYCLE_NUDGE_MARKER, 2);
  const reply = v === 0
    ? '任务卡在手上了，先去和孩子把第一轮排练试起来，不着急回我。回来时给我三样东西：孩子的方案原话、他们的选择结果、一个卡点。中途要素材（投票贴纸模板、给家长的一句话）随时说。'
    : '我还在这里。循环是一小步一小步走的——哪怕排练只进行了五分钟，也可以先回我一句原话或一个卡点，我们就能接着往下走。';
  return {
    reply_markdown: reply,
    question: {
      text: '第一轮试下来，最先带回来的一句是什么？',
      why: '一句原话或一个卡点，循环就能继续走',
      examples: [
        '第一次排练卡在两人配合上，有孩子提议喊「一二一二」',
        '中途想先要一版投票贴纸素材',
      ],
    },
    artifacts: [],
    closure_loop: null,
    state_delta: {},
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('from_zero', 2, [
      { id: 'WF18', name: '收集儿童解决方案', apply: '等待第一轮协作行动的现场结果' },
    ], ['儿童真实反应驱动调整', '状态机优先'], '本轮无状态写入（等待第一轮循环结果，就地支持）'),
  };
}

/** from_zero second cycle round: the stuck point becomes the next inquiry (WF19/WF20/WF21), stage 2→3. */
function turnSecondCycleReview() {
  return {
    reply_markdown:
      '第二轮反馈接住了。先说判断：**卡点是真的，而且值得留给孩子自己再解决一轮**——「喊一二一二」是孩子自己给出的第一个节奏方案，这比任何成人示范都珍贵，先让它跑一轮。\n\n「想请师傅来看看」这句原话也很重要：孩子开始在意「像不像」，说明表演对象在他们心里变真实了。师傅到访可以作为下一轮的可选支线，但主线还是孩子自己的一二一二。',
    question: null,
    artifacts: [
      {
        type: 'cycle_task',
        title: '协作行动 · 第2轮：一二一二能让我们走到一起吗？',
        data: {
          child_question: '把问题抛回给孩子：「两个人怎么才能同时迈脚？你们的一二一二试三次，看看行不行。」',
          flow: ['用孩子的一二一二办法连排三次', '换搭档再试一次', '录像回放，让孩子自己看哪里对上了', '孩子决定要不要请师傅来看'],
          materials: '手机（录像回放用）；可选：给师傅的邀请便条',
          observation_focus: ['谁在喊节奏、谁在跟', '回放时孩子指出了什么', '关于请师傅，孩子怎么商量'],
          teacher_role: '先让孩子的办法跑满三次再说话；回放时只放不评',
        },
      },
    ],
    closure_loop: {
      do_now: '按任务卡把一二一二连排三次，录一段回放给孩子自己看',
      materials: '录像回放；如果孩子决定请师傅，我下轮给你到访访谈支架',
      bring_back: '回放时孩子说的话；配合有没有变化；请师傅的决定',
      i_will: '根据孩子的决定准备师傅到访支架，或直接进入下一轮循环与项目化信号判断',
    },
    state_delta: {
      children_evidence: [
        { id: 'ev-r2-1', kind: 'behavior', content: '第一次排练两人配合卡住，孩子自发提议喊一二一二来对节奏', round: 2, recorded_at: 'round2' },
        { id: 'ev-r2-2', kind: 'child_words', content: '想请师傅来看看我们排得像不像', round: 2, recorded_at: 'round2' },
      ],
      cycle_history: [{ round: 2, phase: 'stuck_review', sub_question: '两个人怎么才能同时迈脚？', agent_judgment: '卡点真实，留给孩子的一二一二先跑一轮' }],
      child_learning_stage: 'trial_inquiry',
      completed_nodes: ['WF19', 'WF20', 'WF21'],
      stage: 3,
    },
    evidence_refs: ['ev-r2-1', 'ev-r2-2'],
    round_complete: true,
    wf_trace: trace('from_zero', 2, [
      { id: 'WF19', name: '选择方案先尝试', apply: '孩子的一二一二方案先跑，成人办法靠后' },
      { id: 'WF20', name: '卡壳复盘', apply: '配合卡点定性为真卡点，转成第2轮子问题' },
      { id: 'WF21', name: '下一轮循环与项目化信号提醒', apply: '师傅到访列为支线；项目化信号待观察' },
    ], ['儿童真实反应驱动调整', '证据优先', '输出闭环固定'], '第二轮证据与循环记录入账；stage 提议 2→3（目标轴心已在档，门槛满足）'),
  };
}

/** optimize_existing: teacher picks a sharpened candidate → WF10 goals + WF16 evidence plan. */
function turnOptimizePick(state, message) {
  const drum = /鼓|节奏|一起动|整齐/.test(message);
  const Q_FLOAT = '我们怎样做一条放进水里不会翻的小龙舟？';
  const Q_DRUM = '我们怎样让全班的桨跟着鼓点一起动起来？';
  const chosen = drum ? Q_DRUM : Q_FLOAT;
  const core = drum
    ? '幼儿能够逐渐理解：很多人一起动作整齐，需要一个共同的信号和反复练习'
    : '幼儿能够逐渐理解：让一个东西浮起来又不翻，需要试、观察、再调整';
  return {
    reply_markdown:
      `好，核心驱动问题就定这个：「${chosen}」\n\n目标与评估轴心先立一根轴——**核心理解**：${core}。四维目标和 GRASPS 评估可以边做边补，不用一次写全。\n\n但**过程性证据计划**现在就要立起来，这是优化线最容易漏的一块：从下一轮开始，每轮固定带回三件东西——一句原话、一张作品或现场照片、一条行为观察。这就是以后目标回看和课程故事的底账。`,
    question: null,
    artifacts: [],
    closure_loop: {
      do_now: '把定下来的驱动问题抛回给孩子，听他们的第一批想法',
      materials: '证据三件套提醒卡：原话、作品或照片、行为观察（下轮可给打印版）',
      bring_back: '孩子对问题的第一批想法，加上第一轮的三件证据',
      i_will: '陪你把第一轮循环拆成可做的小任务（大问题拆解），并盯住证据计划落地',
    },
    state_delta: {
      driving_question: {
        text: chosen,
        candidates: (state.driving_question || {}).candidates || [Q_FLOAT, Q_DRUM],
        chosen_by_teacher: true,
      },
      goals_assessment_axis: {
        core_understanding: core,
        cultural_ladder_target: 'affection',
        grasps: drum
          ? { audience: '全班和运动会上的观众', product: '一段桨随鼓点整齐动作的合练', standards: ['信号大家都听得懂吗', '有没有人跟不上', '我们自己想再改哪里'] }
          : { audience: '全班同伴和家长', product: '一条孩子自己做的能浮不翻的小龙舟', standards: ['放进水里浮不浮', '翻了之后孩子怎么改', '我们自己想再改哪里'] },
      },
      completed_nodes: ['WF10', 'WF16'],
      stage: 3,
    },
    evidence_refs: drum ? ['ev-lz-1'] : ['ev-lz-2'],
    round_complete: true,
    wf_trace: trace('optimize_existing', 2, [
      { id: 'WF10', name: '核心概念性理解目标', apply: '以儿童证据为底，先立核心理解一根轴' },
      { id: 'WF16', name: '过程性证据计划', apply: '每轮三件证据固定回收——优化线的底账' },
    ], ['阶段判断优先', '证据优先'], '写入 driving_question 定稿与目标轴心；stage 提议 2→3（核心理解同轮写入，门槛满足）'),
  };
}

/** story_export: record the chosen export version — WF30 stays unmarked until real delivery. */
function turnStoryVersion(state, message) {
  const version = /汇报|摘要/.test(message) ? '汇报摘要版' : /公众号/.test(message) ? '公众号版' : '完整案例版';
  return {
    reply_markdown:
      `好，就按「${version}」来。下一条消息回我「继续」，或者直接提要求，我就把四章文字稿完整展开——每章的章眼用孩子的原话或真实材料，缺的部分标「待补充」，不编。`,
    question: null,
    artifacts: [],
    closure_loop: null,
    state_delta: {
      story_materials: { ...(state.story_materials || {}), export_version: version },
    },
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('story_export', 5, [
      { id: 'WF32', name: '多版本导出', apply: `版本选定：${version}` },
      { id: 'WF30', name: '图文结构生成', apply: '待下一轮真实交付文字稿后才标记完成' },
    ], ['输出闭环固定', '状态机优先'], '写入 story_materials.export_version；WF30 未交付不打勾'),
  };
}

/** story_export: the ACTUAL expanded course story — four written chapters, every one anchored to evidence. */
function turnStoryExpand(state) {
  const version = (state.story_materials || {}).export_version || '完整案例版';
  return {
    reply_markdown:
      `按「${version}」把四章展开好了——每章的章眼都是孩子的原话或真实材料，标了「待补充」的地方我没有编。结尾附了一段文化育人价值复盘：只写四条证据撑得住的变化苗头，行动层如实标「尚未充分看见」。你读一遍，改动直接说：换章节顺序、换章眼原话都行。`,
    question: null,
    artifacts: [
      {
        type: 'story_fragment',
        title: `课程故事 · ${version}（文字稿）`,
        data: {
          origin: '起点不是教案，而是一批真实的过程照片——孩子们分组动手做东西的样子，先于任何文字记录出现。',
          chapters: [
            {
              chapter: '一、我们动手做',
              content: '故事从一批过程照片开始：桌边、地垫上，孩子们分组做自己的东西，手一直没停。没有导入环节的痕迹——先动起来的是手，不是教案。这一章用照片说话，文字只做旁白。',
              evidence: 'ev-st-photo-1',
            },
            {
              chapter: '二、「这是我们一起做出来的」',
              content: '作品和涂鸦收上来那天，有孩子指着桌上的成品说出了这句话。「一起」两个字是这一章的章眼——作品属于谁，孩子自己说得很清楚。作品照片配原话，不加成人解读。',
              evidence: 'ev-st-words-1',
            },
            {
              chapter: '三、对着镜头说',
              content: '采访视频里，孩子对着镜头介绍自己做的东西：介绍给谁看、用什么词，都由孩子自己决定。这段视频是全篇最有分量的过程证据，建议截两帧配文字。',
              evidence: 'ev-st-video-1',
            },
            {
              chapter: '四、「下次我还想再做一遍」',
              content: '收尾用的也是孩子的原话。这句话指向下一轮课程的种子：想再做一遍的究竟是哪个环节——这个问题留给下学期，此处如实标注，待现场确认。',
              evidence: 'ev-st-words-2',
            },
          ],
          gaps: ['卡点与转折（待补充：当时哪一步不顺利、怎么转的弯）', '教师反思（待补充：一段即可）', '目标与评估对照（待补充：当时的目标记录缺失）'],
        },
      },
      {
        type: 'culture_review',
        title: '文化育人价值复盘（教师后台段落）',
        data: {
          core_resource: '孩子们动手做的这件作品，以及它背后的生活场景',
          initial_relation: '起点：照片里的孩子最初只是动手参与，谈不上「认作自己的」（ev-st-photo-1）',
          evidence_of_change: [
            '「这是我们一起做出来的」——把作品认作自己的（ev-st-words-1）',
            '对着镜头主动介绍自己做的东西——愿意表达、愿意介绍（ev-st-video-1）',
            '「下次我还想再做一遍」——愿意继续探索（ev-st-words-2）',
          ],
          ladder_position: '证据撑到情感层的苗头（喜欢、愿意分享）；行动层（改良、服务、向外介绍）尚未充分看见——如实标注，不拔高',
          usable_statement: '孩子与这份材料的关系从「做」走到「认、讲、想再做」；四条证据俱在，更大的价值结论暂不写。',
        },
      },
    ],
    closure_loop: {
      do_now: '把四章文字稿通读一遍，标出想改的地方',
      materials: '四章文字稿（本轮已交付，可直接誊入园本模板）',
      bring_back: '修改意见，或补充的卡点回忆和教师反思',
      i_will: '按你的意见调整章节与章眼，并把补充材料填进「待补充」的位置',
    },
    state_delta: {
      completed_nodes: ['WF30', 'WF31b', 'WF32'],
    },
    evidence_refs: ['ev-st-photo-1', 'ev-st-words-1', 'ev-st-video-1', 'ev-st-words-2'],
    round_complete: true,
    wf_trace: trace('story_export', 5, [
      { id: 'WF30', name: '图文结构生成', apply: '四章文字稿真实交付——此刻才标记完成' },
      { id: 'WF31b', name: '文化育人价值复盘', apply: '只写证据撑得住的变化苗头，阶梯标到情感层，行动层如实缺席' },
      { id: 'WF32', name: '多版本导出', apply: `按${version}交付文字稿（演示以文字为准）` },
    ], ['证据优先', '输出闭环固定'], '写入 completed_nodes WF30/WF31b/WF32——交付即标记，不提前'),
  };
}

/** story_export: genuine adjustment — real re-ordering / re-quoting, two variants. */
function turnStoryAdjust(state, history) {
  const v = replyVariant(history, /换了个开场|章眼换成/, 2);
  const reply = v === 0
    ? '按你的意思换了个开场：把「对着镜头说」提到第一章——用孩子自己的讲述开场，比过程照片更抓人。新的章节顺序：\n\n一、对着镜头说（证据 ev-st-video-1）\n二、我们动手做（证据 ev-st-photo-1）\n三、「这是我们一起做出来的」（证据 ev-st-words-1）\n四、「下次我还想再做一遍」（证据 ev-st-words-2）\n\n内文不动，只调结构；想换回来或继续调，直接说。'
    : '章眼换成另一句也可以：第二章的章眼从「这是我们一起做出来的」换成「下次我还想再做一遍」，原第四章改用「这是我们一起做出来的」收尾——首尾对调之后，情绪线从期待走向确认。两版都保留在文字稿里，你读完选一版定稿。';
  return {
    reply_markdown: reply,
    question: null,
    artifacts: [],
    closure_loop: null,
    state_delta: {},
    evidence_refs: ['ev-st-photo-1', 'ev-st-words-1', 'ev-st-video-1', 'ev-st-words-2'],
    round_complete: false,
    wf_trace: trace('story_export', 5, [
      { id: 'WF30', name: '图文结构生成', apply: v === 0 ? '按教师意见调整章节顺序' : '按教师意见调整章眼原话' },
    ], ['教师资源意图优先', '证据优先'], '本轮无状态写入（文字稿结构调整，仍在交付范围内）'),
  };
}

/** mid_course second round: a DIFFERENT read — breakthrough, role shift, challenge upgrade. */
function turnMidCourseSecond() {
  return {
    reply_markdown:
      '第二轮的反馈很关键：**卡点破了**。上一轮「分组」的判断在现场得到了验证——胶带组把狮头固定住了，其他组主动围过来要学，这是同伴之间自然的经验流动，比老师示范有效得多。\n\n小宇的变化更值得记一笔：从指挥别人到自己动手缠胶带。上一轮我们说「先观察不打断」，现在看是对的——小组机制自己把角色分流了。\n\n后台再给你一条文化线索（不讲给孩子）：狮头扎作讲究「扎、扑、写、装」的工序，孩子们此刻做的固定，可能正站在「扎」这一步的门口（待现场确认，仅供你观察时参考）。\n\n下一轮建议把挑战升一级：两组交换狮头互相试戴检验——检验别人的作品，是更高一层的探究。',
    question: null,
    artifacts: [
      {
        type: 'cycle_task',
        title: '协作行动 · 下一轮：交换狮头，互相检验',
        data: {
          child_question: '把问题抛给孩子：「别的组做的狮头，戴在你头上也稳吗？帮他们找找会掉的时刻。」',
          flow: ['两组交换狮头试戴', '记下会掉、会歪的时刻', '给对方组提一个改进建议', '回自己组改一版再试'],
          materials: '各组狮头、小镜子、便签纸',
          observation_focus: ['孩子怎么给别人提建议、怎么接受建议', '小宇在交换环节的角色', '有没有组不愿交换，孩子怎么商量'],
          teacher_role: '建议让孩子用自己的话转述，不评谁的更好；护住每个组的作品尊严',
        },
      },
    ],
    closure_loop: {
      do_now: '组织两组交换狮头互相试戴，让孩子记录会掉的时刻',
      materials: '便签和小镜子；建议再录一段交换检验的视频',
      bring_back: '交换检验的结果、孩子提建议的原话、小宇这轮的表现',
      i_will: '判断项目化信号（多组主动改进就是信号），并预告成果展示的可能形态',
    },
    state_delta: {
      children_evidence: [
        { id: 'ev-mc2-1', kind: 'behavior', content: '胶带组用宽胶带把狮头固定住了，其他组围过来要学', round: 2, recorded_at: 'round2' },
        { id: 'ev-mc2-2', kind: 'behavior', content: '小宇这一轮自己动手缠胶带，没有指挥别人', child_ref: '小宇', round: 2, recorded_at: 'round2' },
      ],
      child_participation_difference: [
        { round: 2, profile: 'director', child_ref: '小宇', observation: '从指挥转向动手，小组机制自然分流了角色' },
      ],
      teacher_focus_feedback: [
        { round: 2, what_happened: '胶带组固定成功，其他组要学', who_stood_out: '小宇（转向动手）', to_judge: '挑战要不要升级' },
      ],
      cycle_history: [
        { round: 2, phase: 'breakthrough_review', sub_question: '狮头固定住之后，怎么检验？', agent_judgment: '交换检验，挑战升级' },
      ],
      child_learning_stage: 'trial_inquiry',
      completed_nodes: ['WF20c', 'WF20d', 'WF21'],
    },
    evidence_refs: ['ev-mc2-1', 'ev-mc2-2'],
    round_complete: true,
    wf_trace: trace('mid_course', 0, [
      { id: 'WF20', name: '卡壳复盘', apply: '第二轮判读：卡点已破，读作突破而非卡壳' },
      { id: 'WF20c', name: '文化语义回看', apply: '固定≈扎作「扎」工序入口（仅后台，已加待现场确认）' },
      { id: 'WF20d', name: '儿童差异观察与教师聚焦反馈', apply: '小宇从指挥到动手的角色变化入差异记录' },
      { id: 'WF21', name: '下一轮循环与项目化信号提醒', apply: '挑战升级：交换检验；项目化信号盯多组主动改进' },
    ], ['儿童真实反应驱动调整', '文化可能性后台提示', '证据优先'], '第二轮证据与差异记录入账；stage 保持0——档案仍不完整，不冒进跳阶段'),
  };
}

/** mid_course waiting between rounds: varied, keeps the door open. */
function turnMidCourseHold(history) {
  const v = replyVariant(history, MIDCOURSE_HOLD_MARKER, 2);
  const reply = v === 0
    ? '收到。去把分组尝试跑起来，回来告诉我各组的结果就行——哪组稳了、哪组还在掉、小宇这轮做了什么。'
    : '我还在这里。不用等全部结果，先发一个卡点或一句孩子的原话也可以，我们边走边看。';
  return {
    reply_markdown: reply,
    question: {
      text: '分组试完，先带回哪一组的情况？',
      why: '不用等全部结果，一组的卡点或一句原话就够',
      examples: [
        '胶带组把狮头固定住了，孩子说「要缠三圈」',
        '麻绳组卡住了还在掉，小宇这一轮自己动手试了',
      ],
    },
    artifacts: [],
    closure_loop: null,
    state_delta: {},
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('mid_course', 0, [
      { id: 'WF21', name: '下一轮循环与项目化信号提醒', apply: '等待分组尝试的现场结果' },
    ], ['儿童真实反应驱动调整', '状态机优先'], '本轮无状态写入（等待分组结果回传，就地支持）'),
  };
}

const HORIZON_MARKER = /演示脚本到这里|演示的边界/;

/** 演示边界: every flow ends HERE on purpose — honest, warm, never a stall. */
/** Per-flow things a teacher can still genuinely do past the demo boundary —
 * every chip here must route to a REAL handler (story adjusts, 回顾 recap):
 * a handle the demo cannot honor is a false affordance, worse than none. */
const HORIZON_HANDLES = {
  story_export: ['把章节顺序换一下', '换一句章眼原话', '回顾一下这一路点亮的节点'],
  default: ['回顾一下这一路点亮的节点', '把走过的足迹列给我看看'],
};

/** Honest recap past the boundary: list the workflow nodes this course really
 * lit, from state — deterministic, no fabrication, works in every flow. */
function turnRecap(mode, state) {
  const lit = (state.completed_nodes || []);
  const names = lit.map((id) => {
    const node = WF_NODES.find((n) => n.id === id);
    return node ? `${id} ${node.name}` : id;
  });
  const listText = names.length ? names.map((n) => `- ${n}`).join('\n') : '- 这门课程还没有点亮任何节点';
  const handleCard = {
    id: 'q-horizon-next',
    text: '还想看点什么',
    why: '演示边界内可以随时回顾走过的路',
    examples: HORIZON_HANDLES[mode] || HORIZON_HANDLES.default,
    required: false,
  };
  return {
    reply_markdown:
      `好，这一路我们一起点亮了 ${names.length} 个工作流节点：\n\n${listText}\n\n每个节点的详情在开发者模式的工作流地图里都能看到。`,
    question: handleCard,
    questions: [handleCard],
    artifacts: [],
    closure_loop: null,
    state_delta: {},
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace(mode, state.stage ?? 0, [
      { id: 'WF03', name: '使用方式说明', apply: '按教师要求回顾已点亮的节点——从 state 读取，不虚构' },
    ], ['状态机优先'], '回顾输出，无状态写入'),
  };
}

function turnHorizon(mode, state, history, message = '') {
  if (/回顾|点亮|足迹/.test(message)) return turnRecap(mode, state);
  const v = replyVariant(history, HORIZON_MARKER, 2);
  const reply = v === 0
    ? '这条线路的演示脚本到这里就走完了——真实使用中，我会继续陪你一轮一轮循环下去，直到成果展示和完整导出。你现在可以：\n\n- 点右上角「新课程」，换一条入口再走一遍（从零陪跑、已有主题优化、课程故事整理、素材支持都可以）；\n- 打开设置里的「开发者模式」，在调试抽屉的工作流地图里回顾这一路点亮的节点。\n\n谢谢你陪我走完这一段。'
    : '这条线路走到了演示的边界。往后的部分——继续循环、成果展示、多版本导出——真实使用中我都会接着陪你做，不会停在这里。想再走一条线，点「新课程」换个入口；想复盘，开发者模式的工作流地图里有这一路的完整足迹。';
  const handleCard = {
    id: 'q-horizon-next',
    text: '接下来想做点什么',
    why: mode === 'story_export'
      ? '课程故事的章节与章眼仍然可以调整；也可以回顾走过的路'
      : '演示边界内可以随时回顾走过的路；继续修改在真实使用中进行',
    examples: HORIZON_HANDLES[mode] || HORIZON_HANDLES.default,
    required: false,
  };
  return {
    reply_markdown: reply,
    question: handleCard,
    questions: [handleCard],
    artifacts: [],
    closure_loop: null,
    state_delta: {},
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace(mode, state.stage ?? 0, [
      { id: 'WF03', name: '使用方式说明', apply: '说明演示边界与下一步的玩法，留出可回改的抓手' },
    ], ['状态机优先'], '演示脚本边界，无状态写入'),
  };
}
