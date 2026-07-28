# ADR-0007: Tiered context, TSV skeleton, and change propagation

Date: 2026-07-29 · Status: accepted

## Context

Today every turn ships the whole world. `buildPromptParts` sends base + contract + stage module as a cache-stable prefix, then `stateNoteText` appends `JSON.stringify(state, null, 1)` — the entire `course_state` including the full blueprint tree, pretty-printed with a newline per key — as a trailing system note, plus a 24–36 message history window (`cacheStableHistory`). That was the right shape when the conversation *was* the product and any turn could be about anything.

[ADR-0006](0006-workbench-first-plan-tree.md) removed that premise. A node-scoped turn has a known subject, so it does not need the whole tree, and it does not need a conversation history that is mostly about other nodes.

The 2026-07-28 meeting proposed layered JSON context: 月计划 as the upper context, 周/日 inheriting only summaries, no conversation dump. 冯浩然 owns a real-data token and API-cost measurement before the shape is frozen. 陈栩锋 raised the objection that makes the whole design non-trivial: *a teacher who edits week 2 has just invalidated week 3, and layered context is exactly the architecture that will not notice*. The meeting's answer — 「用户跳回去修改时会自己说明理由」 — holds for one edit inside one session and fails two weeks later.

## Decision

### 1. Context is tiered by subject, and the tier is engine-computed

Prompt assembly takes the turn subject from ADR-0006 and builds context from four bands:

| Band | Always present | Contents |
|---|---|---|
| Rules | yes | base + contract + stage module + 教师档案 (unchanged cache-stable prefix) |
| Skeleton | yes | every `course_plan` node as one row: id, parent, kind, title, `work_status`, provenance status, stale flag, unconfirmed count. Titles only — no bodies. |
| Focus | node turns | the subject node's full body, its ancestors' summaries, its immediate siblings' titles, its `blueprint_refs` targets' bodies, its own revision history |
| Recent | yes | conversation window, shortened for node turns to the exchanges belonging to that node |

The model never selects its own band. A node turn that needs something outside its bands asks for it in the reply; it does not get a silent full-state fallback, because a silent fallback would make the token measurement meaningless.

### 2. The skeleton serializes as TSV; everything the model writes stays JSON

The skeleton is homogeneous rows over a stable column set, so a header-once table drops the per-node braces, quotes and repeated keys that dominate the current pretty-printed JSON. Node ids already encode hierarchy (`m2.1.3`), so a flat table reconstructs the tree — no nesting, no indentation.

**Direction asymmetry, and it is a safety property, not a preference.** TSV **inbound** (rendered for the model), JSON **outbound** (`state_delta`, `blueprint_delta`, the new `plan_delta`). A misaligned TSV column is a silent corruption with no parse error: one shifted field could move a value into the status column and read `hypothesis` as `confirmed` — the exact escalation non-negotiable #1 exists to prevent. Malformed JSON fails loudly and the existing engine validators catch it. The model keeps writing JSON.

### 3. One converter, two consumers

`demo/src/plan-tsv.mjs` — pure, no I/O:

- `toSkeletonTSV(tree)` → the prompt's skeleton band
- `parseSkeletonTSV(text)` → tree, for round-trip tests
- the same normalized rows feed the 工作台 tree render

Same discipline as ADR-0003 §5: the model emits structure, the client draws it. Escaping is the converter's job — tab, newline and carriage return in any field are stripped at serialization (titles are display strings; a title containing a tab is a bug, not content). Round-trip equality is a test, not an assumption.

### 4. Bodies are addressed, not inlined

Node bodies live outside the skeleton and enter context only in the Focus band. This is the larger half of the saving: the format change removes structural characters, but the tiering removes whole paragraphs of Chinese prose that tokenize identically in any format. Stated plainly so nobody attributes the win to TSV alone.

### 5. Change propagation: mark, do not recompute

When a node changes, the engine computes the blast radius and **marks** it. It never regenerates descendants and never edits a parent.

- **Downstream.** Descendants and any node whose `blueprint_refs` point into the changed subtree are stamped `stale_since: <plan_version>` and surface a 待复查 badge in the tree. On the next turn that opens a stale node, the agent leads with what changed upstream and offers a 连动调整; the teacher decides. Confirmation clears the flag.
- **Upstream.** If an edit contradicts an ancestor's stated goal, the ancestor is stamped `needs_review` (a `work_status`, never a provenance change) so a month plan cannot keep claiming an outcome its weeks no longer produce.
- **Reason travels with the node.** Every edit appends `{version, at, by, reason, subject_node}` to the node's own revision history. This is what makes tiered context survivable: a node reopened two weeks later still carries why it looks the way it does, instead of pointing at a chat turn that has fallen out of the window.
- **`confirmed` never auto-escalates and never auto-clears.** Staleness marks that a node *may* need revisiting; it does not demote provenance. Only teacher confirmation or recorded evidence moves provenance, unchanged from ADR-0003.

Rejected alternatives: **recompute descendants** (silently overwrites teacher-confirmed downstream work — a direct violation of the confirmation channel); **do nothing** (the meeting's implicit position; it holds for a single in-session edit and fails at week 3, discovered mid-classroom).

### 6. Measure before freezing

Three numbers on real course data, against today's full-state baseline: prompt tokens per turn (course turn and node turn separately), cache-hit rate, and API cost per completed course. Compact JSON with no indent is measured as a third arm — if compact JSON plus tiering gets most of the win, TSV is not worth its escaping rules. 冯浩然 owns the run; this ADR's format decision is provisional until those numbers exist and is revisited, not defended, if they disagree.

## Consequences

- Cache behavior changes shape. The stable prefix survives (rules band is unchanged), but the skeleton sits between rules and the newest message and moves whenever any node changes. Placing the skeleton *after* the history window keeps the history cache-hot at the cost of distance from the question; the measurement in §6 decides the placement.
- Node-scoped windows mean the model can no longer see a remark the teacher made three nodes ago. That is the intended trade, and the reason §5 forces edit reasons onto the node.
- `stale_since`, `work_status`, `plan_version` and the revision history are new state: debug drawer, client export and admin export all carry them (AGENTS.md).
- A stale badge that never clears is worse than no badge. Clearing paths — teacher confirms, teacher accepts a 连动调整, teacher dismisses — must all exist before the badge ships.
- Voice input, if it lands, multiplies transcript length several-fold and pressures the Recent band first. Tiering makes that survivable; it does not make it free.

## Open questions

- Does the skeleton include *every* node once a course runs long (a semester of daily activities is hundreds of rows), or does it collapse settled subtrees to a single summary row?
- Sibling titles in the Focus band: all siblings, or a window? A 周计划 with 20 activities makes "all" expensive.
- Does a node turn's Recent band include the course-level chat that created the node, or only the node's own dialogue?
