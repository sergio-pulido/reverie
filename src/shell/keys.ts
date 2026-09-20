import { CREATE_PATH, HOME_PATH, JAMS_PATH, NEW_JAM_PATH, DISCOVER_PATH, type Screen } from "../lib/routes";

/**
 * Remote and keyboard conventions the whole app agrees on. Pure, so they are testable without a
 * DOM.
 *
 * A remote's Back arrives under different names depending on the platform: `GoBack` and
 * `BrowserBack` from TV browsers, `XF86Back` from Linux-based sets, Escape from a keyboard, and
 * on some sets only as a key code (461, 10009) with an unhelpful key name. Backspace is Back only
 * outside a text field, where it would otherwise delete a character.
 */
const BACK_KEYS: ReadonlySet<string> = new Set(["Escape", "GoBack", "BrowserBack", "XF86Back"]);
const BACK_KEY_CODES: ReadonlySet<number> = new Set([461, 10009]);

export function isBackKey(key: string, editable = false, keyCode = 0): boolean {
  if (key === "Backspace") return !editable;
  return BACK_KEYS.has(key) || BACK_KEY_CODES.has(keyCode);
}

/**
 * What a Back press does. From inside a page it returns to the top bar; from the top bar it
 * leaves the screen. A press something on the page has already consumed (clearing a field,
 * closing a panel) does neither, and a held Back never leaves: only a fresh press does.
 */
export type BackAction = "focus-top-bar" | "leave";

export function backAction({ key, keyCode = 0, editable, handled, inTopBar, repeat = false }: { key: string; keyCode?: number; editable: boolean; handled: boolean; inTopBar: boolean; repeat?: boolean }): BackAction | null {
  if (handled || !isBackKey(key, editable, keyCode)) return null;
  if (inTopBar) return repeat ? null : "leave";
  return "focus-top-bar";
}

/**
 * Where leaving a screen goes: its parent. Home, Discover, Catalog, Movie Jam and Community are
 * siblings under the home; a jam's screens sit under Movie Jam; the script goes back to its setup; a film page goes
 * back to wherever it was opened from, or to search when it was reached by URL. The home has no
 * parent: Back there belongs to the platform.
 */
export function parentPath(screen: Screen, filmOpen: boolean, from: string | null): string | null {
  if (filmOpen) return from ?? DISCOVER_PATH;
  switch (screen) {
    // Neither is inside the app's back stack: Back on both belongs to the platform, and the
    // home never falls back to the landing.
    case "landing":
    case "home":
      return null;
    case "discover":
    case "catalog":
    case "jams":
    case "community":
    case "join":
    // Not a destination, but read from anywhere; Back leaves it for the home like the rest.
    case "about":
      return HOME_PATH;
    // The door is a sibling of the home; the form below it returns to the door.
    case "create":
      return HOME_PATH;
    case "newJam":
      return CREATE_PATH;
    case "studio":
    // A Director session is opened from the Movie Jam list, and Back returns there.
    case "director":
      return JAMS_PATH;
    case "script":
      return NEW_JAM_PATH;
  }
}

/**
 * How to reach the parent: step back through history when the entry behind is the parent (and
 * is still the entry this one was opened from), so browser history stays truthful; otherwise
 * replace this entry with the parent, so a chain of Backs never replays screens the viewer has
 * already left.
 */
export type LeaveAction = { kind: "history-back" } | { kind: "replace"; path: string };

export function leaveAction({ screen, filmOpen, from, behindIntact = true }: { screen: Screen; filmOpen: boolean; from: string | null; behindIntact?: boolean }): LeaveAction | null {
  const parent = parentPath(screen, filmOpen, from);
  if (parent === null) return null;
  return from === parent && behindIntact ? { kind: "history-back" } : { kind: "replace", path: parent };
}
