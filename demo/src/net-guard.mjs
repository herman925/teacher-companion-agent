// net-guard.mjs — what the server is allowed to fetch on a caller's behalf.
//
// THE HOLE THIS CLOSES. `/api/models` and the custom-endpoint override let a
// request name an address and the server fetches it. On a cloud VM that is a
// credential dispenser: the cleartext metadata service at
// `metadata.tencentyun.com/latest/meta-data/…` hands out CAM credentials to
// anything that asks from inside the machine, and port 5432 on the loopback
// address is the database. Server-side request forgery is not a theoretical
// class of bug here — the Lighthouse instance has both.
//
// THREE RULES, and each closes a different half of it:
//
//   1. https only. Cleartext to a vendor is wrong anyway, and every metadata
//      service in every cloud speaks cleartext.
//   2. NO INTERNAL ADDRESS. The hostname is resolved and EVERY address it
//      answers with must be public. Resolving matters: a name under an
//      attacker's control can point at 127.0.0.1, so a hostname allowlist that
//      only looks at the string proves nothing.
//   3. No embedded credentials, no non-default port. `https://user:pw@host` and
//      `https://host:5432` are both shapes of 「this is not a vendor API」.
//
// HONEST LIMIT, stated rather than papered over: this is a check at validation
// time, and the address can change between the check and the fetch (a DNS
// rebind). Closing that needs the connection itself pinned to the address we
// verified, which Node's fetch does not expose. For an invited alpha behind a
// session requirement the check is the right size; if this endpoint ever opens
// up, the pin is the next thing to build, not another regex.
//
// Everything except `assertPublicHttpsUrl` is pure, so both directions of every
// rule are testable without a network.

import { lookup as dnsLookup } from 'node:dns/promises';

/** Names that ARE the attack, whatever they resolve to today. Checked as
 * strings so the refusal holds even where DNS is unavailable or lying. */
const DENY_HOSTS = new Set([
  'metadata.tencentyun.com',
  'metadata.aliyun.com',
  'metadata.google.internal',
  'metadata',
  'instance-data',
  'localhost',
  'localhost.localdomain',
]);

/** Ports a vendor API never listens on, and internal services always do.
 * NOT an allowlist of ports — see `assertPublicHttpsUrl`, which allows only
 * the default. This list exists to make the refusal message specific. */
const KNOWN_INTERNAL_PORTS = new Set([22, 5432, 6379, 3306, 27017, 9200, 11211, 2375, 8787]);

const b = (ip, i) => Number(ip[i]);

/**
 * Is this IPv4 address one the server must never be told to fetch?
 *
 * Covers the ranges that reach something inside the perimeter:
 * 0/8 (this host), 10/8 · 172.16/12 · 192.168/16 (RFC1918), 127/8 (loopback),
 * 169.254/16 (link-local — every cloud metadata service), 100.64/10 (carrier
 * NAT, which on Tencent and Alibaba is the internal network), 192.0.0/24,
 * 198.18/15 (benchmarking), 224/4 (multicast) and 240/4 (reserved).
 * @param {string} address dotted quad
 * @returns {boolean} true when the address is NOT safe to fetch
 */
export function isPrivateIPv4(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return true;               // unparseable is not safe
  const o = parts.map((p) => Number(p));
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (b(o, 0) === 0) return true;
  if (b(o, 0) === 10) return true;
  if (b(o, 0) === 127) return true;
  if (b(o, 0) === 169 && b(o, 1) === 254) return true;
  if (b(o, 0) === 172 && b(o, 1) >= 16 && b(o, 1) <= 31) return true;
  if (b(o, 0) === 192 && b(o, 1) === 168) return true;
  if (b(o, 0) === 192 && b(o, 1) === 0 && b(o, 2) === 0) return true;
  if (b(o, 0) === 100 && b(o, 1) >= 64 && b(o, 1) <= 127) return true;
  if (b(o, 0) === 198 && (b(o, 1) === 18 || b(o, 1) === 19)) return true;
  if (b(o, 0) >= 224) return true;                   // multicast + reserved
  return false;
}

/**
 * Same question for IPv6, including the IPv4-mapped form — `::ffff:127.0.0.1`
 * is loopback wearing a different spelling, and a check that only reads the
 * colons would wave it through.
 * @param {string} address
 * @returns {boolean} true when the address is NOT safe to fetch
 */
export function isPrivateIPv6(address) {
  const a = String(address).toLowerCase().split('%')[0];   // drop any zone id
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (a === '::1' || a === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(a)) return true;           // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(a)) return true;           // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}:/.test(a)) return true;              // multicast
  return false;
}

/** Either family. @param {{address: string, family: number}} rec */
export function isPrivateAddress(rec) {
  const addr = String(rec?.address ?? '');
  if (!addr) return true;
  return rec?.family === 6 || addr.includes(':') ? isPrivateIPv6(addr) : isPrivateIPv4(addr);
}

const fail = (message) => Object.assign(new Error(message), { status: 400, kind: 'blocked_url' });

/**
 * Validate a caller-supplied base URL, resolving the host before allowing it.
 *
 * Returns the NORMALIZED base (trailing slashes stripped) rather than a
 * boolean, so callers use the checked value instead of re-deriving it from the
 * raw input — a validator whose result is thrown away validates nothing.
 *
 * @param {unknown} raw
 * @param {{lookup?: (host: string, opts: Object) => Promise<Array<{address: string, family: number}>>}} [deps]
 *   `lookup` is injected so both directions can be tested with no network.
 * @returns {Promise<string>} the normalized base URL
 * @throws {Error} status 400, kind 'blocked_url'
 */
export async function assertPublicHttpsUrl(raw, { lookup = dnsLookup } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) throw fail('缺少接口地址');

  let u;
  try { u = new URL(text); } catch { throw fail('接口地址格式不对'); }

  // https and nothing else. The rejected scheme is not named in this file as a
  // literal — the repository's own static review flags a cleartext URL in
  // source, and a comment example is indistinguishable from a live one.
  if (u.protocol !== 'https:') throw fail('接口地址必须是 https');
  if (u.username || u.password) throw fail('接口地址里不能带用户名或密码');
  // Only the default port. A vendor API on 5432 is a database, and enumerating
  // 「bad」 ports would leave every port nobody thought of open.
  if (u.port && u.port !== '443') {
    throw fail(KNOWN_INTERNAL_PORTS.has(Number(u.port))
      ? `接口地址不能指向内部端口 ${u.port}`
      : '接口地址只能使用默认端口（443）');
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw fail('接口地址缺少主机名');
  if (DENY_HOSTS.has(host)) throw fail('接口地址不被允许');

  // A literal address never reaches DNS, so check it directly first — otherwise
  // a resolver that happens to echo literals is doing the security work.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isPrivateIPv4(host)) throw fail('接口地址不能指向内网或本机');
  } else if (host.includes(':')) {
    if (isPrivateIPv6(host)) throw fail('接口地址不能指向内网或本机');
  } else {
    let records;
    try {
      records = await lookup(host, { all: true });
    } catch {
      // Unresolvable is refused, not allowed through: 「we could not check」 and
      // 「it is fine」 are different answers and only one of them is safe.
      throw fail('无法解析接口地址的主机名');
    }
    const list = Array.isArray(records) ? records : [records];
    if (!list.length) throw fail('无法解析接口地址的主机名');
    // EVERY address, not the first: a name answering both a public and a
    // private address is a name that can serve either one.
    if (list.some(isPrivateAddress)) throw fail('接口地址不能指向内网或本机');
  }

  // QUERY AND FRAGMENT ARE DROPPED, not preserved. Callers append a path
  // (`${base}/models`, `${base}/chat/completions`); a base ending `?x=` or `#`
  // parks that suffix inside the query or the fragment, so the request goes to
  // the bare host path instead — which is how any path on the target becomes
  // reachable. Returning an origin-plus-path base makes the append mean what it
  // reads like.
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}
