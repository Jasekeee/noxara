# Hosting (owner-run; nothing here was executed by Claude)

Two pieces: the **game** (static files, Vercel) and the **match server + relayer** (one Node process, Railway).
Keys never leave Railway's variables screen: you paste them there yourself from `.env.mainnet`.

## Railway — match server + relayer
1. railway.com → New Project → Deploy from GitHub repo → `Jasekeee/noxara` (the repo must be public, or connect GitHub).
2. Settings: root directory = repo root. `railway.json` already sets the build (`npm ci --prefix relayer`), start (`npm start --prefix relayer`) and the health check (`/api/health`).
3. Variables (paste values from your `.env.mainnet`; never commit them):
   | Variable | Value |
   |---|---|
   | `NIXPACKS_NODE_VERSION` | `24` |
   | `NEAR_NETWORK` | `mainnet` |
   | `BR_MAINNET_YES` | `yes` |
   | `GAME_CONTRACT_ID` | `noxara.near` |
   | `RELAYER_ACCOUNT_ID` / `RELAYER_PRIVATE_KEY` | `relay.noxara.near` / from `.env.mainnet` |
   | `SERVER_ACCOUNT_ID` / `SERVER_PRIVATE_KEY` | `relay.noxara.near` / same key (mainnet: the relayer is also the match server) |
   | `GUEST_VIA_CONTRACT` | `1` (guests become `g-<id>.noxara.near`) |
   | `CORS_ORIGINS` | `https://<your-vercel-domain>` |
   | `PUBLIC_URL` / `GAME_URL` | `https://<your-vercel-domain>` |
   | `RECORDS_DIR` | `/data/records` |
   | `TRUST_PROXY` | `1` |
4. Add a Volume mounted at `/data` (match records + daily tournament survive restarts).
5. Settings → Networking → Generate Domain → copy `https://<app>.up.railway.app`. Check `https://<app>.up.railway.app/api/health` shows `mainnet`.

## Vercel — the game
1. vercel.com → Add New Project → import `Jasekeee/noxara`. `vercel.json` sets the build (`npm run build`, output `dist`).
2. Environment variables (Production):
   | Variable | Value |
   |---|---|
   | `VITE_NEAR_NETWORK` | `mainnet` (switches contract/RPC/explorer/wallet to `noxara.near` + mainnet) |
   | `VITE_RELAYER_URL` | `https://<app>.up.railway.app` |
3. Deploy. Then put the Vercel domain into Railway's `CORS_ORIGINS`, `PUBLIC_URL`, `GAME_URL` and redeploy Railway.

Cost: Vercel Hobby $0; Railway ≈ $5/month [assumed]. Teardown: delete both projects; contract teardown per docs/MAINNET.md §4.
