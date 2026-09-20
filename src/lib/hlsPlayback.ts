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
}

export function attachHlsStream(
  video: HTMLVideoElement,
  playlistUrl: string,
  options: HlsAttachOptions = {},
): HlsAttachment {
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = playlistUrl;
    return {
      detach() {
        video.removeAttribute("src");
        video.load();
      },
    };
  }

  if (!Hls.isSupported()) {
    options.onFailure?.("This browser cannot play the live stream.");
    return { detach() {} };
  }

  const hls = new Hls({
    // The stream is generated live and the window is small, so there is no
    // history to seek back through: start at the live edge rather than at the
    // oldest segment the window happens to still hold.
    lowLatencyMode: true,
    backBufferLength: 30,
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
    options.onFailure?.("The live stream stopped unexpectedly.");
  });
  hls.loadSource(playlistUrl);
  hls.attachMedia(video);

  return {
    detach() {
      hls.destroy();
    },
  };
}
