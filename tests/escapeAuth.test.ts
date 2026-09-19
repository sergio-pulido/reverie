import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request } from "express";
import { createSupabaseAuthorize, EscapeAuthError, requireHost } from "../apps/server/escapeAuth";

/**
 * These routes spend money, so they do not take the browser's word for who it
 * is. Identity is Supabase Auth's answer and the role is the caller's own
 * membership row read under RLS with the caller's own token.
 */

const ENV = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
};

function asRequest(authorization?: string): Request {
  return { headers: authorization ? { authorization } : {} } as unknown as Request;
}

/** Answers the two reads an authorization makes, and counts them. */
function stubSupabase(
  replies: { user?: Response; members?: Response; jams?: Response } = {},
) {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/auth/v1/user")) {
      return replies.user ?? json({ id: "11111111-2222-3333-4444-555555555555" });
    }
    if (url.includes("jam_members")) {
      return replies.members ?? json([{ role: "host", status: "active" }]);
    }
    return replies.jams ?? json([{ status: "live" }]);
  }) as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = original; } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Runs `work` with the Supabase variables set, and awaits it before restoring
 * them: a synchronous restore would take the configuration away mid-test. */
async function withEnv<T>(work: () => Promise<T>): Promise<T> {
  const before = { ...process.env };
  Object.assign(process.env, ENV);
  try {
    return await work();
  } finally {
    process.env = before;
  }
}

test("a request with no bearer token never reaches Supabase", async () => {
  const supabase = stubSupabase();
  try {
    await withEnv(async () => {
      const authorize = createSupabaseAuthorize();
      const error = await authorize(asRequest(), "jam-1").catch((thrown: unknown) => thrown);
      assert.ok(error instanceof EscapeAuthError);
      assert.equal(error.status, 401);
      assert.deepEqual(supabase.urls, []);
    });
  } finally {
    supabase.restore();
  }
});

test("the role comes from the membership row, not from the request", async () => {
  const supabase = stubSupabase();
  try {
    await withEnv(async () => {
      const caller = await createSupabaseAuthorize()(asRequest("Bearer abc.def"), "jam-1");
      assert.deepEqual(caller, {
        userId: "11111111-2222-3333-4444-555555555555",
        role: "host",
        status: "active",
      });
      assert.ok(supabase.urls.some((url) => url.includes("jam_id=eq.jam-1")));
      assert.ok(
        supabase.urls.every((url) => !url.includes("abc.def")),
        "the token travels in a header, never in a URL",
      );
    });
  } finally {
    supabase.restore();
  }
});

test("a waiting member is refused, however they ask", async () => {
  const supabase = stubSupabase({ members: json([{ role: "member", status: "waiting" }]) });
  try {
    await withEnv(async () => {
      const error = await createSupabaseAuthorize()(asRequest("Bearer abc.def"), "jam-1").catch(
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof EscapeAuthError);
      assert.equal(error.status, 403);
    });
  } finally {
    supabase.restore();
  }
});

test("a session Supabase does not recognise is unauthenticated, not forbidden", async () => {
  const supabase = stubSupabase({ user: json({ message: "bad jwt" }, 401) });
  try {
    await withEnv(async () => {
      const error = await createSupabaseAuthorize()(asRequest("Bearer abc.def"), "jam-1").catch(
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof EscapeAuthError);
      assert.equal(error.status, 401);
      assert.equal(error.code, "escape_unauthenticated");
    });
  } finally {
    supabase.restore();
  }
});

test("a repeated check inside the window costs no round trip", async () => {
  const supabase = stubSupabase();
  try {
    await withEnv(async () => {
      let clock = 1_000;
      const authorize = createSupabaseAuthorize(() => clock);
      await authorize(asRequest("Bearer abc.def"), "jam-1");
      const afterFirst = supabase.urls.length;
      await authorize(asRequest("Bearer abc.def"), "jam-1");
      assert.equal(supabase.urls.length, afterFirst, "the second poll is answered from memory");

      // A different room is a different question, and so is a later one.
      await authorize(asRequest("Bearer abc.def"), "jam-2");
      assert.ok(supabase.urls.length > afterFirst);
      const afterSecondRoom = supabase.urls.length;
      clock += 60_000;
      await authorize(asRequest("Bearer abc.def"), "jam-1");
      assert.ok(supabase.urls.length > afterSecondRoom, "the answer expires");
    });
  } finally {
    supabase.restore();
  }
});

test("without Supabase configured, the server says it cannot tell who you are", async () => {
  const before = { ...process.env };
  delete process.env.SUPABASE_URL;
  delete process.env.VITE_SUPABASE_URL;
  try {
    const error = await createSupabaseAuthorize()(asRequest("Bearer abc.def"), "jam-1").catch(
      (thrown: unknown) => thrown,
    );
    assert.ok(error instanceof EscapeAuthError);
    assert.equal(error.status, 503);
  } finally {
    process.env = before;
  }
});

test("requireHost refuses a member and passes a host", () => {
  assert.throws(
    () => requireHost({ userId: "u", role: "member", status: "active" }),
    EscapeAuthError,
  );
  assert.doesNotThrow(() => requireHost({ userId: "u", role: "host", status: "active" }));
});
