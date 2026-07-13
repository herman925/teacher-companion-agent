# CLAUDE.md

@AGENTS.md

Claude-Code-specific layer on top of the working agreements above (AGENTS.md wins on overlap):

- **Hooks are active.** `.claude/settings.json` wires pre-edit guarding (config-driven ask/warn paths from `harness/harness.config.json`) and post-edit lint-on-write (typewriter + glossary on the file you just edited; exit-2 findings mean fix them now).
- **Gate before commit approval.** Run `node harness/gate.mjs --fast` after doc edits and the full gate before committing.
- **Bilingual twin discipline.** When you edit `docs/PRD.md`, update `docs/PRD.zh-CN.md` in the same session (and vice versa); parity-check will block a one-sided staged change.
- **Use AskUserQuestion before**: editing `docs/glossary.json`, changing `harness/harness.config.json` levels, deleting anything under `source-docs/`, or bypassing the gate.
- **Demo verification**: after demo changes, open the page in a browser (or run the demo's check script) and confirm rendering before reporting done. "It compiled" is not verification.
- **Runtime-harness changes need both directions tested**: a rule must demonstrably fire on a violating fixture AND stay silent on a compliant one (same discipline as `tests/integration/harness-line.test.mjs`).
- **Pilot server ops**: this PC has key-auth SSH to the Tencent VM (`ssh ubuntu@43.136.113.129`). Deploys go `git push server dev|main` (auto-deploy hook), never GitHub-pull on the server. Full runbook: `docs/OPERATIONS.md`.
