import type { CSSProperties, KeyboardEvent, PointerEvent, RefObject } from "react";
import { voiceName, type VoicePhase } from "../voice/voiceState";

type VoiceButtonProps = {
  phase: VoicePhase;
  /** Input level, 0–1, while recording. */
  level: number;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onPress: () => void;
  /**
   * Press and hold instead of press to toggle: holding records, releasing
   * stops. Given both, `onPress` is not called — one gesture, one meaning.
   */
  hold?: { start: () => void; end: () => void };
  /** Where arrow keys lead from the control; any it does not take are left to the page. */
  onArrow?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /** Attributes the page's remote navigation places on it. */
  navigation?: Record<string, string | number>;
};

/**
 * The one voice control: an icon, and nothing else. OK starts recording and OK again stops it,
 * or, where a screen asks for `hold`, holding records and releasing stops.
 * Idle it is a microphone; recording it turns red and becomes a stop square, the one colour
 * change and the one shape change that say "listening" from across a room. A halo in the same red
 * follows the input level. Opening the microphone and finishing the transcript each dim it.
 */
export function VoiceButton({ phase, level, buttonRef, onPress, hold, onArrow, navigation }: VoiceButtonProps) {
  const recording = phase === "recording";
  /** A held gesture ends on release, on leaving the control, and on the pointer being taken away. */
  const release = (event: PointerEvent<HTMLButtonElement>) => {
    if (!hold || event.defaultPrevented) return;
    event.preventDefault();
    hold.end();
  };
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`voice-control voice-control-${phase}`}
      aria-label={voiceName(phase)}
      aria-pressed={recording}
      aria-busy={phase === "starting" || phase === "transcribing"}
      style={{ "--voice-level": recording ? level.toFixed(3) : "0" } as CSSProperties}
      onClick={hold ? undefined : onPress}
      onPointerDown={hold ? (event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        event.preventDefault();
        // The control keeps the pointer, so a finger that slides off it still
        // ends the recording here rather than losing the release entirely.
        event.currentTarget.setPointerCapture?.(event.pointerId);
        hold.start();
      } : undefined}
      onPointerUp={hold ? release : undefined}
      onPointerCancel={hold ? release : undefined}
      onLostPointerCapture={hold ? release : undefined}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        // OK is handled here rather than left to the browser, so every remote behaves the same.
        if (event.key === "Enter" || (hold && event.key === " ")) {
          event.preventDefault();
          // A held key repeats; only the first press starts anything.
          if (!event.repeat) (hold ? hold.start : onPress)();
          return;
        }
        onArrow?.(event);
      }}
      onKeyUp={hold ? (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        hold.end();
      } : undefined}
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
