# DEPLOY.md — hosting the proxy on Alibaba Function Compute (FC)

The demo UI is static, but the chat needs a **server-side proxy** — the LLM vendors block
browser-direct calls (CORS) and treat a frontend key as compromised, and the runtime harness must
validate a turn before the teacher sees it (see [ARCHITECTURE.md](ARCHITECTURE.md) §2). This guide
deploys `demo/serve.mjs` as an **Alibaba Function Compute 3.0 "Web Function"**.

> Note: [ARCHITECTURE.md](ARCHITECTURE.md) names Tencent CloudBase as the leading backend. Alibaba FC
> works identically as the proxy and is consistent with the sibling Hualong project's backend. Treat
> this as a deliberate, recorded deviation — capture it as an ADR if it becomes the committed choice.

## What runs where

- **UI (static):** `demo/` on GitHub Pages, or served by the same FC function. Works offline in
  **演示模式 (mock)** with no backend at all — the mock pipeline runs in the browser.
- **Proxy (FC):** `demo/serve.mjs` — model adapter, runtime harness (L2–L4), state engine. This is the
  only part that needs a server.

The UI has a **服务器地址 (server address)** field in its settings drawer. Empty = same-origin
(local dev). Set it to your FC URL and the browser sends chat turns there. When no backend is
reachable and a real model is selected, the UI falls back to a clearly-labelled **模拟演示**
(simulated) turn instead of failing.

## Option A — Serverless Devs (recommended, reproducible)

The repo ships an `s.yaml` describing the function.

1. **Install the CLI** (Node >= 18):
   ```bash
   npm install -g @serverless-devs/s
   ```
2. **Add credentials** — create a RAM user with FC access in the Alibaba console, then:
   ```bash
   s config add          # choose Alibaba Cloud; paste AccessKey ID + Secret; name it "default"
   ```
3. **Pick a region** — edit `s.yaml` `vars.region` (default `cn-shenzhen`). Use a mainland region
   near your teachers and the vendor APIs.
4. **Deploy:**
   ```bash
   s deploy
   ```
   On success it prints the function's **HTTP trigger URL** (something like
   `https://<hash>.<region>.fcapp.run`).
5. **Wire the UI** — open the demo, settings drawer, paste that URL into **服务器地址**, pick a
   provider, paste that provider's API key, send a message.

Update later with `s deploy` again; remove with `s remove`.

## Option B — FC console (click-through)

1. Function Compute console -> Create Function -> **Web Function**.
2. Runtime **Custom Runtime**; upload a zip of the repo (or connect the git repo).
3. **Startup command:** `node demo/serve.mjs` · **Listening port:** `9000`.
4. Environment variables: `FC_SERVER_PORT=9000`, `CORS_ORIGIN=*` (tighten later).
5. **Memory** 512 MB, **Timeout** 120 s (LLM turns are slow), **Instance concurrency** ~5.
6. Create -> the function gets a default HTTP trigger URL. Paste it into the UI as above.

## Keys and config

- **API keys are optional on the server.** The UI sends the teacher's key per request. If you prefer
  server-seeded keys, set `MINIMAX_API_KEY` / `GLM_API_KEY` / `KIMI_API_KEY` as **environment
  variables** on the function — never in code, never in the repo.
- **Buffered responses.** When the UI calls a cross-origin proxy it requests
  `Accept: application/json`, and `serve.mjs` returns the whole turn as one JSON payload (no SSE). This
  sidesteps any serverless response-streaming limits. Same-origin local dev still streams via SSE.
- **CORS** is set on every response (`CORS_ORIGIN`, default `*`). In production set it to your exact
  Pages origin.

## Option C — Tencent CloudBase (aligns with a WeChat mini-program future)

[ARCHITECTURE.md](ARCHITECTURE.md) names Tencent CloudBase as the leading backend, chosen for WeChat
adjacency. If the product ships as a WeChat mini program, CloudBase is the natural host, and the same
`serve.mjs` deploys to **CloudBase Run (云托管)** — a container service that runs any HTTP server.

1. In the CloudBase console, create an environment (mainland region) and open **云托管 (CloudBase Run)**.
2. Create a service; deploy using the repo-root [Dockerfile](../Dockerfile) (zero-dependency image:
   `node:20-slim` + `demo/` + `harness/schema/`). Startup command is baked in: `node demo/serve.mjs`.
3. CloudBase Run injects the `PORT` env var; `serve.mjs` already honours it and binds `0.0.0.0`.
4. Set model keys as service environment variables for server-seeded keys (else the UI sends them).
5. The service gets an HTTPS URL — paste it into the demo's 服务器地址 field.

CLI path (instead of the console): `npm i -g @cloudbase/cli`, `tcb login` (interactive browser auth, or
`tcb login --apiKeyId … --apiKey …` with an API key pair), then from the repo root deploy the service in
the target environment (CloudBase Run supports source/Dockerfile deploys; see `tcb -h` for the
version-specific command — `tcb run` family on CLI v3).

For a pure WeChat mini program (not this web UI), the proxy would instead be a CloudBase **云函数** with
an HTTP trigger (functions-framework), and the client becomes mini-program pages calling `wx.request` /
a cloud call — a separate build tracked in the PRD, not this web demo.

## Caveats

- **Custom domain needs ICP 备案.** The default `*.fcapp.run` trigger URL works for testing without
  备案. A branded production domain requires 备案 (mainland). See [LAUNCH-COMPLIANCE.md](LAUNCH-COMPLIANCE.md).
- **Cost.** FC bills per invocation + duration; it scales to zero. At demo scale this is small; a slow
  LLM turn is billed as wall-clock, so keep the timeout only as high as needed.
- **Verify streaming vs buffered in the console** for your FC version if you want true SSE; the buffered
  path above avoids the question entirely.

## Alternative — ECS (a plain VM)

If you prefer an always-on server: launch a small ECS instance, run `node demo/serve.mjs --port 80`
behind nginx with TLS, open the security-group port. No cold starts, simplest mental model, more ops.
FC is cheaper at demo scale.
