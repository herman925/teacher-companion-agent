#!/usr/bin/env node
// post-edit-check.mjs — Claude Code PostToolUse hook for Edit|Write|MultiEdit.
//
// Reads { "tool_name": "...", "tool_input": { "file_path": "..." } } on STDIN.
// The edit has ALREADY happened; this hook lints the result and surfaces findings.
//
//   exit 2  -> stderr shown to Claude (so it can fix what it just wrote).
//   exit 0  -> silent / clean.
//
// Behavior:
//   - If the edited file is Markdown (.md/.markdown) and lives under the repo
//     (skip node_modules / .git): run, against the file,
//        node harness/typewriter.mjs lint <file> --json
//        node harness/glossary-check.mjs <file> --json
//     Parse JSON; if either reports pass:false, print a concise human summary
//     (file:line + fix) to stderr and exit 2.
//   - If docs/glossary.json was edited: remind to run `npm run gate`, exit 0.
//   - Any internal error -> exit 0 (never block the human's workflow on a hook bug).
//
// Repo root is resolved from import.meta.url (.claude/hooks -> two levels up),
// NOT from cwd, so the hook is location-independent.

import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const BACKSLASH = String.fromCharCode(92);
const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HOOK_DIR, '..', '..'); // .claude/hooks -> repo root

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(data); } };
    try {
      if (process.stdin.isTTY) { done(); return; }
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', done);
      process.stdin.on('error', done);
      const t = setTimeout(done, 2000);
      if (t.unref) t.unref();
    } catch {
      done();
    }
  });
}

function norm(p) {
  return String(p).split(BACKSLASH).join('/').replace(/\/+/g, '/');
}

// Run a harness checker on a single file and return { pass, findings } or null on failure.
function runChecker(scriptRel, file) {
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'harness', scriptRel.script), ...scriptRel.pre, file, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const out = (r.stdout || '').trim();
    if (!out) return null;
    // The JSON may be preceded/followed by stray output; grab the first {...} block.
    const start = out.indexOf('{');
    const end = out.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;
    return JSON.parse(out.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function main() {
  let raw;
  try {
    raw = (await readStdin()).trim();
  } catch {
    process.exit(0);
  }
  if (!raw) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const ti = payload && payload.tool_input;
  const filePath = ti && ti.file_path;
  if (!filePath || typeof filePath !== 'string') process.exit(0);

  const np = norm(filePath);

  // Skip files outside the repo, or inside vendored/VCS dirs.
  const nroot = norm(ROOT);
  const inRepo = np.toLowerCase().startsWith(nroot.toLowerCase() + '/') || np.toLowerCase() === nroot.toLowerCase();
  if (/(^|\/)(node_modules|\.git)\//.test(np)) process.exit(0);

  // Reminder when the glossary itself was edited.
  if (/(^|\/)docs\/glossary\.json$/.test(np)) {
    process.stderr.write('NOTE: docs/glossary.json was edited. Run `npm run gate` to re-validate all docs against the new terminology source of truth.\n');
    process.exit(0);
  }

  // Only lint Markdown under the repo.
  const ext = path.extname(np).toLowerCase();
  if (ext !== '.md' && ext !== '.markdown') process.exit(0);
  if (!inRepo) process.exit(0);

  let typewriter, glossary;
  try {
    typewriter = runChecker({ script: 'typewriter.mjs', pre: ['lint'] }, filePath);
    glossary = runChecker({ script: 'glossary-check.mjs', pre: [] }, filePath);
  } catch {
    process.exit(0); // never block on hook bug
  }

  const lines = [];

  if (typewriter && typewriter.pass === false) {
    const blocking = (typewriter.findings || []).filter(f => ['P0', 'P1', 'P2'].includes(f.severity));
    if (blocking.length) {
      lines.push('House style (typewriter) — ' + blocking.length + ' blocking finding(s):');
      for (const f of blocking.slice(0, 12)) {
        lines.push('  ' + relish(f.file) + ':' + f.line + '  ' + f.title + (f.fix ? '  → ' + f.fix : ''));
      }
    }
  }

  if (glossary && glossary.pass === false) {
    const blocking = (glossary.findings || []).filter(f => ['P0', 'P1'].includes(f.severity));
    if (blocking.length) {
      lines.push('Glossary — ' + blocking.length + ' terminology violation(s):');
      for (const f of blocking.slice(0, 12)) {
        lines.push('  ' + relish(f.file) + ':' + f.line + '  ' + f.title + (f.fix ? '  → ' + f.fix : ''));
      }
    }
  }

  if (lines.length) {
    process.stderr.write(
      'Post-edit checks flagged the file you just wrote. Please fix:\n' +
      lines.join('\n') + '\n'
    );
    process.exit(2);
  }

  process.exit(0);
}

// Show a repo-relative path when possible, for tidy messages.
function relish(f) {
  if (!f) return '';
  const nf = norm(f);
  const nroot = norm(ROOT);
  if (nf.toLowerCase().startsWith(nroot.toLowerCase() + '/')) return nf.slice(nroot.length + 1);
  return nf;
}

main().catch(() => process.exit(0));
