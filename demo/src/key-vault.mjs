// key-vault.mjs — AES-256-GCM encryption for per-account model keys
// (SECURITY.md; spec 2026-07-22-key-vault-and-rate-limits-design.md §1).
//
// The vault secret (KEYS_SECRET) lives in the server .env, never in the repo
// (AGENTS.md non-negotiable 5). Ciphertext format: `v1$ivB64u$tagB64u$ctB64u`.
// Pure functions; storage lives in the store, policy in serve.mjs.
//
// Blast radius, stated honestly: a VM compromise exposes the secret and the
// ciphertext together — the same radius as env-seeded keys. Rotation = change
// KEYS_SECRET; rows that no longer decrypt are treated as absent (teachers
// re-enter their keys; the UI shows 未配置).

import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Usable secret: any string with at least 16 non-space characters. */
export function vaultReady(secret) {
  return typeof secret === 'string' && secret.trim().length >= 16;
}

// sha256 turns an arbitrary-length passphrase into exactly the 32 bytes GCM
// needs — no format demands on what an operator can put in .env.
const derive = (secret) => createHash('sha256').update(String(secret)).digest();

/** @returns {string} `v1$iv$tag$ct` (base64url parts) */
export function encryptKey(secret, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(secret), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('$');
}

/** @returns {string|null} plaintext, or null on tamper / wrong secret / junk. */
export function decryptKey(secret, blob) {
  try {
    const [v, ivB, tagB, ctB] = String(blob ?? '').split('$');
    if (v !== 'v1' || !ivB || !tagB || !ctB) return null;
    const decipher = createDecipheriv('aes-256-gcm', derive(secret), Buffer.from(ivB, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
