# ADR-0010: The conversation model — one tagged log, node subjects, and a view-only workbench

Date: 2026-07-29 · Status: accepted · Amends [ADR-0006](0006-workbench-first-plan-tree.md)

## Context

[ADR-0006](0006-workbench-first-plan-tree.md) made the 工作台 the deliverable and the per-node dialogue the v1 core capability, but it left the word 「独立对话框」 from the 2026-07-28 meeting unexamined. That word carries an assumption — that a node conversation is a *separate thing* — and the assumption is expensive.

A course has roughly 25 nodes (one 月计划, 4 weeks, ~20 activities). A teacher will ever talk in three or four of them. If a node conversation is a separate object, the design produces about twenty empty rooms per course that must be listed, named, navigated and tidied. Worse, separate rooms are separately amnesiac: each one starts blind to the others, so knowledge has to be deliberately transported between them, and a failure of that transport produces 「我早就跟你说过」 — the single interaction most likely to end a teacher's relationship with the product.

Today the demo has one linear chat per course (`courses/<id>.json` holds state and history together) and the blueprint panel is a decoration on it: per-node 批注 are packed into one message and sent into that same chat.

## Decision

### 1. One message log per course; the subject is a tag, not a container

Storage stays one file per course. Every message carries a **subject**: `course` or a node id. Opening a node renders its subject-tagged messages, which reads as a private conversation about that node. There is no thread object, so a node nobody has discussed has nothing — not an empty session, not a row in a list.

Consequences worth naming, because they were the deciding arguments:

- **One file remains the whole truth of a course.** Debug drawer, client session-log export and admin export each read one object; the observability duty (AGENTS.md) stays trivially satisfiable rather than becoming an audit across N thread objects.
- **Global ordering is preserved.** We can always tell that the teacher asked about 3.2.1 *before* she edited 周2. Separate threads each carry their own clock, and for a product whose central discipline is provenance — what was known, and when — ordering guaranteed by the data structure beats ordering inferred from timestamps.
- **Later consolidation is a filter, not a join.** Cross-course analysis for the regional 教研 warehouse becomes one pass over a tagged array.
- **No migration.** Today's history is already a flat array; the subject tag is additive and existing messages default to `course`.

### 1a. Divergence from the meeting, stated plainly

The 2026-07-28 transcript does **not** contain this decision, and the team may believe something else was agreed. Recording the difference rather than letting it surface during implementation.

**What 林朝湃 proposed**, and what 陈栩锋 agreed to: clicking a node opens a **fresh, zero-context dialogue** each time. Creation is one version, later modification is another, and 「它们两个不互通」 — the two do not share. Each opens blank and is seeded only with the current card content plus the ancestor plans (for 3.2.1 that is 3.2, 3.1 and the 月计划 — 林朝湃's 「必要的最小成本」). Prior conversation about that node is explicitly not carried: 「对，历史对话就没有了」.

**What Herman argued in the same exchange**: keep one conversation, and let clicking a node insert a reference into the composer — 「例如说我点的，它就会直接在这边显示…3.2.2，然后叉」 — so the node becomes an attachment on the current turn rather than a new room. 「都是保留在同一个对话框里面，是这样就比较像 ChatGPT；如果是朝湃你那种，他有点像 subsession 或者是 subagent 的感觉。」 He also named the cost of the other model out loud: a blueprint with 18 nodes means the agent 「已经会帮我开了…18个对话框，都是空白的」. He then conceded — 「虽然我不懂为什么，但来坐这坐吧」 — without being persuaded.

**Resolved 2026-07-29 — Herman's call, build proceeds on it.** One log, subject-tagged. The two positions turned out to address different layers, which is why this is not a compromise: 林朝湃's 「历史对话就没有了」 is a policy about **what reaches the model**, and this ADR decides **what is retained**. The tiered context bands (§ADR-0007) already send a node turn nothing but its ancestor plans and that node's recorded revision reasons — exactly his minimum set. So he gets the context behavior he asked for, and we keep global ordering, one file per course, and no empty dialogues.

To be walked through with 林朝湃 and 陈栩锋 so nobody is surprised in implementation; the storage decision does not wait on their reply, because the context policy it ships with already matches theirs.

Two sub-decisions follow from it:

- **A node's earlier conversation is retained but not re-sent.** The messages stay tagged, in storage and in the export, so the record and its ordering survive for audit. What seeds the model on a revision is the ancestor plans plus that node's recorded revision reasons — nothing of the long creation conversation. 林朝湃's reason for dropping it was sound and is honoured; only the deletion is declined, because deleting is not required to get the effect.
- **The node reference and the mode switch are not exclusive**, and both ship. The 「3.2.2 ✕」 chip is how a node enters an ongoing conversation; the panel switching into node mode is how a node is opened deliberately, and is where the node's detail lives.

### 2. The subject is engine-owned

The subject comes from the UI selection, never from the model. A node turn's context is built from it ([ADR-0007](0007-tiered-context-and-change-propagation.md)); a model that could choose its own subject could also choose its own blast radius.

### 3. Right panel looks and navigates; left panel talks

The single governing rule, and it replaces DESIGN.md §5b's 「工作台 = what needs you」 framing:

> **The 工作台 is for looking and navigating. All input happens on the left.**

Tapping a node swaps the left panel into node mode — node content, stored rationale, then its conversation — while the tree stays visible on the right with the open node highlighted, so the teacher reads the plan while discussing it. Tapping a node transmits nothing, so DESIGN.md §5c's 「the composer is the only mouth」 survives intact.

Two things follow:

- **批注 as a separate mechanism is absorbed.** A 批注 on node 3.2.1 *is* the first message of 3.2.1's conversation — same tag, same log, no translation layer. Known cost, accepted: on a phone, commenting on four activities is four open-type-back trips, where the old batch-annotate flow was one. Revisit if pilots show teachers stop commenting on mobile.
- **The 问题卡 tab leaves the workbench.** Question cards render inline in the conversation where they were asked. The problem that tab solved — questions lost up-scroll — is solved instead by a slim pending strip above the composer showing the unanswered count and jumping back to them. This returns cards to where 动态识别 always said they belonged; a tab full of question cards was a form we had not named as one.

### 4. A node view is never empty

Opening a node shows the node's own substance before any conversation exists: title, body, provenance status, `work_status`, the stored `rationale` (heard quotes / assumptions / pedagogical basis / profile basis), staleness with its upstream reason, and links to related nodes. All rendered from stored data — no model call, no tokens, nothing invented, and it answers 「为什么有这个活动」 instantly, which is a large part of what the meeting asked the 教研员 role to do.

Above the composer sits a **static, randomised greeting** — roughly ten fixed Chinese variants, e.g. 「你打开了『龙舟鼓点节奏游戏』，想跟我确认什么？」. It is screen furniture: never written to the message log, never sent to the model, never exported as something the agent said. A lightweight `node_opened` event is logged so browsing is visible in the drawer. Being static, it is warm without presuming whether she came to 问 or to 改 — a presumption a generated opener could not avoid.

### 5. Blast radius: the open node freely, others by one tap

A conversation may change the node it is scoped to as the teacher talks; the tree updates live and the node is marked unconfirmed. Changes the agent wants to make **elsewhere** surface as an offer inside the conversation, naming the node and the change, applied by one tap.

Nothing outside her view moves without a deliberate act. Silent edits to nodes she is not looking at are invisible by construction — she would meet them later with no memory of authorising them, which is the precise opposite of the 确定性 the product sells.

### 6. Confirmation moves from a click to a quoted engine event

DESIGN.md §5b's ✓确认 — a tick on the panel, applied immediately as an engine event — is **removed**. The meeting's position is that interaction should be conversational; a review pass of a dozen ticks is work teachers will not do. 陈栩锋 recounted the experiment kindergarten's 圆桌会议, where the 园长 had approved the direction and then asked for teacher comment: 「最好分析批注都不要让我们写，你们要有个 AI 帮我来分析吧，因为我们的工作量太大了」 — the session turned from a 技术研讨会 into a 吐槽大会. Teachers are not refusing to think; they are refusing to be given more forms.

Removing the tick removes the one unfakeable escalation channel, so the guarantee is rebuilt on the model side:

- The model may escalate a node to `confirmed` only by **citing the teacher's own words from that same turn**, carried on the confirming operation. This mirrors `evidence_refs` for child evidence.
- **No quote, no escalation**: the harness strips the operation and logs a violation. A model that reads 「好的，我先看看」 as approval fails the citation test rather than silently writing a false record.
- Confirmation remains an engine event: the engine applies it, the model learns of it from the state snapshot next turn.

### 7. Every state-changing turn issues a receipt

Memory captured, nodes confirmed, nodes edited — all surface the same way:

- a **toast** at the moment, carrying undo, so a wrong capture or a wrong confirmation dies in one tap while she is still looking;
- plus **one compact line** under that turn's reply — 「记住了 1 条 · 已确认 2 处 · 周2 已改」 — tappable for detail, still undoable, and re-rendered on scroll-back.

The toast alone would lose the record; an inline banner alone would let a dozen confirmations bury the conversation. The line is an event, not a message: never sent to the model, never a turn.

### 8. Navigation is the tree; there is no list of conversations

Nodes with conversation carry a message-count badge; stale nodes carry 待复查. Above the tree, a short time-ordered strip of recently touched nodes answers 「where was I」, which a hierarchy answers badly. No second hierarchy is built, and no surface presents node conversations as rooms the teacher owns — the words on screen decide whether the object exists in her mind, whatever the storage does.

### 9. Amendments to ADR-0006's tree

- **A day is a date written on an activity, not a level.** The tree is 月 → 周 → 活动, each activity carrying its date(s). This resolves ADR-0006's open question. 「今天要做什么」 becomes a filter rather than a place — and therefore also the cheapest useful screen we could add later. Rescheduling is one field, not a re-parent, so it does not read as a structural edit to the staleness rules. Roughly halves the node count and removes ~20 empty day containers per course from both the screen and the skeleton we send every turn.
- **The root is a phase, labelled 月计划** — one continuous chunk of teaching, roughly 2–5 weeks, ignoring calendar boundaries; a longer course grows a second root. This matches `stage1-workflow-v1.0`, where stage 1 runs 2—3 weeks and does not align to months. Open risk recorded below: if 月计划 is paperwork submitted on a monthly cycle, this reopens.
- **One tree on screen — and the 主题网络图 *is* that tree.** 林朝湃's point, which the transcript records and the earlier minutes missed entirely: the theme network and the 月周日计划 are the same object seen twice. 龙舟 is simultaneously the theme's starting node and the 月计划; 周1 船体 and 周2 协作 are simultaneously weekly plans and the theme's sub-nodes. 「他们是同一个东西来。」 So there is no separate network-map artifact to generate, reconcile or keep in sync — drawing the plan tree *is* drawing the theme network. This is stronger than [ADR-0008](0008-v1-scope-amendment.md) §1, which merely made the map optional; it removes the second artifact.
- **The 资源深度网络图 is deleted, by agreement.** 陈栩锋 proposed dropping it — 「它并不是我们在做教学计划里面的一个要求…它只是想表达一个深度学习的递进关系，从物象到体验到关系到意义」 — and 林朝湃 agreed twice — 「删除掉，删除掉，你说的非常对」「我们只要一个计划的网络」. Its underlying idea — progressive depth from 物象 through 体验 and 关系 to 意义 — survives as pedagogy inside activity design, not as a diagram.
- ADR-0006's two data structures stay separate underneath, but the panel shows a single hierarchy: time nodes, then a 课程资料 branch holding 环创方案, 材料清单 and 家长信. Unscheduled deliverables must be reachable — 材料清单 is opened on a Sunday night — and a second tab is a place things get forgotten. 林朝湃 made the same point about node contents generally: 「把一些跟节点有关的一些内容放到这个节点里面去」, because a node's material becomes background for its sub-nodes.
- **The 列表 view is not optional.** Herman's constraint, stated against a proposal to drop it: a phone-width infinite tree is unusable, so the list is the primary representation and the 导图 is one visualization of it. 「列表才是主导，导图只是另一种把列表的概念展开的可视化模式。」
- **WF-01's 「想生成月计划还是周计划」** governs what is generated first, not the tree's shape.

### 10. Entry fork: one path, two openings

The meeting's 「我需要引导 / 直接开工」 is **not two modes**. With question cards now living inside the conversation (§3), the card-versus-dialogue argument no longer describes a fork — cards appear in dialogue either way. What differs is only who speaks first:

- 帮我想想做什么 → the agent opens with a question card and builds up;
- 我已经有想法了 → she types, the agent delivers a first plan immediately and asks only about real gaps.

By the third turn the two are the same product. Nothing is stored, nothing locks, and she shifts between them by talking differently. This deliberately avoids building, testing and maintaining two flows — and it lets both sides of the meeting's opening argument read their position as having won, because after two turns there is only one product.

### 11. First run and mobile

- **Step zero**: a headline stating what the workbench is, a live checklist of what has been understood so far (real data only), and a collapsed 「看看做出来是什么样」 revealing a full sample only on request. Selling without anchoring, and the sample must contain **zero child-observation-shaped text** — invented children's discoveries on screen would contradict the product's reason to exist even as decoration.
- **Mobile landing depends on course state**: no plan yet → the conversation, because there is nothing to look at; plan exists → the tree with today highlighted, because she is checking or fixing and tapping beats typing. A persistent switch swaps either way.

## Consequences

- DESIGN.md §5b and §5c need amending: the 问题卡 tab is removed, per-node 批注 and ✓确认 are removed, the governing sentence is replaced, and the staging tray survives for card answers only.
- The harness gains a rule family around confirmation citation, testable in both directions: an escalation without a quote must be stripped; an escalation with one must pass untouched.
- Subject tagging touches the message pipeline everywhere — wire format, storage, exports, the debug drawer, and the session-log schema — but it is additive at each point.
- The removal of ✓确认 means `confirmed` is now only ever written on the model's initiative, with the citation as the guard. If pilot data shows the guard leaking, the fallback is not to restore the tick but to require the receipt's undo window to elapse before the escalation persists.

## Open questions

- **Whether 月计划 is submitted paperwork.** If teachers hand a monthly plan to the 园长 on a fixed cycle, the phase-root decision (§9) is wrong and the root must align to calendar months.
- ~~Who owns the activity content schema~~ — **resolved by the transcript.** 陈栩锋 closed the meeting with 「林博士可能你那边需要看看一个活动方案里面要包括了哪些内容」 and 林朝湃 answered 「对，我明白」. So 林朝湃 owns the activity content schema, and separately owns distilling ≤10 深度学习 principles. 陈栩锋 owns a different artifact — a corrected Word write-up of the dialogue flow he demonstrated, promised for the following day. There was never a competing template; the earlier minutes conflated the two deliverables.
- **What a 月/周 node's detail view contains** — high-level plan plus detail is the agreed shape; the specifics are blocked on the item above.
- **Mobile batch commenting.** If pilots show teachers stop annotating on phones because four comments cost four round trips, a batch path returns — but as a way to seed several node conversations at once, not as a separate 批注 mechanism.
