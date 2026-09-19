import { useState, type FormEvent } from "react";
import type { AdmissionResult } from "../core/room";
import { safeMessageOf } from "../lib/errors";
import { requestAdmission } from "../lib/membership";
import { hasSupabaseConfiguration } from "../lib/supabase";
import { Footer, Header, Notice } from "../chrome";

type JoinRoomProps = {
  initialCode: string;
  onBack: () => void;
  onAdmitted: (result: AdmissionResult) => void;
};

/**
 * Exchanges an invite code and a display name for a membership row. The entitlement is
 * the code, not the room URL, so a shared link alone never grants access.
 */
export function JoinRoom({ initialCode, onBack, onAdmitted }: JoinRoomProps) {
  const configured = hasSupabaseConfiguration();
  const [code, setCode] = useState(initialCode);
  const [displayName, setDisplayName] = useState("");
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<AdmissionResult | null>(null);

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsJoining(true);
    setError(null);
    try {
      const result = await requestAdmission(code, displayName);
      if (result.memberStatus === "active") {
        onAdmitted(result);
        return;
      }
      setWaiting(result);
    } catch (caught) {
      setError(safeMessageOf(caught, "The jam could not be joined right now."));
    } finally {
      setIsJoining(false);
    }
  }

  return <main className="site-shell setup-shell">
    <Header onHome={onBack} />
    <section className="join-layout">
      <div className="join-card">
        <button className="back-link" onClick={onBack}>← Back to Reverie</button>
        <p className="eyebrow">JOIN A MOVIE JAM</p>
        <h1>Take a seat in the <em>room.</em></h1>

        {waiting
          ? <>
              <p className="intro">You are in the lobby for <strong>{waiting.title}</strong>. The host admits directors one at a time.</p>
              <Notice tone="status">Waiting for the host. This page updates when you are admitted.</Notice>
              <button className="button button-quiet form-submit" onClick={() => onAdmitted(waiting)}>Open the room <span>→</span></button>
            </>
          : <>
              <p className="intro">Enter the invite code the host shared. A room link on its own is not an invite.</p>
              <form onSubmit={join}>
                <label>Invite code
                  <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="ABCD2345" autoComplete="off" spellCheck={false} required />
                </label>
                <label>Your display name
                  <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Your name" maxLength={32} required />
                </label>
                <button className="button button-primary form-submit" type="submit" disabled={isJoining || !configured}>
                  {isJoining ? "Joining…" : "Join the room"} <span>→</span>
                </button>
              </form>
              {!configured && <Notice>Supabase is not configured in this build, so no jam can be joined from here.</Notice>}
              {error && <Notice>{error}</Notice>}
            </>}
      </div>
    </section>
    <Footer />
  </main>;
}
