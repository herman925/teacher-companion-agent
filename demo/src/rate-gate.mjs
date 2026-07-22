// rate-gate.mjs — persistent sliding-window rate limiting
// (spec 2026-07-22-key-vault-and-rate-limits-design.md §5).
//
// Server-authoritative: counters use the injected clock (server time), persist
// through the injected load/save (file store in the demo), and survive
// restarts. Nothing client-supplied is ever a counter value — only a key.
//
// One mechanism covers both shapes:
//   - fail counters (login, admin token, old password): check() before the
//     attempt, record() after a failure, reset() on success;
//   - use quotas (model turns, key saves): use() = check-and-record in one step.
//
// Honest limits (documented in SECURITY.md): single-process, in-file. Fine for
// the pilot VM; a multi-process deployment needs an external store.

/**
 * @param {{
 *   load: () => Promise<Object|null>,
 *   save: (state: Object) => Promise<void>,
 *   policies: Record<string, {limit: number, windowMs: number}>,
 *   now?: () => number,
 * }} deps
 */
export function createRateGate({ load, save, policies, now = Date.now }) {
  let state = null; // { 'kind|key': [ts, ...] } — lazily loaded
  let saveTimer = null;

  async function ensure() {
    if (!state) state = (await load().catch(() => null)) ?? {};
    return state;
  }
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { save(state).catch(() => {}); }, 250);
    saveTimer.unref?.();
  }
  function policy(kind) {
    const p = policies[kind];
    if (!p) throw new Error(`rate-gate: unknown kind ${kind}`);
    return p;
  }
  function pruned(id, windowMs) {
    const t = now();
    const arr = (state[id] ?? []).filter((x) => t - x < windowMs);
    if (arr.length) state[id] = arr; else delete state[id];
    return arr;
  }
  function verdict(arr, { limit, windowMs }) {
    if (arr.length < limit) return { limited: false, retryAfterSec: 0, count: arr.length };
    // Unlocks when the entry that keeps the count at `limit` leaves the window.
    const unlockTs = arr[arr.length - limit] + windowMs;
    return { limited: true, retryAfterSec: Math.max(1, Math.ceil((unlockTs - now()) / 1000)), count: arr.length };
  }

  return {
    /** Is this key currently over its limit? Never records. */
    async check(kind, key) {
      const p = policy(kind);
      await ensure();
      return verdict(pruned(`${kind}|${key}`, p.windowMs), p);
    },

    /** Record one failure (always — an over-limit attacker keeps counting). */
    async record(kind, key) {
      const p = policy(kind);
      await ensure();
      const arr = pruned(`${kind}|${key}`, p.windowMs);
      arr.push(now());
      state[`${kind}|${key}`] = arr;
      persist();
    },

    /** Quota shape: record the use unless already over. */
    async use(kind, key) {
      const p = policy(kind);
      await ensure();
      const arr = pruned(`${kind}|${key}`, p.windowMs);
      const v = verdict(arr, p);
      if (!v.limited) {
        arr.push(now());
        state[`${kind}|${key}`] = arr;
        persist();
      }
      return v;
    },

    /** Clear one key (e.g. successful login resets its username counter). */
    async reset(kind, key) {
      await ensure();
      delete state[`${kind}|${key}`];
      persist();
    },

    /** Admin view: every live entry with its verdict (tripped ones first). */
    async list() {
      await ensure();
      const rows = [];
      for (const id of Object.keys(state)) {
        const [kind] = id.split('|');
        const p = policies[kind];
        if (!p) continue;
        const arr = pruned(id, p.windowMs);
        if (!arr.length) continue;
        const v = verdict(arr, p);
        rows.push({
          id, kind, key: id.slice(kind.length + 1), count: v.count, limit: p.limit,
          limited: v.limited, retry_after: v.retryAfterSec,
          unlock_at: v.limited ? new Date(now() + v.retryAfterSec * 1000).toISOString() : null,
        });
      }
      rows.sort((a, b) => Number(b.limited) - Number(a.limited) || b.count - a.count);
      return rows;
    },

    /** Admin relief: clear one entry by its `kind|key` id. @returns removed? */
    async clearEntry(id) {
      await ensure();
      const had = id in state;
      delete state[id];
      persist();
      return had;
    },

    /** Admin relief: clear everything. */
    async clearAll() {
      await ensure();
      state = {};
      persist();
    },
  };
}
