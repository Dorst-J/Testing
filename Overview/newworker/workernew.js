function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "https://thedatatab.com",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

async function writeSignInLog(env, { name, email }) {
  if (!env.SIGNIN_LOGS) return;
  const timestamp = Date.now();
  const key = `signin:${timestamp}:${email}`;
  const entry = { name, email, timestamp };
  await env.SIGNIN_LOGS.put(key, JSON.stringify(entry));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method === "GET" && path === "/health") {
      return json({ ok: true, worker: "overview", time: new Date().toISOString() });
    }

    if (request.method === "POST" && path === "/signin") {
      try {
        const body = await request.json();
        const email = (body.email || "").toLowerCase();
        const name = body.name || email;
        if (!email) return json({ success: false, error: "Missing email" }, 400);

        await writeSignInLog(env, { name, email });
        return json({ success: true });
      } catch (e) {
        return json({ success: false, error: String(e) }, 500);
      }
    }

    if (request.method === "GET" && path === "/logs") {
      try {
        if (!env.SIGNIN_LOGS) return json([]);
        const list = await env.SIGNIN_LOGS.list({ limit: 1000 });
        const logs = [];

        for (const k of list.keys) {
          const v = await env.SIGNIN_LOGS.get(k.name, "json");
          if (v) logs.push(v);
        }

        logs.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
        return json(logs);
      } catch {
        return json({ success: false, error: "Failed to load logs" }, 500);
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};
