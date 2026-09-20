import type { ReactNode } from "react";
import type { CatalogueTitle } from "../catalogue/contract";
import type { Critique } from "../conversation/contract";
import type { Line } from "../conversation/transcript";
import type { CardHover } from "./ResultCard";
import { ResultRow, ResultRowWaiting } from "./ResultRow";
import type { TurnBlock } from "./results";

type SearchTranscriptProps = {
  blocks: readonly TurnBlock[];
  /** Answer lines still being answered; only those without films yet show they are waiting. */
  waiting: ReadonlySet<number>;
  /** A message is on its way to the assistant. */
  pending: boolean;
  cellProps: (row: string, index: number) => { "data-row": string; "data-index": number; tabIndex: number };
  onOpen: (title: CatalogueTitle, card: HTMLElement, critique: Critique | null) => void;
  hover: CardHover;
  /** What is being said and not yet sent, drawn as the conversation's next line. */
  children?: ReactNode;
};

const SPOKEN_BY: Record<Line["speaker"], string> = { viewer: "You said: ", assistant: "Assistant: ", system: "Notice: " };

/** The row key for a turn's films, as the remote navigation knows it. */
export function turnRow(turn: number) {
  return `turn-${turn}`;
}

/**
 * The conversation, one block per turn, newest at the bottom: what the viewer said, what came
 * back, and under it the films that turn produced. Earlier turns keep their own films, so
 * scrolling back shows how the search narrowed.
 */
export function SearchTranscript({ blocks, waiting, pending, cellProps, onOpen, hover, children }: SearchTranscriptProps) {
  const last = blocks.at(-1);
  return (
    <section className="search-transcript" role="log" aria-label="Conversation">
      <ol className="search-turns">
        {blocks.map((block) => {
          const said = block.lines.find(({ speaker }) => speaker === "viewer")?.text;
          const preparing = !block.answer && block.lines.some(({ id }) => waiting.has(id));
          const thinking = pending && block === last && block.lines.every(({ speaker }) => speaker === "viewer");
          return (
            <li key={block.turn} className="search-turn" data-block="">
              {block.lines.map((line) => (
                <p key={line.id} className={`search-line search-line-${line.speaker}${line.question ? " search-line-question" : ""}`}>
                  <span className="sr-only">{SPOKEN_BY[line.speaker]}</span>
                  {line.text}
                </p>
              ))}
              {thinking && (
                <p className="search-line search-line-assistant search-line-thinking" role="status">
                  <span className="search-thinking" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="sr-only">Thinking…</span>
                </p>
              )}
              {block.answer && (
                <ResultRow
                  rowKey={turnRow(block.turn)}
                  results={block.answer.results}
                  label={said ? `Films for “${said}”` : "Films"}
                  cellProps={cellProps}
                  onOpen={onOpen}
                  hover={hover}
                />
              )}
              {preparing && <ResultRowWaiting />}
            </li>
          );
        })}
      </ol>
      {children}
    </section>
  );
}
