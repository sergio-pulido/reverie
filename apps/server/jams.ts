import { randomUUID } from "node:crypto";
import express, { type Response, type Router } from "express";
import { createJamCommandSchema, type Jam } from "../../src/core/jam";
import { renderScriptMarkdown } from "../../src/core/scriptMarkdown";
import { resolveNebiusConfig, NebiusError } from "./providers/nebius";
import { ScriptwriterError, writeJamScript } from "./scriptwriter";

const MAX_STORED_JAMS = 100;
const MAX_CONCURRENT_GENERATIONS = 2;
const CREATIONS_PER_MINUTE_PER_IP = 5;

// Persistence boundary: the router never owns jam data directly, so a
// Supabase-backed store can replace the in-memory one without route changes.
export interface JamStore {
  createJam(jam: Jam): Promise<void>;
  getJam(id: string): Promise<Jam | null>;
}

export class InMemoryJamStore implements JamStore {
  private readonly jams = new Map<string, Jam>();

  async createJam(jam: Jam): Promise<void> {
    if (this.jams.size >= MAX_STORED_JAMS) {
      const oldest = this.jams.keys().next().value;
      if (oldest) this.jams.delete(oldest);
    }
    this.jams.set(jam.id, jam);
  }

  async getJam(id: string): Promise<Jam | null> {
    return this.jams.get(id) ?? null;
  }
}

export function createJamsRouter(store: JamStore = new InMemoryJamStore()): Router {
  const router = express.Router();
  const recentCreationsByIp = new Map<string, number[]>();
  let activeGenerations = 0;

  router.use(express.json({ limit: "32kb" }));

  router.post("/api/jams", async (request, response) => {
    if (!allowCreation(recentCreationsByIp, request.ip ?? "unknown")) {
      sendError(response, 429, "rate_limited", "Too many jams created; wait a minute.", true);
      return;
    }

    const command = createJamCommandSchema.safeParse(request.body);
    if (!command.success) {
      sendError(response, 400, "invalid_command", "The jam request is not valid.", false);
      return;
    }

    let config;
    try {
      config = resolveNebiusConfig(process.env);
    } catch (error) {
      if (error instanceof NebiusError) {
        sendError(response, 503, "provider_misconfigured", error.message, false);
        return;
      }
      throw error;
    }
    if (!config) {
      sendError(
        response,
        503,
        "generation_disabled",
        "Script generation is disabled: live providers are not configured on this server.",
        false,
      );
      return;
    }

    if (activeGenerations >= MAX_CONCURRENT_GENERATIONS) {
      sendError(response, 503, "busy", "The studio is busy; try again shortly.", true);
      return;
    }

    activeGenerations += 1;
    try {
      const script = await writeJamScript(config, command.data.source, command.data.format);
      const jam: Jam = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        source: command.data.source,
        format: command.data.format,
        script,
      };
      await store.createJam(jam);
      response.status(201).json({ jam, scriptMarkdown: renderScriptMarkdown(script, jam.source) });
    } catch (error) {
      if (error instanceof ScriptwriterError) {
        sendError(response, 502, "generation_failed", error.message, error.retryable);
        return;
      }
      throw error;
    } finally {
      activeGenerations -= 1;
    }
  });

  router.get("/api/jams/:id", async (request, response) => {
    const jam = await store.getJam(request.params.id);
    if (!jam) {
      sendError(response, 404, "not_found", "This jam does not exist on this server.", false);
      return;
    }
    response.json({ jam });
  });

  router.get("/api/jams/:id/script.md", async (request, response) => {
    const jam = await store.getJam(request.params.id);
    if (!jam) {
      sendError(response, 404, "not_found", "This jam does not exist on this server.", false);
      return;
    }
    response
      .type("text/markdown; charset=utf-8")
      .send(renderScriptMarkdown(jam.script, jam.source));
  });

  return router;
}

function allowCreation(byIp: Map<string, number[]>, ip: string): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const recent = (byIp.get(ip) ?? []).filter((at) => at > windowStart);
  if (recent.length >= CREATIONS_PER_MINUTE_PER_IP) {
    byIp.set(ip, recent);
    return false;
  }
  recent.push(now);
  byIp.set(ip, recent);
  if (byIp.size > 1000) byIp.clear();
  return true;
}

export function sendError(
  response: Response,
  status: number,
  code: string,
  safeMessage: string,
  retryable: boolean,
): void {
  response.status(status).json({ error: { code, safeMessage, retryable } });
}
