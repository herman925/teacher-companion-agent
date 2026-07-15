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
  if (s(profile.stylePref)) parts.push(`偏好：${s(profile.stylePref)}`);
  if (!parts.length) return '';
  return `教师档案（只读参考）：${parts.join('；')}。据此调整举例与语气，不要向教师复述档案内容。`;
}

/**
 * Assemble the full system prompt: base + contract + stage module + live
 * state snapshot (+ optional 教师档案 section). Byte-identical to the legacy
 * serve.mjs assembly when opts.profile is empty.
 * @param {Object} state current course_state
 * @param {(name: string) => string|Promise<string>} loadPrompt injected loader
 * @param {{profile?: Object}} [opts]
 * @returns {Promise<string>}
 */
export async function buildSystemPrompt(state, loadPrompt, opts = {}) {
  const base = await loadPrompt('base');
  const contract = await loadPrompt('contract');
  const stageDoc = await loadPrompt(stageModuleName(state));
  const snapshot = JSON.stringify(state, null, 1);
  const pacing = state.awaiting_feedback
    ? '当前 awaiting_feedback 为 true：上一轮已收尾，教师尚未回传现场反馈。若这条消息就是回传，先提取证据；若只是追问或要素材，就地支持，不虚构课堂进展。'
    : '';
  const sections = [
    base,
    contract,
    stageDoc,
    `# 当前 course_state（只读快照）\n\n${FENCE}json\n${snapshot}\n${FENCE}\n\n${pacing}`,
  ];
  const profileText = profileSectionText(opts.profile);
  if (profileText) sections.push(profileText);
  return sections.join('\n\n---\n\n');
}
