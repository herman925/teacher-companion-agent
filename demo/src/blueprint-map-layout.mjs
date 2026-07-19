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
  gapX: 36,           // horizontal gap between depth columns
  rootW: 120,         // virtual root (blueprint title) column width
  badgeW: 34,         // room reserved right of a collapsed node for the +n badge
};

/** Truncated display label + measured box width for a node title. */
export function nodeBox(title) {
  const chars = [...String(title ?? '')];
  const label = chars.length > MAP_METRICS.maxChars ? chars.slice(0, MAP_METRICS.maxChars - 1).join('') + '…' : chars.join('');
  const w = Math.max(3, [...label].length) * MAP_METRICS.charW + MAP_METRICS.padX * 2;
  return { label, w };
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
    const { w } = nodeBox(n.title);
    depthW[depth] = Math.max(depthW[depth] || 0, w);
    if (!collapsed.has(n.id)) for (const c of n.children) measure(c, depth + 1);
  };
  for (const m of numberedModules || []) measure(m, 0);

  const colX = (depth) => {
    let x = 0;
    for (let d = 0; d < depth; d++) x += (depthW[d] || 0) + MAP_METRICS.gapX;
    return x;
  };

  /** Post-order: returns subtree height; assigns y so parents center on children. */
  const place = (n, depth, top) => {
    const { label, w } = nodeBox(n.title);
    const visibleChildren = collapsed.has(n.id) ? [] : n.children;
    let subtreeH = 0;
    const childTops = [];
    for (const c of visibleChildren) {
      const h = place(c, depth + 1, top + subtreeH);
      childTops.push(h);
      subtreeH += h + MAP_METRICS.gapY;
    }
    if (visibleChildren.length) subtreeH -= MAP_METRICS.gapY;
    const ownH = MAP_METRICS.boxH;
    const totalH = Math.max(ownH, subtreeH);
    const y = visibleChildren.length
      ? top + (subtreeH - ownH) / 2   // center on the span of children
      : top;
    nodes.push({
      id: n.id, number: n.number, title: n.title, label, status: n.status,
      depth, x: colX(depth), y, w, h: ownH,
      childCount: n.children.length, collapsed: collapsed.has(n.id),
      pending: (n.rollup?.hypothesis ?? 0) + (n.rollup?.ai_suggestion ?? 0),
    });
    for (const c of visibleChildren) {
      // edge parent-right-center → child-left-center; child boxes already pushed
      const child = nodes.find((p) => p.id === c.id);
      edges.push({
        from: n.id, to: c.id,
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
