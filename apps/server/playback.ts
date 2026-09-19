import express, { type Router } from "express";
import { z } from "zod";
import type { Jam } from "../../src/core/jam";
import {
  advancePlayback,
  flattenPortions,
  initialPlayback,
  lockedPortionIndex,
  minEditablePortionIndex,
  startPlayback,
  type FlatPortion,
  type PlaybackState,
} from "../../src/core/playback";
import { sendError, type JamStore } from "./jams";
import { InMemoryPortionMediaStore } from "./media";
import {
  downloadVideo,
  getJobStatus,
  getResultVideoUrl,
  resolveFalConfig,
  submitVideoJob,
  FalError,
  type FalConfig,
} from "./providers/fal";

const MAX_CONCURRENT_VIDEO_GENERATIONS = 1;
const POLL_INTERVAL_MS = 3_000;
const MAX_POLLS_PER_JOB = 200;

export type GenerationJobStatus =
  | "queued"
  | "submitted"
  | "generating"
  | "downloading"
  | "ready"
  | "failed";

export interface GenerationJob {
  jamId: string;
  portionIndex: number;
  pinnedRevision: number;
  status: GenerationJobStatus;
  retryable?: boolean;
}

/** Produces clip bytes for one locked portion. Fal-backed in production;
 * tests inject a fake. */
export interface VideoGenerator {
  generate(job: { prompt: string; durationSeconds: number }): Promise<Buffer>;
}

export function createFalVideoGenerator(config: FalConfig): VideoGenerator {
  return {
    async generate(job) {
      const requestId = await submitVideoJob(config, job);
      for (let poll = 0; poll < MAX_POLLS_PER_JOB; poll += 1) {
        const status = await getJobStatus(config, requestId);
        if (status === "completed") {
          const url = await getResultVideoUrl(config, requestId);
          return downloadVideo(url);
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      throw new FalError("The video provider took too long.", true);
    },
  };
}

/**
 * Owns playback state, the lock boundary guard, and the one-portion-ahead
 * generation pipeline. Playback state is in-memory for the local demo; the
 * agreed JamStore getPlayback/updatePlayback persistence lands with RV-07.
 */
export class PlaybackCoordinator {
  private readonly playback = new Map<string, PlaybackState>();
  private readonly jobs = new Map<string, GenerationJob>();
  private active = 0;
  private readonly pending: Array<() => void> = [];

  constructor(
    readonly media: InMemoryPortionMediaStore,
    private readonly generator: VideoGenerator,
  ) {}

  getState(jamId: string): PlaybackState {
    return this.playback.get(jamId) ?? initialPlayback();
  }

  /** Single-call edit guard for the script router (agreed contract). */
  guard(jamId: string, portionCount: number): {
    minEditablePortionIndex: number;
    stateVersion: number;
  } {
    const state = this.getState(jamId);
    return {
      minEditablePortionIndex: minEditablePortionIndex(state, portionCount),
      stateVersion: state.stateVersion,
    };
  }

  job(jamId: string, portionIndex: number): GenerationJob | null {
    return this.jobs.get(`${jamId}:${portionIndex}`) ?? null;
  }

  setState(jamId: string, state: PlaybackState): void {
    this.playback.set(jamId, state);
  }

  /** Pin the locked portion and enqueue its generation job. */
  enqueue(jam: Jam, flat: FlatPortion, pinnedRevision: number): GenerationJob {
    const key = `${jam.id}:${flat.portionIndex}`;
    const existing = this.jobs.get(key);
    if (existing && existing.status !== "failed") return existing;
    const job: GenerationJob = {
      jamId: jam.id,
      portionIndex: flat.portionIndex,
      pinnedRevision,
      status: "queued",
    };
    this.jobs.set(key, job);
    void this.run(job, jam, flat);
    return job;
  }

  private async run(job: GenerationJob, jam: Jam, flat: FlatPortion): Promise<void> {
    await this.acquireSlot();
    try {
      job.status = "submitted";
      const bytes = await this.generator.generate({
        prompt: buildPortionPrompt(jam, flat),
        durationSeconds: flat.portion.durationSeconds,
      });
      job.status = "downloading";
      this.media.put(jam.id, flat.portionIndex, bytes, "video/mp4");
      job.status = "ready";
    } catch (error) {
      job.status = "failed";
      job.retryable = error instanceof FalError ? error.retryable : true;
    } finally {
      this.releaseSlot();
    }
  }

  private acquireSlot(): Promise<void> {
    if (this.active < MAX_CONCURRENT_VIDEO_GENERATIONS) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.pending.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.active -= 1;
    this.pending.shift()?.();
  }
}

const advanceCommandSchema = z.object({
  expectedStateVersion: z.number().int().min(1),
});

export interface PlaybackRouterOptions {
  coordinator?: PlaybackCoordinator;
  media?: InMemoryPortionMediaStore;
}

export function createPlaybackRouter(
  store: JamStore,
  options: PlaybackRouterOptions = {},
): Router {
  const router = express.Router();
  const media = options.media ?? new InMemoryPortionMediaStore();
  let coordinator = options.coordinator ?? null;

  router.use(express.json({ limit: "8kb" }));

  // Lazily built so FAL_KEY is only read when playback actually starts.
  function requireCoordinator(): PlaybackCoordinator | { error: string } {
    if (coordinator) return coordinator;
    let config;
    try {
      config = resolveFalConfig(process.env);
    } catch (error) {
      if (error instanceof FalError) return { error: error.message };
      throw error;
    }
    if (!config) {
      return {
        error:
          "Video generation is disabled: live providers are not configured on this server.",
      };
    }
    coordinator = new PlaybackCoordinator(media, createFalVideoGenerator(config));
    return coordinator;
  }

  // TODO(RV-07): read the pinned portion via getScriptAtRevision once the
  // structured-script store rework lands; until then the creation-time
  // structure is authoritative (structural edits are forbidden in v1).
  async function lockAndEnqueue(
    active: PlaybackCoordinator,
    jam: Jam,
    portionIndex: number,
  ): Promise<GenerationJob | null> {
    const flat = flattenPortions(jam.script)[portionIndex];
    if (!flat) return null;
    const revision = await store.getCurrentScriptRevision(jam.id);
    return active.enqueue(jam, flat, revision?.revision ?? 1);
  }

  function playbackSnapshot(jam: Jam, active: PlaybackCoordinator | null) {
    const flat = flattenPortions(jam.script);
    const state = active?.getState(jam.id) ?? initialPlayback();
    const locked = lockedPortionIndex(state, flat.length);
    return {
      playback: state,
      lockedPortionIndex: locked,
      minEditablePortionIndex: minEditablePortionIndex(state, flat.length),
      portions: flat.map((portion) => ({
        portionIndex: portion.portionIndex,
        durationSeconds: portion.portion.durationSeconds,
        media: media.has(jam.id, portion.portionIndex)
          ? "ready"
          : (active?.job(jam.id, portion.portionIndex)?.status ?? "none"),
      })),
    };
  }

  router.post("/api/jams/:id/playback/start", async (request, response) => {
    const jam = await store.getJam(request.params.id);
    if (!jam) {
      sendError(response, 404, "not_found", "This jam does not exist on this server.", false);
      return;
    }
    const active = requireCoordinator();
    if ("error" in active) {
      sendError(response, 503, "generation_disabled", active.error, false);
      return;
    }
    const state = active.getState(jam.id);
    if (state.status !== "idle") {
      sendError(response, 409, "invalid_transition", "Playback has already started.", false);
      return;
    }
    // Cursor first, then pin the revision: edits landing before this point
    // are included; later ones cannot touch the locked portion.
    active.setState(jam.id, startPlayback(state));
    await lockAndEnqueue(active, jam, 0);
    response.status(202).json(playbackSnapshot(jam, active));
  });

  router.post("/api/jams/:id/playback/advance", async (request, response) => {
    const jam = await store.getJam(request.params.id);
    if (!jam) {
      sendError(response, 404, "not_found", "This jam does not exist on this server.", false);
      return;
    }
    if (!coordinator) {
      sendError(response, 409, "invalid_transition", "Playback has not started.", false);
      return;
    }
    const command = advanceCommandSchema.safeParse(request.body);
    if (!command.success) {
      sendError(response, 400, "invalid_command", "The advance request is not valid.", false);
      return;
    }
    const flat = flattenPortions(jam.script);
    const state = coordinator.getState(jam.id);
    if (state.status !== "priming" && state.status !== "playing") {
      sendError(response, 409, "invalid_transition", "Playback is not running.", false);
      return;
    }
    if (state.stateVersion !== command.data.expectedStateVersion) {
      sendError(response, 409, "stale_state_version", "Playback moved on; reload its state.", false);
      return;
    }
    const target = lockedPortionIndex(state, flat.length);
    if (target !== null && !media.has(jam.id, target)) {
      sendError(response, 409, "media_not_ready", "The next portion's video is not ready yet.", true);
      return;
    }
    const next = advancePlayback(state, flat.length);
    coordinator.setState(jam.id, next);
    const newlyLocked = lockedPortionIndex(next, flat.length);
    if (newlyLocked !== null) {
      await lockAndEnqueue(coordinator, jam, newlyLocked);
    }
    response.json(playbackSnapshot(jam, coordinator));
  });

  router.get("/api/jams/:id/playback", async (request, response) => {
    const jam = await store.getJam(request.params.id);
    if (!jam) {
      sendError(response, 404, "not_found", "This jam does not exist on this server.", false);
      return;
    }
    response.json(playbackSnapshot(jam, coordinator));
  });

  router.get("/api/jams/:id/portions/:index/video", async (request, response) => {
    const portionIndex = Number(request.params.index);
    if (!Number.isInteger(portionIndex) || portionIndex < 0) {
      sendError(response, 400, "invalid_command", "The portion index is not valid.", false);
      return;
    }
    const clip = media.get(request.params.id, portionIndex);
    if (!clip) {
      sendError(response, 404, "not_found", "This portion has no generated video.", false);
      return;
    }
    serveClip(request.headers.range, clip.bytes, clip.contentType, response);
  });

  return router;
}

/** Minimal single-range support so <video> elements can seek. */
function serveClip(
  rangeHeader: string | undefined,
  bytes: Buffer,
  contentType: string,
  response: express.Response,
): void {
  response.setHeader("accept-ranges", "bytes");
  response.setHeader("content-type", contentType);
  const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === "" && match[2] === "")) {
    response.setHeader("content-length", bytes.byteLength);
    response.end(bytes);
    return;
  }
  const start = match[1] === "" ? bytes.byteLength - Number(match[2]) : Number(match[1]);
  const end = match[1] !== "" && match[2] !== "" ? Number(match[2]) : bytes.byteLength - 1;
  if (start < 0 || start > end || end >= bytes.byteLength) {
    response.setHeader("content-range", `bytes */${bytes.byteLength}`);
    response.status(416).end();
    return;
  }
  response.status(206);
  response.setHeader("content-range", `bytes ${start}-${end}/${bytes.byteLength}`);
  response.setHeader("content-length", end - start + 1);
  response.end(bytes.subarray(start, end + 1));
}

/** Concise text-to-video prompt from the pinned portion's creative fields. */
export function buildPortionPrompt(jam: Jam, flat: FlatPortion): string {
  const parts = [
    `Scene: ${flat.sceneHeading}.`,
    flat.portion.action,
    flat.portion.dialogue ? `Dialogue: ${flat.portion.dialogue}` : null,
    flat.portion.visualDirection ? `Visuals: ${flat.portion.visualDirection}` : null,
    `Part of "${jam.script.title}": ${jam.script.logline}`,
  ];
  return parts.filter(Boolean).join(" ");
}
