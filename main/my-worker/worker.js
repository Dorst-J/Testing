export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle GET: Return the current log
    if (request.method === "GET" && url.pathname === "/log") {
      let logs = await env.SIGNINS.get("log", { type: "json" }) || [];
      return new Response(JSON.stringify(logs), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Handle POST: Add new sign-in
    if (request.method === "POST" && url.pathname === "/signin") {
      const { name } = await request.json();
      if (!name) {
        return new Response(JSON.stringify({ error: "Name required" }), { status: 400 });
      }

      let logs = await env.SIGNINS.get("log", { type: "json" }) || [];
      logs.unshift({ name, time: new Date().toLocaleString() });
      await env.SIGNINS.put("log", JSON.stringify(logs));

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};
