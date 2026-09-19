import type { CSSProperties } from "react";
import type { CatalogueTitle } from "../catalogue/contract";
import { Artwork } from "../discover/Artwork";
import type { VoicePhase } from "../voice/voiceState";
import type { Detected } from "./detect";

type PendingVoiceProps = {
  phase: VoicePhase;
  /** Input level, 0–1, while recording. */
  level: number;
  /** What has been heard so far, or the transcript waiting in the field once recording stopped. */
  text: string;
  detected: readonly Detected[];
  /** Posters read against what was heard; null while there is nothing to preview. */
  titles: readonly CatalogueTitle[] | null;
};

const STATUS: Record<VoicePhase, string> = {
  idle: "Not sent yet",
  starting: "Opening the microphone",
  recording: "Listening",
  transcribing: "Finishing",
};

/**
 * What the viewer is saying, as the conversation's next line before it is one. It fills with the
 * partial transcript as it arrives, grows a chip for each preference heard, and previews posters
 * against them, so something answers while a person is still talking. None of it is sent: once
 * recording stops the transcript waits in the field, and only the viewer sends it.
 */
export function PendingVoice({ phase, level, text, detected, titles }: PendingVoiceProps) {
  const waiting = phase === "idle";
  return (
    <section className={`search-pending search-pending-${phase}`} data-block="" aria-label="What you are saying, not sent yet">
      <p className="search-line search-line-viewer search-line-pending" aria-live="polite">
        <span className="search-pending-status">
          {phase === "recording" && (
            <span className="search-listening" aria-hidden="true" style={{ "--voice-level": level.toFixed(3) } as CSSProperties}>
              <i />
              <i />
              <i />
            </span>
          )}
          {STATUS[phase]}
        </span>
        {text ? <span className="search-pending-text">{text}</span> : <span className="search-pending-placeholder">Go ahead…</span>}
      </p>

      {detected.length > 0 && (
        <ul className="search-heard" aria-label="Heard so far">
          {detected.map((item) => (
            <li key={item.key} className={`search-heard-chip${item.kind === "genre" && item.refused ? " search-heard-refused" : ""}`}>
              {item.label}
            </li>
          ))}
        </ul>
      )}

      {titles && titles.length > 0 && (
        <div className="search-results search-results-preview" aria-hidden="true">
          <p className="search-results-caption">Preview · not sent yet</p>
          <ul className="search-track">
            {titles.map((title) => (
              <li key={title.id} className="search-card-slot">
                <span className="search-card search-card-still">
                  <span className="search-card-poster">
                    <Artwork title={title} className="search-card-art" />
                  </span>
                  <span className="search-card-title">{title.title}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {waiting && <p className="search-pending-hint">Press OK to send it, or change it first.</p>}
    </section>
  );
}
