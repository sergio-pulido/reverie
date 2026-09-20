import { createContext, useContext, type ReactNode } from "react";
import type { Destination } from "../lib/routes";

/** What the top bar can ask the app to do. The app owns history; the bar only asks. */
export type Shell = {
  /** Go to a destination. Choosing the one already on screen returns to its top. */
  go: (destination: Destination) => void;
  /** Open the search screen with its field focused. */
  search: () => void;
  /** Open `/about`. It is not a destination, so it is asked for by name rather than chosen. */
  openAbout: () => void;
  /** Sign out of the anonymous Supabase session and leave for the public landing at `/`. */
  logOut: () => Promise<void>;
};

const NOWHERE: Shell = { go: () => undefined, search: () => undefined, openAbout: () => undefined, logOut: async () => undefined };

const ShellContext = createContext<Shell>(NOWHERE);

export function ShellProvider({ shell, children }: { shell: Shell; children: ReactNode }) {
  return <ShellContext.Provider value={shell}>{children}</ShellContext.Provider>;
}

export function useShell(): Shell {
  return useContext(ShellContext);
}
