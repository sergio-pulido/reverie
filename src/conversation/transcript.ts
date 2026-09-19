import type { CatalogueTitle } from "../catalogue/contract";
import type { TurnResponse } from "./contract";

/**
 * What the search screen shows of the conversation, and what it says when the assistant cannot
 * help. Pure: the hook feeds it responses and renders the lines.
 *
 * A turn is one message from the viewer and everything said back to it. An assistant line can
 * carry the films that turn produced, as a snapshot: once attached it is never replaced, so
 * scrolling back shows what was recommended then, not a re-ranking under a later state.
 */

/** Where a result set's order came from, said on screen so nothing claims more than it did. */
export type ResultSource = "assistant" | "genre" | "lookup";

export type ResultSet = {
  /** The titles, in the order they were shown. */
  titles: readonly CatalogueTitle[];
  /** Titles marked as top picks. */
  pickIds: readonly string[];
  /** Why a pick is here, by title id, when the assistant said. */
  reasons: Readonly<Record<string, string>>;
  source: ResultSource;
  /** Why the assistant's order is not the one shown, when it was wanted. */
  note: string | null;
  /** How many titles matched in all, when the catalogue said. */
  total: number | null;
};

export type Line = {
  id: number;
  /** The turn the line belongs to, counted from the start of the session. */
  turn: number;
  speaker: "viewer" | "assistant" | "system";
  text: string;
  /** A clarifying question is shown as one, so the viewer knows an answer is invited. */
  question?: boolean;
  /** The films this turn produced. Only an assistant line carries them. */
  results?: ResultSet;
};

export type Conversation = {
  lines: readonly Line[];
  /** Turns started this session, including those no longer kept. */
  turns: number;
  /** The question the assistant is waiting on, sent back with the next message for context. */
  openQuestion: string | null;
  /** False once the assistant has said it cannot help; the filters and the scorer carry on. */
  available: boolean;
  /** True once the assistant has interpreted at least one message this session. */
  spoken: boolean;
};

/** Turns kept on screen. Older turns leave whole, with their posters, never a line at a time. */
export const MAX_TURNS = 20;

export const EMPTY_CONVERSATION: Conversation = { lines: [], turns: 0, openQuestion: null, available: true, spoken: false };

export const FALLBACK_SUFFIX = "Use the filters to narrow it down; results are ranked by genre match.";

type NewLine = Omit<Line, "id" | "turn">;

function append(conversation: Conversation, lines: NewLine[], turn = Math.max(conversation.turns, 1)): Conversation {
  const last = conversation.lines.at(-1)?.id ?? 0;
  const added = lines.map((line, index) => ({ ...line, id: last + index + 1, turn }));
  const turns = Math.max(conversation.turns, turn);
  const kept = [...conversation.lines, ...added].filter((line) => line.turn > turns - MAX_TURNS);
  return { ...conversation, lines: kept, turns };
}

/** The viewer's message opens a new turn. */
export function viewerSaid(conversation: Conversation, message: string): Conversation {
  return append(conversation, [{ speaker: "viewer", text: message }], conversation.turns + 1);
}

/**
 * The conversation after a reply. `applied` is whether the engine in the browser accepted the
 * turn: a turn the server accepted can still go stale if a filter changed the state meanwhile,
 * and then nothing is claimed.
 */
export function assistantReplied(conversation: Conversation, reply: TurnResponse | null, applied: boolean): Conversation {
  if (!reply) return conversation;
  switch (reply.status) {
    case "ok": {
      if (!applied) {
        return append(conversation, [{ speaker: "system", text: "Something changed while that was on its way, so nothing was applied. Say it again?" }]);
      }
      const lines: NewLine[] = [{ speaker: "assistant", text: reply.acknowledgement }];
      if (reply.question) lines.push({ speaker: "assistant", text: reply.question, question: true });
      return { ...append(conversation, lines), openQuestion: reply.question, available: true, spoken: true };
    }
    case "unavailable":
      return {
        ...append(conversation, [{ speaker: "system", text: `The assistant is unavailable: ${reply.safeMessage} ${FALLBACK_SUFFIX}` }]),
        openQuestion: null,
        available: false,
      };
    case "error":
      return { ...append(conversation, [{ speaker: "system", text: reply.safeMessage }]), openQuestion: null };
  }
}

/**
 * A message answered by looking the words up as a title: the reply names what was looked for and
 * carries what was found. The assistant was not asked, so what it has interpreted is unchanged;
 * a question it was waiting on is dropped, because the viewer has moved on from it.
 */
export function lookupAnswered(conversation: Conversation, query: string, results: ResultSet): Conversation {
  return { ...append(conversation, [{ speaker: "assistant", text: `Here’s what I found for “${query}”.`, results }]), openQuestion: null };
}

/** Something the screen itself has to say about the current turn, such as films failing to load. */
export function systemSaid(conversation: Conversation, text: string): Conversation {
  return append(conversation, [{ speaker: "system", text }]);
}

/** The line a turn's films belong under: the first thing the assistant said in that turn. */
export function answerLineOf(conversation: Conversation, turn: number): number | null {
  return conversation.lines.find((line) => line.turn === turn && line.speaker === "assistant")?.id ?? null;
}

/**
 * Attaches a turn's films to its answer. A line that already carries films keeps them: a
 * snapshot is never replaced. A line that is gone (or is not the assistant's) takes nothing.
 * Returns the same conversation when nothing changed.
 */
export function attachResults(conversation: Conversation, lineId: number, results: ResultSet): Conversation {
  const line = conversation.lines.find(({ id }) => id === lineId);
  if (!line || line.speaker !== "assistant" || line.results) return conversation;
  return { ...conversation, lines: conversation.lines.map((each) => (each === line ? { ...line, results } : each)) };
}
