// key-vault: roundtrip, tamper detection, wrong secret, junk tolerance —
// both directions (a valid blob decrypts; every broken shape returns null,
// never throws, never partial plaintext).

import test from 'node:test';
import assert from 'node:assert/strict';

import { vaultReady, encryptKey, decryptKey } from '../src/key-vault.mjs';

const SECRET = 'unit-test-secret-0123456789abcdef';

test('vaultReady: accepts a real passphrase, rejects short/empty/non-string', () => {
  assert.equal(vaultReady(SECRET), true);
  assert.equal(vaultReady('short'), false);
  assert.equal(vaultReady('                '), false);
  assert.equal(vaultReady(''), false);
  assert.equal(vaultReady(undefined), false);
});

test('roundtrip: decrypt(encrypt(x)) === x, and ciphertext is not the plaintext', () => {
  const key = 'sk-test-ABC123.def_456';
  const blob = encryptKey(SECRET, key);
  assert.match(blob, /^v1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.ok(!blob.includes(key), 'ciphertext must not contain the plaintext');
  assert.equal(decryptKey(SECRET, blob), key);
});

test('two encryptions of the same key differ (fresh IV) but both decrypt', () => {
  const a = encryptKey(SECRET, 'same-key');
  const b = encryptKey(SECRET, 'same-key');
  assert.notEqual(a, b);
  assert.equal(decryptKey(SECRET, a), 'same-key');
  assert.equal(decryptKey(SECRET, b), 'same-key');
});

test('tamper: any flipped ciphertext byte fails closed (null, no throw)', () => {
  const blob = encryptKey(SECRET, 'sk-tamper-target');
  const parts = blob.split('$');
  // Flip a MIDDLE character — the final char's low bits are base64 padding
  // slack and may decode to identical bytes.
  const ct = parts[3];
  const mid = Math.floor(ct.length / 2);
  const flipped = ct.slice(0, mid) + (ct[mid] === 'A' ? 'B' : 'A') + ct.slice(mid + 1);
  assert.equal(decryptKey(SECRET, [parts[0], parts[1], parts[2], flipped].join('$')), null);
});

test('wrong secret fails closed', () => {
  const blob = encryptKey(SECRET, 'sk-secret-bound');
  assert.equal(decryptKey('another-secret-0123456789abcdef', blob), null);
});

test('junk blobs fail closed: wrong version, missing parts, garbage, null', () => {
  for (const junk of ['v2$a$b$c', 'v1$onlyone', 'not-a-blob', '', null, undefined, 'v1$$$']) {
    assert.equal(decryptKey(SECRET, junk), null, `junk ${JSON.stringify(junk)} must be null`);
  }
});
