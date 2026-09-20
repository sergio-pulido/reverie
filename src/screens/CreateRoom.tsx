import {
  PORTION_ABSOLUTE_MAX_SECONDS,
  PORTION_ABSOLUTE_MIN_SECONDS,
  TOTAL_MAX_SECONDS,
  TOTAL_MIN_SECONDS,
} from "../core/script";
import type { FormEvent } from "react";
import { Footer, HowItWorks, LiveScene } from "../chrome";
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

type CreateRoomProps = {
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
 * The Movie Jam screen: where a jam is started. It is also where a Jam is explained, because this
 * is where knowing how one works helps.
 */
export function CreateRoom({ title, premise, visibility, sourceKind, importedScript, scenarios, scenarioId, scenariosNotice, onScenarioId, totalSeconds, portionMinSeconds, portionMaxSeconds, onTitle, onPremise, onVisibility, onSourceKind, onImportedScript, onTotalSeconds, onPortionMinSeconds, onPortionMaxSeconds, onSubmit, isCreating, notice }: CreateRoomProps) {
  return <main className="site-shell setup-shell"><TopBar current="jam" /><section className="setup-layout setup-layout-explained">
    <div className="setup-intro"><p className="eyebrow">NEW MOVIE JAM</p><h1>Set the first <em>scene.</em></h1><p className="intro">Start from a prompt and let Reverie write, bring an existing script into its own room, or take the room into an escape room and see what it does.</p></div>
    <form className="room-form" onSubmit={onSubmit}>
      <label>Jam title<input value={title} onChange={(event) => onTitle(event.target.value)} maxLength={72} required /></label>
      <div className="jam-kind" role="radiogroup" aria-label="Story source">
        <button type="button" role="radio" aria-checked={sourceKind === "from-scratch"} className={sourceKind === "from-scratch" ? "active" : ""} onClick={() => onSourceKind("from-scratch")}>From scratch</button>
        <button type="button" role="radio" aria-checked={sourceKind === "import-script"} className={sourceKind === "import-script" ? "active" : ""} onClick={() => onSourceKind("import-script")}>Import a script</button>
        <button type="button" role="radio" aria-checked={sourceKind === "escape-room"} className={sourceKind === "escape-room" ? "active" : ""} onClick={() => onSourceKind("escape-room")}>Escape room</button>
      </div>
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
      <label>Who can join?<select value={visibility} onChange={(event) => onVisibility(event.target.value as JamVisibility)}><option value="invite_only">Invite only</option><option value="public">Public room</option></select></label>
      <p className="form-note">{hasSupabaseConfiguration() ? "This room will receive its own persistent URL." : "Supabase is not configured yet, so this creates a clearly labelled local preview."} {sourceKind === "escape-room" ? "The scenario is written into this repository; the film is whatever the room makes the character do." : "The script is an original generated work — never a copy of an existing film."}</p>
      <button className="button button-primary form-submit" type="submit" disabled={isCreating || (sourceKind === "escape-room" && !scenarioId)}>{submitLabel(sourceKind, isCreating, totalSeconds)}<span>↗</span></button>
      {notice && <aside className="notice" role="alert"><span className="notice-dot" />{notice}</aside>}
    </form>
    <div className="setup-scene"><LiveScene compact /></div>
  </section>
  <HowItWorks />
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

function submitLabel(sourceKind: SourceKind, isCreating: boolean, totalSeconds: number): string {
  if (sourceKind === "escape-room") return isCreating ? "Opening the room…" : "Open the room";
  if (isCreating) return `Writing your ${totalSeconds}-second script…`;
  return "Write the script";
}
