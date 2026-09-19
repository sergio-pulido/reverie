import { createContext, useContext, type ReactNode } from "react";
import { requestRanking, requestTurn } from "./assistantClient";

/** The two conversational calls, as the search screen makes them. */
export type Assistant = { requestTurn: typeof requestTurn; requestRanking: typeof requestRanking };

const AssistantContext = createContext<Assistant>({ requestTurn, requestRanking });

/**
 * Where the conversation reaches the assistant. The app calls `/api/discover/turn` and
 * `/api/discover/rank`; a test puts its own answers here and drives the same screen through them.
 */
export function AssistantProvider({ assistant, children }: { assistant: Assistant; children: ReactNode }) {
  return <AssistantContext.Provider value={assistant}>{children}</AssistantContext.Provider>;
}

export function useAssistant(): Assistant {
  return useContext(AssistantContext);
}
