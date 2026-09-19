import type { RefObject } from "react";
import { MAX_MESSAGE_CHARS } from "../conversation/decision";
import { VoiceButton } from "../discover/VoiceButton";
import type { VoicePhase } from "../voice/voiceState";

/** The composer's controls as the remote navigation numbers them. */
export const COMPOSER_ROW = "composer";
export const COMPOSER_FIELD = 1;

type ComposerProps = {
  draft: string;
  onDraft: (value: string) => void;
  onSend: () => void;
  /** A message is on its way; nothing more is sent until it is answered. */
  pending: boolean;
  placeholder: string;
  voice: { phase: VoicePhase; level: number; press: () => void };
  inputRef: RefObject<HTMLInputElement | null>;
  voiceRef: RefObject<HTMLButtonElement | null>;
  /** A line under the field: why nothing was sent, or what went wrong with the microphone. */
  status: string | null;
};

/**
 * The one field, with the voice control at its leading edge and the send button after it. The
 * same field takes a film's name or a request in the viewer's own words; the screen decides
 * which. OK in the field sends, Escape first clears it, and Left from its start reaches the
 * microphone.
 */
export function Composer({ draft, onDraft, onSend, pending, placeholder, voice, inputRef, voiceRef, status }: ComposerProps) {
  const canSend = !pending && draft.trim().length > 0;
  return (
    <div className="search-composer">
      <form
        className="search-composer-form"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <VoiceButton
          phase={voice.phase}
          level={voice.level}
          buttonRef={voiceRef}
          onPress={voice.press}
          navigation={{ "data-row": COMPOSER_ROW, "data-index": 0 }}
        />
        <label className="search-field">
          <span className="sr-only">Name a film, or say what you’re in the mood for</span>
          <input
            ref={inputRef}
            type="search"
            value={draft}
            maxLength={MAX_MESSAGE_CHARS}
            placeholder={placeholder}
            autoComplete="off"
            enterKeyHint="send"
            data-row={COMPOSER_ROW}
            data-index={COMPOSER_FIELD}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              const input = event.currentTarget;
              if (event.defaultPrevented || event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                // OK sends, here, rather than waiting on the browser's own form submission.
                event.preventDefault();
                onSend();
                return;
              }
              // Escape first clears what is typed; on an empty field it is Back, for the app.
              if (event.key === "Escape" && draft) {
                event.preventDefault();
                onDraft("");
                return;
              }
              const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
              const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
              if (event.key === "ArrowLeft" && atStart) {
                event.preventDefault();
                voiceRef.current?.focus();
              }
              if (event.key === "ArrowRight" && atEnd && canSend) {
                event.preventDefault();
                input.form?.querySelector<HTMLButtonElement>(".search-send")?.focus();
              }
            }}
          />
        </label>
        {/* It appears once there is something to send: at rest the field and the microphone stand alone. */}
        {(draft.trim() || pending) && (
          <button
            type="submit"
            className="search-send"
            disabled={!canSend}
            data-row={COMPOSER_ROW}
            data-index={2}
            onKeyDown={(event) => {
              if (event.defaultPrevented || event.key !== "Enter") return;
              event.preventDefault();
              onSend();
            }}
          >
            {pending ? "Thinking…" : "Send"}
          </button>
        )}
      </form>
      {status && (
        <p className="search-status" role="status">
          {status}
        </p>
      )}
    </div>
  );
}
