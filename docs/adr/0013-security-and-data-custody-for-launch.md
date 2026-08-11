# ADR-0013: Security and data custody for the alpha launch

Date: 2026-07-29 · Status: accepted · Amends [ADR-0002](0002-pilot-backend-lighthouse-vm.md), [ADR-0005](0005-per-account-key-vault-and-rate-limits.md)

## Context

Until now every teacher on the deployed instance has been a colleague and every course has been test data. Launching to invited teachers changes that in one step: the content becomes real lesson plans, and the uploads become photographs of other people's children.

The deployed reality, checked rather than remembered (2026-07-29):

- The public instance serves over **plain HTTP** — `listen 80 default_server`, no certificate.
- All user data lives as **JSON files on disk**: 24 courses on public, 9 on dev, separate datasets.
- PostgreSQL is installed and the database `teacher_platform` exists — with **zero tables**. It has never been used.
- `ADMIN_TOKEN` and `KEYS_SECRET` are both set. The key vault, rate limits, opaque sessions and per-user course scoping all work.

Two documents disagreed about the production target: [ARCHITECTURE.md](../ARCHITECTURE.md) §5 describes Tencent CloudBase, while [ADR-0002](0002-pilot-backend-lighthouse-vm.md) and [OPERATIONS.md](../OPERATIONS.md) describe the machine that actually runs. That had to be settled before anything else, because storage, backups, TLS and row-level security all resolve differently between them.

The instance is a **Lighthouse** server (not a CVM, as this ADR's first draft said): 2 vCPU, 4GB RAM, 70GB SSD system disk, 600GB/month at 6Mbps, Guangzhou zone 4.

## Decision

### 1. Production is the Lighthouse VM. CloudBase becomes a candidate, not the plan

It runs today, the deploy hook works, and PostgreSQL is local — which is what makes real row-level security available. A migration in the weeks before launch would buy no user-visible benefit, and ARCHITECTURE.md's own research warns that CloudBase's AI layer churns (Agents discontinued 2025-09, promos ended 2026-06).

ARCHITECTURE.md §5 is re-marked as a candidate. The portability rule that made the choice cheap stays: core modules are plain ESM and the transport shell is replaceable, so this is reversible if scale ever demands it.

**Accepted risk:** one machine is one point of failure. Tolerable for an invited alpha; before wide launch it requires working backups and a written rebuild path.

### 2. TLS blocks real users. This is the launch gate

No teacher content may reach the public instance over HTTP. SECURITY.md §9 already stated the rule — 「Until then: test data only」 — and this ADR promotes it from a known gap to a release gate.

TLS needs a domain and a mainland domain needs 备案, which has weeks of lead time. **File it now**, ahead of every other item here, because nothing else can ship without it.

### 3. Whitelist only. No self-registration

Accounts are admin-provisioned, as today. No public sign-up in this phase. This is what makes §4 possible.

### 4. The browser never holds a model key

The vault already does this for logged-in users: `keys: {}` on the wire, ciphertext at rest, the read endpoint returning presence flags and never values, decryption at call time after the session resolves.

The fallback path — `localStorage` keys travelling in the request body when there is no session — is **removed entirely**, not disabled by a flag. With a whitelist there is no legitimate user without a session, so the branch has no purpose and a branch that must stay correctly configured is a branch that will one day be misconfigured.

**Cost, accepted:** the paste-your-own-key offline demo stops working. Local development uses env keys.

### 5. PostgreSQL with row-level security, from the first table

Data moves off disk files into Postgres, and RLS is enabled at creation rather than retrofitted — there are zero tables today, which is the cheapest this will ever be.

The setup that makes it real, all three parts required:

- the application connects as a role that does **not own** the tables;
- every table carries `FORCE ROW LEVEL SECURITY`, because the owner bypasses policies by default and RLS that silently does nothing is worse than no RLS;
- each request sets its user inside the transaction (`SET LOCAL app.user_id`).

Admin access uses a separate role that bypasses the policies deliberately, so "admin can read everything" is an explicit grant rather than an accident.

**Proof obligation:** a test that connects as teacher A and tries to read teacher B's course, and gets nothing. Without that test this section is a wish.

### 6. Uploads go to LighthouseCOS, never to the system disk

Verified 2026-07-29: LighthouseCOS is built on COS, is API/SDK/CLI compatible with it, supports 私有读写 buckets, and supports signed URL access.

The reason is the hardware, not scale. A phone photo is 2–5MB; twenty teachers uploading twenty a week is roughly 75GB a year against a **70GB system disk**. Filling the system disk does not merely exhaust storage — it stops Postgres writing and takes the whole service down, which would mean teacher uploads can kill the server. Separately, the 6Mbps pipe is shared with the API, and object storage serves files off Tencent's network instead.

Rules:

- The bucket is **private**. No public read, at any point, for any object.
- Postgres stores only a row — owner, course, random key, size, MIME. The bytes are never in the database.
- Object keys are random (`courses/<uuid>/<uuid>.<ext>`), never the uploaded filename.
- Viewing is server-mediated: check ownership, then mint a **short-lived** presigned URL. Minutes, not the 2-hour default.
- **Photo metadata is stripped at ingest.** A phone JPEG carries GPS coordinates; a picture of children plus the exact location of the kindergarten in one file is not something to store and hope about.
- Type allowlist (PDF, DOCX, JPEG, PNG) and a size cap. Reject by default rather than blocklisting.
- Deleting a course deletes its objects. Orphaned child photos in a bucket nobody tracks are the failure mode to design against.
- Non-negotiable #4 stands: **no uploaded child photo goes to any model** without a compliance decision recorded as its own ADR. The upload path enforces it; a comment is not enforcement.

Because it is COS-compatible, moving to standard COS later is configuration, not a rewrite.

### 7. Admins read everything, and every read is recorded

Herman's call: the admin console keeps full read access to course content and uploads. Reach and accountability are separate axes, and only the second is constrained here.

Every content read — opening a course's messages, opening a file — appends one line to a **daily-rotated** log at `.data/auth/access-log/YYYY-MM-DD.jsonl`: who, what, when. Daily files rather than one growing file, kept beside the other auth data. Retention 90 days, then pruned; an audit log that grows forever becomes its own liability.

The log is not teacher-visible in this phase.

**Stated plainly because it is a real tension:** non-negotiable #4 asks for scoped access, and full admin read is broader than that. It is accepted deliberately for a small trusted team, with the access log as the compensating control, and should be revisited when the team grows beyond the people who built it.

### 8. Admin auth: shared token now, session and role at public beta

The console is gated by a shared password today (`adminAuthorized` compares a token, resolving no user). That is acceptable while the console is effectively reachable only by three people.

**At public beta launch it becomes session + role** — admins log in as themselves and the console checks `role === 'admin'`. This is written as a launch gate with a named trigger rather than 「later」, because until it lands the access log in §7 can only record 「someone with the token」 and attribution is impossible.

### 9. Memory accepts a closed set of fact kinds

The building agent flagged, correctly, that an extractor cannot distinguish 「班上没有鼓」 (a constraint) from 「孩子们对鼓声特别有反应」 (a child observation) — both are short sentences a teacher says — and declined to add a keyword heuristic on the grounds that it would give false confidence exactly where the product cannot afford it.

The fix is structural, not textual. Memory accepts only these kinds:

`equipment` · `space` · `schedule` · `class_composition` · `teacher_preference`

A child observation has no kind to be filed under, so the bypass closes by construction. Anything the model wants to record about what children did must go through `children_evidence` with an evidence reference — the existing gated path. Unclassifiable input is refused, not guessed at.

### 10. Leaders see aggregates, never named content

A 园长 or 教研员 role reads counts, theme distribution, stage progression and common constraints — enough to answer 「区里面的难点在哪里」, which is what the meeting actually promised. Not a named teacher's plan, not child evidence, not photos.

Mechanically: leader roles read a **view**, never the base tables, so the RLS policy stays simple and a mistake in a leader query cannot reach a course row.

This also keeps a promise that can be made honestly to teachers in one sentence. The meeting recorded teachers turning a review into a 吐槽大会 when they felt work was being pushed at them; discovering they were being read would be worse.

### 11. Three account states, and revocation is not deletion

- **active**
- **revoked** — login refused, sessions dead, data retained. The teacher left the school, or was banned.
- **erased** — everything gone.

These are different operations for different situations, not points on a scale. Alpha cleanup uses erase.

**Erase** removes courses, messages, snapshots, memory facts across all four scopes, vault entries, and the COS objects — verified, not assumed. Two tests: no orphaned object remains in the bucket, and no row references the missing user. Access-log rows keep the admin id and lose the subject.

**Revoked data auto-erases after a configurable window, default 12 months.** A kindergarten can still refer to last year's curriculum; child observations from a teacher who left do not sit in the database indefinitely because nobody remembered. The window is configuration, so the pilot's compliance answer can set it.

## Consequences

- **Order is forced by lead time**, not preference: 备案 first, because TLS waits on it and real users wait on TLS. Everything else can proceed in parallel.
- The persistence work now has a fixed shape: `pg-store.mjs` behind the existing `store.mjs` facade, plus a one-time importer for the JSON files, with the store test suite passing against both implementations as the proof the swap is safe.
- Postgres needs a driver, and this repository has **zero dependencies** by long-standing choice. Accepting `pg` is the first exception; it is recorded here rather than slipped in, and applies only to the server tier — core modules stay dependency-free and portable.
- `DATABASE.md` §2 predates Workflow v2 and knows nothing about subjects, the plan tree, memory facts, interaction axes, the scope log, uploads or the access log. It must be brought up to date **before** the schema is created, or the migration builds the wrong tables.
- §5's RLS discipline and §7's access log are both easy to implement in a way that appears to work and does not. Each carries a proof obligation above; neither is done until its test exists.
- SECURITY.md §9's gap table shrinks: TLS becomes a gate, admin-token becomes a dated commitment, and CSRF origin checks remain open.

## Open questions

- **备案 subject** — which legal entity files, and how long it takes in practice. Blocks everything.
- **The retention window's real value.** 12 months is a placeholder chosen to be defensible, not a compliance answer. Someone who knows mainland requirements for child-related records should set it.
- **Whether the access log should become teacher-visible** once admin auth is session-based. Deferred, not rejected.
- **Backups.** Nightly `pg_dump` plus COS lifecycle is the obvious shape; nothing exists yet, and the current JSON files are unbacked. Acceptable only while the data is genuinely test data.
