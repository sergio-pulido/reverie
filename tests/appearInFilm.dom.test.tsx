import "./dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, click, render, settle } from "./render";
import { AppearInFilm } from "../src/live/AppearInFilm";
import type { LiveConsent, LiveConsentKind } from "../src/core/liveMedia";
import type { JamMember } from "../src/core/room";

const ALICE = "a0000000-0000-4000-8000-00000000000a";
const BRUNO = "b0000000-0000-4000-8000-00000000000b";
const JAM = "10000000-0000-4000-8000-000000000001";

const members: JamMember[] = [
  { jam_id: JAM, user_id: ALICE, display_name: "Alice", role: "host", status: "active", joined_at: "2026-09-20T11:00:00.000Z" },
  { jam_id: JAM, user_id: BRUNO, display_name: "Bruno", role: "member", status: "active", joined_at: "2026-09-20T11:01:00.000Z" },
];

function consent(overrides: Partial<LiveConsent> = {}): LiveConsent {
  const granted = Date.now() - 60_000;
  return {
    id: "c0000000-0000-4000-8000-000000000001",
    jam_id: JAM,
    owner_id: ALICE,
    kind: "likeness" as LiveConsentKind,
    purpose: "be the detective",
    asset_ref: "likeness:11111111-2222-4333-8444-555555555555",
    granted_at: new Date(granted).toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    withdrawn_at: null,
    ...overrides,
  };
}

/** Every getUserMedia call, so a test can prove the camera opened only on a press. */
let cameraCalls = 0;
let stoppedTracks = 0;

beforeEach(() => {
  cameraCalls = 0;
  stoppedTracks = 0;
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        cameraCalls += 1;
        return { getTracks: () => [{ stop: () => { stoppedTracks += 1; } }] } as unknown as MediaStream;
      },
    },
  });
});

afterEach(cleanup);

function text(container: HTMLElement): string {
  return container.textContent ?? "";
}

function buttonSaying(container: HTMLElement, label: string): HTMLButtonElement | null {
  const match = [...container.querySelectorAll("button")].find((button) =>
    (button.textContent ?? "").includes(label),
  );
  return (match as HTMLButtonElement | undefined) ?? null;
}

test("a room where nobody has agreed says so, and claims no likeness", async () => {
  const container = await render(
    <AppearInFilm jamId={JAM} userId={ALICE} members={members} canAppear consents={[]} onChanged={() => {}} />,
  );
  assert.match(text(container), /Nobody has agreed to appear/);
  assert.match(text(container), /NOT IN IT/);
  assert.equal(cameraCalls, 0, "nothing opened a camera on its own");
});

test("the camera opens only on a press, and takes no picture by opening", async () => {
  const container = await render(
    <AppearInFilm jamId={JAM} userId={ALICE} members={members} canAppear consents={[]} onChanged={() => {}} />,
  );
  assert.equal(cameraCalls, 0);

  await click(buttonSaying(container, "Turn on my camera"));
  assert.equal(cameraCalls, 1);
  assert.ok(container.querySelector("video"), "the camera is showing");
  // Nothing has been captured or recorded: the only way forward is another press.
  assert.ok(buttonSaying(container, "Take the picture"), "a picture is taken by pressing");
  assert.equal(text(container).includes("Use this picture of me"), false);
});

test("turning the camera off stops its tracks", async () => {
  const container = await render(
    <AppearInFilm jamId={JAM} userId={ALICE} members={members} canAppear consents={[]} onChanged={() => {}} />,
  );
  await click(buttonSaying(container, "Turn on my camera"));
  await click(buttonSaying(container, "Turn the camera off"));
  assert.equal(stoppedTracks, 1);
  assert.equal(container.querySelector("video"), null);
});

test("someone who has agreed sees one press that takes them out", async () => {
  const container = await render(
    <AppearInFilm jamId={JAM} userId={ALICE} members={members} canAppear consents={[consent()]} onChanged={() => {}} />,
  );
  assert.match(text(container), /YOU ARE IN IT/);
  assert.match(text(container), /be the detective/);
  const out = buttonSaying(container, "Take me out of the film");
  assert.ok(out, "withdrawing is one press, not a menu");
  assert.equal(out?.disabled, false);
});

test("the words about an already-generated beat do not pretend it can be recalled", async () => {
  const container = await render(
    <AppearInFilm jamId={JAM} userId={ALICE} members={members} canAppear consents={[consent()]} onChanged={() => {}} />,
  );
  const words = text(container);
  assert.match(words, /Beats already generated still show you/);
  assert.match(words, /cannot be called back/);
  assert.doesNotMatch(words, /remove.{0,20}from (every|all)/i);
});

test("a withdrawn agreement reads as ended, and offers no withdraw button", async () => {
  const withdrawn = consent({ withdrawn_at: new Date().toISOString() });
  const container = await render(
    <AppearInFilm jamId={JAM} userId={ALICE} members={members} canAppear consents={[withdrawn]} onChanged={() => {}} />,
  );
  assert.match(text(container), /NOT IN IT/);
  assert.match(text(container), /No longer in the film/);
  assert.match(text(container), /Beats made while they were still stand/);
  assert.equal(buttonSaying(container, "Withdraw"), null);
});

test("an expired agreement reads the same as a withdrawn one", async () => {
  const expired = consent({ expires_at: new Date(Date.now() - 1_000).toISOString() });
  const container = await render(
    <AppearInFilm jamId={JAM} userId={ALICE} members={members} canAppear consents={[expired]} onChanged={() => {}} />,
  );
  assert.match(text(container), /NOT IN IT/);
  assert.match(text(container), /No longer in the film/);
});

test("another participant's agreement is shown but is not this viewer's to withdraw", async () => {
  const theirs = consent({ owner_id: BRUNO, purpose: "be the driver" });
  const container = await render(
    <AppearInFilm jamId={JAM} userId={ALICE} members={members} canAppear consents={[theirs]} onChanged={() => {}} />,
  );
  assert.match(text(container), /Bruno/);
  assert.match(text(container), /be the driver/);
  assert.match(text(container), /NOT IN IT/, "somebody else agreeing does not put this viewer in the film");
  assert.equal(buttonSaying(container, "Withdraw"), null);
  assert.equal(buttonSaying(container, "Take me out of the film"), null);
  // Another participant's reference never reaches this browser's markup.
  assert.doesNotMatch(text(container), new RegExp(theirs.asset_ref));
});

test("a waiting participant cannot start the camera at all", async () => {
  const container = await render(
    <AppearInFilm jamId={JAM} userId={ALICE} members={members} canAppear={false} consents={[]} onChanged={() => {}} />,
  );
  assert.equal(buttonSaying(container, "Turn on my camera")?.disabled, true);
  await settle(1);
  assert.equal(cameraCalls, 0);
});
