# OPERATIONS.md — pilot server runbook

How to reach, deploy to, and debug the pilot VM. Written for both humans and future coding-agent sessions on Herman's PC. Decision context: [ADR-0002](adr/0002-pilot-backend-lighthouse-vm.md).

## The server

| | |
|---|---|
| Host | Tencent Lighthouse VM, Guangzhou (instance `lhins-2vtadb4x`) |
| IP | `43.136.113.129` |
| OS | Ubuntu Server 24.04 LTS, 2 vCPU / 4 GB / 70 GB SSD, prepaid to 2027-07 |
| Admin access | `ssh ubuntu@43.136.113.129` — key auth from Herman's PC (`~/.ssh/id_ed25519`); no passwords. `ubuntu` has passwordless sudo. |
| Firewall | Tencent console (Lighthouse → 防火墙), NOT ufw. Open: 22, 80, 443. Everything else blocked. |

If SSH stops working: Tencent console → instance → 登录 → 免密连接 (TAT) gives a browser terminal without SSH.

## What runs where

| Instance | Path | Branch | Service | Bind | Reached via |
|---|---|---|---|---|---|
| Public | `/home/app/platform` | `main` | `platform.service` | `0.0.0.0:3000` | nginx → http://43.136.113.129/ |
| Dev | `/home/app/platform-dev` | `dev` | `platform-dev.service` | `127.0.0.1:3001` | SSH tunnel only |

Both run `demo/serve.mjs` under user `app`, env in each checkout's `.env` (chmod 600 — model keys and `DATABASE_URL` live there, never in the repo). PostgreSQL 16 runs localhost-only, database `teacher_platform`; the DB password is in `/home/app/.env.dbpass` (root-readable) and inside each `.env`.

## Deploying

GitHub is unreliable from mainland servers, so the server never pulls from GitHub. The flow is **local → Tencent directly**, with GitHub as the collaboration mirror:

```
git push origin <branch>   # GitHub (org repo Chao0s/teacher-companion-agent = origin, herman925 fork = fork)
git push server <branch>   # Tencent bare repo — auto-deploys via post-receive hook
```

- `git push server dev` → dev instance redeploys itself
- `git push server main` → public instance redeploys itself
- The `server` remote is `ubuntu@43.136.113.129:/srv/git/platform.git`; the hook lives in `hooks/post-receive` there and calls `/usr/local/bin/deploy-dev` / `deploy-public` (pull `--ff-only` + service restart; they can also be run by hand over SSH).

Normal cycle:

```bash
git checkout dev                  # work happens on dev
# …edit, commit…
git push server dev               # dev instance redeploys itself (watch hook output)
# …teammates test via the tunnel wizard…
git checkout main && git merge --ff-only dev
git push server main              # public instance redeploys itself
git push origin main dev          # GitHub mirror — fine if this fails; retry when reachable
```

Rules of thumb: `server` is the deploy truth, `origin` (GitHub) is the mirror; never commit directly on `main` except merges from `dev`; the hook prints `dev deployed: <commit>` / `public deployed: <commit>` — if that line is missing, the deploy did not happen.

## Dev access for teammates (no SSH knowledge needed)

- Teammate double-clicks `tools/dev-access-wizard.bat` (Windows). It creates their key, puts the public key on their clipboard, and tells them to send it to Herman. After approval it opens the tunnel and the browser at `http://localhost:3001`.
- Herman authorizes a key with `tools/grant-dev-access.ps1 "<pasted public key>"`.
- Security model: teammates authenticate as the `devtunnel` user, which has **no shell** and can forward **only** to `127.0.0.1:3001` (`/etc/ssh/sshd_config.d/60-devtunnel.conf`). They can use the dev instance (and any server-seeded model keys in its `.env`) but can never read keys, touch the DB, or reach the public instance.
- Revoke: delete their line from `/home/devtunnel/.ssh/authorized_keys` on the server.

## Debugging

```bash
ssh ubuntu@43.136.113.129 "systemctl status platform platform-dev --no-pager -l"
ssh ubuntu@43.136.113.129 "sudo journalctl -u platform-dev -n 100 --no-pager"   # dev logs
ssh ubuntu@43.136.113.129 "sudo journalctl -u platform -n 100 --no-pager"       # public logs
ssh ubuntu@43.136.113.129 "sudo -u postgres psql teacher_platform"              # DB shell
ssh ubuntu@43.136.113.129 "sudo nginx -t && sudo systemctl reload nginx"        # after nginx edits
```

Model API keys: edit `/home/app/platform/.env` (or `platform-dev/.env`), then `sudo systemctl restart platform` (or `platform-dev`). Keys may also be supplied per-request from the UI settings drawer instead.

## Inspecting demo data

The demo persistence tier stores chat history as JSON files on each instance's disk (`<checkout>/demo/.data/courses/<id>.json`), one file per course, owned by the `app` service user — not in PostgreSQL yet ([DATABASE.md](DATABASE.md) §4). Two ways to look:

**Admin console (GUI).** Each running instance serves a data console at `/admin`: courses with message/snapshot counts, full-record view, per-course download and whole-export, plus delete / multi-delete. It carries an in-page 使用指南 for teammates.

Access model (two doors, one console):

1. **Authorized machine (the wizard).** A teammate whose SSH key Herman approved runs `tools/dev-access-wizard.bat`; the tunnel itself is the authentication. The dev instance's `.env` deliberately leaves `ADMIN_TOKEN` unset, so inside the tunnel `http://localhost:3001/admin` needs **no password** — machine auth already happened.
2. **Password (unauthorized device — a phone, a borrowed PC).** The public instance sets `ADMIN_TOKEN` in `/home/app/platform/.env` (server-side only — passwords never enter the repo, same rule as model keys). The console page sends the SHA-256 of the entered password in the `x-admin-token` header, never the plaintext and never in a URL. Honest limit: until 备案 unlocks HTTPS, bare-IP HTTP means an on-path observer could replay the hash — the hash protects the password itself, not the session. Real transport secrecy arrives with TLS.

**Planned feature (recorded 2026-07-15): retire the password path entirely** — admin access becomes authorized-machine only (wizard/tunnel), and `ADMIN_TOKEN` support is removed. Keep until teammates stop needing phone access.

**CLI (files are `app`-owned → `sudo`).**
```bash
ssh ubuntu@43.136.113.129 'sudo ls -la /home/app/platform-dev/demo/.data/courses/'
ssh ubuntu@43.136.113.129 'sudo cat /home/app/platform-dev/demo/.data/courses/<id>.json | jq .'
# export ALL demo data to your PC
ssh ubuntu@43.136.113.129 'sudo tar -C /home/app/platform-dev/demo -czf /tmp/demo-data.tgz .data && sudo chown ubuntu /tmp/demo-data.tgz'
scp ubuntu@43.136.113.129:/tmp/demo-data.tgz .
```

Once the v1 persistence layer lands, this data moves to PostgreSQL; manage it then with `psql` / `pg_dump`, or a desktop GUI (DBeaver, TablePlus) over a tunnel: `ssh -L 5432:localhost:5432 ubuntu@43.136.113.129` (empty until the schema is applied).

## Standing constraints

- **No domain / no ICP 备案 / no TLS yet.** Bare-IP HTTP is test-only: no real teacher or child data until 备案 approval + HTTPS (see [LAUNCH-COMPLIANCE.md](LAUNCH-COMPLIANCE.md) and ADR-0002). 备案 is the multi-week long pole — buy domain, file early.
- **Database is provisioned but not yet wired to code** — persistence layer per [DATABASE.md](DATABASE.md) is the next build. Until then course state lives in each browser's localStorage.
- Backups: nightly `pg_dump` job is part of the persistence-layer work; until data lands in Postgres there is nothing to back up.
