// schema-check — validates harness/schema/course-state.schema.json (structural
// sanity, zero-dep — not a full JSON Schema validator) and cross-checks that the
// demo's turn schema and engine agree with it on field names.
//
// Guards against the classic drift: someone renames a spec §2 field in one of the
// three places (schema / engine whitelist / adapter TURN_SCHEMA) and not the others.
//
// Usage: node harness/schema-check.mjs [--json]

import path from 'node:path';
import fs from 'node:fs';
import { ROOT, read, parseArgs, c, sevTag } from './lib/util.mjs';

const args = parseArgs(process.argv.slice(2));
const findings = [];
const F = (severity, file, msg) => findings.push({ severity, file, msg });

const SCHEMA_PATH = path.join(ROOT, 'harness', 'schema', 'course-state.schema.json');

// Spec §2 field inventory (source-docs/workflow-v1.3.zh-CN.md) — the schema must cover all of these.
const SPEC_FIELDS = [
  'course_id', 'teacher_mode', 'class_profile', 'theme_resource', 'teacher_resource_intent',
  'resource_entry_card', 'theme_fit_level', 'children_evidence', 'child_question_pool',
  'driving_question', 'goals_assessment_axis', 'cycle_history', 'child_learning_stage',
  'project_signal_level', 'story_materials', 'child_participation_difference', 'teacher_focus_feedback',
];
// course_plan_blueprint is platform-side: ENGINE-written (absorbed from
// blueprint artifacts, ADR-0003 Phase 3), never model-writable via state_delta.
const PLATFORM_FIELDS = ['stage', 'completed_nodes', 'awaiting_feedback', 'pending_confirmations', 'schema_version', 'course_plan_blueprint'];

let schema = null;
if (!fs.existsSync(SCHEMA_PATH)) {
  F('P0', 'harness/schema/course-state.schema.json', 'schema file missing');
} else {
  try {
    schema = JSON.parse(read(SCHEMA_PATH));
  } catch (e) {
    F('P0', 'harness/schema/course-state.schema.json', `invalid JSON: ${e.message}`);
  }
}

if (schema) {
  const props = schema.properties || {};
  for (const f of [...SPEC_FIELDS, ...PLATFORM_FIELDS]) {
    if (!props[f]) F('P1', 'course-state.schema.json', `spec/platform field missing from schema: ${f}`);
  }
  for (const key of Object.keys(props)) {
    if (![...SPEC_FIELDS, ...PLATFORM_FIELDS, 'project_signals'].includes(key)) {
      F('P2', 'course-state.schema.json', `schema declares field not in spec inventory: ${key} (update SPEC_FIELDS here if intentional)`);
    }
  }
  if (schema.additionalProperties !== false) F('P1', 'course-state.schema.json', 'additionalProperties must be false (fabrication surface)');
  // enum sanity for the state machine's core dimensions
  const enumOf = (p) => props[p]?.enum || props[p]?.items?.enum || [];
  if (enumOf('teacher_mode').length !== 5) F('P1', 'course-state.schema.json', 'teacher_mode must have exactly the five spec entry modes');
  if (enumOf('child_learning_stage').length !== 5) F('P1', 'course-state.schema.json', 'child_learning_stage must have the five spec stages');
  if (!(props.stage?.maximum === 5 && props.stage?.minimum === 0)) F('P1', 'course-state.schema.json', 'stage must be bounded 0..5');
}

// Cross-check: engine whitelist and adapter turn schema agree with the state schema.
const enginePath = path.join(ROOT, 'demo', 'src', 'engine.mjs');
const adapterPath = path.join(ROOT, 'demo', 'src', 'adapter.mjs');
if (schema && fs.existsSync(enginePath)) {
  const engineSrc = read(enginePath);
  // course_id is platform identity — deliberately NOT model-writable.
  for (const f of SPEC_FIELDS.filter((x) => x !== 'course_id')) {
    if (!engineSrc.includes(`'${f}'`)) F('P1', 'demo/src/engine.mjs', `engine WRITABLE whitelist is missing spec field: ${f}`);
  }
  if (/WRITABLE = new Set\(\[[^\]]*'course_id'/.test(engineSrc)) {
    F('P1', 'demo/src/engine.mjs', 'course_id must NOT be model-writable (platform identity field)');
  }
}
if (fs.existsSync(adapterPath)) {
  const adapterSrc = read(adapterPath);
  for (const key of ['reply_markdown', 'question', 'artifacts', 'closure_loop', 'state_delta', 'evidence_refs', 'round_complete']) {
    if (!adapterSrc.includes(key)) F('P1', 'demo/src/adapter.mjs', `TURN_SCHEMA is missing turn-contract field: ${key}`);
  }
}

const blocking = findings.filter((f) => f.severity === 'P0' || f.severity === 'P1');
if (args.flags.json) {
  console.log(JSON.stringify({ pass: blocking.length === 0, findings }, null, 2));
} else {
  if (!findings.length) console.log(c.green('✓ schema-check: course_state schema + engine + adapter agree'));
  for (const f of findings) console.log(`${sevTag(f.severity)} ${f.file} — ${f.msg}`);
}
process.exit(blocking.length ? 1 : 0);
