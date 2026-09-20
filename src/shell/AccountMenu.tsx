import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { safeMessageOf } from "../lib/errors";
import { avatarColour, initialsOf } from "./avatar";
import { isBackKey } from "./keys";
import { useShell } from "./ShellContext";
import { useViewer } from "./ViewerContext";

const MENU_ITEM = "[data-account-item]";

/**
 * The viewer, at the trailing edge of the top bar: a circle in a colour derived from their
 * Supabase user id, carrying the initials of the name they gave a room.
 *
 * It shows the anonymous session the app actually signed them in to — the one RLS checks — so
 * there is nothing to fabricate. With no name yet it shows a neutral mark and no initials, never
 * an invented name, email or photo.
 *
 * For a remote it is the last stop on the bar's Left/Right axis (it carries `data-top-bar-item`,
 * so the bar walks onto it). OK opens the menu and focus moves into it; Up and Down move through
 * its items; Back or Escape closes it and returns focus to the circle. While it is open focus is
 * trapped: Tab cycles inside it and the keys the menu takes never reach the bar underneath.
 */
export function AccountMenu() {
  const viewer = useViewer();
  const shell = useShell();
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const avatar = useRef<HTMLButtonElement>(null);

  const initials = initialsOf(viewer.displayName);

  /** The menu's items, in the order Up and Down walk them. */
  function items(): HTMLElement[] {
    return Array.from(root.current?.querySelectorAll<HTMLElement>(MENU_ITEM) ?? []);
  }

  /** Opening hands focus to the first item, so a remote is inside the menu it just opened. */
  useEffect(() => {
    if (open) items()[0]?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    setFailure(null);
    avatar.current?.focus();
  }

  /** A pointer used elsewhere dismisses the menu, without stealing focus back to the circle. */
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target || !root.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("pointerdown", dismiss, true);
    return () => window.removeEventListener("pointerdown", dismiss, true);
  }, [open]);

  async function logOut() {
    setFailure(null);
    try {
      await shell.logOut();
    } catch (error) {
      // Staying open and saying so beats navigating away as if the session had ended.
      setFailure(safeMessageOf(error, "You could not be signed out."));
    }
  }

  function moveInMenu(event: KeyboardEvent<HTMLElement>) {
    const all = items();
    const index = all.indexOf(event.target as HTMLElement);
    if (index < 0 || event.defaultPrevented) return;
    if (isBackKey(event.key, false, event.keyCode)) {
      event.preventDefault();
      close();
      return;
    }
    switch (event.key) {
      case "Enter":
        // Chosen once, here, as the bar chooses its own destinations, rather than left to the
        // browser's activation of the button.
        event.preventDefault();
        all[index].click();
        return;
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        all[event.key === "ArrowDown" ? Math.min(index + 1, all.length - 1) : Math.max(index - 1, 0)]?.focus();
        return;
      case "Tab":
        // The trap: Tab never leaves the menu while it is open.
        event.preventDefault();
        all[(index + (event.shiftKey ? all.length - 1 : 1)) % all.length]?.focus();
        return;
      case "ArrowLeft":
      case "ArrowRight":
        // The bar's own axis stops at the circle while the menu is open.
        event.preventDefault();
    }
  }

  return (
    <div className="top-bar-account" ref={root} onKeyDown={moveInMenu}>
      <button
        type="button"
        ref={avatar}
        className="account-avatar"
        data-top-bar-item=""
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={viewer.displayName ? `Account: ${viewer.displayName}` : "Account"}
        style={{ backgroundColor: avatarColour(viewer.userId) }}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {initials
          ? <span aria-hidden="true">{initials}</span>
          // No name to draw from: a neutral mark, not a guessed letter.
          : <span className="account-avatar-neutral" aria-hidden="true" />}
      </button>
      {open && (
        <div className="account-menu" role="menu" aria-label="Account">
          <p className="account-menu-name">{viewer.displayName ?? "Signed in"}</p>
          {/* Present and focusable on purpose. The account screen is not built yet, and this
              opens nothing rather than pretending it does. */}
          <button type="button" className="account-menu-item" role="menuitem" data-account-item="">Account</button>
          {/* Not a destination on the bar, so this and the page's footer are how it is reached. */}
          <button type="button" className="account-menu-item" role="menuitem" data-account-item="" onClick={() => { close(); shell.openAbout(); }}>About Reverie</button>
          <button type="button" className="account-menu-item" role="menuitem" data-account-item="" onClick={logOut}>Log out</button>
          {failure && <p className="account-menu-failure" role="alert">{failure}</p>}
        </div>
      )}
    </div>
  );
}
