import { useState, type FormEvent } from "react";
import {
  CONSENT_MAX_PURPOSE,
  isConsentEffective,
  LIVE_TRACK_KINDS,
  type LiveConsent,
  type LiveTrackKind,
} from "../core/liveMedia";
import { authorName, type JamMember } from "../core/room";
import { Notice } from "../chrome";
import { useLiveStage } from "./useLiveStage";

const KIND_LABEL: Record<LiveTrackKind, string> = {
  camera: "Camera",
  microphone: "Microphone",
  screen: "Screen",
};

const CONNECTION_LABEL: Record<string, string> = {
  idle: "NOT ON STAGE",
  connecting: "CONNECTING",
  live: "ON STAGE",
  reconnecting: "RECONNECTING",
  offline: "OFFLINE",
  denied: "REFUSED",
};

/**
 * The live stage panel. Nothing here publishes on its own: a track starts only after its
 * owner has declared a purpose, and stops the moment that consent is withdrawn or expires.
 */
export function LiveStage({ jamId, userId, members, canJoin }: {
  jamId: string;
  userId: string;
  members: readonly JamMember[];
  canJoin: boolean;
}) {
  const { state, permitted, joined, refs, actions } = useLiveStage(jamId, userId, canJoin);
  const [kind, setKind] = useState<LiveTrackKind>("camera");
  const [purpose, setPurpose] = useState("");

  const now = Date.now();
  const active = state.consents.filter((consent) => isConsentEffective(consent, now));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const declared = purpose.trim();
    if (!declared) return;
    setPurpose("");
    void actions.grant(kind, declared);
  }

  return <div className="queue-card live-stage">
    <div className="panel-heading">
      <div><p className="eyebrow">LIVE STAGE</p><h2>Camera, microphone and screen</h2></div>
      <span className="local-badge">{CONNECTION_LABEL[state.connection] ?? "NOT ON STAGE"}</span>
    </div>

    {state.availability === "not_configured"
      ? <p>Live media is not enabled for this deployment, so nobody can join the stage.</p>
      : <p>
          Joining connects you to the room. Nothing is published until you say what a track
          is for, and nothing is recorded: this slice has no archive, export or transformation.
        </p>}

    {state.error && <Notice>{state.error}</Notice>}

    <div className="studio-actions">
      {joined
        ? <button className="button button-quiet" onClick={() => void actions.leave()}>Leave the stage</button>
        : <button className="button button-primary" disabled={!canJoin || state.busy || state.availability === "not_configured"} onClick={() => void actions.join()}>
            Join the stage <span>↗</span>
          </button>}
      {joined && <span className="form-note">{state.remoteStreams} other live contribution{state.remoteStreams === 1 ? "" : "s"}</span>}
    </div>

    <div className="live-surfaces">
      <div className="live-surface" ref={refs.camera} aria-label="Live camera contributions" />
      <div className="live-surface" ref={refs.screen} aria-label="Live screen contributions" />
    </div>

    <form className="contribution-form live-consent-form" onSubmit={submit}>
      <label className="sr-only" htmlFor="live-kind">What are you contributing?</label>
      <select id="live-kind" value={kind} onChange={(event) => setKind(event.target.value as LiveTrackKind)}>
        {LIVE_TRACK_KINDS.map((option) => <option key={option} value={option}>{KIND_LABEL[option]}</option>)}
      </select>
      <label className="sr-only" htmlFor="live-purpose">What is it for?</label>
      <input
        id="live-purpose"
        value={purpose}
        maxLength={CONSENT_MAX_PURPOSE}
        placeholder="What is this for? e.g. show the costume for the lead character"
        onChange={(event) => setPurpose(event.target.value)}
        disabled={!canJoin || state.busy}
      />
      <button className="button button-primary" type="submit" disabled={!canJoin || state.busy}>Allow <span>↗</span></button>
    </form>
    <p className="form-note">
      Consent lasts 30 minutes unless you withdraw it sooner. Withdrawing stops the track
      immediately and retires its reference for everyone.
    </p>

    <ul className="roster live-consents">
      {active.length === 0 && <li><span>No live contribution is permitted right now.</span></li>}
      {active.map((consent) => <ConsentRow
        key={consent.id}
        consent={consent}
        owner={authorName(members, consent.owner_id)}
        isOwner={consent.owner_id === userId}
        publishing={consent.owner_id === userId && permitted.has(consent.kind) && joined}
        onWithdraw={() => void actions.withdraw(consent.id)}
      />)}
    </ul>
  </div>;
}

function ConsentRow({ consent, owner, isOwner, publishing, onWithdraw }: {
  consent: LiveConsent;
  owner: string;
  isOwner: boolean;
  publishing: boolean;
  onWithdraw: () => void;
}) {
  const expires = new Date(consent.expires_at);
  return <li>
    <span className={publishing ? "roster-dot online" : "roster-dot"} aria-label={publishing ? "publishing" : "permitted"} />
    <span>
      <strong>{KIND_LABEL[consent.kind]}</strong> · {owner}{isOwner ? " · you" : ""}
      <br />
      <span className="form-note">
        “{consent.purpose}” · until {expires.toLocaleTimeString()} · {consent.asset_ref}
      </span>
    </span>
    {isOwner && <button className="button button-quiet" onClick={onWithdraw}>Withdraw</button>}
  </li>;
}
