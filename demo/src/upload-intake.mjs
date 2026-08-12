// upload-intake.mjs — what a file IS, and what has to come off it before we
// keep it (ADR-0013 §6). Pure: bytes in, verdict out, no I/O and no clock, so
// both directions of every rule are testable without a server.
//
// TYPE IS DECIDED BY CONTENT, NEVER BY NAME. A filename is teacher-supplied
// text; so is the declared `content-type`. Both are hints. `photo.jpg` holding
// a Windows executable is the oldest upload bug there is, and on a service that
// later serves those bytes back to a browser it is also the most expensive.
// So: sniff the magic bytes, and refuse anything the sniffer cannot name.
// Reject by default, never blocklist — the same discipline as the store's
// MATERIAL_MIME_TYPES allowlist.
//
// WHAT WE ACCEPT, AND WHY IT IS THREE THINGS: PDF (下发的活动方案), DOCX (她的教案),
// JPEG (现场照片). PNG sits in the store's MIME allowlist and is deliberately NOT
// accepted here yet: PNG carries its own metadata chunks (`eXIf`, `tEXt`), and
// an accepted format whose metadata we do not strip would quietly reopen the
// hole this module exists to close. Adding it means writing the chunk stripper
// first, not widening the list.

/** JPEG APP segments we remove. APP1 is EXIF (and XMP) — where the camera
 * writes GPS. APP13 is the Photoshop/IPTC block, which carries location and
 * author fields of its own. Everything else (JFIF density, ICC colour) is
 * needed to render the picture correctly and says nothing about where it was
 * taken. */
const JPEG_DROP_MARKERS = new Set([0xe1, 0xed]);

/** MIME → the extension the object key gets. OURS, not the upload's. */
export const MIME_EXT = Object.freeze({
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
});

/** Everything this endpoint accepts. A subset of the store's allowlist, and
 * intentionally so — the store records what may be REFERENCED, this decides
 * what may be RECEIVED. */
export const ACCEPTED_MIME_TYPES = Object.freeze(Object.keys(MIME_EXT));

/** Teacher-facing name of a format, for refusal messages that mean something. */
export const MIME_LABEL = Object.freeze({
  'application/pdf': 'PDF',
  'image/jpeg': 'JPEG 照片',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word 文档',
});

const startsWith = (buf, bytes) => bytes.every((b, i) => buf[i] === b);

/**
 * What are these bytes, really?
 *
 * @param {Buffer} buf the whole uploaded body (we have it; it is capped)
 * @returns {string|null} an accepted MIME type, or null when unidentifiable
 */
export function sniffMime(buf) {
  if (!buf || buf.length < 8) return null;
  // %PDF-
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  // SOI + first marker
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // DOCX is a ZIP, and a bare ZIP is not a document — it is a container that
  // could hold anything, including the things this allowlist exists to keep
  // out. So the ZIP magic alone is not enough: the archive must actually name
  // the Word main part. Entry names are stored UNCOMPRESSED in both the local
  // headers and the central directory, so a plain byte scan is reliable and
  // needs no unzip.
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    const asBytes = buf.includes(Buffer.from('word/document.xml'))
      && buf.includes(Buffer.from('[Content_Types].xml'));
    return asBytes ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : null;
  }
  return null;
}

/**
 * Remove the metadata segments from a JPEG.
 *
 * THE THING BEING DESIGNED AGAINST is one file that contains both a photograph
 * of children and the kindergarten's exact coordinates. EXIF is where a phone
 * writes those, along with the device id and the timestamp, and none of it is
 * needed to look at the picture.
 *
 * A JPEG whose segment structure does not parse is REFUSED rather than passed
 * through: 「we could not read this well enough to strip it」 is not a reason to
 * keep it whole, it is a reason not to keep it.
 *
 * @param {Buffer} buf
 * @returns {{buffer: Buffer, stripped: boolean}|null} null when malformed
 */
export function stripJpegMetadata(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const out = [buf.subarray(0, 2)];
  let stripped = false;
  let pos = 2;

  while (pos < buf.length - 1) {
    if (buf[pos] !== 0xff) return null;         // lost the marker stream
    let m = pos + 1;
    while (m < buf.length && buf[m] === 0xff) m += 1; // fill bytes are legal
    if (m >= buf.length) return null;
    const marker = buf[m];

    // Standalone markers carry no length word.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(buf.subarray(pos, m + 1));
      pos = m + 1;
      continue;
    }
    // Start of scan / end of image: the rest is entropy-coded data (which can
    // legally contain anything) and is copied verbatim.
    if (marker === 0xda || marker === 0xd9) {
      out.push(buf.subarray(pos));
      pos = buf.length;
      break;
    }
    if (m + 2 >= buf.length) return null;
    const len = buf.readUInt16BE(m + 1);
    if (len < 2) return null;
    const end = m + 1 + len;
    if (end > buf.length) return null;

    if (JPEG_DROP_MARKERS.has(marker)) stripped = true;
    else out.push(buf.subarray(pos, end));
    pos = end;
  }

  return { buffer: Buffer.concat(out), stripped };
}

/**
 * The whole ingest decision for one upload: identify, then strip.
 *
 * @param {Buffer} buf uploaded bytes, already capped by the caller
 * @param {string} [declared] the request's own content-type — checked, not trusted
 * @returns {{ok: true, mime: string, ext: string, bytes: Buffer, exif_stripped: boolean}
 *          |{ok: false, reason: string, message: string}}
 */
export function intakeFile(buf, declared = '') {
  const mime = sniffMime(buf);
  if (!mime) {
    return {
      ok: false,
      reason: 'unidentified',
      message: '这个文件认不出来是什么格式——目前只收 PDF、Word 文档和 JPEG 照片',
    };
  }
  // The declared type is compared, not believed. A mismatch is not a
  // formatting nuisance: it is the one signal that says the sender's idea of
  // this file and its actual content disagree.
  const said = String(declared ?? '').split(';')[0].trim().toLowerCase();
  if (said && said !== mime && !(mime === 'image/jpeg' && said === 'image/jpg')) {
    return {
      ok: false,
      reason: 'type_mismatch',
      message: `文件说自己是 ${said}，实际是 ${MIME_LABEL[mime]}——为安全起见没有收下`,
    };
  }
  if (mime !== 'image/jpeg') {
    return { ok: true, mime, ext: MIME_EXT[mime], bytes: buf, exif_stripped: false };
  }
  const cleaned = stripJpegMetadata(buf);
  if (!cleaned) {
    return {
      ok: false,
      reason: 'unreadable_jpeg',
      message: '这张照片的结构读不通，没法去掉里面的位置信息，所以没有收下',
    };
  }
  // `exif_stripped: true` means the pass RAN, not that something was found. A
  // photo that never had EXIF is as stripped as one that did, and the flag on
  // the row has to answer 「did this file go through the stripper」.
  return { ok: true, mime, ext: MIME_EXT[mime], bytes: cleaned.buffer, exif_stripped: true };
}
