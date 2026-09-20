import { useCallback, useEffect, useRef, useState } from "react";
import {
  classifyMediaError,
  CONSENT_MAX_PURPOSE,
  isConsentEffective,
  MEDIA_OUTCOME_MESSAGE,
  type LiveConsent,
} from "../core/liveMedia";
import { likenessConsents, usableLikenesses } from "../core/likeness";
import { authorName, type JamMember } from "../core/room";
import { Notice } from "../chrome";
import { safeMessageOf } from "../lib/errors";
import { agreeToAppear, captureFrame, stopAppearing } from "../lib/likeness";

type Stage =
  | { step: "idle" }
  | { step: "camera" }
  | { step: "review"; frame: Blob; preview: string }
  | { step: "sending" };

/**
 * Choosing to be a character in the film.
 *
 * Three things this panel must never do, because they are the feature and not decoration:
 * it never captures without a press, it never sends a frame the person has not seen and
 * approved, and it never says a likeness is in use when it is not. Everything it shows
 * about who has agreed comes from the register, not from what happened in this tab.
 */
export function AppearInFilm({ jamId, userId, members, canAppear, consents, onChanged }: {
  jamId: string;
  userId: string;
  members: readonly JamMember[];
  canAppear: boolean;
  consents: readonly LiveConsent[];
  onChanged: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ step: "idle" });
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const now = Date.now();
  const grants = likenessConsents(consents);
  const standing = usableLikenesses(consents, now);
  const mine = standing.find((consent) => consent.owner_id === userId) ?? null;

  const stopCamera = useCallback(() => {
    // The camera opened for one picture and closes the moment it is no longer needed.
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  async function openCamera() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      streamRef.current = stream;
      setStage({ step: "camera" });
      // The element only exists once the stage renders it.
      queueMicrotask(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => undefined);
        }
      });
    } catch (mediaError) {
      setError(MEDIA_OUTCOME_MESSAGE[classifyMediaError(mediaError)]);
    }
  }

  async function takeFrame() {
    if (!videoRef.current) return;
    setError(null);
    try {
      const frame = await captureFrame(videoRef.current);
      stopCamera();
      setStage({ step: "review", frame, preview: URL.createObjectURL(frame) });
    } catch (captureError) {
      setError(safeMessageOf(captureError, "That picture could not be taken."));
    }
  }

  function discardFrame(current: Extract<Stage, { step: "review" }>) {
    URL.revokeObjectURL(current.preview);
    setStage({ step: "idle" });
  }

  async function approve(current: Extract<Stage, { step: "review" }>) {
    const declared = purpose.trim();
    if (!declared) {
      setError("Say what you are agreeing to before you agree to it.");
      return;
    }
    setStage({ step: "sending" });
    setError(null);
    try {
      await agreeToAppear(jamId, declared, current.frame);
      URL.revokeObjectURL(current.preview);
      setPurpose("");
      setStage({ step: "idle" });
      onChanged();
    } catch (sendError) {
      // The frame stays on screen: the person can try again without taking another picture.
      setStage(current);
      setError(safeMessageOf(sendError, "Your frame could not be sent. You are not in the film."));
    }
  }

  async function withdraw(consent: LiveConsent) {
    setError(null);
    try {
      await stopAppearing(jamId, consent);
      onChanged();
    } catch (withdrawError) {
      setError(safeMessageOf(withdrawError, "That could not be withdrawn. Try again."));
      onChanged();
    }
  }

  return <div className="queue-card appear-in-film">
    <div className="panel-heading">
      <div><p className="eyebrow">IN THE FILM</p><h2>Appearing as a character</h2></div>
      <span className="local-badge">{mine ? "YOU ARE IN IT" : "NOT IN IT"}</span>
    </div>

    <p>
      You can choose to be a character in the film this room is making. One picture from
      your own camera becomes the reference, and you see it before anything uses it. Being
      here and having a camera on are not the same as agreeing to this.
    </p>

    {error && <Notice>{error}</Notice>}

    {mine
      ? <div className="studio-actions">
          <p className="form-note">
            You agreed to appear, for “{mine.purpose}”, until {new Date(mine.expires_at).toLocaleTimeString()}.
          </p>
          <button className="button button-primary" onClick={() => void withdraw(mine)}>
            Take me out of the film
          </button>
          <p className="form-note">
            That stops the next beat immediately. Beats already generated still show you:
            they were made while you agreed, and they cannot be called back.
          </p>
        </div>
      : <AgreeControls
          stage={stage}
          purpose={purpose}
          canAppear={canAppear}
          videoRef={videoRef}
          onPurpose={setPurpose}
          onOpenCamera={() => void openCamera()}
          onTake={() => void takeFrame()}
          onDiscard={discardFrame}
          onApprove={(current) => void approve(current)}
          onCancel={() => { stopCamera(); setStage({ step: "idle" }); }}
        />}

    <ul className="roster likeness-roster">
      {grants.length === 0 && <li><span>Nobody has agreed to appear. Beats are generated without anyone in the room.</span></li>}
      {grants.map((consent) => {
        const effective = isConsentEffective(consent, now);
        return <li key={consent.id}>
          <span className={effective ? "roster-dot online" : "roster-dot"} aria-label={effective ? "in the film" : "no longer in the film"} />
          <span>
            <strong>{authorName(members, consent.owner_id)}</strong>{consent.owner_id === userId ? " · you" : ""}
            <br />
            <span className="form-note">
              {effective
                ? `“${consent.purpose}” · until ${new Date(consent.expires_at).toLocaleTimeString()}`
                : "No longer in the film. Beats made while they were still stand."}
            </span>
          </span>
          {consent.owner_id === userId && effective &&
            <button className="button button-quiet" onClick={() => void withdraw(consent)}>Withdraw</button>}
        </li>;
      })}
    </ul>
  </div>;
}

function AgreeControls({ stage, purpose, canAppear, videoRef, onPurpose, onOpenCamera, onTake, onDiscard, onApprove, onCancel }: {
  stage: Stage;
  purpose: string;
  canAppear: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onPurpose: (value: string) => void;
  onOpenCamera: () => void;
  onTake: () => void;
  onDiscard: (current: Extract<Stage, { step: "review" }>) => void;
  onApprove: (current: Extract<Stage, { step: "review" }>) => void;
  onCancel: () => void;
}) {
  if (stage.step === "idle") {
    return <div className="studio-actions">
      <button className="button button-primary" disabled={!canAppear} onClick={onOpenCamera}>
        Turn on my camera <span>↗</span>
      </button>
      <span className="form-note">Turning it on takes no picture. You press for that.</span>
    </div>;
  }

  if (stage.step === "camera") {
    return <div className="likeness-capture">
      <video ref={videoRef} className="likeness-preview" muted playsInline aria-label="Your camera" />
      <div className="studio-actions">
        <button className="button button-primary" onClick={onTake}>Take the picture</button>
        <button className="button button-quiet" onClick={onCancel}>Turn the camera off</button>
      </div>
    </div>;
  }

  if (stage.step === "sending") {
    return <p className="form-note">Recording your agreement and sending your frame…</p>;
  }

  return <div className="likeness-capture">
    <img className="likeness-preview" src={stage.preview} alt="The picture you just took" />
    <label className="sr-only" htmlFor="likeness-purpose">What are you agreeing to?</label>
    <input
      id="likeness-purpose"
      value={purpose}
      maxLength={CONSENT_MAX_PURPOSE}
      placeholder="What is this for? e.g. be the detective in this film"
      onChange={(event) => onPurpose(event.target.value)}
    />
    <div className="studio-actions">
      <button className="button button-primary" onClick={() => onApprove(stage)}>
        Use this picture of me
      </button>
      <button className="button button-quiet" onClick={() => onDiscard(stage)}>Take another</button>
    </div>
    <p className="form-note">
      Nothing has been recorded yet. This picture is used only after you press the button
      above, and it is never shown to anyone else in the room.
    </p>
  </div>;
}
