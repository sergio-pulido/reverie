import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { NO_VIEWER, supabaseViewer, type Viewer, type ViewerSource } from "./viewer";

const ViewerSourceContext = createContext<ViewerSource>(supabaseViewer);

/** Gives the screens below a different viewer source than the live Supabase session. */
export function ViewerProvider({ source, children }: { source: ViewerSource; children: ReactNode }) {
  return <ViewerSourceContext.Provider value={source}>{children}</ViewerSourceContext.Provider>;
}

export function useViewerSource(): ViewerSource {
  return useContext(ViewerSourceContext);
}

/** The viewer as they are now, updated when the session or their name changes. */
export function useViewer(): Viewer {
  const source = useViewerSource();
  const [viewer, setViewer] = useState<Viewer>(NO_VIEWER);
  useEffect(() => source.observe(setViewer), [source]);
  return viewer;
}
