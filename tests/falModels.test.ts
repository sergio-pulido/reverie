import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampDuration,
  DEFAULT_FAL_MODEL_SLUG,
  FAL_MODEL_ALLOWLIST,
  FAL_MODEL_SPECS,
  findFalModelSpec,
} from "../apps/server/providers/falModels";
import { resolveFalConfig, FalError } from "../apps/server/providers/fal";
import {
  PORTION_ABSOLUTE_MAX_SECONDS,
  PORTION_ABSOLUTE_MIN_SECONDS,
} from "../src/core/script";

const LIVE = { REVERIE_LIVE_ENABLED: "true", FAL_KEY: "k" } as NodeJS.ProcessEnv;

test("MiniMax H3 Max is the default and the fallback", () => {
  assert.equal(DEFAULT_FAL_MODEL_SLUG, "minimax/h3-max/text-to-video");
  assert.equal(FAL_MODEL_ALLOWLIST[0], DEFAULT_FAL_MODEL_SLUG);
  assert.equal(resolveFalConfig(LIVE)?.spec.slug, DEFAULT_FAL_MODEL_SLUG);
  // An empty FAL_MODEL is a missing switch, not a request for no model.
  assert.equal(
    resolveFalConfig({ ...LIVE, FAL_MODEL: "   " })?.spec.slug,
    DEFAULT_FAL_MODEL_SLUG,
  );
});

test("FAL_MODEL switches to another allowlisted model", () => {
  const config = resolveFalConfig({
    ...LIVE,
    FAL_MODEL: "minimax/h3-max-turbo/text-to-video",
  });
  assert.equal(config?.spec.slug, "minimax/h3-max-turbo/text-to-video");
});

test("an unlisted FAL_MODEL is refused, never silently replaced", () => {
  assert.throws(
    () => resolveFalConfig({ ...LIVE, FAL_MODEL: "fal-ai/ltx-video" }),
    (error: unknown) => error instanceof FalError && !error.retryable,
  );
});

test("the provider stays off without the live flag or a key", () => {
  assert.equal(resolveFalConfig({ FAL_KEY: "k" }), null);
  assert.equal(resolveFalConfig({ REVERIE_LIVE_ENABLED: "true" }), null);
  assert.equal(resolveFalConfig({ ...LIVE, REVERIE_LIVE_ENABLED: "TRUE" }), null);
});

test("a queued request is addressed by application, not by full slug", () => {
  // minimax/h3-max/text-to-video is polled at minimax/h3-max/requests/<id>.
  for (const spec of FAL_MODEL_SPECS) {
    assert.equal(spec.queueAppId, spec.slug.split("/").slice(0, 2).join("/"));
    assert.ok(spec.slug.startsWith(`${spec.queueAppId}/`));
  }
});

test("every allowlisted model accepts the whole portion band", () => {
  for (const spec of FAL_MODEL_SPECS) {
    assert.ok(spec.minDurationSeconds <= PORTION_ABSOLUTE_MIN_SECONDS);
    assert.ok(spec.maxDurationSeconds >= PORTION_ABSOLUTE_MAX_SECONDS);
  }
});

test("durations are clamped into the model's band and kept whole", () => {
  const spec = findFalModelSpec(DEFAULT_FAL_MODEL_SLUG)!;
  assert.equal(clampDuration(spec, 1), 5);
  assert.equal(clampDuration(spec, 5), 5);
  assert.equal(clampDuration(spec, 9.4), 9);
  assert.equal(clampDuration(spec, 9.6), 10);
  assert.equal(clampDuration(spec, 15), 15);
  assert.equal(clampDuration(spec, 60), 15);
});

test("the request body carries the clamped duration and a pinned framing", () => {
  const spec = findFalModelSpec(DEFAULT_FAL_MODEL_SLUG)!;
  const body = spec.buildInput({ prompt: "A door opens.", durationSeconds: 5 }, 5);
  assert.deepEqual(body, {
    prompt: "A door opens.",
    duration: 5,
    resolution: "768P",
    aspect_ratio: "16:9",
  });
});
