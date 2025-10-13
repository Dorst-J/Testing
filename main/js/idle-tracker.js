(() => {
  const MAX_IDLE_MS = 5 * 60_000;   // 1 minutes
  const HEARTBEAT_INTERVAL = 60_000; // every 1 minute
  const WARNING_MS = 60_000;         // 1 minute before logout

  let lastActivity = Date.now();
  let sessionId = localStorage.getItem('sessionId');
  let heartbeatTimer, checkTimer;

  // Reuse or create a sessionId
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    localStorage.setItem('sessionId', sessionId);
  }

  function resetActivity() {
    lastActivity = Date.now();
    const warning = document.getElementById('logoutWarning');
    if (warning) warning.style.display = 'none';
  }

  async function sendHeartbeat() {
    try {
      await fetch('https://thedatatab.jenna-dorst.workers.dev/api/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
    } catch (err) {
      console.warn('Heartbeat failed', err);
    }
  }

  function checkIdle() {
    const idleTime = Date.now() - lastActivity;
    const remaining = MAX_IDLE_MS - idleTime;

    if (remaining <= 0) {
      logoutUser();
    } else if (remaining <= WARNING_MS) {
      showWarning();
    }
  }

  async function logoutUser() {
    try {
      await fetch('https://thedatatab.jenna-dorst.workers.dev/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
    } catch (e) {}
    localStorage.removeItem('sessionId');
    window.location.href = '/index.html?reason=idle';
  }

  function showWarning() {
    let warning = document.getElementById('logoutWarning');
    if (!warning) {
      warning = document.createElement('div');
      warning.id = 'logoutWarning';
      warning.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: #fff3cd;
        color: #856404;
        border: 1px solid #ffeeba;
        padding: 10px 15px;
        border-radius: 8px;
        box-shadow: 0 0 5px rgba(0,0,0,0.1);
        font-family: Arial, sans-serif;
        z-index: 9999;
      `;
      warning.textContent = 'You will be logged out soon due to inactivity.';
      document.body.appendChild(warning);
    }
    warning.style.display = 'block';
  }

  ['mousemove','keydown','mousedown','scroll','touchstart'].forEach(ev =>
    window.addEventListener(ev, resetActivity, { passive: true })
  );

  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  checkTimer = setInterval(checkIdle, 1000);
  sendHeartbeat();
})();
