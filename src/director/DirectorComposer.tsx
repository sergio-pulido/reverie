import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { MAX_MESSAGE_CHARS } from "../conversation/decision";
import { VoiceButton } from "../discover/VoiceButton";
import { useVoiceInput } from "../voice/useVoiceInput";
import { mergeIntoDraft } from "../voice/voiceState";
import { ATTACH_INTENTS, ATTACH_NOT_WIRED, type AttachIntentId } from "./attachIntents";
import type { DirectorMode } from "./mode";

export const COMPOSER_ROW = "composer";

type DirectorComposerProps = {
  mode: DirectorMode;
  /** Sends one direction. Answers false when the server refused it. */
  onDirect: (body: string, beatIndex?: number) => Promise<boolean>;
  /** The beat a direction is aimed at, or null for wherever the stream is. */
  targetBeat: number | null;
  onClearTarget: () => void;
  /** Lines under the field: why nothing can be sent, and what is refused. */
  notes: readonly string[];
  /** True when a direction cannot be sent at all. */
  blocked: boolean;
  cellProps: (row: string, index: number) => Record<string, unknown>;
};

/**
 * The way in: speak, or type, or show it something.
 *
 * Speaking is primary and works by holding the control — the microphone opens
 * on the press and closes on the release, with what has been heard so far
 * under it. In Direct that transcript is sent the moment it is final, which is
 * what makes the mode direct. In Review it waits in the field, because the
 * point of Review is that nothing happens until you say so.
 *
 * All of the voice machinery is the app's existing relay, recorder and partial
 * merge; only the gesture is new.
 */
export function DirectorComposer({
  mode,
  onDirect,
  targetBeat,
  onClearTarget,
  notes,
  blocked,
  cellProps,
}: DirectorComposerProps) {
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [attached, setAttached] = useState<{ name: string; kind: string } | null>(null);
  const [intent, setIntent] = useState<AttachIntentId | null>(null);
  const [dragging, setDragging] = useState(false);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const voiceRef = useRef<HTMLButtonElement | null>(null);
  const sending = useRef(false);

  const send = useCallback(
    async (body: string) => {
      const said = body.trim();
      // The disabled button is not the only path in: Enter and a Direct voice
      // transcript call this same function without clicking it. Keep the guard
      // here so a direction typed at a stream that is not running is dropped
      // by every input path, not just by the one with the disabled button.
      if (blocked || !said || sending.current) return;
      sending.current = true;
      const sent = await onDirect(said, targetBeat ?? undefined);
      sending.current = false;
      if (sent) {
        setDraft("");
        setNote(null);
      }
    },
    [blocked, onDirect, targetBeat],
  );

  const voice = useVoiceInput({
    onTranscript(text) {
      if (mode === "direct") {
        void send(text);
        return;
      }
      setDraft((current) => mergeIntoDraft(current, text));
      setNote(null);
      const input = field.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
  });

  // Leaving Direct closes the microphone: Review is the stopped mode, and a
  // control still listening would be the loudest possible contradiction of it.
  useEffect(() => {
    if (mode === "review") voice.hold.end();
  }, [mode, voice.hold]);

  function take(file: File | undefined) {
    if (!file) return;
    setAttached({ name: file.name, kind: file.type || "unknown" });
    setIntent(null);
    setNote(null);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    take(event.dataTransfer?.files?.[0]);
  }

  const speaking = voice.phase !== "idle";
  const heard = speaking ? voice.partial : "";

  return (
    <section className="director-composer" aria-label="Direct the film">
      {targetBeat !== null && (
        <p className="director-aim">
          Aimed at beat {targetBeat + 1}.{" "}
          <button type="button" className="director-aim-clear" onClick={onClearTarget}>
            Aim at the stream instead
          </button>
        </p>
      )}

      {(speaking || heard) && (
        <p className="director-heard" aria-live="polite">
          <span className="director-heard-status">
            {voice.phase === "recording" && (
              <span
                className="director-level"
                aria-hidden="true"
                style={{ ["--voice-level" as string]: voice.level.toFixed(3) }}
              >
                <i />
                <i />
                <i />
              </span>
            )}
            {PHASE_LABEL[voice.phase]}
          </span>
          {heard ? (
            <span className="director-heard-text">{heard}</span>
          ) : (
            <span className="director-heard-placeholder">Go ahead…</span>
          )}
        </p>
      )}

      <div
        className="director-composer-row"
        data-dragging={dragging ? "" : undefined}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <VoiceButton
          phase={voice.phase}
          level={voice.level}
          buttonRef={voiceRef}
          onPress={voice.press}
          hold={voice.hold}
          navigation={cellProps(COMPOSER_ROW, 0) as Record<string, string | number>}
        />
        <label className="director-field">
          <span className="sr-only">Tell the film what to do</span>
          <textarea
            ref={field}
            value={draft}
            maxLength={MAX_MESSAGE_CHARS}
            placeholder={
              mode === "direct"
                ? "Hold the microphone, or type it here."
                : "Change a beat, or write the next one."
            }
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.defaultPrevented || event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
            {...cellProps(COMPOSER_ROW, 1)}
          />
        </label>
        <label className="director-attach">
          <span className="sr-only">Show it an image or a clip</span>
          <input
            type="file"
            accept="image/*,video/*"
            onChange={(event) => take(event.target.files?.[0] ?? undefined)}
          />
          <span aria-hidden="true">＋</span>
        </label>
        <button
          type="button"
          className="button button-primary director-send"
          disabled={!draft.trim() || blocked}
          onClick={() => void send(draft)}
          {...cellProps(COMPOSER_ROW, 2)}
        >
          Direct <span aria-hidden="true">↗</span>
        </button>
      </div>

      {attached && (
        <div className="director-attached">
          <p className="director-attached-file">
            <strong>{attached.name}</strong> <span>{attached.kind}</span>
            <button
              type="button"
              className="director-aim-clear"
              onClick={() => {
                setAttached(null);
                setIntent(null);
                setNote(null);
              }}
            >
              Remove
            </button>
          </p>
          <p className="director-zone-note">What is it to the film?</p>
          <ul className="director-intents">
            {ATTACH_INTENTS.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  className="director-intent"
                  aria-pressed={intent === option.id}
                  onClick={() => {
                    setIntent(option.id);
                    setNote(ATTACH_NOT_WIRED);
                  }}
                >
                  <span className="director-intent-label">{option.label}</span>
                  <span className="director-intent-detail">{option.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Several things can be true at once — the stream is stopped and the
          reference you just picked cannot travel — and each one is its own
          line rather than the first hiding the rest. */}
      <div className="director-composer-notes" role="status">
        {[...notes, note, voice.notice].filter(Boolean).map((line, index) => (
          // eslint-disable-next-line react/no-array-index-key -- a fixed, ordered list of lines
          <p className="director-composer-note" key={index}>
            {line}
          </p>
        ))}
      </div>
    </section>
  );
}

const PHASE_LABEL = {
  idle: "Not sent yet",
  starting: "Opening the microphone",
  recording: "Listening",
  transcribing: "Finishing",
} as const;
