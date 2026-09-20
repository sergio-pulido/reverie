import { createContext, useContext, type ReactNode } from "react";
import { requestCritique, requestRanking, requestTurn } from "./assistantClient";

/** The three conversational calls, as the search screen makes them. */
export type Assistant = {
  requestTurn: typeof requestTurn;
  requestRanking: typeof requestRanking;
  requestCritique: typeof requestCritique;
};

const AssistantContext = createContext<Assistant>({ requestTurn, requestRanking, requestCritique });

/**
 * Where the conversation reaches the assistant. The app calls `/api/discover/turn`,
 * `/api/discover/rank` and `/api/discover/critique`; a test puts its own answers here and drives
 * the same screen through them.
 */
export function AssistantProvider({ assistant, children }: { assistant: Assistant; children: ReactNode }) {
  return <AssistantContext.Provider value={assistant}>{children}</AssistantContext.Provider>;
}

export function useAssistant(): Assistant {
  return useContext(AssistantContext);
}
