(async function () {
  const currentPage = "/" + window.location.pathname.split("/").pop();

  try {
    const res = await fetch(
      "https://overview.jenna-dorst.workers.dev/api/auth/check",
      {
        method: "GET",
        credentials: "include",
        cache: "no-store"
      }
    );

    const data = await res.json();

    console.log("AUTH CHECK:", data, "CURRENT PAGE:", currentPage);

    if (!data.ok || !data.loggedIn) {
      window.location.replace("/index.html");
      return;
    }

    const allowed = Array.isArray(data.allow) ? data.allow : [data.allow];

    if (allowed.includes("*")) return;

    if (!allowed.includes(currentPage)) {
      alert("You are not allowed to view this page.");
      window.location.replace(data.defaultPage || "/index.html");
      return;
    }

  } catch (err) {
    console.error("AUTH ERROR:", err);
    window.location.replace("/index.html");
  }
})();

async function signOut() {
  try {
    await fetch("https://overview.jenna-dorst.workers.dev/signout", {
      method: "POST",
      credentials: "include",
      cache: "no-store"
    });
  } catch {}

  window.location.replace("/index.html");
}