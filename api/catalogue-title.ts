import type { IncomingMessage, ServerResponse } from "node:http";
import { catalogueProviderIdSchema } from "../src/catalogue/contract";
import type { CatalogueAdapterOptions } from "./_lib/supabase-catalogue";
import { fetchCatalogueTitle } from "./_lib/supabase-catalogue-title";
import { readBearerToken } from "./_lib/supabase-rest";
import { clientKey, createRateLimiter, isSameOrigin, requestUrl, sendJson } from "./_lib/http";

const RATE_LIMIT_REQUESTS = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

const allowRequest = createRateLimiter(RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS);

/** One film's full record: `GET /api/catalogue-title?id=<provider id>`. */
export default async function catalogueTitle(
  request: IncomingMessage,
  response: ServerResponse,
  options: CatalogueAdapterOptions = {},
) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendJson(response, 405, { status: "error", code: "METHOD_NOT_ALLOWED", safeMessage: "Only GET is supported.", retryable: false });
    return;
  }

  if (!isSameOrigin(request)) {
    sendJson(response, 403, {
      status: "error",
      code: "CROSS_ORIGIN_BLOCKED",
      safeMessage: "This endpoint only answers same-origin requests.",
      retryable: false,
    });
    return;
  }

  if (!allowRequest(clientKey(request))) {
    response.setHeader("Retry-After", String(RATE_LIMIT_WINDOW_MS / 1_000));
    sendJson(response, 429, { status: "error", code: "RATE_LIMITED", safeMessage: "Too many requests. Try again shortly.", retryable: true });
    return;
  }

  const id = catalogueProviderIdSchema.safeParse(requestUrl(request).searchParams.get("id") ?? "");
  if (!id.success) {
    sendJson(response, 400, { status: "error", code: "INVALID_TITLE_ID", safeMessage: "That is not a film id.", retryable: false });
    return;
  }

  const result = await fetchCatalogueTitle(id.data, readBearerToken(request.headers.authorization), options);
  sendJson(response, statusFor(result), result);
}

function statusFor(result: Awaited<ReturnType<typeof fetchCatalogueTitle>>) {
  if (result.status === "not_found") return 404;
  if (result.status !== "error") return 200;
  if (result.code === "CATALOGUE_UNAUTHENTICATED") return 401;
  if (result.code === "CATALOGUE_FORBIDDEN") return 403;
  return result.retryable ? 502 : 400;
}
