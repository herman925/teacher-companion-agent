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
 * @param {{region?: string, ageBand?: string, classSize?: string|number, stylePref?: string}|null|undefined} profile
 */
export function profileSectionText(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const parts = [];
  const region = String(profile.region ?? '').trim();
  const ageBand = String(profile.ageBand ?? '').trim();
  const classSize = String(profile.classSize ?? '').trim();
  const stylePref = String(profile.stylePref ?? '').trim();
  if (region) parts.push(`地区：${region}`);
  if (ageBand) parts.push(`年段：${ageBand}`);
  if (classSize) parts.push(`班额：${classSize}`);
  if (stylePref) parts.push(`偏好：${stylePref}`);
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
