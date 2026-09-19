import type { PointerEvent } from "react";
import type { CatalogueTitle } from "../catalogue/contract";
import { Artwork } from "../discover/Artwork";

/** Resting the pointer on a card, as the screen's dwell listens for it. */
export type CardHover = {
  onPointerMove: (title: CatalogueTitle, event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
};

type ResultCardProps = {
  title: CatalogueTitle;
  pick: boolean;
  reason: string | null;
  /** Where the remote finds it: its row, its place, and whether it is the row's way in. */
  navigation: { "data-row": string; "data-index": number; tabIndex: number };
  onOpen: (title: CatalogueTitle, card: HTMLElement) => void;
  hover: CardHover;
};

/**
 * One film in an answer: the poster, with the title and year beneath it. Click, OK, or resting a
 * pointer on it opens its preview. Focus alone never does, so a remote can sweep a row freely.
 */
export function ResultCard({ title, pick, reason, navigation, onOpen, hover }: ResultCardProps) {
  const name = [title.title, title.year ? `, ${title.year}` : "", pick ? ", top pick" : "", reason ? `. Why it’s here: ${reason}` : ""].join("");
  return (
    <li className="search-card-slot">
      <button
        type="button"
        className="search-card"
        aria-label={name}
        {...navigation}
        onClick={(event) => onOpen(title, event.currentTarget)}
        onKeyDown={(event) => {
          // OK opens it once, here: a held OK's repeats arrive already taken.
          if (event.defaultPrevented || event.key !== "Enter") return;
          event.preventDefault();
          onOpen(title, event.currentTarget);
        }}
        onPointerMove={(event) => hover.onPointerMove(title, event)}
        onPointerLeave={hover.onPointerLeave}
      >
        <span className="search-card-poster">
          <Artwork title={title} className="search-card-art" />
          {pick && <span className="search-card-pick">Top pick</span>}
        </span>
        <span className="search-card-title">{title.title}</span>
        <span className="search-card-year">{title.year ?? " "}</span>
      </button>
    </li>
  );
}
