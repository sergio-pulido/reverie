import assert from "node:assert/strict";
import { test } from "node:test";
import {
  downloadSegment,
  FalSegmentError,
  getSegmentStatus,
  getSegmentUrl,
  resolveFalSegmentConfig,
  submitSegment,
  type FalSegmentConfig,
} from "../apps/server/providers/falSegments";
import {
  clampDuration,
  FAL_SEGMENT_MODEL_ALLOWLIST,
  findSegmentModel,
} from "../apps/server/providers/falSegmentModels";
import { MAX_SEGMENT_BYTES } from "../apps/server/objectStorage";

const config: FalSegmentConfig = {
  apiKey: "test-key",
  model: findSegmentModel("minimax/h3-max/text-to-video")!,
};

/** Runs `work` with `fetch` replaced, and records what it was called with. */
async function withFetch<T>(
  reply: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
  work: (calls: { url: string; init: RequestInit | undefined }[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return reply(url, init);
  }) as typeof fetch;
  try {
    return await work(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("the allowlist is the only way to pick a model", () => {
  assert.deepEqual([...FAL_SEGMENT_MODEL_ALLOWLIST], [
    "minimax/h3-max/text-to-video",
    "minimax/h3-max-turbo/text-to-video",
  ]);
  const chosen = resolveFalSegmentConfig({
    REVERIE_LIVE_ENABLED: "true",
    FAL_KEY: "k",
    FAL_MODEL: "minimax/h3-max-turbo/text-to-video",
  } as NodeJS.ProcessEnv);
  assert.equal(chosen?.model.slug, "minimax/h3-max-turbo/text-to-video");

  assert.throws(
    () =>
      resolveFalSegmentConfig({
        REVERIE_LIVE_ENABLED: "true",
        FAL_KEY: "k",
        FAL_MODEL: "somebody-else/cheap-video",
      } as NodeJS.ProcessEnv),
    FalSegmentError,
    "an unknown model is refused, never quietly replaced",
  );
});

test("without the flag or the key there is no configuration at all", () => {
  assert.equal(resolveFalSegmentConfig({ FAL_KEY: "k" } as NodeJS.ProcessEnv), null);
  assert.equal(
    resolveFalSegmentConfig({ REVERIE_LIVE_ENABLED: "true" } as NodeJS.ProcessEnv),
    null,
  );
  assert.equal(
    resolveFalSegmentConfig({ REVERIE_LIVE_ENABLED: "yes", FAL_KEY: "k" } as NodeJS.ProcessEnv),
    null,
    "only the exact string turns paid generation on",
  );
});

test("a submit carries the model's own body and an in-band duration", async () => {
  const requestId = await withFetch(
    () => json({ request_id: "req-1" }),
    async (calls) => {
      const id = await submitSegment(config, { prompt: "a cold loading bay", durationSeconds: 40 });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://queue.fal.run/minimax/h3-max/text-to-video");
      const body = JSON.parse(String(calls[0].init?.body));
      assert.deepEqual(body, {
        prompt: "a cold loading bay",
        duration: 15,
        resolution: "768P",
        aspect_ratio: "16:9",
      });
      const headers = calls[0].init?.headers as Record<string, string>;
      assert.equal(headers.authorization, "Key test-key");
      return id;
    },
  );
  assert.equal(requestId, "req-1");
});

test("duration is clamped to the band the model publishes", () => {
  assert.equal(clampDuration(config.model, 2), 5);
  assert.equal(clampDuration(config.model, 15), 15);
  assert.equal(clampDuration(config.model, 99), 15);
  assert.equal(clampDuration(config.model, 7.4), 7);
});

test("a queued request is polled by application, not by slug", async () => {
  await withFetch(
    () => json({ status: "IN_PROGRESS" }),
    async (calls) => {
      assert.equal(await getSegmentStatus(config, "req-1"), "generating");
      assert.equal(
        calls[0].url,
        "https://queue.fal.run/minimax/h3-max/requests/req-1/status",
      );
    },
  );
});

test("every queue status maps to a state the room can be told", async () => {
  for (const [upstream, expected] of [
    ["IN_QUEUE", "queued"],
    ["IN_PROGRESS", "generating"],
    ["COMPLETED", "completed"],
  ] as const) {
    await withFetch(
      () => json({ status: upstream }),
      async () => assert.equal(await getSegmentStatus(config, "req-1"), expected),
    );
  }
});

test("a result is read from either video shape", async () => {
  await withFetch(
    () => json({ video: { url: "https://v3b.fal.media/a.mp4" } }),
    async () => assert.equal(await getSegmentUrl(config, "r"), "https://v3b.fal.media/a.mp4"),
  );
  await withFetch(
    () => json({ videos: [{ url: "https://v3b.fal.media/b.mp4" }] }),
    async () => assert.equal(await getSegmentUrl(config, "r"), "https://v3b.fal.media/b.mp4"),
  );
});

test("a result with no video is a refusal, not an empty clip", async () => {
  await withFetch(
    () => json({ detail: "nothing here" }),
    async () => {
      await assert.rejects(() => getSegmentUrl(config, "r"), FalSegmentError);
    },
  );
});

test("a provider failure says whether retrying could help, and carries no body", async () => {
  await withFetch(
    () => json({ detail: "quota for account 12345 exceeded" }, 429),
    async () => {
      const error = await submitSegment(config, { prompt: "x", durationSeconds: 5 }).catch(
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof FalSegmentError);
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /12345|quota/);
    },
  );
  await withFetch(
    () => json({ detail: "bad prompt" }, 422),
    async () => {
      const error = await submitSegment(config, { prompt: "x", durationSeconds: 5 }).catch(
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof FalSegmentError);
      assert.equal(error.retryable, false);
    },
  );
});

test("a download is capped, and reports the type it actually got", async () => {
  const small = await downloadSegment(
    "https://v3b.fal.media/a.mp4",
    (async () =>
      new Response(new Uint8Array([0, 1, 2]), {
        headers: { "content-type": "video/mp4" },
      })) as typeof fetch,
  );
  assert.equal(small.bytes.byteLength, 3);
  assert.equal(small.contentType, "video/mp4");

  await assert.rejects(
    () =>
      downloadSegment(
        "https://v3b.fal.media/a.mp4",
        (async () => new Response(new Uint8Array(MAX_SEGMENT_BYTES + 1))) as typeof fetch,
      ),
    FalSegmentError,
  );
});
