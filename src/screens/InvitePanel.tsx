import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { describeInvite, inviteUrl, isInviteShareable, type JamInvite } from "../core/invite";
import { getJamInvite, revokeJamInvite, rotateJamInvite } from "../lib/invite";
import { safeMessageOf } from "../lib/errors";
import { Notice } from "../chrome";
import { isBackKey } from "../shell/keys";

/** Lifetimes the host can pick. `null` is an invite that does not expire. */
const TTL_CHOICES: readonly { label: string; minutes: number | null }[] = [
  { label: "30 minutes", minutes: 30 },
  { label: "2 hours", minutes: 120 },
  { label: "No expiry", minutes: null },
];

type InvitePanelProps = {
  jamId: string;
  onClose: () => void;
};

/**
 * Host-only. Shows the shareable link and a QR of the same URL, and owns rotation and
 * revocation. The panel never decides who gets in — it only renders what the database
 * says the invite currently is. Back inside the panel closes it before it does anything else.
 */
export function InvitePanel({ jamId, onClose }: InvitePanelProps) {
  const [invite, setInvite] = useState<JamInvite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [copied, setCopied] = useState(false);
  // Re-renders the countdown so an invite that lapses while the panel is open says so.
  const [, setTick] = useState(0);

  const run = useCallback(async (action: () => Promise<JamInvite>, fallback: string) => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setInvite(await action());
    } catch (caught) {
      setError(safeMessageOf(caught, fallback));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run(() => getJamInvite(jamId), "The invite could not be read.");
  }, [jamId, run]);

  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const url = invite ? inviteUrl(window.location.origin, invite.slug, invite.code) : null;
  const shareable = invite ? isInviteShareable(invite) : false;

  return <div className="invite-panel" role="dialog" aria-label="Invite people to this jam" onKeyDown={(event) => {
    if (!event.defaultPrevented && isBackKey(event.key, false, event.keyCode)) {
      event.preventDefault();
      onClose();
    }
  }}>
    <div className="panel-heading">
      <div><p className="eyebrow">INVITE</p><h2>Share the room.</h2></div>
      <button className="button button-quiet" onClick={onClose}>Close</button>
    </div>

    {error && <Notice>{error}</Notice>}

    {!invite
      ? <p>{busy ? "Reading the invite…" : "No invite is available for this room."}</p>
      : <>
          {shareable && url
            ? <div className="invite-qr">
                {/* The QR encodes the same URL as the link, so scanning and pasting are one path. */}
                <QRCodeSVG value={url} size={176} level="M" marginSize={2} title="Invite QR code" />
              </div>
            : <Notice>This invite is not shareable right now. Rotate it to admit anyone else.</Notice>}

          <p className="invite-code" aria-label="Invite code">{invite.code}</p>
          <p className="form-note">{describeInvite(invite)}</p>
          <p className="form-note">The code is the entitlement. A room link without it grants nothing.</p>

          <div className="invite-actions">
            <button
              className="button button-primary"
              disabled={!shareable || !url}
              onClick={() => {
                if (!url) return;
                void navigator.clipboard?.writeText(url)
                  .then(() => setCopied(true))
                  .catch(() => setError("This browser would not copy the link. Read the code out instead."));
              }}
            >{copied ? "Link copied" : "Copy invite link"} <span>↗</span></button>

            <button
              className="button button-quiet"
              disabled={busy || invite.state === "revoked"}
              onClick={() => void run(() => revokeJamInvite(jamId), "The invite could not be revoked.")}
            >Revoke</button>
          </div>

          <div className="invite-actions" role="group" aria-label="Rotate the invite">
            {TTL_CHOICES.map((choice) => <button
              key={choice.label}
              className="button button-quiet"
              disabled={busy}
              onClick={() => void run(() => rotateJamInvite(jamId, choice.minutes), "The invite could not be rotated.")}
            >New code · {choice.label}</button>)}
          </div>
          <p className="form-note">A new code stops every link and QR already shared. Nobody already in the room is removed.</p>
        </>}
  </div>;
}
