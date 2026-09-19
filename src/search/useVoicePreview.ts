import { useEffect, useMemo, useState } from "react";
import type { CatalogueFilters, CatalogueTitle } from "../catalogue/contract";
import { detectPreferences, previewFilters, type Detected } from "./detect";
import { carriesRequest } from "./filler";
import { SNAPSHOT_SIZE } from "./results";
import { useShortlist } from "./useShortlist";

/** How long detection has to hold still before posters are read for it. */
const PREVIEW_SETTLE_MS = 300;

/**
 * What the screen shows while the viewer is still speaking: the preferences heard so far, and a
 * row of posters read against them on top of what is already narrowing the results. Display only.
 * The words are never sent anywhere; only the filters derived from them reach the catalogue, the
 * same way a filter would. Filler hears nothing, so it previews nothing.
 */
export function useVoicePreview(text: string, base: CatalogueFilters | null, enabled: boolean) {
  const detected = useMemo<Detected[]>(() => (enabled && carriesRequest(text) ? detectPreferences(text) : []), [enabled, text]);
  const heard = detected.map(({ key }) => key).join("|");
  // Keyed by what was heard, so each new partial with the same preferences reads nothing new.
  const filters = useMemo(() => previewFilters(base, detected), [base, heard]); // eslint-disable-line react-hooks/exhaustive-deps
  const shortlist = useShortlist(filters, { enabled: filters !== null, pageSize: SNAPSHOT_SIZE, debounceMs: PREVIEW_SETTLE_MS });
  const [titles, setTitles] = useState<readonly CatalogueTitle[] | null>(null);

  // The last row stays up while the next is read, so the preview changes rather than flickers.
  useEffect(() => {
    if (filters === null) setTitles(null);
    else if (shortlist.state?.phase === "ready") setTitles(shortlist.state.response.items);
  }, [filters, shortlist.state]);

  return { detected, titles, reading: filters !== null && shortlist.state === null };
}
