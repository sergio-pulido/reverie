import { useState } from "react";
import { MAX_MESSAGE_CHARS } from "../conversation/decision";
import type { Conversation } from "../conversation/transcript";

type ConversationBarProps = {
  conversation: Conversation;
  pending: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSend: (message: string) => void;
  /** Up from the input. */
  onExitUp: () => void;
  /** Down from the input. */
  onExitDown: () => void;
};

/**
 * Where the viewer says what they want in their own words. The assistant's acknowledgement and
 * any clarifying question appear beneath it; when the assistant cannot help, it says so here
 * and the chips below carry on.
 */
export function ConversationBar({ conversation, pending, inputRef, onSend, onExitUp, onExitDown }: ConversationBarProps) {
  const [draft, setDraft] = useState("");
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
              if (event.key === "ArrowDown") {
                event.preventDefault();
                onExitDown();
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                onExitUp();
              }
              // Escape first clears the draft; on an empty field it is Back, for the app.
              if (event.key === "Escape" && draft) {
                event.preventDefault();
                setDraft("");
              }
            }}
          />
        </label>
        <button type="submit" className="discover-talk-send" disabled={pending || !draft.trim()}>
          {pending ? "Thinking…" : "Ask"}
        </button>
      </form>

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
