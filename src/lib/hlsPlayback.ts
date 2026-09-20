import Hls from "hls.js";

/**
 * Attaches a live director playlist to a video element.
 *
 * Two paths, because browsers disagree about whose job this is. Safari and iOS
 * play HLS natively from a `src`; everywhere else it has to be fed through
 * Media Source Extensions, which is what hls.js does. Preferring the native
 * path where it exists is not only lighter — on iOS it is the only one that
 * works, since MSE is unavailable on iPhone.
 *
 * The room is watching one shared stream, so this only ever reads: it fetches
 * a playlist and segments over plain HTTP and holds no connection of its own.
 */

export interface HlsAttachment {
  /** Stops playback and releases whatever was attached. Safe to call twice. */
  detach(): void;
}

export interface HlsAttachOptions {
  /** Called when the stream cannot be played at all, with a safe message. */
  onFailure?: (message: string) => void;
  /**
   * The viewer's access token, when the playlist and its pieces are behind an
   * authorization check — which the archived film in production is.
   *
   * It forces the hls.js path even where the browser plays HLS natively,
   * because a native `<video src>` cannot carry a header and there is nowhere
   * else to put a credential that is not a credential in a URL. Safari on the
   * desktop supports MSE, so this costs nothing there; a browser with neither
   * is told plainly that it cannot play the film.
   */
  accessToken?: string;
  /**
   * A finished film rather than a live take.
   *
   * A live window starts at the live edge and keeps almost no history. A
   * recording is the opposite: every piece is listed, none is ever removed,
   * and the viewer is expected to seek through it.
   */
  vod?: boolean;
  /** Injected in tests; defaults to `globalThis.fetch`. */
  fetchPlaylist?: typeof fetch;
}

/** How long a live take may take to produce its first segment before we give up. */
const FIRST_SEGMENT_TIMEOUT_MS = 90_000;
const FIRST_SEGMENT_POLL_MS = 1_000;

/**
 * Waits until a live playlist actually lists a segment.
 *
 * A director playlist exists before its first segment does. The provider takes
 * several seconds to send a chunk, the muxer needs a keyframe before it can emit
 * anything, and until then the playlist is a valid header with no `#EXTINF` and
 * an `EXT-X-MAP` pointing at an `init.mp4` that 404s.
 *
 * Handing that to hls.js does not merely fail slowly: it counts as a level
 * error, and after its own retries hls.js excludes the only level there is and
 * stops for good — so the frame stays black even once segments appear. Waiting
 * for the first `#EXTINF` costs a few HEAD-sized reads and avoids the whole
 * problem, which is much less fragile than trying to talk hls.js out of its
 * exclusion logic.
 */
export async function waitForFirstSegment(
  playlistUrl: string,
  options: {
    accessToken?: string;
    cancelled: () => boolean;
    fetchPlaylist?: typeof fetch;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  },
): Promise<boolean> {
  const load = options.fetchPlaylist ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + FIRST_SEGMENT_TIMEOUT_MS;
  while (!options.cancelled()) {
    try {
      const response = await load(playlistUrl, {
        cache: "no-store",
        ...(options.accessToken
          ? { headers: { authorization: `Bearer ${options.accessToken}` } }
          : {}),
      });
      if (response.ok && (await response.text()).includes("#EXTINF")) return true;
    } catch {
      // A playlist that cannot be read yet is the ordinary case before the
      // session is serving, not a reason to stop waiting.
    }
    if (now() >= deadline || options.cancelled()) return false;
    await wait(FIRST_SEGMENT_POLL_MS);
  }
  return false;
}

export function attachHlsStream(
  video: HTMLVideoElement,
  playlistUrl: string,
  options: HlsAttachOptions = {},
): HlsAttachment {
  // A live take has no segment for the first several seconds, and attaching to
  // an empty playlist is what left the stage black until the page was reloaded.
  // A finished film is complete the moment it is served, so it attaches at once.
  if (options.vod) return attachNow(video, playlistUrl, options);

  let cancelled = false;
  let attached: HlsAttachment | null = null;
  void waitForFirstSegment(playlistUrl, {
    accessToken: options.accessToken,
    fetchPlaylist: options.fetchPlaylist,
    cancelled: () => cancelled,
  }).then((ready) => {
    if (cancelled) return;
    if (!ready) {
      options.onFailure?.("The live stream has not produced any video yet.");
      return;
    }
    attached = attachNow(video, playlistUrl, options);
  });
  return {
    detach() {
      cancelled = true;
      attached?.detach();
      attached = null;
    },
  };
}

function attachNow(
  video: HTMLVideoElement,
  playlistUrl: string,
  options: HlsAttachOptions,
): HlsAttachment {
  // hls.js first wherever Media Source Extensions exist, and the native player
  // only where they do not.
  //
  // The obvious arrangement is the other way round — ask the element what it can
  // play and believe it — and it is a trap. Chrome answers `"maybe"` for
  // `application/vnd.apple.mpegurl` and then plays nothing at all, because it has
  // no native HLS. `"maybe"` is truthy, so preferring the native path hands every
  // Chrome, Edge and Firefox viewer a `<video src>` pointing at a playlist their
  // browser will never decode: a frame that stays black while the stream behind it
  // is perfectly healthy. Only Safari ever worked.
  //
  // MSE is what is actually missing on iOS, so `Hls.isSupported()` is the honest
  // question, and the native fallback below is for exactly that case.
  if (Hls.isSupported()) return attachThroughHlsJs(video, playlistUrl, options);

  // A native `<video src>` sends no Authorization header, so there is nowhere to
  // put a credential that is not a credential in a URL.
  if (options.accessToken || !video.canPlayType("application/vnd.apple.mpegurl")) {
    options.onFailure?.(
      options.vod
        ? "This browser cannot play the finished film."
        : "This browser cannot play the live stream.",
    );
    return { detach() {} };
  }

  video.src = playlistUrl;
  startPlaying(video, options);
  return {
    detach() {
      video.removeAttribute("src");
      video.load();
    },
  };
}

function attachThroughHlsJs(
  video: HTMLVideoElement,
  playlistUrl: string,
  options: HlsAttachOptions,
): HlsAttachment {

  const accessToken = options.accessToken;
  const hls = new Hls({
    // The stream is generated live and the window is small, so there is no
    // history to seek back through: start at the live edge rather than at the
    // oldest segment the window happens to still hold. A finished film is the
    // opposite case and keeps its whole back buffer, because seeking through
    // it is the point.
    lowLatencyMode: !options.vod,
    ...(options.vod ? {} : { backBufferLength: 30 }),
    ...(accessToken
      ? {
          xhrSetup: (xhr: XMLHttpRequest) => {
            xhr.setRequestHeader("authorization", `Bearer ${accessToken}`);
          },
        }
      : {}),
  });
  // Recovery is bounded and spaced. Calling `startLoad` the instant a fatal
  // network error arrives spins as fast as the playlist can 404, which is a
  // busy loop rather than a retry.
  let recoveries = 0;
  const MAX_RECOVERIES = 5;
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) return;
    // A fatal media or network error is recoverable often enough to be worth
    // trying; a room watching together would rather see a stutter than a dead
    // frame. Anything else is reported and left alone.
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      if (recoveries >= MAX_RECOVERIES) {
        options.onFailure?.(
          options.vod ? "The film could not be loaded." : "The live stream could not be loaded.",
        );
        return;
      }
      recoveries += 1;
      setTimeout(() => hls.startLoad(), 1_000 * recoveries);
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      hls.recoverMediaError();
      return;
    }
    options.onFailure?.(
      options.vod ? "The film stopped unexpectedly." : "The live stream stopped unexpectedly.",
    );
  });
  // `autoplay` is an attribute of the element's own load, and by the time a
  // source is attached through MSE that moment is long past: the element ends up
  // holding a perfectly decodable stream, paused at zero. Starting it here is
  // what turns "the frame is loaded" into "the film is playing".
  hls.on(Hls.Events.MANIFEST_PARSED, () => startPlaying(video, options));
  hls.loadSource(playlistUrl);
  hls.attachMedia(video);

  return {
    detach() {
      hls.destroy();
    },
  };
}

/**
 * Starts a live take playing.
 *
 * Only a live take: a finished film carries its own controls and belongs to
 * whoever is watching it, so it waits to be asked. The element is muted, which
 * is what makes this allowed without a gesture — and the viewer pressed Play to
 * get here anyway.
 */
function startPlaying(video: HTMLVideoElement, options: HlsAttachOptions): void {
  if (options.vod) return;
  void video.play().catch(() => {
    // A browser that refuses is not a stream that failed: the frame is there
    // and the viewer can start it. Reporting it as a broken stream would be a
    // lie, and there is nothing to recover from.
  });
}
