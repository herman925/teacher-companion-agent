// redact.mjs — one place that knows what a credential LOOKS like.
//
// The repository already had a value-shaped detector, and it lived inside
// demo/tests/key-custody.test.mjs — which means the test could prove a key
// never reached a request body while nothing stopped the same key coming back
// through an error message. Several vendors echo the submitted credential in an
// auth-failure body, and the key in play on that path is the PLATFORM env key,
// not the caller's. So the detector is promoted out of the test and applied on
// the way OUT of the process as well as on the way in.
//
// Name-based redaction (a property called `token`) and value-based redaction (a
// string that starts `sk-`) catch different failures. A key sitting inside a
// `message` string has no property name to match, which is exactly how an
// upstream error body carried one into the session log and out of the export.
//
// Zero dependencies and no I/O: this module is imported by the server, by the
// adapter and by browser UI code, so it must run unchanged in all three.

/**
 * Values that look like credentials whatever the field is called.
 *
 * Kept deliberately narrow — three shapes we have actually seen — because a
 * greedy pattern that masks ordinary prose would train people to ignore the
 * mask. It is a net, not a proof: anything this misses is still covered by the
 * rule that upstream bodies are not relayed at all (adapter.mjs).
 */
export const CREDENTIAL_VALUE = /(\bsk-[A-Za-z0-9_-]{3,})|(\bBearer\s+\S+)|(\bfe_oa_[A-Za-z0-9][A-Za-z0-9_-]*)/g;

/** What a masked credential reads as. Same string the session log uses, so a
 * reader sees one mask rather than wondering which layer produced which. */
export const MASK = '••redacted••';

/**
 * Replace every credential-shaped run in a string.
 *
 * Non-strings pass through untouched rather than being coerced: this is called
 * on error messages, and turning `undefined` into the text 「undefined」 would
 * put a fake message where an absent one was.
 *
 * @param {unknown} value
 * @returns {unknown} the same value, or a masked copy of the string
 */
export function scrubCredentials(value) {
  if (typeof value !== 'string' || !value) return value;
  // `CREDENTIAL_VALUE` is global, so `lastIndex` survives between calls on a
  // shared regex object. `String.prototype.replace` with a /g regex resets it
  // itself; `.test()` would not, which is why nothing here uses `.test()`.
  return value.replace(CREDENTIAL_VALUE, MASK);
}

/**
 * Does this string look like it carries a credential? Used by write paths that
 * REFUSE rather than mask — a teacher profile with a key pasted into it should
 * bounce back to her, not be silently saved with the key starred out.
 * @param {unknown} value
 * @returns {boolean}
 */
export function looksLikeCredential(value) {
  if (typeof value !== 'string' || !value) return false;
  // A fresh regex per call: see the lastIndex note above.
  return new RegExp(CREDENTIAL_VALUE.source).test(value);
}

/**
 * Walk any JSON-ish value and report whether a credential-shaped string sits
 * anywhere inside it, at any depth, in a key or a value.
 * @param {unknown} value
 * @returns {boolean}
 */
export function containsCredential(value) {
  if (typeof value === 'string') return looksLikeCredential(value);
  if (Array.isArray(value)) return value.some(containsCredential);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => looksLikeCredential(k) || containsCredential(v));
  }
  return false;
}
