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
  pending_validation: '待现场验证',
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
    const out = {
      id,
      title: String(n.title ?? '').trim(),
      body: String(n.body ?? '').trim(),
      status: KNOWN_STATUS.has(n.status) ? n.status : 'ai_suggestion',
      children: (Array.isArray(n.children) ? n.children : []).map((c, i) => normNode(c, `${id}.${i + 1}`)),
    };
    // Provenance detail (DESIGN.md §5b): why this node exists. Carried through
    // so the detail view can show 依据/假设/教学依据 — never invented here.
    if (n.rationale && typeof n.rationale === 'object') {
      out.rationale = {
        ...(Array.isArray(n.rationale.heard) ? { heard: n.rationale.heard.filter((h) => h && h.quote).map((h) => ({ quote: String(h.quote), ...(h.msg_id ? { msg_id: String(h.msg_id) } : {}) })) } : {}),
        ...(n.rationale.assumed ? { assumed: String(n.rationale.assumed) } : {}),
        ...(n.rationale.pedagogy ? { pedagogy: String(n.rationale.pedagogy) } : {}),
        ...(n.rationale.profile_basis ? { profile_basis: String(n.rationale.profile_basis) } : {}),
        ...(n.rationale.adjust ? { adjust: String(n.rationale.adjust) } : {}),
      };
      if (!Object.keys(out.rationale).length) delete out.rationale;
    }
    if (Array.isArray(n.evidence_refs) && n.evidence_refs.length) out.evidence_refs = n.evidence_refs.map(String);
    return out;
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
    const rollup = { confirmed: 0, teacher_preset: 0, ai_suggestion: 0, hypothesis: 0, pending_validation: 0 };
    rollup[node.status] += 1;
    for (const c of children) for (const k of Object.keys(rollup)) rollup[k] += c.rollup[k];
    return { ...node, number, children, rollup };
  };
  return (modules || []).map((m, i) => walk(m, String(i + 1)));
}

/**
 * Count nodes not yet confirmed — the chip's 「N 项待确认」. Counts every node
 * (branch + leaf), matching the panel's per-branch rollup arithmetic.
 * @param {Array} modules normalized modules from normalizeBlueprint()
 */
export function countUnconfirmed(modules) {
  let n = 0;
  const walk = (node) => {
    if (node.status !== 'confirmed') n += 1;
    node.children.forEach(walk);
  };
  (modules || []).forEach(walk);
  return n;
}

/**
 * Package per-node 批注 into ONE teacher message (mirror of the question-card
 * packaging): numbered lines quoting the node the teacher saw, with the stable
 * id the model needs to answer via blueprint_delta.
 * @param {Array<{id: string, number: string, title: string, text: string}>} comments
 * @returns {string|null} packed message, or null when nothing to send
 */
export function packBlueprintComments(comments) {
  const rows = (comments || []).filter((c) => c && String(c.text ?? '').trim());
  if (!rows.length) return null;
  // One comment = ONE line (the parse side is line-anchored): newlines in the
  // teacher's text collapse to spaces; 「」 in titles would break the quoting.
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const safeTitle = (s) => oneLine(s).replace(/[「」]/g, '');
  const lines = rows.map((c, i) =>
    `${i + 1}. 「${c.number} ${safeTitle(c.title)}」(id: ${c.id})：${oneLine(c.text)}`);
  return `【蓝图批注】\n${lines.join('\n')}`;
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
