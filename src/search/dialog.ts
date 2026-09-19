import type { KeyboardEvent } from "react";
import { isBackKey } from "../shell/keys";
import { isEditable } from "../shell/topBarFocus";

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The controls inside `dialog` a viewer can reach, in reading order. */
export function focusables(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/**
 * Keys every dialog on the search screen shares. Back (Escape, a remote's Back, its key codes)
 * closes it, and is taken so the app does not also treat it as Back. Tab and Shift+Tab go round
 * the dialog's own controls and never leave it. Answers whether the key was taken.
 */
export function dialogKey(event: KeyboardEvent<HTMLElement>, onClose: () => void): boolean {
  if (event.defaultPrevented) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (isBackKey(event.key, isEditable(target), event.keyCode)) {
    event.preventDefault();
    if (!event.repeat) onClose();
    return true;
  }
  if (event.key === "Tab") {
    const controls = focusables(event.currentTarget);
    if (controls.length === 0) return false;
    const at = controls.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (at <= 0 ? controls.length - 1 : at - 1) : at === controls.length - 1 ? 0 : at + 1;
    event.preventDefault();
    controls[next].focus();
    return true;
  }
  return false;
}
