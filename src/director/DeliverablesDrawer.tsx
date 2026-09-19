import { useRef, useState } from "react";
import type { Deliverable } from "./deliverables";

const STATE_LABEL = {
  ready: "Ready",
  generating: "Generating",
  absent: "Not made",
} as const;

/**
 * What the session can hand over.
 *
 * Every row shows its real state, and a row that is not ready carries no
 * control at all — not a disabled one. A greyed-out Download says "soon";
 * these files are not soon, and two of the four do not exist in this build.
 */
export function DeliverablesDrawer({ items }: { items: readonly Deliverable[] }) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement | null>(null);
  const ready = items.filter((item) => item.state === "ready").length;

  return (
    <div className="director-drawer" data-open={open ? "" : undefined}>
      <button
        type="button"
        ref={toggle}
        className="director-drawer-toggle"
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
      >
        Deliverables
        <span className="director-drawer-count">
          {ready} of {items.length} ready
        </span>
      </button>

      {open && (
        <ul className="director-drawer-list" aria-label="Deliverables">
          {items.map((item) => (
            <li key={item.id} className="director-deliverable" data-state={item.state}>
              <div>
                <p className="director-deliverable-name">
                  {item.name}
                  <span className="director-deliverable-state">{STATE_LABEL[item.state]}</span>
                </p>
                <p className="director-deliverable-detail">{item.detail}</p>
                {item.missing && <p className="director-deliverable-missing">{item.missing}</p>}
              </div>
              <Get item={item} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A control only where there is a file. Nothing at all where there is not. */
function Get({ item }: { item: Deliverable }) {
  if (item.state !== "ready") return null;
  if (item.href) {
    return (
      <a className="button button-quiet" href={item.href} download>
        Download <span aria-hidden="true">↓</span>
      </a>
    );
  }
  if (!item.build) return null;
  return (
    <button type="button" className="button button-quiet" onClick={() => save(item.build!())}>
      Download <span aria-hidden="true">↓</span>
    </button>
  );
}

/** Writes a file this browser already holds, without asking a server for it. */
function save({ filename, text, type }: { filename: string; text: string; type: string }) {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
