import type { PointerEvent } from "react";
import type { CatalogueTitle } from "../catalogue/contract";
import type { Critique } from "../conversation/contract";
import { Artwork } from "../discover/Artwork";

/** Resting the pointer on a card, as the screen's dwell listens for it. */
export type CardHover = {
  onPointerMove: (title: CatalogueTitle, critique: Critique | null, event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
};

type ResultCardProps = {
  title: CatalogueTitle;
  pick: boolean;
  reason: string | null;
  /** What the critic wrote about this pick, when it wrote anything. */
  critique: Critique | null;
  /** Where the remote finds it: its row, its place, and whether it is the row's way in. */
  navigation: { "data-row": string; "data-index": number; tabIndex: number };
  onOpen: (title: CatalogueTitle, card: HTMLElement, critique: Critique | null) => void;
  hover: CardHover;
};

/** What a card says about itself when it is read aloud: exactly what it shows, in reading order. */
function spokenName(title: CatalogueTitle, pick: boolean, reason: string | null, critique: Critique | null): string {
  const said = [title.title, title.year ? `, ${title.year}` : "", pick ? ", top pick" : ""];
  if (critique) said.push(`. Why it’s here: ${critique.why} One reservation: ${critique.reservation}`);
  else if (reason) said.push(`. Why it’s here: ${reason}`);
  return said.join("");
}

/**
 * One film in an answer: the poster, with the title and year beneath it. Click, OK, or resting a
 * pointer on it opens its preview. Focus alone never does, so a remote can sweep a row freely.
 *
 * A pick the critic wrote about carries its note here, beside the poster it is about, so "why
 * this one" is answered without leaving the row: why it was picked, and the one thing against it.
 * What watching it is like is the longest of the three and is the preview's. On a phone a column
 * this narrow cannot hold a paragraph, so the note is cut to its opening there and the whole of
 * it opens with the film.
 */
export function ResultCard({ title, pick, reason, critique, navigation, onOpen, hover }: ResultCardProps) {
  return (
    <li className={`search-card-slot${critique ? " search-card-slot-noted" : ""}`}>
      <button
        type="button"
        className={`search-card${critique ? " search-card-noted" : ""}`}
        aria-label={spokenName(title, pick, reason, critique)}
        {...navigation}
        onClick={(event) => onOpen(title, event.currentTarget, critique)}
        onKeyDown={(event) => {
          // OK opens it once, here: a held OK's repeats arrive already taken.
          if (event.defaultPrevented || event.key !== "Enter") return;
          event.preventDefault();
          onOpen(title, event.currentTarget, critique);
        }}
        onPointerMove={(event) => hover.onPointerMove(title, critique, event)}
        onPointerLeave={hover.onPointerLeave}
      >
        <span className="search-card-poster">
          <Artwork title={title} className="search-card-art" />
          {pick && <span className="search-card-pick">Top pick</span>}
        </span>
        <span className="search-card-body">
          <span className="search-card-title">{title.title}</span>
          <span className="search-card-year">{title.year ?? " "}</span>
          {critique && (
            <span className="search-card-note" aria-hidden="true">
              <span className="search-card-why">{critique.why}</span>
              <span className="search-card-against">
                <span className="search-card-against-label">But</span> {critique.reservation}
              </span>
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
