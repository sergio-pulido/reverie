import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { OutlineEditRecord } from "../core/outlineEdit";
import type { JamScript } from "../core/script";
import { formatClock } from "../core/scriptMarkdown";
import {
  listOutlineEdits,
  OutlineError,
  readOutline,
  submitOutlineEdit,
  type OutlineBeat,
  type OutlineSnapshot,
} from "../lib/outline";

/** Interim transport, like the director panel's: the contract is Realtime events. */
const OUTLINE_POLL_MS = 4000;

type BeatState = "played" | "generating" | "editable";

/** Where a beat stands against the live director's window. */
export function beatState(beat: OutlineBeat, snapshot: OutlineSnapshot): BeatState {
  const current = snapshot.window.currentBeatIndex;
  if (current !== null && beat.portionIndex <= current) return "played";
  if (beat.locked) return "generating";
  return "editable";
}

const STATE_LABEL: Record<BeatState, string> = {
  played: "PLAYED",
  generating: "GENERATING",
  editable: "EDITABLE",
};

const STATUS_LABEL: Record<OutlineEditRecord["status"], string> = {
  queued: "waiting",
  processing: "rewriting",
  landed: "landed",
  failed: "failed",
};

/**
 * The outline: one phrase per beat, the settled part readable and the rest
 * editable. Both ways of changing a beat go through the same queue, and the
 * ledger under the list shows what that queue did with each one — including
 * an edit that was refused, in the server's words.
 */
export function OutlinePanel({
  jamId,
  canEdit,
  authorId,
  onScript,
}: {
  jamId: string;
  canEdit: boolean;
  authorId?: string;
  /** The current revision's script, so a screenplay under this panel can follow it. */
  onScript?: (script: JamScript) => void;
}) {
  const [snapshot, setSnapshot] = useState<OutlineSnapshot | null>(null);
  const [edits, setEdits] = useState<OutlineEditRecord[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const onScriptRef = useRef(onScript);
  onScriptRef.current = onScript;

  const refresh = useCallback(async () => {
    try {
      const [next, ledger] = await Promise.all([readOutline(jamId), listOutlineEdits(jamId)]);
      setSnapshot(next);
      setEdits(ledger);
      setMissing(false);
      onScriptRef.current?.(next.script);
    } catch (error) {
      if (error instanceof OutlineError && error.code === "not_found") {
        setMissing(true);
        return;
      }
      setFailure(error instanceof Error ? error.message : "The outline could not be read.");
    }
  }, [jamId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), OUTLINE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function submit(command: Parameters<typeof submitOutlineEdit>[1]) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await submitOutlineEdit(jamId, command);
      setEditing(null);
      setDraft("");
      await refresh();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The edit could not be queued.");
      // A stale refusal means the outline moved; show the room what it moved to.
      if (error instanceof OutlineError && error.code === "stale_state_version") await refresh();
    } finally {
      setBusy(false);
    }
  }

  function rewrite(event: FormEvent<HTMLFormElement>, beat: OutlineBeat) {
    event.preventDefault();
    const summary = draft.trim();
    if (!summary || !snapshot) return;
    void submit({
      requestId: crypto.randomUUID(),
      intent: "set",
      beatIndex: beat.portionIndex,
      summary,
      expectedRevision: snapshot.revision,
      mechanism: "direct",
      ...(authorId ? { authorId } : {}),
    });
  }

  function reject(beat: OutlineBeat) {
    if (!snapshot) return;
    void submit({
      requestId: crypto.randomUUID(),
      intent: "reroll",
      beatIndex: beat.portionIndex,
      expectedRevision: snapshot.revision,
      mechanism: "direct",
      ...(authorId ? { authorId } : {}),
    });
  }

  if (missing) {
    return <section className="queue-card queue-card-stack outline-panel" aria-label="Story outline">
      <div><p className="eyebrow">STORY OUTLINE</p><h2>No script on this server.</h2></div>
      <p className="form-note">The script lives on the server that created it and does not survive a restart. Create the jam again to steer it.</p>
    </section>;
  }

  return <section className="queue-card queue-card-stack outline-panel" aria-label="Story outline">
    <div className="outline-head">
      <div><p className="eyebrow">STORY OUTLINE{snapshot ? ` · REVISION ${snapshot.revision}` : ""}</p><h2>What happens, beat by beat.</h2></div>
      {snapshot && snapshot.pending > 0 && <span className="local-badge" role="status">{snapshot.pending} EDIT{snapshot.pending === 1 ? "" : "S"} IN FLIGHT</span>}
    </div>
    <p className="form-note">
      Rewrite a beat or reject it, and everything after it is re-derived so the story stays coherent.
      Beats on screen or already being generated cannot change.
    </p>
    {failure && <p className="jam-error" role="alert">{failure}</p>}
    {!snapshot && !failure && <p className="form-note">Reading the outline…</p>}
    {snapshot && <ol className="outline-list">
      {snapshot.beats.map((beat) => {
        const state = beatState(beat, snapshot);
        const open = editing === beat.portionIndex;
        return <li key={beat.portionIndex} className={`outline-beat outline-beat-${state}`}>
          <p className="jam-portion-time">
            BEAT {beat.portionIndex + 1} · {formatClock(beat.startSeconds)} · {beat.durationSeconds}s · {STATE_LABEL[state]}
          </p>
          {beat.summary
            ? <p className="outline-summary">{beat.summary}</p>
            : <p className="outline-summary outline-summary-missing">No beat yet for this portion.</p>}
          {canEdit && state === "editable" && !open && <div className="outline-actions">
            <button type="button" className="button button-quiet" disabled={busy} onClick={() => { setEditing(beat.portionIndex); setDraft(beat.summary ?? ""); }}>Rewrite</button>
            <button type="button" className="button button-quiet" disabled={busy} onClick={() => reject(beat)}>Not this</button>
          </div>}
          {canEdit && state === "editable" && open && <form className="outline-form" onSubmit={(event) => rewrite(event, beat)}>
            <label>
              <span className="eyebrow">NEW BEAT {beat.portionIndex + 1}</span>
              <input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={120} autoFocus required placeholder="One short phrase: what happens here" />
            </label>
            <div className="outline-actions">
              <button type="submit" className="button button-primary" disabled={busy || !draft.trim()}>Rewrite from here <span>↗</span></button>
              <button type="button" className="button button-quiet" disabled={busy} onClick={() => { setEditing(null); setDraft(""); }}>Cancel</button>
            </div>
          </form>}
        </li>;
      })}
    </ol>}
    {edits.length > 0 && <ul className="outline-ledger" aria-label="Outline edits">
      {edits.slice(0, 8).map((edit) => <li key={edit.id} className={`outline-edit outline-edit-${edit.status}`}>
        <span className="jam-portion-time">
          BEAT {edit.beatIndex + 1} · {edit.intent === "set" ? "REWRITE" : "NOT THIS"} · {STATUS_LABEL[edit.status].toUpperCase()}
          {edit.revision ? ` · REVISION ${edit.revision}` : ""}
        </span>
        <p>
          {edit.intent === "set" ? `“${edit.summary}”` : "Asked for something else."}
          {edit.error ? ` ${edit.error.safeMessage}` : ""}
          {edit.direction && edit.direction.sent > 0 ? ` Sent to the live stream.` : ""}
        </p>
      </li>)}
    </ul>}
  </section>;
}
