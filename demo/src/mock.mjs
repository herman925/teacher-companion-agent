// Mock provider — a scripted, contract-compliant 醒狮 walkthrough of the §7
// minimal loop, keyed off course_state. Lets the UI, SSE pipeline, runtime
// harness, and engine be exercised (and browser-verified) without an API key.
// Every canned turn MUST pass validateTurn + the stage gates: the mock goes
// through the same L2/L3 pipeline as real providers — no special casing.

/**
 * @param {Object} state current course_state
 * @param {Array} history prior chat messages
 * @param {string} message the teacher's message
 * @returns {Object} a turn-contract object (see contract.zh.md)
 */
export function mockTurn(state, history, message) {
  // Scripted branch order mirrors the demo walkthrough, not real inference.
  // turn 1 records theme_resource; turn 2's message is the intent answer.
  if (!state.theme_resource?.name) return turnIntentQuestion(message);
  if (!state.resource_entry_card) return turnEntryCard();
  if (!(state.children_evidence || []).length) return turnAwaitOrIngest(state, message);
  if (!(state.child_question_pool || []).length) return turnQuestionPool();
  if (!(state.cycle_history || []).length) return turnCycleTask();
  return turnStoryFragment(state);
}

function turnIntentQuestion(message) {
  const resource = /龙舟/.test(message) ? '龙舟' : /趁墟/.test(message) ? '趁墟' : /祠堂/.test(message) ? '祠堂' : '醒狮';
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
    state_delta: { teacher_mode: 'from_zero', theme_resource: { name: resource } },
    evidence_refs: [],
    round_complete: false,
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
      completed_nodes: ['WF01', 'WF02b', 'WF03b'],
      stage: 1,
    },
    evidence_refs: [],
    round_complete: true,
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
  };
}

function turnQuestionPool() {
  // Reached when evidence exists but pool wasn't stored (teacher answered the
  // confirmation question) — confirm pool and hand over goal-axis lite + cycle task.
  return turnCycleTask();
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
      completed_nodes: ['WF17', 'WF18'],
      stage: 2,
    },
    evidence_refs: ['ev-behavior-1'],
    round_complete: true,
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
  };
}
