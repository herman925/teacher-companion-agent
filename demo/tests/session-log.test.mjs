// Session logger (debug drawer 「日志」 panel) — store discipline, both
// directions: categories default ON and record; a toggled-off category drops;
// toggles persist through the injected storage; the ring cap evicts honestly;
// and NO secret (API key / password / token) survives redaction into an entry
// or an export. DOM-free — only the store core is under test here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLogStore, redactSecrets, LOG_CATEGORIES } from '../src/ui/session-log.mjs';

const fixedNow = () => '2026-07-14T00:00:00.000Z';

test('every category defaults ON and records entries', () => {
  const store = createLogStore({ now: fixedNow });
  for (const cat of LOG_CATEGORIES) {
    assert.equal(store.isEnabled(cat.id), true, `${cat.id} should default on`);
    store.log(cat.id, 'probe', { cat: cat.id });
  }
  assert.equal(store.getEntries().length, LOG_CATEGORIES.length);
  const counts = store.countByCategory();
  for (const cat of LOG_CATEGORIES) assert.equal(counts[cat.id], 1);
});

test('a toggled-off category drops its entries; re-enabling records again', () => {
  const store = createLogStore({ now: fixedNow });
  store.setEnabled('api_out', false);
  store.log('api_out', 'chat_request', { url: '/api/chat' });
  assert.equal(store.getEntries().length, 0);
  store.log('user_input', 'message', { text: '醒狮' }); // other categories unaffected
  assert.equal(store.getEntries().length, 1);
  store.setEnabled('api_out', true);
  store.log('api_out', 'chat_request', { url: '/api/chat' });
  assert.equal(store.getEntries().length, 2);
});

test('unknown categories never enter the log', () => {
  const store = createLogStore({ now: fixedNow });
  store.log('made_up', 'x', {});
  assert.equal(store.getEntries().length, 0);
});

test('toggles persist via the injected storage and load back', () => {
  let persisted = null;
  const save = (cfg) => { persisted = cfg; };
  const store = createLogStore({ now: fixedNow, saveConfig: save });
  store.setEnabled('workflow', false);
  assert.equal(persisted.workflow, false);
  assert.equal(persisted.harness, true);

  const reloaded = createLogStore({ now: fixedNow, loadConfig: () => persisted });
  assert.equal(reloaded.isEnabled('workflow'), false);
  assert.equal(reloaded.isEnabled('harness'), true);
});

test('ring cap evicts oldest entries and counts the drop honestly', () => {
  const store = createLogStore({ now: fixedNow, max: 3 });
  for (let i = 1; i <= 5; i += 1) store.log('user_input', 'message', { i });
  const entries = store.getEntries();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.data.i), [3, 4, 5]);
  assert.equal(store.dropped, 2);
  const payload = store.buildExportPayload();
  assert.equal(payload.dropped_over_cap, 2);
  store.clear();
  assert.equal(store.getEntries().length, 0);
  assert.equal(store.dropped, 0);
});

test('redactSecrets masks key-bearing fields and the request keys map, nothing else', () => {
  const body = {
    message: '我想带中班孩子做醒狮',
    provider: 'glm',
    keys: { glm: 'sk-live-abc123', minimax: '' },
    custom: { baseURL: 'https://api.example.com/v1', key: 'ck-999' },
    opencode: { baseURL: 'http://127.0.0.1:4096', password: 'hunter2' },
    nested: [{ token: 'tok-1', ok: 'visible' }],
  };
  const red = redactSecrets(body);
  assert.equal(red.message, body.message);
  assert.equal(red.provider, 'glm');
  assert.equal(red.keys.glm, '••redacted••');
  assert.equal(red.keys.minimax, ''); // empty stays empty — nothing to hide
  assert.equal(red.custom.key, '••redacted••');
  assert.equal(red.custom.baseURL, body.custom.baseURL);
  assert.equal(red.opencode.password, '••redacted••');
  assert.equal(red.nested[0].token, '••redacted••');
  assert.equal(red.nested[0].ok, 'visible');
  // input untouched
  assert.equal(body.keys.glm, 'sk-live-abc123');
});

test('entries are redacted at append time, so exports carry no secrets', () => {
  const store = createLogStore({ now: fixedNow });
  store.log('api_out', 'chat_request', { keys: { glm: 'sk-live-abc123' }, url: '/api/chat' });
  const payload = store.buildExportPayload({ provider: 'glm' });
  const text = JSON.stringify(payload);
  assert.ok(!text.includes('sk-live-abc123'), 'exported log must not contain the key');
  assert.equal(payload.entries[0].data.keys.glm, '••redacted••');
  assert.equal(payload.entries[0].ts, fixedNow());
  assert.equal(payload.context.provider, 'glm');
  assert.equal(payload.entry_count, 1);
});

test('onChange fires on log/toggle/clear and unsubscribes cleanly', () => {
  const store = createLogStore({ now: fixedNow });
  let fired = 0;
  const off = store.onChange(() => { fired += 1; });
  store.log('error', 'turn_error', { message: 'x' });
  store.setEnabled('error', false);
  store.clear();
  assert.equal(fired, 3);
  off();
  store.log('user_input', 'message', { text: 'y' });
  assert.equal(fired, 3);
});
