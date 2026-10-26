const GROQ_API_URL =
  "https://api.groq.com/openai/v1/chat/completions";

const TAVILY_API_URL =
  "https://api.tavily.com/search";

const DEFAULT_MODEL =
  "openai/gpt-oss-120b";

const ALLOWED_MODELS = new Set([
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b"
]);

const ALLOWED_ORIGINS = new Set([
  "https://yveslacroix83400.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000"
]);

const MAX_QUESTION_LENGTH = 2000;
const MAX_WEB_CONTEXT_CHARACTERS = 6000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const corsHeaders = getCorsHeaders(origin);

    /*
     * CORS preflight.
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
     * Health check.
     */
    if (request.method === "GET") {
      return jsonResponse(
        {
          status: "GCP CDA Groq and Tavily proxy is ready.",
          provider: "Groq",
          model: DEFAULT_MODEL,
          web_search_provider: "Tavily",
          web_search_configured: Boolean(env.TAVILY_API_KEY)
        },
        200,
        corsHeaders
      );
    }

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

    if (!env.GROQ_API_KEY || !env.GROQ_API_KEY.trim()) {
      return jsonResponse(
        {
          error: {
            message:
              "GROQ_API_KEY is missing from the Worker settings."
          }
        },
        500,
        corsHeaders
      );
    }

    try {
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
       * Accept your existing wrapped request format:
       *
       * {
       *   type: "chat",
       *   payload: {
       *     model,
       *     messages,
       *     temperature
       *   },
       *   webSearch: {
       *     enabled,
       *     query
       *   }
       * }
       */
      const payload =
        body?.type === "chat" &&
        body?.payload &&
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

      const requestedModel =
        typeof payload.model === "string"
          ? payload.model.trim()
          : "";

      const selectedModel =
        ALLOWED_MODELS.has(requestedModel)
          ? requestedModel
          : DEFAULT_MODEL;

      /*
       * Create a clean copy of the messages.
       */
      const messages = payload.messages.map((message) => ({
        role: message.role,
        content: String(message.content || "")
      }));

      /*
       * Obtain the student's question.
       */
      const lastUserMessage = [...messages]
        .reverse()
        .find((message) => message.role === "user");

      const fallbackQuery =
        lastUserMessage?.content || "";

      const requestedSearchQuery =
        typeof body?.webSearch?.query === "string"
          ? body.webSearch.query.trim()
          : "";

      const searchQuery =
        requestedSearchQuery || fallbackQuery;

      const webSearchEnabled =
        body?.webSearch?.enabled === true;

      let webResults = [];
      let webSearchWarning = null;

      /*
       * Call Tavily only when explicitly requested.
       */
      if (webSearchEnabled) {
        if (!env.TAVILY_API_KEY ||
            !env.TAVILY_API_KEY.trim()) {
          webSearchWarning =
            "Web search was requested, but TAVILY_API_KEY is not configured.";
        } else if (!searchQuery) {
          webSearchWarning =
            "Web search was requested without a query.";
        } else if (
          searchQuery.length > MAX_QUESTION_LENGTH
        ) {
          webSearchWarning =
            `The web search query exceeds ` +
            `${MAX_QUESTION_LENGTH} characters.`;
        } else {
          try {
            webResults = await searchTavily(
              searchQuery,
              env.TAVILY_API_KEY
            );
          } catch (error) {
            console.error("Tavily error:", error);

            /*
             * Continue with the course context even if Tavily fails.
             */
            webSearchWarning =
              error instanceof Error
                ? error.message
                : "Web search failed.";
          }
        }
      }

      /*
       * Inject compact web results into the last user message.
       */
      if (webResults.length > 0) {
        let webContext = webResults
          .map((result, index) => {
            return [
              `[Web source ${index + 1}]`,
              `Title: ${result.title}`,
              `URL: ${result.url}`,
              `Excerpt: ${result.content}`
            ].join("\n");
          })
          .join("\n\n---\n\n");

        webContext = webContext.slice(
          0,
          MAX_WEB_CONTEXT_CHARACTERS
        );

        const lastUserIndex = messages
          .map((message) => message.role)
          .lastIndexOf("user");

        if (lastUserIndex >= 0) {
          messages[lastUserIndex] = {
            ...messages[lastUserIndex],
            content: [
              messages[lastUserIndex].content,
              "",
              "Current web search results:",
              webContext,
              "",
              "Instructions for web information:",
              "- Use web information only when relevant.",
              "- Distinguish course information from current web information.",
              "- Cite web sources using their exact titles and URLs.",
              "- Do not invent sources or claims.",
              "- Prefer the provided course context for course-specific questions."
            ].join("\n")
          };
        }
      }

      const temperature =
        typeof payload.temperature === "number"
          ? Math.min(
              Math.max(payload.temperature, 0),
              2
            )
          : 0.2;

      const groqPayload = {
        model: selectedModel,
        messages,
        temperature,
        max_completion_tokens: 1200
      };

      const groqResponse = await fetch(
        GROQ_API_URL,
        {
          method: "POST",
          headers: {
            "Authorization":
              `Bearer ${env.GROQ_API_KEY.trim()}`,
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body: JSON.stringify(groqPayload)
        }
      );

      const groqText =
        await groqResponse.text();

      let groqData;

      try {
        groqData =
          groqText ? JSON.parse(groqText) : {};
      } catch {
        return jsonResponse(
          {
            error: {
              message:
                "Groq returned a non-JSON response.",
              detail: groqText.slice(0, 800)
            }
          },
          groqResponse.status || 502,
          corsHeaders
        );
      }

      if (!groqResponse.ok) {
        return jsonResponse(
          groqData,
          groqResponse.status,
          corsHeaders
        );
      }

      /*
       * Add web metadata without altering the normal
       * OpenAI-compatible choices response.
       */
      return jsonResponse(
        {
          ...groqData,

          model_used: selectedModel,

          web_search: {
            requested: webSearchEnabled,
            successful: webResults.length > 0,
            warning: webSearchWarning
          },

          web_sources: webResults.map((result) => ({
            title: result.title,
            url: result.url,
            content: result.content
          }))
        },
        200,
        corsHeaders
      );
    } catch (error) {
      console.error("Unexpected Worker error:", error);

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

async function searchTavily(query, apiKey) {
  const response = await fetch(
    TAVILY_API_URL,
    {
      method: "POST",
      headers: {
        "Authorization":
          `Bearer ${apiKey.trim()}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        topic: "general",
        max_results: 4,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_published_date: true,
        safe_search: true
      })
    }
  );

  const responseText =
    await response.text();

  let data;

  try {
    data =
      responseText
        ? JSON.parse(responseText)
        : {};
  } catch {
    throw new Error(
      `Tavily returned a non-JSON response ` +
      `(HTTP ${response.status}): ` +
      responseText.slice(0, 500)
    );
  }

  if (!response.ok) {
    const detail =
      data?.detail ||
      data?.message ||
      data?.error ||
      responseText;

    throw new Error(
      `Tavily HTTP ${response.status}: ${
        typeof detail === "string"
          ? detail
          : JSON.stringify(detail)
      }`
    );
  }

  if (!Array.isArray(data.results)) {
    return [];
  }

  /*
   * Keep the Tavily response compact before sending
   * it to Groq and to the browser.
   */
  return data.results
    .slice(0, 4)
    .map((result) => ({
      title:
        String(result.title || "Web source")
          .slice(0, 300),

      url:
        String(result.url || "")
          .slice(0, 2000),

      content:
        String(result.content || "")
          .slice(0, 1500),

      published_date:
        result.published_date || null
    }))
    .filter((result) => result.url);
}

function isAllowedOrigin(origin) {
  /*
   * Requests without an Origin header are allowed
   * for curl and server-side tests.
   */
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function getCorsHeaders(origin) {
  const allowedOrigin =
    ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://yveslacroix83400.github.io";

  return {
    "Access-Control-Allow-Origin":
      allowedOrigin,

    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type, Authorization",

    "Access-Control-Max-Age":
      "86400",

    "Vary":
      "Origin"
  };
}

function jsonResponse(
  data,
  status,
  corsHeaders
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}
