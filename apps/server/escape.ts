import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";
import { sendError } from "./jams";
import {
  createSupabaseAuthorize,
  EscapeAuthError,
  requireHost,
  type Authorize,
  type EscapeCaller,
} from "./escapeAuth";
import { EscapeRooms, type EscapeRoomsOptions } from "./escapeSessions";
import { resolveEscapeMediaStore, type EscapeMediaStore } from "./escapeMedia";
import { scenarioCards } from "../../src/core/escape/scenarios";

/**
 * The escape room's HTTP surface.
 *
 * An escape room is a Movie Jam with a fixed world and a goal: it reuses the
 * jam wholesale for the invite code, the QR, the lobby, admission and the
 * roster, and adds exactly this — the scenario's state, the turn the room is
 * on, and the segments generated from them. It is a configuration of the jam
 * screen, not a second product.
 *
 * Unlike the other routes on this Express host, these check who is calling.
 * They move a world the whole room can see and they call paid providers, so
 * identity comes from Supabase Auth and the role from the caller's own
 * membership row under RLS (./escapeAuth), never from the request body.
 */

// Strict, like `POST /api/live/token`: an unknown field is rejected rather
// than dropped. A browser that believes it set the author of a proposal must
// be told it did not, not quietly overruled.
const openSchema = z.strictObject({ scenarioId: z.string().trim().min(2).max(48) });

const proposalSchema = z.strictObject({
  // The same 280 characters `jam_proposals` already enforces on a proposal.
  body: z.string().trim().min(1).max(280),
  authorName: z.string().trim().min(1).max(32).default("Someone"),
});

const voteSchema = z.strictObject({ proposalId: z.uuid() });

/**
 * Ids out of the path, checked before anything reads them.
 *
 * A jam id does not stay in this process: it is interpolated into the
 * PostgREST query that reads the caller's membership. An id carrying `&`
 * would add filters to that query, which is a query this server must be able
 * to trust. Every id these routes mint or accept is a v4 UUID, so requiring
 * one costs nothing and closes it. A media id goes on to address an object
 * key, and is checked in the same breath.
 */
const idSchema = z.uuid();

export interface EscapeRouterOptions extends Partial<EscapeRoomsOptions> {
  media?: EscapeMediaStore;
  authorize?: Authorize;
  rooms?: EscapeRooms;
}

export function createEscapeRouter(options: EscapeRouterOptions = {}): Router {
  const router = express.Router();
  const media = options.media ?? resolveEscapeMediaStore();
  const rooms = options.rooms ?? new EscapeRooms({ ...options, media });
  const authorize = options.authorize ?? createSupabaseAuthorize();

  router.use("/api/jams/:id/escape-room", (request, response, next) => {
    if (!idSchema.safeParse(request.params.id).success) {
      sendError(response, 400, "invalid_command", "That is not a jam id.", false);
      return;
    }
    next();
  });
  router.use("/api/jams/:id/escape-room", express.json({ limit: "8kb" }));
  router.use("/api/escape-room", express.json({ limit: "8kb" }));

  /** The rooms a host can start from. Public: it is this repository's own data. */
  router.get("/api/escape-room/scenarios", (_request, response) => {
    response.json({ scenarios: scenarioCards() });
  });

  router.post("/api/jams/:id/escape-room", (request, response) => {
    void withCaller(request, response, authorize, (caller) => {
      requireHost(caller);
      const command = openSchema.safeParse(request.body);
      if (!command.success) {
        sendError(response, 400, "invalid_command", "That is not a scenario this build ships.", false);
        return;
      }
      const opened = rooms.open(request.params.id, command.data.scenarioId);
      if (typeof opened === "string") {
        sendError(response, refusalStatus(opened), opened, openRefusal(opened), false);
        return;
      }
      response.status(201).json(rooms.snapshot(request.params.id, caller.userId));
    });
  });

  router.get("/api/jams/:id/escape-room", (request, response) => {
    void withCaller(request, response, authorize, (caller) => {
      const snapshot = rooms.snapshot(request.params.id, caller.userId);
      if (!snapshot) {
        sendError(response, 404, "not_open", "This server is not running an escape room for this jam.", false);
        return;
      }
      response.json(snapshot);
    });
  });

  router.post("/api/jams/:id/escape-room/proposals", (request, response) => {
    void withCaller(request, response, authorize, (caller) => {
      const command = proposalSchema.safeParse(request.body);
      if (!command.success) {
        sendError(response, 400, "invalid_command", "That proposal is not valid.", false);
        return;
      }
      const proposed = rooms.propose(request.params.id, {
        authorId: caller.userId,
        authorName: command.data.authorName,
        body: command.data.body,
      });
      if (typeof proposed === "string") {
        sendError(response, refusalStatus(proposed), proposed, proposeRefusal(proposed), false);
        return;
      }
      response.status(201).json({
        proposalId: proposed.id,
        snapshot: rooms.snapshot(request.params.id, caller.userId),
      });
    });
  });

  router.post("/api/jams/:id/escape-room/votes", (request, response) => {
    void withCaller(request, response, authorize, (caller) => {
      const command = voteSchema.safeParse(request.body);
      if (!command.success) {
        sendError(response, 400, "invalid_command", "That vote is not valid.", false);
        return;
      }
      const voted = rooms.vote(request.params.id, caller.userId, command.data.proposalId);
      if (typeof voted === "string") {
        sendError(response, refusalStatus(voted), voted, proposeRefusal(voted), false);
        return;
      }
      if (!voted) {
        sendError(response, 404, "not_found", "That proposal is not on the table this turn.", false);
        return;
      }
      response.json(rooms.snapshot(request.params.id, caller.userId));
    });
  });

  /**
   * Closes the vote. Host-only, because it generates: the winner is resolved and
   * filmed, and the losing proposals are discarded rather than queued.
   */
  router.post("/api/jams/:id/escape-room/settle", (request, response) => {
    void withCaller(request, response, authorize, (caller) => {
      requireHost(caller);
      const settled = rooms.settle(request.params.id);
      if (typeof settled === "string") {
        sendError(response, refusalStatus(settled), settled, settleRefusal(settled), false);
        return;
      }
      response.json({
        beatId: settled.id,
        snapshot: rooms.snapshot(request.params.id, caller.userId),
      });
    });
  });

  /** A generated segment, served from this server's own storage. */
  router.get("/api/jams/:id/escape-room/segments/:mediaId", (request, response) => {
    void withCaller(request, response, authorize, async () => {
      if (!idSchema.safeParse(request.params.mediaId).success) {
        sendError(response, 404, "not_found", "There is no such segment.", false);
        return;
      }
      let segment;
      try {
        segment = await rooms.segmentBytes(request.params.id, request.params.mediaId);
      } catch {
        sendError(response, 503, "media_unavailable", "The segment store could not be reached.", true);
        return;
      }
      if (!segment) {
        sendError(response, 404, "not_found", "There is no such segment.", false);
        return;
      }
      response.setHeader("content-type", segment.contentType);
      response.setHeader("content-length", String(segment.bytes.byteLength));
      response.status(200).end(segment.bytes);
    });
  });

  return router;
}

/** Authorizes, then runs the route. Every failure answers in the same shape. */
async function withCaller(
  request: Request,
  response: Response,
  authorize: Authorize,
  work: (caller: EscapeCaller) => void | Promise<void>,
): Promise<void> {
  let caller: EscapeCaller;
  try {
    caller = await authorize(request, request.params.id);
  } catch (error) {
    if (error instanceof EscapeAuthError) {
      sendError(response, error.status, error.code, error.message, error.status >= 500);
      return;
    }
    sendError(response, 503, "escape_unavailable", "Membership could not be checked.", true);
    return;
  }
  try {
    await work(caller);
  } catch (error) {
    if (error instanceof EscapeAuthError) {
      sendError(response, error.status, error.code, error.message, false);
      return;
    }
    throw error;
  }
}

function refusalStatus(refusal: string): number {
  if (refusal === "not_open") return 404;
  if (refusal === "unknown_scenario") return 400;
  return 409;
}

function openRefusal(refusal: string): string {
  if (refusal === "unknown_scenario") return "That is not a scenario this build ships.";
  if (refusal === "already_open") return "This jam already has an escape room running here.";
  return "This server is running as many escape rooms as it can hold.";
}

function proposeRefusal(refusal: string): string {
  if (refusal === "not_open") return "This server is not running an escape room for this jam.";
  if (refusal === "session_over") return "This session has ended.";
  return "This turn already has as many proposals as it can hold.";
}

function settleRefusal(refusal: string): string {
  if (refusal === "not_open") return "This server is not running an escape room for this jam.";
  if (refusal === "session_over") return "This session has ended.";
  return "Nobody has proposed anything this turn.";
}
