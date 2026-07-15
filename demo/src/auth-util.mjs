// auth-util.mjs — server-side auth primitives (SECURITY.md §2/§5). Zero-dep:
// scrypt + timingSafeEqual from node:crypto. Pure functions; storage lives in
// the store, HTTP plumbing in serve.mjs.

import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Cost parameters live inside the stored string so they can be raised later
// without a migration (old hashes keep verifying with their recorded cost).
const SCRYPT_N = 32768; // 2^15
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/** @returns {string} `scrypt$N$r$p$saltB64$hashB64` */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * 1024 * 1024 });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/** Constant-time verify against a stored hash string. */
export function verifyPassword(password, stored) {
  try {
    const [kind, n, r, p, saltB64, hashB64] = String(stored || '').split('$');
    if (kind !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64url');
    const want = Buffer.from(hashB64, 'base64url');
    const got = scryptSync(String(password), salt, want.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024 });
    return timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/** One-time temporary password for admin-provisioned accounts (readable, no ambiguous chars). */
export function tempPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzACDEFHJKLMNPQRSTUVWXYZ234679';
  const bytes = randomBytes(12);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/** Session bearer token (cookie value) and public sid (device list) — distinct
 * on purpose: the list endpoint must never expose another device's bearer token. */
export function sessionToken() { return randomBytes(24).toString('base64url'); }
export function sessionSid() { return randomBytes(9).toString('base64url'); }

// ---- display-name rules (SECURITY.md §5) ----

const HERE = fileURLToPath(new URL('.', import.meta.url));
let PROFANITY = null;
function profanityList() {
  if (!PROFANITY) {
    try { PROFANITY = JSON.parse(readFileSync(`${HERE}data/profanity.json`, 'utf8')); }
    catch { PROFANITY = []; }
  }
  return PROFANITY;
}

const NAME_RE = /^[\p{Script=Han}A-Za-z0-9_\-·]{2,20}$/u;
const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000;

/**
 * Validate a display-name change. Returns a zh-CN error string, or null when OK.
 * Uniqueness is the store's job (it holds the user list); this checks the rest.
 * @param {string} name
 * @param {{ lastChangedAt?: string|null }} [ctx]
 */
export function displayNameError(name, ctx = {}) {
  const n = String(name ?? '').trim();
  if (!NAME_RE.test(n)) return '昵称需为 2–20 个字符，只能包含中英文、数字、_-·';
  const lower = n.toLowerCase();
  if (profanityList().some((w) => lower.includes(String(w).toLowerCase()))) {
    return '昵称包含不允许的词汇，请换一个';
  }
  if (ctx.lastChangedAt) {
    const elapsed = Date.now() - Date.parse(ctx.lastChangedAt);
    if (Number.isFinite(elapsed) && elapsed < SIX_MONTHS_MS) return '昵称每 6 个月只能修改一次';
  }
  return null;
}

// ---- cookie helpers (zero-dep) ----

export const SESSION_COOKIE = 'cst_sid';
const THIRTY_DAYS_S = 30 * 24 * 60 * 60;

/** Parse the Cookie header into a map. */
export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Set-Cookie value for a session token. No Secure until TLS exists (SECURITY.md §7). */
export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${THIRTY_DAYS_S}`;
}
export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
