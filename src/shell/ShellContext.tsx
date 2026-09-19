import { createContext, useContext, type ReactNode } from "react";
import type { Destination } from "../lib/routes";

/** What the top bar can ask the app to do. The app owns history; the bar only asks. */
export type Shell = {
  /** Go to a destination. Choosing the one already on screen returns to its top. */
  go: (destination: Destination) => void;
  /** Open Discover with its search field focused. */
  search: () => void;
};

const NOWHERE: Shell = { go: () => undefined, search: () => undefined };

const ShellContext = createContext<Shell>(NOWHERE);

export function ShellProvider({ shell, children }: { shell: Shell; children: ReactNode }) {
  return <ShellContext.Provider value={shell}>{children}</ShellContext.Provider>;
}

export function useShell(): Shell {
  return useContext(ShellContext);
}
