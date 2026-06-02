(async function () {
  const currentPage =
    "/" + window.location.pathname.split("/").pop();

  try {
    const res = await fetch(
      "https://overview.jenna-dorst.workers.dev/api/auth/check",
      {
        credentials: "include"
      }
    );

    const data = await res.json();

    // not signed in
    if (!data.ok || !data.loggedIn) {
      window.location.replace("/index.html");
      return;
    }

    // admin can see everything
    if (data.allow === "*") return;

    const allowed = data.allow || [];

    // page not allowed
    if (!allowed.includes(currentPage)) {
      alert("You are not allowed to view this page.");
      window.location.replace(data.defaultPage || "/index.html");
      return;
    }

  } catch (err) {
    console.error(err);
    window.location.replace("/index.html");
  }
})();

async function signOut() {
  try {
    await fetch(
      "https://overview.jenna-dorst.workers.dev/signout",
      {
        method: "POST",
        credentials: "include"
      }
    );
  } catch {}

  window.location.replace("/index.html");
}