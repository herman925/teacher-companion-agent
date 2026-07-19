// blueprint-map-layout tests: the 导图 geometry is pure and deterministic —
// same tree in, same boxes out; collapse hides subtrees; edges connect
// parent-right to child-left; no overlapping sibling boxes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBlueprint, numberBlueprint } from '../src/blueprint-util.mjs';
import { layoutBlueprintMap, edgePath, nodeBox, MAP_METRICS } from '../src/blueprint-map-layout.mjs';

const TREE = normalizeBlueprint({
  modules: [
    { id: 'net', title: '主题预设网络图', children: [
      { id: 'a', title: '来源与故事' },
      { id: 'b', title: '真实场景' },
      { id: 'c', title: '幼儿可能提出的问题', status: 'hypothesis' },
    ] },
    { id: 'depth', title: '资源深度网络', children: [
      { id: 'w', title: '物象层' }, { id: 't', title: '体验层' },
    ] },
  ],
});
const NUMBERED = numberBlueprint(TREE.modules);

test('layout is deterministic: two runs, identical geometry', () => {
  const a = layoutBlueprintMap(NUMBERED);
  const b = layoutBlueprintMap(NUMBERED);
  assert.deepEqual(a, b);
});

test('siblings never overlap vertically; parent centers on its children', () => {
  const { nodes } = layoutBlueprintMap(NUMBERED);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const sibs = ['a', 'b', 'c'].map((id) => byId[id]).sort((p, q) => p.y - q.y);
  for (let i = 1; i < sibs.length; i++) {
    assert.ok(sibs[i].y >= sibs[i - 1].y + sibs[i - 1].h + MAP_METRICS.gapY, 'sibling gap respected');
  }
  const net = byId.net;
  const mid = (sibs[0].y + sibs[2].y + sibs[2].h) / 2;
  assert.ok(Math.abs((net.y + net.h / 2) - mid) < 1, 'parent vertically centered on child span');
});

test('edges run parent-right-center → child-left-center', () => {
  const { nodes, edges } = layoutBlueprintMap(NUMBERED);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const e = edges.find((x) => x.from === 'net' && x.to === 'a');
  assert.equal(e.x1, byId.net.x + byId.net.w);
  assert.equal(e.y1, byId.net.y + byId.net.h / 2);
  assert.equal(e.x2, byId.a.x);
  assert.equal(e.y2, byId.a.y + byId.a.h / 2);
  assert.match(edgePath(e), /^M .+ C .+$/);
});

test('collapse hides the subtree and flags the node; expand restores', () => {
  const collapsed = layoutBlueprintMap(NUMBERED, new Set(['net']));
  assert.ok(!collapsed.nodes.some((n) => n.id === 'a'), 'collapsed children not laid out');
  const net = collapsed.nodes.find((n) => n.id === 'net');
  assert.equal(net.collapsed, true);
  assert.equal(net.childCount, 3, 'childCount preserved for the +n badge');
  const open = layoutBlueprintMap(NUMBERED);
  assert.ok(open.nodes.some((n) => n.id === 'a'));
  assert.ok(collapsed.height < open.height, 'collapsing shrinks the canvas');
});

test('empty blueprint lays out to a 0x0 canvas — never negative dimensions', () => {
  const empty = layoutBlueprintMap([]);
  assert.equal(empty.width, 0);
  assert.equal(empty.height, 0);
  assert.deepEqual(empty.nodes, []);
  const single = layoutBlueprintMap(numberBlueprint(normalizeBlueprint({ modules: [{ id: 'solo', title: '独节点' }] }).modules));
  assert.ok(single.width > 0 && single.height > 0, 'single node still gets positive canvas');
});

test('CJK titles truncate with ellipsis but keep full title for the tooltip', () => {
  const { label, w } = nodeBox('这是一个特别特别长的节点标题超过上限');
  assert.ok(label.endsWith('…'));
  assert.equal([...label].length, MAP_METRICS.maxChars);
  assert.ok(w <= MAP_METRICS.maxChars * MAP_METRICS.charW + MAP_METRICS.padX * 2);
});
