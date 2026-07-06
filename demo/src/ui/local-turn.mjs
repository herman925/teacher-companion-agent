// local-turn.mjs — run the mock turn pipeline entirely in the browser, so the
// demo (演示模式) works on static hosting (e.g. GitHub Pages) with no proxy.
// Mirrors demo/serve.mjs runTurn for provider === 'mock': mockTurn → L2/L3 → engine.
// The same pure modules the server uses; no network, no API key.

import { mockTurn } from '../mock.mjs';
import { parseTurn, validateTurn, safeTemplate } from '../harness.mjs';
import { applyDelta, createInitialState, STAGE_NAMES } from '../engine.mjs';

/**
 * @param {Object} state current course_state
 * @param {Array} history prior chat messages ({role, content})
 * @param {string} message the teacher's message
 * @returns {Object} the same "turn" event shape serve.mjs emits
 */
export function runLocalMockTurn(state, history, message) {
  const cur = state && state.course_id ? state : createInitialState(`course-${Date.now()}`);
  const payload = mockTurn(cur, history || [], message);
  const parsed = parseTurn(payload);
  const violations = parsed.turn ? validateTurn(parsed.turn, cur) : parsed.violations;
  const blocking = violations.filter((v) => v.action === 'block');
  const ok = Boolean(parsed.turn) && blocking.length === 0;
  const turn = ok ? parsed.turn : safeTemplate(cur);
  const applied = applyDelta(cur, turn.state_delta, { roundComplete: turn.round_complete, teacherTurn: true });
  return {
    turn,
    state: applied.state,
    gate_report: { ok, violations: [...violations, ...applied.violations], attempt: 1, degraded: !ok },
    provider: 'mock',
    providerLabel: '演示模式',
    usage: null,
    stageName: STAGE_NAMES[applied.state.stage],
  };
}
