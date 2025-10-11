function handleOptions(request) {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",  // or your site: "https://thedatatab.com"
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle preflight CORS
    if (request.method === "OPTIONS") {
      return handleOptions(request);
    }

    // --- POST /signin ---
    if (request.method === "POST" && url.pathname === "/signin") {
  try {
    const { name, email } = await request.json(); // <-- Added email here

    if (!name || !email) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing name or email" }),
        { headers: corsHeaders(), status: 400 }
      );
    }

    const timestamp = Date.now();
    const logEntry = { name, email, timestamp }; // <-- Include email in log

    await env.SIGNIN_LOGS.put(`log-${timestamp}`, JSON.stringify(logEntry));

    return new Response(JSON.stringify({ success: true }), {
      headers: corsHeaders(),
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { headers: corsHeaders(), status: 500 }
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

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "https://thedatatab.com", // safer: "https://thedatatab.com"
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
