import type { CSSProperties, RefObject } from "react";
import { voiceLabel, type VoicePhase } from "../voice/voiceState";

type VoiceButtonProps = {
  phase: VoicePhase;
  /** Input level, 0–1, while recording. */
  level: number;
  secondsLeft: number;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onPress: () => void;
  /** Right from the control, into the text field. */
  onExitRight: () => void;
  onExitUp: () => void;
  onExitDown: () => void;
};

/**
 * The one voice control: OK starts recording, OK again stops it. While recording it turns red,
 * counts down and shows a live level bar, all sized to read from the sofa.
 */
export function VoiceButton({ phase, level, secondsLeft, buttonRef, onPress, onExitRight, onExitUp, onExitDown }: VoiceButtonProps) {
  const recording = phase === "recording";
  const busy = phase === "starting" || phase === "transcribing";
  const accessibleName = recording
    ? "Stop recording"
    : phase === "starting"
      ? "Opening the microphone. Press to cancel."
      : phase === "transcribing"
        ? "Transcribing what you said"
        : "Speak instead of typing";

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`discover-voice discover-voice-${phase}`}
      aria-label={accessibleName}
      aria-pressed={recording}
      aria-busy={busy}
      style={{ "--voice-level": recording ? level.toFixed(3) : "0" } as CSSProperties}
      onClick={onPress}
      onKeyDown={(event) => {
        // OK is handled here rather than left to the browser, so every remote behaves the same.
        if (event.key === "Enter") {
          event.preventDefault();
          onPress();
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          onExitRight();
        }
        if (event.key === "ArrowUp" || event.key === "Escape") {
          event.preventDefault();
          onExitUp();
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          onExitDown();
        }
      }}
    >
      <span className="discover-voice-dot" aria-hidden="true" />
      <span className="discover-voice-label" aria-hidden="true">
        {voiceLabel(phase, secondsLeft)}
      </span>
      <span className="discover-voice-meter" aria-hidden="true">
        <span className="discover-voice-meter-fill" />
      </span>
    </button>
  );
}
