const GROQ_API_URL =
  "https://api.groq.com/openai/v1/chat/completions";

const DEFAULT_MODEL = "openai/gpt-oss-20b";

const ALLOWED_ORIGINS = new Set([
  "https://yveslacroix83400.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000"
]);

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    const corsHeaders = getCorsHeaders(origin);

    /*
     * Handle browser CORS preflight.
     */
    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(origin)) {
        return jsonResponse(
          {
            error: {
              message: "Origin not allowed."
            }
          },
          403,
          corsHeaders
        );
      }

      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    /*
     * Health-check endpoint.
     */
    if (request.method === "GET") {
      return jsonResponse(
        {
          status: "Groq proxy is live and ready!",
          provider: "Groq",
          model: DEFAULT_MODEL
        },
        200,
        corsHeaders
      );
    }

    /*
     * Only POST is accepted for chat requests.
     */
    if (request.method !== "POST") {
      return jsonResponse(
        {
          error: {
            message: "Method not allowed. Use POST."
          }
        },
        405,
        corsHeaders
      );
    }

    /*
     * Reject unknown websites.
     *
     * Requests without an Origin header remain possible for terminal
     * diagnostics with curl.
     */
    if (!isAllowedOrigin(origin)) {
      return jsonResponse(
        {
          error: {
            message: "Origin not allowed."
          }
        },
        403,
        corsHeaders
      );
    }

    try {
      const apiKey = env.GROQ_API_KEY;

      if (!apiKey || !apiKey.trim()) {
        return jsonResponse(
          {
            error: {
              message:
                "GROQ_API_KEY is missing from the Cloudflare Worker settings."
            }
          },
          500,
          corsHeaders
        );
      }

      let body;

      try {
        body = await request.json();
      } catch {
        return jsonResponse(
          {
            error: {
              message: "The request body must contain valid JSON."
            }
          },
          400,
          corsHeaders
        );
      }

      /*
       * Accept both request formats:
       *
       * 1. Wrapped format:
       *    { type: "chat", payload: { model, messages, ... } }
       *
       * 2. Direct OpenAI-compatible format:
       *    { model, messages, ... }
       */
      const payload =
        body &&
        body.type === "chat" &&
        body.payload &&
        typeof body.payload === "object"
          ? body.payload
          : body;

      if (!Array.isArray(payload?.messages)) {
        return jsonResponse(
          {
            error: {
              message:
                "Invalid request: a messages array is required."
            }
          },
          400,
          corsHeaders
        );
      }

      if (payload.messages.length === 0) {
        return jsonResponse(
          {
            error: {
              message:
                "Invalid request: the messages array cannot be empty."
            }
          },
          400,
          corsHeaders
        );
      }

      /*
       * Allow only models deliberately approved by this proxy.
       * This avoids arbitrary model selection from the public frontend.
       */
      const allowedModels = new Set([
        "openai/gpt-oss-20b",
        "openai/gpt-oss-120b"
      ]);

      const requestedModel =
        typeof payload.model === "string"
          ? payload.model.trim()
          : "";

      const selectedModel = allowedModels.has(requestedModel)
        ? requestedModel
        : DEFAULT_MODEL;

      const groqPayload = {
        model: selectedModel,
        messages: payload.messages,
        temperature:
          typeof payload.temperature === "number"
            ? Math.min(Math.max(payload.temperature, 0), 2)
            : 0.2
      };

      /*
       * Forward optional OpenAI-compatible parameters when present.
       */
      if (Number.isInteger(payload.max_completion_tokens)) {
        groqPayload.max_completion_tokens = Math.min(
          Math.max(payload.max_completion_tokens, 1),
          4096
        );
      }

      if (typeof payload.top_p === "number") {
        groqPayload.top_p = Math.min(
          Math.max(payload.top_p, 0),
          1
        );
      }

      const groqResponse = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey.trim()}`,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(groqPayload)
      });

      const responseText = await groqResponse.text();

      /*
       * Preserve Groq's actual HTTP status.
       * The frontend can then distinguish 400, 401, 404, 429, etc.
       */
      return new Response(responseText, {
        status: groqResponse.status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        }
      });
    } catch (error) {
      console.error("Worker error:", error);

      return jsonResponse(
        {
          error: {
            message:
              error instanceof Error
                ? error.message
                : "Unexpected Worker error."
          }
        },
        500,
        corsHeaders
      );
    }
  }
};

function isAllowedOrigin(origin) {
  /*
   * No Origin header generally means a terminal or server-side request.
   * Permit it so the Worker can be tested with curl.
   */
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function getCorsHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.has(origin)
    ? origin
    : "https://yveslacroix83400.github.io";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
