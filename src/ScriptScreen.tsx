import { FormEvent, useMemo, useState } from "react";
import { Footer } from "./chrome";
import { JamDirector } from "./screens/JamDirector";
import { OutlinePanel } from "./screens/OutlinePanel";
import { readJamConfiguration, rememberJamSession } from "./lib/jamConfiguration";
import type { Jam } from "./core/jam";
import type { JamSession } from "./core/session";
import { totalDurationSeconds, type JamScript } from "./core/script";
import { formatClock } from "./core/scriptMarkdown";
import { TopBar } from "./shell/TopBar";

const LANGUAGES = [
  ["en", "English"],
  ["es", "Español"],
  ["ca", "Català"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["it", "Italiano"],
  ["pt", "Português"],
  ["ja", "日本語"],
] as const;

type ScriptScreenProps = {
  jam: Jam;
  roomTitle: string;
  onStudio: () => void;
};

export function ScriptScreen({ jam, roomTitle, onStudio }: ScriptScreenProps) {
  // The creator's own session, so the stream runs under the configuration this
  // viewer chose rather than the room default.
  const [session, setSession] = useState<JamSession | null>(null);
  const configuration = useMemo(
    () => session?.settings ?? readJamConfiguration(jam.id),
    [session, jam.id],
  );
  // The screenplay follows the revision the outline describes, not the one
  // the jam was created with: an outline edit rewrites portions underneath.
  const [script, setScript] = useState<JamScript>(jam.script);
  const total = totalDurationSeconds(script);
  const portions = script.scenes.reduce((sum, scene) => sum + scene.portions.length, 0);
  let elapsed = 0;

  return <main className="site-shell setup-shell"><TopBar current="jam" />
    <section className="script-layout" aria-label="Generated jam script">
      <header className="script-head">
        <p className="eyebrow">{roomTitle} · SCRIPT · {formatClock(total)} · {script.scenes.length} SCENES · {portions} PORTIONS</p>
        <h1>{script.title}</h1>
        <p className="intro">{script.logline}</p>
        <p className="jam-note">{jam.source.kind === "imported-script" ? "Imported into this Movie Jam as its own editable script." : "An original generated Movie Jam script — not an existing film or catalogue title."}</p>
        <div className="hero-actions">
          <button className="button button-primary" onClick={onStudio}>Open the studio <span>↗</span></button>
          <a className="button button-quiet" href={`/api/jams/${jam.id}/script.md`} target="_blank" rel="noreferrer">Open as markdown <span>→</span></a>
        </div>
      </header>
      <SessionPanel jam={jam} session={session} onSession={setSession} />
      <JamDirector jamId={jam.id} configuration={configuration} />
      <OutlinePanel jamId={jam.id} canEdit onScript={setScript} />
      {script.scenes.map((scene, sceneIndex) => (
        <article key={sceneIndex} className="jam-scene">
          <h2>Scene {sceneIndex + 1} — {scene.heading}</h2>
          {scene.portions.map((portion, portionIndex) => {
            const start = elapsed;
            elapsed += portion.durationSeconds;
            return (
              <div key={portionIndex} className="jam-portion">
                <p className="jam-portion-time">PORTION {sceneIndex + 1}.{portionIndex + 1} · {formatClock(start)}–{formatClock(elapsed)} · {portion.durationSeconds}s</p>
                <p>{portion.action}</p>
                {portion.dialogue && <p className="jam-dialogue">“{portion.dialogue}”</p>}
                {portion.visualDirection && <p className="jam-visuals">{portion.visualDirection}</p>}
              </div>
            );
          })}
        </article>
      ))}
    </section><Footer />
  </main>;
}

/**
 * One user's seat at the jam: everyone shares the same script, and each
 * session's language and ambientation shape how it plays back for its owner.
 */
function SessionPanel({ jam, session, onSession }: {
  jam: Jam;
  session: JamSession | null;
  onSession: (session: JamSession) => void;
}) {
  const [ownerToken, setOwnerToken] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [language, setLanguage] = useState("en");
  const [ambientation, setAmbientation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const settings = { language, ambientation: ambientation.trim() };
      const response = session
        ? await fetch(`/api/sessions/${session.id}`, {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${ownerToken}`,
            },
            body: JSON.stringify({ settings }),
          })
        : await fetch(`/api/jams/${jam.id}/sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ displayName: displayName.trim(), settings }),
          });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(body?.error?.safeMessage ?? "The session could not be saved.");
        return;
      }
      const saved = body.session as JamSession;
      onSession(saved);
      // Remembered for the studio, which has no session form of its own. The
      // owner token stays in memory here and is never stored.
      rememberJamSession(saved);
      if (body.ownerToken) setOwnerToken(body.ownerToken as string);
      setSaved(true);
    } catch {
      setError("The server could not be reached.");
    } finally {
      setBusy(false);
    }
  }

  return <aside className="session-card" aria-label="Your playback session">
    <p className="eyebrow">{session ? `YOUR SESSION · ${session.owner.displayName}` : "YOUR SESSION"}</p>
    <h2>{session ? "Tune your playback." : "Watch it your way."}</h2>
    <p className="session-note">The room shares one script; your session plays it back in your language and ambientation.</p>
    <form className="session-form" onSubmit={submit}>
      {!session && <label>Your name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={32} required /></label>}
      <label>Language<select value={language} onChange={(event) => setLanguage(event.target.value)}>{LANGUAGES.map(([tag, name]) => <option key={tag} value={tag}>{name}</option>)}</select></label>
      <label>Ambientation<input value={ambientation} onChange={(event) => setAmbientation(event.target.value)} maxLength={280} placeholder="e.g. neon-noir rainy metropolis" /></label>
      {error && <p className="jam-error" role="alert">{error}</p>}
      <div className="hero-actions">
        <button className="button button-primary" type="submit" disabled={busy}>{session ? "Save my playback" : "Start my session"} <span>↗</span></button>
        {session && <a className="button button-quiet" href={`/api/sessions/${session.id}/script.md`} target="_blank" rel="noreferrer">My script view <span>→</span></a>}
      </div>
      {saved && <p className="session-saved" role="status">Saved — this jam now plays back your way.</p>}
    </form>
  </aside>;
}
