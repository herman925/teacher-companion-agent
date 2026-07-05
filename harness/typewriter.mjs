#!/usr/bin/env node
// typewriter.mjs — House-style content tool for 教师资源发展平台. Two modes:
//
//   GENERATE:  node harness/typewriter.mjs new <type> "<title>" [--out PATH]
//              types: adr | prd-section | research | readme-section
//              Scaffolds a doc/section in the project's bilingual house style.
//
//   LINT:      node harness/typewriter.mjs lint <path...> [--fix] [--json] [--strict]
//              Enforces house style on Markdown:
//                - CJK prose must use full-width punctuation ，。！？：；（） (P2, --fix auto-corrects CJK-adjacent ASCII punct)
//                - no trailing whitespace (P3, --fix)
//                - no tabs (P3, --fix -> 2 spaces)
//                - heading levels must not skip (h1->h3) (P2)
//
// Exit: 0 clean · 1 blocking (P2 found, or any with --strict) · 2 usage/IO error
// Pure Node, no dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { walk, read, proseLines, parseArgs, sevTag, c } from './lib/util.mjs';

const args = parseArgs(process.argv.slice(2));
const mode = args._[0];

// ------------------------------------------------------------------ GENERATE
function generate() {
  const type = args._[1];
  const title = args._[2] || 'Untitled';
  const today = process.env.TYPEWRITER_DATE || '<YYYY-MM-DD>'; // injected by caller; no nondeterministic clock here
  const tmpl = TEMPLATES[type];
  if (!tmpl) { process.stderr.write(`unknown type "${type}". types: ${Object.keys(TEMPLATES).join(', ')}\n`); process.exit(2); }
  const body = tmpl(title, today);
  const out = args.flags.out;
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, body, 'utf8');
    console.log(c.green(`✓ wrote ${out}`));
  } else {
    process.stdout.write(body);
  }
  process.exit(0);
}

const TEMPLATES = {
  adr: (t, d) => `# ADR-NNNN: ${t}

- **Status:** Proposed
- **Date:** ${d}
- **Deciders:** <names/roles>
- **Module / 模块:** <companion-agent | course-state | model-adapter | ...>

## Context / 背景
<EN: the forces at play, the constraint, what makes this hard to reverse.>

> 中文：促成本决策的背景与约束，以及为什么难以回退。

## Decision / 决策
<EN: the choice we are making, in one or two sentences.>

> 中文：我们做出的选择。

## Alternatives considered / 备选方案
1. **<option>** — <why rejected>

## Consequences / 影响
- **Positive / 正面:** <...>
- **Negative / 负面:** <...>
- **Compliance / 合规:** <内容安全 / PIPL / 生成式AI服务管理 implications, if any>
`,
  'prd-section': (t) => `### ${t}

**User stories / 用户故事**
1. As a <role 角色>, I want <feature 功能>, so that <benefit 收益>.

**Acceptance criteria / 验收标准**
- [ ] <Given/When/Then — observable, testable>

**Out of scope / 不在范围**
- <...>
`,
  research: (t, d) => `# Research: ${t}

> Updated: ${d}. Every claim cites a source URL inline. No guessing — unverified items go under "Open questions".

## Summary / 摘要

## Findings / 发现

## Recommendations & open questions / 建议与待确认
`,
  'readme-section': (t) => `## ${t}

<EN paragraph.>

> 中文段落。
`,
};

// ---------------------------------------------------------------------- LINT
function lint() {
  const fix = !!args.flags.fix;
  const json = !!args.flags.json;
  const strict = !!args.flags.strict;
  const targets = args._.slice(1);
  const files = [];
  for (const t of (targets.length ? targets : ['docs', 'README.md', 'README.zh-CN.md', 'CLAUDE.md', 'AGENTS.md'])) {
    files.push(...walk(t, ['.md', '.markdown']));
  }
  const findings = [];

  const ASCII2FULL = { ',': '，', '.': '。', '!': '！', '?': '？', ':': '：', ';': '；', '(': '（', ')': '）' };
  const isCJK = ch => /[一-鿿㐀-䶿]/.test(ch);
  // A line is "CJK-dominant" when CJK chars are >= 30% of its non-space characters.
  const cjkDominant = s => {
    const ns = s.replace(/\s/g, '').length;
    if (!ns) return false;
    const cjk = (s.match(/[一-鿿㐀-䶿]/g) || []).length;
    return cjk / ns >= 0.30;
  };

  for (const file of [...new Set(files)]) {
    let text = read(file);
    if (!text) continue;
    const rawLines = text.split(/\r?\n/);
    const annotated = proseLines(text);
    let headingLevels = [];
    let changed = false;

    for (let i = 0; i < rawLines.length; i++) {
      const meta = annotated[i];
      let line = rawLines[i];

      // trailing whitespace (P3) — always safe to fix, even in code
      if (/[ \t]+$/.test(line)) {
        findings.push({ severity: 'P3', file, line: i + 1, title: 'trailing whitespace', fix: 'trim end of line' });
        if (fix) { line = line.replace(/[ \t]+$/, ''); changed = true; }
      }
      // tabs (P3)
      if (/\t/.test(line)) {
        findings.push({ severity: 'P3', file, line: i + 1, title: 'tab character', fix: 'replace with 2 spaces' });
        if (fix) { line = line.replace(/\t/g, '  '); changed = true; }
      }

      if (meta.code) { rawLines[i] = line; continue; }

      // heading skip (P2)
      const h = line.match(/^(#{1,6})\s/);
      if (h) {
        const lvl = h[1].length;
        const prev = headingLevels[headingLevels.length - 1] || 0;
        if (prev && lvl > prev + 1) {
          findings.push({ severity: 'P2', file, line: i + 1, title: `heading jumps h${prev}→h${lvl}`, fix: `use h${prev + 1} or restructure` });
        }
        headingLevels.push(lvl);
      }

      // CJK-adjacent ASCII punctuation (P2). Only enforced on CJK-DOMINANT lines, so an
      // English sentence with an embedded 中文 term (e.g. "companion agent / 陪跑智能体, aka the coach")
      // keeps its English punctuation, while a real Chinese sentence gets full-width 标点.
      if (cjkDominant(meta.text)) {
        for (const [ascii, full] of Object.entries(ASCII2FULL)) {
          const re = new RegExp('\\' + ascii, 'g');
          let m;
          while ((m = re.exec(meta.text)) !== null) {
            const pos = m.index;
            const before = meta.text[pos - 1] || '';
            const after = meta.text[pos + 1] || '';
            if (ascii === '.' && /\d/.test(before) && /\d/.test(after)) continue; // numeric decimal
            if (isCJK(before) || isCJK(after)) {
              findings.push({ severity: 'P2', file, line: i + 1, title: `half-width "${ascii}" in CJK prose → "${full}"`, fix: `use full-width ${full}` });
            }
          }
        }
        // auto-fix CJK punctuation conservatively on the RAW line (skip URLs/code spans)
        if (fix) {
          const fixedRaw = fixCjkPunct(line, ASCII2FULL, isCJK);
          if (fixedRaw !== line) { line = fixedRaw; changed = true; }
        }
      }
      rawLines[i] = line;
    }

    if (fix && changed) { fs.writeFileSync(file, rawLines.join('\n'), 'utf8'); }
  }

  if (json) {
    const blocking = findings.filter(f => f.severity === 'P0' || f.severity === 'P1' || f.severity === 'P2').length;
    const pass = blocking === 0 && (!strict || findings.length === 0);
    process.stdout.write(JSON.stringify({ tool: 'typewriter-lint', findings, fixed: fix, pass }, null, 2) + '\n');
    process.exit(pass ? 0 : 1);
  }

  console.log(c.bold('=== Typewriter Lint ==='));
  if (!findings.length) { console.log(c.green('✓ House style clean.')); process.exit(0); }
  for (const f of findings) {
    console.log(`${sevTag(f.severity)} ${f.title}  ${c.dim(f.file + ':' + f.line)}`);
  }
  const blocking = findings.filter(f => ['P0', 'P1', 'P2'].includes(f.severity)).length;
  console.log('');
  if (fix) console.log(c.dim('(--fix applied: trailing whitespace, tabs, CJK-adjacent punctuation)'));
  console.log(blocking ? c.red(`✗ ${blocking} blocking style finding(s).`) : c.yellow(`${findings.length} polish finding(s).`));
  process.exit(blocking || (strict && findings.length) ? 1 : 0);
}

// Replace CJK-adjacent ASCII punctuation in a raw line, skipping inline-code spans and URLs.
function fixCjkPunct(line, map, isCJK) {
  // protect inline code and URLs by splitting
  const parts = line.split(/(`[^`]*`|https?:\/\/\S+)/);
  return parts.map(seg => {
    if (seg.startsWith('`') || /^https?:\/\//.test(seg)) return seg;
    let out = '';
    for (let i = 0; i < seg.length; i++) {
      const ch = seg[i];
      if (map[ch]) {
        const before = seg[i - 1] || '';
        const after = seg[i + 1] || '';
        if (ch === '.' && /\d/.test(before) && /\d/.test(after)) { out += ch; continue; }
        out += (isCJK(before) || isCJK(after)) ? map[ch] : ch;
      } else out += ch;
    }
    return out;
  }).join('');
}

// ---------------------------------------------------------------- DISPATCH
// Placed last so const TEMPLATES and all helpers are initialized before use.
if (mode === 'new') generate();
else if (mode === 'lint') lint();
else {
  process.stderr.write('usage: typewriter.mjs (new <type> "<title>") | (lint <path...> [--fix])\n');
  process.exit(2);
}
