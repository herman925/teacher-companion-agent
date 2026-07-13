# Tencent CloudBase Run (云托管) container for the demo proxy + static UI.
# docs/DEPLOY.md Option C: CloudBase Run injects PORT; serve.mjs honours it
# and binds 0.0.0.0. Model keys arrive per-request from the UI, or seed them
# as service environment variables (GLM_API_KEY etc.) — never in this image.
FROM node:20-slim

WORKDIR /app

# The demo server is zero-dependency (Node stdlib only) — no npm install.
# demo/ is the app; harness/schema/ is static-served for the debug drawer.
COPY demo/ demo/
COPY harness/schema/ harness/schema/
COPY package.json ./

EXPOSE 8787
CMD ["node", "demo/serve.mjs"]
