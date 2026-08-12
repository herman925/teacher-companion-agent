// KEY CUSTODY — the browser key path is gone (ADR-0013 §4), both directions.
//
// What ADR-0013 §4 actually removed: `keys: serverKeyMode() ? {} : {...apiKeys}`
// in the chat request body, and the localStorage store ('cst.keys') behind it.
// With an admin-provisioned whitelist there is no legitimate user without a
// session, so the branch had no purpose — and a branch that must stay correctly
// configured is one that eventually is not.
//
// Two claims, each tested with a fixture that trips it and one that must pass:
//
//   1. CLIENT — no chat request body carries key material, on ANY branch. Proved
//      by EXECUTING the real chatRequestBody / courseChatRequestBody out of
//      main.js and inspecting what they build, not by trusting the call site or
//      grepping for the word "keys". One of the fixtures leaves a legacy `key`
//      sitting in customCfg (an old localStorage blob that survived an upgrade)
//      and the built body must still not contain it.
//   2. SERVER — a stale client that still sends `keys` is ignored. Proved by the
//      one signal that is wording-independent and works offline: the adapter's
//      failover chain reports which providers it ATTEMPTED. A provider with no
//      key is skipped, so an empty chain means nothing was tried. If the bait
//      key had been honoured the chain would name the provider it called.
//
// main.js is a browser module (top-level `document`, `window.matchMedia`), so it
// cannot be imported here. The two builders are pure functions of module-level
// state, so we lift their source and run them against a stub scope. A stray free
// variable — `apiKeys` creeping back — throws by name rather than passing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..');
const MAIN_JS = path.join(DEMO, 'src', 'ui', 'main.js');

// Distinctive enough that a match is never a coincidence, and shaped like the
// real thing so a value-based detector has something honest to catch.
const BAIT = 'sk-BAIT-KEY-must-never-travel';

// --------------------------------------------------------------- the detector

/** Field names that carry credentials. A body has no business holding any. */
const CREDENTIAL_FIELD = /^(keys?|api_?keys?|apikey|token|secret|password|authorization)$/i;
/** Values that look like credentials whatever the field is called. */
const CREDENTIAL_VALUE = /(\bsk-[A-Za-z0-9_-]{3,})|(\bBearer\s+\S)|(\bfe_oa_[A-Za-z0-9])/;

/**
 * Every place in a built request body that holds, or looks like it holds, key
 * material. Returns paths so a failure says WHERE, not just that it failed.
 * @param {unknown} value
 * @param {string} [at]
 * @returns {string[]}
 */
function findKeyMaterial(value, at = 'body') {
  const hits = [];
  const walk = (v, p) => {
    if (v == null) return;
    if (typeof v === 'string') {
      if (CREDENTIAL_VALUE.test(v)) hits.push(`${p} — value looks like a credential`);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${p}[${i}]`)); return; }
    if (typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v)) {
      if (CREDENTIAL_FIELD.test(k)) hits.push(`${p}.${k} — credential-shaped field`);
      walk(val, `${p}.${k}`);
    }
  };
  walk(value, at);
  return hits;
}

// The detector's own two directions: it must fire on a body that carries key
// material and stay silent on one that does not. Without this, "zero hits" on
// the real builder could just mean the detector never fires at all.
test('the detector fires on key material and stays silent without it', () => {
  const namedField = { message: 'hi', provider: 'glm', keys: { glm: BAIT } };
  assert.ok(findKeyMaterial(namedField).length >= 1, 'a `keys` field must be caught');

  // Renaming the field is not a fix, so the detector must not depend on the name.
  const hiddenValue = { message: 'hi', custom: { headers: { 'x-thing': `Bearer ${BAIT}` } } };
  assert.ok(findKeyMaterial(hiddenValue).length >= 1, 'credential-shaped VALUES must be caught too');

  const clean = {
    state: { course_id: 'c1' },
    history: [{ role: 'user', content: '我想带中班孩子做醒狮' }],
    message: '继续',
    provider: 'glm',
    model: 'glm-5.2',
    custom: { baseURL: 'https://api.example.com/v1', model: 'x', label: '自定义' },
    caps: { webSearch: true },
  };
  assert.deepEqual(findKeyMaterial(clean), [], 'an ordinary body must not trip the detector');
});

// ------------------------------------------------- lifting the real builders

/**
 * Source text of one top-level function declaration.
 *
 * main.js declares them at column 0 and closes them with a lone `}` at column 0,
 * which is what makes this slice well defined. If that ever stops being true the
 * extraction produces something that will not compile and the test fails loudly
 * — it cannot quietly pass on a truncated body.
 * @param {string} src
 * @param {string} name
 */
function functionSource(src, name) {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  assert.notEqual(start, -1, `main.js no longer declares ${name}() at top level`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  assert.notEqual(end, -1, `${name}() has no closing brace at column 0`);
  return lines.slice(start, end + 1).join('\n');
}

/** Globals the lifted code may legitimately reach for; everything else is app state. */
const REAL_GLOBALS = new Set(['undefined', 'Object', 'JSON', 'Boolean', 'String', 'Number', 'Array', 'Math']);

/**
 * Compile the two builders against a stub of main.js's module state.
 *
 * The scope proxy claims every name, so an identifier the stub does not define
 * throws with that identifier in the message. That is the point: if someone
 * reintroduces `apiKeys`, this fails saying so, instead of building a body the
 * detector then has to catch.
 * @param {string} src  main.js source
 * @param {Object} stub module-level state to run against
 */
function compileBuilders(src, stub) {
  const scope = new Proxy(stub, {
    has: (t, k) => typeof k === 'string' && !REAL_GLOBALS.has(k),
    get: (t, k) => {
      // `with` consults @@unscopables on every claimed name before binding it;
      // that is the engine asking, not the lifted code reading a variable.
      if (typeof k === 'symbol') return t[k];
      if (k in t) return t[k];
      throw new Error(`the request builder read an unexpected free variable \`${String(k)}\` `
        + '— key material (or anything else) must not re-enter this path');
    },
  });
  const body = [
    functionSource(src, 'chatRequestBody'),
    functionSource(src, 'courseChatRequestBody'),
    'return { chatRequestBody, courseChatRequestBody };',
  ].join('\n\n');
  // Sloppy mode (a `new Function` body is not strict unless it says so), which is
  // what makes `with` available — and `with` is what lets the lifted source keep
  // reading its free variables exactly as it does inside the module.
  // eslint-disable-next-line no-new-func
  const make = new Function('scope', `with (scope) {\n${body}\n}`);
  return make(scope);
}

/** Module state as main.js holds it, with the knobs each fixture needs. */
function stubState(over = {}) {
  return {
    courseState: { course_id: 'course-1', stage: 1 },
    wireHistory: () => [{ role: 'user', content: '我想带中班孩子做醒狮' }],
    provider: 'glm',
    profileForRequest: () => null,
    devMode: false,
    providerCaps: {},
    modelChoices: {},
    customCfg: { baseURL: '', model: '', label: '' },
    providerInfo: () => ({ id: 'glm', label: 'GLM', defaultModel: 'glm-5.2', hasEnvKey: false }),
    ...over,
  };
}

const mainSrc = await readFile(MAIN_JS, 'utf8');

test('no chat request body carries key material — every branch of the builder', () => {
  /** @type {Array<{name: string, state: Object}>} */
  const branches = [
    { name: 'plain turn, nothing configured', state: {} },
    {
      name: 'dev mode + 教师档案 + capability toggles',
      state: {
        devMode: true,
        profileForRequest: () => ({ province: '广东', stylePref: '朴素' }),
        providerCaps: { glm: { webSearch: true, thinking: true } },
        modelChoices: { glm: 'glm-5.2-air' },
      },
    },
    {
      // The adversarial one: an old 'cst.custom' blob that still holds a key
      // from before ADR-0013 §4. Deleting the assignment is only half the job —
      // the body must not pick the value up from anywhere.
      name: 'custom endpoint with a legacy key left in customCfg',
      state: {
        provider: 'custom',
        customCfg: { baseURL: 'https://api.example.com/v1', model: 'x', label: '自建', key: BAIT },
        providerInfo: () => null,
      },
    },
  ];

  for (const { name, state } of branches) {
    const { chatRequestBody, courseChatRequestBody } = compileBuilders(mainSrc, stubState(state));

    const stateless = chatRequestBody('狮头做到一半卡住了');
    assert.deepEqual(findKeyMaterial(stateless), [], `/api/chat body carries key material (${name})`);
    assert.ok(!('keys' in stateless), `/api/chat body still has a keys field (${name})`);
    assert.ok(!JSON.stringify(stateless).includes(BAIT), `the bait key reached the wire (${name})`);

    const persistent = courseChatRequestBody('狮头做到一半卡住了');
    assert.deepEqual(findKeyMaterial(persistent), [], `course chat body carries key material (${name})`);
    assert.ok(!('keys' in persistent), `course chat body still has a keys field (${name})`);
    assert.ok(!JSON.stringify(persistent).includes(BAIT), `the bait key reached the wire (${name})`);
    // The persistence tier ships neither state nor history — unchanged by this
    // work, asserted so the destructure is not quietly broken while editing it.
    assert.ok(!('state' in persistent) && !('history' in persistent), `course body should ship neither state nor history (${name})`);
  }
});

test('the builder still says which provider and model to use', () => {
  // A body stripped of keys is only correct if it still carries what the server
  // needs to resolve one. "Send nothing" would pass the test above and be wrong.
  const { chatRequestBody } = compileBuilders(mainSrc, stubState({ modelChoices: { glm: 'glm-5.2-air' } }));
  const body = chatRequestBody('继续');
  assert.equal(body.provider, 'glm');
  assert.equal(body.model, 'glm-5.2-air', 'a non-default model override must survive');
  assert.equal(body.message, '继续');
});

test('main.js keeps no key storage, and purges what older builds left behind', () => {
  assert.doesNotMatch(mainSrc, /\bapiKeys\b/, 'the apiKeys store is back in main.js');
  assert.doesNotMatch(mainSrc, /LS\.keys\b/, 'a localStorage key slot is back in main.js');
  // Removing the reader without removing the data leaves the secrets sitting in
  // the browser — on a shared staffroom machine that is the leak, not the fix.
  assert.match(mainSrc, /removeItem\(LEGACY_KEY_STORE\)/, 'legacy cst.keys is no longer purged on load');
  assert.match(mainSrc, /LEGACY_KEY_STORE = 'cst\.keys'/, 'the legacy key name to purge is gone');
});

// ------------------------------------------------------------- the server side

// Ports are hand-allocated across the suite (8913 static-guard, 8917 key-vault,
// 8919 store-subject, 8921 turn-wiring) because `node --test` runs the files in
// parallel — a shared port is a flake that only appears in the full run.
const PORT = 8923;
const BASE = `http://127.0.0.1:${PORT}`;
/** @type {import('node:child_process').ChildProcess|undefined} */
let child;
/** @type {string} */
let dataDir;

test.before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'cst-keycustody-'));
  // A hermetic environment: no vendor key anywhere, so "was this provider
  // attempted?" is a clean signal. Also no PORT/FC_SERVER_PORT (they would move
  // the listener to 0.0.0.0), a scratch data dir, and quotas out of the way.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/_API_KEY$/.test(k)) delete env[k];
  delete env.PORT;
  delete env.FC_SERVER_PORT;
  delete env.CHANNEL;
  env.KEYS_SECRET = '';           // vault off: the env is then the ONLY key source
  env.DEMO_DATA_DIR = dataDir;
  env.RATE_TURNS_HOUR = '100000';
  env.RATE_TURNS_DAY = '100000';

  child = spawn(process.execPath, [path.join(DEMO, 'serve.mjs'), '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  // Keep stderr: "server exited" with no reason is the worst kind of red build.
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += String(b); });
  const started = new Promise((resolve) => {
    child.stdout.on('data', (b) => { if (String(b).includes(String(PORT))) resolve(); });
  });
  await Promise.race([
    started,
    once(child, 'exit').then(() => { throw new Error(`server exited before listening:\n${stderr}`); }),
  ]);
});

test.after(async () => {
  child?.kill();
  await rm(dataDir, { recursive: true, force: true });
});

/** One buffered turn (Accept: application/json) → its events plus the raw text. */
async function postChat(body) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  return { events: JSON.parse(text).events, text };
}

const TURN = { message: '我想带中班孩子做醒狮主题', state: null, history: [] };

test('the server ignores a keys field from a stale client', async () => {
  // Violating fixture: an old build still shipping localStorage keys. If the
  // server honoured them it would CALL glm — and the failover chain would say so.
  const withKeys = await postChat({ ...TURN, provider: 'glm', keys: { glm: BAIT } });
  const err = withKeys.events.find((e) => e.event === 'error');
  assert.ok(err, 'expected the turn to fail for want of a key');
  assert.deepEqual(
    err.data.chain, [],
    'a provider was ATTEMPTED — the bait key was used instead of being dropped',
  );
  assert.ok(!withKeys.events.some((e) => e.event === 'turn'), 'no turn should come back without a key');
  assert.ok(!withKeys.text.includes(BAIT), 'the bait key was echoed back to the client');

  // Same request minus the field. Identical outcome is what "ignored" means:
  // the presence of `keys` changes nothing at all.
  const without = await postChat({ ...TURN, provider: 'glm' });
  const err2 = without.events.find((e) => e.event === 'error');
  assert.ok(err2, 'expected the same failure without the keys field');
  assert.deepEqual(err2.data.chain, []);
  assert.equal(err.data.message, err2.data.message, 'sending `keys` changed the outcome');
});

test('an ordinary turn is untouched by the key-custody strip', async () => {
  // Compliant fixture: the normal path must keep working, keys field or not.
  // 演示模式 never leaves the process, so this stays offline and deterministic.
  for (const body of [{ ...TURN, provider: 'mock' }, { ...TURN, provider: 'mock', keys: { glm: BAIT } }]) {
    const { events, text } = await postChat(body);
    const turn = events.find((e) => e.event === 'turn');
    assert.ok(turn, 'the mock turn stopped working');
    assert.ok(turn.data.turn?.reply_markdown, 'the turn carries no reply');
    assert.ok(!events.some((e) => e.event === 'error'), 'an ordinary turn must not error');
    assert.ok(!text.includes(BAIT), 'the bait key was echoed back to the client');
  }
});
