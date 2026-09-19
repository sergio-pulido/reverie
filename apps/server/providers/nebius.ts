import { z } from "zod";

// Server-owned allowlist. NEBIUS_MODEL may pick one of these; nothing else.
// Default verified by the dated probe recorded in docs/PROJECT_STATE.md.
export const NEBIUS_MODEL_ALLOWLIST = [
  "Qwen/Qwen3-235B-A22B-Instruct-2507",
  "Qwen/Qwen3-30B-A3B-Instruct-2507",
  "deepseek-ai/DeepSeek-V4.1-Flash",
] as const;

const NEBIUS_BASE_URL = "https://api.studio.nebius.com/v1";
const REQUEST_TIMEOUT_MS = 90_000;

export class NebiusError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "NebiusError";
  }
}

const completionResponseSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1),
});

export interface NebiusConfig {
  apiKey: string;
  model: string;
}

export function resolveNebiusConfig(env: NodeJS.ProcessEnv): NebiusConfig | null {
  if (env.REVERIE_LIVE_ENABLED !== "true") return null;
  const apiKey = env.NEBIUS_API_KEY?.trim();
  if (!apiKey) return null;
  const requested = env.NEBIUS_MODEL?.trim();
  if (requested && !NEBIUS_MODEL_ALLOWLIST.includes(requested as never)) {
    throw new NebiusError(`NEBIUS_MODEL is not on the server allowlist.`, false);
  }
  return { apiKey, model: requested || NEBIUS_MODEL_ALLOWLIST[0] };
}

/** One JSON-mode chat completion. Returns the raw JSON text of the reply. */
export async function completeJson(
  config: NebiusConfig,
  options: { system: string; user: string; maxTokens: number },
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${NEBIUS_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: options.maxTokens,
        temperature: 0.8,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: options.system },
          { role: "user", content: options.user },
        ],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Network/timeout details stay out of logs; no payloads are recorded.
    throw new NebiusError("The creative provider did not respond.", true);
  }

  if (!response.ok) {
    throw new NebiusError(
      `The creative provider rejected the request (status ${response.status}).`,
      response.status === 429 || response.status >= 500,
    );
  }

  const parsed = completionResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new NebiusError("The creative provider returned an unexpected shape.", true);
  }
  return parsed.data.choices[0].message.content;
}
