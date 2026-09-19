import type { CSSProperties, KeyboardEvent, RefObject } from "react";
import { voiceName, type VoicePhase } from "../voice/voiceState";

type VoiceButtonProps = {
  phase: VoicePhase;
  /** Input level, 0–1, while recording. */
  level: number;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onPress: () => void;
  /** Where arrow keys lead from the control; any it does not take are left to the page. */
  onArrow?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /** Attributes the page's remote navigation places on it. */
  navigation?: Record<string, string | number>;
};

/**
 * The one voice control: an icon, and nothing else. OK starts recording and OK again stops it.
 * Idle it is a microphone; recording it turns red and becomes a stop square, the one colour
 * change and the one shape change that say "listening" from across a room. A halo in the same red
 * follows the input level. Opening the microphone and finishing the transcript each dim it.
 */
export function VoiceButton({ phase, level, buttonRef, onPress, onArrow, navigation }: VoiceButtonProps) {
  const recording = phase === "recording";
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`voice-control voice-control-${phase}`}
      aria-label={voiceName(phase)}
      aria-pressed={recording}
      aria-busy={phase === "starting" || phase === "transcribing"}
      style={{ "--voice-level": recording ? level.toFixed(3) : "0" } as CSSProperties}
      onClick={onPress}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        // OK is handled here rather than left to the browser, so every remote behaves the same.
        if (event.key === "Enter") {
          event.preventDefault();
          onPress();
          return;
        }
        onArrow?.(event);
      }}
      {...navigation}
    >
      {recording ? <StopIcon /> : <MicrophoneIcon />}
    </button>
  );
}

function MicrophoneIcon() {
  return (
    <svg className="voice-control-icon" viewBox="0 0 24 24" width="40" height="40" aria-hidden="true" focusable="false">
      <rect x="8.5" y="2.5" width="7" height="12" rx="3.5" fill="currentColor" />
      <path d="M5 11.5a7 7 0 0 0 14 0" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M12 18.5v3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="voice-control-icon" viewBox="0 0 24 24" width="40" height="40" aria-hidden="true" focusable="false">
      <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
    </svg>
  );
}
