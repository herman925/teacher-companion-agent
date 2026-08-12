// egress-guard.test.mjs — the two directions of the server's outside edge.
//
// WHAT THE SERVER MAY FETCH (net-guard.mjs). A caller names an address and the
// server requests it. On the Lighthouse VM that reaches a metadata service
// which hands out CAM credentials and a local PostgreSQL, so「is this address
// allowed」 is a security decision, not a formatting one.
//
// WHAT MAY LEAVE (redact.mjs). Vendor error bodies used to be relayed to the
// browser verbatim, and several vendors echo the submitted credential in an
// auth-failure body — where the key in play is the PLATFORM env key.
//
// Every rule below is asserted in BOTH directions: the address it must refuse
// AND the ordinary vendor address it must leave alone; the bait key it must
// mask AND the ordinary message it must not touch.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertPublicHttpsUrl, isPrivateIPv4, isPrivateIPv6,
} from '../src/net-guard.mjs';
import {
  scrubCredentials, looksLikeCredential, containsCredential, MASK,
} from '../src/redact.mjs';

// A resolver that answers with whatever the test tells it to, so nothing here
// touches DNS. Keyed by hostname; an unknown name is NXDOMAIN.
const resolver = (table) => async (host) => {
  const v = table[host];
  if (!v) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return v;
};
const PUBLIC = { 'api.example.com': [{ address: '93.184.216.34', family: 4 }] };
const ok = { lookup: resolver(PUBLIC) };

const refused = async (input, deps = ok) => {
  await assert.rejects(() => assertPublicHttpsUrl(input, deps), (e) => {
    assert.equal(e.kind, 'blocked_url', `expected a blocked_url refusal, got: ${e.message}`);
    assert.equal(e.status, 400);
    return true;
  });
};

// -------------------------------------------------------- address classifier

test('isPrivateIPv4 knows every range that reaches inside the perimeter', () => {
  for (const bad of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.100.100.200',
    '198.18.0.1', '224.0.0.1', '255.255.255.255', 'not-an-ip']) {
    assert.equal(isPrivateIPv4(bad), true, bad);
  }
});

test('MUST PASS — ordinary public IPv4 is not treated as internal', () => {
  for (const good of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.32.0.1', '11.0.0.1']) {
    assert.equal(isPrivateIPv4(good), false, good);
  }
});

test('isPrivateIPv6 catches loopback, unique-local, link-local and the v4-mapped spelling', () => {
  for (const bad of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
    assert.equal(isPrivateIPv6(bad), true, bad);
  }
  assert.equal(isPrivateIPv6('2606:4700:4700::1111'), false);
  assert.equal(isPrivateIPv6('::ffff:93.184.216.34'), false);
});

// -------------------------------------------------------------- the URL gate

test('MUST PASS — an ordinary vendor base URL survives, normalized', async () => {
  assert.equal(await assertPublicHttpsUrl('https://api.example.com/v1', ok), 'https://api.example.com/v1');
  assert.equal(await assertPublicHttpsUrl('https://api.example.com/v1///', ok), 'https://api.example.com/v1');
  assert.equal(await assertPublicHttpsUrl('  https://api.example.com  ', ok), 'https://api.example.com');
});

test('http is refused — every cloud metadata service speaks it', async () => {
  await refused('http://api.example.com/v1');
});

test('the metadata service is refused by name and by address', async () => {
  await refused('https://metadata.tencentyun.com/latest/meta-data');
  await refused('https://169.254.169.254/latest/meta-data');
  await refused('https://metadata.google.internal/');
});

test('loopback and the private ranges are refused, literal or resolved', async () => {
  await refused('https://127.0.0.1/v1');
  await refused('https://[::1]/v1');
  await refused('https://10.1.2.3/v1');
  // The whole reason the host is RESOLVED: a public-looking name pointing home.
  await refused('https://evil.example.com/v1', {
    lookup: resolver({ 'evil.example.com': [{ address: '127.0.0.1', family: 4 }] }),
  });
  // …and one that answers with a public AND a private address.
  await refused('https://split.example.com/v1', {
    lookup: resolver({
      'split.example.com': [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    }),
  });
});

test('a name that will not resolve is refused, not waved through', async () => {
  await refused('https://nowhere.example.com/v1');
});

test('non-default ports and embedded credentials are refused', async () => {
  await refused('https://api.example.com:5432/v1');
  await refused('https://api.example.com:8080/v1');
  await refused('https://user:pw@api.example.com/v1');
  // The default port written out is the same address, so it stays allowed.
  assert.equal(await assertPublicHttpsUrl('https://api.example.com:443/v1', ok), 'https://api.example.com/v1');
});

test('a query or fragment is stripped, so an appended path cannot be parked in it', async () => {
  // `${base}/models` on a base ending `?x=` would request `/` with the path in
  // the query string — which is how any path on the target became reachable.
  assert.equal(await assertPublicHttpsUrl('https://api.example.com/v1?x=', ok), 'https://api.example.com/v1');
  assert.equal(await assertPublicHttpsUrl('https://api.example.com/v1#', ok), 'https://api.example.com/v1');
});

test('junk input is a refusal, never a pass-through', async () => {
  await refused('');
  await refused(null);
  await refused('not a url');
  await refused('file:///etc/passwd');
});

// -------------------------------------------------------------- the redactor

test('a vendor body echoing the submitted key comes back scrubbed', () => {
  const body = 'invalid api key: sk-BAIT-KEY-must-never-travel (request 44)';
  const out = scrubCredentials(body);
  assert.ok(!out.includes('sk-BAIT'), out);
  assert.ok(out.includes(MASK));
  assert.ok(out.includes('request 44'), 'the diagnosable part must survive');
  assert.equal(scrubCredentials('Authorization: Bearer abc.def.ghi').includes('abc.def'), false);
  assert.equal(scrubCredentials('fe_oa_ABC123XYZ').includes('ABC123'), false);
});

test('MUST PASS — an ordinary 429 message survives unchanged', () => {
  const msg = 'MiniMax（https://api.minimaxi.com/v1）返回 429——详细原因见服务器日志';
  assert.equal(scrubCredentials(msg), msg);
  assert.equal(looksLikeCredential(msg), false);
  // Non-strings are returned as they came, not coerced into the word 「undefined」.
  assert.equal(scrubCredentials(undefined), undefined);
  assert.equal(scrubCredentials(7), 7);
});

test('the global regex does not lose its place between calls', () => {
  // A shared /g regex carries lastIndex; two identical calls must agree.
  assert.equal(looksLikeCredential('sk-aaaa'), true);
  assert.equal(looksLikeCredential('sk-aaaa'), true);
  assert.equal(scrubCredentials('sk-aaaa sk-bbbb'), `${MASK} ${MASK}`);
});

test('containsCredential walks nested values, and stays quiet on an ordinary profile', () => {
  assert.equal(containsCredential({ profile: { school: '番禺一幼', note: '喜欢提问引导' } }), false);
  assert.equal(containsCredential({ profile: { note: '我的钥匙 sk-abcdef' } }), true);
  assert.equal(containsCredential([{ a: [{ b: 'Bearer zzz' }] }]), true);
});
