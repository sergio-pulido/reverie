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
}

export function attachHlsStream(
  video: HTMLVideoElement,
  playlistUrl: string,
  options: HlsAttachOptions = {},
): HlsAttachment {
  // A native `<video src>` sends no Authorization header, so an authorized
  // playlist has to go through hls.js even where native HLS exists.
  if (!options.accessToken && video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = playlistUrl;
    return {
      detach() {
        video.removeAttribute("src");
        video.load();
      },
    };
  }

  if (!Hls.isSupported()) {
    options.onFailure?.(
      options.vod
        ? "This browser cannot play the finished film."
        : "This browser cannot play the live stream.",
    );
    return { detach() {} };
  }

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
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) return;
    // A fatal media or network error is recoverable often enough to be worth
    // one attempt; a room watching together would rather see a stutter than a
    // dead frame. Anything else is reported and left alone.
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      hls.startLoad();
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
  hls.loadSource(playlistUrl);
  hls.attachMedia(video);

  return {
    detach() {
      hls.destroy();
    },
  };
}
