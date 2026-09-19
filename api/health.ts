import type { IncomingMessage, ServerResponse } from "node:http";

export default function health(_request: IncomingMessage, response: ServerResponse) {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.statusCode = 200;
  response.end(JSON.stringify({ status: "ok", service: "reverie-movie-jam" }));
}
