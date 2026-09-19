import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryPortionMediaStore } from "../apps/server/media";
import {
  MediaStorageError,
  resolvePortionMediaStore,
  resolvePortionStorageConfig,
  SupabasePortionMediaStore,
} from "../apps/server/supabaseMedia";

const JAM = "11111111-2222-4333-8444-555555555555";
const CONFIG = { url: "https://project.supabase.co", serviceRoleKey: "service-key", bucket: "jam-portions" };

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

/** A Storage double that records what the server sent and holds uploaded objects. */
function storageDouble(options: { failUpload?: boolean } = {}) {
  const calls: Call[] = [];
  const objects = new Map<string, Buffer>();

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, url, headers, body: init?.body });

    if (url.includes("/object/list/")) {
      const prefix = JSON.parse(String(init?.body)).prefix as string;
      const listed = [...objects.keys()]
        .filter((path) => path.startsWith(prefix))
        .map((path) => ({ name: path.slice(prefix.length + 1) }));
      return new Response(JSON.stringify(listed), { status: 200 });
    }
    if (method === "POST") {
      if (options.failUpload) {
        return new Response(JSON.stringify({ message: "bucket jam-portions denied for role service_role" }), { status: 403 });
      }
      objects.set(url.split(`/object/${CONFIG.bucket}/`)[1], Buffer.from(init?.body as Uint8Array));
      return new Response("{}", { status: 200 });
    }
    if (method === "DELETE") return new Response("{}", { status: 200 });

    const stored = objects.get(url.split(`/object/${CONFIG.bucket}/`)[1] ?? "");
    return stored
      ? new Response(new Uint8Array(stored), { status: 200, headers: { "content-type": "video/mp4" } })
      : new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls, objects };
}

test("storage is configured only when the server holds a service-role key", () => {
  assert.equal(resolvePortionStorageConfig({ SUPABASE_URL: CONFIG.url } as NodeJS.ProcessEnv), null);
  assert.equal(resolvePortionStorageConfig({ SUPABASE_SERVICE_ROLE_KEY: "k" } as NodeJS.ProcessEnv), null);
  assert.deepEqual(
    resolvePortionStorageConfig({
      VITE_SUPABASE_URL: `${CONFIG.url}/`,
      SUPABASE_SERVICE_ROLE_KEY: " service-key ",
    } as NodeJS.ProcessEnv),
    CONFIG,
  );
  assert.throws(
    () => resolvePortionStorageConfig({
      SUPABASE_URL: CONFIG.url,
      SUPABASE_SERVICE_ROLE_KEY: "k",
      REVERIE_PORTION_BUCKET: "../secrets",
    } as NodeJS.ProcessEnv),
    MediaStorageError,
  );
});

test("an unconfigured server keeps clips in memory and does not claim durability", () => {
  const store = resolvePortionMediaStore({} as NodeJS.ProcessEnv);
  assert.ok(store instanceof InMemoryPortionMediaStore);
  assert.equal(store.durable, false);
  assert.equal(
    resolvePortionMediaStore({ SUPABASE_URL: CONFIG.url, SUPABASE_SERVICE_ROLE_KEY: "k" } as NodeJS.ProcessEnv).durable,
    true,
  );
});

test("a clip is uploaded to the jam's own path and served back from the cache", async () => {
  const { fetchImpl, calls, objects } = storageDouble();
  const store = new SupabasePortionMediaStore(CONFIG, { fetchImpl });

  await store.put(JAM, 0, Buffer.from("clip-bytes"), "video/mp4");
  const upload = calls.find((call) => call.method === "POST" && !call.url.includes("/list/"));
  assert.ok(upload);
  assert.equal(upload.url, `${CONFIG.url}/storage/v1/object/${CONFIG.bucket}/jams/${JAM}/portions/0.mp4`);
  assert.equal(upload.headers.authorization, "Bearer service-key");
  assert.equal(upload.headers["x-upsert"], "true");
  assert.equal(upload.headers["content-type"], "video/mp4");
  assert.deepEqual([...objects.keys()], [`jams/${JAM}/portions/0.mp4`]);

  const before = calls.length;
  const clip = await store.get(JAM, 0);
  assert.equal(clip?.bytes.toString(), "clip-bytes");
  assert.equal(await store.has(JAM, 0), true);
  assert.equal(calls.length, before, "a cached clip is served without touching storage");
});

test("a clip stored before this process started is found and downloaded once", async () => {
  const { fetchImpl, calls, objects } = storageDouble();
  objects.set(`jams/${JAM}/portions/2.mp4`, Buffer.from("restarted"));
  const store = new SupabasePortionMediaStore(CONFIG, { fetchImpl });

  assert.equal(await store.has(JAM, 2), true, "a restart does not lose the clip");
  assert.equal(await store.has(JAM, 3), false);
  assert.equal(calls.filter((call) => call.url.includes("/list/")).length, 1, "one listing answers every portion");

  const clip = await store.get(JAM, 2);
  assert.equal(clip?.bytes.toString(), "restarted");
  assert.equal(clip?.contentType, "video/mp4");
  assert.equal(await (await store.get(JAM, 3)), null);
});

test("a storage failure fails the clip without repeating what storage said", async () => {
  const { fetchImpl } = storageDouble({ failUpload: true });
  const store = new SupabasePortionMediaStore(CONFIG, { fetchImpl });
  await assert.rejects(
    () => store.put(JAM, 0, Buffer.from("clip"), "video/mp4"),
    (error: unknown) => {
      assert.ok(error instanceof MediaStorageError);
      assert.equal(error.message, "The generated clip could not be stored.");
      assert.doesNotMatch(error.message, /bucket|role|service/i);
      return true;
    },
  );
});

test("a jam id that could reshape the object path stores and reads nothing", async () => {
  const { fetchImpl, calls } = storageDouble();
  const store = new SupabasePortionMediaStore(CONFIG, { fetchImpl });
  await assert.rejects(() => store.put("../../other", 0, Buffer.from("x"), "video/mp4"), MediaStorageError);
  assert.equal(await store.get("../../other", 0), null);
  assert.equal(await store.has("../../other", 0), false);
  assert.deepEqual(calls, [], "no request is made for an id that cannot address an object");
});

test("closing a jam removes the clips it stored", async () => {
  const { fetchImpl, calls, objects } = storageDouble();
  objects.set(`jams/${JAM}/portions/0.mp4`, Buffer.from("a"));
  objects.set(`jams/${JAM}/portions/1.mp4`, Buffer.from("b"));
  const store = new SupabasePortionMediaStore(CONFIG, { fetchImpl });

  await store.deleteJam(JAM);
  const deletion = calls.find((call) => call.method === "DELETE");
  assert.ok(deletion);
  assert.deepEqual(JSON.parse(String(deletion.body)).prefixes.sort(), [
    `jams/${JAM}/portions/0.mp4`,
    `jams/${JAM}/portions/1.mp4`,
  ]);
});
