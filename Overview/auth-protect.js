(async function () {
  function norm(p) {
    if (!p) return "";

    let clean = "/" + String(p)
      .replace("./", "")
      .replace(/^\/+/, "")
      .split("?")[0]
      .split("#")[0];

    // If page was typed without .html, add it
    if (!clean.includes(".") && clean !== "/") {
      clean += ".html";
    }

    return clean;
  }

  const currentPage = norm(window.location.pathname);

  try {
    const res = await fetch("https://overview.jenna-dorst.workers.dev/api/auth/check", {
      method: "GET",
      credentials: "include",
      cache: "no-store"
    });

    const data = await res.json();
    console.log("AUTH CHECK:", data, "CURRENT:", currentPage);

    if (!data.ok || !data.loggedIn) {
      window.location.replace("/index.html");
      return;
    }

    if (data.isAdmin === true) return;

    const allowed = Array.isArray(data.allow)
      ? data.allow.map(norm)
      : [];

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