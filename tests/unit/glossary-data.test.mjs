// tests/unit/glossary-data.test.mjs
//
// Validates docs/glossary.json integrity directly (no CLI). The glossary is the
// single source of truth that both glossary-check.mjs and wording_judge.py read,
// so a data bug here silently corrupts every terminology check. These cases catch
// the classic mistakes: malformed JSON, missing fields, duplicate ids/terms, a
// term listing its own canonical form as a forbidden variant, and a "forbidden
// variant" that is actually another term's canonical name. Pure node:test.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const GLOSSARY_PATH = path.join(ROOT, 'docs', 'glossary.json');

function loadGlossary() {
  const raw = fs.readFileSync(GLOSSARY_PATH, 'utf8');
  return JSON.parse(raw); // throws on invalid JSON — case 1 covers that
}

test('glossary.json is valid JSON and every term has id/zh/en/category', () => {
  const g = loadGlossary();
  assert.ok(Array.isArray(g.terms), 'glossary.terms must be an array');
  assert.ok(g.terms.length > 0, 'glossary must contain at least one term');
  for (const t of g.terms) {
    for (const field of ['id', 'zh', 'en', 'category']) {
      assert.ok(
        typeof t[field] === 'string' && t[field].length > 0,
        `term ${JSON.stringify(t.id ?? t)} is missing required field "${field}"`,
      );
    }
  }
});

test('term ids are unique and zh values are unique', () => {
  const g = loadGlossary();
  const ids = g.terms.map(t => t.id);
  const zhs = g.terms.map(t => t.zh);
  assert.equal(new Set(ids).size, ids.length, `duplicate id(s): ${dupes(ids).join(', ')}`);
  assert.equal(new Set(zhs).size, zhs.length, `duplicate zh value(s): ${dupes(zhs).join(', ')}`);
});

test('no term lists its own canonical zh inside variants_forbidden', () => {
  const g = loadGlossary();
  for (const t of g.terms) {
    const variants = t.variants_forbidden || [];
    assert.ok(
      !variants.includes(t.zh),
      `term "${t.id}" (${t.zh}) lists its own canonical form as a forbidden variant`,
    );
  }
});

test('no forbidden variant equals any term\'s canonical zh', () => {
  const g = loadGlossary();
  const canonical = new Set(g.terms.map(t => t.zh));
  for (const t of g.terms) {
    for (const v of t.variants_forbidden || []) {
      assert.ok(
        !canonical.has(v),
        `forbidden variant "${v}" (on term "${t.id}") is itself a canonical term — it must not be forbidden`,
      );
    }
  }
});

function dupes(arr) {
  const seen = new Set();
  const dup = new Set();
  for (const x of arr) (seen.has(x) ? dup : seen).add(x);
  return [...dup];
}
