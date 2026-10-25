export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === "GET") {
      return new Response(JSON.stringify({ status: "Groq proxy is live and ready!" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    try {
      const apiKey = env.GROQ_API_KEY;
      if (!apiKey) {
        throw new Error("Missing GROQ_API_KEY in Cloudflare settings.");
      }

      const body = await request.json();

      // Forward to Groq's ultra-fast Llama-3.1 endpoint
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey.trim()}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: body.payload.messages,
          temperature: 0.2
        })
      });

      const responseData = await response.text();
      return new Response(responseData, {
        status: response.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
