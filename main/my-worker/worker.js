// worker.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request.headers.get("Origin")) });
    }

    // Common headers
    const headers = {
      "Content-Type": "application/json",
      ...corsHeaders(request.headers.get("Origin")),
    };

    if (request.method === "GET" && url.pathname === "/log") {
      let logs = await env.SIGNINS.get("log", { type: "json" }) || [];
      return new Response(JSON.stringify(logs), { headers });
    }

    if (request.method === "POST" && url.pathname === "/signin") {
      let body;
      try { body = await request.json(); } catch (_) { body = {}; }

      const raw = (body && body.name) ? String(body.name) : "";
      const name = raw.trim() || "Unknown User";

      let logs = await env.SIGNINS.get("log", { type: "json" }) || [];
      logs.unshift({ name, time: new Date().toISOString() }); // store ISO (UTC)
      if (logs.length > 500) logs = logs.slice(0, 500);       // safety cap

      await env.SIGNINS.put("log", JSON.stringify(logs));

      return new Response(JSON.stringify({ success: true }), { headers });
    }

    return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers });
  }
};

function corsHeaders(origin) {
  // To restrict, list allowed origins and echo back when matched.
  // const allowed = ["https://your-site.com", "http://localhost:5500"];
  // if (allowed.includes(origin)) {
  //   return { "Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
  // }
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}


