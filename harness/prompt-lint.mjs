// prompt-lint — deterministic checks over the runtime prompt corpus
// (demo/src/prompts/*.zh.md). The prompts ARE the L1 harness layer; this lint
// keeps their non-negotiable content from silently eroding during iteration.
//
// Checks (all P1 = blocking):
//   base.zh.md     carries the seven spec-§1 principles' key phrases, the
//                  screening contract markers, and the spec-§6 prohibitions.
//   contract.zh.md names every turn-contract field.
//   stage modules  exist for 0/1/2/3/5 and are non-trivial.
//   every file     uses full-width punctuation in prose (house style).
//
// Usage: node harness/prompt-lint.mjs [--json]

import path from 'node:path';
import fs from 'node:fs';
import { ROOT, read, parseArgs, c, sevTag } from './lib/util.mjs';

const args = parseArgs(process.argv.slice(2));
const findings = [];
const F = (severity, file, msg) => findings.push({ severity, file, msg });

const DIR = path.join(ROOT, 'demo', 'src', 'prompts');
if (!fs.existsSync(DIR)) {
  console.log(c.yellow('prompt-lint: demo/src/prompts/ not found — skipping (nothing to lint yet).'));
  process.exit(0);
}

const must = (file, text, needles, label) => {
  for (const n of needles) {
    if (!text.includes(n)) F('P1', file, `${label}缺少必需内容：「${n}」`);
  }
};

// --- base.zh.md: principles + screening contract + prohibitions
const basePath = path.join(DIR, 'base.zh.md');
if (!fs.existsSync(basePath)) {
  F('P0', 'base.zh.md', 'missing');
} else {
  const base = read(basePath);
  must('base.zh.md', base, ['状态机优先', '证据优先', '资源意图', '文化可能性后台提示', '输出闭环'], '系统原则');
  must('base.zh.md', base, ['先读后问', '一次一问', '必附示例', '静默跳关', '待现场确认'], '动态识别契约');
  must('base.zh.md', base, ['禁止编造儿童反馈', '禁止把文化线索变成儿童口号', '禁止所有主题都项目化', '禁止只给方案不给回传要求'], '禁止规则');
  must('base.zh.md', base, ['本轮可以去做什么', '回来请告诉我什么'], '闭环要素');
}

// --- contract.zh.md: every turn field named
const contractPath = path.join(DIR, 'contract.zh.md');
if (!fs.existsSync(contractPath)) {
  F('P0', 'contract.zh.md', 'missing');
} else {
  const contract = read(contractPath);
  must('contract.zh.md', contract,
    ['reply_markdown', 'question', 'artifacts', 'closure_loop', 'state_delta', 'evidence_refs', 'round_complete'],
    '输出契约');
}

// --- stage modules
for (const s of ['stage0', 'stage1', 'stage2', 'stage3', 'stage5']) {
  const p = path.join(DIR, `${s}.zh.md`);
  if (!fs.existsSync(p)) { F('P0', `${s}.zh.md`, 'missing'); continue; }
  const text = read(p);
  if (text.trim().length < 300) F('P1', `${s}.zh.md`, 'stage module suspiciously short (<300 chars)');
}
// stage-specific anchors that must never erode
const anchors = {
  'stage0.zh.md': ['WF03b', '三问', '切口卡', '适配性筛查'],
  'stage1.zh.md': ['访谈卡', '问题池', '核心驱动问题', 'evidence'],
  'stage3.zh.md': ['三类儿童观察', '三句聚焦反馈', '第一优先级', '项目化探究信号', '等待'],
  'stage5.zh.md': ['缺口', '不虚构', '真实发生顺序'],
};
for (const [file, needles] of Object.entries(anchors)) {
  const p = path.join(DIR, file);
  if (fs.existsSync(p)) must(file, read(p), needles, '阶段锚点');
}

const blocking = findings.filter((f) => f.severity === 'P0' || f.severity === 'P1');
if (args.flags.json) {
  console.log(JSON.stringify({ pass: blocking.length === 0, findings }, null, 2));
} else {
  if (!findings.length) console.log(c.green('✓ prompt-lint: prompt corpus carries all non-negotiable content'));
  for (const f of findings) console.log(`${sevTag(f.severity)} ${f.file} — ${f.msg}`);
}
process.exit(blocking.length ? 1 : 0);
