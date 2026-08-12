// store.mjs — persistence facade for the demo (DATABASE.md §4).
// Callers (serve.mjs) import { store } from here and never learn which
// implementation is underneath. JSON-file impl now; a pg-store.mjs will
// implement the SAME interface later (swap point is this one line).
//
// Interface:
//   listCourses(userId)                        -> [{ id, title, state_version, updated_at }]
//   createCourse(userId, title)                -> course brief   (enforces 30-course quota)
//   getCourse(userId, courseId)                -> { id, title, course_state, state_version, ... } | null
//   deleteCourse(userId, courseId, { deleteObject })
//                                              -> { deleted, cos_keys, objects_deleted }
// DELETING A COURSE DELETES ITS OBJECTS (ADR-0013 §6). The materials row is the
// only record of an object key, so both tiers harvest the keys, delete the
// objects, and only then remove the rows. `deleteObject` is injected because
// neither tier owns a COS client; without one, `cos_keys` comes back and
// deleting them is the caller's obligation — stated rather than assumed. It
// returns a receipt rather than a boolean for exactly that reason: a caller
// that got `true` learned nothing about what it still owns in the bucket.
//   appendMessage(courseId, msg)               -> message row    (append-only;
//                                                 msg.subject tags it, default 'course')
//   getMessages(courseId, { before, limit, subject })
//                                              -> message rows   (chronological)
// Subjects (ADR-0010 §1/§2): ONE ordered message log per course, every row
// tagged 'course' or a node id. `subject` filters that one log — it never
// partitions storage, because global ordering is what proves what was asked
// when. The tag is engine-owned: it comes from the request, never the model.
//   saveState(courseId, delta, newState, ver)  -> { state_version } (optimistic lock + checkpoints)
// MEMORY (ADR-0011 · ADR-0013 §9). Facts are the teacher's persistent
// constraints — 「班上没有鼓」 — and they ride EVERY prompt, which is why the read
// is one call and the taxonomy is closed:
//   listFacts(userId, {courseId, classId, includeArchived})
//                                              -> facts in memory-scopes shape
// THIS ONE THROWS AND MUST NEVER RETURN [] ON FAILURE. `memoryBandText` omits
// the band for null and renders both headers for [], and that difference is
// security-relevant: a read error coerced into an empty list tells the model
// this class has no constraints, and it offers 敲鼓感受节奏 to the class with no
// drums. The caller passes null on failure and [] only on a genuine empty.
//   recordFact(userId, {courseId, classId, kind, text, quote, scope, source,
//                       archivedAt, archiveReason, supersededBy})   -> fact
// The store PERSISTS; it never curates. Screening, merging, superseding and
// capping are memory-scopes.mjs's, and PROVENANCE IS ENGINE-SET: `source` is
// mapped through one function that sends anything unrecognised to the
// least-trusted value, so persisting a fact cannot launder a teacher source in.
//   archiveFact(userId, factId, {reason, supersededBy})  -> fact | null
// The ONLY way a fact leaves the prompt. There is deliberately NO deleteFact:
// app_rw holds no DELETE on facts, so one would pass every JSON test and fail
// with 42501 in production.
//   widenFact(userId, factId, toScope, {classId})        -> fact | null
//   touchFactsUsed(userId, factIds)                      -> number stamped
// CLASSES (ADR-0011 §3) — an identity (中三班) that OUTLIVES a course, created
// by her naming one in conversation, never through a management screen:
//   listClasses(userId) · createClass(userId, {name, ageBand, classSize, isDefault})
//   updateClass(userId, classId, {name, ageBand, classSize})
//   setDefaultClass(userId, classId)     — the single owner of at-most-one-default
//   setCourseClass(userId, courseId, classId|null) -> {id, class_id}
// No deleteClass in v1: facts.class_id is ON DELETE CASCADE, so deleting a class
// would silently destroy every class fact she deliberately widened.
// INTERACTION SIGNALS (ADR-0009 §3) — append-only audit trail behind the axis
// vector, which itself is a singleton in users.settings and needs no method:
//   recordSignal(userId, {axis, signal, delta, courseId, messageId})
//   listSignals(userId, {limit, axis})   -> newest first
// UPLOADS:
//   recordMaterial / listMaterials / getMaterial(userId, materialId)
//   listMaterialIds(userId, courseId)    -> ids only, for the SYNCHRONOUS
//                                           resolveUploadRef the engine needs
//   adminListCourses()                         -> all courses (all users) + message/snapshot counts
//   adminListFacts({userId, courseId, limit})  -> facts across teachers, archived
//                                                 included (ADR-0013 §7: log the read)
//   adminListClasses({userId, limit})          -> classes across teachers, WITH
//                                                 user_id. Without it the export's
//                                                 facts.class_id / courses.class_id
//                                                 resolve to nothing.
//   adminListSignals({userId, limit})          -> axis observations across teachers
//                                                 (ADR-0009 §3's 「为什么这个把手动了」)
//   adminGetCourse(courseId)                   -> full raw record | null
//   adminDelete(courseId, { deleteObject })    -> same receipt (delete any owner)
//   adminExportAll()                           -> [full records] for one-file export
// Auth (SECURITY.md): createUser/getUser/listUsers/verifyLogin/changePassword/
//   resetPassword/setDisplayName/saveUserProfile/updateUser · createSession/
//   getSessionUser/listSessions/revokeSession/revokeByToken · audit/listAudit
// Scope shell (ADR-0012 §3): logScope(row) · listScope({limit}) -> {rows,total,byRule}
//   logScope stores { rule, enforced, refused, excerpt, userId }. THE EXCERPT IS
//   CAPPED AT 60 CHARACTERS, and that cap is part of THIS interface, not of one
//   implementation: this is an ops log, and a whole teacher message at rest in
//   it is teacher content in the wrong place. Callers truncate too, so a future
//   pg-store cannot inherit the guarantee by accident and lose it by accident.

import { createJsonStore } from './store/json-store.mjs';

// ---------------------------------------------------------------------------
// THE SWAP POINT. `DATABASE_URL` decides the tier and nothing else does:
// present → PostgreSQL (DATABASE.md §2 tables, row-level security per
// ADR-0013 §5); absent → JSON files on disk. No flag, no fallback chain, no
// half-configured third state — a tier that can be selected two ways is a tier
// somebody will select by accident.
//
// pg-store is loaded DYNAMICALLY, and that is not a style choice: `pg` is this
// repository's first and only dependency (ADR-0013), server tier only. A static
// import would make every test, every check and the static demo tier fail on a
// machine that has not installed it. Imported here, it is loaded exactly when a
// database has been configured.
//
// DATABASE_URL points at app_rw — never `postgres`, never `app_owner`, both of
// which restore the exact failure 002/003 exist to prevent while nothing
// complains (demo/migrations/README.md). DATABASE_URL_ADMIN is the separate
// app_admin connection the auth plane and the admin console use; see
// pg-store.mjs for which calls take which, and why.
// ---------------------------------------------------------------------------
let selected;
if (process.env.DATABASE_URL) {
  const { createPgStore } = await import('./store/pg-store.mjs');
  selected = createPgStore({
    connectionString: process.env.DATABASE_URL,
    adminConnectionString: process.env.DATABASE_URL_ADMIN,
  });
} else {
  // DEMO_DATA_DIR override keeps server-level tests hermetic (scratch .data).
  selected = createJsonStore(
    process.env.DEMO_DATA_DIR ? { baseDir: process.env.DEMO_DATA_DIR } : {},
  );
}

export const store = selected;
