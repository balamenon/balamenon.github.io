(function () {
  var relativeTime = typeof Intl !== "undefined" && typeof Intl.RelativeTimeFormat === "function" ? new Intl.RelativeTimeFormat("en", { numeric: "auto" }) : null;
  var TURNSTILE_SITE_KEY = (window.TURNSTILE_SITE_KEY || "").trim();
  var lastUpdatedAt = null;
  var refreshTimer = null;
  var lastRenderedText = "";
  var activeReplyCallout = null;
  var turnstileScriptPromise = null;

  function ensureReplyStyles() {
    if (document.getElementById("status-reply-styles")) {
      return;
    }

    var style = document.createElement("style");
    style.id = "status-reply-styles";
    style.textContent =
      ".site-status-wrap{position:relative}" +
      ".status-bubble-row{display:inline-flex;align-items:center;gap:.45rem;flex-wrap:wrap}" +
      ".status-reply-trigger{display:inline-flex;align-items:center;justify-content:center;width:1.75rem;height:1.75rem;border-radius:999px;border:1px solid rgba(255,255,255,.32);background:rgba(14,18,22,.72);color:#f5f7ff;cursor:pointer;padding:0;line-height:1;transition:transform .16s ease,background .16s ease,border-color .16s ease}" +
      ".status-reply-trigger:hover{transform:translateY(-1px);background:rgba(20,26,32,.9);border-color:rgba(255,255,255,.55)}" +
      ".status-reply-trigger[hidden]{display:none}" +
      ".status-reply-callout{position:absolute;top:calc(100% + .45rem);left:0;z-index:35;width:min(420px,86vw);padding:.72rem;border-radius:.75rem;border:1px solid rgba(255,255,255,.16);background:rgba(9,13,18,.95);backdrop-filter:blur(8px);display:none;box-shadow:0 16px 38px rgba(0,0,0,.35)}" +
      ".status-reply-callout.open{display:block}" +
      ".status-reply-textarea{width:100%;resize:vertical;min-height:88px;border-radius:.56rem;border:1px solid rgba(255,255,255,.17);padding:.58rem .62rem;background:rgba(255,255,255,.96);color:#111926;font:inherit}" +
      ".status-reply-textarea:focus{outline:none;border-color:rgba(84,197,255,.8);box-shadow:0 0 0 2px rgba(84,197,255,.24)}" +
      ".status-reply-actions{display:flex;gap:.45rem;margin-top:.55rem}" +
      ".status-reply-send,.status-reply-cancel{border:0;border-radius:.52rem;padding:.38rem .64rem;font:inherit;cursor:pointer}" +
      ".status-reply-send{background:#e9f3ff;color:#0f2134}" +
      ".status-reply-cancel{background:rgba(255,255,255,.16);color:#eff5ff}" +
      ".status-reply-feedback{margin:.42rem 0 0;font-size:.84rem;color:#ffd9d9;min-height:1.2em}" +
      ".status-reply-turnstile{margin-top:.55rem;min-height:65px}";
    document.head.appendChild(style);
  }

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

  function closeActiveReplyCallout() {
    if (!activeReplyCallout) {
      return;
    }
    activeReplyCallout.classList.remove("open");
    activeReplyCallout = null;
  }

  function ensureTurnstileScript() {
    if (!TURNSTILE_SITE_KEY) {
      return Promise.resolve(false);
    }
    if (window.turnstile && typeof window.turnstile.render === "function") {
      return Promise.resolve(true);
    }
    if (turnstileScriptPromise) {
      return turnstileScriptPromise;
    }

    turnstileScriptPromise = new Promise(function (resolve) {
      var script = document.querySelector('script[src="https://challenges.cloudflare.com/turnstile/v0/api.js"]');
      if (script) {
        var waiter = window.setInterval(function () {
          if (window.turnstile && typeof window.turnstile.render === "function") {
            window.clearInterval(waiter);
            resolve(true);
          }
        }, 60);
        window.setTimeout(function () {
          window.clearInterval(waiter);
          resolve(!!(window.turnstile && typeof window.turnstile.render === "function"));
        }, 5000);
        return;
      }

      var newScript = document.createElement("script");
      newScript.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
      newScript.async = true;
      newScript.defer = true;
      newScript.onload = function () {
        resolve(!!(window.turnstile && typeof window.turnstile.render === "function"));
      };
      newScript.onerror = function () {
        resolve(false);
      };
      document.head.appendChild(newScript);
    });

    return turnstileScriptPromise;
  }

  async function submitStatusReply(message, turnstileToken) {
    var endpoint = getApiBase() + "/api/status/replies";
    var response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        message: message,
        turnstile_token: turnstileToken || ""
      })
    });

    if (!response.ok) {
      var payload = await response.json().catch(function () {
        return { error: "Could not send reply." };
      });
      throw new Error(payload.error || "Could not send reply.");
    }
  }

  function ensureReplyUi(container) {
    if (!container || container.__statusReplyInit) {
      return;
    }

    ensureReplyStyles();

    var bubble = container.querySelector("[data-site-status]");
    if (!bubble) {
      return;
    }

    var row = document.createElement("div");
    row.className = "status-bubble-row";
    bubble.parentNode.insertBefore(row, bubble);
    row.appendChild(bubble);

    var trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "status-reply-trigger";
    trigger.setAttribute("aria-label", "Reply to status");
    trigger.title = "Reply";
    trigger.textContent = "↩";
    row.appendChild(trigger);

    var callout = document.createElement("div");
    callout.className = "status-reply-callout";

    var textarea = document.createElement("textarea");
    textarea.className = "status-reply-textarea";
    textarea.rows = 4;
    textarea.maxLength = 2000;
    textarea.placeholder = "Share a suggestion (music, articles, ideas...)";

    var turnstileSlot = document.createElement("div");
    turnstileSlot.className = "status-reply-turnstile";

    var actions = document.createElement("div");
    actions.className = "status-reply-actions";

    var sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "status-reply-send";
    sendBtn.textContent = "Send";

    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "status-reply-cancel";
    cancelBtn.textContent = "Cancel";

    var feedback = document.createElement("p");
    feedback.className = "status-reply-feedback";

    actions.appendChild(sendBtn);
    actions.appendChild(cancelBtn);
    callout.appendChild(textarea);
    callout.appendChild(turnstileSlot);
    callout.appendChild(actions);
    callout.appendChild(feedback);
    container.appendChild(callout);

    var turnstileWidgetId = null;
    var turnstileReady = false;

    async function ensureTurnstileWidget() {
      if (!TURNSTILE_SITE_KEY || turnstileReady) {
        return;
      }

      var scriptReady = await ensureTurnstileScript();
      if (!scriptReady || !window.turnstile || typeof window.turnstile.render !== "function") {
        feedback.textContent = "Verification unavailable right now.";
        return;
      }

      turnstileWidgetId = window.turnstile.render(turnstileSlot, {
        sitekey: TURNSTILE_SITE_KEY
      });
      turnstileReady = true;
    }

    trigger.addEventListener("click", function () {
      var wasOpen = callout.classList.contains("open");
      closeActiveReplyCallout();
      if (wasOpen) {
        return;
      }
      callout.classList.add("open");
      activeReplyCallout = callout;
      feedback.textContent = "";
      ensureTurnstileWidget();
      textarea.focus();
    });

    cancelBtn.addEventListener("click", function () {
      feedback.textContent = "";
      callout.classList.remove("open");
      if (activeReplyCallout === callout) {
        activeReplyCallout = null;
      }
    });

    sendBtn.addEventListener("click", async function () {
      var message = textarea.value.trim();
      if (!message) {
        feedback.textContent = "Please add a message.";
        return;
      }

      var token =
        turnstileWidgetId !== null && window.turnstile && typeof window.turnstile.getResponse === "function"
          ? window.turnstile.getResponse(turnstileWidgetId)
          : "";

      if (TURNSTILE_SITE_KEY && !token) {
        feedback.textContent = "Please complete verification.";
        return;
      }

      sendBtn.disabled = true;
      feedback.textContent = "";

      try {
        await submitStatusReply(message, token);
        textarea.value = "";
        callout.classList.remove("open");
        if (activeReplyCallout === callout) {
          activeReplyCallout = null;
        }
      } catch (error) {
        feedback.textContent = (error && error.message) || "Could not send reply.";
      } finally {
        sendBtn.disabled = false;
        if (turnstileWidgetId !== null && window.turnstile && typeof window.turnstile.reset === "function") {
          window.turnstile.reset(turnstileWidgetId);
        }
      }
    });

    container.__statusReplyInit = true;
    container.__statusReplyTrigger = trigger;
    container.__statusReplyCallout = callout;
  }

  function renderStatus(text, updatedAt, repliesEnabled) {
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
      containers.forEach(function (el) {
        if (el.__statusReplyTrigger) {
          el.__statusReplyTrigger.hidden = true;
        }
        if (el.__statusReplyCallout) {
          el.__statusReplyCallout.classList.remove("open");
        }
      });
      lastUpdatedAt = null;
      lastRenderedText = "";
      closeActiveReplyCallout();
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
      ensureReplyUi(el);
      el.hidden = false;
      if (shouldAnimate) {
        el.classList.remove("status-enter");
        void el.offsetWidth;
        el.classList.add("status-enter");
      }
      if (el.__statusReplyTrigger) {
        el.__statusReplyTrigger.hidden = !repliesEnabled;
      }
      if (!repliesEnabled && el.__statusReplyCallout) {
        el.__statusReplyCallout.classList.remove("open");
      }
    });
    if (!repliesEnabled) {
      closeActiveReplyCallout();
    }

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
    var repliesEnabled = payload.replies_enabled === true;
    renderStatus(statusText, updatedAt, repliesEnabled);
    startRefreshTimer();
  }

  document.addEventListener("click", function (event) {
    if (!activeReplyCallout) {
      return;
    }
    var target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (!activeReplyCallout.contains(target) && !target.closest(".status-reply-trigger")) {
      closeActiveReplyCallout();
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      loadStatus().catch(function () {});
    });
  } else {
    loadStatus().catch(function () {});
  }
})();
