#!/usr/bin/env node
// pre-edit-guard.mjs — Claude Code PreToolUse hook for Edit|Write|MultiEdit.
//
// Reads a JSON object on STDIN: { "tool_name": "...", "tool_input": { "file_path": "..." } }
// and classifies the pending edit against harness/harness.config.json -> guard:
//
//   deny  -> refuse the edit            (permissionDecision: "deny", exit 0)
//   ask   -> ASK THE USER to confirm    (permissionDecision: "ask",  exit 0)
//   warn  -> allow with a note          (stderr note, exit 0)
//   else  -> allow silently             (exit 0)
//
// "ask" uses Claude Code's native confirmation prompt — the harness asks the user
// rather than hard-blocking or relying on an env override. When emitting a decision,
// STDOUT carries JSON ONLY (Claude Code requires valid JSON on stdout); notes use stderr.
//
// Defensive: empty/unparseable stdin or a missing file_path -> exit 0. Never break the
// session on a hook bug. Handles Windows and POSIX paths.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const BACKSLASH = String.fromCharCode(92);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DEFAULT_GUARD = {
  deny: [],
  ask: ['docs/glossary.json', 'harness/harness.config.json', '.claude/', 'source-docs/', '.githooks/'],
  warn: ['docs/adr/'],
};

function loadGuard() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'harness', 'harness.config.json'), 'utf8'));
    return Object.assign({}, DEFAULT_GUARD, cfg.guard || {});
  } catch { return DEFAULT_GUARD; }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(data); } };
    try {
      if (process.stdin.isTTY) { done(); return; }
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', done);
      process.stdin.on('error', done);
      const t = setTimeout(done, 2000);
      if (t.unref) t.unref();
    } catch { done(); }
  });
}

const norm = p => String(p).split(BACKSLASH).join('/').replace(/\/+/g, '/').replace(/\/+$/, '');
const base = p => { const n = norm(p); const i = n.lastIndexOf('/'); return i === -1 ? n : n.slice(i + 1); };

// Does a normalized path match a guard pattern?
function matches(p, pattern) {
  const name = base(p);
  if (pattern.endsWith('/')) {                 // directory: a path segment equals the dir
    const dir = pattern.slice(0, -1);
    return new RegExp('(^|/)' + dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(/|$)').test(p);
  }
  if (pattern.startsWith('*.')) return name.toLowerCase().endsWith(pattern.slice(1).toLowerCase());
  if (pattern.includes('/')) return p === pattern || p.endsWith('/' + pattern); // path suffix
  return name === pattern;                      // bare filename
}

function decision(kind, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: kind, permissionDecisionReason: reason },
  }));
  process.exit(0);
}
function warn(msg) { process.stderr.write(msg + '\n'); process.exit(0); }

async function main() {
  let raw;
  try { raw = (await readStdin()).trim(); } catch { process.exit(0); }
  if (!raw) process.exit(0);
  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }
  const fp = payload && payload.tool_input && payload.tool_input.file_path;
  if (!fp || typeof fp !== 'string') process.exit(0);

  const p = norm(fp);
  const rel = p.startsWith(norm(REPO) + '/') ? p.slice(norm(REPO).length + 1) : p; // repo-relative when possible
  const guard = loadGuard();
  const hit = list => (list || []).some(pat => matches(rel, pat) || matches(p, pat));

  if (hit(guard.deny)) {
    decision('deny', 'This path is locked by the harness (guard.deny). Refusing the edit. If this is truly intended, change it deliberately outside the agent.');
  }
  if (hit(guard.ask)) {
    decision('ask', 'This is a governance / source-of-truth file (guard.ask) — editing it changes what the harness enforces (source-docs/ is the immutable spec). Confirm you intend this change. Run `npm run gate` afterward.');
  }
  if (hit(guard.warn)) {
    warn('NOTE: editing a guarded path (guard.warn) — changes here affect decisions of record. Review carefully and run `npm run gate`.');
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
