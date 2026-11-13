// Chain-less server for the social features only (tests, e2e, local play): no keys, no RPC.
//   PORT=8790 node --import ./src/ts-resolve.ts src/social-server.ts
// Account ownership can't be checked without an RPC here, so every signed claim is treated as
// unverified unless SOCIAL_RPC is set. The real relayer (server.ts) wires the same handlers with
// its KeyOwners.
import http from "node:http";
import path from "node:path";
import { createSocial, writeReply } from "./social-http.ts";
import { KeyOwners } from "./verify.ts";

const PORT = Number(process.env.PORT ?? 8790);
const origins = (process.env.CORS_ORIGINS ?? "http://127.0.0.1:5192,http://localhost:5192").split(",");
const owners = process.env.SOCIAL_RPC ? new KeyOwners(process.env.SOCIAL_RPC) : null;
const social = createSocial({
  dataDir: process.env.SOCIAL_DATA ?? path.join(import.meta.dirname, "../data"),
  allowedOrigins: origins,
  publicUrl: process.env.PUBLIC_URL,
  gameUrl: process.env.GAME_URL,
  guestParent: process.env.RELAYER_ACCOUNT_ID,
  verifyOwner: async (a, k) => (owners ? owners.owns(a, k) : false),
  realtimeFactor: process.env.SOCIAL_REALTIME === undefined ? undefined : Number(process.env.SOCIAL_REALTIME),
});
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.method === "OPTIONS") {
    const h: Record<string, string> = { "access-control-allow-methods": "POST, GET", "access-control-allow-headers": "content-type", "access-control-max-age": "600" };
    if (origin && origins.includes(origin)) h["access-control-allow-origin"] = origin;
    res.writeHead(204, h);
    return res.end();
  }
  if (req.method === "GET" && req.url === "/api/health") return writeReply(res, { code: 200, json: { ok: true, social: true } }, origin, origins);
  const r = await social.handle(req, req.socket.remoteAddress ?? "?");
  writeReply(res, r ?? { code: 404, json: { error: "not found" } }, origin, origins);
});
server.listen(PORT, () => console.log(`social server on :${PORT}`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
