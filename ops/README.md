# ops/ — the deploy scripts that live on the VM

These four files are copies of what actually runs on the Lighthouse instance. They are versioned here because the machine is a single point of failure ([ADR-0013](../docs/adr/0013-security-and-data-custody-for-launch.md) §1) and a rebuild path that exists only inside the machine being rebuilt is not a rebuild path.

| File | Installed at | Owner |
|---|---|---|
| `post-receive` | `/srv/git/platform.git/hooks/post-receive` | `ubuntu`, mode 755 |
| `deploy-common.sh` | `/usr/local/bin/deploy-common` | `root`, mode 755 |
| `deploy-dev` | `/usr/local/bin/deploy-dev` | `root`, mode 755 |
| `deploy-public` | `/usr/local/bin/deploy-public` | `root`, mode 755 |

Reinstall after a rebuild:

```bash
sudo install -m 755 ops/deploy-common.sh /usr/local/bin/deploy-common
sudo install -m 755 ops/deploy-dev      /usr/local/bin/deploy-dev
sudo install -m 755 ops/deploy-public   /usr/local/bin/deploy-public
sudo install -m 755 ops/post-receive    /srv/git/platform.git/hooks/post-receive
```

## Why deploy-common is not three lines any more

It was three lines until 2026-08-12, when a push reported `main -> main` and the public instance carried on serving month-old code. The failure was invisible for an hour and was only caught by reading a journal timestamp by hand.

`post-receive` runs **after** the ref has already moved, so a hook that fails cannot fail the push. Whatever goes wrong in here, the operator still sees a successful-looking push — which is why the failure banner is shouted rather than printed, and why each of the three original gaps now has an explicit check:

1. **A dirty checkout silently skipped the pull.** `git pull --ff-only` refuses to run over local changes and says so in one word, buried in remote output. The script now refuses first and prints the offending files. (The real case: a hand-run `npm install pg` left `package.json` modified and `package-lock.json` untracked.)
2. **Nothing installed dependencies.** The repository had none for its whole life, then gained `pg`. A checkout whose `node_modules` does not match its lockfile is now a crash loop rather than a warning. `npm ci` runs when — and only when — the manifest changed between the old and new commit, and it runs *before* the restart so a failed install never restarts into a missing module.
3. **`systemctl is-active` was the only health check.** A service crash-looping under `Restart=always` reads as active between attempts. The script now also asks the port for a page and requires HTTP 200.

The last line reports the commit the service is **actually serving**, read back from the checkout after the restart — not the commit that was pushed. If those ever drift apart again, that line is what shows it.

## Verifying a change to these scripts

All three failure paths are worth exercising by hand after any edit, because none of them fires during a normal deploy:

```bash
# 1. dirty checkout must fail, exit 1
sudo -u app bash -c 'echo "// dirt" >> /home/app/platform-dev/demo/serve.mjs'
sudo /usr/local/bin/deploy-dev; echo "exit: $?"      # want 1, and the file named
sudo -u app git -C /home/app/platform-dev checkout -- demo/serve.mjs

# 2. clean checkout must succeed, exit 0, and name the running commit
sudo /usr/local/bin/deploy-dev; echo "exit: $?"      # want 0

# 3. a service that starts but does not serve must fail
#    (temporarily point the health check at a dead port, then restore)
```

Measure the exit status directly, not through a pipe — `$?` after `... | tail` reports `tail`.
