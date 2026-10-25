export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === "GET") {
      return new Response(JSON.stringify({ status: "Proxy is live and ready!" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    try {
      const apiKey = env.ALBERT_API_KEY;
      if (!apiKey) {
        throw new Error("Missing ALBERT_API_KEY in Cloudflare settings.");
      }

      const body = await request.json();

      const response = await fetch("https://albert.api.etalab.gouv.fr/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey.trim()}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body.payload)
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
