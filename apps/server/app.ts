import express, { type Express } from "express";
import health from "../../api/health";
import catalogue from "../../api/catalogue";
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
  app.use(createJamsRouter(store));
  app.use(createSessionsRouter(store));
  app.use(createPlaybackRouter(store));
  app.use("/api", (_request, response) => {
    response.status(404).json({ code: "NOT_FOUND", safeMessage: "API route not found." });
  });

  return app;
}
