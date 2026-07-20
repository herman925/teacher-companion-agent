// wf-nodes.mjs — workflow node catalog as pure data. Stages 0 & 1 follow the
// 2026-07-19 stage-1 redesign (source-docs/stage1-workflow-v1.0.zh-CN.md —
// blueprint-first: deliver the 预设包, then 陪跑 on 回传); stages 2–5 remain
// V1.3 (source-docs/workflow-v1.3.zh-CN.md) until upstream revises them.
// Ids are STABLE across the redesign (existing course states carry them);
// only names/semantics were re-bound. The model cites these ids in wf_trace /
// completed_nodes; the engine additionally lights preset-artifact nodes
// deterministically from blueprint absorption (engine_lit_nodes — see
// engine.absorbBlueprint). The debug drawer renders the 工作流地图 from this
// list. No logic lives here.

export { STAGE_NAMES as STAGE_TITLES } from './engine.mjs';

/** @type {Array<{id: string, name: string, stage: number}>} */
export const WF_NODES = [
  // 阶段0 启动与建档
  { id: 'WF01', name: '入口识别', stage: 0 },
  { id: 'WF02', name: '信息补全', stage: 0 },
  { id: 'WF02b', name: '主题探究适配性筛查', stage: 0 },
  { id: 'WF03', name: '使用方式说明', stage: 0 },
  { id: 'WF03b', name: '资源意图确认与课程可能性启发', stage: 0 },
  // 阶段1 聚焦问题，补齐经验 — stage1-workflow-v1.0 五步法.
  // Preset-artifact nodes (WF04a/04/04b/08) are engine-lit from blueprint
  // absorption; child-evidence nodes (WF05–07b, 09) only light on real 回传 —
  // a light must never claim children did something no evidence shows.
  { id: 'WF04a', name: '阶段一蓝图一次性输出', stage: 1 },
  { id: 'WF04', name: '主题预设网络图（教师备课用）', stage: 1 },
  { id: 'WF04b', name: '资源深度网络（物象·体验·关系·意义）', stage: 1 },
  { id: 'WF05', name: '建立共同经验（真实体验活动）', stage: 1 },
  { id: 'WF05b', name: '真实人物与生活场景访谈任务', stage: 1 },
  { id: 'WF06', name: '发掘幼儿已有相关知识', stage: 1 },
  { id: 'WF07', name: '发展幼儿想探究的问题（问题池·KWHL·问题墙）', stage: 1 },
  { id: 'WF07b', name: '儿童问题背后的文化可能性提示', stage: 1 },
  { id: 'WF08', name: '布置探索环境与时间（环创·材料·周月计划）', stage: 1 },
  { id: 'WF09', name: '阶段一回传与动态调整', stage: 1 },
  // 阶段2 目标与评估轴心
  { id: 'WF10', name: '核心概念性理解目标', stage: 2 },
  { id: 'WF11', name: '四维目标·关键经验', stage: 2 },
  { id: 'WF12', name: '四维目标·学习品质', stage: 2 },
  { id: 'WF13', name: '四维目标·社会交往', stage: 2 },
  { id: 'WF14', name: '四维目标·文化情境与目标阶梯', stage: 2 },
  { id: 'WF15', name: 'GRASPS表现性评估', stage: 2 },
  { id: 'WF16', name: '过程性证据计划', stage: 2 },
  // 阶段3 开启脑洞，协作行动
  { id: 'WF17', name: '大问题拆解', stage: 3 },
  { id: 'WF18', name: '收集儿童解决方案', stage: 3 },
  { id: 'WF19', name: '选择方案先尝试', stage: 3 },
  { id: 'WF20', name: '卡壳复盘', stage: 3 },
  { id: 'WF20b', name: '儿童学习阶段识别', stage: 3 },
  { id: 'WF20c', name: '文化语义回看', stage: 3 },
  { id: 'WF20d', name: '儿童差异观察与教师聚焦反馈', stage: 3 },
  { id: 'WF21', name: '下一轮循环与项目化信号提醒', stage: 3 },
  { id: 'WF22', name: '素材与资源支持', stage: 3 },
  // 阶段4 成果展示，迭代进化
  { id: 'WF23', name: '公共交付准备', stage: 4 },
  { id: 'WF24', name: '依据GRASPS评估', stage: 4 },
  { id: 'WF25', name: '产品回炉调优', stage: 4 },
  { id: 'WF26', name: '生成新项目问题', stage: 4 },
  { id: 'WF27', name: '迁移新应用场景', stage: 4 },
  // 阶段5 课程故事导出
  { id: 'WF28', name: '材料完整性检查', stage: 5 },
  { id: 'WF29', name: '叙事主线提炼', stage: 5 },
  { id: 'WF30', name: '图文结构生成', stage: 5 },
  { id: 'WF31', name: '目标与评估对照', stage: 5 },
  { id: 'WF31b', name: '文化育人价值复盘', stage: 5 },
  { id: 'WF32', name: '多版本导出', stage: 5 },
];

/** §1 principles — short names, in spec order. */
export const PRINCIPLES = [
  '状态机优先',
  '阶段判断优先',
  '证据优先',
  '教师资源意图优先',
  '儿童真实反应驱动调整',
  '文化可能性后台提示',
  '输出闭环固定',
];

/**
 * Conservative node dependency table (partial order), enforced delta-aware in
 * engine.applyDelta: marking a node completed requires its prerequisites in
 * state.completed_nodes OR in the same delta (set semantics — array order
 * inside one delta does not matter). Only orderings clearly required by the
 * V1.3 spec are listed: a false block is worse than a gap.
 * NOTE: WF20 卡壳复盘 deliberately has NO WF19 prerequisite — 过程中续聊 enters
 * mid-stream with an empty archive: the stuck attempt happened offline and
 * was never recorded, and 卡壳复盘 must still be able to run.
 * @type {Record<string, string[]>}
 */
export const NODE_PREREQS = {
  WF03b: ['WF01'],
  WF07: ['WF06'],
  WF07b: ['WF07'],
  // stage1-v1.0: WF08 is now 环境与计划 (no question-pool prerequisite), and
  // stage 2 must NOT be gated on a stage-1 driving question — the redesign
  // explicitly stops requiring 核心驱动问题 inside stage 1.
  WF15: ['WF10'],
  WF19: ['WF18'],
  WF20b: ['WF20'],
  WF21: ['WF20'],
  WF24: ['WF15'],
  WF29: ['WF28'],
  WF30: ['WF29'],
  WF31: ['WF29'],
  WF31b: ['WF29'],
  WF32: ['WF29'],
};
