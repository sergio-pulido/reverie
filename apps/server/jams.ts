import { randomUUID } from "node:crypto";
import express, { type Response, type Router } from "express";
import {
  createJamCommandSchema,
  revertJamScriptCommandSchema,
  updateJamScriptCommandSchema,
  type Jam,
} from "../../src/core/jam";
import { renderScriptMarkdown } from "../../src/core/scriptMarkdown";
import { projectImportedScript, ScriptImportError } from "../../src/core/scriptImport";
import {
  appendRevision,
  createInitialHistory,
  currentRevision,
  findRevision,
  revertToRevision,
  ScriptHistoryError,
  type JamScriptHistory,
  type ScriptRevision,
} from "../../src/core/scriptHistory";
import { resolveNebiusConfig, NebiusError } from "./providers/nebius";
import { ScriptwriterError, writeJamScript } from "./scriptwriter";

const MAX_STORED_JAMS = 100;
const MAX_CONCURRENT_GENERATIONS = 2;
const CREATIONS_PER_MINUTE_PER_IP = 5;

// Persistence boundary: the router never owns jam data directly, so a
// Supabase-backed store can replace the in-memory one without route changes.
// Creating a jam also creates revision 1 of its script markdown (rendered
// deterministically from the structured script); live edits and undos append
// to that history, never rewrite it.
export interface JamStore {
  createJam(jam: Jam, options?: { initialMarkdown?: string }): Promise<void>;
  getJam(id: string): Promise<Jam | null>;
  appendScriptRevision(
    jamId: string,
    markdown: string,
    options?: RevisionOptions,
  ): Promise<ScriptRevision>;
  revertScriptToRevision(
    jamId: string,
    targetRevision: number,
    options?: RevisionOptions,
  ): Promise<ScriptRevision>;
  getScriptRevision(
    jamId: string,
    revision: number,
  ): Promise<ScriptRevision | null>;
  getCurrentScriptRevision(jamId: string): Promise<ScriptRevision | null>;
  listScriptRevisions(jamId: string): Promise<ScriptRevision[]>;
}

export interface RevisionOptions {
  authorId?: string;
  note?: string;
}

export class JamStoreError extends Error {
  constructor(
    message: string,
    readonly code: "jam_not_found" | "jam_exists",
  ) {
    super(message);
    this.name = "JamStoreError";
  }
}

export class InMemoryJamStore implements JamStore {
  private readonly jams = new Map<string, { jam: Jam; history: JamScriptHistory }>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async createJam(jam: Jam, options?: { initialMarkdown?: string }): Promise<void> {
    if (this.jams.has(jam.id)) {
      throw new JamStoreError("This jam already exists.", "jam_exists");
    }
    if (this.jams.size >= MAX_STORED_JAMS) {
      const oldest = this.jams.keys().next().value;
      if (oldest) this.jams.delete(oldest);
    }
    const history = createInitialHistory(jam.id, {
      markdown: options?.initialMarkdown ?? renderScriptMarkdown(jam.script, jam.source),
      createdAt: this.clock().toISOString(),
    });
    this.jams.set(jam.id, { jam, history });
  }

  async getJam(id: string): Promise<Jam | null> {
    return this.jams.get(id)?.jam ?? null;
  }

  async appendScriptRevision(
    jamId: string,
    markdown: string,
    options?: RevisionOptions,
  ): Promise<ScriptRevision> {
    const entry = this.requireEntry(jamId);
    entry.history = appendRevision(entry.history, {
      markdown,
      createdAt: this.clock().toISOString(),
      ...options,
    });
    return currentRevision(entry.history);
  }

  async revertScriptToRevision(
    jamId: string,
    targetRevision: number,
    options?: RevisionOptions,
  ): Promise<ScriptRevision> {
    const entry = this.requireEntry(jamId);
    entry.history = revertToRevision(entry.history, targetRevision, {
      createdAt: this.clock().toISOString(),
      ...options,
    });
    return currentRevision(entry.history);
  }

  async getScriptRevision(
    jamId: string,
    revision: number,
  ): Promise<ScriptRevision | null> {
    const entry = this.jams.get(jamId);
    return entry ? (findRevision(entry.history, revision) ?? null) : null;
  }

  async getCurrentScriptRevision(jamId: string): Promise<ScriptRevision | null> {
    const entry = this.jams.get(jamId);
    return entry ? currentRevision(entry.history) : null;
  }

  async listScriptRevisions(jamId: string): Promise<ScriptRevision[]> {
    return this.jams.get(jamId)?.history.revisions ?? [];
  }

  private requireEntry(jamId: string): { jam: Jam; history: JamScriptHistory } {
    const entry = this.jams.get(jamId);
    if (!entry) {
      throw new JamStoreError(
        "This jam does not exist on this server.",
        "jam_not_found",
      );
    }
    return entry;
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

    // Importing an existing script is a pure projection: it never calls a live
    // provider and never counts against the generation concurrency gate.
    if (command.data.mode === "import") {
      const data = command.data;
      try {
        const script = projectImportedScript(
          data.source.scriptTitle,
          data.scriptMarkdown,
          data.format,
        );
        const jam: Jam = {
          id: data.jamId ?? randomUUID(),
          createdAt: new Date().toISOString(),
          source: data.source,
          format: data.format,
          script,
        };
        await store.createJam(jam, { initialMarkdown: data.scriptMarkdown });
        response.status(201).json({ jam, scriptMarkdown: data.scriptMarkdown });
      } catch (error) {
        handleCreateError(response, error);
      }
      return;
    }

    let config: ReturnType<typeof resolveNebiusConfig> = null;
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
        id: command.data.jamId ?? randomUUID(),
        createdAt: new Date().toISOString(),
        source: command.data.source,
        format: command.data.format,
        script,
      };
      const scriptMarkdown = renderScriptMarkdown(script, jam.source);
      await store.createJam(jam, { initialMarkdown: scriptMarkdown });
      response.status(201).json({ jam, scriptMarkdown });
    } catch (error) {
      handleCreateError(response, error);
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

  // The live document is the current revision, not a re-render: the room can
  // have edited the markdown past what the structured script generated.
  router.get("/api/jams/:id/script.md", async (request, response) => {
    const current = await store.getCurrentScriptRevision(request.params.id);
    if (!current) {
      sendError(response, 404, "not_found", "This jam does not exist on this server.", false);
      return;
    }
    response.type("text/markdown; charset=utf-8").send(current.markdown);
  });

  router.put("/api/jams/:id/script", async (request, response) => {
    const command = updateJamScriptCommandSchema.safeParse(request.body);
    if (!command.success) {
      sendError(response, 400, "invalid_command", "The script update is not valid.", false);
      return;
    }
    try {
      const revision = await store.appendScriptRevision(
        request.params.id,
        command.data.markdown,
      );
      response.json({ revision });
    } catch (error) {
      if (!handleStoreError(response, error)) throw error;
    }
  });

  router.post("/api/jams/:id/script/revert", async (request, response) => {
    const command = revertJamScriptCommandSchema.safeParse(request.body);
    if (!command.success) {
      sendError(response, 400, "invalid_command", "The revert request is not valid.", false);
      return;
    }
    try {
      const revision = await store.revertScriptToRevision(
        request.params.id,
        command.data.revision,
      );
      response.json({ revision });
    } catch (error) {
      if (!handleStoreError(response, error)) throw error;
    }
  });

  // Metadata only: full markdown snapshots are fetched one revision at a time.
  router.get("/api/jams/:id/script/revisions", async (request, response) => {
    const jam = await store.getJam(request.params.id);
    if (!jam) {
      sendError(response, 404, "not_found", "This jam does not exist on this server.", false);
      return;
    }
    const revisions = (await store.listScriptRevisions(request.params.id)).map(
      ({ markdown, ...meta }) => ({ ...meta, markdownChars: markdown.length }),
    );
    response.json({ revisions });
  });

  router.get(
    "/api/jams/:id/script/revisions/:revision",
    async (request, response) => {
      const revisionNumber = Number(request.params.revision);
      if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
        sendError(response, 400, "invalid_command", "The revision number is not valid.", false);
        return;
      }
      const revision = await store.getScriptRevision(
        request.params.id,
        revisionNumber,
      );
      if (!revision) {
        sendError(response, 404, "not_found", "This revision does not exist.", false);
        return;
      }
      response.json({ revision });
    },
  );

  return router;
}

/** Maps creation errors to safe responses; rethrows anything unrecognized. */
function handleCreateError(response: Response, error: unknown): void {
  if (error instanceof ScriptImportError) {
    sendError(response, 400, "invalid_script_import", error.message, false);
    return;
  }
  if (error instanceof ScriptwriterError) {
    sendError(response, 502, "generation_failed", error.message, error.retryable);
    return;
  }
  if (error instanceof JamStoreError && error.code === "jam_exists") {
    sendError(response, 409, "jam_exists", "A jam with this id already exists.", false);
    return;
  }
  throw error;
}

/** Maps store/history errors to safe responses; returns false if unhandled. */
function handleStoreError(response: Response, error: unknown): boolean {
  if (error instanceof JamStoreError) {
    sendError(
      response,
      error.code === "jam_not_found" ? 404 : 409,
      error.code,
      error.message,
      false,
    );
    return true;
  }
  if (error instanceof ScriptHistoryError) {
    sendError(response, 409, "invalid_revision", error.message, false);
    return true;
  }
  return false;
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
