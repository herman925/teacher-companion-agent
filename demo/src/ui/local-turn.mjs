// local-turn.mjs — run the mock turn pipeline entirely in the browser, so the
// demo (演示模式) works on static hosting (e.g. GitHub Pages) with no proxy.
// Mirrors demo/serve.mjs runTurn for provider === 'mock': mockTurn → L2/L3 → engine.
// The same pure modules the server uses; no network, no API key.

import { mockTurn } from '../mock.mjs';
import { parseTurn, validateTurn, safeTemplate } from '../harness.mjs';
import { applyDelta, absorbBlueprint, applyBlueprintDelta, createInitialState, STAGE_NAMES } from '../engine.mjs';

/**
 * @param {Object} state current course_state
 * @param {Array} history prior chat messages ({role, content})
 * @param {string} message the teacher's message
 * @returns {Object} the same "turn" event shape serve.mjs emits
 */
export function runLocalMockTurn(state, history, message, opts = {}) {
  const cur = state && state.course_id ? state : createInitialState(`course-${Date.now()}`);
  const payload = mockTurn(cur, history || [], message, opts);
  const parsed = parseTurn(payload);
  const violations = parsed.turn ? validateTurn(parsed.turn, cur, { stylePref: opts.profile?.stylePref }) : parsed.violations;
  const blocking = violations.filter((v) => v.action === 'block');
  const ok = Boolean(parsed.turn) && blocking.length === 0;
  const turn = ok ? parsed.turn : safeTemplate(cur);
  const applied = applyDelta(cur, turn.state_delta, { roundComplete: turn.round_complete, teacherTurn: true });
  applied.state = absorbBlueprint(applied.state, turn, { teacherTurn: true }).state;
  applied.state = applyBlueprintDelta(applied.state, turn.blueprint_delta, { teacherTurn: true }).state;
  // Transparency parity with the server path: one "attempt" whose response is the
  // scripted mock payload (no network). The system prompt rides in prompt_debug.
  const api_debug = {
    provider: 'mock',
    model: '（演示脚本）',
    base_url: '',
    kind: 'mock',
    chain_errors: [],
    attempts: [{
      attempt: 1,
      provider: 'mock',
      endpoint: '（无 API 调用 · 本地演示脚本）',
      model: '（演示脚本）',
      strategy: 'mock',
      request_messages: [...(history || []).map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: message }],
      response_raw: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      usage: null,
      elapsed_ms: 0,
      parsed_ok: Boolean(parsed.turn),
      violations: violations.map((v) => ({ kind: v.kind, action: v.action, detail: v.detail })),
      blocking_count: blocking.length,
      decision: ok ? 'accepted' : 'degraded',
      feedback_injected: null,
    }],
  };
  return {
    turn,
    state: applied.state,
    gate_report: { ok, violations: [...violations, ...applied.violations], attempt: 1, degraded: !ok },
    provider: 'mock',
    providerLabel: '演示模式',
    usage: null,
    stageName: STAGE_NAMES[applied.state.stage],
    api_debug,
  };
}
