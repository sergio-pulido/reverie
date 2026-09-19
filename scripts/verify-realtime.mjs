// Two-session verification for the Movie Jam lobby and Realtime collaboration.
//
// This talks to a real Supabase project through the public anon key and three
// independent anonymous sessions. It is not a mock: every assertion below passes only
// if RLS, the admission RPCs and Realtime are actually configured.
//
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/verify-realtime.mjs
//
// Requirements: both migrations in supabase/migrations applied, Anonymous Sign-Ins
// enabled, and Realtime authorization active. The script leaves one test jam behind and
// prints its slug so it can be removed from the dashboard.

import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error("Set SUPABASE_URL and SUPABASE_ANON_KEY. This script refuses to pretend a room works.");
  process.exit(2);
}

const REALTIME_TIMEOUT_MS = 12_000;
const results = [];

function check(name, run) {
  return run().then(
    () => { results.push([true, name]); console.log(`PASS ${name}`); },
    (error) => { results.push([false, name]); console.error(`FAIL ${name}: ${error.message}`); },
  );
}

/** Each session is an independent client with its own storage: a separate browser. */
async function newSession(label) {
  const memory = new Map();
  const client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: `verify-${label}`,
      storage: {
        getItem: (key) => memory.get(key) ?? null,
        setItem: (key, value) => void memory.set(key, value),
        removeItem: (key) => void memory.delete(key),
      },
    },
  });
  const { data, error } = await client.auth.signInAnonymously();
  if (error || !data.user) throw new Error(`${label} could not sign in anonymously: ${error?.message}`);
  return { label, client, userId: data.user.id };
}

function waitForMessage(session, jamId, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void session.client.removeChannel(channel);
      reject(new Error("no realtime delivery within the timeout"));
    }, REALTIME_TIMEOUT_MS);

    const channel = session.client
      .channel(`jam:${jamId}`, { config: { private: true } })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "jam_messages", filter: `jam_id=eq.${jamId}` }, ({ new: row }) => {
        if (!predicate(row)) return;
        clearTimeout(timer);
        void session.client.removeChannel(channel);
        resolve(row);
      })
      .subscribe((status, error) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          clearTimeout(timer);
          reject(new Error(`channel ${status}: ${error?.message ?? "no detail"}`));
        }
      });
  });
}

const host = await newSession("host");
const guest = await newSession("guest");
const outsider = await newSession("outsider");
const lurker = await newSession("lurker");
await host.client.realtime.setAuth();
await guest.client.realtime.setAuth();

const slug = `verify-room-${Date.now().toString(36)}`;
const created = await host.client
  .from("jams")
  .insert({ slug, title: "Verification Jam", premise: "Two sessions verify the lobby.", visibility: "invite_only", host_id: host.userId })
  .select("id, slug")
  .single();
if (created.error) {
  console.error(`Could not create the verification jam: ${created.error.message}`);
  process.exit(1);
}
const jam = created.data;
console.log(`Verification jam: ${jam.slug} (remove it from the dashboard afterwards)`);

// The invite is host-only at the column level, so even the host reads it through the RPC.
const firstInvite = await host.client.rpc("get_jam_invite", { p_jam_id: jam.id });
if (firstInvite.error) {
  console.error(`Could not read the invite: ${firstInvite.error.message}`);
  process.exit(1);
}
jam.invite_code = firstInvite.data.code;

await check("the host receives a well-formed, active invite code", async () => {
  assert.match(jam.invite_code, /^[A-HJ-NP-TV-Z2-9]{8}$/);
  assert.equal(firstInvite.data.state, "active");
});

await check("nobody can select the invite column directly, not even the host", async () => {
  const hostRead = await host.client.from("jams").select("invite_code").eq("id", jam.id);
  assert.ok(hostRead.error, "the invite column was selectable");
  const guestRead = await guest.client.from("jams").select("invite_code").eq("id", jam.id);
  assert.ok(guestRead.error, "the invite column was selectable by a guest");
});

await check("a host cannot hand-write a predictable invite code", async () => {
  const { error } = await host.client.from("jams").update({ invite_code: "ABCD2345" }).eq("id", jam.id);
  assert.ok(error, "a host wrote their own invite code");
});

await check("a guest cannot read, rotate or revoke someone else's invite", async () => {
  for (const [fn, args] of [
    ["get_jam_invite", { p_jam_id: jam.id }],
    ["rotate_jam_invite", { p_jam_id: jam.id, p_expires_in_minutes: 30 }],
    ["revoke_jam_invite", { p_jam_id: jam.id }],
  ]) {
    const { error } = await guest.client.rpc(fn, args);
    assert.ok(error, `${fn} was allowed for a non-host`);
  }
});

await check("an unknown invite code is refused", async () => {
  const { error } = await guest.client.rpc("request_jam_admission", { p_invite_code: "ZZZZZZZZ", p_display_name: "Guest" });
  assert.ok(error, "an unknown code was accepted");
});

await check("a guest cannot insert a membership row directly", async () => {
  const { error } = await guest.client.from("jam_members").insert({ jam_id: jam.id, user_id: guest.userId, display_name: "Sneak", role: "host", status: "active" });
  assert.ok(error, "direct membership insert was allowed");
});

await check("an invite-only jam places a guest in the lobby", async () => {
  const { data, error } = await guest.client.rpc("request_jam_admission", { p_invite_code: jam.invite_code, p_display_name: "Guest" });
  assert.equal(error, null, error?.message);
  assert.equal(data.memberStatus, "waiting");
  assert.equal(data.slug, jam.slug);
});

await check("a waiting guest cannot read the conversation", async () => {
  const { data, error } = await guest.client.from("jam_messages").select("id").eq("jam_id", jam.id);
  assert.equal(error, null, error?.message);
  assert.equal(data.length, 0);
});

await check("a waiting guest cannot contribute", async () => {
  const { error } = await guest.client.from("jam_messages").insert({ jam_id: jam.id, body: "let me in" });
  assert.ok(error, "a waiting guest was allowed to write");
});

await check("a guest cannot admit themselves", async () => {
  const { error } = await guest.client.rpc("set_jam_member_status", { p_jam_id: jam.id, p_member_id: guest.userId, p_status: "active" });
  assert.ok(error, "self-admission was allowed");
});

await check("the host admits the guest", async () => {
  const { data, error } = await host.client.rpc("set_jam_member_status", { p_jam_id: jam.id, p_member_id: guest.userId, p_status: "active" });
  assert.equal(error, null, error?.message);
  assert.equal(data.status, "active");
  assert.equal(data.role, "member");
});

await check("an admitted guest receives the host's message over Realtime", async () => {
  const body = `host line ${Date.now()}`;
  const delivered = waitForMessage(guest, jam.id, (row) => row.body === body);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const { error } = await host.client.from("jam_messages").insert({ jam_id: jam.id, body });
  assert.equal(error, null, error?.message);
  const row = await delivered;
  assert.equal(row.author_id, host.userId, "author identity did not come from Auth");
});

await check("only the host can see who is waiting in the lobby", async () => {
  const joined = await lurker.client.rpc("request_jam_admission", { p_invite_code: jam.invite_code, p_display_name: "Lurker" });
  assert.equal(joined.error, null, joined.error?.message);
  assert.equal(joined.data.memberStatus, "waiting");

  const hostView = await host.client.from("jam_members").select("user_id, status").eq("jam_id", jam.id);
  assert.ok(hostView.data.some((row) => row.user_id === lurker.userId), "the host could not see the waiting participant");

  const peerView = await guest.client.from("jam_members").select("user_id, status").eq("jam_id", jam.id);
  assert.equal(peerView.data.some((row) => row.user_id === lurker.userId), false, "an active member enumerated the waiting lobby");
});

await check("a proposal from the guest reaches the host over Realtime", async () => {
  const body = `guest proposal ${Date.now()}`;
  const delivered = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no realtime delivery within the timeout")), REALTIME_TIMEOUT_MS);
    const channel = host.client
      .channel(`jam:${jam.id}`, { config: { private: true } })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "jam_proposals", filter: `jam_id=eq.${jam.id}` }, ({ new: row }) => {
        if (row.body !== body) return;
        clearTimeout(timer);
        void host.client.removeChannel(channel);
        resolve(row);
      })
      .subscribe();
  });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const { error } = await guest.client.from("jam_proposals").insert({ jam_id: jam.id, body });
  assert.equal(error, null, error?.message);
  const row = await delivered;
  assert.equal(row.author_id, guest.userId);
  assert.equal(row.status, "queued");
});

await check("a reload closes the gap left by a disconnected subscription", async () => {
  // Nothing is subscribed here on purpose: this is the reconnect snapshot path.
  const body = `offline line ${Date.now()}`;
  await host.client.from("jam_messages").insert({ jam_id: jam.id, body });
  const { data, error } = await guest.client.from("jam_messages").select("id, body").eq("jam_id", jam.id);
  assert.equal(error, null, error?.message);
  assert.ok(data.some((row) => row.body === body), "the snapshot did not contain the missed message");
});

await check("an outsider cannot see the jam", async () => {
  const { data, error } = await outsider.client.from("jams").select("id").eq("slug", jam.slug).maybeSingle();
  assert.equal(error, null, error?.message);
  assert.equal(data, null, "an outsider read a jam they do not belong to");
});

await check("an outsider cannot read the conversation or contribute", async () => {
  const read = await outsider.client.from("jam_messages").select("id").eq("jam_id", jam.id);
  assert.equal(read.data?.length ?? 0, 0);
  const write = await outsider.client.from("jam_messages").insert({ jam_id: jam.id, body: "hello" });
  assert.ok(write.error, "an outsider was allowed to write");
});

await check("the host removes the guest", async () => {
  const { data, error } = await host.client.rpc("set_jam_member_status", { p_jam_id: jam.id, p_member_id: guest.userId, p_status: "removed" });
  assert.equal(error, null, error?.message);
  assert.equal(data.status, "removed");
});

await check("a removed guest loses read and write access", async () => {
  const read = await guest.client.from("jam_messages").select("id").eq("jam_id", jam.id);
  assert.equal(read.data?.length ?? 0, 0, "a removed guest still read the conversation");
  const write = await guest.client.from("jam_messages").insert({ jam_id: jam.id, body: "still here" });
  assert.ok(write.error, "a removed guest was allowed to write");
});

await check("a removed guest cannot re-enter with the same invite code", async () => {
  const { error } = await guest.client.rpc("request_jam_admission", { p_invite_code: jam.invite_code, p_display_name: "Guest" });
  assert.ok(error, "a removed guest re-entered the jam");
});

// --- invite lifecycle ---------------------------------------------------------

await check("a repeated request from a waiting participant is idempotent", async () => {
  const first = await lurker.client.rpc("request_jam_admission", { p_invite_code: jam.invite_code, p_display_name: "Lurker" });
  assert.equal(first.error, null, first.error?.message);
  assert.equal(first.data.memberStatus, "waiting");
  const again = await lurker.client.rpc("request_jam_admission", { p_invite_code: jam.invite_code, p_display_name: "Lurker Again" });
  assert.equal(again.error, null, again.error?.message);
  assert.equal(again.data.memberStatus, "waiting", "a repeated request changed the status");
});

await check("a waiting participant can read their own membership row and nothing else", async () => {
  const own = await lurker.client.from("jam_members").select("user_id, status").eq("jam_id", jam.id);
  assert.equal(own.error, null, own.error?.message);
  assert.equal(own.data.length, 1, "a waiting participant saw more than their own row");
  assert.equal(own.data[0].user_id, lurker.userId);
  assert.equal(own.data[0].status, "waiting");
});

await check("a revoked invite stops admitting and is indistinguishable from an unknown code", async () => {
  const revoked = await host.client.rpc("revoke_jam_invite", { p_jam_id: jam.id });
  assert.equal(revoked.error, null, revoked.error?.message);
  assert.equal(revoked.data.state, "revoked");

  const attempt = await outsider.client.rpc("request_jam_admission", { p_invite_code: jam.invite_code, p_display_name: "Outsider" });
  assert.ok(attempt.error, "a revoked invite still admitted");
  const unknown = await outsider.client.rpc("request_jam_admission", { p_invite_code: "ZZZZZZZZ", p_display_name: "Outsider" });
  assert.equal(attempt.error.message, unknown.error.message, "a revoked invite is distinguishable from an unknown code");
});

await check("rotating mints a new code and kills the old one", async () => {
  const rotated = await host.client.rpc("rotate_jam_invite", { p_jam_id: jam.id, p_expires_in_minutes: 30 });
  assert.equal(rotated.error, null, rotated.error?.message);
  assert.notEqual(rotated.data.code, jam.invite_code, "rotation reused the previous code");
  assert.match(rotated.data.code, /^[A-HJ-NP-TV-Z2-9]{8}$/);
  assert.equal(rotated.data.state, "active");
  assert.ok(Date.parse(rotated.data.expiresAt) > Date.now(), "the rotated invite is already expired");

  const stale = await outsider.client.rpc("request_jam_admission", { p_invite_code: jam.invite_code, p_display_name: "Outsider" });
  assert.ok(stale.error, "the previous invite code still worked after rotation");
  jam.invite_code = rotated.data.code;
});

await check("a rotated invite admits again", async () => {
  const { data, error } = await outsider.client.rpc("request_jam_admission", { p_invite_code: jam.invite_code, p_display_name: "Outsider" });
  assert.equal(error, null, error?.message);
  assert.equal(data.memberStatus, "waiting");
});

await check("an out-of-band invite lifetime is refused", async () => {
  for (const minutes of [1, 4, 5000]) {
    const { error } = await host.client.rpc("rotate_jam_invite", { p_jam_id: jam.id, p_expires_in_minutes: minutes });
    assert.ok(error, `${minutes} minutes was accepted`);
  }
});

await check("repeated wrong codes are throttled before a private room can be enumerated", async () => {
  const prober = await newSession("prober");
  let throttledAt = null;
  for (let attempt = 1; attempt <= 12 && throttledAt === null; attempt += 1) {
    const guess = `Z${attempt.toString().padStart(7, "2")}`.slice(0, 8).toUpperCase();
    const { error } = await prober.client.rpc("request_jam_admission", { p_invite_code: guess, p_display_name: "Prober" });
    assert.ok(error, "a guessed code was accepted");
    if (/too many invite attempts/.test(error.message)) throttledAt = attempt;
  }
  assert.ok(throttledAt !== null, "an unlimited number of invite guesses was allowed");
  console.log(`      throttled after ${throttledAt} failed lookups`);

  // The throttle must not leak into the real invite either.
  const blocked = await prober.client.rpc("request_jam_admission", { p_invite_code: jam.invite_code, p_display_name: "Prober" });
  assert.ok(blocked.error, "a throttled session still exchanged a valid invite");
  await prober.client.auth.signOut();
});

for (const session of [host, guest, outsider, lurker]) {
  await session.client.removeAllChannels();
  await session.client.auth.signOut();
}

const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
