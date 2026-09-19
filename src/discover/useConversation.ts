import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_MESSAGE_CHARS } from "../conversation/decision";
import { EMPTY_CONVERSATION, assistantReplied, viewerSaid, type Conversation } from "../conversation/transcript";
import type { PreferenceState, TurnInput } from "../preferences/schema";
import { requestTurn } from "./assistantClient";

type Speaker = {
  sessionId: string;
  current: () => PreferenceState;
  say: (turn: TurnInput) => boolean;
};

/**
 * The viewer's side of the conversation for one Discover session. A message goes to the
 * server, the assistant's turn comes back and is applied through the same engine as a chip.
 * "Start over" begins a new session, which clears the conversation too.
 */
export function useConversation({ sessionId, current, say }: Speaker) {
  const [conversation, setConversation] = useState<Conversation>(EMPTY_CONVERSATION);
  const [pending, setPending] = useState(false);
  const latest = useRef(conversation);
  latest.current = conversation;
  const session = useRef(sessionId);

  useEffect(() => {
    session.current = sessionId;
    setConversation(EMPTY_CONVERSATION);
    setPending(false);
  }, [sessionId]);

  const send = useCallback(
    async (raw: string) => {
      const message = raw.trim().slice(0, MAX_MESSAGE_CHARS);
      if (!message || pending) return;
      const askedIn = session.current;
      setPending(true);
      setConversation((value) => viewerSaid(value, message));
      const reply = await requestTurn(message, current(), latest.current.openQuestion);
      if (session.current !== askedIn) return;
      const applied = reply?.status === "ok" ? say(reply.turn) : false;
      setConversation((value) => assistantReplied(value, reply, applied));
      setPending(false);
    },
    [pending, current, say],
  );

  return { conversation, pending, send };
}
