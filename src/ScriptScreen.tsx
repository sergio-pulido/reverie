import { Footer, Header } from "./chrome";
import type { Jam } from "./core/jam";
import { totalDurationSeconds } from "./core/script";
import { formatClock } from "./core/scriptMarkdown";

type ScriptScreenProps = {
  jam: Jam;
  roomTitle: string;
  onStudio: () => void;
  onBack: () => void;
};

export function ScriptScreen({ jam, roomTitle, onStudio, onBack }: ScriptScreenProps) {
  const total = totalDurationSeconds(jam.script);
  const portions = jam.script.scenes.reduce((sum, scene) => sum + scene.portions.length, 0);
  let elapsed = 0;

  return <main className="site-shell setup-shell"><Header onHome={onBack} />
    <section className="script-layout" aria-label="Generated jam script">
      <header className="script-head">
        <button className="back-link" onClick={onBack}>← Back to setup</button>
        <p className="eyebrow">{roomTitle} · SCRIPT · {formatClock(total)} · {jam.script.scenes.length} SCENES · {portions} PORTIONS</p>
        <h1>{jam.script.title}</h1>
        <p className="intro">{jam.script.logline}</p>
        <p className="jam-note">An original generated Movie Jam script — not an existing film or catalogue title.</p>
        <div className="hero-actions">
          <button className="button button-primary" onClick={onStudio}>Open the studio <span>↗</span></button>
          <a className="button button-quiet" href={`/api/jams/${jam.id}/script.md`} target="_blank" rel="noreferrer">Open as markdown <span>→</span></a>
        </div>
      </header>
      {jam.script.scenes.map((scene, sceneIndex) => (
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
