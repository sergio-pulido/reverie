import type { FormEvent } from "react";
import { Footer, HowItWorks, LiveScene } from "../chrome";
import type { JamVisibility } from "../lib/jams";
import { hasSupabaseConfiguration } from "../lib/supabase";
import { TopBar } from "../shell/TopBar";

export type SourceKind = "from-scratch" | "import-script";

type CreateRoomProps = {
  title: string; premise: string; visibility: JamVisibility;
  sourceKind: SourceKind; importedScript: string;
  totalMinutes: number; portionMinSeconds: number; portionMaxSeconds: number;
  onTitle: (value: string) => void; onPremise: (value: string) => void; onVisibility: (value: JamVisibility) => void;
  onSourceKind: (value: SourceKind) => void; onImportedScript: (value: string) => void;
  onTotalMinutes: (value: number) => void; onPortionMinSeconds: (value: number) => void; onPortionMaxSeconds: (value: number) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void; isCreating: boolean; notice: string | null;
};

/**
 * The Movie Jam screen: where a jam is started. It is also where a Jam is explained, because this
 * is where knowing how one works helps.
 */
export function CreateRoom({ title, premise, visibility, sourceKind, importedScript, totalMinutes, portionMinSeconds, portionMaxSeconds, onTitle, onPremise, onVisibility, onSourceKind, onImportedScript, onTotalMinutes, onPortionMinSeconds, onPortionMaxSeconds, onSubmit, isCreating, notice }: CreateRoomProps) {
  return <main className="site-shell setup-shell"><TopBar current="jam" /><section className="setup-layout setup-layout-explained">
    <div className="setup-intro"><p className="eyebrow">NEW MOVIE JAM</p><h1>Set the first <em>scene.</em></h1><p className="intro">Start from a prompt and let Reverie write, or bring an existing script into its own room.</p></div>
    <form className="room-form" onSubmit={onSubmit}>
      <label>Jam title<input value={title} onChange={(event) => onTitle(event.target.value)} maxLength={72} required /></label>
      <div className="jam-kind" role="radiogroup" aria-label="Story source">
        <button type="button" role="radio" aria-checked={sourceKind === "from-scratch"} className={sourceKind === "from-scratch" ? "active" : ""} onClick={() => onSourceKind("from-scratch")}>From scratch</button>
        <button type="button" role="radio" aria-checked={sourceKind === "import-script"} className={sourceKind === "import-script" ? "active" : ""} onClick={() => onSourceKind("import-script")}>Import a script</button>
      </div>
      {sourceKind === "from-scratch" ? (
        <label>Opening premise<textarea value={premise} onChange={(event) => onPremise(event.target.value)} minLength={8} maxLength={280} required /></label>
      ) : (
        <label>Existing script<textarea value={importedScript} onChange={(event) => onImportedScript(event.target.value)} minLength={40} maxLength={9000} placeholder="Paste the script this jam should use…" required /></label>
      )}
      <div className="format-row" role="group" aria-label="Script length">
        <label>Total length (min)<input type="number" min={0.2} max={15} step={0.1} value={totalMinutes} onChange={(event) => onTotalMinutes(Number(event.target.value))} required /></label>
        <label>Shortest portion (s)<input type="number" min={4} max={60} value={portionMinSeconds} onChange={(event) => onPortionMinSeconds(Number(event.target.value))} required /></label>
        <label>Longest portion (s)<input type="number" min={4} max={60} value={portionMaxSeconds} onChange={(event) => onPortionMaxSeconds(Number(event.target.value))} required /></label>
      </div>
      <label>Who can join?<select value={visibility} onChange={(event) => onVisibility(event.target.value as JamVisibility)}><option value="invite_only">Invite only</option><option value="public">Public room</option></select></label>
      <p className="form-note">{hasSupabaseConfiguration() ? "This room will receive its own persistent URL." : "Supabase is not configured yet, so this creates a clearly labelled local preview."} The script is an original generated work — never a copy of an existing film.</p>
      <button className="button button-primary form-submit" type="submit" disabled={isCreating}>{isCreating ? `Writing your ${totalMinutes}-minute script…` : "Write the script"}<span>↗</span></button>
      {notice && <aside className="notice" role="alert"><span className="notice-dot" />{notice}</aside>}
    </form>
    <div className="setup-scene"><LiveScene compact /></div>
  </section>
  <HowItWorks />
  <Footer />
  </main>;
}
