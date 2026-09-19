import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Request, type Router } from "express";
import type { JamStore } from "./jams";
import { sendError } from "./jams";
import { renderScriptMarkdown } from "../../src/core/scriptMarkdown";
import {
  createSessionCommandSchema,
  updateSessionCommandSchema,
  type JamSession,
} from "../../src/core/session";

const MAX_SESSIONS_PER_JAM = 32;
const MAX_STORED_SESSIONS = 500;

// A stored session pairs the public session with the secret its owner got at
// creation time. The token authorizes changes and is never listed or logged.
export type StoredSession = {
  session: JamSession;
  ownerToken: string;
};

// Persistence boundary, mirroring JamStore: a Supabase-backed store (with
// auth.users ownership instead of bearer tokens) can replace this one
// without route changes.
export interface SessionStore {
  createSession(stored: StoredSession): Promise<void>;
  getSession(id: string): Promise<StoredSession | null>;
  updateSession(session: JamSession): Promise<void>;
  listSessionsForJam(jamId: string): Promise<JamSession[]>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, StoredSession>();

  async createSession(stored: StoredSession): Promise<void> {
    if (this.sessions.size >= MAX_STORED_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    this.sessions.set(stored.session.id, stored);
  }

  async getSession(id: string): Promise<StoredSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async updateSession(session: JamSession): Promise<void> {
    const stored = this.sessions.get(session.id);
    if (stored) this.sessions.set(session.id, { ...stored, session });
  }

  async listSessionsForJam(jamId: string): Promise<JamSession[]> {
    return [...this.sessions.values()]
      .map((stored) => stored.session)
      .filter((session) => session.jamId === jamId);
  }
}

export function createSessionsRouter(
  jams: JamStore,
  sessions: SessionStore = new InMemorySessionStore(),
): Router {
  const router = express.Router();

  router.use(express.json({ limit: "16kb" }));

  router.post("/api/jams/:id/sessions", async (request, response) => {
    const jam = await jams.getJam(request.params.id);
    if (!jam) {
      sendError(response, 404, "not_found", "This jam does not exist on this server.", false);
      return;
    }

    const command = createSessionCommandSchema.safeParse(request.body);
    if (!command.success) {
      sendError(response, 400, "invalid_command", "The session request is not valid.", false);
      return;
    }

    const existing = await sessions.listSessionsForJam(jam.id);
    if (existing.length >= MAX_SESSIONS_PER_JAM) {
      sendError(response, 409, "session_limit", "This jam already has its maximum number of sessions.", false);
      return;
    }

    const now = new Date().toISOString();
    const session: JamSession = {
      id: randomUUID(),
      jamId: jam.id,
      owner: { id: randomUUID(), displayName: command.data.displayName },
      settings: command.data.settings,
      createdAt: now,
      updatedAt: now,
    };
    const ownerToken = randomUUID();
    await sessions.createSession({ session, ownerToken });
    response.status(201).json({ session, ownerToken });
  });

  router.get("/api/jams/:id/sessions", async (request, response) => {
    const jam = await jams.getJam(request.params.id);
    if (!jam) {
      sendError(response, 404, "not_found", "This jam does not exist on this server.", false);
      return;
    }
    response.json({ sessions: await sessions.listSessionsForJam(jam.id) });
  });

  router.get("/api/sessions/:id", async (request, response) => {
    const stored = await sessions.getSession(request.params.id);
    if (!stored) {
      sendError(response, 404, "not_found", "This session does not exist on this server.", false);
      return;
    }
    response.json({ session: stored.session });
  });

  router.patch("/api/sessions/:id", async (request, response) => {
    const stored = await sessions.getSession(request.params.id);
    if (!stored) {
      sendError(response, 404, "not_found", "This session does not exist on this server.", false);
      return;
    }
    if (!isOwner(request, stored.ownerToken)) {
      sendError(response, 403, "not_owner", "Only the session owner can change its settings.", false);
      return;
    }

    const command = updateSessionCommandSchema.safeParse(request.body);
    if (!command.success) {
      sendError(response, 400, "invalid_command", "The session update is not valid.", false);
      return;
    }

    const session: JamSession = {
      ...stored.session,
      settings: { ...stored.session.settings, ...command.data.settings },
      updatedAt: new Date().toISOString(),
    };
    await sessions.updateSession(session);
    response.json({ session });
  });

  router.get("/api/sessions/:id/script.md", async (request, response) => {
    const stored = await sessions.getSession(request.params.id);
    if (!stored) {
      sendError(response, 404, "not_found", "This session does not exist on this server.", false);
      return;
    }
    const jam = await jams.getJam(stored.session.jamId);
    if (!jam) {
      sendError(response, 404, "not_found", "The jam behind this session is gone from this server.", false);
      return;
    }
    response
      .type("text/markdown; charset=utf-8")
      .send(renderScriptMarkdown(jam.script, jam.source, stored.session));
  });

  return router;
}

function isOwner(request: Request, ownerToken: string): boolean {
  const header = request.headers.authorization;
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!presented) return false;
  const expected = Buffer.from(ownerToken);
  const received = Buffer.from(presented);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
