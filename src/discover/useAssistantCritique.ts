import { useEffect, useRef, useState } from "react";
import type { CatalogueTitle } from "../catalogue/contract";
import type { Critique } from "../conversation/contract";
import type { PreferenceState } from "../preferences/schema";
import { useAssistant } from "./AssistantContext";
import { acceptCritiques, critiqueKey, withheldTitles } from "./critiques";

/** Waiting on the critic, then done — with whatever it wrote, which may be nothing. */
export type CritiqueStatus = { phase: "writing" } | { phase: "done"; critiques: Readonly<Record<string, Critique>> };

const NONE: CritiqueStatus = { phase: "done", critiques: {} };

/**
 * Asks the critic to write about a row's top picks, once per set of picks and state. A newer set
 * aborts the older request, and an answer for anything but the current key is never shown.
 *
 * A refusal, a timeout or a critic that is switched off all end the same way: done, with nothing.
 * The row keeps the reasons the ranking already wrote, so a critique that never arrives costs the
 * viewer nothing but the critique.
 */
export function useAssistantCritique(
  picks: readonly CatalogueTitle[] | null,
  row: readonly CatalogueTitle[] | null,
  state: PreferenceState,
  enabled: boolean,
): CritiqueStatus {
  const { requestCritique } = useAssistant();
  const [answer, setAnswer] = useState<{ key: string; critiques: Readonly<Record<string, Critique>> } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const wanted = enabled && picks !== null && picks.length > 0;
  const key = wanted && picks ? critiqueKey(state, picks) : null;

  // `key` encodes the session, the state version and every pick, so `picks` and `state` cannot
  // change under the same key; they are read here, not listed as dependencies.
  useEffect(() => {
    controller.current?.abort();
    controller.current = null;
    if (!key || !picks) return;

    const request = new AbortController();
    controller.current = request;
    void requestCritique(state, picks, withheldTitles(row ?? picks, picks), request.signal).then((reply) => {
      if (request.signal.aborted) return;
      setAnswer({ key, critiques: acceptCritiques(reply, state, picks) });
    });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => controller.current?.abort(), []);

  if (!wanted) return NONE;
  if (!answer || answer.key !== key) return { phase: "writing" };
  return { phase: "done", critiques: answer.critiques };
}
