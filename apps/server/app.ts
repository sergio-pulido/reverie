import express, { type Express } from "express";
import health from "../../api/health";
import catalogue from "../../api/catalogue";
import catalogueTitle from "../../api/catalogue-title";
import liveToken from "../../api/live/token";
import { createJamsRouter, InMemoryJamStore, type JamStore } from "./jams";
import { createPlaybackRouter } from "./playback";
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
  app.use(createJamsRouter(store));
  app.use(createSessionsRouter(store));
  app.use(createPlaybackRouter(store));
  app.use("/api", (_request, response) => {
    response.status(404).json({ code: "NOT_FOUND", safeMessage: "API route not found." });
  });

  return app;
}
