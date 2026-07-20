# Design: blueprint chat chip · per-node 批注 · auto course-title regen

Date: 2026-07-20 · Status: approved by Herman (chat) · Scope: demo UI + prompts + serve

## 1. Blueprint stays out of chat (pointer chip)

Problem: `blueprint` artifacts render the full tree in the chat column, duplicating the right-hand workspace panel (DESIGN.md §5b) and burying conversation.

Change:

- New `renderBlueprintChip({ version, pending })` in `demo/src/ui/render.js`: one compact card-row — `预设蓝图 vX 已更新 · N 项待确认 · 去面板确认 →`.
- `demo/src/ui/main.js` artifact loop: `type === 'blueprint'` (and turns carrying `blueprint_delta`) render the chip instead of `renderArtifactCard`. Pending count computed from the post-turn `course_plan_blueprint` (nodes with `status !== 'confirmed'`).
- Chip click: `bpHidden = false; refreshBlueprintPanel()`; below 1100px additionally opens the sheet (same behavior as `#btn-blueprint`).
- History re-render uses the same chip (stored turns keep their `artifacts`; chip is derived at render time, so old sessions get chips too).
- Prompt: contract blueprint 规范 gains a bullet — reply_markdown must not restate blueprint content; one sentence points the teacher to the 预设蓝图 panel (mobile: the blueprint button opens a drawer) to review, confirm, and 批注.
- `renderBlueprintCard` stays exported (shared outline helpers feed the panel) but is no longer called for new turns.

## 2. Per-node 批注 (comment → AI refinement channel)

Problem: teachers can only ✓确认; there is no way to push back on a single node, so refinement feedback has no channel.

Change:

- `render.js`: a 批注 button beside every ✓确认 (confirmed nodes too — you may want to comment on a confirmed node). Opens an inline textarea under the node row; saving stores `{ id, number, title, text }` and shows a dot badge on the row.
- State lives in `main.js`: `bpComments` map persisted per course (`localStorage` key `cst.bpComments.<courseId>`); survives reloads; cleared on send.
- Panel footer bar (visible when count > 0): `未发送批注 N 条 · 一起发送`. Sending packages ALL comments into ONE teacher message via the existing `send()`:

  ```
  【蓝图批注】
  1. 「1.2 文化转译」(id: cultural_translation)：例子太广州，我们是沙田……
  ```

- Pure helper `packBlueprintComments(comments)` in `demo/src/blueprint-util.mjs` + node tests (format, id inclusion, empty → null).
- Contract addition: on a 【蓝图批注】 message the model answers with `blueprint_delta` ops targeting the annotated ids and explains 保留/调整 per node; it must not re-emit the whole blueprint.
- Mock: scripted response for `/^【蓝图批注】/` returning a plausible `blueprint_delta`, so 演示模式 and tests exercise the loop.

## 3. Auto course-title regen (interval harness)

Problem: the course is titled once (theme heuristic at first turn); long sessions drift and the title goes stale. Herman wants Hermes-Agent-style periodic renaming.

Change:

- Setting in 用户中心 (profile pane, synced like the rest of profile/settings): checkbox 自动更新课程名 (default **off**) + interval select 10/20/30/40/50 (default 10). Interval unit: one teacher prompt (system/loop/packaged resend turns do not count beyond the one send that carries them).
- Trigger harness — dedicated side-channel, never the turn contract. New `demo/src/title-agent.mjs` (pure, tested):
  - `shouldRegenTitle({ teacherTurns, every, enabled, titleLocked })` — deterministic trigger (`teacherTurns > 0 && teacherTurns % every === 0`).
  - `buildTitleMessages(history, state)` — tiny standalone prompt: last ≤6 messages (truncated) + theme fields; instruction "只输出 ≤12 字课程名，不要标点/引号/解释".
  - `sanitizeTitle(raw)` — strip quotes/markdown/trailing punctuation, hard cap `TITLE_MAX`, reject empty/JSON-looking output → null (fallback: keep current title).
- Server (`serve.mjs` `runCourseTurn`): after persisting a turn, count teacher messages; when the harness fires, call the provider chain with the tiny prompt (same keys, `temperature 0.3`), sanitize, then `store.renameCourse(uid, id, t, { auto: true })` + emit the existing `course` SSE event (client rail already refreshes on it). `title_locked` (human rename) always wins — harness skips locked courses. Failures are swallowed: naming is cosmetic, never fails a turn.
- 演示模式 (no server persistence): client-side counter per course; regen uses the `deriveCourseTitle` heuristic (no model call) so behavior is visible without keys.

## Testing

- Node tests: `packBlueprintComments`, `shouldRegenTitle`, `sanitizeTitle`, mock 批注 turn, chip pending-count helper.
- Browser verification (AGENTS.md): chip render + click on desktop and 375px sheet, 批注 add/edit/send flow, both themes.

## Out of scope

- Comment threads/replies per node (one live comment per node; editing overwrites).
- Server-side storage of unsent comments (localStorage only until sent).
- Title regen model choice UI (uses the session's provider chain).
