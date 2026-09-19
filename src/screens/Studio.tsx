import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { authorName, type ConnectionState, type JamMember } from "../core/room";
import { Footer, Header, LiveScene, Notice } from "../chrome";
import { InvitePanel } from "./InvitePanel";
import { useAccessStatus } from "./useAccessStatus";
import { useJamRoom } from "./useJamRoom";
import { LiveStage } from "../live/LiveStage";

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  idle: "NOT CONNECTED",
  connecting: "CONNECTING",
  live: "LIVE",
  reconnecting: "RECONNECTING",
  offline: "OFFLINE",
  denied: "ACCESS ENDED",
};

export function Studio({ slug, onExit }: { slug: string; onExit: () => void }) {
  const { state, actions, actionError, contributionAllowed } = useJamRoom(slug);
  const [showInvite, setShowInvite] = useState(false);

  if (state.phase === "loading") {
    return <Shell onExit={onExit}><section className="studio-header"><div><p className="eyebrow">MOVIE JAM</p><h1>Opening the room…</h1></div></section></Shell>;
  }
  if (state.phase === "error" || !state.snapshot) {
    return <Shell onExit={onExit}>
      <section className="studio-header">
        <div><p className="eyebrow">MOVIE JAM</p><h1>This room is not open to you.</h1><p>{state.error}</p></div>
        <div className="studio-actions"><button className="button button-quiet" onClick={onExit}>Back to Reverie</button><button className="button button-primary" onClick={actions.refresh}>Try again <span>↻</span></button></div>
      </section>
    </Shell>;
  }

  const { jam, self, members, messages, proposals } = state.snapshot;
  const isHost = self?.role === "host";
  const waitingMembers = members.filter((member) => member.status === "waiting");
  const activeMembers = members.filter((member) => member.status === "active");
  const onlineIds = new Set(state.presence.map((entry) => entry.userId));

  return <Shell onExit={onExit}>
    <section className="studio-header">
      <div>
        <p className="eyebrow">MOVIE JAM / <ConnectionBadge state={state.connection} /></p>
        <h1>{jam.title}</h1>
        <p>{jam.visibility === "public" ? "Public room" : "Invite-only room"} · {activeMembers.length} in the room · {onlineIds.size} connected now</p>
      </div>
      <div className="studio-actions">
        <button className="button button-quiet" onClick={onExit}>Leave</button>
        {isHost && <button className="button button-primary" onClick={() => setShowInvite((open) => !open)}>
          {showInvite ? "Hide invite" : "Invite people"} <span>↗</span>
        </button>}
      </div>
    </section>

    {state.error && <Notice>{state.error}</Notice>}
    {actionError && <Notice>{actionError}</Notice>}
    {isHost && showInvite && <InvitePanel jamId={jam.id} onClose={() => setShowInvite(false)} />}

    {self?.status !== "active"
      ? <WaitingLobby jamId={jam.id} onAdmitted={actions.refresh} />
      : <section className="studio-grid">
          <aside className="conversation-panel">
            <div className="panel-heading"><div><p className="eyebrow">STORY CONVERSATION</p><h2>What should happen next?</h2></div><span className="local-badge">{CONNECTION_LABEL[state.connection]}</span></div>
            <div className="contribution-list" aria-live="polite">
              {messages.length === 0 && <p>No lines yet. The first one sets the tone.</p>}
              {messages.map((message) => <article className={`contribution ${message.author_id === self.user_id ? "host" : "director"}`} key={message.id}>
                <span>{authorName(members, message.author_id)}</span><p>{message.body}</p>
              </article>)}
            </div>
            <Composer placeholder="Say something to the room…" maxLength={500} disabled={!contributionAllowed} label="Send" onSubmit={actions.sendMessage} />
          </aside>

          <div className="studio-scene">
            <LiveScene compact />
            <div className="queue-card">
              <div><p className="eyebrow">UP NEXT</p><h2>Proposal queue</h2></div>
              <div className="contribution-list" aria-live="polite">
                {proposals.length === 0 && <p>Nothing queued yet.</p>}
                {proposals.map((proposal) => <article className="contribution director" key={proposal.id}>
                  <span>{authorName(members, proposal.author_id)} · {proposal.status}</span><p>{proposal.body}</p>
                </article>)}
              </div>
              <Composer placeholder="Add a character, twist, shot, or feeling…" maxLength={280} disabled={!contributionAllowed} label="Propose" onSubmit={actions.addProposal} />
              <p className="form-note">Accepting a proposal into a scene needs the versioned transactional contract that is not implemented yet.</p>
            </div>

            <LiveStage jamId={jam.id} userId={self.user_id} members={members} canJoin={contributionAllowed} />

            <Roster members={activeMembers} onlineIds={onlineIds} selfId={self.user_id} isHost={isHost} onRemove={actions.remove} />
            {isHost && <Lobby waiting={waitingMembers} onAdmit={actions.admit} onRemove={actions.remove} />}
          </div>
        </section>}
  </Shell>;
}

function Shell({ children, onExit }: { children: ReactNode; onExit: () => void }) {
  return <main className="site-shell studio-shell"><Header onHome={onExit} />{children}<Footer /></main>;
}

function ConnectionBadge({ state }: { state: ConnectionState }) {
  return <span className={`connection connection-${state}`} role="status">{CONNECTION_LABEL[state]}</span>;
}

/**
 * A waiting participant holds no Realtime channel, because channel authorization requires
 * active membership. It polls the one row it is authorized to read — its own — and asks
 * the room to reload the moment that row turns active.
 */
function WaitingLobby({ jamId, onAdmitted }: { jamId: string; onAdmitted: () => void }) {
  const access = useAccessStatus(jamId, true);

  useEffect(() => {
    if (access.status === "active") onAdmitted();
  }, [access.status, onAdmitted]);

  const refused = access.status === "removed";
  return <section className="studio-grid"><aside className="conversation-panel">
    <div className="panel-heading">
      <div><p className="eyebrow">LOBBY</p><h2>{refused ? "The host did not admit you." : "Waiting for the host."}</h2></div>
      <span className="local-badge">{refused ? "NOT ADMITTED" : access.checking ? "CHECKING" : "WAITING"}</span>
    </div>
    <p>{refused
      ? "This session cannot enter this jam. Ask the host directly if that was not intended."
      : "The conversation and the proposal queue open when the host admits you. This page checks every few seconds."}</p>
    {access.error && <Notice>{access.error}</Notice>}
  </aside><div className="studio-scene"><LiveScene compact /></div></section>;
}

function Roster({ members, onlineIds, selfId, isHost, onRemove }: {
  members: readonly JamMember[];
  onlineIds: ReadonlySet<string>;
  selfId: string;
  isHost: boolean;
  onRemove: (memberId: string) => void;
}) {
  return <div className="queue-card">
    <div><p className="eyebrow">IN THE ROOM</p><h2>{members.length} director{members.length === 1 ? "" : "s"}</h2></div>
    <ul className="roster">
      {members.map((member) => <li key={member.user_id}>
        <span className={onlineIds.has(member.user_id) ? "roster-dot online" : "roster-dot"} aria-label={onlineIds.has(member.user_id) ? "connected" : "away"} />
        <span>{member.display_name}{member.role === "host" ? " · host" : ""}{member.user_id === selfId ? " · you" : ""}</span>
        {isHost && member.role !== "host" && <button className="button button-quiet" onClick={() => onRemove(member.user_id)}>Remove</button>}
      </li>)}
    </ul>
  </div>;
}

function Lobby({ waiting, onAdmit, onRemove }: {
  waiting: readonly JamMember[];
  onAdmit: (memberId: string) => void;
  onRemove: (memberId: string) => void;
}) {
  return <div className="queue-card">
    <div><p className="eyebrow">LOBBY</p><h2>{waiting.length} waiting</h2></div>
    {waiting.length === 0
      ? <p>Nobody is waiting for admission.</p>
      : <ul className="roster">{waiting.map((member) => <li key={member.user_id}>
          <span className="roster-dot" /><span>{member.display_name}</span>
          <button className="button button-primary" onClick={() => onAdmit(member.user_id)}>Admit</button>
          <button className="button button-quiet" onClick={() => onRemove(member.user_id)}>Refuse</button>
        </li>)}</ul>}
  </div>;
}

function Composer({ placeholder, maxLength, disabled, label, onSubmit }: {
  placeholder: string;
  maxLength: number;
  disabled: boolean;
  label: string;
  onSubmit: (body: string) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    void onSubmit(body);
  }
  return <form className="contribution-form" onSubmit={submit}>
    <label className="sr-only" htmlFor={`composer-${label}`}>{placeholder}</label>
    <textarea id={`composer-${label}`} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={placeholder} maxLength={maxLength} disabled={disabled} />
    <button className="button button-primary" type="submit" disabled={disabled}>{label} <span>↗</span></button>
  </form>;
}
