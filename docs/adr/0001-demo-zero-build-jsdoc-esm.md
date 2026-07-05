# ADR-0001: Demo uses JSDoc-typed ES modules with no build step

**Status:** Accepted · 2026-07-05

## Context

The demo needs typed, maintainable browser + Node code. TypeScript was the default instinct ("html + js + typescript maybe"). But the repo inherits a zero-npm-dependency philosophy from the sister project's harness: every dependency is an attack/maintenance surface, and the dev harness itself runs on bare Node ≥18. TypeScript requires either a compiler dependency (typescript/esbuild) and a build step, or abandoning type checking.

## Decision

Demo code is written as **plain ES modules (`.mjs`/`.js`) with JSDoc type annotations**. Browsers load `demo/src/**` natively via `<script type="module">`; `demo/serve.mjs` runs on bare Node. Type checking is available on demand via `npx tsc --noEmit --checkJs` (or an editor's built-in TS server) without any committed dependency or build artifact. Shared JSDoc `@typedef`s live in `demo/src/types.mjs`.

## Consequences

- Zero build step: edit → refresh. The gate stays dependency-free; CI needs no toolchain.
- Types are advisory (editor/`--checkJs`), not enforced at commit time. Acceptable for a demo; production may revisit.
- No TS-only features (enums, decorators). Interfaces become `@typedef`s.
- If the demo graduates to production code, this ADR must be revisited (likely: real TS + a pinned bundler, as its own ADR).

## Alternatives considered

- **TypeScript + esbuild dev dependency**: better ergonomics, but breaks the zero-dep gate philosophy and adds a build artifact pipeline for a demo whose point is the conversation design, not the toolchain.
- **TypeScript compiled by a globally-installed tsc**: hidden machine state; violates "no guessing" reproducibility.
