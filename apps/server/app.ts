import express, { type Express } from "express";
import health from "../../api/health";
import catalogue from "../../api/catalogue";
import catalogueTitle from "../../api/catalogue-title";
import liveToken from "../../api/live/token";
import discoverTurn from "../../api/discover/turn";
import discoverRank from "../../api/discover/rank";
import voiceTranscribe from "../../api/voice/transcribe";
import { createJamsRouter, InMemoryJamStore, type JamStore, type PlaybackGuard } from "./jams";
import { createDirectorRouter, DirectorStreamRegistry } from "./director";
import { createOutlineRouter } from "./outline";
import { createSessionsRouter } from "./sessions";

/**
 * API wiring shared by the real server and tests. Order matters: the JSON
 * 404 catch-all must come AFTER the routers, or it shadows every API route.
 */
export function createApiApp(store: JamStore = new InMemoryJamStore()): Express {
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
  app.all("/api/voice/transcribe", (request, response) => {
    void voiceTranscribe(request, response);
  });
  // One registry, read by both: the director refuses direction on a closed
  // beat, and the script routes refuse an edit to the same portion. Two
  // answers to one question would be worse than either alone.
  const streams = new DirectorStreamRegistry();
  const guard: PlaybackGuard = (jamId) => ({
    minEditablePortionIndex: streams.minEditablePortionIndex(jamId),
    stateVersion: 0,
  });
  app.use(createJamsRouter(store, guard));
  // The outline queue reads the same guard inside the same critical section,
  // and sends a landed beat to the same streams the director holds.
  app.use(
    createOutlineRouter(store, guard, {
      window: (jamId) => streams.beatWindow(jamId),
      streamsFor: (jamId) => streams.streamsFor(jamId),
    }),
  );
  app.use(createSessionsRouter(store));
  app.use(createDirectorRouter(store, { registry: streams }));
  app.use("/api", (_request, response) => {
    response.status(404).json({ code: "NOT_FOUND", safeMessage: "API route not found." });
  });

  return app;
}
