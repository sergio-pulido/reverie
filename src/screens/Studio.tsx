import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { authorName, type ConnectionState, type JamMember, type JamProposal } from "../core/room";
import type { SessionSettings } from "../core/session";
import { Footer, Notice } from "../chrome";
import { TopBar } from "../shell/TopBar";
import { InvitePanel } from "./InvitePanel";
import { EscapeRoom } from "./EscapeRoom";
import { JamDirector } from "./JamDirector";
import { useEscapeRoom } from "./useEscapeRoom";
import { OutlinePanel } from "./OutlinePanel";
import { useAccessStatus } from "./useAccessStatus";
import { useJamRoom } from "./useJamRoom";
import { readJamConfiguration } from "../lib/jamConfiguration";
import { LiveStage } from "../live/LiveStage";
import { AppearInFilm } from "../live/AppearInFilm";
import { useConsentRegister } from "../live/useConsentRegister";

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  idle: "NOT CONNECTED",
  connecting: "CONNECTING",
  live: "LIVE",
  reconnecting: "RECONNECTING",
  offline: "OFFLINE",
  denied: "ACCESS ENDED",
};

/**
 * The live room. "Leave the room" is a room action, not a way back: it ends this participant's
 * presence, and unmounting the room stops any live camera, microphone or screen tracks.
 */
export function Studio({ slug, onLeave }: { slug: string; onLeave: () => void }) {
  const { state, actions, actionError, contributionAllowed } = useJamRoom(slug);
  const [showInvite, setShowInvite] = useState(false);
  const inviteToggle = useRef<HTMLButtonElement | null>(null);
  const [chatWidth, setChatWidth] = useChatWidth();
  const jamId = state.snapshot?.jam.id ?? null;
  // Hooks run before the early returns below.
  const configuration = useMemo(() => (jamId ? readJamConfiguration(jamId) : null), [jamId]);
  // One register for the room: the live stage and the film read the same rows, so the two
  // panels can never disagree about what somebody agreed to.
  const register = useConsentRegister(jamId, contributionAllowed);

  if (state.phase === "loading") {
    return <Shell><section className="studio-header"><div><p className="eyebrow">MOVIE JAM</p><h1>Opening the room…</h1></div></section></Shell>;
  }
  if (state.phase === "error" || !state.snapshot) {
    return <Shell>
      <section className="studio-header">
        <div><p className="eyebrow">MOVIE JAM</p><h1>This room is not open to you.</h1><p>{state.error}</p></div>
        <div className="studio-actions"><button className="button button-primary" onClick={actions.refresh}>Try again <span>↻</span></button></div>
      </section>
    </Shell>;
  }

  const { jam, self, members, messages, proposals } = state.snapshot;
  const isHost = self?.role === "host";
  const waitingMembers = members.filter((member) => member.status === "waiting");
  const activeMembers = members.filter((member) => member.status === "active");

  return <Shell>
    <section className="studio-header">
      <div>
        <p className="eyebrow">MOVIE JAM / <ConnectionBadge state={state.connection} /></p>
        <h1>{jam.title}</h1>
        <p>{jam.visibility === "public" ? "Public room" : "Invite-only room"} · {activeMembers.length} in the room</p>
      </div>
      <div className="studio-actions">
        <button className="button button-quiet" onClick={onLeave}>Leave the room</button>
        {isHost && <button className="button button-primary" ref={inviteToggle} onClick={() => setShowInvite((open) => !open)}>
          {showInvite ? "Hide invite" : "Invite people"} <span>↗</span>
        </button>}
      </div>
    </section>

    {state.error && <Notice>{state.error}</Notice>}
    {actionError && <Notice>{actionError}</Notice>}
    {isHost && showInvite && <InvitePanel jamId={jam.id} onClose={() => {
      setShowInvite(false);
      inviteToggle.current?.focus();
    }} />}

    {self?.status !== "active"
      ? <WaitingLobby jamId={jam.id} onAdmitted={actions.refresh} />
      : <section className="studio-grid" style={{ "--chat-width": `${chatWidth}%` } as CSSProperties}>
          <aside className="conversation-panel">
            <div className="panel-heading"><div><p className="eyebrow">STORY CONVERSATION</p><h2>What should happen next?</h2></div><span className="local-badge">{CONNECTION_LABEL[state.connection]}</span></div>
            <div className="contribution-list" aria-live="polite">
              {messages.length === 0 && <p>No lines yet. The first one sets the tone.</p>}
              {messages.map((message) => <article className={`contribution ${message.author_id === self.user_id ? "host" : "director"}`} key={message.id}>
                <span>{authorName(members, message.author_id)}</span><p>{message.body}</p>
              </article>)}
            </div>
            <Composer placeholder="Say something to the room…" maxLength={500} disabled={!contributionAllowed} label="Send" onSubmit={actions.sendMessage} />
            <ChatResizer width={chatWidth} onChange={setChatWidth} />
          </aside>

          <div className="studio-scene">
            <Story
              jamId={jam.id}
              isHost={isHost}
              authorId={self.user_id}
              displayName={self.display_name}
              contributionAllowed={contributionAllowed}
              configuration={configuration}
              members={members}
              proposals={proposals}
              onPropose={actions.addProposal}
            />

            <LiveStage jamId={jam.id} userId={self.user_id} members={members} canJoin={contributionAllowed} register={register} />

            <AppearInFilm
              jamId={jam.id}
              userId={self.user_id}
              members={members}
              canAppear={contributionAllowed}
              consents={register.consents}
              onChanged={register.reload}
            />

            <Roster members={activeMembers} selfId={self.user_id} isHost={isHost} onRemove={actions.remove} />
            {isHost && <Lobby waiting={waitingMembers} onAdmit={actions.admit} onRemove={actions.remove} />}
          </div>
        </section>}
  </Shell>;
}

/**
 * What the room is making, which is one of two things.
 *
 * An escape room is a jam with a fixed world and a goal, so it is drawn here,
 * in the slot the live director occupies otherwise, rather than on a screen of
 * its own — everything around it (the invite, the lobby, the chat, the roster,
 * the live stage) is the jam's and is untouched. Which one this is comes from
 * the server: `absent` means this jam has no escape room, and until the answer
 * arrives neither is drawn, so the panels do not swap under the reader.
 */
function Story({
  jamId,
  isHost,
  authorId,
  displayName,
  contributionAllowed,
  configuration,
  members,
  proposals,
  onPropose,
}: {
  jamId: string;
  isHost: boolean;
  authorId: string;
  displayName: string;
  contributionAllowed: boolean;
  configuration: SessionSettings | null;
  members: readonly JamMember[];
  proposals: readonly JamProposal[];
  onPropose: (body: string) => void | Promise<void>;
}) {
  const escape = useEscapeRoom(jamId);

  if (escape.state.status === "unknown") return null;
  if (escape.state.status === "present") {
    return <EscapeRoom
      snapshot={escape.state.snapshot}
      isHost={isHost}
      displayName={displayName}
      canContribute={contributionAllowed}
      busy={escape.busy}
      failure={escape.failure}
      actions={escape.actions}
    />;
  }

  // The outline belongs to the screenplay path: an escape room has its own
  // turn structure and no beats to steer.
  return <>
    <JamDirector jamId={jamId} configuration={configuration} />
    <OutlinePanel jamId={jamId} canEdit={contributionAllowed} authorId={authorId} />
    <div className="queue-card queue-card-stack">
      <div><p className="eyebrow">UP NEXT</p><h2>Proposal queue</h2></div>
      <div className="contribution-list" aria-live="polite">
        {proposals.length === 0 && <p>Nothing queued yet.</p>}
        {proposals.map((proposal) => <article className="contribution director" key={proposal.id}>
          <span>{authorName(members, proposal.author_id)} · {proposal.status}</span><p>{proposal.body}</p>
        </article>)}
      </div>
      <Composer placeholder="Add a character, twist, shot, or feeling…" maxLength={280} disabled={!contributionAllowed} label="Propose" onSubmit={onPropose} />
      <p className="form-note">Accepting a proposal into a scene needs the versioned transactional contract that is not implemented yet.</p>
    </div>
  </>;
}

const CHAT_WIDTH = { key: "reverie.studio.chatWidth", min: 22, max: 62, fallback: 38 };

function clampChatWidth(value: number) {
  return Math.min(CHAT_WIDTH.max, Math.max(CHAT_WIDTH.min, Math.round(value)));
}

/**
 * How wide the conversation column sits, as a percentage of the studio grid. This is the
 * reader's own preference rather than a property of the jam, so it is stored per browser
 * and shared across every room. Storage can throw in a private window; the default stands.
 */
function useChatWidth(): [number, (next: number) => void] {
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem(CHAT_WIDTH.key));
      return stored > 0 ? clampChatWidth(stored) : CHAT_WIDTH.fallback;
    } catch {
      return CHAT_WIDTH.fallback;
    }
  });

  const update = useCallback((next: number) => {
    const clamped = clampChatWidth(next);
    setWidth(clamped);
    try {
      window.localStorage.setItem(CHAT_WIDTH.key, String(clamped));
    } catch {
      // A browser that refuses storage still resizes for this visit.
    }
  }, []);

  return [width, update];
}

/** Drag or arrow-key the divider between the conversation and the scene. */
function ChatResizer({ width, onChange }: { width: number; onChange: (next: number) => void }) {
  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const grid = event.currentTarget.closest(".studio-grid");
    if (!grid) return;
    event.preventDefault();
    const bounds = grid.getBoundingClientRect();
    const move = (moveEvent: globalThis.PointerEvent) => onChange(((moveEvent.clientX - bounds.left) / bounds.width) * 100);
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  return <div
    className="chat-resizer"
    role="separator"
    tabIndex={0}
    aria-orientation="vertical"
    aria-label="Resize the conversation"
    aria-valuenow={width}
    aria-valuemin={CHAT_WIDTH.min}
    aria-valuemax={CHAT_WIDTH.max}
    onPointerDown={startDrag}
    onKeyDown={(event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      onChange(width + (event.key === "ArrowLeft" ? -2 : 2));
    }}
  />;
}

function Shell({ children }: { children: ReactNode }) {
  return <main className="site-shell studio-shell"><TopBar current="jam" />{children}<Footer /></main>;
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
  </aside></section>;
}

function Roster({ members, selfId, isHost, onRemove }: {
  members: readonly JamMember[];
  selfId: string;
  isHost: boolean;
  onRemove: (memberId: string) => void;
}) {
  return <div className="queue-card">
    <div><p className="eyebrow">IN THE ROOM</p><h2>{members.length} director{members.length === 1 ? "" : "s"}</h2></div>
    <ul className="roster">
      {members.map((member) => <li key={member.user_id}>
        <span className="roster-dot online" aria-label="active member" />
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
