// turn-wiring.test.mjs — the guards that only exist if serve.mjs actually calls
// them (2026-08 review). Everything here is a WIRING claim, which is why it runs
// against a real server process rather than against the pure modules: each of
// these rules already passed its own unit fixtures while being dead on the path
// a logged-in teacher uses.
//
// Two claims, both directions each:
//   1. The scope shell's verdict is persisted on the COURSE endpoint, not only
//      on anonymous /api/chat. The 范围护栏 tab is what the SCOPE_ENFORCE=1
//      decision gets made from, and it was reading the wrong population.
//   2. `gate_report` says whether the confirmations in a turn were CHECKED
//      against the teacher's words, so a verified confirmation and a merely
//      trusted one are distinguishable downstream.
//
// Hermetic: scratch DEMO_DATA_DIR + scratch port, provider 'mock' (never leaves
// the process, needs no key), ADMIN_TOKEN unset so the admin API can provision
// the test user.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..');

const PORT = 8921;
const BASE = `http://127.0.0.1:${PORT}`;

async function api(pathname, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON bodies stay in text */ }
  return { status: res.status, json, text, setCookie: res.headers.getSetCookie?.() ?? [] };
}

test('the course endpoint writes scope rows, and only for off-purpose turns', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cst-wiring-'));
  const child = spawn(process.execPath, [path.join(DEMO, 'serve.mjs'), '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DEMO_DATA_DIR: dataDir, ADMIN_TOKEN: '' },
  });
  t.after(async () => { child?.kill(); await rm(dataDir, { recursive: true, force: true }); });
  const started = new Promise((resolve) => {
    child.stdout.on('data', (b) => { if (String(b).includes(String(PORT))) resolve(); });
  });
  await Promise.race([started, once(child, 'exit').then(() => { throw new Error('server exited'); })]);

  const created = await api('/api/admin/users', { method: 'POST', body: { username: 'wiring_srv' } });
  assert.equal(created.status, 200, created.text);
  const login = await api('/api/auth/login', {
    method: 'POST', body: { username: 'wiring_srv', password: created.json.temp_password },
  });
  const cookie = login.setCookie.find((c) => c.startsWith('cst_sid=')).split(';')[0];
  const course = await api('/api/courses', { method: 'POST', body: { title: '龙舟' }, cookie });
  const id = course.json.course.id;
  const chat = (message) => api(`/api/courses/${id}/chat`, {
    method: 'POST', cookie, body: { message, provider: 'mock' },
  });

  // MUST PASS half first: real course work leaves no scope row at all. A log
  // that fills up with her ordinary turns is a log nobody can judge from.
  const planning = await chat('我想带大班孩子围绕龙舟做一个月的主题探究课程');
  assert.ok(planning.json.events.some((e) => e.event === 'turn'), `turn expected: ${planning.text}`);
  let log = await api('/api/admin/scope');
  assert.equal(log.json.total, 0, '正常备课不该进范围护栏日志');

  // Off-purpose, on the endpoint every logged-in teacher actually uses.
  await chat('长沙今天天气怎么样');
  log = await api('/api/admin/scope');
  assert.equal(log.json.total, 1, '课程端点的判定必须落库，否则那张表读的是另一群人');
  const row = log.json.rows[0];
  assert.equal(row.rule, 'weather');
  assert.equal(row.refused, false, '默认只记录不拦截（SCOPE_ENFORCE 未开）');
  assert.equal(row.user_id, created.json.user.id, '课程端点要记下是谁');
  assert.ok(row.excerpt.length <= 60, '运维日志里不放整条教师消息');

  // gate_report carries the citation flag, so a checked confirmation and a
  // trusted one are not the same row downstream.
  const turn = planning.json.events.find((e) => e.event === 'turn');
  assert.equal(turn.data.gate_report.citation_checked, true);

  // The revision cap (harness rule 2c) reads `askedLastTurn` off the PREVIOUS
  // agent row's stored `turn_contract`. The rule has its own both-directions
  // fixtures; what only a live server can show is that the field it reads is
  // actually there and actually populated — a cap computed from a field that is
  // always undefined would pass every unit test and never fire once.
  const stored = await api(`/api/courses/${id}/messages`, { cookie });
  const agentRow = stored.json.messages.filter((m) => m.role === 'agent').at(-1);
  assert.ok(agentRow, '应当存下 agent 这一轮');
  assert.ok(agentRow.turn_contract, 'turn_contract 必须落库——追问上限就是从它读的');
  assert.ok(Array.isArray(agentRow.turn_contract.questions),
    'questions 要以数组形状留在记录里，而不是只留渲染后的正文');
});
