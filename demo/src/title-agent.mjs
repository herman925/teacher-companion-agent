// title-agent — the interval harness for automatic course-title regeneration.
// A dedicated side-channel: its own tiny prompt, deterministic trigger, and
// output sanitation. It NEVER goes through the turn contract, and a human
// rename (title_locked) always wins (store.renameCourse auto guard).

// Kept in sync with json-store.mjs TITLE_MAX (asserted equal in tests) —
// this module must stay importable in the browser, json-store is Node-only.
export const TITLE_MAX = 16;

/** Allowed regen intervals (teacher prompts between regens) + default. */
export const TITLE_INTERVALS = [10, 20, 30, 40, 50];
export const TITLE_INTERVAL_DEFAULT = 10;

/**
 * Deterministic trigger: fire on every Nth teacher prompt.
 * @param {{teacherTurns: number, every: number, enabled: boolean, titleLocked: boolean}} p
 */
export function shouldRegenTitle({ teacherTurns, every, enabled, titleLocked }) {
  if (!enabled || titleLocked) return false;
  const n = Number(teacherTurns);
  const e = Number(every);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (!TITLE_INTERVALS.includes(e)) return false;
  return n % e === 0;
}

/**
 * Build the standalone naming prompt: recent conversation (truncated) + theme
 * fields. Deliberately minimal — one short completion, no contract, no state.
 * @param {Array<{role: string, content: string}>} history user/assistant rows
 * @param {Object} state course_state (theme fields only are read)
 * @returns {Array<{role: string, content: string}>}
 */
export function buildTitleMessages(history, state) {
  const recent = (history || []).slice(-6)
    .map((m) => `${m.role === 'assistant' ? '助手' : '老师'}：${String(m.content ?? '').slice(0, 200)}`)
    .join('\n');
  const theme = state?.theme_resource?.name ? `主题资源：${state.theme_resource.name}\n` : '';
  const band = state?.class_profile?.age_band ? `年龄段：${state.class_profile.age_band}\n` : '';
  return [
    { role: 'system', content: '你为一段幼儿园主题探究课程的对话起课程名。只输出课程名本身：不超过12个字，不带标点、引号、序号或任何解释。' },
    { role: 'user', content: `${theme}${band}最近对话：\n${recent}\n\n课程名：` },
  ];
}

/**
 * Sanitize a model-produced title. Returns null on anything unusable —
 * caller keeps the current title (naming is cosmetic, never worth a retry).
 * @param {string} raw
 * @returns {string|null}
 */
export function sanitizeTitle(raw) {
  if (typeof raw !== 'string') return null;
  let t = raw.trim()
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .split('\n')[0]
    .replace(/^[#>*\-\s]+/, '')
    .replace(/^["'「『《【\s]+|["'」』》】\s]+$/g, '')
    .replace(/[。．.，,！!？?；;：:]+$/g, '')
    .trim();
  if (!t) return null;
  if (t.startsWith('{') || t.startsWith('[')) return null; // JSON leak
  // Code-point-safe cap: String#slice would split emoji surrogate pairs.
  const points = [...t];
  if (points.length > TITLE_MAX) t = points.slice(0, TITLE_MAX).join('');
  return t;
}
