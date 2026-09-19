import { useRef, useState } from "react";
import { MAX_MESSAGE_CHARS } from "../conversation/decision";
import type { Conversation } from "../conversation/transcript";
import { useVoiceInput } from "../voice/useVoiceInput";
import { mergeIntoDraft } from "../voice/voiceState";
import { VoiceButton } from "./VoiceButton";

type ConversationBarProps = {
  conversation: Conversation;
  pending: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSend: (message: string) => void;
  /** Up or Escape from the input. */
  onExitUp: () => void;
  /** Down from the input. */
  onExitDown: () => void;
};

/**
 * Where the viewer says what they want in their own words. The assistant's acknowledgement and
 * any clarifying question appear beneath it; when the assistant cannot help, it says so here
 * and the chips below carry on.
 *
 * The viewer can also speak: the voice control to the left of the field records, and the final
 * transcript lands in the field, where it can be read and corrected. It is never sent for them.
 */
export function ConversationBar({ conversation, pending, inputRef, onSend, onExitUp, onExitDown }: ConversationBarProps) {
  const [draft, setDraft] = useState("");
  const voiceRef = useRef<HTMLButtonElement | null>(null);
  const voice = useVoiceInput({
    onTranscript: (text) => {
      setDraft((current) => mergeIntoDraft(current, text));
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      // The caret goes after the transcript, ready for OK or a correction.
      requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length));
    },
  });
  const placeholder = conversation.openQuestion ? "Answer, or say something else…" : "Tell me what you’re in the mood for…";

  return (
    <section className="discover-talk" aria-label="Tell the assistant what you want">
      <form
        className="discover-talk-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim() || pending) return;
          onSend(draft);
          setDraft("");
        }}
      >
        <VoiceButton
          phase={voice.phase}
          level={voice.level}
          secondsLeft={voice.secondsLeft}
          buttonRef={voiceRef}
          onPress={voice.press}
          onExitRight={() => inputRef.current?.focus()}
          onExitUp={onExitUp}
          onExitDown={onExitDown}
        />
        <label className="discover-talk-field">
          <span className="sr-only">Tell the assistant what you want</span>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            maxLength={MAX_MESSAGE_CHARS}
            placeholder={placeholder}
            autoComplete="off"
            enterKeyHint="send"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              const input = event.currentTarget;
              if (event.key === "ArrowLeft" && input.selectionStart === 0 && input.selectionEnd === 0) {
                event.preventDefault();
                voiceRef.current?.focus();
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                onExitDown();
              }
              if (event.key === "ArrowUp" || (event.key === "Escape" && !draft)) {
                event.preventDefault();
                onExitUp();
              }
              if (event.key === "Escape" && draft) setDraft("");
            }}
          />
        </label>
        <button type="submit" className="discover-talk-send" disabled={pending || !draft.trim()}>
          {pending ? "Thinking…" : "Ask"}
        </button>
      </form>

      {voice.partial && voice.phase !== "idle" && (
        <p className="discover-talk-line discover-voice-partial" aria-live="polite">
          <span className="sr-only">Hearing: </span>
          {voice.partial}
        </p>
      )}

      {voice.notice && (
        <p className="discover-talk-line discover-talk-system discover-voice-notice" role="status">
          {voice.notice}
        </p>
      )}

      {conversation.lines.length > 0 && (
        <ol className="discover-talk-log" aria-live="polite">
          {conversation.lines.map((line) => (
            <li key={line.id} className={`discover-talk-line discover-talk-${line.speaker}${line.question ? " discover-talk-question" : ""}`}>
              <span className="sr-only">{line.speaker === "viewer" ? "You said: " : line.speaker === "assistant" ? "Assistant: " : "Notice: "}</span>
              {line.text}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
