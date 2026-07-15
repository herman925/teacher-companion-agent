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
//   appendMessage(courseId, msg)               -> message row    (append-only)
//   getMessages(courseId, { before, limit })   -> message rows   (chronological)
//   saveState(courseId, delta, newState, ver)  -> { state_version } (optimistic lock + checkpoints)
//   adminListCourses()                         -> all courses (all users) + message/snapshot counts
//   adminGetCourse(courseId)                   -> full raw record | null
//   adminDelete(courseId)                      -> boolean (delete any owner)
//   adminExportAll()                           -> [full records] for one-file export
// Auth (SECURITY.md): createUser/getUser/listUsers/verifyLogin/changePassword/
//   resetPassword/setDisplayName/saveUserProfile/updateUser · createSession/
//   getSessionUser/listSessions/revokeSession/revokeByToken · audit/listAudit

import { createJsonStore } from './store/json-store.mjs';

// Later: if (process.env.DATABASE_URL) store = createPgStore(process.env.DATABASE_URL);
export const store = createJsonStore();
