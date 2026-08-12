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
//   adminListCourses()                         -> all courses (all users) + message/snapshot counts
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
