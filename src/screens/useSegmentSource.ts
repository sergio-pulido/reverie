import { useEffect, useState } from "react";
import { fetchSegment } from "../lib/escapeRoom";

/**
 * A playable source for one generated segment.
 *
 * The clip lives behind a route that checks membership, and a video element
 * sends no Authorization header, so the bytes are fetched here and handed over
 * as an object URL. Exactly one is alive at a time per element: the previous
 * URL is revoked the moment the path changes or the element goes away, so a
 * room that plays twenty beats does not hold twenty clips in memory.
 *
 * `null` means "not playable yet", which is the same thing the caller does
 * when there is no clip at all — so a slow fetch shows the placeholder rather
 * than an empty frame.
 */
export type FetchClip = (path: string) => Promise<Blob>;

export function useSegmentSource(
  path: string | null,
  fetchClip: FetchClip = fetchSegment,
): string | null {
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setSource(null);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    void fetchClip(path)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSource(url);
      })
      .catch(() => {
        // The panel already says what the server thinks of this segment; a
        // second message about the download would not tell anyone more.
        if (!cancelled) setSource(null);
      });
    return () => {
      cancelled = true;
      setSource(null);
      if (url) URL.revokeObjectURL(url);
    };
  }, [fetchClip, path]);

  return source;
}
