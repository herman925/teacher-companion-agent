// store.mjs — persistence facade for the demo (DATABASE.md §4).
// Callers (serve.mjs) import { store } from here and never learn which
// implementation is underneath. JSON-file impl now; a pg-store.mjs will
// implement the SAME interface later (swap point is this one line).
//
// Interface:
//   listCourses(userId)                        -> [{ id, title, state_version, updated_at }]
//   createCourse(userId, title)                -> course brief   (enforces 30-course quota)
//   getCourse(userId, courseId)                -> { id, title, course_state, state_version, ... } | null
//   deleteCourse(userId, courseId)             -> boolean          (whole-course erasure)
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
//   adminDelete(courseId)                      -> boolean (delete any owner)
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

// DEMO_DATA_DIR override keeps server-level tests hermetic (scratch .data).
// Later: if (process.env.DATABASE_URL) store = createPgStore(process.env.DATABASE_URL);
export const store = createJsonStore(
  process.env.DEMO_DATA_DIR ? { baseDir: process.env.DEMO_DATA_DIR } : {},
);
