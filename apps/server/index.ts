import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { createApiApp } from "./app";
import { attachVoiceStream } from "./voiceStream";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(currentDirectory, "../..");

try {
  process.loadEnvFile(path.join(rootDirectory, ".env.local"));
} catch {
  // No .env.local: live providers stay disabled.
}

const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 4317);
const host = process.env.HOST ?? "127.0.0.1";
const app = createApiApp();

async function start() {
  if (!isProduction) {
    const vite = await createViteServer({
      root: rootDirectory,
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // `/` is the static landing (dist/index.html); every other path is the app's shell.
    app.use(express.static(path.join(rootDirectory, "dist")));
    app.get("*", (_request, response) => {
      response.sendFile(path.join(rootDirectory, "dist", "app.html"));
    });
  }

  const server = app.listen(port, host, () => {
    console.log(`Reverie is ready at http://${host}:${port}`);
  });
  attachVoiceStream(server);
}

void start();
