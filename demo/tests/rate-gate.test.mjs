// rate-gate: sliding-window behavior with an injected clock — both directions
// (the 6th failure trips, a fresh key stays clean, expiry unlocks, reset and
// admin clears relieve, persisted state survives a reload).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRateGate } from '../src/rate-gate.mjs';

const POLICIES = {
  login_user: { limit: 5, windowMs: 15 * 60_000 },
  turns_user: { limit: 3, windowMs: 60 * 60_000 },
};

function makeGate(overrides = {}) {
  let t = 1_000_000;
  const saved = { state: null };
  const gate = createRateGate({
    load: async () => (saved.state ? JSON.parse(JSON.stringify(saved.state)) : null),
    save: async (s) => { saved.state = JSON.parse(JSON.stringify(s)); },
    policies: POLICIES,
    now: () => t,
    ...overrides,
  });
  return { gate, saved, tick: (ms) => { t += ms; }, timeAt: () => t };
}

test('fail counter: 5 failures trip the 6th check; a fresh key stays clean', async () => {
  const { gate } = makeGate();
  for (let i = 0; i < 5; i += 1) {
    const before = await gate.check('login_user', 'teacher-a');
    assert.equal(before.limited, false, `attempt ${i + 1} not yet limited`);
    await gate.record('login_user', 'teacher-a');
  }
  const tripped = await gate.check('login_user', 'teacher-a');
  assert.equal(tripped.limited, true);
  assert.ok(tripped.retryAfterSec > 0 && tripped.retryAfterSec <= 900);
  const fresh = await gate.check('login_user', 'teacher-b');
  assert.equal(fresh.limited, false, 'another username is unaffected');
});

test('window expiry unlocks without any intervention', async () => {
  const { gate, tick } = makeGate();
  for (let i = 0; i < 5; i += 1) await gate.record('login_user', 'x');
  assert.equal((await gate.check('login_user', 'x')).limited, true);
  tick(15 * 60_000 + 1);
  assert.equal((await gate.check('login_user', 'x')).limited, false);
});

test('reset (login success) clears just that key', async () => {
  const { gate } = makeGate();
  for (let i = 0; i < 5; i += 1) { await gate.record('login_user', 'a'); await gate.record('login_user', 'b'); }
  await gate.reset('login_user', 'a');
  assert.equal((await gate.check('login_user', 'a')).limited, false);
  assert.equal((await gate.check('login_user', 'b')).limited, true);
});

test('use quota: 3 uses pass, the 4th is refused and not recorded', async () => {
  const { gate } = makeGate();
  for (let i = 0; i < 3; i += 1) assert.equal((await gate.use('turns_user', 'u1')).limited, false);
  const over = await gate.use('turns_user', 'u1');
  assert.equal(over.limited, true);
  assert.equal(over.count, 3, 'refused use does not inflate the count');
  assert.equal((await gate.use('turns_user', 'u2')).limited, false, 'another user unaffected');
});

test('state persists: a new gate over the same storage still sees the trip', async () => {
  const first = makeGate();
  for (let i = 0; i < 5; i += 1) await first.gate.record('login_user', 'persist-me');
  await new Promise((r) => setTimeout(r, 400)); // let the debounced save land
  const second = createRateGate({
    load: async () => JSON.parse(JSON.stringify(first.saved.state)),
    save: async () => {},
    policies: POLICIES,
    now: first.timeAt,
  });
  assert.equal((await second.check('login_user', 'persist-me')).limited, true, 'restart does not reset windows');
});

test('list + clearEntry + clearAll: admin relief works and unknown kinds are skipped', async () => {
  const { gate } = makeGate();
  for (let i = 0; i < 5; i += 1) await gate.record('login_user', 'locked');
  await gate.record('login_user', 'partial');
  const rows = await gate.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'login_user|locked', 'tripped entries sort first');
  assert.equal(rows[0].limited, true);
  assert.ok(rows[0].unlock_at, 'tripped rows carry an unlock time');
  assert.equal(await gate.clearEntry('login_user|locked'), true);
  assert.equal((await gate.check('login_user', 'locked')).limited, false);
  await gate.clearAll();
  assert.deepEqual(await gate.list(), []);
});
