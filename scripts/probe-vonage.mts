// Bounded live probe of the Vonage Video session/token cycle.
//
//   REVERIE_LIVE_ENABLED=true VONAGE_APPLICATION_ID=... VONAGE_PRIVATE_KEY=... \
//     node --import tsx scripts/probe-vonage.mts
//
// A legacy project deployment sets VONAGE_API_KEY (numeric) and VONAGE_API_SECRET instead.
//
// It creates one session through the real REST API and mints one connection token with the
// same adapter the API route uses. It prints status, latency and shape only: no session id,
// no token, no credential. Nothing is archived, broadcast or transformed.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createVideoSession,
  mintConnectionToken,
  readVonageAuth,
  LiveMediaError,
} from "../api/_lib/vonage-video.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(root, ".env.local"));
} catch {
  // Environment variables may be supplied directly.
}

const auth = readVonageAuth();
if (!auth) {
  console.error(
    "No usable Vonage Video credentials. Set REVERIE_LIVE_ENABLED=true plus either " +
      "VONAGE_APPLICATION_ID and VONAGE_PRIVATE_KEY, or a numeric VONAGE_API_KEY and " +
      "VONAGE_API_SECRET. An account-level API key cannot create a video session.",
  );
  process.exit(2);
}
console.log(`credential mode: ${auth.mode}`);

const started = Date.now();
try {
  const sessionId = await createVideoSession(auth);
  const elapsed = Date.now() - started;
  console.log(`PASS session/create — ${elapsed}ms, session id ${sessionId.length} chars`);

  const publisher = mintConnectionToken(auth, { sessionId, role: "publisher" });
  const claims = JSON.parse(Buffer.from(publisher.token.split(".")[1], "base64url").toString());
  const ttl = claims.exp - claims.iat;
  console.log(`PASS token/publisher — scope ${claims.scope}, role ${claims.role}, ttl ${ttl}s, expires ${publisher.expiresAt}`);
  console.log(`PASS token binds the session — ${claims.session_id === sessionId}`);
} catch (error) {
  if (error instanceof LiveMediaError) {
    console.error(`FAIL ${error.code}: ${error.safeMessage}`);
    process.exit(1);
  }
  throw error;
}
