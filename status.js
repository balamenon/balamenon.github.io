(function () {
  function getApiBase() {
    var configured = (window.SITE_API_BASE || window.NOTES_API_BASE || "").trim();
    if (configured) {
      return configured.replace(/\/$/, "");
    }
    return window.location.origin;
  }

  function renderStatus(text) {
    var targets = document.querySelectorAll("[data-site-status]");
    targets.forEach(function (el) {
      if (!text) {
        el.textContent = "";
        el.hidden = true;
        return;
      }
      el.textContent = text;
      el.hidden = false;
    });
  }

  async function loadStatus() {
    var endpoint = getApiBase() + "/api/status";
    var response = await fetch(endpoint, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      return;
    }

    var payload = await response.json();
    if (!payload || payload.ok !== true) {
      return;
    }

    var statusText = typeof payload.status === "string" ? payload.status.trim() : "";
    renderStatus(statusText);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      loadStatus().catch(function () {});
    });
  } else {
    loadStatus().catch(function () {});
  }
})();
