#!/usr/bin/env node
// code-review.mjs — Lightweight static code review for the FUTURE demo source.
//
// A reusable, run-per-change check. It is a NO-OP today: there is no demo source
// yet, so it prints a skip-pass and exits 0. The moment code lands under
// demo/src/, it activates and scans for a curated antipattern checklist tuned
// for this web-based AI companion-chat platform.
//
// Checks:
//   P0  eval()                                   — unsafe, never needed here
//   P0  hardcoded secret literal                 — API keys belong server-side / in env
//   P1  hardcoded http:// URL                    — HTTPS only
//   P2  console.log/debug/info left in           — route through a gated logger
//   P2  TODO/FIXME without an issue reference    — track or resolve
//   P2  loose equality (== / !=)                 — use === / !==
//   P2  "moderation-todo" (heuristic, honest):   a file that writes LLM output into
//       the DOM (innerHTML / insertAdjacentHTML / document.write / outerHTML) without
//       passing it through a function named sanitize*. Content moderation (内容安全)
//       for generated content is a launch requirement; this placeholder only nudges —
//       the real moderation pipeline check lands with the runtime harness.
//
// Usage:  node harness/code-review.mjs [path...] [--json]
// Exit:   0 clean (no P0/P1) · 1 any P0/P1 finding · (P2/P3 never block)
//
// Pure Node, no dependencies. Cross-platform (Windows-safe).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ----------------------------------------------------------------- args
const argv = process.argv.slice(2);
const json = argv.includes('--json');
const explicitTargets = argv.filter(a => !a.startsWith('--'));

// Candidate application-source roots (first existing ones win when no explicit target).
const SOURCE_DIRS = [path.join('demo', 'src')];
const SOURCE_EXTS = ['.js', '.ts', '.mjs', '.html'];
const IGNORE = ['node_modules', '.git', 'dist', 'build', '.planning'];

function walk(target, out = []) {
  let stat;
  try { stat = fs.statSync(target); } catch { return out; }
  if (stat.isFile()) {
    if (SOURCE_EXTS.includes(path.extname(target).toLowerCase())) out.push(target);
    return out;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (IGNORE.includes(entry.name)) continue;
    const p = path.join(target, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (SOURCE_EXTS.includes(path.extname(entry.name).toLowerCase())) out.push(p);
  }
  return out;
}

// Resolve the set of files to review.
let targets;
if (explicitTargets.length) {
  targets = explicitTargets.map(t => path.resolve(ROOT, t));
} else {
  targets = SOURCE_DIRS.map(d => path.join(ROOT, d)).filter(d => fs.existsSync(d));
}

const files = [];
for (const t of targets) walk(t, files);
const uniqueFiles = [...new Set(files)];

// ------------------------------------------------ no-op until source lands
if (uniqueFiles.length === 0) {
  if (json) {
    process.stdout.write(JSON.stringify({
      tool: 'code-review',
      skipped: true,
      reason: 'no demo source yet',
      filesScanned: 0,
      findings: [],
      pass: true,
    }, null, 2) + '\n');
  } else {
    console.log('no demo source yet — code review skipped (pass)');
  }
  process.exit(0);
}

// ------------------------------------------------------------- the checklist
const findings = [];
const add = (severity, file, line, title, fix) =>
  findings.push({ severity, file: path.relative(ROOT, file), line, title, fix });

// Blank out string literals so the == / != operator check ignores prose inside
// strings. We DELIBERATELY keep strings for the http:// and secret checks
// (they target string literals).
function stripStrings(s) {
  return s.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
}

for (const file of uniqueFiles) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const lines = text.split(/\r?\n/);

  // file-level moderation-todo heuristic state
  let domWriteLine = 0;      // first line that writes into the DOM
  let hasSanitizer = false;  // any sanitize*( call anywhere in the file

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const n = i + 1;
    const codeForOps = stripStrings(raw);

    // P2: console.log left in
    if (/\bconsole\.(log|debug|info)\s*\(/.test(raw)) {
      add('P2', file, n, 'console.* left in source', 'Remove debug logging or route through a logger gated by env.');
    }

    // P2: TODO/FIXME without an issue reference (#123 / ISSUE-123 / a URL)
    const todo = raw.match(/\b(TODO|FIXME|HACK|XXX)\b/);
    if (todo && !/#\d+|[A-Z]+-\d+|https?:\/\//.test(raw)) {
      add('P2', file, n, `${todo[1]} without an issue reference`, `Add a tracking ref (e.g. ${todo[1]}(#123)) or resolve it.`);
    }

    // P2: loose equality (== / !=) — prefer === / !==
    if (/[^=!<>]==[^=]/.test(codeForOps) || /[^!]!=[^=]/.test(codeForOps)) {
      add('P2', file, n, 'loose equality (== or !=)', 'Use strict equality === / !== to avoid coercion bugs.');
    }

    // P1: hardcoded http:// URL — HTTPS only. Loopback is exempt: local dev
    // servers (opencode serve, the demo proxy) run plain HTTP with no TLS.
    if (/["'`]http:\/\//.test(raw) && !/["'`]http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/.test(raw)) {
      add('P1', file, n, 'hardcoded http:// URL', 'Use https:// for all network requests.');
    }

    // P0: eval(
    if (/\beval\s*\(/.test(raw)) {
      add('P0', file, n, 'use of eval()', 'Remove eval(); it is unsafe.');
    }

    // P0: secret-looking literal (api key / token assigned a string)
    if (/\b(app[_-]?secret|api[_-]?key|secret[_-]?key|access[_-]?token)\b\s*[:=]\s*["'`][^"'`]{8,}["'`]/i.test(raw)) {
      add('P0', file, n, 'hardcoded secret literal', 'Never commit secrets; load model-provider keys from a server/env, not client source.');
    }

    // DOM write path (LLM output rendered into the page)
    if (/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/.test(raw)) {
      if (!domWriteLine) domWriteLine = n;
    }
    // a sanitizer function referenced anywhere in the file
    if (/\bsanitize\w*\s*\(/i.test(raw)) {
      hasSanitizer = true;
    }
  }

  // P2 "moderation-todo": the file writes HTML into the DOM but never calls a
  // sanitize* function. Honest placeholder — a real moderation/injection check
  // arrives with the runtime harness; until then this only warns.
  if (domWriteLine && !hasSanitizer) {
    add('P2', file, domWriteLine, 'moderation-todo: DOM write without sanitize*()',
      'This file writes (possibly LLM-generated) HTML into the DOM without passing it through a sanitize* function. Route generated content through a sanitizer/moderation step (内容安全) before rendering.');
  }
}

// ------------------------------------------------------------------- output
const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
findings.sort((a, b) => (order[a.severity] - order[b.severity]) || a.file.localeCompare(b.file) || a.line - b.line);
const blocking = findings.filter(f => f.severity === 'P0' || f.severity === 'P1').length;
const pass = blocking === 0;

if (json) {
  process.stdout.write(JSON.stringify({
    tool: 'code-review',
    skipped: false,
    filesScanned: uniqueFiles.length,
    findings,
    pass,
  }, null, 2) + '\n');
  process.exit(pass ? 0 : 1);
}

console.log('=== Code Review ===');
console.log(`scanned ${uniqueFiles.length} demo source file(s)`);
if (!findings.length) {
  console.log('✓ No code-review findings.');
  process.exit(0);
}
for (const f of findings) {
  console.log(`[${f.severity}] ${f.title}`);
  console.log(`    ${f.file}:${f.line}`);
  console.log(`    fix: ${f.fix}`);
}
console.log('');
console.log(blocking ? `✗ ${blocking} blocking (P0/P1) finding(s).` : `${findings.length} non-blocking finding(s).`);
process.exit(pass ? 0 : 1);
