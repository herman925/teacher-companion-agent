# demo/migrations — the first tables in `teacher_platform`

Five psql scripts that turn an empty PostgreSQL 16 database into the schema in
[docs/DATABASE.md](../../docs/DATABASE.md) v0.2 §2, with row-level security on
from the first table rather than retrofitted
([ADR-0013](../../docs/adr/0013-security-and-data-custody-for-launch.md) §5).

| File | What it does | Run as |
|---|---|---|
| `001_schema.sql` | Tables, indexes, constraints (§2) | `postgres` |
| `002_roles.sql` | `app_owner` / `app_rw` / `app_admin` / `app_leader`, ownership, privileges (§2c) | `postgres` |
| `003_rls.sql` | `ENABLE` + `FORCE ROW LEVEL SECURITY` and the policies (§2c) | `postgres` |
| `004_views.sql` | `leader_dashboard`, granted to `app_leader` and to nobody else (§2d) | `postgres` |
| `005_auth_plane.sql` | `sessions` / `admin_audit` / `user_keys` / `app_state`, the account columns (§4), and the migration ledger | `postgres` |
| `006_facts_widened_at.sql` | `facts.widened_at` — WHEN a fact was widened, which `001` does not record (§2e) | `postgres` |

Read this whole file before running anything. The section that matters is
[Verify that RLS is real](#verify-that-rls-is-real) — this setup is the kind
that fails silently, and "it applied without errors" is not evidence that it
works.

## Before you start

- **These are psql scripts, not plain SQL.** They use meta-commands (`\set`,
  `\if`, `\echo`) and psql variables. Run them with `psql -f`. A generic SQL
  client or a GUI will choke on the first backslash.
- **They are not idempotent.** No `IF NOT EXISTS` anywhere: re-running a file
  must fail loudly rather than half-apply against a database that has data.
- **They expect zero tables.** Verified state as of 2026-07-29: the database
  `teacher_platform` exists on the Lighthouse VM and holds no tables at all.
  If that is no longer true, stop and find out why before proceeding.
- **PostgreSQL is localhost-only on the VM.** Connect over SSH
  (`ssh ubuntu@43.136.113.129`, see [docs/OPERATIONS.md](../../docs/OPERATIONS.md)),
  not over the network.
- **The ledger arrived with the fifth file.** `005_auth_plane.sql` creates
  `schema_migrations` and backfills rows for 001–004 (their real application
  times are unknown and are labelled as such rather than invented). From now on,
  every migration inserts its own row and
  `SELECT * FROM schema_migrations ORDER BY filename;` is how you tell what this
  box has had — not memory, and not the verification queries below.

## Secrets

The three login roles take their passwords from psql variables. No password may
appear in this repository, in shell history, or in `ps` output — which rules out
`psql -v app_pw=…` on the command line, because that is visible in both.

Generate them and put them in a file **outside the repository**, readable only
by root:

```bash
umask 077
{
  echo "\\set app_pw '$(openssl rand -base64 24)'"
  echo "\\set adm_pw '$(openssl rand -base64 24)'"
  echo "\\set ldr_pw '$(openssl rand -base64 24)'"
} > /root/migration-vars.psql
```

Copy the values into the server `.env` (the application reads `DATABASE_URL`;
see [Wiring the application](#wiring-the-application)) and into whatever the
team uses to keep operational secrets, then keep the file at mode `600` or
delete it once the roles exist. `002_roles.sql` refuses to run if any of the
three variables is unset, so a mistyped filename fails before it creates
anything.

One more log-hygiene check before running `002`: if `log_statement` is `all` or
`ddl` in `postgresql.conf`, the `CREATE ROLE … PASSWORD` statements land in the
Postgres log in clear text. Confirm with `SHOW log_statement;` (`none` on a
default install) and, if it is not `none`, turn it off for the duration.

## Apply, in order

From a shell on the VM, with this repository checked out:

```bash
cd /path/to/repo
sudo -u postgres psql -d teacher_platform -f demo/migrations/001_schema.sql
sudo -u postgres psql -d teacher_platform \
     -f /root/migration-vars.psql \
     -f demo/migrations/002_roles.sql
sudo -u postgres psql -d teacher_platform -f demo/migrations/003_rls.sql
sudo -u postgres psql -d teacher_platform -f demo/migrations/004_views.sql
sudo -u postgres psql -d teacher_platform -f demo/migrations/005_auth_plane.sql
sudo -u postgres psql -d teacher_platform -f demo/migrations/006_facts_widened_at.sql
```

`006` is the first additive file: it uses `ADD COLUMN IF NOT EXISTS` and may be
re-run. Every other file here is deliberately not idempotent. Apply it on any
box that already has `001`–`005` — without it every memory query in
`pg-store.mjs` fails with `42703`, and the teacher memory band goes silent.

Two `-f` options in one invocation share a single psql session, which is how
`002` sees the variables set by the vars file. Keep them in that order.

Do not add `--single-transaction`: each file already wraps itself in
`BEGIN`/`COMMIT`, and combining the two produces "there is already a
transaction in progress" warnings.

Stop at the first failure. `\set ON_ERROR_STOP on` is set inside every file, so
a failing statement aborts psql with exit status 3 and the surrounding
transaction rolls back — nothing is half-applied.

**Apply all five before any application connects.** Between `002` and `003`,
`app_rw` holds table privileges with no row-level security behind them. That
window is harmless on an empty database and dangerous on a populated one. And
`pg-store.mjs` does not run at all without `005` — it queries `sessions`,
`admin_audit`, `user_keys` and `app_state`, none of which `001` creates.

**Do not hand-create the `005` tables during an outage.** A table created on the
box is owned by `postgres`, has no `ENABLE`, no `FORCE`, no policy and no grant,
and looks identical to a correct one in `\dt`. That is precisely the silently
disabled row-level security `002` and `003` exist to prevent, on the two tables
that hold bearer tokens and vault ciphertext. `createPgStore` refuses to start
against such a database (see [Why the store refuses to
start](#why-the-store-refuses-to-start)), which is the cheapest place for that
mistake to surface.

## Verify that RLS is real

Run every check. Each one exists because the corresponding mistake produces no
error message.

**Never run these as `postgres`.** Superusers, and any role holding
`BYPASSRLS`, ignore row-level security entirely — including `FORCE`. A check run
as the superuser proves nothing and will show you every row in the table.

### 1. The application does not own the tables

```sql
SELECT tablename, tableowner FROM pg_tables
 WHERE schemaname = 'public' AND tableowner <> 'app_owner';
```

Expect **zero rows**. Any row here means ownership did not move in `002`, and a
table owner is exempt from its own policies unless `FORCE` is also set — which
is exactly the "RLS that appears enabled and enforces nothing" failure.

### 2. Every table is ENABLE **and** FORCE

`pg_tables.rowsecurity` is the column everyone reaches for, and it only reports
`ENABLE`:

```sql
SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';
```

That query can return `t` for every table while the owner still bypasses every
policy. `FORCE` lives in `pg_class.relforcerowsecurity` and nowhere else, so the
check that counts is:

```sql
SELECT c.relname,
       c.relrowsecurity      AS enabled,
       c.relforcerowsecurity AS forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
 ORDER BY 1;
```

Both columns must be `t` on all fifteen tables (ten from `001`, five from
`005`). The offenders-only form, which should return zero rows:

```sql
SELECT c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
```

### 3. The policies exist, and read `app.user_id`

```sql
SELECT tablename, policyname, roles, cmd
  FROM pg_policies WHERE schemaname = 'public'
 ORDER BY tablename, policyname;
```

Expect **27 policies over 15 tables**: one policy per table for `app_rw`
(`users_self`, and `<table>_owner` everywhere else) and one `<table>_admin` for
`app_admin`, plus `courses_aggregate` and `facts_aggregate` for `app_owner`
(those two exist only so that `leader_dashboard` can read anything; see
`004_views.sql`). One of the ten `001` tables — `violations` — is the only one
`app_rw` can write but not read back in full, which is deliberate; see `003`.

The five tables `005` adds (`sessions`, `admin_audit`, `user_keys`, `app_state`,
`schema_migrations`) carry an `app_admin` policy **and no `app_rw` policy at
all**, because the auth plane runs entirely on the admin connection — the
resolution of `003`'s known gap, option (b), now recorded in `DATABASE.md` §2c.
For those five, one policy is the finished state; for the other ten, a table
with fewer than two is a table somebody added without finishing.

Every `app_rw` policy must test the session setting. This finds any that does
not:

```sql
SELECT tablename, policyname FROM pg_policies
 WHERE schemaname = 'public' AND roles = '{app_rw}'
   AND qual NOT LIKE '%app.user_id%';
```

Expect zero rows. Note that `pg_policies.qual` shows the *deparsed* expression,
which typically renders the literal with an explicit cast
(`current_setting('app.user_id'::text, true)`) rather than character-for-
character as written in `003_rls.sql`. Match on the substring `app.user_id` so
the check does not depend on how Postgres chooses to print it.

A table with RLS enabled and no policy at all denies everything, which is the
safe direction but is usually a mistake:

```sql
SELECT c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid);
```

### 4. No role can bypass

```sql
SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
  FROM pg_roles WHERE rolname LIKE 'app\_%' ORDER BY 1;
```

`app_owner` must show `rolcanlogin = f`. All four must show `rolsuper = f` and
`rolbypassrls = f`. A `t` in either of the last two columns makes every policy
in `003` advisory for that role.

### 5. The proof obligation — one teacher cannot read another's course

ADR-0013 §5 is explicit that this section is a wish until this test exists.
Both directions, same discipline as the runtime-harness rules: the guard must
fire on the violating case **and** stay silent on the compliant one.

Seed two teachers with one course each (as `postgres`, which bypasses RLS, so
the setup is not itself under test), then connect **as `app_rw`**:

```bash
psql "postgresql://app_rw:PASSWORD@localhost:5432/teacher_platform"
```

```sql
-- Compliant direction: her own rows come back.
BEGIN;
  SET LOCAL app.user_id = '<teacher A uuid>';
  SELECT count(*) FROM courses;                        -- expect: A's course count, > 0
  SELECT count(*) FROM courses WHERE id = '<A course>';-- expect: 1
COMMIT;

-- Violating direction: B's course, asked for by id, by A.
BEGIN;
  SET LOCAL app.user_id = '<teacher A uuid>';
  SELECT count(*) FROM courses WHERE id = '<B course>';-- expect: 0
  SELECT count(*) FROM messages;                       -- expect: A's messages only
COMMIT;

-- Forgotten identity: no SET LOCAL at all.
BEGIN;
  SELECT count(*) FROM courses;                        -- expect: 0, not everything
COMMIT;
```

The third block is the one that matters most: it is the behaviour of a code path
that forgot to name its user. If it returns rows, `SET LOCAL app.user_id` is not
the only thing standing between two teachers.

Test the owner side too, on a table that has no aggregate policy:

```sql
-- as postgres
SET ROLE app_owner;
SELECT count(*) FROM messages;   -- expect: 0 — FORCE applies to the owner
RESET ROLE;
```

`app_owner` cannot log in, so `SET ROLE` is the only way to reach it; row
security is applied to the role in effect after `SET ROLE`. Treat this as a
supporting check and step 5's direct `app_rw` connection as the real proof.
Do **not** run the same check against `courses` or `facts` — `003` grants
`app_owner` a deliberate read-only aggregate policy on those two so that
`leader_dashboard` works, and it will correctly return rows.

### 6. Leaders reach the view and nothing else

```bash
psql "postgresql://app_leader:PASSWORD@localhost:5432/teacher_platform"
```

```sql
SELECT * FROM leader_dashboard;   -- expect: it runs
SELECT * FROM courses;            -- expect: ERROR, permission denied for table courses
SELECT * FROM messages;           -- expect: ERROR, permission denied for table messages
SELECT * FROM materials;          -- expect: ERROR, permission denied for table materials
```

An **empty** `leader_dashboard` is not a failure during the pilot: the view
suppresses any group with fewer than five distinct courses, so it stays empty
until there is enough data to aggregate. To tell "empty because suppressed" from
"empty because the aggregate policy is missing", run `SET ROLE app_owner;
SELECT count(*) FROM courses;` as `postgres` — a non-zero count means
`courses_aggregate` is in place and the view can see its base tables.

### 7. The `005` tables, and the ledger

```sql
SELECT filename, applied_at, applied_by FROM schema_migrations ORDER BY filename;
```

Five rows. The first four say `backfilled by 005 — actual time unknown`, which
is the honest record: they were applied before the ledger existed.

Then re-run steps 1 and 2 — `sessions`, `admin_audit`, `user_keys`, `app_state`
and `schema_migrations` must all be owned by `app_owner` with both RLS columns
`t`. A table that reached this database any other way (hand-created during an
outage) has none of that and is indistinguishable in `\dt`.

## Why the store refuses to start

`createPgStore` runs three assertions on its first connection and **throws**
rather than degrading:

1. `current_user` is not a superuser, is not the tables' owner, and is not
   `app_admin`;
2. every table in `public` has both `relrowsecurity` and
   `relforcerowsecurity`;
3. when no separate admin URL is configured, the shared connection is not
   `app_rw`.

Each one exists because the corresponding misconfiguration is **invisible from
the application**. Every teacher-plane query in `pg-store` also carries an
explicit `WHERE user_id = $1`, so the whole contract suite returns identical
results against a database with RLS switched off — the isolation appears to work
and is not there. A boot failure is the loudest cheap moment to find that out.

If the store refuses to start, do not remove the check. Run steps 1, 2 and 5
above and fix what they report.

## Wiring the application

`DATABASE_URL` on the server points at **`app_rw`**:

```
postgresql://app_rw:PASSWORD@localhost:5432/teacher_platform
```

Never `postgres`, never `app_owner`. Pointing it at either restores the exact
failure that `002` and `003` exist to prevent — and until the startup assertions
above existed, nothing in the application complained.

The admin console uses a second connection as `app_admin`; every content read
through it must append a line to the access log at
`.data/auth/access-log/YYYY-MM-DD.jsonl` (ADR-0013 §7). The log is the
compensating control for that role's reach, so a console that reads without
logging is not the design.

Every request that touches teacher data:

```sql
BEGIN;
  SET LOCAL app.user_id = '<the session user uuid>';
  -- queries here
COMMIT;
```

`SET LOCAL`, not `SET`. A plain `SET` outlives the transaction and, on a pooled
connection, hands the next teacher the previous teacher's identity. No policy
can protect against that.

## Operating notes

- **A future data migration will silently do nothing if you run it as
  `app_owner`.** `FORCE` applies to the owner, and `app_owner` has only two
  read-only aggregate policies, so a backfill `UPDATE` matches zero rows and
  reports success. Run data changes as `postgres` (superuser bypasses RLS), or
  temporarily `ALTER TABLE x NO FORCE ROW LEVEL SECURITY`, then restore it and
  re-run the checks in step 2.
- **Every new table needs both halves, by hand.** A `GRANT` in the `002`
  pattern and `ENABLE` + `FORCE` + policies in the `003` pattern. `002`
  deliberately sets no `ALTER DEFAULT PRIVILEGES`, so nothing is granted
  automatically and a forgotten table is unreadable rather than unprotected.
  `005` is the worked example of doing all three parts for four new tables.
- **The one-time JSON importer runs as `postgres`.**
  `demo/scripts/import-json-to-pg.mjs` inserts into `courses`, `messages`,
  `course_snapshots` and `materials`. `app_admin` holds `INSERT` only on `users`
  and `scope_log`, so pointing the importer at it fails with `42501` at the
  first write. Widening `app_admin` for a script that runs once would leave the
  widening behind forever, so the importer takes the superuser instead.
- **Rotating a password** does not require re-running anything:
  `ALTER ROLE app_rw PASSWORD :'app_pw';` with the same vars file.
- **Full teardown** (destroys all data — for a pilot reset only):

  ```sql
  DROP OWNED BY app_owner, app_rw, app_admin, app_leader CASCADE;
  DROP ROLE app_owner, app_rw, app_admin, app_leader;
  ```

## Known gaps, recorded rather than guessed

- **Login cannot run as `app_rw` under `users_self`.** Resolving a teacher by
  phone or display name happens before `app.user_id` can be set, so the lookup
  returns zero rows. Two candidate fixes are written out at the top of
  `003_rls.sql`; neither is chosen here, and the choice belongs in DATABASE.md
  before it is coded.
- **DATABASE.md §4 contradicts §2** on `users.role` and `users.status`. `001`
  follows §2 and ADR-0013 §11 (`active` / `revoked` / `erased`). §4's session
  and audit tables are not created here; they belong to a later migration
  written alongside the auth build.
- **`courses.updated_at` has no trigger**, because §2 documents none. The turn
  transaction must set it explicitly, or `idx_courses_owner` orders every course
  list by creation time forever.
- **`leader_dashboard` is more suppressive than §2d as written.** §2d's
  `HAVING count(*) >= 5` counts joined rows, so a single course carrying five
  facts of one kind passes the threshold alone and publishes the very
  single-course row the threshold exists to suppress. `004` adds
  `AND count(DISTINCT c.id) >= 5`; DATABASE.md should be updated to match.
- **Backups do not exist yet** (ADR-0013 open questions). Nightly `pg_dump` to
  the private bucket is the obvious shape, and a restore that has never been
  drilled does not count.
