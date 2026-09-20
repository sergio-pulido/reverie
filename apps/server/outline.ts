import { randomUUID } from "node:crypto";
import express, { type Router } from "express";
import type { DirectorBeatWindow } from "../../src/core/directorBeats";
import { buildOutline, type Beat } from "../../src/core/outline";
import {
  MAX_EDIT_RECORDS_PER_JAM,
  MAX_QUEUED_EDITS_PER_JAM,
  outlineEditCommandSchema,
  type OutlineEditCommand,
  type OutlineEditError,
  type OutlineEditIntent,
  type OutlineEditRecord,
} from "../../src/core/outlineEdit";
import type { JamScript } from "../../src/core/script";
import {
  getPortionAt,
  portionCount,
  PortionLockedError,
  StaleRevisionError,
} from "../../src/core/scriptHistory";
import {
  sendError,
  withJamLock,
  type JamStore,
  type PlaybackGuard,
} from "./jams";
import { resolveNebiusConfig } from "./providers/nebius";
import { OutlineWriterError, runCascade } from "./outlineWriter";

/**
 * The outline edit queue: every way of steering the story lands here as one
 * `set` or `reroll` against one beat, and from here on there is exactly one
 * path — admission, a FIFO per jam, one cascade completion outside the
 * critical section, one all-or-nothing commit inside it, and the edited beat
 * sent to the jam's open streams. See docs/specs/story-outline.md.
 *
 * This queue is correct because it runs in the one container process the
 * live director already requires (docs/DECISIONS.md, 2026-09-20): the lock
 * boundary is read from that process, and so is every edit. Deploying these
 * routes as many serverless instances would serialize nothing, and is not a
 * supported deployment for edits.
 */

/** Rewrites the story from the edited beat on. Injected in tests; the default calls the provider. */
export type CascadeRunner = (script: JamScript, edit: OutlineEditIntent) => Promise<JamScript>;

/** The slice of a live stream the queue needs: which jam, where it is, and one direction. */
export interface OutlineStream {
  readonly jamId: string;
  /** Where this stream stands, so only the beat it is about to render is directed. */
  readonly beats: DirectorBeatWindow;
  direct(request: { body: string; authorId?: string; beatIndex?: number }): {
    accepted: boolean;
    refusal?: string;
  };
}

export interface OutlineRouterOptions {
  /**
   * How a cascade is computed. `undefined` resolves the provider per request
   * from the environment; `null` means no provider, so every edit is refused
   * with `generation_disabled` rather than fabricated.
   */
  cascade?: CascadeRunner | null;
  /** The strictest open stream's window, for the panel. Defaults to nothing locked. */
  window?: (jamId: string) => DirectorBeatWindow;
  /** The jam's open streams, so a landed beat can be sent as direction. */
  streamsFor?: (jamId: string) => OutlineStream[];
  now?: () => Date;
}

export const NOTHING_LOCKED: DirectorBeatWindow = {
  currentBeatIndex: null,
  lockedBeatIndex: null,
  minEditableBeatIndex: 0,
};

/** How many times the worker recomputes a cascade whose base revision moved underneath it. */
const COMMIT_ATTEMPTS = 2;

interface JamQueue {
  records: OutlineEditRecord[];
  draining: boolean;
}

export class OutlineEditQueue {
  private readonly byJam = new Map<string, JamQueue>();

  constructor(
    private readonly store: JamStore,
    private readonly guard: PlaybackGuard,
    private readonly cascade: CascadeRunner,
    private readonly streamsFor: (jamId: string) => OutlineStream[] = () => [],
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The record a `requestId` already produced, whatever state it is in. */
  find(jamId: string, requestId: string): OutlineEditRecord | undefined {
    return this.queue(jamId).records.find((record) => record.requestId === requestId);
  }

  get(jamId: string, editId: string): OutlineEditRecord | undefined {
    return this.queue(jamId).records.find((record) => record.id === editId);
  }

  /** Newest first. */
  list(jamId: string): OutlineEditRecord[] {
    return [...this.queue(jamId).records].reverse();
  }

  pending(jamId: string): number {
    return this.queue(jamId).records.filter(
      (record) => record.status === "queued" || record.status === "processing",
    ).length;
  }

  waiting(jamId: string): number {
    return this.queue(jamId).records.filter((record) => record.status === "queued").length;
  }

  /** Queues an admitted command and starts the jam's worker if it is idle. */
  admit(jamId: string, command: OutlineEditCommand): OutlineEditRecord {
    const queue = this.queue(jamId);
    const record: OutlineEditRecord = {
      id: randomUUID(),
      jamId,
      requestId: command.requestId,
      intent: command.intent,
      beatIndex: command.beatIndex,
      ...(command.intent === "set" ? { summary: command.summary } : {}),
      ...(command.intent === "reroll" && command.reason ? { reason: command.reason } : {}),
      mechanism: command.mechanism,
      ...(command.authorId ? { authorId: command.authorId } : {}),
      status: "queued",
      queuedAt: this.now().toISOString(),
    };
    queue.records.push(record);
    // The ledger is bounded; a record still in flight is never the one dropped.
    while (queue.records.length > MAX_EDIT_RECORDS_PER_JAM) {
      const index = queue.records.findIndex(
        (entry) => entry.status === "landed" || entry.status === "failed",
      );
      if (index < 0) break;
      queue.records.splice(index, 1);
    }
    void this.drain(jamId);
    return record;
  }

  private queue(jamId: string): JamQueue {
    let queue = this.byJam.get(jamId);
    if (!queue) {
      queue = { records: [], draining: false };
      this.byJam.set(jamId, queue);
    }
    return queue;
  }

  /** One worker per jam: edits are applied strictly one after another. */
  private async drain(jamId: string): Promise<void> {
    const queue = this.queue(jamId);
    if (queue.draining) return;
    queue.draining = true;
    try {
      for (;;) {
        const next = queue.records.find((record) => record.status === "queued");
        if (!next) break;
        await this.process(next);
      }
    } finally {
      queue.draining = false;
    }
  }

  private async process(record: OutlineEditRecord): Promise<void> {
    try {
      await this.attempt(record);
    } catch {
      // An unexpected failure must still settle the record: a record left
      // `processing` blocks this jam's queue forever and tells the room
      // nothing about why.
      this.fail(record, {
        code: "generation_failed",
        safeMessage: "The story could not be rewritten.",
        retryable: true,
      });
    }
    if (record.status === "processing") {
      this.fail(record, {
        code: "generation_failed",
        safeMessage: "The story could not be rewritten.",
        retryable: true,
      });
    }
  }

  private async attempt(record: OutlineEditRecord): Promise<void> {
    record.status = "processing";
    record.startedAt = this.now().toISOString();
    const intent: OutlineEditIntent =
      record.intent === "set"
        ? { intent: "set", beatIndex: record.beatIndex, summary: record.summary ?? "" }
        : { intent: "reroll", beatIndex: record.beatIndex, reason: record.reason };

    for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt += 1) {
      const current = await this.store.getCurrentScriptRevision(record.jamId);
      if (!current) {
        this.fail(record, { code: "not_found", safeMessage: "This jam has no script on this server.", retryable: false });
        return;
      }
      // A room can end while an edit waits its turn.
      if ((await this.store.getJam(record.jamId))?.lifecycle === "ended") {
        this.fail(record, ENDED_ERROR);
        return;
      }
      // Re-read at the front of the queue: the beat may have locked while the
      // edit waited, and that must fail visibly rather than rewrite a beat the
      // provider already has.
      const boundary = this.guard(record.jamId).minEditablePortionIndex;
      if (record.beatIndex >= portionCount(current.script)) {
        this.fail(record, { code: "invalid_command", safeMessage: "That beat does not exist in the current script.", retryable: false });
        return;
      }
      if (record.beatIndex < boundary) {
        this.fail(record, lockedError(boundary));
        return;
      }
      record.baseRevision = current.revision;

      let next: JamScript;
      try {
        next = await this.cascade(current.script, intent);
      } catch (error) {
        this.fail(record, cascadeError(error));
        return;
      }

      try {
        const landed = await withJamLock(record.jamId, () => {
          const inside = this.guard(record.jamId).minEditablePortionIndex;
          return this.store.commitScript(record.jamId, next, inside, {
            expectedRevision: current.revision,
            authorId: record.authorId,
            note: `outline ${record.intent} on beat ${record.beatIndex}`.slice(0, 280),
          });
        });
        record.revision = landed.revision;
        record.status = "landed";
        record.finishedAt = this.now().toISOString();
        record.direction = this.deliver(record, landed.script);
        return;
      } catch (error) {
        if (error instanceof StaleRevisionError && attempt < COMMIT_ATTEMPTS) {
          // A direct edit or a revert landed while the cascade was with the
          // provider. Recompute from what is there now, once.
          continue;
        }
        if (error instanceof StaleRevisionError) {
          this.fail(record, { code: "stale_state_version", safeMessage: error.message, retryable: true });
          return;
        }
        if (error instanceof PortionLockedError) {
          this.fail(record, lockedError(error.lockedIndex + 1));
          return;
        }
        throw error;
      }
    }
  }

  /**
   * Sends the edited beat's new phrase to the streams that are about to render
   * it.
   *
   * ONLY to those. A direction is a steering prompt carrying `replan`, not a
   * positional instruction: the provider re-plans what it generates next from
   * whatever it is told. So sending a beat the stream will not reach for
   * another three minutes does not schedule that beat — it makes the stream
   * render it now, out of order. A stream is addressed only when the edited
   * beat is the one it would generate next, which the lock window already
   * names: the two closed beats are the one on screen and the one with the
   * provider, so the first editable beat is exactly the imminent one.
   *
   * The honest consequence, which no code here can fix: a beat edited further
   * ahead does not reach an already-open stream at all. The script went to the
   * provider once, in the `configure` message at session open, and nothing
   * re-sends it. The commit is durable either way; the stream is what misses.
   *
   * Best-effort on top of a commit that already stands: a refusal is recorded
   * and never fails the edit, and with no stream open nothing is wrong.
   */
  private deliver(
    record: OutlineEditRecord,
    script: JamScript,
  ): { sent: number; refused: number; skipped: number } {
    const body = getPortionAt(script, record.beatIndex)?.portion.summary;
    const outcome = { sent: 0, refused: 0, skipped: 0 };
    if (!body) return outcome;
    for (const stream of this.streamsFor(record.jamId)) {
      if (record.beatIndex !== stream.beats.minEditableBeatIndex) {
        outcome.skipped += 1;
        continue;
      }
      let accepted = false;
      try {
        accepted = stream.direct({ body, authorId: record.authorId, beatIndex: record.beatIndex }).accepted;
      } catch {
        accepted = false;
      }
      if (accepted) outcome.sent += 1;
      else outcome.refused += 1;
    }
    return outcome;
  }

  private fail(record: OutlineEditRecord, error: OutlineEditError): void {
    record.status = "failed";
    record.error = error;
    record.finishedAt = this.now().toISOString();
  }
}

/** A finished room keeps the film it made; editing its story afterwards would describe one that was never shot. */
const ENDED_ERROR: OutlineEditError = {
  code: "jam_ended",
  safeMessage: "This jam has ended; its story is what the recording shows.",
  retryable: false,
};

function lockedError(minEditablePortionIndex: number): OutlineEditError {
  return {
    code: "portion_locked",
    safeMessage: `Beats up to ${minEditablePortionIndex} have played or are being generated; only later beats can still change.`,
    retryable: false,
  };
}

function cascadeError(error: unknown): OutlineEditError {
  if (error instanceof OutlineWriterError) {
    return { code: error.code, safeMessage: error.message, retryable: error.retryable };
  }
  return {
    code: "generation_failed",
    safeMessage: "The story could not be rewritten.",
    retryable: true,
  };
}

export interface OutlineBeat extends Beat {
  locked: boolean;
}

export function createOutlineRouter(
  store: JamStore,
  guard: PlaybackGuard,
  options: OutlineRouterOptions = {},
): Router {
  const router = express.Router();
  const window = options.window ?? (() => NOTHING_LOCKED);
  const streamsFor = options.streamsFor ?? (() => []);

  // Resolved per request so the process picks up configuration changes the
  // way the jams router does; `null` is an explicit "no provider".
  function resolveCascade(): CascadeRunner | null {
    if (options.cascade !== undefined) return options.cascade;
    try {
      const config = resolveNebiusConfig(process.env);
      return config ? (script, edit) => runCascade(config, script, edit) : null;
    } catch {
      return null;
    }
  }

  const queue = new OutlineEditQueue(
    store,
    guard,
    (script, edit) => {
      const cascade = resolveCascade();
      if (!cascade) {
        throw new OutlineWriterError("Script generation is disabled on this server.", "generation_failed", false);
      }
      return cascade(script, edit);
    },
    streamsFor,
    options.now,
  );

  router.use(express.json({ limit: "32kb" }));

  router.get("/api/jams/:id/outline", async (request, response) => {
    const current = await store.getCurrentScriptRevision(request.params.id);
    if (!current) {
      sendError(response, 404, "not_found", "This jam has no script on this server.", false);
      return;
    }
    const beats = window(request.params.id);
    response.json({
      revision: current.revision,
      script: current.script,
      beats: buildOutline(current.script).map<OutlineBeat>((beat) => ({
        ...beat,
        locked: beat.portionIndex < beats.minEditableBeatIndex,
      })),
      window: beats,
      pending: queue.pending(request.params.id),
    });
  });

  router.post("/api/jams/:id/outline/edits", async (request, response) => {
    const jamId = request.params.id;
    const command = outlineEditCommandSchema.safeParse(request.body);
    if (!command.success) {
      sendError(response, 400, "invalid_command", "The outline edit is not valid.", false);
      return;
    }
    const current = await store.getCurrentScriptRevision(jamId);
    if (!current) {
      sendError(response, 404, "not_found", "This jam has no script on this server.", false);
      return;
    }
    // A replay returns what the first request produced, in whatever state it
    // is now — it never queues the edit twice.
    //
    // This is answered BEFORE every refusal below, including the room having
    // ended. A replay performs nothing, so the state it would be refused for
    // is irrelevant to it: a retried fetch or a reconnect after the room
    // finished must still be told what its edit did, not that it is too late.
    // Refusing a replay is exactly the non-idempotency the envelope exists to
    // prevent.
    const replay = queue.find(jamId, command.data.requestId);
    if (replay) {
      response.status(200).json({ edit: replay });
      return;
    }
    if ((await store.getJam(jamId))?.lifecycle === "ended") {
      sendError(response, 409, ENDED_ERROR.code, ENDED_ERROR.safeMessage, false);
      return;
    }
    if (!resolveCascade()) {
      sendError(
        response,
        503,
        "generation_disabled",
        "Outline edits are disabled: live providers are not configured on this server.",
        false,
      );
      return;
    }
    if (command.data.beatIndex >= portionCount(current.script)) {
      sendError(response, 400, "invalid_command", "That beat does not exist in the current script.", false);
      return;
    }
    const boundary = guard(jamId);
    if (command.data.beatIndex < boundary.minEditablePortionIndex) {
      response.status(409).json({
        error: {
          ...lockedError(boundary.minEditablePortionIndex),
          lockedIndex: boundary.minEditablePortionIndex - 1,
          stateVersion: boundary.stateVersion,
        },
      });
      return;
    }
    if (
      command.data.expectedRevision !== undefined &&
      command.data.expectedRevision !== current.revision
    ) {
      response.status(409).json({
        error: {
          code: "stale_state_version",
          safeMessage: `The outline has moved on to revision ${current.revision}; read it again before editing.`,
          retryable: true,
        },
        revision: current.revision,
      });
      return;
    }
    if (queue.waiting(jamId) >= MAX_QUEUED_EDITS_PER_JAM) {
      sendError(response, 409, "queue_full", "Too many edits are waiting for this jam; try again shortly.", true);
      return;
    }
    const record = queue.admit(jamId, command.data);
    response.status(202).json({ edit: record });
  });

  router.get("/api/jams/:id/outline/edits", async (request, response) => {
    const jam = await store.getJam(request.params.id);
    if (!jam) {
      sendError(response, 404, "not_found", "This jam has no script on this server.", false);
      return;
    }
    response.json({ edits: queue.list(request.params.id) });
  });

  router.get("/api/jams/:id/outline/edits/:editId", (request, response) => {
    const record = queue.get(request.params.id, request.params.editId);
    if (!record) {
      sendError(response, 404, "not_found", "That outline edit does not exist.", false);
      return;
    }
    response.json({ edit: record });
  });

  return router;
}
