// uploads.test.mjs — teacher uploads: what gets in, and who can read it back.
//
// Herman's requirement, verbatim: 「whatever users upload or talk about is
// strictly private: only accessible to that specific user and to the admins」.
// That is one sentence and several routes, so the privacy half is asserted
// ONCE PER ROUTE — a file that is unreachable through the endpoint that was
// designed for it and reachable through the static handler is not private, it
// is private in the place somebody remembered to look.
//
// Routes probed with teacher B against teacher A's file:
//   · GET /api/materials/:id/view          (guessing the id — she has it here,
//                                           which is stronger than guessing)
//   · the same, with no session at all
//   · GET /api/courses/:id/materials       (A's course, B's cookie)
//   · GET /api/admin/courses/:id/materials/:mid/view  (no admin token)
//   · the static file handler, pointed at the objects directory
//   · GET /api/admin/export                (object keys must not ride it)
//
// And the ingest half, both directions: content decides the type, a lie about
// the type is refused, EXIF comes off, and the caps hold.
//
// Hermetic: scratch DEMO_DATA_DIR, scratch port, no keys, no provider calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm, readdir, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { intakeFile, stripJpegMetadata } from '../src/upload-intake.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..');
const ADMIN_TOKEN = 'upload-test-token';

/** A JPEG whose EXIF block carries something we can search for afterwards. */
function jpegWithExif(secret = 'GPS-22.5431-114.0579', body = 'PIXELS') {
  const exif = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from(secret)]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(exif.length + 2); return b; })(),
    exif,
  ]);
  const sosHeader = Buffer.from([0xff, 0xda, 0x00, 0x02]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), app1, sosHeader, Buffer.from(body), Buffer.from([0xff, 0xd9]),
  ]);
}

const pdfBytes = () => Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');
/** DOCX is a ZIP that actually names the Word main part; a bare ZIP is not. */
const docxBytes = () => Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('....[Content_Types].xml....word/document.xml....'),
]);
const bareZipBytes = () => Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....payload.bin....'),
]);
/** A Windows executable, which is what 「photo.jpg」 sometimes is. */
const exeBytes = () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0x90)]);

/**
 * One server, one scratch data dir. `dataDir` is created INSIDE demo/ on
 * purpose for the static-handler probe: with the default `.data` layout the
 * dot-segment rule already refuses the path, which would make that assertion
 * pass for a reason unrelated to uploads. A non-dot directory inside the served
 * root is the case where only the objects guard stands.
 */
/** Ask the OS for a port nobody is on, starting from the hint. Fixed ports made
 * this file report a defect in the upload routes whenever something unrelated
 * on the machine happened to hold 8942 — a red that says nothing about the code
 * is worse than no test, because it teaches everyone to re-run instead of read. */
async function freePort(hint) {
  for (let port = hint; port < hint + 200; port += 1) {
    const taken = await new Promise((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(true));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
    });
    if (!taken) return port;
  }
  throw new Error(`no free port near ${hint}`);
}

async function startServer(t, hint) {
  const port = await freePort(hint);
  const dataDir = path.join(DEMO, `tmp-uploads-${port}`);
  await mkdir(dataDir, { recursive: true });
  const child = spawn(process.execPath, [path.join(DEMO, 'serve.mjs'), '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, DEMO_DATA_DIR: dataDir, DATABASE_URL: '', ADMIN_TOKEN,
      MINIMAX_API_KEY: '', GLM_API_KEY: '', ZAI_API_KEY: '', KIMI_API_KEY: '',
    },
  });
  // The kill is asynchronous: on Windows (and on this Google Drive mount) the
  // child can still hold a handle inside dataDir when rm runs, and rmdir then
  // fails ENOTEMPTY — a teardown race that fails a test whose assertions all
  // passed. Retry briefly, and never let cleanup be the thing that reports a
  // defect: a flaky red is worse than a leaked temp directory, because it
  // trains everyone to re-run instead of read.
  t.after(async () => {
    child.kill();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { await rm(dataDir, { recursive: true, force: true }); return; }
      catch { await new Promise((r) => setTimeout(r, 100)); }
    }
  });
  const started = new Promise((resolve) => {
    child.stdout.on('data', (b) => { if (String(b).includes(String(port))) resolve(); });
  });
  await Promise.race([started, once(child, 'exit').then(() => { throw new Error('server exited'); })]);

  const base = `http://127.0.0.1:${port}`;
  const call = async (pathname, { method = 'GET', body, cookie, headers = {}, raw = false } = {}) => {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        ...(raw ? {} : { 'content-type': 'application/json' }),
        accept: raw ? '*/*' : 'application/json',
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
    });
    if (raw) return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON stays in text */ }
    return { status: res.status, json, text, setCookie: res.headers.getSetCookie?.() ?? [] };
  };
  const admin = (pathname, opts = {}) => call(pathname, {
    ...opts, headers: { ...(opts.headers ?? {}), 'x-admin-token': ADMIN_TOKEN },
  });
  /** Provision a teacher and log her in. */
  const teacher = async (username) => {
    const created = await admin('/api/admin/users', { method: 'POST', body: { username } });
    assert.equal(created.status, 200, created.text);
    const login = await call('/api/auth/login', {
      method: 'POST', body: { username, password: created.json.temp_password },
    });
    const cookie = login.setCookie.find((c) => c.startsWith('cst_sid=')).split(';')[0];
    return { id: created.json.user.id, cookie };
  };
  const accessRows = async () => {
    const dir = path.join(dataDir, 'auth', 'access-log');
    let names;
    try { names = await readdir(dir); } catch { return []; }
    const rows = [];
    for (const n of names.sort()) {
      for (const line of (await readFile(path.join(dir, n), 'utf8')).split('\n')) {
        if (line.trim()) rows.push(JSON.parse(line));
      }
    }
    return rows;
  };
  return { call, admin, teacher, accessRows, dataDir };
}

/** Upload one file and return the created material. */
async function upload(call, cookie, courseId, bytes, contentType, query = '') {
  return call(`/api/courses/${courseId}/materials${query}`, {
    method: 'POST', cookie, raw: true, body: bytes, headers: { 'content-type': contentType },
  }).then(async (r) => {
    // raw:true returns bytes; re-read as JSON for the upload response
    const text = r.bytes.toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch { /* leave null */ }
    return { status: r.status, json, text };
  });
}

// ===================== THE STRIPPER, WITHOUT A SERVER =====================
//
// These are pure and run in-process, because the interesting JPEGs are the ones
// no fixture builder writes by accident: a phone's motion photo (a whole MP4
// appended after the picture's end marker), a multi-picture JPEG (a second full
// image, with its own APP1 and its own GPS, in the same place), and the APPn
// segments that are not APP1. The server tests above prove the route; these
// prove the rule the route depends on.

/** One length-prefixed JPEG segment. */
function seg(marker, payload) {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, Buffer.from(payload)]);
}

/** A structurally valid JPEG built out of the parts a test cares about. */
function jpegOf({ segments = [], scan = Buffer.from('PIXELS'), trailer = Buffer.alloc(0) } = {}) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...segments,
    Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.from(scan),
    Buffer.from([0xff, 0xd9]),
    Buffer.from(trailer),
  ]);
}

test('every application segment except JFIF and ICC comes off, and so does anything after the end marker', () => {
  const gps = 'GPS-22.5431-114.0579';
  const file = jpegOf({
    segments: [
      seg(0xe0, Buffer.from('JFIF\0')),          // APP0 — kept
      seg(0xe1, Buffer.from(`Exif\0\0${gps}`)),              // APP1 EXIF — off
      seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>')), // XMP — off
      seg(0xe2, Buffer.from(`MPF\0${gps}`)),                 // APP2 MPF — off
      seg(0xe2, Buffer.from('ICC_PROFILE\0\0profile-bytes')), // APP2 ICC — kept
      seg(0xe3, Buffer.from(`Meta\0${gps}`)),                // APP3 — off
      seg(0xed, Buffer.from(`Photoshop 3.0\0${gps}`)),       // APP13 IPTC — off
      seg(0xfe, Buffer.from(`拍摄地点 ${gps}`)),              // COM — off
    ],
    // A motion photo's video, appended past the EOI. This is the byte range the
    // old code copied verbatim, which is how a second copy of the coordinates
    // walked through a function whose verdict said `exif_stripped: true`.
    trailer: Buffer.concat([Buffer.from('ftypmp42'), Buffer.from(`moov${gps}`)]),
  });

  const out = intakeFile(file, 'image/jpeg');
  assert.equal(out.ok, true);
  assert.equal(out.exif_stripped, true);
  assert.equal(out.trailer_dropped, true, '尾巴掉了这件事要说出来');
  assert.match(out.notice, /只留下了照片本身/);

  const bytes = out.bytes;
  assert.ok(!bytes.includes(Buffer.from(gps)), '坐标一份都不许留下');
  for (const gone of ['Exif', 'xmpmeta', 'MPF\0', 'Meta\0', 'Photoshop 3.0', '拍摄地点', 'ftypmp42']) {
    assert.ok(!bytes.includes(Buffer.from(gone)), `${gone} 应该被去掉`);
  }
  assert.ok(bytes.includes(Buffer.from('JFIF')), 'JFIF 头要留着——没有它图渲染不对');
  assert.ok(bytes.includes(Buffer.from('ICC_PROFILE')), 'ICC 色彩配置要留着');
  assert.ok(bytes.includes(Buffer.from('PIXELS')), '图像数据要留着');
  assert.deepEqual(bytes.subarray(-2), Buffer.from([0xff, 0xd9]), '文件在它自己的结束标记处结束');
});

test('an ordinary JFIF + ICC photo passes through whole', () => {
  // The must-pass direction. A rule that only ever removes things is not a rule
  // anybody can trust with a teacher's photographs.
  const file = jpegOf({
    segments: [
      seg(0xe0, Buffer.from('JFIF\0')),
      seg(0xe2, Buffer.from('ICC_PROFILE\0\0profile-bytes')),
      seg(0xdb, Buffer.alloc(64, 0x10)),   // DQT — structural, must survive
    ],
  });
  const out = intakeFile(file, 'image/jpeg');
  assert.equal(out.ok, true);
  assert.equal(out.exif_stripped, true, '「跑过一遍」，不是「找到了东西」');
  assert.equal(out.trailer_dropped, false);
  assert.equal(out.notice, '');
  assert.deepEqual(out.bytes, file, '没有可去的东西时，一个字节都不动');
});

test('restart markers, stuffed bytes and a second scan do not end the picture early', () => {
  // A progressive JPEG has several scans, and scan data legally contains FF 00
  // and FF D0–D7. Treating the first FF as a marker would truncate the image;
  // treating the rest of the file as scan data was the old bug. Both directions
  // of the same boundary.
  const scan1 = Buffer.from([0x41, 0xff, 0x00, 0x42, 0xff, 0xd0, 0x43]);
  const file = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe1, Buffer.from('Exif\0\0SECRET')),
    Buffer.from([0xff, 0xda, 0x00, 0x02]), scan1,
    seg(0xc4, Buffer.alloc(8, 0x20)),                       // DHT between scans
    Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.from('SECONDSCAN'),
    Buffer.from([0xff, 0xd9]),
  ]);
  const out = stripJpegMetadata(file);
  assert.ok(out, '这是一个合法的渐进式 JPEG');
  assert.equal(out.trailerBytes, 0);
  assert.ok(!out.buffer.includes(Buffer.from('SECRET')));
  assert.ok(out.buffer.includes(scan1), '第一段扫描数据要完整留着');
  assert.ok(out.buffer.includes(Buffer.from('SECONDSCAN')), '第二段也是');
});

test('a JPEG that never reaches its end marker is refused, not half-kept', () => {
  const truncated = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe1, Buffer.from('Exif\0\0SECRET')),
    Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.from('PIXELS'),
  ]);
  assert.equal(stripJpegMetadata(truncated), null, '读不通就不收');
  const out = intakeFile(truncated, 'image/jpeg');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'unreadable_jpeg');
});

// ============================ THE PRIVACY CLAIM ============================

test('a second teacher cannot read the first teacher\'s upload — by any route', async (t) => {
  const s = await startServer(t, 8941);
  const a = await s.teacher('upload_a');
  const b = await s.teacher('upload_b');
  const courseA = (await s.call('/api/courses', { method: 'POST', body: { title: '醒狮' }, cookie: a.cookie })).json.course;
  const courseB = (await s.call('/api/courses', { method: 'POST', body: { title: '龙舟' }, cookie: b.cookie })).json.course;

  const secret = 'GPS-22.5431-114.0579';
  const up = await upload(s.call, a.cookie, courseA.id, jpegWithExif(secret), 'image/jpeg');
  assert.equal(up.status, 200, up.text);
  const mid = up.json.material.id;
  assert.ok(mid);
  assert.equal(up.json.material.cos_key, undefined, '对象键不回给浏览器——它是一张儿童照片的地址');

  // MUST PASS half first: the owner can read her own file back.
  const mine = await s.call(`/api/materials/${mid}/view`, { cookie: a.cookie, raw: true });
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get('content-disposition')?.startsWith('attachment'), true, '不许内联渲染');
  assert.equal(mine.headers.get('cache-control'), 'no-store', '共用的浏览器不许留下副本');
  assert.ok(mine.bytes.includes(Buffer.from('PIXELS')), '图像数据还在');

  // ROUTE 1 — the view endpoint, with the id in hand (stronger than guessing).
  const stolen = await s.call(`/api/materials/${mid}/view`, { cookie: b.cookie });
  assert.equal(stolen.status, 404, 'B 拿着 A 的 id 也读不到');
  assert.equal(stolen.json.ok, false);
  // And it is the SAME answer as a wholly invented id, so the endpoint is not
  // an oracle for which uploads exist.
  const invented = await s.call('/api/materials/00000000-0000-4000-8000-000000000000/view', { cookie: b.cookie });
  assert.equal(invented.status, 404);
  assert.deepEqual(invented.json, stolen.json, '「不是你的」和「不存在」必须是同一个回答');

  // ROUTE 2 — no session at all.
  const anon = await s.call(`/api/materials/${mid}/view`);
  assert.equal(anon.status, 401);

  // ROUTE 3 — the listing endpoint on A's course, with B's cookie.
  const listed = await s.call(`/api/courses/${courseA.id}/materials`, { cookie: b.cookie });
  assert.equal(listed.status, 404, 'A 的课程对 B 来说不存在');
  // And B's own listing does not contain A's file.
  const hers = await s.call(`/api/courses/${courseB.id}/materials`, { cookie: b.cookie });
  assert.equal(hers.status, 200);
  assert.deepEqual(hers.json.materials, []);

  // ROUTE 4 — the admin route, without an admin token.
  const noToken = await s.call(`/api/admin/courses/${courseA.id}/materials/${mid}/view`, { cookie: b.cookie });
  assert.equal(noToken.status, 401, '教师的 cookie 不是管理员口令');
  const listNoToken = await s.call(`/api/admin/courses/${courseA.id}/materials`, { cookie: b.cookie });
  assert.equal(listNoToken.status, 401);

  // ROUTE 5 — the static file handler, aimed at the objects directory. The
  // data dir here is a NON-dot directory inside demo/, so the dot-segment rule
  // does not fire and only the objects guard stands.
  const dirName = path.basename(s.dataDir);
  for (const guess of [
    `/${dirName}/objects/courses/${courseA.id}/anything.jpg`,
    `/${dirName}/objects`,
    `/${dirName}/objects/`,
  ]) {
    const r = await s.call(guess, { raw: true });
    assert.equal(r.status, 403, `静态处理器必须挡住 ${guess}`);
  }
  // The real key, read off disk, is the strongest form of this probe: even
  // knowing exactly where the bytes are, the URL does not serve them.
  const coursesDir = path.join(s.dataDir, 'objects', 'courses', courseA.id);
  const [objectName] = await readdir(coursesDir);
  assert.ok(objectName, '文件确实落在盘上了');
  const exact = await s.call(`/${dirName}/objects/courses/${courseA.id}/${objectName}`, { raw: true });
  assert.equal(exact.status, 403, '知道确切路径也没用');

  // ROUTE 6 — the export. Admins may read the rows; the object key is not one
  // of the things that rides a file onto somebody's laptop.
  const exported = await s.admin('/api/admin/export');
  assert.equal(exported.status, 200);
  assert.ok(!exported.text.includes('cos_key'), '导出里不带对象键');
  assert.ok(!exported.text.includes(objectName), '也不带对象名');
  const payload = JSON.parse(exported.text);
  assert.equal(payload.materials.length, 1, '但上传这件事本身要在导出里看得见');
  assert.equal(payload.materials[0].id, mid);

  // THE ADMIN DIRECTION, which is the other half of the requirement: an admin
  // CAN read it, and the read is written down.
  const before = (await s.accessRows()).length;
  const asAdmin = await s.admin(`/api/admin/courses/${courseA.id}/materials/${mid}/view`, { raw: true });
  assert.equal(asAdmin.status, 200);
  assert.ok(asAdmin.bytes.includes(Buffer.from('PIXELS')));
  const rows = await s.accessRows();
  assert.equal(rows.length, before + 1, '管理员每读一次文件，日志就多一行');
  const row = rows.at(-1);
  assert.equal(row.action, 'read_file');
  assert.equal(row.subject, mid);
  assert.equal(row.course_id, courseA.id);
});

test('EXIF comes off at ingest — the coordinates never reach storage', async (t) => {
  const s = await startServer(t, 8942);
  const a = await s.teacher('upload_exif');
  const course = (await s.call('/api/courses', { method: 'POST', body: { title: '醒狮' }, cookie: a.cookie })).json.course;

  const secret = 'GPS-22.5431-114.0579';
  const up = await upload(s.call, a.cookie, course.id, jpegWithExif(secret), 'image/jpeg');
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.material.exif_stripped, true);
  assert.equal(up.json.material.contains_children, true, '照片默认按「含儿童影像」处理——严的方向');
  assert.equal(up.json.material.kind, 'photo');

  // On disk, not merely in the response: the flag would be easy to set and
  // never act on.
  const dir = path.join(s.dataDir, 'objects', 'courses', course.id);
  const [name] = await readdir(dir);
  const onDisk = await readFile(path.join(dir, name));
  assert.ok(!onDisk.includes(Buffer.from(secret)), '幼儿园的坐标不许留在盘上');
  assert.ok(!onDisk.includes(Buffer.from('Exif')), 'APP1 整段都拿掉了');
  assert.ok(onDisk.includes(Buffer.from('PIXELS')), '照片本身没被破坏');

  // And what comes back out is the stripped file, not the original.
  const back = await s.call(`/api/materials/${up.json.material.id}/view`, { cookie: a.cookie, raw: true });
  assert.ok(!back.bytes.includes(Buffer.from(secret)));
});

// ============================== THE INGEST HALF ==============================

test('type is decided by content, not by what the upload claims', async (t) => {
  const s = await startServer(t, 8943);
  const a = await s.teacher('upload_sniff');
  const course = (await s.call('/api/courses', { method: 'POST', body: { title: '醒狮' }, cookie: a.cookie })).json.course;
  const post = (bytes, ct, q = '') => upload(s.call, a.cookie, course.id, bytes, ct, q);

  // MUST PASS: the three formats we accept.
  const pdf = await post(pdfBytes(), 'application/pdf');
  assert.equal(pdf.status, 200, pdf.text);
  assert.equal(pdf.json.material.mime_type, 'application/pdf');
  assert.equal(pdf.json.material.kind, 'document');
  assert.equal(pdf.json.material.contains_children, false, '文档不默认按含儿童影像处理');

  const docx = await post(docxBytes(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(docx.status, 200, docx.text);

  // MUST FAIL: an executable that says it is a photo.
  const exe = await post(exeBytes(), 'image/jpeg');
  assert.equal(exe.status, 415, '认不出来的东西一律不收');
  assert.equal(exe.json.reason, 'unidentified');

  // MUST FAIL: a real JPEG that claims to be a PDF. The mismatch itself is the
  // signal — the sender's idea of the file and its content disagree.
  const lying = await post(jpegWithExif(), 'application/pdf');
  assert.equal(lying.status, 415);
  assert.equal(lying.json.reason, 'type_mismatch');

  // MUST FAIL: a ZIP that is not a Word document. A bare container could hold
  // anything, including the things this allowlist exists to keep out.
  const zip = await post(bareZipBytes(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(zip.status, 415);

  // MUST FAIL: nothing at all.
  const empty = await post(Buffer.alloc(0), 'application/pdf');
  assert.equal(empty.status, 400);

  // Only the accepted ones landed.
  const listed = await s.call(`/api/courses/${course.id}/materials`, { cookie: a.cookie });
  assert.equal(listed.json.materials.length, 2);
});

test('the size cap holds, and it is enforced before the bytes are held', async (t) => {
  const s = await startServer(t, 8944);
  const a = await s.teacher('upload_cap');
  const course = (await s.call('/api/courses', { method: 'POST', body: { title: '醒狮' }, cookie: a.cookie })).json.course;

  // 10MB default; 12MB of PDF is over it. The declared content-length is
  // checked first, so this is refused without the body being kept.
  const big = Buffer.concat([pdfBytes(), Buffer.alloc(12 * 1024 * 1024, 0x20)]);
  const r = await upload(s.call, a.cookie, course.id, big, 'application/pdf');
  assert.equal(r.status, 413);
  assert.match(r.json.message, /太大/);
  assert.deepEqual((await s.call(`/api/courses/${course.id}/materials`, { cookie: a.cookie })).json.materials, []);
});

test('an upload cannot be filed against another teacher\'s course', async (t) => {
  const s = await startServer(t, 8945);
  const a = await s.teacher('upload_owner_a');
  const b = await s.teacher('upload_owner_b');
  const courseA = (await s.call('/api/courses', { method: 'POST', body: { title: '醒狮' }, cookie: a.cookie })).json.course;

  const r = await upload(s.call, b.cookie, courseA.id, pdfBytes(), 'application/pdf');
  assert.equal(r.status, 404, 'B 的课程列表里没有 A 的课程，所以连挂都挂不上去');
  // And no object was left behind by the refused write.
  const dir = path.join(s.dataDir, 'objects', 'courses', courseA.id);
  await assert.rejects(readdir(dir), '被拒的上传不许在盘上留下字节');
});

test('deleting a course deletes its objects', async (t) => {
  const s = await startServer(t, 8946);
  const a = await s.teacher('upload_delete');
  const course = (await s.call('/api/courses', { method: 'POST', body: { title: '醒狮' }, cookie: a.cookie })).json.course;
  await upload(s.call, a.cookie, course.id, jpegWithExif(), 'image/jpeg');

  const dir = path.join(s.dataDir, 'objects', 'courses', course.id);
  assert.equal((await readdir(dir)).length, 1);

  const gone = await s.call(`/api/courses/${course.id}`, { method: 'DELETE', cookie: a.cookie });
  assert.equal(gone.status, 200);
  // The row was the only record of the key, so a course deletion that leaves
  // the object behind leaves a photograph of children nothing can ever find.
  const left = await readdir(dir).catch(() => []);
  assert.deepEqual(left, [], '课程删掉，字节也要跟着删掉');
});
