// session-log.mjs — developer-mode session logger + export (调试抽屉「日志」面板).
// Tracks user input, API in/out, workflow progression, harness verdicts, and
// errors as structured entries; every category defaults ON and can be toggled
// individually. The buffer lives in memory (capped ring); only the category
// toggles persist. Secrets (API keys/passwords) are redacted BEFORE an entry
// is stored, so an exported log never contains a key.
//
// The store core is DOM-free (unit-tested in demo/tests/session-log.test.mjs);
// only mountLogPanel() touches the document.

/** Log categories — ids are stable (they appear in exported files). */
export const LOG_CATEGORIES = [
  { id: 'user_input', label: '用户输入' },
  { id: 'api_out', label: 'API 发送' },
  { id: 'api_in', label: 'API 返回' },
  { id: 'workflow', label: '工作流' },
  { id: 'harness', label: '护栏' },
  { id: 'error', label: '错误' },
  { id: 'session', label: '会话/设置' },
];

const CATEGORY_IDS = new Set(LOG_CATEGORIES.map((c) => c.id));

/** Object keys whose string values are secrets and must never enter the log. */
const SECRET_KEY_RE = /^(key|apikey|api_key|token|password|secret|authorization)$/i;

/**
 * Deep-copy a value with secret-bearing fields masked. Two rules:
 * 1. any object property whose NAME matches SECRET_KEY_RE and whose value is a
 *    non-empty string becomes '••redacted••';
 * 2. a property literally named `keys` (the request-body provider→apiKey map)
 *    has every string value masked, whatever the provider ids are.
 * @param {unknown} value
 * @returns {unknown} redacted deep copy (input is never mutated)
 */
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k) && typeof v === 'string' && v) {
        out[k] = '••redacted••';
      } else if (k === 'keys' && v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [
          pk, typeof pv === 'string' && pv ? '••redacted••' : redactSecrets(pv),
        ]));
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * Create a session-log store.
 * @param {{
 *   max?: number,
 *   loadConfig?: () => Record<string, boolean>|null,
 *   saveConfig?: (cfg: Record<string, boolean>) => void,
 *   now?: () => string,
 * }} [opts] storage/clock injection (tests); defaults: no persistence, ISO clock.
 */
export function createLogStore(opts = {}) {
  const max = opts.max ?? 1000;
  const now = opts.now ?? (() => new Date().toISOString());
  const saveConfig = opts.saveConfig ?? (() => {});

  /** Category toggles — default ALL ON; persisted values override. */
  const config = Object.fromEntries(LOG_CATEGORIES.map((c) => [c.id, true]));
  const persisted = opts.loadConfig ? opts.loadConfig() : null;
  if (persisted && typeof persisted === 'object') {
    for (const id of Object.keys(config)) {
      if (typeof persisted[id] === 'boolean') config[id] = persisted[id];
    }
  }

  /** @type {Array<{seq: number, ts: string, cat: string, event: string, data: unknown}>} */
  let entries = [];
  let seq = 0;
  let dropped = 0; // entries evicted by the ring cap (still counted, for honesty)
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) fn(); };

  return {
    /**
     * Append one entry (no-op when the category is toggled off or unknown).
     * `data` is secret-redacted and deep-copied at append time, so later
     * mutation of the source object cannot change what was logged.
     */
    log(cat, event, data) {
      if (!CATEGORY_IDS.has(cat) || !config[cat]) return;
      seq += 1;
      entries.push({ seq, ts: now(), cat, event, data: redactSecrets(data) });
      if (entries.length > max) {
        dropped += entries.length - max;
        entries = entries.slice(entries.length - max);
      }
      notify();
    },
    isEnabled(cat) { return Boolean(config[cat]); },
    setEnabled(cat, on) {
      if (!CATEGORY_IDS.has(cat)) return;
      config[cat] = Boolean(on);
      saveConfig({ ...config });
      notify();
    },
    getEntries() { return [...entries]; },
    countByCategory() {
      const counts = Object.fromEntries(LOG_CATEGORIES.map((c) => [c.id, 0]));
      for (const e of entries) counts[e.cat] += 1;
      return counts;
    },
    get dropped() { return dropped; },
    clear() {
      entries = [];
      dropped = 0;
      notify();
    },
    /** Assemble the export file body (pure — the download itself is UI-side). */
    buildExportPayload(context = {}) {
      return {
        app: '小小探索家 demo · session log',
        exported_at: now(),
        context,
        categories: { ...config },
        entry_count: entries.length,
        dropped_over_cap: dropped,
        entries: [...entries],
      };
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** yyyymmdd-hhmmss stamp for the export filename. */
function fileStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Trigger a browser download of the export payload as a JSON file. */
export function downloadLog(store, context) {
  const payload = store.buildExportPayload(context);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `peipao-session-log-${fileStamp()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Mount the 日志 panel into the debug drawer: per-category toggles with live
 * counts, 导出 JSON / 清空 actions, and a total line. Repaints on store change.
 * @param {HTMLElement} container the static #log-panel node (never wiped by renderDebug)
 * @param {ReturnType<typeof createLogStore>} store
 * @param {{ getContext?: () => Object }} [opts] extra context stamped into exports
 */
export function mountLogPanel(container, store, opts = {}) {
  const getContext = opts.getContext ?? (() => ({}));

  const heading = document.createElement('div');
  heading.className = 'debug-heading';
  heading.textContent = '日志（session log）';

  const toggles = document.createElement('div');
  toggles.className = 'log-toggles';
  /** @type {Map<string, HTMLElement>} category id → count span */
  const countEls = new Map();
  for (const cat of LOG_CATEGORIES) {
    const label = document.createElement('label');
    label.className = 'log-toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = store.isEnabled(cat.id);
    box.addEventListener('change', () => store.setEnabled(cat.id, box.checked));
    const count = document.createElement('span');
    count.className = 'log-count';
    countEls.set(cat.id, count);
    label.append(box, document.createTextNode(cat.label), count);
    toggles.append(label);
  }

  const actions = document.createElement('div');
  actions.className = 'log-actions';
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'log-btn';
  exportBtn.textContent = '导出 JSON';
  exportBtn.addEventListener('click', () => downloadLog(store, getContext()));
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'log-btn';
  clearBtn.textContent = '清空';
  clearBtn.addEventListener('click', () => store.clear());
  actions.append(exportBtn, clearBtn);

  const meta = document.createElement('div');
  meta.className = 'log-meta';

  const repaint = () => {
    const counts = store.countByCategory();
    for (const [id, node] of countEls) node.textContent = ` ${counts[id]}`;
    const total = store.getEntries().length;
    meta.textContent = `共 ${total} 条`
      + (store.dropped ? ` · 超出上限已丢弃 ${store.dropped} 条（先导出再清空可避免）` : '')
      + ' · 密钥已自动脱敏';
  };
  store.onChange(repaint);
  repaint();

  container.append(heading, toggles, actions, meta);
}
