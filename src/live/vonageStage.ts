// The only file that talks to the Vonage Video client SDK. Everything above it deals in
// track kinds, consent and connection state.
//
// The SDK is imported dynamically so a deployment without live media never downloads it.

import type OT from "@vonage/client-sdk-video";
import type { LiveTrackKind } from "../core/liveMedia";
import { classifyMediaError, MEDIA_OUTCOME_MESSAGE } from "../core/liveMedia";

export type StageConnection = "idle" | "connecting" | "live" | "reconnecting" | "offline" | "denied";

export type StageCredentials = { authId: string; sessionId: string; token: string };

export type StageHandlers = {
  onConnection: (state: StageConnection) => void;
  onRemoteStreams: (count: number) => void;
  onError: (message: string) => void;
};

export type StageHandle = {
  /** Starts or stops publishing to match the permitted set. Never publishes anything else. */
  applyPermissions: (permitted: ReadonlySet<LiveTrackKind>) => Promise<void>;
  leave: () => Promise<void>;
};

type Containers = { camera: HTMLElement; screen: HTMLElement };

let sdk: typeof OT | null = null;

async function loadSdk(): Promise<typeof OT> {
  if (!sdk) {
    const loaded = (await import("@vonage/client-sdk-video")) as unknown as { default?: typeof OT } & typeof OT;
    sdk = loaded.default ?? loaded;
  }
  return sdk;
}

/** Stops every underlying device track before the publisher goes away. */
function stopTracks(publisher: OT.Publisher) {
  try {
    publisher.getVideoSource?.().track?.stop();
  } catch {
    // A publisher with no video source has nothing to stop.
  }
  try {
    publisher.getAudioSource?.()?.stop();
  } catch {
    // Likewise for audio.
  }
}

/**
 * Connects to the jam's Vonage session and publishes only what consent permits.
 *
 * Connecting publishes nothing: `applyPermissions` is the only path that starts a track,
 * and calling it with a smaller set stops the difference immediately.
 */
export async function openStage(
  credentials: StageCredentials,
  containers: Containers,
  handlers: StageHandlers,
): Promise<StageHandle> {
  const OTApi = await loadSdk();
  handlers.onConnection("connecting");

  const session = OTApi.initSession(credentials.authId, credentials.sessionId);
  let cameraPublisher: OT.Publisher | null = null;
  let screenPublisher: OT.Publisher | null = null;
  let remoteStreams = 0;
  let left = false;

  session.on("streamCreated", (event) => {
    remoteStreams += 1;
    handlers.onRemoteStreams(remoteStreams);
    session.subscribe(event.stream, containers.camera, { insertMode: "append", width: "100%", height: "100%" });
  });
  session.on("streamDestroyed", () => {
    remoteStreams = Math.max(0, remoteStreams - 1);
    handlers.onRemoteStreams(remoteStreams);
  });
  session.on("sessionReconnecting", () => handlers.onConnection("reconnecting"));
  session.on("sessionReconnected", () => handlers.onConnection("live"));
  session.on("sessionDisconnected", () => handlers.onConnection(left ? "idle" : "offline"));

  try {
    await session.connect.promise(credentials.token);
  } catch (error) {
    handlers.onConnection("denied");
    throw new Error(
      (error as { message?: string })?.message
        ? "The live stage refused this connection."
        : "The live stage could not be reached.",
    );
  }
  handlers.onConnection("live");

  async function destroyCamera() {
    if (!cameraPublisher) return;
    const publisher = cameraPublisher;
    cameraPublisher = null;
    try {
      await session.unpublish(publisher);
    } catch {
      // Already unpublished; the local teardown below still has to run.
    }
    stopTracks(publisher);
    publisher.destroy();
  }

  async function destroyScreen() {
    if (!screenPublisher) return;
    const publisher = screenPublisher;
    screenPublisher = null;
    try {
      await session.unpublish(publisher);
    } catch {
      // Already unpublished.
    }
    stopTracks(publisher);
    publisher.destroy();
  }

  async function applyPermissions(permitted: ReadonlySet<LiveTrackKind>) {
    const wantsCamera = permitted.has("camera");
    const wantsMicrophone = permitted.has("microphone");
    const wantsScreen = permitted.has("screen");

    if (!wantsCamera && !wantsMicrophone) {
      await destroyCamera();
    } else if (!cameraPublisher) {
      try {
        const publisher = OTApi.initPublisher(containers.camera, {
          insertMode: "append",
          width: "100%",
          height: "100%",
          publishVideo: wantsCamera,
          publishAudio: wantsMicrophone,
          name: "live",
        });
        await session.publish.promise(publisher);
        cameraPublisher = publisher;
      } catch (error) {
        // A refused browser permission is stated, not retried.
        handlers.onError(MEDIA_OUTCOME_MESSAGE[classifyMediaError(error)]);
      }
    } else {
      cameraPublisher.publishVideo(wantsCamera);
      cameraPublisher.publishAudio(wantsMicrophone);
    }

    if (!wantsScreen) {
      await destroyScreen();
    } else if (!screenPublisher) {
      try {
        const publisher = OTApi.initPublisher(containers.screen, {
          insertMode: "append",
          width: "100%",
          height: "100%",
          videoSource: "screen",
          publishAudio: false,
          name: "screen",
        });
        await session.publish.promise(publisher);
        // Ending the share from the browser's own bar destroys the publisher; the room
        // must stop showing the reference in that case too.
        publisher.on("mediaStopped", () => { void destroyScreen(); });
        screenPublisher = publisher;
      } catch (error) {
        handlers.onError(MEDIA_OUTCOME_MESSAGE[classifyMediaError(error)]);
      }
    }
  }

  async function leave() {
    left = true;
    await destroyCamera();
    await destroyScreen();
    try {
      await session.disconnect();
    } catch {
      // Disconnecting an already-closed session is not an error worth showing.
    }
    handlers.onConnection("idle");
  }

  return { applyPermissions, leave };
}
