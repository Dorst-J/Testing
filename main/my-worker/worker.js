function handleOptions(request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- Handle preflight ---
    if (request.method === "OPTIONS") {
      return handleOptions(request);
    }

    // --- POST /signin ---
    if (request.method === "POST" && path === "/signin") {
      try {
        const { name, email } = await request.json();

        if (!name || !email) {
          return new Response(
            JSON.stringify({ success: false, error: "Missing name or email" }),
            { headers: corsHeaders(), status: 400 }
          );
        }

        const timestamp = Date.now();
        const logEntry = { name, email, timestamp };

        await env.SIGNIN_LOGS.put(`log-${timestamp}`, JSON.stringify(logEntry));

        // store session info in SESSION_STATE
        const sessionId = crypto.randomUUID();
        await env.SESSION_STATE.put(`session:${sessionId}`, Date.now().toString());

        return new Response(
          JSON.stringify({ success: true, sessionId }),
          { headers: { ...corsHeaders(), "Content-Type": "application/json" } }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ success: false, error: err.message }),
          { headers: corsHeaders(), status: 500 }
        );
      }
    }

    // --- GET /logs ---
    if (request.method === "GET" && path === "/logs") {
      try {
        const list = await env.SIGNIN_LOGS.list();
        const logs = [];

        for (const key of list.keys) {
          const entry = await env.SIGNIN_LOGS.get(key.name);
          if (entry) logs.push(JSON.parse(entry));
        }

        logs.sort((a, b) => b.timestamp - a.timestamp);

        return new Response(JSON.stringify(logs), {
          headers: corsHeaders(),
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ success: false, error: err.message }),
          { headers: corsHeaders(), status: 500 }
        );
      }
    }

    // --- POST /api/heartbeat ---
    if (request.method === "POST" && path === "/api/heartbeat") {
      try {
        const { sessionId } = await request.json();
        if (!sessionId) {
          return new Response("Missing sessionId", { status: 400, headers: corsHeaders() });
        }
        await env.SESSION_STATE.put(`session:${sessionId}`, Date.now().toString());
        return new Response("OK", { headers: corsHeaders() });
      } catch (err) {
        return new Response("Invalid heartbeat", { status: 400, headers: corsHeaders() });
      }
    }

    // --- POST /auth/logout ---
    if (request.method === "POST" && path === "/auth/logout") {
      try {
        const { sessionId } = await request.json();
        if (sessionId) await env.SESSION_STATE.delete(`session:${sessionId}`);
        return new Response("Logged out", { headers: corsHeaders() });
      } catch {
        return new Response("Invalid logout", { status: 400, headers: corsHeaders() });
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};

// --- Helpers ---
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "https://thedatatab.com",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
