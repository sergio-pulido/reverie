import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(currentDirectory, "../..");
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 4317);
const app = express();

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok", service: "reverie-movie-jam" });
});

async function start() {
  if (!isProduction) {
    const vite = await createViteServer({
      root: rootDirectory,
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(rootDirectory, "dist")));
    app.get("/{*splat}", (_request, response) => {
      response.sendFile(path.join(rootDirectory, "dist", "index.html"));
    });
  }

  app.listen(port, "127.0.0.1", () => {
    console.log(`Reverie is ready at http://127.0.0.1:${port}`);
  });
}

void start();
