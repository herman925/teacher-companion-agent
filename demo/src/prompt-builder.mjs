// prompt-builder.mjs — shared, pure system-prompt assembly (server + demo UI).
// Extracted from demo/serve.mjs so the SAME assembly runs on the server (fs
// loader) and in the browser (fetch loader, 开发者模式 prompt visibility).
// The prompt files in demo/src/prompts/ are read as-is and never modified.

/** Stage → prompt module name (stage 4 reuses the stage3 module by design). */
export const STAGE_MODULE = { 0: 'stage0', 1: 'stage1', 2: 'stage2', 3: 'stage3', 4: 'stage3', 5: 'stage5' };

/** @param {Object} state @returns {string} the prompt module name for a state */
export function stageModuleName(state) {
  return STAGE_MODULE[state?.stage] ?? 'stage0';
}

const FENCE = '```';

/**
 * 回应风格 → the exact directive injected into the system prompt. Single
 * source of truth: the profile UI builds its choices and its explanations
 * from this map, so the teacher reads precisely what the model is told.
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
  const styleDirective = STYLE_DIRECTIVES[s(profile.stylePref)];
  if (styleDirective) parts.push(`回应风格：${styleDirective}`);
  else if (s(profile.stylePref)) parts.push(`偏好：${s(profile.stylePref)}`);
  if (!parts.length) return '';
  return `教师档案（只读参考）：${parts.join('；')}。据此调整举例与语气，不要向教师复述档案内容。`;
}

/**
 * Assemble the full system prompt: base + contract + stage module + live
 * state snapshot (+ optional 教师档案 section). Byte-identical to the legacy
 * serve.mjs assembly when opts.profile is empty.
 * Kept for the debug drawer's mock reconstruction and prompt visibility;
 * real vendor requests use buildPromptParts so the volatile state snapshot
 * stops busting the vendors' automatic prefix caches.
 * @param {Object} state current course_state
 * @param {(name: string) => string|Promise<string>} loadPrompt injected loader
 * @param {{profile?: Object}} [opts]
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
    stateNoteText(state),
  ];
  const profileText = profileSectionText(opts.profile);
  if (profileText) sections.push(profileText);
  return sections.join('\n\n---\n\n');
}

/** The volatile per-turn section: live state snapshot + pacing note. */
export function stateNoteText(state) {
  const snapshot = JSON.stringify(state, null, 1);
  const pacing = state.awaiting_feedback
    ? '当前 awaiting_feedback 为 true：上一轮已收尾，教师尚未回传现场反馈。若这条消息就是回传，先提取证据；若只是追问或要素材，就地支持，不虚构课堂进展。'
    : '';
  return `# 当前 course_state（只读快照）\n\n${FENCE}json\n${snapshot}\n${FENCE}\n\n${pacing}`;
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
 * @returns {Promise<{system: string, stateNote: string}>}
 */
export async function buildPromptParts(state, loadPrompt, opts = {}) {
  const base = await loadPrompt('base');
  const contract = await loadPrompt('contract');
  const stageDoc = await loadPrompt(stageModuleName(state));
  const sections = [base, contract, stageDoc];
  const profileText = profileSectionText(opts.profile);
  if (profileText) sections.push(profileText);
  return { system: sections.join('\n\n---\n\n'), stateNote: stateNoteText(state) };
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
