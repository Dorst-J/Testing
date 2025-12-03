// adminButton.js
(function () {
  const role = localStorage.getItem("userRole");

  // Only admins see the button
  if (role !== "admin") return;

  // Create wrapper div
  const wrapper = document.createElement("div");
  wrapper.id = "admin-float-btn";
  wrapper.style.position = "fixed";
  wrapper.style.bottom = "20px";
  wrapper.style.right = "20px";
  wrapper.style.zIndex = "9999";

  // Create button
  const button = document.createElement("button");
  button.innerText = "Admin Dashboard";
  button.onclick = () => window.location.href = "./AdminMainPage.html";

  // Button styling
  button.style.padding = "14px 22px";
  button.style.backgroundColor = "#007bff";
  button.style.color = "white";
  button.style.border = "none";
  button.style.borderRadius = "50px";
  button.style.fontSize = "16px";
  button.style.boxShadow = "0 4px 10px rgba(0,0,0,0.3)";
  button.style.cursor = "pointer";

  wrapper.appendChild(button);
  document.body.appendChild(wrapper);
})();
