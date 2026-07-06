// Mock provider — scripted, contract-compliant walkthroughs of the §7 loop,
// keyed off course_state（状态机优先：路由只看状态，不看轮数）. WF01 入口识别
// classifies the FIRST message into one of five teacher modes; each mode is a
// distinct flow touching different V1.3 workflow nodes, and every turn carries
// a dev-facing wf_trace annotation (developer mode UI). Every canned turn MUST
// pass validateTurn + the stage gates: the mock goes through the same
// L2/L3 pipeline as real providers — no special casing.

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
export function mockTurn(state, history, message) {
  // WF01 has not run yet → entry recognition on first contact (状态机优先).
  if (!(state.completed_nodes || []).includes('WF01')) return turnEntry(message);
  switch (state.teacher_mode) {
    case 'optimize_existing': return optimizeFlow(state);
    case 'story_export': return storyFlow(state);
    case 'mid_course': return midCourseFlow(state);
    case 'material_support': return materialFlow(state);
    default: return fromZeroFlow(state, message);
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

function turnEntry(message) {
  switch (classifyEntry(message)) {
    case 'story_export': return turnStoryEntry();
    case 'optimize_existing': return turnOptimizeEntry();
    case 'mid_course': return turnMidCourseEntry();
    case 'material_support': return turnMaterialEntry(message);
    default: return turnIntentQuestion(message);
  }
}

function detectResource(message) {
  return /龙舟/.test(message) ? '龙舟' : /趁墟/.test(message) ? '趁墟' : /祠堂/.test(message) ? '祠堂' : '醒狮';
}

// ======================================================== 从零陪跑 from_zero

function fromZeroFlow(state, message) {
  if (!state.resource_entry_card) return turnEntryCard();
  if (!(state.children_evidence || []).length) return turnAwaitOrIngest(state, message);
  if (!(state.cycle_history || []).length) return turnCycleTask();
  return turnStoryFragment(state);
}

function turnIntentQuestion(message) {
  const resource = detectResource(message);
  return {
    reply_markdown:
      `听起来你已经带着「${resource}」的初步想法来了——这个资源本身就有很强的现场感，我们不急着写方案，先把它变成孩子能真实进入的入口。\n\n我先问一个最要紧的问题（后面两问会更快）。`,
    question: {
      text: `为什么想带孩子做${resource}？你希望孩子接触它之后，多感受到一点什么？`,
      why: '先听懂你的资源意图，切口卡才不会泛泛而谈',
      examples: [
        `园附近每年都有${resource}活动，孩子们其实见过，但只是看热闹`,
        '园里想做本土文化课程，我自己也想试试项目式的做法',
        '我还说不清楚，你根据这个资源先给我几个可能的方向',
      ],
    },
    artifacts: [],
    closure_loop: null,
    state_delta: { teacher_mode: 'from_zero', theme_resource: { name: resource }, completed_nodes: ['WF01', 'WF02'] },
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('from_zero', 0, [
      { id: 'WF01', name: '入口识别', apply: '首条消息按关键词判定为从零陪跑模式' },
      { id: 'WF02', name: '信息补全', apply: '动态识别式提问：一次只问一个聚焦问题' },
      { id: 'WF03b', name: '资源意图确认与课程可能性启发', apply: '先听资源意图，下一轮才出切口卡' },
    ], ['状态机优先', '教师资源意图优先'], '本轮写入 teacher_mode 与 theme_resource；stage 保持0'),
  };
}

function turnEntryCard() {
  return {
    reply_markdown:
      '明白了。你的想法里已经有两个很好的线索：孩子们**见过**这个资源（有真实场域），你希望他们**不止于看热闹**（有意图方向）。我把它整理成一张资源课程化切口卡，你只要标出最认可的儿童入口。\n\n同时我判断了一下这个主题适合走到哪一步，以及第一轮可以怎么做——都在下面的卡片里。',
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
      completed_nodes: ['WF02b', 'WF03b'],
      stage: 1,
    },
    evidence_refs: [],
    round_complete: true,
    wf_trace: trace('from_zero', 0, [
      { id: 'WF03b', name: '资源意图确认与课程可能性启发', apply: '教师意图落成切口卡的三个儿童入口' },
      { id: 'WF02b', name: '主题探究适配性筛查', apply: '判定主题探究型，项目化留待儿童反应验证' },
      { id: 'WF05', name: '高频情境浸润', apply: '第一轮体验计划：看一次真实训练' },
      { id: 'WF05b', name: '真实人物与生活场景访谈任务', apply: '生成舞狮师傅访谈卡（孩子问＋老师问）' },
    ], ['教师资源意图优先', '阶段判断优先', '输出闭环固定'], '写入 resource_entry_card 与 theme_fit_level；stage 提议 0→1（引擎按门槛放行）'),
  };
}

function turnAwaitOrIngest(state, message) {
  // If the teacher message reads like field feedback, ingest it as evidence.
  const hasFeedback = /(说|问|画|拍|停留|围|模仿|盯着)/.test(message) && message.length > 20;
  if (!hasFeedback) {
    return {
      reply_markdown:
        '我先在这里等你带孩子去现场，不急。如果你在准备中遇到问题（联系不上醒狮队、家长有顾虑、想先做点铺垫），随时告诉我，我可以帮你出预案或素材。\n\n回来时不用写总结——几句孩子原话、两个停留点、几张照片就够。',
      question: null,
      artifacts: [],
      closure_loop: null,
      state_delta: {},
      evidence_refs: [],
      round_complete: false,
      wf_trace: trace('from_zero', 1, [
        { id: 'WF05', name: '高频情境浸润', apply: '体验尚未发生——等待现场，不催促也不虚构' },
      ], ['证据优先', '儿童真实反应驱动调整'], '本轮不写入任何状态字段；awaiting_feedback 由平台控制'),
    };
  }
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
      { id: 'WF06', name: '显性化表征已有经验', apply: '现场反馈（原话/行为/停留点）入证据账本' },
      { id: 'WF07', name: '儿童问题池整理', apply: '三个真问题入池，成人化问题剔除' },
      { id: 'WF07b', name: '儿童问题背后的文化可能性提示', apply: '每个问题附后台文化线索（只给教师看）' },
      { id: 'WF08', name: '核心驱动问题推导', apply: '从真实问题推出两个候选，教师与孩子选' },
    ], ['证据优先', '儿童真实反应驱动调整', '文化可能性后台提示'], '写入 children_evidence、child_question_pool 与 driving_question 候选'),
  };
}

function turnCycleTask() {
  return {
    reply_markdown:
      '好，那我们跟着孩子的选择走。先回应你上轮最关心的问题：**是的，可以进入行动尝试了**——证据是孩子已经从「看和问」走到「自发模仿」（男孩A他们的马步），这是典型的尝试探究前兆。\n\n下面是第一轮协作行动的小任务卡。记住：这轮先不追求像不像，重要的是让孩子自己决定「我们的小醒狮」怎么排。',
    question: null,
    artifacts: [
      {
        type: 'cycle_task',
        title: '协作行动 · 第1轮：我们的小醒狮怎么排？',
        data: {
          child_question: '把核心问题抛给孩子：「要让弟弟妹妹看懂又不害怕，我们的醒狮要有什么？」',
          flow: ['孩子头脑风暴（全收不筛）', '贴纸投票选第一个要排的段落', '两人一组试「一头一尾」配合', '排练一小段并录像'],
          materials: '大布/床单（狮被替代）、纸箱（狮头雏形）、鼓或塑料桶',
          observation_focus: ['孩子怎么分工、怎么协商', '卡住的点（配合？节奏？）', '谁提出了新办法'],
          teacher_role: '提供材料和安全，不示范「标准动作」，孩子卡住先让他们自己商量',
        },
      },
    ],
    closure_loop: {
      do_now: '把核心问题抛给孩子，收集所有方案后让孩子投票选一段先排',
      materials: '方案记录表和投票贴纸（下轮我可以生成打印版）',
      bring_back: '孩子的方案原话和投票结果；排练中的1个卡点；三类儿童观察；三句聚焦反馈（第三句示例：「孩子的配合卡点该介入吗？」「要不要请师傅来看一次？」）',
      i_will: '和你一起把卡点变成下一轮探究，并判断是否出现项目化信号',
    },
    state_delta: {
      driving_question: {
        text: '我们怎样排一段自己的小醒狮，让弟弟妹妹们看懂并且不害怕？',
        candidates: ['我们怎样排一段自己的小醒狮，让弟弟妹妹们看懂并且不害怕？'],
        validation: { child_appropriate: true, authentic: true, actionable: true, public_relevance: true, cultural_possibility: true },
        chosen_by_teacher: true,
      },
      goals_assessment_axis: {
        core_understanding: '幼儿能够逐渐理解：一场让别人看懂的表演，需要商量、分工和反复练习',
        cultural_ladder_target: 'affection',
        grasps: { audience: '小班弟弟妹妹', product: '一段孩子自己排的小醒狮', standards: ['弟弟妹妹看懂了吗', '有没有人害怕', '我们自己想再改哪里'] },
      },
      cycle_history: [{ round: 1, phase: 'collect_ideas', sub_question: '我们的小醒狮要有什么？', agent_judgment: '进入行动尝试' }],
      child_learning_stage: 'trial_inquiry',
      completed_nodes: ['WF10', 'WF17', 'WF18'],
      stage: 2,
    },
    evidence_refs: ['ev-behavior-1'],
    round_complete: true,
    wf_trace: trace('from_zero', 1, [
      { id: 'WF10', name: '核心概念性理解目标', apply: '目标轴心先立核心理解（轻量版），四维随后展开' },
      { id: 'WF17', name: '大问题拆解', apply: '核心驱动问题拆成本轮子问题：小醒狮要有什么' },
      { id: 'WF18', name: '收集儿童解决方案', apply: '任务卡：头脑风暴全收不筛，投票选段落' },
    ], ['儿童真实反应驱动调整', '阶段判断优先', '输出闭环固定'], '写入 driving_question 定稿与 goals_assessment_axis；stage 提议 1→2'),
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

function optimizeFlow(state) {
  if (!state.resource_entry_card) return turnOptimizeBackfill();
  if (!(state.children_evidence || []).length) return turnOptimizeEvidence();
  return turnOptimizeNext();
}

function turnOptimizeEntry() {
  return {
    reply_markdown:
      '好——已经在做的主题不用推倒重来，我们从你手上已有的东西接着长。我先把家底接进课程档案，再看孩子的真实反应指向哪里。',
    question: {
      text: '你们现在手上已经有什么，做到哪一步了？',
      why: '先摸清已有底子，才不会给你重复的建议',
      examples: ['有主题网络，但孩子兴趣散', '做了两周活动，不知道下一步', '有活动照片和作品，没整理'],
    },
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
      { id: 'WF04', name: '预备资产网络', apply: '现成的主题网络作为预备资产接入档案' },
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
      { id: 'WF06', name: '显性化表征已有经验', apply: '两周活动里的儿童原话入证据账本' },
      { id: 'WF07', name: '儿童问题池整理', apply: '原话整理入池，「兴趣散」被证据修正' },
      { id: 'WF07b', name: '儿童问题背后的文化可能性提示', apply: '每个问题附后台文化线索（不讲给孩子）' },
      { id: 'WF08', name: '核心驱动问题推导', apply: '从真实问题收紧出两个候选' },
    ], ['证据优先', '儿童真实反应驱动调整', '文化可能性后台提示'], '写入 children_evidence 与 driving_question 候选；stage 提议 1→2（证据与候选同轮入账）'),
  };
}

function turnOptimizeNext() {
  return {
    reply_markdown:
      '目标与评估轴心可以开动了：先把核心概念性理解目标定下来，四维目标和 GRASPS 表现性评估随后展开。等孩子选定驱动问题，回来告诉我一声就行。',
    question: null,
    artifacts: [],
    closure_loop: null,
    state_delta: {},
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('optimize_existing', 2, [
      { id: 'WF10', name: '核心概念性理解目标', apply: '下一步：以儿童证据为底定核心理解目标' },
    ], ['阶段判断优先'], '等待教师带回孩子对驱动问题的选择，不抢跑'),
  };
}

// ================================================== 课程故事整理 story_export

function storyFlow(state) {
  if (!state.story_materials) return turnStoryMaterials();
  if (state.stage < 5) return turnStorySpine();
  return turnStoryVersion();
}

function turnStoryEntry() {
  return {
    reply_markdown:
      '好，我们把这堆照片整理成一个立得住的课程故事。第一步不是动笔，而是盘点材料——有什么、缺什么，缺的部分如实标注，不虚构。\n\n先告诉我材料的底子。',
    question: {
      text: '这堆照片主要拍的是什么？',
      why: '材料完整性检查是课程故事的第一步，主线要从真实材料里长出来',
      examples: ['主要是活动过程照片', '有孩子的作品和涂鸦', '还有几段采访视频'],
    },
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

function turnStoryVersion() {
  return {
    reply_markdown:
      '好，就按这个版本来。文字稿我可以按四章骨架直接展开；图文排版和多版本导出在真实使用中会给你可下载的文件，这个演示先到文字结构为止。\n\n想调整章节顺序或换章眼原话，随时说。',
    question: null,
    artifacts: [],
    closure_loop: null,
    state_delta: { completed_nodes: ['WF30', 'WF32'] },
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('story_export', 5, [
      { id: 'WF30', name: '图文结构生成', apply: '按选定版本排章节与图文位置' },
      { id: 'WF32', name: '多版本导出', apply: '演示中以文字结构代替可下载文件' },
    ], ['输出闭环固定'], '记录已选版本的导出节点；stage 保持5'),
  };
}

// ==================================================== 过程中续聊 mid_course

function midCourseFlow(state) {
  if (!(state.children_evidence || []).length) return turnMidCourseReview();
  return turnMidCourseNext();
}

function turnMidCourseEntry() {
  return {
    reply_markdown:
      '收到。按流程我会先读你的课程档案再接话——但这个演示会话里档案是空的，真实使用中不会让你重复回忆已经记录过的东西。这里先快速补档：用三句话把昨天的现场带给我就够。',
    question: {
      text: '用三句话告诉我：孩子们做了什么、谁的表现最让你在意、你现在最想判断什么？',
      why: '三句聚焦反馈够我接住现场，不用写总结',
      examples: [
        '孩子们试了纸箱做狮头，卡在固定不住',
        '最活跃的是小宇，一直在指挥别人',
        '我想知道下一轮该分组还是集体',
      ],
    },
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

function turnMidCourseNext() {
  return {
    reply_markdown:
      '收到。带着各组的固定办法和原话回来，我们再一起判断有没有项目化信号——如果多个组开始主动改进自己的办法，这个卡点就可能长成一个真项目。',
    question: null,
    artifacts: [],
    closure_loop: null,
    state_delta: {},
    evidence_refs: [],
    round_complete: false,
    wf_trace: trace('mid_course', 0, [
      { id: 'WF21', name: '下一轮循环与项目化信号提醒', apply: '等待各组结果，再判断项目化信号' },
    ], ['儿童真实反应驱动调整'], '不写入状态；等待现场反馈回传'),
  };
}

// ================================================= 素材支持 material_support

function materialFlow(state) {
  return turnMaterialDeliver(state);
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
