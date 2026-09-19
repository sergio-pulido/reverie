import { useEffect, useState, type FormEvent } from "react";
import type { AdmissionResult } from "../core/room";
import { safeMessageOf } from "../lib/errors";
import { requestAdmission } from "../lib/membership";
import { hasSupabaseConfiguration } from "../lib/supabase";
import { Footer, Notice } from "../chrome";
import { TopBar } from "../shell/TopBar";
import { useAccessStatus } from "./useAccessStatus";

type JoinRoomProps = {
  initialCode: string;
  onAdmitted: (result: AdmissionResult) => void;
};

/**
 * Exchanges an invite code and a display name for a membership row. The entitlement is
 * the code, not the room URL, so a shared link alone never grants access.
 *
 * Repeating the request is safe: the database refreshes the display name and leaves the
 * status alone, so a second submit never resets a pending admission or re-admits someone
 * the host removed.
 */
export function JoinRoom({ initialCode, onAdmitted }: JoinRoomProps) {
  const configured = hasSupabaseConfiguration();
  const [code, setCode] = useState(initialCode);
  const [displayName, setDisplayName] = useState("");
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<AdmissionResult | null>(null);

  // An invite link can change under the screen when the host shares a rotated one.
  useEffect(() => setCode(initialCode), [initialCode]);

  const access = useAccessStatus(waiting?.jamId ?? null, waiting !== null);

  useEffect(() => {
    if (waiting && access.status === "active") onAdmitted(waiting);
  }, [access.status, waiting, onAdmitted]);

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isJoining) return;
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

  const refused = access.status === "removed";

  return <main className="site-shell setup-shell">
    <TopBar current="jam" />
    <section className="join-layout">
      <div className="join-card">
        <p className="eyebrow">JOIN A MOVIE JAM</p>
        <h1>Take a seat in the <em>room.</em></h1>

        {waiting
          ? <>
              <p className="intro">
                {refused
                  ? <>The host did not admit you to <strong>{waiting.title}</strong>.</>
                  : <>You are in the lobby for <strong>{waiting.title}</strong>. The host admits directors one at a time.</>}
              </p>
              {refused
                ? <Notice>This session cannot enter this jam. Ask the host directly if that was not intended.</Notice>
                : <>
                    <Notice tone="status">
                      {access.checking ? "Checking with the host…" : "Waiting for the host. This page checks every few seconds."}
                    </Notice>
                    {access.error && <Notice>{access.error}</Notice>}
                    <button className="button button-quiet form-submit" onClick={() => onAdmitted(waiting)}>Open the lobby <span>→</span></button>
                  </>}
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
