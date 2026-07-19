// blueprint-map-layout — pure, deterministic tidy-tree layout for the 预设蓝图
// map view. Zero dependencies, no DOM: takes the SAME normalized tree the list
// view uses (blueprint-util) and returns positioned boxes + edges. The model
// never draws; this module IS the 绞肉机 (structure in, geometry out) — all
// client-side, zero server cost. Rendering (SVG) lives in ui/render.js.

/** Geometry constants (px). CJK glyphs at 13px are ~13px wide. */
export const MAP_METRICS = {
  charW: 13,          // per CJK char at font-size 13
  padX: 10,           // node box horizontal padding
  boxH: 30,           // node box height
  maxChars: 12,       // truncate titles beyond this (full title via tooltip)
  gapY: 10,           // vertical gap between sibling subtrees
  cousinGap: 12,      // extra breathing after a sibling that has visible children
  gapX: 36,           // horizontal gap between depth columns
  rootW: 120,         // virtual root (blueprint title) column width
  badgeW: 34,         // room reserved right of a collapsed node for the +n badge
  foldPad: 20,        // extra box width on branch nodes for the fold affordance circle
  numCharW: 7,        // per char of the faint mono number prefix (10px mono)
};

/** Truncated display label + measured box width for a node title (plus its
 * client-assigned number prefix — the number comes from numberBlueprint(),
 * never from here or the model). */
export function nodeBox(title, number = '') {
  const chars = [...String(title ?? '')];
  const label = chars.length > MAP_METRICS.maxChars ? chars.slice(0, MAP_METRICS.maxChars - 1).join('') + '…' : chars.join('');
  const numW = number ? String(number).length * MAP_METRICS.numCharW + 6 : 0;
  const w = Math.max(3, [...label].length) * MAP_METRICS.charW + MAP_METRICS.padX * 2 + numW;
  return { label, w, numW };
}

/**
 * Layout the numbered blueprint tree (numberBlueprint output) as a horizontal
 * tidy tree. `collapsed` is a Set of node ids whose children are hidden —
 * collapse state is pure UI state, owned by the caller, never by the model.
 *
 * Returns { nodes, edges, width, height } where each node is
 * {id, number, title, label, status, depth, x, y, w, h, childCount, collapsed}
 * (x/y = box top-left) and each edge is {from, to, x1, y1, x2, y2}
 * (edge endpoints at box vertical centers).
 * @param {Array} numberedModules  output of numberBlueprint()
 * @param {Set<string>} [collapsed]
 */
export function layoutBlueprintMap(numberedModules, collapsed = new Set()) {
  const nodes = [];
  const edges = [];
  // Column width per depth = widest box at that depth (computed on visible nodes).
  const depthW = [];
  const measure = (n, depth) => {
    let { w } = nodeBox(n.title, n.number);
    if (n.children.length) w += MAP_METRICS.foldPad; // fold-circle room
    depthW[depth] = Math.max(depthW[depth] || 0, w);
    if (!collapsed.has(n.id)) for (const c of n.children) measure(c, depth + 1);
  };
  for (const m of numberedModules || []) measure(m, 0);

  const colX = (depth) => {
    let x = 0;
    for (let d = 0; d < depth; d++) x += (depthW[d] || 0) + MAP_METRICS.gapX;
    return x;
  };

  /** Post-order: returns subtree height; parents sit on the midpoint of their
   * FIRST and LAST child (not the span average — the two differ on uneven
   * subtrees and the average version reads subtly off). A sibling that itself
   * has visible children earns cousinGap extra breathing after its block. */
  const place = (n, depth, top) => {
    const box = nodeBox(n.title, n.number);
    const label = box.label;
    const numW = box.numW;
    const w = box.w + (n.children.length ? MAP_METRICS.foldPad : 0);
    const visibleChildren = collapsed.has(n.id) ? [] : n.children;
    let subtreeH = 0;
    const childRefs = [];
    visibleChildren.forEach((c, i) => {
      const h = place(c, depth + 1, top + subtreeH);
      childRefs.push(nodes[nodes.length - 1]); // post-order: last pushed IS c
      subtreeH += h;
      if (i < visibleChildren.length - 1) {
        subtreeH += MAP_METRICS.gapY;
        if (c.children.length && !collapsed.has(c.id)) subtreeH += MAP_METRICS.cousinGap;
      }
    });
    const ownH = MAP_METRICS.boxH;
    const totalH = Math.max(ownH, subtreeH);
    const y = childRefs.length
      ? (childRefs[0].y + childRefs[childRefs.length - 1].y) / 2 // uniform h → midpoint of first/last child
      : top;
    nodes.push({
      id: n.id, number: n.number, title: n.title, body: n.body ?? '', label, numW, status: n.status,
      depth, x: colX(depth), y, w, h: ownH,
      childCount: n.children.length, collapsed: collapsed.has(n.id),
      pending: (n.rollup?.hypothesis ?? 0) + (n.rollup?.pending_validation ?? 0) + (n.rollup?.ai_suggestion ?? 0),
    });
    for (const child of childRefs) {
      edges.push({
        from: n.id, to: child.id, toStatus: child.status,
        x1: colX(depth) + w, y1: y + ownH / 2,
        x2: child.x, y2: child.y + child.h / 2,
      });
    }
    return totalH;
  };

  let totalTop = 0;
  for (const m of numberedModules || []) {
    totalTop += place(m, 0, totalTop) + MAP_METRICS.gapY * 2;
  }
  // Canvas width = rightmost box edge, plus room for the +n fold badge that
  // renders OUTSIDE a collapsed node's box (SVG roots clip by default).
  const width = nodes.reduce((w, n) => Math.max(w, n.x + n.w + (n.collapsed && n.childCount ? MAP_METRICS.badgeW : 0)), 0);
  const height = Math.max(0, totalTop - MAP_METRICS.gapY * 2);
  return { nodes, edges, width, height };
}

/** SVG cubic path for an edge (horizontal S-curve — computed here so the
 * renderer stays dumb and the curve is testable). */
export function edgePath(e) {
  const mx = (e.x1 + e.x2) / 2;
  return `M ${e.x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${e.x2} ${e.y2}`;
}
