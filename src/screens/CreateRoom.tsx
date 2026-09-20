import {
  PORTION_ABSOLUTE_MAX_SECONDS,
  PORTION_ABSOLUTE_MIN_SECONDS,
  TOTAL_MAX_SECONDS,
  TOTAL_MIN_SECONDS,
} from "../core/script";
import type { FormEvent, ReactNode } from "react";
import { Footer, HowItWorks, LiveScene } from "../chrome";
import type { CreateWay } from "../create/CreateScreen";
import type { ScenarioCard } from "../lib/escapeRoom";
import type { JamVisibility } from "../lib/jams";
import { hasSupabaseConfiguration } from "../lib/supabase";
import { TopBar } from "../shell/TopBar";

/**
 * Where a jam's story comes from. An escape room is the third: a fixed world
 * and a goal, authored as data in this repository, which the room shares
 * control of one character inside. It is a source, not a separate product —
 * the invite, the lobby, the roster and the room screen are the jam's.
 */
export type SourceKind = "from-scratch" | "import-script" | "escape-room";

/** What the screen calls itself, and what it says it is about to make, for each of the three. */
const INTRO: Readonly<Record<CreateWay, { eyebrow: string; title: ReactNode; lede: string }>> = {
  director: {
    eyebrow: "NEW DIRECTOR SESSION",
    title: <>Set the first <em>scene.</em></>,
    lede: "Start from a prompt and let Reverie write the screenplay, or bring one you already have. It opens in your own Director session: you, the film, and nobody to wait for.",
  },
  jam: {
    eyebrow: "NEW MOVIE JAM",
    title: <>Set the first <em>scene.</em></>,
    lede: "Start from a prompt and let Reverie write the screenplay, or bring one you already have into its own room. Then invite the people you want directing it with you.",
  },
  escape: {
    eyebrow: "NEW ESCAPE ROOM",
    title: <>Choose the <em>place.</em></>,
    lede: "The world and the way out are already written. Your room shares control of one character inside it, and the film is whatever they make them do.",
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
 * and never the escape room. What a Jam is, below, is shown only when this is one.
 */
export function CreateRoom({ way, title, premise, visibility, sourceKind, importedScript, scenarios, scenarioId, scenariosNotice, onScenarioId, totalSeconds, portionMinSeconds, portionMaxSeconds, onTitle, onPremise, onVisibility, onSourceKind, onImportedScript, onTotalSeconds, onPortionMinSeconds, onPortionMaxSeconds, onSubmit, isCreating, notice }: CreateRoomProps) {
  return <main className="site-shell setup-shell"><TopBar current="create" /><section className="setup-layout setup-layout-explained">
    <div className="setup-intro"><p className="eyebrow">{INTRO[way].eyebrow}</p><h1>{INTRO[way].title}</h1><p className="intro">{INTRO[way].lede}</p></div>
    <form className="room-form" onSubmit={onSubmit}>
      <label>{TITLE_LABEL[way]}<input value={title} onChange={(event) => onTitle(event.target.value)} maxLength={72} required /></label>
      {/* An escape room's story IS the room, so there is nothing to choose between here. */}
      {way !== "escape" && <div className="jam-kind" role="radiogroup" aria-label="Story source">
        <button type="button" role="radio" aria-checked={sourceKind === "from-scratch"} className={sourceKind === "from-scratch" ? "active" : ""} onClick={() => onSourceKind("from-scratch")}>From scratch</button>
        <button type="button" role="radio" aria-checked={sourceKind === "import-script"} className={sourceKind === "import-script" ? "active" : ""} onClick={() => onSourceKind("import-script")}>Import a script</button>
      </div>}
      {sourceKind === "from-scratch" && (
        <label>Opening premise<textarea value={premise} onChange={(event) => onPremise(event.target.value)} minLength={8} maxLength={280} required /></label>
      )}
      {sourceKind === "import-script" && (
        <label>Existing script<textarea value={importedScript} onChange={(event) => onImportedScript(event.target.value)} minLength={40} maxLength={9000} placeholder="Paste the script this jam should use…" required /></label>
      )}
      {sourceKind === "escape-room" && (
        <ScenarioPicker scenarios={scenarios} scenarioId={scenarioId} notice={scenariosNotice} onChoose={onScenarioId} />
      )}
      {sourceKind !== "escape-room" && <div className="format-row" role="group" aria-label="Script length">
        <label>Total length (s)<input type="number" min={TOTAL_MIN_SECONDS} max={TOTAL_MAX_SECONDS} step={1} value={totalSeconds} onChange={(event) => onTotalSeconds(Number(event.target.value))} required /></label>
        <label>Shortest portion (s)<input type="number" min={PORTION_ABSOLUTE_MIN_SECONDS} max={PORTION_ABSOLUTE_MAX_SECONDS} value={portionMinSeconds} onChange={(event) => onPortionMinSeconds(Number(event.target.value))} required /></label>
        <label>Longest portion (s)<input type="number" min={PORTION_ABSOLUTE_MIN_SECONDS} max={PORTION_ABSOLUTE_MAX_SECONDS} value={portionMaxSeconds} onChange={(event) => onPortionMaxSeconds(Number(event.target.value))} required /></label>
      </div>}
      {/* Alone is alone: a Director session has nobody to admit, so it is registered invite-only. */}
      {way !== "director" && <label>Who can join?<select value={visibility} onChange={(event) => onVisibility(event.target.value as JamVisibility)}><option value="invite_only">Invite only</option><option value="public">Public room</option></select></label>}
      <p className="form-note">{hasSupabaseConfiguration() ? "This room will receive its own persistent URL." : "Supabase is not configured yet, so this creates a clearly labelled local preview."} {sourceKind === "escape-room" ? "The scenario is written into this repository; the film is whatever the room makes the character do." : "The script is an original generated work — never a copy of an existing film."}</p>
      <button className="button button-primary form-submit" type="submit" disabled={isCreating || (sourceKind === "escape-room" && !scenarioId)}>{submitLabel(way, sourceKind, isCreating, totalSeconds)}<span>↗</span></button>
      {notice && <aside className="notice" role="alert"><span className="notice-dot" />{notice}</aside>}
    </form>
    <div className="setup-scene"><LiveScene compact /></div>
  </section>
  {/* What a Jam is, told to someone about to start one. Only they are about to start one. */}
  {way === "jam" && <HowItWorks />}
  <Footer />
  </main>;
}

/** The rooms this build ships, listed from the server rather than hard-coded here. */
function ScenarioPicker({ scenarios, scenarioId, notice, onChoose }: {
  scenarios: readonly ScenarioCard[];
  scenarioId: string;
  notice: string | null;
  onChoose: (value: string) => void;
}) {
  if (notice) return <p className="form-note">{notice}</p>;
  if (scenarios.length === 0) return <p className="form-note">Looking for the rooms this server ships…</p>;
  return <div className="scenario-picker" role="radiogroup" aria-label="Escape room">
    {scenarios.map((scenario) => <button
      key={scenario.id}
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
  if (sourceKind === "escape-room") return isCreating ? "Opening the room…" : "Open the room";
  if (isCreating) return `Writing your ${totalSeconds}-second script…`;
  return way === "director" ? "Write it and direct" : "Write the script";
}
