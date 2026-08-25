(function () {
  "use strict";

  const API_URL = "https://bala-pingback-worker.menon-bala.workers.dev/api/pingbacks";
  const MAX_MESSAGE_LENGTH = 4000;

  const form = document.getElementById("pingback-form");
  const messageInput = document.getElementById("message");
  const count = document.getElementById("message-count");
  const submitButton = document.getElementById("submit-button");
  const status = document.getElementById("form-status");

  if (!form || !messageInput || !count || !submitButton || !status) {
    return;
  }

  function updateCount() {
    count.textContent = `${messageInput.value.length} / ${MAX_MESSAGE_LENGTH}`;
  }

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = `form-status${kind ? ` ${kind}` : ""}`;
  }

  function resetTurnstile() {
    if (window.turnstile && typeof window.turnstile.reset === "function") {
      window.turnstile.reset();
    }
  }

  async function readError(response) {
    try {
      const payload = await response.json();
      if (typeof payload.error === "string" && payload.error.length <= 160) {
        return payload.error;
      }
    } catch {
      // Use the generic error below.
    }
    return "The message could not be queued. Please try again.";
  }

  messageInput.addEventListener("input", updateCount);
  updateCount();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("", "");

    if (!form.reportValidity()) {
      return;
    }

    const formData = new FormData(form);
    const turnstileToken = formData.get("cf-turnstile-response");
    if (typeof turnstileToken !== "string" || !turnstileToken) {
      setStatus("Please complete the verification check.", "error");
      return;
    }

    const payload = {
      name: String(formData.get("name") || ""),
      replyTo: String(formData.get("replyTo") || ""),
      message: String(formData.get("message") || ""),
      website: String(formData.get("website") || ""),
      turnstileToken,
    };

    submitButton.disabled = true;
    submitButton.textContent = "Sending…";
    setStatus("Adding your message to the queue…", "");

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      form.reset();
      updateCount();
      resetTurnstile();
      setStatus("Queued. Thanks — I’ll get it when my laptop checks in.", "success");
    } catch (error) {
      resetTurnstile();
      const message = error instanceof Error ? error.message : "The message could not be queued. Please try again.";
      setStatus(message, "error");
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Send pingback";
    }
  });
})();
