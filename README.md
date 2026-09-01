# AutoTrade AI V1 — Deploy Ready

Cloudflare Workers 用の最小構成です。

- `worker.js` : UI + `/api/health` + `/api/market/quotes`
- `wrangler.jsonc` : Worker 設定
- `package.json` : Wrangler 依存関係

静的アセット機能を使わず、UIを Worker 内に同梱しています。
そのため `_worker.js` / `_headers` / `.assetsignore` / `public` フォルダは不要です。

Workers Builds の Deploy command は既定の `npx wrangler deploy` で動作する構成です。
