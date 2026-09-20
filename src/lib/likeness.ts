// Browser side of appearing in the film.
//
// The browser captures a frame from its own camera and shows it back, but it decides
// nothing: it cannot issue a reference, cannot set a lifetime, cannot read another
// participant's frame, and cannot ask for a likeness to be used. It records a grant in the
// register and hands over the bytes behind the reference the register issued.

import { LIKENESS_CONSENT_KIND, type LiveConsent } from "../core/liveMedia";
import { FRAME_CONTENT_TYPE, MAX_FRAME_BYTES, MAX_FRAME_PIXELS, MIN_FRAME_PIXELS } from "../core/likeness";
import { grantLiveConsent, withdrawLiveConsent } from "./liveMedia";
import { JamError, notConfigured } from "./errors";
import { supabase } from "./supabase";

/** JPEG quality for the approved frame: enough detail for a face, inside the byte cap. */
const FRAME_QUALITY = 0.9;

/**
 * Draws one frame from a live video element.
 *
 * Called only from a press. Nothing on this path runs on a timer, on stream start, or on
 * anything but the person's own action, and the caller shows the result back before it is
 * used for anything.
 */
export function captureFrame(video: HTMLVideoElement): Promise<Blob> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) {
    return Promise.reject(new JamError("unavailable", "The camera is not showing a picture yet."));
  }
  // Square, centred, and scaled into the band the provider and the payload guard agree on.
  const side = Math.min(width, height);
  const target = Math.max(MIN_FRAME_PIXELS, Math.min(MAX_FRAME_PIXELS, side));
  const canvas = document.createElement("canvas");
  canvas.width = target;
  canvas.height = target;
  const context = canvas.getContext("2d");
  if (!context) {
    return Promise.reject(new JamError("unavailable", "This browser could not take the picture."));
  }
  context.drawImage(video, (width - side) / 2, (height - side) / 2, side, side, 0, 0, target, target);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new JamError("unavailable", "This browser could not take the picture."));
          return;
        }
        if (blob.size > MAX_FRAME_BYTES) {
          reject(new JamError("invalid_input", "That frame came out too large. Try again."));
          return;
        }
        resolve(blob);
      },
      FRAME_CONTENT_TYPE,
      FRAME_QUALITY,
    );
  });
}

async function accessToken(): Promise<string> {
  if (!supabase) throw notConfigured("Appearing in the film");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new JamError("unauthenticated", "Your session is no longer signed in. Reload the page to continue.");
  }
  return token;
}

/**
 * Records the grant, then sends the frame behind the reference the register issued.
 *
 * In that order, deliberately: the reference exists because a grant exists, never the other
 * way round. A frame that fails to upload leaves a grant with nothing behind it, which the
 * room sees as an error — it never becomes a beat generated without the person.
 */
export async function agreeToAppear(
  jamId: string,
  purpose: string,
  frame: Blob,
): Promise<LiveConsent> {
  const consent = await grantLiveConsent(jamId, LIKENESS_CONSENT_KIND, purpose);
  await attachFrame(jamId, consent.asset_ref, frame);
  return consent;
}

export async function attachFrame(jamId: string, assetRef: string, frame: Blob): Promise<void> {
  const token = await accessToken();
  let response: Response;
  try {
    response = await fetch(`/api/jams/${jamId}/likeness/${encodeURIComponent(assetRef)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": frame.type || FRAME_CONTENT_TYPE },
      body: frame,
    });
  } catch {
    throw new JamError("unavailable", "Your frame could not be sent. Nothing is being used yet.", true);
  }
  if (!response.ok) throw await toJamErrorFromResponse(response, "Your frame could not be stored.");
}

/**
 * Ends the grant and then discards the frame.
 *
 * The register is stamped first, because that is what actually stops the next beat. The
 * frame is then removed because it has no reason to exist any more; a discard that fails
 * leaves bytes behind a withdrawn grant, which no route will use, and the room is told.
 */
export async function stopAppearing(jamId: string, consent: LiveConsent): Promise<void> {
  await withdrawLiveConsent(consent.id);
  const token = await accessToken();
  try {
    const response = await fetch(
      `/api/jams/${jamId}/likeness/${encodeURIComponent(consent.asset_ref)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok && response.status !== 404) {
      throw await toJamErrorFromResponse(response, "Your frame could not be discarded.");
    }
  } catch (error) {
    if (error instanceof JamError) throw error;
    throw new JamError(
      "unavailable",
      "You have been taken out of the film, but your frame could not be discarded. Nothing will use it.",
      true,
    );
  }
}

async function toJamErrorFromResponse(response: Response, fallback: string): Promise<JamError> {
  let safeMessage = fallback;
  let retryable = response.status >= 500;
  try {
    const body = (await response.json()) as { error?: { safeMessage?: unknown; retryable?: unknown } };
    if (typeof body?.error?.safeMessage === "string") safeMessage = body.error.safeMessage;
    if (typeof body?.error?.retryable === "boolean") retryable = body.error.retryable;
  } catch {
    // A body that is not the typed envelope tells us nothing; the fallback stands.
  }
  const kind = response.status === 401
    ? "unauthenticated"
    : response.status === 403
      ? "forbidden"
      : response.status === 400 || response.status === 409
        ? "invalid_input"
        : "unavailable";
  return new JamError(kind, safeMessage, retryable);
}
