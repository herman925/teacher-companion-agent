// object-store.mjs — where uploaded BYTES live (ADR-0013 §6).
//
// THREE METHODS, DELIBERATELY. `put` / `get` / `delete`, and nothing else, is
// the whole seam: LighthouseCOS is COS-compatible, so replacing local disk with
// a bucket has to be a configuration change rather than a rewrite of every
// caller. Anything richer here (listing, signed URLs, metadata) would be a
// promise the COS implementation then has to keep.
//
// NO PRESIGNED URLs IN THE LOCAL TIER, and that is a security property rather
// than a missing feature: every read of an uploaded file goes through a
// session-checked handler in serve.mjs, so there is no address that works
// without a cookie and therefore no link to leak. DATABASE.md §4 used to
// sketch a client-direct `POST /api/materials/upload-url`; that line is gone
// and the reason is written down there, because EXIF stripping is mandatory at
// ingest and a browser cannot be trusted to have done it.
//
// The objects live OUTSIDE anything the static file handler serves. With the
// default data root that is `demo/.data/objects/…`, which the static handler
// already refuses twice over (dot-prefixed segment, and the explicit objects
// check in serve.mjs). A photograph of children must not be one URL guess away.

import { createReadStream } from 'node:fs';
import { mkdir, writeFile, unlink, stat, statfs } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/**
 * Object keys we are willing to touch. Random uuid basename, extension from
 * OUR sniffed-mime table, never from the uploaded filename — a teacher's file
 * name is untrusted input and also frequently a child's name.
 *
 * The regex is the containment guard's first half: no dots as segments, no
 * separators beyond the two the shape allows.
 */
const KEY_RE = /^courses\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/[A-Za-z0-9-]{8,64}\.[a-z0-9]{2,5}$/;

/**
 * Mint a fresh object key for one course.
 * @param {string} courseId @param {string} ext extension WITHOUT the dot
 * @returns {string}
 */
export function materialKey(courseId, ext) {
  const key = `courses/${String(courseId)}/${randomUUID()}.${String(ext)}`;
  if (!KEY_RE.test(key)) throw Object.assign(new Error('对象键不合法'), { status: 400 });
  return key;
}

/** Is this a key this store will ever resolve? Exported so callers can refuse
 * a stored row that has drifted, instead of handing it to path.join. */
export const validKey = (key) => KEY_RE.test(String(key ?? ''));

/**
 * Local-disk object store. The pilot tier.
 *
 * ACCEPTED WITH A COMPENSATING CONTROL, not accepted blindly: ADR-0013 §6's
 * reasoning against local disk still stands — a full system disk stops
 * PostgreSQL and takes the service down with it — so `freeBytes` exists and
 * serve.mjs refuses uploads below a floor. A seam that could not answer 「how
 * much room is left」 would make that check impossible to write.
 *
 * @param {{baseDir: string}} opts `baseDir` is the objects root
 */
export function createLocalObjectStore({ baseDir }) {
  const root = path.resolve(baseDir);

  /** Key → absolute path, containment verified. Two locks: the key shape, and
   * the resolved path having to start with the root. Either alone has been
   * enough to lose to a `%2e%2e` somewhere in this codebase's history. */
  const resolveKey = (key) => {
    const k = String(key ?? '');
    if (!KEY_RE.test(k)) throw Object.assign(new Error('对象键不合法'), { status: 400 });
    const full = path.resolve(path.join(root, k));
    if (!full.startsWith(root + path.sep)) throw Object.assign(new Error('对象键不合法'), { status: 400 });
    return full;
  };

  return {
    kind: 'local',
    root,

    /**
     * Write one object. Mode 0600: on a shared VM the other services have no
     * business reading a kindergarten's photographs.
     * @param {string} key @param {Buffer} bytes
     * @returns {Promise<{key: string, size: number}>}
     */
    async put(key, bytes) {
      const full = resolveKey(key);
      await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
      await writeFile(full, bytes, { mode: 0o600 });
      return { key, size: bytes.length };
    },

    /**
     * Read one object as a stream. Throws ENOENT when the row outlived the
     * object, which the caller must answer as 404 rather than 500 — a broken
     * link is a data problem, not a server fault.
     * @param {string} key @returns {import('node:fs').ReadStream}
     */
    get(key) {
      return createReadStream(resolveKey(key));
    },

    /** @param {string} key @returns {Promise<number|null>} size, null if absent */
    async size(key) {
      try { return (await stat(resolveKey(key))).size; } catch { return null; }
    },

    /**
     * Remove one object. Returns false when it was already gone — a delete
     * that has nothing to delete is a success for the caller's purposes
     * (erasure), and throwing would abort a course deletion halfway.
     * @param {string} key @returns {Promise<boolean>}
     */
    async delete(key) {
      // A key that no longer parses cannot be resolved to a path, and must not
      // take an erase down: report it as「nothing removed」so the caller's
      // orphan warning fires instead.
      let full;
      try { full = resolveKey(key); } catch { return false; }
      try { await unlink(full); return true; } catch { return false; }
    },

    /**
     * Free bytes on the volume holding the objects, or null when this Node
     * cannot say (statfs landed in 18.15).
     *
     * NULL IS NOT ZERO AND NOT INFINITY. The caller decides what an unknown
     * means; here we only refuse to invent a number.
     * @returns {Promise<number|null>}
     */
    async freeBytes() {
      try {
        await mkdir(root, { recursive: true, mode: 0o700 });
        const s = await statfs(root);
        return Number(s.bsize) * Number(s.bavail);
      } catch { return null; }
    },
  };
}
