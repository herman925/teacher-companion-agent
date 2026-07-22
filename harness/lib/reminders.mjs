// reminders.mjs — Pure decision logic for the gate's guidance reminders.
//
// Extracted from gate.mjs so the "does the guidance fire in the right situation?"
// behavior is unit-testable without git mutation. Given the repo root, the list of
// files staged in the pending commit, and the harness config, it returns one entry
// per reminder describing whether it fires, at what level, and the message.
//
//   handoff     — a commit should update the tracked HANDOFF.md (run /handoff).
//                 Soft (warn-level) by default: HANDOFF.md may not exist yet in
//                 this young repo, so the reminder nudges without blocking.
//   tempCleanup — scratch/temp paths are non-empty; prompt a cleanup.
//   exportDuty  — a NEW client-state key (cst.*) is staged in demo/src/ui/
//                 without any export/observability surface in the same commit
//                 (DESIGN.md §6b: a feature is not designed until its data
//                 trail is designed). Deterministic proxy, warn-level: it
//                 cannot prove the consideration happened, only notice when
//                 it visibly did not.
//
// Pure except for fs.existsSync against rootDir (so tests point rootDir at a temp dir).

import fs from 'node:fs';
import path from 'node:path';

const norm = s => String(s).replace(/\\/g, '/');

// True if the path exists and (for a directory) contains at least one entry.
function nonEmpty(p) {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return true;
    return fs.readdirSync(p).length > 0;
  } catch { return false; }
}

export function computeReminders({ rootDir, stagedFiles = [], config = {}, uiStagedDiff = '' }) {
  const level = (name, dflt) => (config.checks && config.checks[name] && config.checks[name].level) || dflt;
  const staged = stagedFiles.map(norm);
  const committing = staged.length > 0;
  const out = [];

  // ---- handoff ----
  const hLevel = level('handoff', 'warn');
  if (hLevel !== 'off') {
    const handoffFile = norm((config.handoff && config.handoff.file) || 'HANDOFF.md');
    const exists = fs.existsSync(path.join(rootDir, handoffFile));
    const handoffStaged = staged.includes(handoffFile);
    if (!exists) {
      out.push({ name: 'handoff', fire: true, level: hLevel, msg: `${handoffFile} is missing. Run /handoff and capture it into ${handoffFile} (tracked, not gitignored).` });
    } else if (committing && !handoffStaged) {
      out.push({ name: 'handoff', fire: true, level: hLevel, msg: `This commit does not update ${handoffFile}. Run /handoff and refresh it so the next session/agent can continue.` });
    } else {
      out.push({ name: 'handoff', fire: false, level: hLevel });
    }
  }

  // ---- temp cleanup ----
  const tLevel = level('tempCleanup', 'warn');
  if (tLevel !== 'off') {
    const paths = (config.tempCleanup && config.tempCleanup.paths) || ['tmp/', '.scratch/'];
    const present = paths.filter(p => nonEmpty(path.join(rootDir, p)));
    out.push(present.length
      ? { name: 'tempCleanup', fire: true, level: tLevel, msg: `Temp clutter detected (${present.join(', ')}). Review and clean it, or run \`npm run clean:temp -- --apply\` (a temp-janitor style review should confirm before deleting).` }
      : { name: 'tempCleanup', fire: false, level: tLevel });
  }

  // ---- export duty (DESIGN.md §6b / AGENTS.md observable-and-exportable rule) ----
  const eLevel = level('exportDuty', 'warn');
  if (eLevel !== 'off') {
    const keyRe = /['"](cst\.[A-Za-z0-9_.-]+)['"]/g;
    // New keys = keys on added lines that are not also on removed lines — a
    // moved/reformatted existing key must not fire.
    const keysOn = (prefix) => {
      const keys = new Set();
      for (const line of String(uiStagedDiff).split('\n')) {
        if (!line.startsWith(prefix)) continue;
        if (line.startsWith('+++') || line.startsWith('---')) continue; // diff headers
        for (const m of line.matchAll(keyRe)) keys.add(m[1]);
      }
      return keys;
    };
    const removed = keysOn('-');
    const fresh = [...keysOn('+')].filter(k => !removed.has(k));
    const surfaces = (config.exportDuty && config.exportDuty.observabilityPaths) || [
      'demo/src/ui/session-log.mjs', 'demo/serve.mjs', 'demo/src/store/', 'demo/DESIGN.md',
    ];
    const touched = surfaces.some(p => {
      const s = norm(p);
      return s.endsWith('/') ? staged.some(f => f.startsWith(s)) : staged.includes(s);
    });
    out.push(fresh.length && !touched
      ? { name: 'exportDuty', fire: true, level: eLevel, msg: `New client-state key(s) ${fresh.join(', ')} staged without touching any export/observability surface (session-log / serve / store / DESIGN.md). DESIGN.md §6b: a feature is not designed until its data trail is designed — wire the exports, or state in DESIGN.md why this state is client-only.` }
      : { name: 'exportDuty', fire: false, level: eLevel });
  }

  return out;
}
