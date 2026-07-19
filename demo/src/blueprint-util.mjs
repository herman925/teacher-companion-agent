// blueprint-util — pure helpers for the 阶段一预设蓝图 artifact (ADR-0003).
// The MODEL emits a semantic tree (stable ids + status); numbering, branching
// display and collapse state are reconstructed deterministically CLIENT-SIDE
// from this module. The model never writes display numbers.

/** Provenance statuses a blueprint node may carry (contract.zh.md). */
export const BLUEPRINT_STATUS = {
  confirmed: '已确认',
  teacher_preset: '老师预设',
  ai_suggestion: 'AI建议',
  hypothesis: '预设·待验证',
};

const KNOWN_STATUS = new Set(Object.keys(BLUEPRINT_STATUS));

/**
 * Normalize raw artifact data into a safe tree: guarantees ids (generated
 * from the path when the model omitted them), a known status (defaults to
 * ai_suggestion), string title/body, and an array children.
 * @param {Object} data raw `artifact.data` from the model
 * @returns {{version: string, modules: Array}} normalized tree
 */
export function normalizeBlueprint(data) {
  const src = data && typeof data === 'object' ? data : {};
  const version = typeof src.version === 'string' && src.version.trim() ? src.version.trim() : 'v0.1';
  const modules = Array.isArray(src.modules) ? src.modules : [];
  const seen = new Set();
  const normNode = (node, path) => {
    const n = node && typeof node === 'object' ? node : {};
    let id = typeof n.id === 'string' && n.id.trim() ? n.id.trim() : path;
    while (seen.has(id)) id = `${id}-dup`;
    seen.add(id);
    return {
      id,
      title: String(n.title ?? '').trim(),
      body: String(n.body ?? '').trim(),
      status: KNOWN_STATUS.has(n.status) ? n.status : 'ai_suggestion',
      children: (Array.isArray(n.children) ? n.children : []).map((c, i) => normNode(c, `${id}.${i + 1}`)),
    };
  };
  return { version, modules: modules.map((m, i) => normNode(m, `m${i + 1}`)) };
}

/**
 * Assign display numbers (1 / 1.1 / 1.1.2 …) and per-node status rollups by
 * walking the normalized tree. Pure: returns a new tree; input untouched.
 * Rollup counts include the node itself — a collapsed heading can honestly
 * summarize everything beneath it.
 * @param {Array} modules normalized modules from normalizeBlueprint()
 * @returns {Array} same shape plus {number, rollup:{confirmed,teacher_preset,ai_suggestion,hypothesis}}
 */
export function numberBlueprint(modules) {
  const walk = (node, number) => {
    const children = node.children.map((c, i) => walk(c, `${number}.${i + 1}`));
    const rollup = { confirmed: 0, teacher_preset: 0, ai_suggestion: 0, hypothesis: 0 };
    rollup[node.status] += 1;
    for (const c of children) for (const k of Object.keys(rollup)) rollup[k] += c.rollup[k];
    return { ...node, number, children, rollup };
  };
  return (modules || []).map((m, i) => walk(m, String(i + 1)));
}

/**
 * Flatten a numbered tree into [{number, id, title, status}] rows — the
 * number→id snapshot that later lets a teacher's 「把2.3换掉」 resolve against
 * the version they actually saw (Phase 3 uses this; kept here so the mapping
 * has exactly one implementation from day one).
 */
export function blueprintIndex(numberedModules) {
  const rows = [];
  const walk = (n) => {
    rows.push({ number: n.number, id: n.id, title: n.title, status: n.status });
    n.children.forEach(walk);
  };
  (numberedModules || []).forEach(walk);
  return rows;
}
