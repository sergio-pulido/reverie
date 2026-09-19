import { randomUUID } from "node:crypto";
import express, { type Response, type Router } from "express";
import {
  createJamCommandSchema,
  revertJamScriptCommandSchema,
  updatePortionCommandSchema,
  type Jam,
} from "../../src/core/jam";
import { renderScriptMarkdown } from "../../src/core/scriptMarkdown";
import { projectImportedScript, ScriptImportError } from "../../src/core/scriptImport";
import {
  applyPortionPatch,
  appendRevision,
  createInitialHistory,
  currentRevision,
  findRevision,
  PortionLockedError,
  revertToRevision,
  ScriptHistoryError,
  type JamScriptHistory,
  type PortionPatch,
  type ScriptRevision,
} from "../../src/core/scriptHistory";
import type { JamScript } from "../../src/core/script";
import { resolveNebiusConfig, NebiusError } from "./providers/nebius";
import { ScriptwriterError, writeJamScript } from "./scriptwriter";

const MAX_STORED_JAMS = 100;
const MAX_CONCURRENT_GENERATIONS = 2;
const CREATIONS_PER_MINUTE_PER_IP = 5;

// Persistence boundary: the router never owns jam data directly, so a
// Supabase-backed store can replace the in-memory one without route changes.
// Creating a jam creates revision 1 of its structured script; portion edits
// and reverts append to that history, never rewrite it. The store stays
// persistence-only: lock enforcement takes minEditablePortionIndex as a
// parameter (the router wires it from the playback guard), and playback
// semantics live outside — the store only persists the record under CAS.
// Contract: docs/API_CONTRACTS.md "Portion playback, locking, and video
// generation". A Supabase implementation must serialize per-jam mutations
// (updatePortion, revertScriptToRevision, updatePlayback) — e.g. a
// transaction with a row lock on the jam's script row.
export interface JamStore {
  createJam(jam: Jam, options?: { initialMarkdown?: string }): Promise<void>;
  getJam(id: string): Promise<Jam | null>;
  updatePortion(
    jamId: string,
    portionIndex: number,
    patch: PortionPatch,
    minEditablePortionIndex: number,
    options?: RevisionOptions,
  ): Promise<ScriptRevision>;
  revertScriptToRevision(
    jamId: string,
    targetRevision: number,
    minEditablePortionIndex: number,
    options?: RevisionOptions,
  ): Promise<ScriptRevision>;
  getScriptRevision(
    jamId: string,
    revision: number,
  ): Promise<ScriptRevision | null>;
  /** Structured script at a revision — RV-06 reads pinned portion text here. */
  getScriptAtRevision(jamId: string, revision: number): Promise<JamScript | null>;
  getCurrentScriptRevision(jamId: string): Promise<ScriptRevision | null>;
  listScriptRevisions(jamId: string): Promise<ScriptRevision[]>;
}

// The playback guard is synchronous so the router can read it in the same
// critical section (withJamLock) as the mutation it protects — the boundary
// cannot move between check and write. RV-06's playback module provides the
// real guard; the default leaves everything editable until it is wired.
export type PlaybackGuard = (jamId: string) => {
  minEditablePortionIndex: number;
  stateVersion: number;
};

export const openPlaybackGuard: PlaybackGuard = () => ({
  minEditablePortionIndex: 0,
  stateVersion: 0,
});

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

// Per-jam critical section: guard reads and the mutation they protect run
// under the same lock, and RV-06's playback advance must use it too so the
// lock boundary can never move between check and write. In-process only; the
// Supabase store carries this requirement into a transaction.
const jamLockTails = new Map<string, Promise<void>>();

export async function withJamLock<T>(
  jamId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = jamLockTails.get(jamId) ?? Promise.resolve();
  const run = previous.then(work, work);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  jamLockTails.set(jamId, settled);
  void settled.then(() => {
    if (jamLockTails.get(jamId) === settled) jamLockTails.delete(jamId);
  });
  return run;
}

interface JamEntry {
  jam: Jam;
  history: JamScriptHistory;
}

export class InMemoryJamStore implements JamStore {
  private readonly jams = new Map<string, JamEntry>();

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
      script: jam.script,
      createdAt: this.clock().toISOString(),
    });
    this.jams.set(jam.id, { jam, history });
  }

  async getJam(id: string): Promise<Jam | null> {
    return this.jams.get(id)?.jam ?? null;
  }

  async updatePortion(
    jamId: string,
    portionIndex: number,
    patch: PortionPatch,
    minEditablePortionIndex: number,
    options?: RevisionOptions,
  ): Promise<ScriptRevision> {
    const entry = this.requireEntry(jamId);
    if (portionIndex < minEditablePortionIndex) {
      throw new PortionLockedError(
        `Portion ${portionIndex} has played or is locked for generation.`,
        minEditablePortionIndex - 1,
      );
    }
    const script = applyPortionPatch(
      currentRevision(entry.history).script,
      portionIndex,
      patch,
      entry.jam.format,
    );
    entry.history = appendRevision(entry.history, {
      script,
      createdAt: this.clock().toISOString(),
      ...options,
    });
    return currentRevision(entry.history);
  }

  async revertScriptToRevision(
    jamId: string,
    targetRevision: number,
    minEditablePortionIndex: number,
    options?: RevisionOptions,
  ): Promise<ScriptRevision> {
    const entry = this.requireEntry(jamId);
    entry.history = revertToRevision(
      entry.history,
      targetRevision,
      minEditablePortionIndex,
      {
        createdAt: this.clock().toISOString(),
        ...options,
      },
    );
    return currentRevision(entry.history);
  }

  async getScriptRevision(
    jamId: string,
    revision: number,
  ): Promise<ScriptRevision | null> {
    const entry = this.jams.get(jamId);
    return entry ? (findRevision(entry.history, revision) ?? null) : null;
  }

  async getScriptAtRevision(
    jamId: string,
    revision: number,
  ): Promise<JamScript | null> {
    return (await this.getScriptRevision(jamId, revision))?.script ?? null;
  }

  async getCurrentScriptRevision(jamId: string): Promise<ScriptRevision | null> {
    const entry = this.jams.get(jamId);
    return entry ? currentRevision(entry.history) : null;
  }

  async listScriptRevisions(jamId: string): Promise<ScriptRevision[]> {
    return this.jams.get(jamId)?.history.revisions ?? [];
  }

  private requireEntry(jamId: string): JamEntry {
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

export function createJamsRouter(
  store: JamStore = new InMemoryJamStore(),
  guard: PlaybackGuard = openPlaybackGuard,
): Router {
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

  // The live document is the current revision's script rendered to markdown;
  // the structured script is the source of truth, markdown only a view.
  router.get("/api/jams/:id/script.md", async (request, response) => {
    const [jam, current] = await Promise.all([
      store.getJam(request.params.id),
      store.getCurrentScriptRevision(request.params.id),
    ]);
    if (!jam || !current) {
      sendError(response, 404, "not_found", "This jam does not exist on this server.", false);
      return;
    }
    response
      .type("text/markdown; charset=utf-8")
      .send(renderScriptMarkdown(current.script, jam.source));
  });

  // Live edits are portion-scoped; the guard is read inside the same per-jam
  // critical section as the mutation so the lock boundary cannot move
  // between check and write.
  router.patch(
    "/api/jams/:id/script/portions/:portionIndex",
    async (request, response) => {
      const portionIndex = Number(request.params.portionIndex);
      if (!Number.isInteger(portionIndex) || portionIndex < 0) {
        sendError(response, 400, "invalid_command", "The portion index is not valid.", false);
        return;
      }
      const command = updatePortionCommandSchema.safeParse(request.body);
      if (!command.success) {
        sendError(response, 400, "invalid_command", "The portion update is not valid.", false);
        return;
      }
      try {
        const revision = await withJamLock(request.params.id, async () => {
          const boundary = guard(request.params.id);
          try {
            return await store.updatePortion(
              request.params.id,
              portionIndex,
              command.data,
              boundary.minEditablePortionIndex,
            );
          } catch (error) {
            throw attachStateVersion(error, boundary.stateVersion);
          }
        });
        response.json({ revision: revision });
      } catch (error) {
        if (!handleStoreError(response, error)) throw error;
      }
    },
  );

  router.post("/api/jams/:id/script/revert", async (request, response) => {
    const command = revertJamScriptCommandSchema.safeParse(request.body);
    if (!command.success) {
      sendError(response, 400, "invalid_command", "The revert request is not valid.", false);
      return;
    }
    try {
      const revision = await withJamLock(request.params.id, async () => {
        const boundary = guard(request.params.id);
        try {
          return await store.revertScriptToRevision(
            request.params.id,
            command.data.revision,
            boundary.minEditablePortionIndex,
          );
        } catch (error) {
          throw attachStateVersion(error, boundary.stateVersion);
        }
      });
      response.json({ revision: revision });
    } catch (error) {
      if (!handleStoreError(response, error)) throw error;
    }
  });

  // Metadata only: full structured snapshots are fetched one at a time.
  router.get("/api/jams/:id/script/revisions", async (request, response) => {
    const jam = await store.getJam(request.params.id);
    if (!jam) {
      sendError(response, 404, "not_found", "This jam does not exist on this server.", false);
      return;
    }
    const revisions = (await store.listScriptRevisions(request.params.id)).map(
      ({ script, ...meta }) => meta,
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
      const [jam, revision] = await Promise.all([
        store.getJam(request.params.id),
        store.getScriptRevision(request.params.id, revisionNumber),
      ]);
      if (!jam || !revision) {
        sendError(response, 404, "not_found", "This revision does not exist.", false);
        return;
      }
      response.json({
        revision: {
          ...revision,
          markdown: renderScriptMarkdown(revision.script, jam.source),
        },
      });
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

/** Marks a PortionLockedError with the guard's stateVersion for the reply. */
function attachStateVersion(error: unknown, stateVersion: number): unknown {
  if (error instanceof PortionLockedError) {
    (error as PortionLockedError & { stateVersion?: number }).stateVersion =
      stateVersion;
  }
  return error;
}

/** Maps store/history errors to safe responses; returns false if unhandled. */
function handleStoreError(response: Response, error: unknown): boolean {
  if (error instanceof PortionLockedError) {
    response.status(409).json({
      error: {
        code: "portion_locked",
        safeMessage: error.message,
        retryable: false,
        lockedIndex: error.lockedIndex,
        stateVersion:
          (error as PortionLockedError & { stateVersion?: number })
            .stateVersion ?? 0,
      },
    });
    return true;
  }
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
