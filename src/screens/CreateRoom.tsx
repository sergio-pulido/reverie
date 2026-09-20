import {
  PORTION_ABSOLUTE_MAX_SECONDS,
  PORTION_ABSOLUTE_MIN_SECONDS,
  TOTAL_MAX_SECONDS,
  TOTAL_MIN_SECONDS,
} from "../core/script";
import type { FormEvent, ReactNode } from "react";
import { Footer } from "../chrome";
import { ModeIllustration } from "../create/ModeIllustration";
import { useRows } from "../shell/useRows";
import { focusTopBar } from "../shell/topBarFocus";
import type { CreateWay } from "../create/CreateScreen";
import type { ScenarioCard } from "../lib/escapeRoom";
import type { JamVisibility } from "../lib/jams";
import { hasSupabaseConfiguration } from "../lib/supabase";
import { TopBar } from "../shell/TopBar";

/**
 * Where a jam's story comes from. An escape room is the third: a fixed world
 * and a goal, authored as data in this repository, which the room shares
 * control of one character inside. The source is an existing API contract;
 * the declared create mode decides which fields are offered here.
 */
export type SourceKind = "from-scratch" | "import-script" | "escape-room";

/** What the screen calls itself, and what it says it is about to make, for each of the three. */
const INTRO: Readonly<Record<CreateWay, { eyebrow: string; title: ReactNode; lede: string }>> = {
  director: {
    eyebrow: "NEW DIRECTOR SESSION",
    title: <>Your film.<br /><em>Your direction.</em></>,
    lede: "Start from a prompt and let Reverie write the screenplay, or bring one you already have. It opens in your own Director session: you, the film, and nobody to wait for.",
  },
  jam: {
    eyebrow: "NEW MOVIE JAM",
    title: <>One screenplay.<br /><em>Many voices.</em></>,
    lede: "Start from a prompt and let Reverie write the screenplay, or bring one you already have into its own room. Then invite people to share ideas and proposals. Voting on Movie Jam proposals and turning them into scenes are not available yet.",
  },
  escape: {
    eyebrow: "NEW ESCAPE ROOM",
    title: <>The world is set.<br /><em>You choose the move.</em></>,
    lede: "Choose an authored scenario for your room to play. You share control of one character; the rules decide what happens, and the model narrates the outcome.",
  },
};

/** What the thing being made is called, so the form never calls a Director session a jam. */
const TITLE_LABEL: Readonly<Record<CreateWay, string>> = { director: "Film title", jam: "Jam title", escape: "Room title" };

type CreateRoomProps = {
  /** Which of the three was chosen at the door. It decides what this form is for. */
  way: CreateWay;
  title: string; premise: string; visibility: JamVisibility;
  sourceKind: SourceKind; importedScript: string;
  scenarios: readonly ScenarioCard[]; scenarioId: string; scenariosNotice: string | null;
  onScenarioId: (value: string) => void;
  totalSeconds: number; portionMinSeconds: number; portionMaxSeconds: number;
  onTitle: (value: string) => void; onPremise: (value: string) => void; onVisibility: (value: JamVisibility) => void;
  onSourceKind: (value: SourceKind) => void; onImportedScript: (value: string) => void;
  onTotalSeconds: (value: number) => void; onPortionMinSeconds: (value: number) => void; onPortionMaxSeconds: (value: number) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void; isCreating: boolean; notice: string | null;
};

/**
 * Where a jam is registered, whichever of the three doors led here.
 *
 * The door has already said what is being made, so this form does not ask again: an escape room
 * shows its rooms and no story source, and the other two offer a prompt or an imported script
 * and never the escape room. No mode is inferred from stored room data.
 */
export function CreateRoom({ way, title, premise, visibility, sourceKind, importedScript, scenarios, scenarioId, scenariosNotice, onScenarioId, totalSeconds, portionMinSeconds, portionMaxSeconds, onTitle, onPremise, onVisibility, onSourceKind, onImportedScript, onTotalSeconds, onPortionMinSeconds, onPortionMaxSeconds, onSubmit, isCreating, notice }: CreateRoomProps) {
  const escape = way === "escape";
  const rows = useRows([
    { key: "title", count: 1 },
    ...(!escape ? [{ key: "source", count: 2 }, { key: "story", count: 1 }, { key: "total", count: 1 }, { key: "min", count: 1 }, { key: "max", count: 1 }] : scenariosNotice ? [] : scenarios.map((scenario) => ({ key: `scenario-${scenario.id}`, count: 1 }))),
    ...(way !== "director" ? [{ key: "visibility", count: 2 }] : []),
    { key: "submit", count: isCreating || (escape && !scenarioId) ? 0 : 1 },
  ], { onExitTop: () => { focusTopBar(); } });
  return <main className={`site-shell setup-shell mode-setup mode-${way}`}><TopBar current="create" onEnterPage={() => { rows.focusCell("title", 0); }} /><section className="setup-layout setup-layout-explained" ref={rows.containerRef} onFocus={rows.onFocus} onKeyDown={rows.onKeyDown}>
    <div className="setup-intro"><p className="eyebrow">{INTRO[way].eyebrow}</p><h1>{INTRO[way].title}</h1><p className="intro">{INTRO[way].lede}</p></div>
    <form className="room-form" aria-label={INTRO[way].eyebrow} onSubmit={onSubmit}>
      <label>{TITLE_LABEL[way]}<input {...rows.cellProps("title", 0)} value={title} onChange={(event) => onTitle(event.target.value)} maxLength={72} required /></label>
      {/* An escape room's story IS the room, so there is nothing to choose between here. */}
      {way !== "escape" && <div className="jam-kind" role="radiogroup" aria-label="Story source">
        <button {...rows.cellProps("source", 0)} type="button" role="radio" aria-checked={sourceKind === "from-scratch"} className={sourceKind === "from-scratch" ? "active" : ""} onClick={() => onSourceKind("from-scratch")}>From scratch</button>
        <button {...rows.cellProps("source", 1)} type="button" role="radio" aria-checked={sourceKind === "import-script"} className={sourceKind === "import-script" ? "active" : ""} onClick={() => onSourceKind("import-script")}>Import a script</button>
      </div>}
      {!escape && sourceKind === "from-scratch" && (
        <label>{way === "director" ? "What is your film about?" : "The room’s starting premise"}<textarea {...rows.cellProps("story", 0)} value={premise} onChange={(event) => onPremise(event.target.value)} minLength={8} maxLength={280} required /></label>
      )}
      {!escape && sourceKind === "import-script" && (
        <label>{way === "director" ? "Your screenplay" : "The screenplay you’ll share"}<textarea {...rows.cellProps("story", 0)} value={importedScript} onChange={(event) => onImportedScript(event.target.value)} minLength={40} maxLength={9000} placeholder="Paste your screenplay…" required /></label>
      )}
      {escape && (
        <ScenarioPicker scenarios={scenarios} scenarioId={scenarioId} notice={scenariosNotice} onChoose={onScenarioId} cellProps={rows.cellProps} />
      )}
      {!escape && <div className="format-row" role="group" aria-label="Script length">
        <label>Total length (s)<input {...rows.cellProps("total", 0)} type="number" min={TOTAL_MIN_SECONDS} max={TOTAL_MAX_SECONDS} step={1} value={totalSeconds} onChange={(event) => onTotalSeconds(Number(event.target.value))} required /></label>
        <label>Shortest portion (s)<input {...rows.cellProps("min", 0)} type="number" min={PORTION_ABSOLUTE_MIN_SECONDS} max={PORTION_ABSOLUTE_MAX_SECONDS} value={portionMinSeconds} onChange={(event) => onPortionMinSeconds(Number(event.target.value))} required /></label>
        <label>Longest portion (s)<input {...rows.cellProps("max", 0)} type="number" min={PORTION_ABSOLUTE_MIN_SECONDS} max={PORTION_ABSOLUTE_MAX_SECONDS} value={portionMaxSeconds} onChange={(event) => onPortionMaxSeconds(Number(event.target.value))} required /></label>
      </div>}
      {/* Alone is alone: a Director session has nobody to admit, so it is registered invite-only. */}
      {way !== "director" && <fieldset className="create-admission"><legend>Who can join?</legend><div className="jam-kind" role="radiogroup" aria-label="Who can join?">
        <button {...rows.cellProps("visibility", 0)} type="button" role="radio" aria-checked={visibility === "invite_only"} className={visibility === "invite_only" ? "active" : ""} onClick={() => onVisibility("invite_only")}>Invite only</button>
        <button {...rows.cellProps("visibility", 1)} type="button" role="radio" aria-checked={visibility === "public"} className={visibility === "public" ? "active" : ""} onClick={() => onVisibility("public")}>Public room</button>
      </div></fieldset>}

      <p className="form-note">{hasSupabaseConfiguration() ? "This room will receive its own persistent URL." : "Supabase is not configured yet, so this creates a clearly labelled local preview."} {escape ? "The scenario is authored; its rules resolve your actions." : sourceKind === "import-script" ? "Your imported screenplay is kept as the starting script." : "Reverie generates an original screenplay from your premise."}</p>
      <button {...rows.cellProps("submit", 0)} className="button button-primary form-submit" type="submit" disabled={isCreating || (sourceKind === "escape-room" && !scenarioId)}>{submitLabel(way, sourceKind, isCreating, totalSeconds)}<span>↗</span></button>
      {notice && <aside className="notice" role="alert"><span className="notice-dot" />{notice}</aside>}
    </form>
    <figure className="setup-scene"><ModeIllustration mode={way} /><figcaption>{way === "director" ? "A screenplay to start from. A Director session of your own." : way === "jam" ? "One shared script. Space for everyone’s ideas." : "An authored world. One character. Your next move."}</figcaption></figure>
  </section>
  <Footer />
  </main>;
}

/** The rooms this build ships, listed from the server rather than hard-coded here. */
function ScenarioPicker({ scenarios, scenarioId, notice, onChoose, cellProps }: {
  scenarios: readonly ScenarioCard[];
  scenarioId: string;
  notice: string | null;
  onChoose: (value: string) => void;
  cellProps: ReturnType<typeof useRows>["cellProps"];
}) {
  if (notice) return <p className="form-note">{notice}</p>;
  if (scenarios.length === 0) return <p className="form-note">Looking for the rooms this server ships…</p>;
  return <div className="scenario-picker" role="radiogroup" aria-label="Escape room">
    {scenarios.map((scenario) => <button
      key={scenario.id}
      {...cellProps(`scenario-${scenario.id}`, 0)}
      type="button"
      role="radio"
      aria-checked={scenarioId === scenario.id}
      // The card's name is its title: the logline and the goal are inside it
      // as text, but a radio with no accessible name is announced as nothing.
      aria-label={scenario.title}
      className={`scenario-card${scenarioId === scenario.id ? " active" : ""}`}
      onClick={() => onChoose(scenario.id)}
    >
      <strong>{scenario.title}</strong>
      <span>{scenario.logline}</span>
      <em>{scenario.characterName} · {scenario.locationCount} location{scenario.locationCount === 1 ? "" : "s"} · {scenario.goal}</em>
    </button>)}
  </div>;
}

function submitLabel(way: CreateWay, sourceKind: SourceKind, isCreating: boolean, totalSeconds: number): string {
  if (way === "escape") return isCreating ? "Opening the escape room…" : "Open escape room";
  if (isCreating) return sourceKind === "import-script" ? "Importing your screenplay…" : `Writing your ${totalSeconds}-second script…`;
  if (way === "director") return sourceKind === "import-script" ? "Import and open Director" : "Write and open Director";
  return sourceKind === "import-script" ? "Import shared screenplay" : "Write shared screenplay";
}
