import { loadOwnDisplayName } from "../lib/membership";
import { observeUserId, signOutViewer } from "../lib/session";

/**
 * Who the account menu is showing. There is no account system to invent one from: every visitor
 * is signed in anonymously through Supabase, and that user is what RLS checks, so this is that
 * user and nothing else.
 */
export type Viewer = {
  /** The Supabase user id, or `null` before anything on the page has caused a sign-in. */
  userId: string | null;
  /** The name they last gave a room, or `null` when they have never given one. */
  displayName: string | null;
};

export const NO_VIEWER: Viewer = { userId: null, displayName: null };

/** Where the account menu gets the viewer, and how it signs them out. Replaceable in a test. */
export type ViewerSource = {
  /** Calls back with the viewer now, and again whenever the session changes. Returns an unsubscribe. */
  observe: (listener: (viewer: Viewer) => void) => () => void;
  /** A real sign-out: the next visit mints a new anonymous user. */
  signOut: () => Promise<void>;
};

/** The app's own source: the live Supabase session, and the name it carries into rooms. */
export const supabaseViewer: ViewerSource = {
  observe(listener) {
    let current: string | null | undefined;
    let stopped = false;
    const stop = observeUserId((userId) => {
      if (stopped || userId === current) return;
      current = userId;
      listener({ userId, displayName: null });
      if (!userId) return;
      loadOwnDisplayName()
        .then((displayName) => {
          // A name that arrives after the viewer changed again belongs to nobody on screen.
          if (!stopped && current === userId) listener({ userId, displayName });
        })
        .catch(() => {
          // The bar is on every screen; a name that cannot be read must not break all of them.
          // The menu says "Signed in", which is true, rather than guessing at a name.
        });
    });
    return () => {
      stopped = true;
      stop();
    };
  },
  signOut: () => signOutViewer(),
};
