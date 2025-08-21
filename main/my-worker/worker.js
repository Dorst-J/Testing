export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- POST /signin ---
    if (request.method === "POST" && url.pathname === "/signin") {
      try {
        const { name } = await request.json();
        if (!name) {
          return new Response(
            JSON.stringify({ success: false, error: "Missing name" }),
            { headers: { "Content-Type": "application/json" }, status: 400 }
          );
        }

        const timestamp = Date.now();
        const logEntry = { name, timestamp };

        // Store in KV with a unique key
        await env.SIGNIN_LOGS.put(`log-${timestamp}`, JSON.stringify(logEntry));

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ success: false, error: err.message }),
          { headers: { "Content-Type": "application/json" }, status: 500 }
        );
      }
    }

    // --- GET /logs ---
    if (request.method === "GET" && url.pathname === "/logs") {
      try {
        const list = await env.SIGNIN_LOGS.list();
        const logs = [];

        for (const key of list.keys) {
          const entry = await env.SIGNIN_LOGS.get(key.name);
          if (entry) logs.push(JSON.parse(entry));
        }

        // Sort newest first
        logs.sort((a, b) => b.timestamp - a.timestamp);

        return new Response(JSON.stringify(logs), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ success: false, error: err.message }),
          { headers: { "Content-Type": "application/json" }, status: 500 }
        );
      }
    }

    // Default route
    return new Response("Not found", { status: 404 });
  },
};
