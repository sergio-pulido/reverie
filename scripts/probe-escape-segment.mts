// Bounded live probe of one escape-room segment through the fal queue.
//
//   REVERIE_LIVE_ENABLED=true FAL_KEY=... \
//     node --import tsx scripts/probe-escape-segment.mts [seconds]
//
// It submits ONE generation with a real loop shot from a shipped scenario,
// polls it to completion, downloads the clip and measures what actually came
// back: the file's own duration, its size and the wall-clock time from submit
// to a playable file. Those three numbers are what the escape room's timing is
// built on, and documentation is not a substitute for them.
//
// This costs money. Run it deliberately, not in a loop. It prints no key, no
// prompt of anyone else's and no provider body.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMp4DurationSeconds } from "../src/core/mediaDuration.ts";
import { SCENARIOS } from "../src/core/escape/scenarios/index.ts";
import {
  downloadSegment,
  getSegmentStatus,
  getSegmentUrl,
  resolveFalSegmentConfig,
  submitSegment,
} from "../apps/server/providers/falSegments.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(root, ".env.local"));
} catch {
  // Environment variables may be supplied directly.
}

const requested = Number(process.argv[2] ?? 15);
const seconds = Number.isFinite(requested) ? Math.round(requested) : 15;

let config;
try {
  config = resolveFalSegmentConfig(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : "The model could not be resolved.");
  process.exit(1);
}
if (!config) {
  console.error(
    "Segment generation is not configured: REVERIE_LIVE_ENABLED must be \"true\" and FAL_KEY must be set. Nothing was called.",
  );
  process.exit(1);
}

const scenario = SCENARIOS[0];
const location = scenario.locations[0];
const prompt = `${scenario.look} ${location.loopShot}`;

console.log(`model: ${config.model.slug}`);
console.log(`asked for: ${seconds}s, ${prompt.length} characters of prompt`);

const submittedAt = Date.now();
const requestId = await submitSegment(config, { prompt, durationSeconds: seconds });
console.log(`request accepted in ${Date.now() - submittedAt}ms`);

let status = await getSegmentStatus(config, requestId);
let polls = 0;
while (status !== "completed") {
  if (Date.now() - submittedAt > 10 * 60_000) {
    console.error(`still ${status} after ten minutes; giving up on this probe.`);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  status = await getSegmentStatus(config, requestId);
  polls += 1;
}
const completedAt = Date.now();
console.log(`completed after ${((completedAt - submittedAt) / 1000).toFixed(1)}s (${polls} polls)`);

const url = await getSegmentUrl(config, requestId);
console.log(`result host: ${new URL(url).host}`);
const { bytes, contentType } = await downloadSegment(url);
const readyAt = Date.now();
const measured = readMp4DurationSeconds(bytes);

console.log(`downloaded ${bytes.byteLength} bytes as ${contentType}`);
console.log(`measured duration: ${measured === null ? "unreadable" : `${measured.toFixed(3)}s`}`);
console.log(`submit to playable file: ${((readyAt - submittedAt) / 1000).toFixed(1)}s`);
