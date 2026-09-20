import { useSyncExternalStore } from "react";
import { TmdbAttribution } from "../discover/TmdbAttribution";
import { Footer } from "../chrome";
import type { ScenarioCard } from "../lib/escapeRoom";
import { TopBar } from "../shell/TopBar";
import { focusTopBar } from "../shell/topBarFocus";
import { useRows } from "../shell/useRows";
import { ModeIllustration } from "./ModeIllustration";

/** Only the three existing flows can be opened. Exam is a preview, not a fourth route. */
export type CreateWay = "director" | "jam" | "escape";
type WayCard = { way: CreateWay | "exam"; name: string; who: string; blurb: string };
const WAYS: readonly WayCard[] = [
  { way: "director", name: "Director", who: "Your own film", blurb: "Make your own film from a prompt or a script, then open your Director session with nobody to wait for." },
  { way: "jam", name: "Movie Jam", who: "Create together", blurb: "Bring a room together around one screenplay, sharing ideas and proposals for where the film goes next." },
  { way: "escape", name: "Escape Room", who: "Play an authored world", blurb: "Decide together what one character does inside an authored world: the rules resolve each action and the model narrates it." },
  { way: "exam", name: "Exam", who: "Assessment · coming later", blurb: "An escape room for assessment, where an examiner states what they want to see and reviews a candidate’s decisions." },
];

type CreateScreenProps = {
  scenarios: readonly ScenarioCard[];
  scenariosNotice: string | null;
  onChoose: (way: CreateWay) => void;
};

export function CreateScreen({ scenarios, scenariosNotice, onChoose }: CreateScreenProps) {
  const unavailable = scenariosNotice
    ? `Escape rooms are not available here. ${scenariosNotice}`
    : scenarios.length === 0 ? "Looking for the rooms this server ships…" : null;
  const stacked = useSyncExternalStore(subscribeLayout, () => layoutQuery()?.matches ?? false, () => false);
  const rows = useRows(stacked ? WAYS.map(({ way }) => ({ key: way, count: 1 })) : [{ key: "ways", count: 4 }], { onExitTop: () => { focusTopBar(); } });
  const cardProps = (way: WayCard["way"], index: number) => rows.cellProps(stacked ? way : "ways", stacked ? 0 : index);
  return <main className="site-shell create-shell">
    <TopBar current="create" onEnterPage={() => { rows.focusCell(stacked ? "director" : "ways", 0); }} />
    <section className="create-layout" ref={rows.containerRef} onFocus={rows.onFocus} onKeyDown={rows.onKeyDown}>
      <header className="create-head"><p className="eyebrow">MAKE SOMETHING</p><h1>Four ways <em>in.</em></h1><p className="intro">Your film, a shared screenplay, an authored world, or an assessment. Choose an available experience; Exam is still to come.</p></header>
      <ul className="create-ways">{WAYS.map((card, index) => {
        const way = card.way;
        const notice = way === "exam" ? "Not open yet. Assessment creation is not available." : way === "escape" ? unavailable : null;
        return <li key={way}><article className={`create-way mode-${way}${notice ? " create-way-blocked" : ""}`}>
          <ModeIllustration mode={way} />
          <div className="create-way-copy"><p className="eyebrow">{card.who}</p><h2>{card.name}</h2><p className="create-way-blurb">{card.blurb}</p>
          {notice ? <p className="create-way-notice" role="status" {...cardProps(way, index)}>{notice}</p>
            : <button className="button button-primary" {...cardProps(way, index)} onClick={() => { if (way !== "exam") onChoose(way); }} aria-label={`${card.name}: ${card.who.toLowerCase()}`}>Start {card.name}<span>↗</span></button>}
          </div>
        </article></li>;
      })}</ul>
    </section><TmdbAttribution /><Footer />
  </main>;
}

// Keep the remote's axis in step with create.css, including when the viewport changes.
const layoutQuery = () => typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 950px)") : null;
function subscribeLayout(onChange: () => void) {
  const media = layoutQuery();
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}
