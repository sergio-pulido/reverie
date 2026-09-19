import express, { type Router } from "express";
import { sendError, type JamStore } from "./jams";
import {
  DirectorSessionLedger,
  resolveDirectorLimits,
  type DirectorSessionLimits,
} from "./directorSessions";
import {
  buildConfigureMessage,
  directorOfferSchema,
  DirectorError,
  resolveDirectorConfig,
  startDirectorSession,
  type DirectorConfig,
} from "./providers/falDirector";

/**
 * Brokers MiniMax H3 Max Director sessions.
 *
 * The browser is the WebRTC peer — it has to be, since the video arrives as a
 * media track and only a browser can render one without pulling a native
 * WebRTC stack into this server. This router therefore does the two things a
 * browser must not: it spends FAL_KEY, and it decides whether a session may be
 * opened at all.
 *
 * What it deliberately does NOT do is see individual prompts. Once the peer
 * connection is up, direction travels on a data channel straight to fal. That
 * is a real narrowing of the server-owns-provider-calls rule in AGENTS.md, and
 * it is recorded as such in docs/DECISIONS.md rather than hidden here.
 */

export interface DirectorRouterOptions {
  config?: DirectorConfig | null;
  limits?: DirectorSessionLimits;
  startSession?: typeof startDirectorSession;
  now?: () => number;
}

export function createDirectorRouter(
  store: JamStore,
  options: DirectorRouterOptions = {},
): Router {
  const router = express.Router();
  const startSession = options.startSession ?? startDirectorSession;
  const limits = options.limits ?? resolveDirectorLimits(process.env);
  const ledger = new DirectorSessionLedger(limits, options.now);
  let resolved = false;
  let config: DirectorConfig | null = options.config ?? null;

  function requireConfig(): DirectorConfig | null {
    if (options.config !== undefined) return options.config;
    if (!resolved) {
      config = resolveDirectorConfig(process.env);
      resolved = true;
    }
    return config;
  }

  // 64kb: an SDP offer is far larger than the 8kb the other routers allow.
  router.use(express.json({ limit: "64kb" }));

  router.post("/api/jams/:id/director/session", async (request, response) => {
    const jam = await store.getJam(request.params.id);
    if (!jam) {
      sendError(response, 404, "not_found", "This jam does not exist on this server.", false);
      return;
    }
    const active = requireConfig();
    if (!active) {
      sendError(
        response,
        503,
        "director_disabled",
        "The live director is not configured on this server.",
        false,
      );
      return;
    }
    const offer = directorOfferSchema.safeParse(request.body);
    if (!offer.success) {
      sendError(response, 400, "invalid_command", "The session offer is not valid.", false);
      return;
    }

    const session = ledger.open(jam.id);
    if (typeof session === "string") {
      sendError(response, 409, session, refusalMessage(session), session !== "budget_exhausted");
      return;
    }

    try {
      const answer = await startDirectorSession_(startSession, active, offer.data);
      response.status(201).json({
        sessionId: session.sessionId,
        answer,
        // Built here so the jam's script, not the browser, decides the beats.
        configure: buildConfigureMessage(active, jam.script),
        maxSessionSeconds: limits.maxSessionSeconds,
      });
    } catch (error) {
      // A session that never opened must not keep holding its reservation.
      ledger.close(session.sessionId);
      if (error instanceof DirectorError) {
        sendError(response, 502, "director_unavailable", error.message, error.retryable);
        return;
      }
      throw error;
    }
  });

  router.post("/api/jams/:id/director/session/:sessionId/renew", (request, response) => {
    if (!ledger.renew(request.params.sessionId)) {
      sendError(response, 404, "not_found", "That director session is not open.", false);
      return;
    }
    response.status(204).end();
  });

  router.post("/api/jams/:id/director/session/:sessionId/end", (request, response) => {
    ledger.close(request.params.sessionId);
    // Idempotent on purpose: a client tearing down twice is not an error, and
    // the important thing is that the reservation is released.
    response.status(204).end();
  });

  return router;
}

function startDirectorSession_(
  start: typeof startDirectorSession,
  config: DirectorConfig,
  offer: { sdp: string; type: "offer" },
): Promise<unknown> {
  return start(config, offer);
}

function refusalMessage(refusal: string): string {
  if (refusal === "budget_exhausted") {
    return "The director budget for this server is spent.";
  }
  if (refusal === "already_open") {
    return "This jam already has a director stream open.";
  }
  return "Too many director streams are open right now.";
}
