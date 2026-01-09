function corsHeaders(origin) {
  // Lock to your site in production:
  const allowed = "https://thedatatab.com";
  const o = origin || allowed;

  return {
    "Access-Control-Allow-Origin": allowed, // keep strict
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

async function writeSignInLog(env, { name, email }) {
  if (!env.SIGNIN_LOGS) return; // KV not configured? just skip.
  const timestamp = Date.now();
  const key = `signin:${timestamp}:${email}`;
  const entry = { name, email, timestamp };
  await env.SIGNIN_LOGS.put(key, JSON.stringify(entry));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get("Origin") || "";

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Health check
    if (request.method === "GET" && path === "/health") {
      return json({ ok: true, worker: "thedatatab-api", time: new Date().toISOString() }, 200, origin);
    }

    // Sign-in logging endpoint
    if (request.method === "POST" && path === "/signin") {
      try {
        const body = await request.json();
        const email = (body.email || "").toLowerCase();
        const name = body.name || email;

        if (!email) return json({ success: false, error: "Missing email" }, 400, origin);

        await writeSignInLog(env, { name, email });
        return json({ success: true }, 200, origin);
      } catch (e) {
        return json({ success: false, error: String(e) }, 500, origin);
      }
    }

    // Read logs
    if (request.method === "GET" && path === "/logs") {
      try {
        if (!env.SIGNIN_LOGS) return json([], 200, origin);

        const list = await env.SIGNIN_LOGS.list({ limit: 1000 });
        const logs = [];

        for (const k of list.keys) {
          const v = await env.SIGNIN_LOGS.get(k.name, "json");
          if (v) logs.push(v);
        }

        logs.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
        return json(logs, 200, origin);
      } catch (e) {
        return json({ success: false, error: "Failed to load logs" }, 500, origin);
      }
    }

    // Room for your existing stuff later:
    // if (path.startsWith("/api/")) { ... }

    return new Response("Not found", { status: 404, headers: corsHeaders(origin) });
  },
};
