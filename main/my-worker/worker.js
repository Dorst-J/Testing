export default {
  async fetch(request, env, ctx) {
    if (request.method === "POST") {
      const { choices } = await request.json();

      const body = `The user selected:\n\n${choices
        .map((c, i) => `Dropdown ${i + 1}: ${c}`)
        .join("\n")}`;

      await env.SEND_EMAIL.send({
        from: "jenna.dorst@gmail.com", // must be a routed domain
        to: "sedorst17@gmail.com",       // forwarded to your real email
        subject: "Dropdown Choices Submitted",
        text: body
      });

      return new Response("Email sent", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  }
};
