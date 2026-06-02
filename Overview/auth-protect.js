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

    if (!data.ok || !data.loggedIn) {
      window.location.replace("/index.html");
      return;
    }

    // ADMIN USERS = FULL ACCESS
    if (data.isAdmin === true) {
      return;
    }

    const allowed = Array.isArray(data.allow)
      ? data.allow
      : [];

    if (!allowed.includes(currentPage)) {
      alert("You are not allowed to view this page.");
      window.location.replace(
        data.defaultPage || "/index.html"
      );
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