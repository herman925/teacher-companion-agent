#!/bin/bash
# deploy-common — shared body for deploy-dev and deploy-public.
#
# WHY THIS IS NOT THE ORIGINAL THREE-LINER (2026-08-12, after a silent failure):
# a push reported success while the public instance kept serving month-old code
# for an hour. post-receive runs AFTER the ref moves, so a hook that fails does
# not fail the push — the operator sees "main -> main" and believes it shipped.
# Three things caused it and all three are handled below:
#   1. `git pull --ff-only` refuses to run over a dirty checkout, and said so in
#      one word ("Aborting") buried in the remote output.
#   2. Nothing installed dependencies. The repository grew its first one (pg),
#      so a checkout without node_modules is now a crash loop, not a warning.
#   3. `systemctl is-active` was the only health check, and it reports "active"
#      for a process that is restarting on a loop.
#
# Called as: deploy-common <checkout> <service> <port> <branch>
set -uo pipefail

CHECKOUT="$1"; SVC="$2"; PORT="$3"; BRANCH="$4"

# Loud on purpose. This text has to survive being skim-read inside git's own
# push output, which is where it will be seen or not seen at all.
fail() {
  echo ""
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "!!  DEPLOY FAILED — $SVC IS NOT RUNNING THE PUSHED CODE"
  echo "!!  $*"
  echo "!!  The push succeeded; the deploy did not. Fix, then push again."
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo ""
  exit 1
}

# 1. A dirty checkout silently skips the pull. Name the files — the last time
#    this happened they were package.json and an untracked package-lock.json
#    left behind by an npm install run by hand.
dirty="$(sudo -u app git -C "$CHECKOUT" status --porcelain 2>&1)"
if [ -n "$dirty" ]; then
  echo "[deploy] local changes in $CHECKOUT:"
  echo "$dirty" | head -20
  fail "checkout is dirty, so the pull would be skipped"
fi

before="$(sudo -u app git -C "$CHECKOUT" rev-parse HEAD)"
sudo -u app git -C "$CHECKOUT" pull --ff-only origin "$BRANCH" || fail "git pull --ff-only failed"
after="$(sudo -u app git -C "$CHECKOUT" rev-parse HEAD)"

# 2. Dependencies, but only when the manifest actually moved — npm ci wipes
#    node_modules, and paying that on every docs commit would be silly.
if ! sudo -u app git -C "$CHECKOUT" diff --quiet "$before" "$after" -- package.json package-lock.json; then
  echo "[deploy] dependency manifest changed — installing before restart"
  sudo -u app bash -c "cd '$CHECKOUT' && npm ci --omit=dev --no-audit --no-fund" \
    || fail "npm ci failed — do NOT restart into a missing dependency"
fi

sudo systemctl restart "$SVC" || fail "systemctl restart refused"
sleep 3

# 3. is-active is necessary and not sufficient: a service crash-looping under
#    Restart=always reads as active between attempts. Ask it for a page.
systemctl is-active --quiet "$SVC" || fail "$SVC is not active after restart"

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/" || true)"
[ "$code" = "200" ] || fail "$SVC restarted but http://127.0.0.1:$PORT/ answered '$code'"

# 4. Say what is actually running, not what was pushed. If a future failure mode
#    lets these drift apart, the line below is what shows it.
echo "[deploy] OK — $SVC now serving $(sudo -u app git -C "$CHECKOUT" log -1 --oneline)"
