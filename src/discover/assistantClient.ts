import type { z } from "zod";
import type { CatalogueTitle } from "../catalogue/contract";
import {
  CONVERSATION_LIMITS,
  rankResponseSchema,
  turnResponseSchema,
  type RankCandidate,
  type RankResponse,
  type TurnResponse,
} from "../conversation/contract";
import type { PreferenceState } from "../preferences/schema";
import { ensureAccessToken } from "../lib/session";

/** What the browser says when it could not reach the assistant at all. */
const UNREACHABLE = {
  status: "error",
  code: "ASSISTANT_UNREACHABLE",
  safeMessage: "The assistant could not be reached.",
  retryable: true,
} as const;

const UNREADABLE = {
  status: "error",
  code: "ASSISTANT_INVALID_RESPONSE",
  safeMessage: "The assistant sent a response Discover could not trust.",
  retryable: false,
} as const;

/**
 * One call to a conversational endpoint as the viewer's own session. The response is parsed
 * again here, so an unexpected shape becomes an explicit error rather than a half-applied turn.
 * Resolves to null when aborted.
 */
async function post<S extends z.ZodType>(
  path: string,
  body: unknown,
  schema: S,
  signal?: AbortSignal,
): Promise<z.output<S> | typeof UNREACHABLE | typeof UNREADABLE | null> {
  try {
    const accessToken = await ensureAccessToken("Talking to the assistant");
    const response = await fetch(path, {
      method: "POST",
      signal,
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });
    const parsed = schema.safeParse(await response.json());
    if (signal?.aborted) return null;
    return parsed.success ? parsed.data : UNREADABLE;
  } catch (error: unknown) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return null;
    return UNREACHABLE;
  }
}

export function requestTurn(message: string, state: PreferenceState, previousQuestion: string | null): Promise<TurnResponse | null> {
  return post("/api/discover/turn", { message, state, previousQuestion }, turnResponseSchema);
}

/** The few fields the model judges a film by, with the synopsis cut to a gist. */
export function toRankCandidate(title: CatalogueTitle): RankCandidate {
  return {
    id: title.id,
    title: title.title,
    year: title.year,
    genres: title.genres,
    runtimeMinutes: title.runtimeMinutes,
    originalLanguage: title.originalLanguage,
    rating: title.rating,
    synopsis: title.synopsis?.slice(0, CONVERSATION_LIMITS.rankSynopsisChars),
  };
}

export function requestRanking(
  state: PreferenceState,
  titles: readonly CatalogueTitle[],
  signal: AbortSignal,
): Promise<RankResponse | null> {
  const candidates = titles.slice(0, CONVERSATION_LIMITS.maxRankCandidates).map(toRankCandidate);
  return post("/api/discover/rank", { state, candidates }, rankResponseSchema, signal);
}
