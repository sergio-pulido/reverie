import type { TurnResponse } from "./contract";

/**
 * What Discover shows of the conversation, and what it says when the assistant cannot help.
 * Pure: the hook feeds it responses and renders the lines.
 */

export type Line = {
  id: number;
  speaker: "viewer" | "assistant" | "system";
  text: string;
  /** A clarifying question is shown as one, so the viewer knows an answer is invited. */
  question?: boolean;
};

export type Conversation = {
  lines: readonly Line[];
  /** The question the assistant is waiting on, sent back with the next message for context. */
  openQuestion: string | null;
  /** False once the assistant has said it cannot help; chips and the scorer carry on. */
  available: boolean;
  /** True once the assistant has interpreted at least one message this session. */
  spoken: boolean;
};

export const MAX_LINES = 6;

export const EMPTY_CONVERSATION: Conversation = { lines: [], openQuestion: null, available: true, spoken: false };

export const FALLBACK_SUFFIX = "Use the chips to refine; results are ranked by genre match.";

function append(conversation: Conversation, lines: Omit<Line, "id">[]): Conversation {
  const last = conversation.lines.at(-1)?.id ?? 0;
  const added = lines.map((line, index) => ({ ...line, id: last + index + 1 }));
  return { ...conversation, lines: [...conversation.lines, ...added].slice(-MAX_LINES) };
}

export function viewerSaid(conversation: Conversation, message: string): Conversation {
  return append(conversation, [{ speaker: "viewer", text: message }]);
}

/**
 * The conversation after a reply. `applied` is whether the engine in the browser accepted the
 * turn: a turn the server accepted can still go stale if a chip changed the state meanwhile, and
 * then nothing is claimed.
 */
export function assistantReplied(conversation: Conversation, reply: TurnResponse | null, applied: boolean): Conversation {
  if (!reply) return conversation;
  switch (reply.status) {
    case "ok": {
      if (!applied) {
        return append(conversation, [{ speaker: "system", text: "Something changed while that was on its way, so nothing was applied. Say it again?" }]);
      }
      const lines: Omit<Line, "id">[] = [{ speaker: "assistant", text: reply.acknowledgement }];
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
