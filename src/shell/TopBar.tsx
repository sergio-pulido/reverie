import type { KeyboardEvent, MouseEvent } from "react";
import { AccountMenu } from "./AccountMenu";
import { BAR_DESTINATIONS, DESTINATION_PATH, HOME_PATH, type Destination } from "../lib/routes";
import { useShell } from "./ShellContext";
import { focusFirstContent, scrollPageBelow, topBarItems } from "./topBarFocus";

const LABELS: Readonly<Record<Destination, string>> = {
  home: "Home",
  discover: "Discover",
  catalog: "Catalog",
  create: "Create",
  jam: "Yours",
};

/**
 * The one top bar, rendered at the top of every screen: the brand, the five destinations
 * (Discover marked by its lens as well as its name) and, at the trailing edge, the viewer's
 * account. It holds no text field: choosing Discover opens it with its own field focused.
 *
 * `current` is the destination the screen belongs to, or null on a screen that belongs to none
 * (About), where nothing on the bar is marked as the page.
 *
 * It scrolls away with the page. A remote reaches it again with Up from the first row, or with
 * Back from anywhere on the page. Left and Right move along it, Down returns to the page: to
 * `onEnterPage` when the screen steers its own rows, otherwise to the first thing below the bar,
 * or, on a page with nothing to focus, a step further down the page.
 */
export function TopBar({ current, onEnterPage }: { current: Destination | null; onEnterPage?: () => void }) {
  const shell = useShell();

  function follow(event: MouseEvent<HTMLAnchorElement>, action: () => void) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    action();
  }

  return (
    <nav className="top-bar" data-top-bar="" aria-label="Primary" onKeyDown={(event) => moveAlongBar(event, onEnterPage)}>
      {/* The brand leads home for a pointer; a remote reaches home through the first destination. */}
      <a className="top-bar-brand" href={HOME_PATH} tabIndex={-1} aria-label="Reverie home" onClick={(event) => follow(event, () => shell.go("home"))}>
        <span className="top-bar-brand-mark" aria-hidden="true">✳</span>
        <span className="top-bar-brand-name" aria-hidden="true">REVERIE</span>
      </a>
      <ul className="top-bar-destinations">
        {BAR_DESTINATIONS.map((id) => (
          <li key={id}>
            <a
              className="top-bar-item"
              data-top-bar-item=""
              href={DESTINATION_PATH[id]}
              aria-current={id === current ? "page" : undefined}
              onClick={(event) => follow(event, () => shell.go(id))}
            >
              {id === "discover" && <SearchIcon />}
              {LABELS[id]}
            </a>
          </li>
        ))}
      </ul>
      <AccountMenu />
    </nav>
  );
}

/** Left and Right walk the bar and stop at its ends; Down goes into the page; Up stays; OK chooses. */
function moveAlongBar(event: KeyboardEvent<HTMLElement>, onEnterPage?: () => void) {
  const bar = event.currentTarget;
  const items = topBarItems(bar);
  const index = items.indexOf(event.target as HTMLElement);
  if (index < 0 || event.defaultPrevented) return;
  switch (event.key) {
    case "Enter":
      // Chosen once, here, rather than left to the browser's own activation of the link.
      event.preventDefault();
      items[index].click();
      return;
    case "ArrowLeft":
    case "ArrowRight": {
      event.preventDefault();
      items[event.key === "ArrowRight" ? Math.min(index + 1, items.length - 1) : Math.max(index - 1, 0)]?.focus();
      return;
    }
    case "ArrowDown":
      event.preventDefault();
      if (onEnterPage) onEnterPage();
      else if (!focusFirstContent(bar)) scrollPageBelow(bar);
      return;
    case "ArrowUp":
      event.preventDefault();
  }
}

/** A lens and a handle, drawn for Reverie. */
function SearchIcon() {
  return (
    <svg className="top-bar-search-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <path d="M15.4 15.4 21 21" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
