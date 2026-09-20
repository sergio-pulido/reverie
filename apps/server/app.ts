import express, { type Express } from "express";
import health from "../../api/health";
import catalogue from "../../api/catalogue";
import catalogueTitle from "../../api/catalogue-title";
import liveToken from "../../api/live/token";
import discoverTurn from "../../api/discover/turn";
import discoverCritique from "../../api/discover/critique";
import discoverRank from "../../api/discover/rank";
import voiceTranscribe from "../../api/voice/transcribe";
import evaluate from "../../api/evaluate";
import {
  createJamsRouter,
  InMemoryJamStore,
  type JamStore,
  type PlaybackGuard,
} from "./jams";
import { createOutlineRouter } from "./outline";
import {
  createDirectorRouter,
  DirectorStreamRegistry,
  type DirectorRouterOptions,
} from "./director";
import { createDirectorArchiveRouter } from "./directorArchiveRoutes";
import {
  resolveDirectorRecordingStore,
  type DirectorRecordingStore,
} from "./directorRecordings";
import {
  resolveDirectorIndexStore,
  type DirectorIndexStore,
} from "./directorIndex";
import { createEscapeRouter } from "./escape";
import { createSessionsRouter } from "./sessions";
import { resolveSpendAccount } from "./spendLedger";
import { FalBudget } from "./falBudget";
import { createLikenessRouter } from "./likeness";
import { resolveDirectorLimits, DirectorSessionLedger } from "./directorSessions";

/**
 * API wiring shared by the real server and tests. Order matters: the JSON
 * 404 catch-all must come AFTER the routers, or it shadows every API route.
 */
export interface ApiAppOptions {
  /** Shared by the live writer and archive reader, including in-memory mode. */
  directorIndex?: DirectorIndexStore;
  directorRecordings?: DirectorRecordingStore;
  /** Test/provider seams; shared stores and the registry are owned by this app. */
  director?: Omit<DirectorRouterOptions, "index" | "recordings" | "registry">;
}

export function createApiApp(
  store: JamStore = new InMemoryJamStore(),
  options: ApiAppOptions = {},
): Express {
  const app = express();

  app.get("/api/health", health);
  app.get("/api/catalogue", (request, response) => {
    void catalogue(request, response);
  });
  app.get("/api/catalogue-title", (request, response) => {
    void catalogueTitle(request, response);
  });
  // Registered for every method so the local host answers 405 exactly as the Vercel
  // function does, instead of letting the catch-all turn a wrong method into a 404.
  app.all("/api/live/token", (request, response) => {
    void liveToken(request, response);
  });
  app.all("/api/discover/turn", (request, response) => {
    void discoverTurn(request, response);
  });
  app.all("/api/discover/rank", (request, response) => {
    void discoverRank(request, response);
  });
  app.all("/api/discover/critique", (request, response) => {
    void discoverCritique(request, response);
  });
  app.all("/api/evaluate", (request, response) => {
    void evaluate(request, response);
  });
  app.all("/api/voice/transcribe", (request, response) => {
    void voiceTranscribe(request, response);
  });
  // One registry, read by both: the director refuses direction on a closed
  // beat, and the script routes refuse an edit to the same portion. Two
  // answers to one question would be worse than either alone.
  const streams = new DirectorStreamRegistry();
  // Resolve each fallback once. When Supabase is absent these are in-memory
  // stores, so separate instances would let the live router write an archive
  // that the read router could never see.
  const directorIndex = options.directorIndex ?? resolveDirectorIndexStore();
  const directorRecordings =
    options.directorRecordings ?? resolveDirectorRecordingStore();
  // FAL_ASSET_BUDGET_USD is a ceiling on this process, so the director, the
  // escape room and beat generation all debit one account. The budget is a
  // second face on that same account, not a second pot.
  const account = resolveSpendAccount();
  const budget = new FalBudget(account.budgetUsd, account);
  // One boundary, read by the script routes and by the outline queue, inside
  // the same per-jam critical section as the mutation it protects.
  const guard: PlaybackGuard = (jamId) => ({
    minEditablePortionIndex: streams.minEditablePortionIndex(jamId),
    stateVersion: 0,
  });
  app.use(createJamsRouter(store, guard));
  // The outline queue sends a landed beat to the same streams the director
  // holds, so one edited phrase drives the script and the stream alike.
  app.use(
    createOutlineRouter(store, guard, {
      window: (jamId) => streams.beatWindow(jamId),
      streamsFor: (jamId) => streams.streamsFor(jamId),
    }),
  );
  app.use(createSessionsRouter(store));
  app.use(createDirectorRouter(store, {
    ...options.director,
    registry: streams,
    index: directorIndex,
    recordings: directorRecordings,
    budget,
  }));
  app.use(createDirectorArchiveRouter(store, {
    index: directorIndex,
    recordings: directorRecordings,
  }));
  app.use(createEscapeRouter({ account }));
  app.use(createLikenessRouter(store, { budget }));
  app.use("/api", (_request, response) => {
    response.status(404).json({ code: "NOT_FOUND", safeMessage: "API route not found." });
  });

  return app;
}
