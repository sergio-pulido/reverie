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
import {
  openBeats,
  outlineDirectionCommandSchema,
  type DirectionTarget,
} from "../../src/core/outlineDirection";
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
import { OutlineWriterError, runCascade, runTargeting } from "./outlineWriter";

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

/**
 * Chooses which of the beats that can still change a free-text direction is
 * about, and what that beat now reads. Injected in tests; the default calls
 * the provider.
 */
/**
 * The slice of a live stream the queue needs: which jam it is, and how to put
 * a new story in the provider's hands.
 */
export interface OutlineStream {
  readonly jamId: string;
  updateScript(script: JamScript): { accepted: boolean; promptVersion?: number };
}

export type TargetingRunner = (
  script: JamScript,
  direction: string,
  candidates: readonly Beat[],
) => Promise<DirectionTarget>;

export interface OutlineRouterOptions {
  /**
   * How a cascade is computed. `undefined` resolves the provider per request
   * from the environment; `null` means no provider, so every edit is refused
   * with `generation_disabled` rather than fabricated.
   */
  cascade?: CascadeRunner | null;
  /**
   * How a direction is aimed at a beat. `undefined` resolves the provider per
   * request from the environment; `null` means no provider, so a direction is
   * refused rather than aimed at the opening beat by default.
   */
  target?: TargetingRunner | null;
  /** The strictest open stream's window, for the panel. Defaults to nothing locked. */
  window?: (jamId: string) => DirectorBeatWindow;
  /** The jam's open streams, so a landed revision reaches the take that is running. */
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

  /**
   * Queues an admitted command and starts the jam's worker if it is idle.
   *
   * `provenance` is how an edit that nobody wrote by hand still says where it
   * came from: a free-text direction carries the room's own words and the
   * reason its beat was chosen. Audit only — the queue never reads it.
   */
  admit(
    jamId: string,
    command: OutlineEditCommand,
    provenance: { said?: string; chosenBecause?: string } = {},
  ): OutlineEditRecord {
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
      ...(provenance.said ? { said: provenance.said } : {}),
      ...(provenance.chosenBecause ? { chosenBecause: provenance.chosenBecause } : {}),
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
        record.streamsUpdated = this.deliver(record.jamId, landed.script);
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
   * Puts the landed revision in the provider's hands, for every take running
   * on this jam.
   *
   * The WHOLE script goes, not the edited beat. A beat on its own was the old
   * shape and it does not work: fal is given a script at `configure` and plans
   * from it, so a single beat sent as a steering prompt changes what it makes
   * NEXT rather than what it makes at that beat's offset — and a beat appended
   * to the script stopped the stream outright. Replacing the script is the one
   * verb that means "the story is now this".
   *
   * Best-effort on top of a commit that already stands: a stream that cannot
   * take it is counted out, never thrown, and with no take running there is
   * nothing to do and nothing wrong.
   */
  private deliver(jamId: string, script: JamScript): number {
    let updated = 0;
    for (const stream of this.streamsFor(jamId)) {
      try {
        if (stream.updateScript(script).accepted) updated += 1;
      } catch {
        // A stream that throws is a stream that did not take it.
      }
    }
    return updated;
  }

  private fail(record: OutlineEditRecord, error: OutlineEditError): void {
    record.status = "failed";
    record.error = error;
    record.finishedAt = this.now().toISOString();
  }
}

function lockedError(minEditablePortionIndex: number): OutlineEditError {
  return {
    code: "portion_locked",
    safeMessage: `Beats up to ${minEditablePortionIndex} have played or are being generated; only later beats can still change.`,
    retryable: false,
  };
}

/**
 * The aim a record carries, so a replayed direction answers the same question
 * the first request did rather than making the caller reconstruct it.
 */
function targetOf(record: OutlineEditRecord): DirectionTarget | null {
  if (record.intent !== "set" || !record.summary) return null;
  return {
    beatIndex: record.beatIndex,
    summary: record.summary,
    ...(record.chosenBecause ? { reason: record.chosenBecause } : {}),
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

  function resolveTargeting(): TargetingRunner | null {
    if (options.target !== undefined) return options.target;
    try {
      const config = resolveNebiusConfig(process.env);
      return config
        ? (script, direction, candidates) => runTargeting(config, script, direction, candidates)
        : null;
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
    // This is answered BEFORE every refusal below. A replay performs nothing,
    // so the state it would be refused for is irrelevant to it: a retried
    // fetch or a reconnect must still be told what its edit did, not that it
    // is too late. Refusing a replay is exactly the non-idempotency the
    // envelope exists to prevent.
    const replay = queue.find(jamId, command.data.requestId);
    if (replay) {
      response.status(200).json({ edit: replay });
      return;
    }
    // A room between takes still takes story edits. Stopping the stream ends
    // the take, not the room — the next press of play reads whatever the
    // outline says by then — so there is no state here in which the room is
    // finished with its story.
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

  /**
   * One free-text direction, aimed at the beat it is about.
   *
   * This is the Director composer's path, and the difference from
   * `/outline/edits` is only where the beat number comes from: there a person
   * names it, here a model chooses it from the beats that can still change.
   * Everything after the choice is identical — the same queue, the same
   * cascade, the same commit, the same delivery to the open streams — because
   * a direction that is not an ordinary edit by the time it lands would be a
   * second way for the story to change, and there is only one.
   *
   * The choice is made here rather than in the worker so the room is told what
   * its words were aimed at in the answer to its own request. The worker
   * re-reads the lock boundary at the front of the queue either way, so a beat
   * that closes while the edit waits fails visibly rather than rewriting
   * something the provider already has.
   */
  router.post("/api/jams/:id/outline/directions", async (request, response) => {
    const jamId = request.params.id;
    const command = outlineDirectionCommandSchema.safeParse(request.body);
    if (!command.success) {
      sendError(response, 400, "invalid_command", "That direction is not valid.", false);
      return;
    }
    const current = await store.getCurrentScriptRevision(jamId);
    if (!current) {
      sendError(response, 404, "not_found", "This jam has no script on this server.", false);
      return;
    }
    // A replay is answered before any refusal, for the reason the edit route
    // states: a retried request performs nothing, so the state it would now be
    // refused for is not its business.
    const replay = queue.find(jamId, command.data.requestId);
    if (replay) {
      response.status(200).json({ edit: replay, target: targetOf(replay) });
      return;
    }
    const aim = resolveTargeting();
    if (!aim || !resolveCascade()) {
      sendError(
        response,
        503,
        "generation_disabled",
        "Directions are disabled: live providers are not configured on this server.",
        false,
      );
      return;
    }
    const aimed = command.data.beatIndex;
    if (aimed !== undefined && aimed >= portionCount(current.script)) {
      sendError(response, 400, "invalid_command", "That beat does not exist in the current script.", false);
      return;
    }
    const boundary = guard(jamId);
    const open = openBeats(current.script, boundary.minEditablePortionIndex);
    // A room that aimed at a beat keeps its aim: the model is then only being
    // asked what that beat should now read, not where the words belong.
    const candidates = aimed === undefined ? open : open.filter((beat) => beat.portionIndex === aimed);
    if (candidates.length === 0) {
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
          safeMessage: `The outline has moved on to revision ${current.revision}; read it again before directing it.`,
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

    let target: DirectionTarget;
    try {
      target = await aim(current.script, command.data.body, candidates);
    } catch (error) {
      const failure = cascadeError(error);
      // Nothing is queued when the beat could not be chosen. Aiming at the
      // opening beat instead is exactly the behaviour this route replaces.
      sendError(response, 502, failure.code, failure.safeMessage, failure.retryable);
      return;
    }

    const record = queue.admit(
      jamId,
      {
        intent: "set",
        beatIndex: target.beatIndex,
        summary: target.summary,
        requestId: command.data.requestId,
        mechanism: "direction",
        ...(command.data.authorId ? { authorId: command.data.authorId } : {}),
      },
      { said: command.data.body, ...(target.reason ? { chosenBecause: target.reason } : {}) },
    );
    response.status(202).json({ edit: record, target });
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
