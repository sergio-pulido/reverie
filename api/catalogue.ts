import type { IncomingMessage, ServerResponse } from "node:http";
import { catalogueQuerySchema } from "../src/catalogue/contract";
import { fetchCatalogue, type CatalogueAdapterOptions } from "./_lib/supabase-catalogue";
import { readBearerToken } from "./_lib/supabase-rest";
import { clientKey, createRateLimiter, isSameOrigin, requestUrl, sendJson } from "./_lib/http";

const RATE_LIMIT_REQUESTS = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

const allowRequest = createRateLimiter(RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS);

export default async function catalogue(
  request: IncomingMessage,
  response: ServerResponse,
  options: CatalogueAdapterOptions = {},
) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendJson(response, 405, {
      status: "error",
      code: "METHOD_NOT_ALLOWED",
      safeMessage: "Only GET is supported.",
      retryable: false,
    });
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
    sendJson(response, 429, {
      status: "error",
      code: "RATE_LIMITED",
      safeMessage: "Too many catalogue requests. Try again shortly.",
      retryable: true,
    });
    return;
  }

  const url = requestUrl(request);
  const parsedQuery = catalogueQuerySchema.safeParse({
    query: url.searchParams.get("query") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });

  if (!parsedQuery.success) {
    sendJson(response, 400, {
      status: "error",
      code: "INVALID_QUERY",
      safeMessage: "The catalogue query was outside the accepted limits.",
      retryable: false,
    });
    return;
  }

  const result = await fetchCatalogue(parsedQuery.data, readBearerToken(request.headers.authorization), options);
  sendJson(response, statusFor(result), result);
}

function statusFor(result: Awaited<ReturnType<typeof fetchCatalogue>>) {
  if (result.status !== "error") return 200;
  if (result.code === "CATALOGUE_UNAUTHENTICATED") return 401;
  if (result.code === "CATALOGUE_FORBIDDEN") return 403;
  return result.retryable ? 502 : 400;
}
