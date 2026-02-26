(function () {
  var relativeTime = typeof Intl !== "undefined" && typeof Intl.RelativeTimeFormat === "function" ? new Intl.RelativeTimeFormat("en", { numeric: "auto" }) : null;
  var lastUpdatedAt = null;
  var refreshTimer = null;
  var lastRenderedText = "";

  function getApiBase() {
    var configured = (window.SITE_API_BASE || window.NOTES_API_BASE || "").trim();
    if (configured) {
      return configured.replace(/\/$/, "");
    }
    return window.location.origin;
  }

  function formatUpdatedTime(updatedAt) {
    if (!updatedAt) {
      return "";
    }

    var updatedMs = Date.parse(updatedAt);
    if (Number.isNaN(updatedMs)) {
      return "";
    }

    var deltaSeconds = Math.round((Date.now() - updatedMs) / 1000);
    if (deltaSeconds < 45) {
      return "updated just now";
    }

    var units = [
      { name: "year", seconds: 31536000 },
      { name: "month", seconds: 2592000 },
      { name: "day", seconds: 86400 },
      { name: "hour", seconds: 3600 },
      { name: "minute", seconds: 60 }
    ];

    for (var i = 0; i < units.length; i += 1) {
      var unit = units[i];
      if (deltaSeconds >= unit.seconds) {
        var value = Math.floor(deltaSeconds / unit.seconds);
        if (relativeTime) {
          return "updated " + relativeTime.format(-value, unit.name);
        }
        return "updated " + value + " " + unit.name + (value === 1 ? " ago" : "s ago");
      }
    }

    return "updated just now";
  }

  function renderStatus(text, updatedAt) {
    var containers = document.querySelectorAll("[data-site-status-container]");
    var bubbles = document.querySelectorAll("[data-site-status]");
    var meta = document.querySelectorAll("[data-site-status-updated]");
    var normalizedText = typeof text === "string" ? text.trim() : "";

    if (!normalizedText) {
      containers.forEach(function (el) {
        el.hidden = true;
        el.classList.remove("status-enter");
      });
      bubbles.forEach(function (el) {
        el.textContent = "";
      });
      meta.forEach(function (el) {
        el.textContent = "";
      });
      lastUpdatedAt = null;
      lastRenderedText = "";
      return;
    }

    bubbles.forEach(function (el) {
      el.textContent = normalizedText;
    });

    var label = formatUpdatedTime(updatedAt);
    meta.forEach(function (el) {
      el.textContent = label;
    });

    var shouldAnimate = lastRenderedText !== normalizedText;
    containers.forEach(function (el) {
      el.hidden = false;
      if (shouldAnimate) {
        el.classList.remove("status-enter");
        void el.offsetWidth;
        el.classList.add("status-enter");
      }
    });

    lastUpdatedAt = updatedAt || null;
    lastRenderedText = normalizedText;
  }

  function startRefreshTimer() {
    if (refreshTimer !== null) {
      return;
    }
    refreshTimer = window.setInterval(function () {
      if (!lastUpdatedAt) {
        return;
      }
      var label = formatUpdatedTime(lastUpdatedAt);
      var meta = document.querySelectorAll("[data-site-status-updated]");
      meta.forEach(function (el) {
        el.textContent = label;
      });
    }, 60000);
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

    var statusText = typeof payload.status === "string" ? payload.status.replace(/\s+/g, " ").trim() : "";
    var updatedAt = typeof payload.updated_at === "string" ? payload.updated_at : "";
    renderStatus(statusText, updatedAt);
    startRefreshTimer();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      loadStatus().catch(function () {});
    });
  } else {
    loadStatus().catch(function () {});
  }
})();
