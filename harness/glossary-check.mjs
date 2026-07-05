#!/usr/bin/env node
// glossary-check.mjs — Keyword glossary checker for 教师资源发展平台.
//
// Reads docs/glossary.json (the single source of truth) and scans Markdown/text
// for terminology problems:
//   1. forbidden variants  -> P1 (a non-canonical synonym is used, e.g. 聊天机器人 vs 陪跑智能体)
//   2. undefined CJK term-like tokens are NOT flagged (too noisy) — we only enforce the known list
//
// Usage:  node harness/glossary-check.mjs <path...> [--json] [--strict] [--glossary PATH]
// Exit:   0 clean (or only P3) · 1 found P1/P2 (or P3 with --strict) · 2 usage/IO error
//
// Pure Node, no dependencies. Cross-platform.

import { walk, read, proseLines, parseArgs, loadGlossary, sevTag, c } from './lib/util.mjs';

const args = parseArgs(process.argv.slice(2));
const json = !!args.flags.json;
const strict = !!args.flags.strict;
// source-docs/ is the immutable upstream spec — never scanned (it legitimately
// predates the canonical glossary and may use pre-normalization wording).
const targets = args._.length ? args._ : ['docs', 'README.md', 'README.zh-CN.md', 'CLAUDE.md', 'AGENTS.md'];

const glossary = loadGlossary(args.flags.glossary);
if (!glossary) {
  process.stderr.write('glossary-check: cannot load docs/glossary.json\n');
  process.exit(2);
}

// Build a lookup of forbidden variant -> canonical term.
const forbidden = [];
for (const t of glossary.terms) {
  for (const v of t.variants_forbidden || []) {
    forbidden.push({ variant: v, canonical_zh: t.zh, canonical_en: t.en, id: t.id, ref: t.conflict_ref });
  }
}
// Canonical terms (longest first) are masked out of each line BEFORE searching for
// a forbidden variant, so a generic variant that is a substring of a canonical term
// never produces a false positive. The mask is computed PER VARIANT: a canonical
// term that is itself a substring of the variant being searched (e.g. canonical
// 输出闭环 inside forbidden 输出闭环四件套) is NOT masked for that variant, so the
// longer forbidden form still fires.
const canonical = glossary.terms.map(t => t.zh).filter(Boolean).sort((a, b) => b.length - a.length);
const maskLineFor = (txt, variant) => {
  let m = txt;
  for (const canon of canonical) {
    if (variant.includes(canon)) continue;
    if (m.includes(canon)) m = m.split(canon).join(' '.repeat(canon.length));
  }
  return m;
};

const findings = [];
const files = [];
for (const t of targets) files.push(...walk(t, ['.md', '.markdown', '.txt']));

for (const file of [...new Set(files)]) {
  // docs/research holds external reference material that legitimately cites other
  // platforms' own wording; it is not project-authored domain prose.
  if (/[\\/]research[\\/]/.test(file) || /[\\/]source-docs[\\/]/.test(file)) continue;
  const text = read(file);
  if (!text) continue;
  const lines = proseLines(text);
  for (const ln of lines) {
    if (ln.code) continue;
    for (const f of forbidden) {
      // Skip lines that legitimately quote the forbidden term while defining it:
      // the glossary mirror's "*Avoid:* …" catalogue, legacy-name notes, and ADR refs.
      if (/variants_forbidden|legacy name|旧称|conflict_ref|ADR-|Avoid:|避免/.test(ln.raw)) continue;
      const masked = maskLineFor(ln.text, f.variant);
      let idx = masked.indexOf(f.variant);
      while (idx !== -1) {
        findings.push({
          severity: 'P1', file, line: ln.n, term: f.variant,
          title: `Forbidden variant "${f.variant}" — use canonical "${f.canonical_zh}" (${f.canonical_en})`,
          fix: `Replace "${f.variant}" with "${f.canonical_zh}"${f.ref ? ` (see ${f.ref})` : ''}.`,
        });
        idx = masked.indexOf(f.variant, idx + f.variant.length);
      }
    }
  }
}

if (json) {
  const pass = findings.filter(f => f.severity === 'P0' || f.severity === 'P1').length === 0 && (!strict || findings.length === 0);
  process.stdout.write(JSON.stringify({ tool: 'glossary-check', filesScanned: new Set(files).size, findings, pass }, null, 2) + '\n');
  process.exit(pass ? 0 : 1);
}

console.log(c.bold('=== Glossary Check ==='));
console.log(c.dim(`scanned ${new Set(files).size} file(s) against ${glossary.terms.length} canonical terms, ${forbidden.length} forbidden variants`));
if (!findings.length) {
  console.log(c.green('✓ No terminology violations.'));
  process.exit(0);
}
for (const f of findings) {
  console.log(`${sevTag(f.severity)} ${f.title}`);
  console.log(c.dim(`    ${f.file}:${f.line}`));
  console.log(`    fix: ${f.fix}`);
}
const blocking = findings.filter(f => f.severity === 'P0' || f.severity === 'P1').length;
console.log('');
console.log(blocking ? c.red(`✗ ${blocking} blocking terminology finding(s).`) : c.yellow(`${findings.length} non-blocking finding(s).`));
process.exit(blocking || (strict && findings.length) ? 1 : 0);
