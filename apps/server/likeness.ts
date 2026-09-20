import express, { type Request, type Response, type Router } from "express";
import {
  authenticate,
  readLiveConsents,
  readMembership,
  readSupabaseConfig,
  RestError,
  type SupabaseConfig,
  type SupabaseRestOptions,
} from "../../api/_lib/supabase-rest";
import { decideLiveAccess, liveConsentSchema, type LiveConsent } from "../../src/core/liveMedia";
import {
  decideFrameAccess,
  decideFrameDiscard,
  describeBeatLikeness,
  MAX_FRAME_BYTES,
  usableLikenesses,
  type BeatLikenessUse,
} from "../../src/core/likeness";
import { resolveBeatLimits, type BeatLimits } from "./beatLimits";
import { sendError, type JamStore } from "./jams";
import { checkFrame, frameObjectName, FRAME_REFUSAL_MESSAGE, resolveFrameStore } from "./likenessFrames";
import { MediaStorageError } from "./objectStorage";
import { resolvePrivateObjectStore, type PrivateObjectStore } from "./privateObjects";
import {
  BeatVideoError,
  clampBeatSeconds,
  describeReferences,
  generateBeatVideo,
  resolveBeatVideoConfig,
  type BeatVideoConfig,
  type LikenessFrame,
} from "./providers/falBeatVideo";

/**
 * Appearing in the film: the frame a participant approved, and the beats made from it.
 *
 * Every route here asks the same two questions in the same order. Who is calling, answered
 * by Supabase Auth verifying their own token; and what does the register say, read under the
 * same RLS the browser is subject to. Nothing is derived from a request body, and this
 * server holds no privileged read of the register — it cannot see a consent that the caller
 * could not see themselves.
 *
 * The rule the whole feature rests on is one line, in one place: `usableLikenesses` decides
 * which grants may seed a generation, evaluated at the instant of submission. There is no
 * cache to invalidate, so a withdrawal a second earlier is honoured by construction.
 */

/** A frame is small and a beat is not; both bodies are capped before they are buffered. */
const MAX_BEAT_BODY_BYTES = 2_048;
const BEAT_PROMPT_SENTENCE_CAP = 900;

export interface LikenessRouterOptions {
  supabase?: SupabaseConfig | null;
  rest?: SupabaseRestOptions;
  beatConfig?: BeatVideoConfig | null;
  limits?: BeatLimits;
  frames?: PrivateObjectStore;
  clips?: PrivateObjectStore;
  generate?: typeof generateBeatVideo;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

/** One generated beat, and the grants it was actually made from. Never rewritten. */
interface BeatRecord {
  readonly index: number;
  readonly model: string;
  readonly requestId: string;
  readonly generatedAt: string;
  readonly contentType: string;
  readonly elapsedMs: number;
  readonly use: BeatLikenessUse | null;
}

type Caller = { userId: string; accessToken: string; supabase: SupabaseConfig };

export function createLikenessRouter(store: JamStore, options: LikenessRouterOptions = {}): Router {
  const router = express.Router();
  const env = options.env ?? process.env;
  const rest = options.rest ?? {};
  const limits = options.limits ?? resolveBeatLimits(env);
  const frames = options.frames ?? resolveFrameStore(env);
  const clips = options.clips ?? resolvePrivateObjectStore("beats", 16, env);
  const generate = options.generate ?? generateBeatVideo;
  const now = options.now ?? Date.now;
  const beats = new Map<string, BeatRecord>();
  const inFlight = new Set<string>();

  let beatConfigResolved = false;
  let beatConfig: BeatVideoConfig | null = options.beatConfig ?? null;

  function requireBeatConfig(): BeatVideoConfig | null {
    if (options.beatConfig !== undefined) return options.beatConfig;
    if (!beatConfigResolved) {
      beatConfig = resolveBeatVideoConfig(env);
      beatConfigResolved = true;
    }
    return beatConfig;
  }

  function supabaseConfig(): SupabaseConfig | null {
    return options.supabase !== undefined ? options.supabase : readSupabaseConfig(env);
  }

  /**
   * Resolves the caller and confirms they are an active member of this jam.
   *
   * Without Supabase the answer is that this room cannot be checked, not that the check
   * passes. A server that cannot verify consent must not act on it.
   */
  async function resolveCaller(request: Request, response: Response, jamId: string): Promise<Caller | null> {
    const supabase = supabaseConfig();
    if (!supabase) {
      sendError(
        response,
        503,
        "likeness_not_configured",
        "This server cannot check consent, so it will not use anyone's likeness.",
        false,
      );
      return null;
    }
    const header = request.headers.authorization;
    const accessToken = typeof header === "string" && /^Bearer [A-Za-z0-9._-]+$/.test(header.trim())
      ? header.trim().slice(7)
      : null;
    if (!accessToken) {
      sendError(response, 401, "unauthenticated", "Sign in to this jam first.", false);
      return null;
    }
    try {
      const userId = await authenticate(supabase, accessToken, rest);
      const facts = await readMembership(supabase, accessToken, jamId, userId, rest);
      const decision = decideLiveAccess(facts);
      if (!decision.allowed) {
        sendError(
          response,
          403,
          "forbidden",
          decision.reason === "jam_closed" ? "This jam is no longer open." : "You are not an active member of this jam.",
          false,
        );
        return null;
      }
      return { userId, accessToken, supabase };
    } catch (error) {
      sendRestError(response, error);
      return null;
    }
  }

  async function readRegister(caller: Caller, jamId: string): Promise<LiveConsent[]> {
    const rows = await readLiveConsents(caller.supabase, caller.accessToken, jamId, rest);
    return rows.flatMap((row) => {
      const parsed = liveConsentSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  }

  /**
   * Attaches the frame a participant approved to their own standing grant.
   *
   * The reference was issued by the register's trigger, so this route never mints one; it
   * only ever fills in the bytes behind a reference the caller already owns.
   */
  router.put(
    "/api/jams/:id/likeness/:assetRef",
    express.raw({ type: ["image/jpeg", "image/png"], limit: MAX_FRAME_BYTES }),
    async (request, response) => {
      const caller = await resolveCaller(request, response, request.params.id);
      if (!caller) return;

      const contentType = (request.headers["content-type"] ?? "").split(";")[0].trim();
      const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const frame = checkFrame(contentType, bytes);
      if (!frame.ok) {
        sendError(response, 400, frame.reason, FRAME_REFUSAL_MESSAGE[frame.reason], false);
        return;
      }

      try {
        const register = await readRegister(caller, request.params.id);
        const consent = register.find((row) => row.asset_ref === request.params.assetRef);
        if (!consent) {
          sendError(response, 404, "consent_not_found", "That agreement is not in this room's register.", false);
          return;
        }
        const access = decideFrameAccess(consent, caller.userId, now());
        if (!access.allowed) {
          sendError(response, 403, access.reason, refusalMessage(access.reason), false);
          return;
        }
        await frames.put(request.params.id, frameObjectName(consent.asset_ref), bytes, contentType);
        response.status(201).json({
          assetRef: consent.asset_ref,
          width: frame.dimensions.width,
          height: frame.dimensions.height,
          durable: frames.durable,
          expiresAt: consent.expires_at,
        });
      } catch (error) {
        sendStorageOrRestError(response, error, "That frame could not be stored.");
      }
    },
  );

  /** The owner's own frame, and nobody else's. It is never served to another participant. */
  router.get("/api/jams/:id/likeness/:assetRef", async (request, response) => {
    const caller = await resolveCaller(request, response, request.params.id);
    if (!caller) return;
    try {
      const register = await readRegister(caller, request.params.id);
      const consent = register.find((row) => row.asset_ref === request.params.assetRef);
      if (!consent) {
        sendError(response, 404, "consent_not_found", "That agreement is not in this room's register.", false);
        return;
      }
      const access = decideFrameAccess(consent, caller.userId, now());
      if (!access.allowed) {
        sendError(response, 403, access.reason, refusalMessage(access.reason), false);
        return;
      }
      const stored = await frames.get(request.params.id, frameObjectName(consent.asset_ref));
      if (!stored) {
        sendError(response, 404, "no_frame", "No frame has been attached to that agreement.", false);
        return;
      }
      response.setHeader("content-type", stored.contentType);
      response.setHeader("cache-control", "no-store");
      response.status(200).end(stored.bytes);
    } catch (error) {
      sendStorageOrRestError(response, error, "That frame could not be read.");
    }
  });

  /**
   * Discards the frame behind an ended grant.
   *
   * Called by the owner's own client the moment they withdraw. A grant that has ended is the
   * expected case here, not a refusal — a frame outliving the consent that justified it is
   * the thing this route exists to prevent.
   */
  router.delete("/api/jams/:id/likeness/:assetRef", async (request, response) => {
    const caller = await resolveCaller(request, response, request.params.id);
    if (!caller) return;
    try {
      const register = await readRegister(caller, request.params.id);
      const consent = register.find((row) => row.asset_ref === request.params.assetRef);
      if (!consent) {
        sendError(response, 404, "consent_not_found", "That agreement is not in this room's register.", false);
        return;
      }
      const discard = decideFrameDiscard(consent, caller.userId);
      if (!discard.allowed) {
        sendError(response, 403, discard.reason, refusalMessage(discard.reason), false);
        return;
      }
      await frames.discard(request.params.id, frameObjectName(consent.asset_ref));
      response.status(204).end();
    } catch (error) {
      sendStorageOrRestError(response, error, "That frame could not be discarded.");
    }
  });

  /**
   * Generates one beat.
   *
   * Whether anybody appears in it is not the caller's choice and is not in the request body:
   * the register decides, read fresh, at this moment. A room where nobody has agreed
   * generates a plain beat, exactly as it did before this feature existed.
   */
  router.post(
    "/api/jams/:id/beats/:index/video",
    express.json({ limit: MAX_BEAT_BODY_BYTES }),
    async (request, response) => {
      const jamId = request.params.id;
      const index = Number(request.params.index);
      const jam = await store.getJam(jamId);
      if (!jam || !Number.isInteger(index) || index < 0) {
        sendError(response, 404, "not_found", "That beat does not exist on this server.", false);
        return;
      }
      const portion = portionAt(jam.script, index);
      if (!portion) {
        sendError(response, 404, "not_found", "That beat does not exist on this server.", false);
        return;
      }

      const caller = await resolveCaller(request, response, jamId);
      if (!caller) return;

      const config = requireBeatConfig();
      if (!config) {
        // No mock, and no plain beat standing in for one that was meant to have a face in it.
        sendError(response, 503, "generation_disabled", "Beat generation is not configured on this server.", false);
        return;
      }

      const key = `${jamId}:${index}`;
      if (inFlight.has(key)) {
        sendError(response, 409, "beat_in_flight", "That beat is already being generated.", true);
        return;
      }
      if (inFlight.size >= limits.maxConcurrentBeats) {
        sendError(response, 429, "too_many_beats", "Too many beats are generating right now.", true);
        return;
      }

      let register: LiveConsent[];
      try {
        register = await readRegister(caller, jamId);
      } catch (error) {
        sendRestError(response, error);
        return;
      }

      // The single gate. Read now, used now, never stored for later.
      const grants = usableLikenesses(register, now());
      const loaded: LikenessFrame[] = [];
      const used: LiveConsent[] = [];
      try {
        for (const grant of grants) {
          const stored = await frames.get(jamId, frameObjectName(grant.asset_ref));
          // A grant whose frame never arrived is not silently dropped into a plain beat: the
          // owner is told their frame is missing, and nothing generates without them.
          if (!stored) {
            sendError(
              response,
              409,
              "frame_missing",
              "Someone agreed to appear but their frame did not arrive. Ask them to take it again.",
              false,
            );
            return;
          }
          loaded.push({ assetRef: grant.asset_ref, contentType: stored.contentType, bytes: stored.bytes });
          used.push(grant);
        }
      } catch (error) {
        sendStorageOrRestError(response, error, "A frame could not be read.");
        return;
      }

      const seconds = clampBeatSeconds(portion.durationSeconds);

      inFlight.add(key);
      try {
        const clip = await generate(config, {
          prompt: beatPrompt(portion, loaded.length),
          durationSeconds: seconds,
          frames: loaded,
        });
        await clips.put(jamId, String(index), clip.bytes, clip.contentType);
        const record: BeatRecord = {
          index,
          model: clip.model,
          requestId: clip.requestId,
          generatedAt: new Date(now()).toISOString(),
          contentType: clip.contentType,
          elapsedMs: clip.elapsedMs,
          use: used.length === 0
            ? null
            : {
                consentIds: used.map((c) => c.id),
                assetRefs: used.map((c) => c.asset_ref),
                ownerIds: used.map((c) => c.owner_id),
                generatedAt: new Date(now()).toISOString(),
                model: clip.model,
              },
        };
        beats.set(key, record);
        response.status(201).json({
          ...projectBeat(record, register, now()),
          durable: clips.durable,
        });
      } catch (error) {
        if (error instanceof BeatVideoError) {
          sendError(response, error.retryable ? 502 : 500, error.code, error.message, error.retryable);
          return;
        }
        sendStorageOrRestError(response, error, "That beat could not be generated.");
      } finally {
        inFlight.delete(key);
      }
    },
  );

  /** What a generated beat is, including what may honestly be said about who is in it. */
  router.get("/api/jams/:id/beats/:index", async (request, response) => {
    const record = beats.get(`${request.params.id}:${Number(request.params.index)}`);
    if (!record) {
      sendError(response, 404, "not_found", "That beat has not been generated.", false);
      return;
    }
    const caller = await resolveCaller(request, response, request.params.id);
    if (!caller) return;
    try {
      response.json(projectBeat(record, await readRegister(caller, request.params.id), now()));
    } catch (error) {
      sendRestError(response, error);
    }
  });

  /** The clip itself, served by this server. No storage address ever reaches a browser. */
  router.get("/api/jams/:id/beats/:index/video", async (request, response) => {
    const index = Number(request.params.index);
    const record = beats.get(`${request.params.id}:${index}`);
    if (!record) {
      sendError(response, 404, "not_found", "That beat has not been generated.", false);
      return;
    }
    const caller = await resolveCaller(request, response, request.params.id);
    if (!caller) return;
    try {
      const stored = await clips.get(request.params.id, String(index));
      if (!stored) {
        sendError(response, 404, "not_found", "That beat's clip is no longer held by this server.", false);
        return;
      }
      response.setHeader("content-type", stored.contentType);
      response.setHeader("content-length", String(stored.bytes.byteLength));
      response.status(200).end(stored.bytes);
    } catch (error) {
      sendStorageOrRestError(response, error, "That clip could not be read.");
    }
  });

  return router;
}

function projectBeat(record: BeatRecord, register: readonly LiveConsent[], at: number) {
  return {
    index: record.index,
    model: record.model,
    requestId: record.requestId,
    generatedAt: record.generatedAt,
    elapsedMs: record.elapsedMs,
    likeness: {
      standing: describeBeatLikeness(record.use, register, at),
      // Owners, not references: another participant is never handed the reference that
      // addresses somebody's face.
      ownerIds: record.use?.ownerIds ?? [],
    },
  };
}

interface BeatPortion {
  durationSeconds: number;
  action: string;
  dialogue?: string;
  visualDirection?: string;
  summary?: string;
}

function portionAt(script: { scenes: { portions: BeatPortion[] }[] }, index: number): BeatPortion | null {
  let seen = 0;
  for (const scene of script.scenes) {
    for (const portion of scene.portions) {
      if (seen === index) return portion;
      seen += 1;
    }
  }
  return null;
}

/**
 * The beat's own words, with the references named first.
 *
 * The model addresses references positionally, so the sentence saying which image is which
 * has to come before the scene. Nothing about the people reaches the provider beyond "a
 * character in this scene": no display name, no id, not even how many are in the room.
 * Script text is concatenated as prose and never interpolated as instruction.
 */
function beatPrompt(portion: BeatPortion, referenceCount: number): string {
  const scene = [portion.visualDirection, portion.action, portion.dialogue]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" ")
    .slice(0, BEAT_PROMPT_SENTENCE_CAP);
  const references = describeReferences(referenceCount);
  return references ? `${references} ${scene}` : scene;
}

function refusalMessage(reason: string): string {
  if (reason === "withdrawn_or_expired") {
    return "That agreement has ended, so it can no longer be used.";
  }
  // "Not yours" and "not a likeness consent" get the same sentence, so neither answer tells
  // a prober anything about the other.
  return "That agreement is not yours.";
}

function sendRestError(response: Response, error: unknown): void {
  if (error instanceof RestError) {
    const status = error.code === "unauthenticated" ? 401 : error.code === "forbidden" ? 403 : 503;
    sendError(response, status, error.code, error.message, error.code === "unavailable");
    return;
  }
  sendError(response, 500, "unavailable", "That request could not be completed.", true);
}

function sendStorageOrRestError(response: Response, error: unknown, fallback: string): void {
  if (error instanceof MediaStorageError) {
    sendError(response, error.retryable ? 503 : 400, "media_unavailable", fallback, error.retryable);
    return;
  }
  sendRestError(response, error);
}
