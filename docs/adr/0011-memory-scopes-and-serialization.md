# ADR-0011: Four memory scopes, the class object, and where TSV is allowed

Date: 2026-07-29 · Status: accepted · Amends [ADR-0007](0007-tiered-context-and-change-propagation.md), [ADR-0009](0009-teacher-interaction-axes.md)

## Context

[ADR-0007](0007-tiered-context-and-change-propagation.md) established that context is tiered by subject and that decisions travel with the node they changed. [ADR-0010](0010-conversation-and-workbench-model.md) then scoped conversations to nodes. Together they create a specific hole.

Work through it concretely. A teacher opens 活动 3.2.1 and says 「我们班没有鼓，而且有几个孩子很怕大声」. The activity is changed to wooden sticks. Two days later she opens 周3, asks for a new activity, and is offered 敲鼓感受节奏.

Two different things came out of that first conversation:

1. *This activity now uses sticks.* A fact about node 3.2.1. Node-level provenance and revision history already carry it.
2. *This class has no drums and several noise-averse children.* **Not** a fact about 3.2.1. It constrains every activity in every week of every course she will ever plan — and node-scoped memory has nowhere to put it except on the node, where 周3 will never look.

The second case is 「我早就跟你说过」, and it is created by the very design that made node conversations cheap. It cannot be fixed by better node memory.

A second problem surfaced alongside it: a class outlives a course. In September she finishes 龙舟 and starts 中秋灯笼 with the same children. Memory scoped to the *course* does not travel, so the same failure fires at the start of every new theme. Teachers also frequently teach more than one class, in different rooms with different equipment — so 「which class is this?」 is a question the system must be able to answer.

## Decision

### 1. Four memory scopes

| Scope | Holds | Lifetime | Written by |
|---|---|---|---|
| **Node** | why this node reads as it does — heard quotes, assumptions, pedagogical basis, edit history and reasons | the node | generated deterministically on every change |
| **Course** | facts about this theme | the course | auto-extracted |
| **Class** | 班上没有鼓 · 几个孩子怕大声 · 下雨就用不了户外场地 | the class, across courses | auto-extracted, or widened from course scope |
| **Teacher** | interaction axes ([ADR-0009](0009-teacher-interaction-axes.md)), working preferences | forever | inferred + explicit |

Node memory is not *extracted* — it is generated whenever a node changes, and it already exists as `rationale` plus the revision history from ADR-0007 §5. Only the middle two require the agent to notice something and keep it.

**Default narrow, widen deliberately.** Filing a fact too narrowly makes her repeat herself once — annoying. Filing it too broadly follows her invisibly into every future course — much worse. So auto-extraction writes to **course** scope; widening to class or teacher is a deliberate act (hers, by tap). This is the same discipline as provenance escalation, where only a deliberate act reaches `confirmed`.

**Room constraints are not a fifth scope in v1.** 「多功能室才有投影仪」 is recorded as a class fact naming the room in its text. If pilots show teachers restating room facts across classes, promotion to a real scope is a search-and-retag rather than a reconstruction.

### 2. Capture is automatic, visible, and undoable — never a form

A teacher-facing 班级情况 form is barred by non-negotiable #2 and would not work anyway: she cannot predict which facts matter before she knows what she is planning. Facts are picked up from what she naturally says.

Capture surfaces through the receipt mechanism of [ADR-0010](0010-conversation-and-workbench-model.md) §7 — a toast carrying undo at the moment, plus the compact line under that turn's reply. **The undo at the moment of capture is what makes automatic extraction safe**: a wrong fact dies in one tap while she is still looking. Correction that requires navigating to a memory page later will not happen, and the wrong fact then quietly poisons everything downstream.

One dedicated place shows all four scopes, grouped so scope is legible at a glance, each fact quoting the words it came from and the date. Every line is editable and deletable. Nothing is ever presented as a blank field to fill in.

### 3. The class object

New, and deliberately *not* an extension of `classBands` — 中班 is an age band, 中三班 is a class identity.

- The profile holds a list of named classes; each carries its own age band and size; one may be marked default.
- Starting a new course, the agent asks which class **only if she has more than one**; with one class it is assumed silently.
- Selection is single-choice.
- A toggle controls whether the agent asks at the start of every new course or always assumes the default.

### 4. Injection: always-on, late, curated rather than compressed

Class and course memory ride the volatile trailing section next to the plan skeleton, on **every** turn — node-scoped or not. Never retrieved-by-relevance: the entire purpose of class memory is that it applies everywhere, and one retrieval miss reproduces exactly the failure this ADR exists to prevent, with nothing on screen to explain it.

Placement follows the same cache logic as ADR-0007. A cache hit ends at the first differing byte, so volatile content belongs after the history, not in the stable prefix. Memory in the prefix would mean that adding one fact mid-conversation invalidates the prefix *and* every turn behind it.

Growth is bounded by **curation, not compression**:

- **merge** when a new fact restates an existing one (update the timestamp, do not append);
- **supersede** when a new fact contradicts an old one — the old is archived with a pointer, never deleted, so the record of what was believed when survives;
- **visible cap** — overflow is archived and says so. Silent truncation is barred (AGENTS.md).

Realistic volume is 20–40 short lines, a few hundred tokens. It should be markedly smaller than today's full pretty-printed state snapshot.

### 5. No pre-send harness; an assertion instead

A gate that checks whether the assembler included memory is checking the assembler against itself — it would catch a bug in our own code, not a condition in the world, and there is little real condition to check (a new class legitimately has no facts). More fundamentally, a model cannot be *forced* to attend to text; it can only be placed well and checked afterwards.

So: an **assertion inside the assembler plus a unit test**, catching the regression where a refactor silently stops appending memory. The enforceable question — did the model respect what it was told — belongs in `validateTurn`, where an activity proposing drums against a no-drums class is detectable, feedable and regeneratable, and testable in both directions.

### 6. Where TSV is allowed, and where it is not

ADR-0007 §2 set the direction; this fixes the boundary.

**TSV renders row-shaped data on the way in, and row-shaped data on the way out to analysts:**

- the plan skeleton;
- class and course memory;
- the evidence index;
- export sidecars alongside the canonical JSON, for the regional 教研 warehouse when it arrives.

**JSON everywhere else, and always for model output.** The reasons are not stylistic:

- **Schema enforcement has no TSV equivalent.** The adapter already branches on `json_schema` / `tool_call` / `json_object_prompt`; these vendor features are why malformed turns are rare. Asking for TSV output means returning to 「please format like this」, the fragile regime structured output exists to escape.
- **Failure loudness.** `parseTurn` failing is visible and drives the retry loop with specifics. A misaligned TSV column **parses successfully with wrong values in the wrong fields** — and one of those fields is provenance status. A shifted column reading `hypothesis` as `confirmed` is the exact escalation non-negotiable #1 guards against, arriving through a channel with no error to catch.
- **Shape.** Artifacts carry arbitrary nested `data`; `rationale` has optional sub-objects; deltas are partial patches. None flattens into rows without inventing nested-data-in-TSV, which is JSON with worse tooling.
- Storage, wire and config stay JSON: nested, singleton-shaped, and well served already.

**Rules for every TSV block we emit** (each fixes a known failure mode):

- **never an empty cell** — write an explicit `-`; two consecutive tabs cause silent column drift;
- **no prose** — titles only, length-capped; bodies belong in the focus band as ordinary text;
- **at most ~8 columns**;
- **a version marker in the header**, since adding a column changes every row and breaks positional readers;
- **the debug drawer renders it as an aligned table** — full-width Chinese makes tab columns invisible to human readers even where the model reads them fine.

### 7. Measure efficacy, not only tokens

ADR-0007 §6's measurement gains a second axis and a third number:

- **accuracy**, not just cost: same fixtures, JSON skeleton versus TSV skeleton, comparing whether the model's references to node numbers stay correct. Cheaper tokens with worse node-targeting is a bad trade that cost data alone would never reveal.
- **cost per subject switch.** Because each subject carries its own scoped history, switching between nodes — or between a node and the course — starts a **cold cache**, not merely an uncached tail. Real usage is bursty (several turns inside one node, then away), so this is probably tolerable, but it is a distinct number and nobody had raised it. If it proves expensive, the mitigation is a shared history segment with narrowing done in the trailing note.

### 8. Staleness clearing (completing ADR-0007 §5)

The 待复查 badge **names what changed upstream and why**, drawn from the changed node's recorded reason. 待复查 alone is a puzzle she must solve before she can judge it.

It clears on three deliberate acts — 跟着改 (accept the 连动调整), 我自己改, or 这样就行 — and **not** on merely opening the node. Reading is not deciding; a badge cleared by a distracted glance leaves the system believing she decided something she did not.

Once the node's dates have passed, the badge **retires on its own**. A warning about teaching that already happened is noise, and badges nobody reads are worse than no badges because we will believe we warned her.

The badge and ADR-0010 §5's cross-node offer are the same event at two moments: the offer is the proactive path when the agent notices during the conversation; the badge is the fallback when it did not, or when she declined.

## Consequences

- Four new stores (course facts, class facts, the class list, the archive) all carry the AGENTS.md observability duty: debug drawer, client export, admin export — including *which* utterance produced *which* fact, so a wrong extraction is diagnosable rather than mysterious.
- Class facts are the first store keyed to something other than a course or a teacher. On the no-backend static tier they live in localStorage and do not follow her across devices; the UI must say so plainly rather than paper over it.
- These are teacher- and class-behavioural records, not child records, so non-negotiable #4 does not bind them directly — but they are personal data and keep the same residency and retention posture as the rest of the account.
- `plan-tsv.mjs` grows a second consumer (memory blocks) and an export path. Round-trip tests cover both.

## Open questions

- Which utterances are safely extractable as constraints? 「今天没带鼓」 is a passing fact; 「我们班没有鼓」 is a constraint. Getting this wrong in the permanent direction is the expensive one.
- Does the class list belong to the teacher or to the kindergarten? Two teachers sharing 中三班 would benefit from shared class facts, but that is multi-teacher collaboration, currently out of scope.
- Room scope, deferred above — revisit on pilot evidence.
