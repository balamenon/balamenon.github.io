(function () {
  const NOTES_API_BASE = window.NOTES_API_BASE || "";
  const PAGE_SIZE = 10;

  const root = document.getElementById("notes-root");
  const statusEl = document.getElementById("notes-status");
  const prevBtn = document.getElementById("prev-page");
  const nextBtn = document.getElementById("next-page");
  const pageLabel = document.getElementById("page-label");
  const retryBtn = document.getElementById("retry-button");
  let activeThoughtCallout = null;

  let currentPage = Number.parseInt(new URLSearchParams(window.location.search).get("page") || "1", 10);
  if (Number.isNaN(currentPage) || currentPage < 1) {
    currentPage = 1;
  }

  function ordinalSuffix(day) {
    const mod10 = day % 10;
    const mod100 = day % 100;
    if (mod10 === 1 && mod100 !== 11) return "st";
    if (mod10 === 2 && mod100 !== 12) return "nd";
    if (mod10 === 3 && mod100 !== 13) return "rd";
    return "th";
  }

  function formatGroupDate(dateUtc) {
    const parts = dateUtc.split("-");
    if (parts.length !== 3) return dateUtc;

    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    if (!year || !month || !day) return dateUtc;

    const monthName = new Intl.DateTimeFormat("en-US", {
      month: "long",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month - 1, day)));

    return `${day}${ordinalSuffix(day)} ${monthName} ${year}`;
  }

  function formatTimeAgo(isoTimestamp) {
    const ts = Date.parse(isoTimestamp);
    if (Number.isNaN(ts)) return isoTimestamp;

    const diffSeconds = Math.floor((Date.now() - ts) / 1000);
    if (diffSeconds < 45) return "a few seconds ago";
    if (diffSeconds < 90) return "a minute ago";

    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 45) return `${diffMinutes} minutes ago`;
    if (diffMinutes < 90) return "an hour ago";

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours} hours ago`;
    if (diffHours < 48) return "yesterday";

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays} days ago`;

    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths < 12) return diffMonths === 1 ? "a month ago" : `${diffMonths} months ago`;

    const diffYears = Math.floor(diffMonths / 12);
    return diffYears === 1 ? "a year ago" : `${diffYears} years ago`;
  }

  function setStatus(text, isError) {
    statusEl.textContent = text || "";
    statusEl.classList.toggle("error", !!isError);
  }

  function updateUrl(page) {
    const url = new URL(window.location.href);
    url.searchParams.set("page", String(page));
    window.history.replaceState({}, "", url.toString());
  }

  function closeActiveThoughtCallout() {
    if (!activeThoughtCallout) return;
    activeThoughtCallout.classList.remove("open");
    activeThoughtCallout = null;
  }

  async function submitThought(noteId, sender, message) {
    const url = new URL((NOTES_API_BASE || window.location.origin) + `/api/notes/${noteId}/thoughts`);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sender,
        message,
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(function () {
        return { error: `API error ${response.status}` };
      });
      throw new Error(payload.error || `API error ${response.status}`);
    }
  }

  function createThoughtComposer(note) {
    const container = document.createElement("div");
    container.className = "thoughts-wrap";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "thought-trigger";
    trigger.textContent = "Send thoughts?";

    const callout = document.createElement("div");
    callout.className = "thought-callout";

    const senderLabel = document.createElement("label");
    senderLabel.className = "thought-label";
    senderLabel.textContent = "Name or X handle";

    const senderInput = document.createElement("input");
    senderInput.type = "text";
    senderInput.maxLength = 80;
    senderInput.placeholder = "e.g. @yourhandle";

    const messageLabel = document.createElement("label");
    messageLabel.className = "thought-label";
    messageLabel.textContent = "Your message";

    const messageInput = document.createElement("textarea");
    messageInput.rows = 4;
    messageInput.maxLength = 2000;
    messageInput.placeholder = "Share your thoughts on this note...";

    const actions = document.createElement("div");
    actions.className = "thought-actions";

    const sendButton = document.createElement("button");
    sendButton.type = "button";
    sendButton.className = "thought-send";
    sendButton.textContent = "Send";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "thought-cancel";
    cancelButton.textContent = "Cancel";

    const feedback = document.createElement("p");
    feedback.className = "thought-feedback";

    actions.appendChild(sendButton);
    actions.appendChild(cancelButton);

    callout.appendChild(senderLabel);
    callout.appendChild(senderInput);
    callout.appendChild(messageLabel);
    callout.appendChild(messageInput);
    callout.appendChild(actions);
    callout.appendChild(feedback);

    trigger.addEventListener("click", function () {
      const wasOpen = callout.classList.contains("open");
      closeActiveThoughtCallout();
      if (!wasOpen) {
        callout.classList.remove("sending");
        callout.classList.add("open");
        activeThoughtCallout = callout;
        senderInput.focus();
      }
    });

    cancelButton.addEventListener("click", function () {
      callout.classList.remove("open");
      if (activeThoughtCallout === callout) {
        activeThoughtCallout = null;
      }
      feedback.textContent = "";
    });

    sendButton.addEventListener("click", async function () {
      const sender = senderInput.value.trim();
      const message = messageInput.value.trim();
      if (!sender) {
        feedback.textContent = "Please add your name or X handle.";
        return;
      }
      if (!message) {
        feedback.textContent = "Please add a message.";
        return;
      }

      sendButton.disabled = true;
      callout.classList.add("sending");

      const submittedSender = sender;
      const submittedMessage = message;

      senderInput.value = "";
      messageInput.value = "";
      feedback.textContent = "";

      setTimeout(function () {
        callout.classList.remove("open");
        callout.classList.remove("sending");
        if (activeThoughtCallout === callout) {
          activeThoughtCallout = null;
        }
        sendButton.disabled = false;
      }, 430);

      submitThought(note.id, submittedSender, submittedMessage)
        .then(function () {
          setStatus("Thought sent. Thank you.", false);
          setTimeout(function () {
            if (statusEl.textContent === "Thought sent. Thank you.") {
              setStatus("", false);
            }
          }, 2200);
        })
        .catch(function (error) {
          setStatus(error.message || "Could not send your thoughts.", true);
        });
    });

    container.appendChild(trigger);
    container.appendChild(callout);
    return container;
  }

  function createNoteElement(note) {
    const article = document.createElement("article");
    article.className = "note-item";

    const meta = document.createElement("p");
    meta.className = "note-meta";
    const timeAgo = formatTimeAgo(note.created_at);
    meta.textContent = `#${note.id} | ${note.word_count} words | ${timeAgo}`;
    meta.title = note.created_at;
    article.appendChild(meta);

    const content = document.createElement("div");
    content.className = "note-content";

    const maxPreviewChars = 1200;
    const fullText = note.content || "";

    if (fullText.length > maxPreviewChars) {
      let expanded = false;
      const textEl = document.createElement("p");
      textEl.textContent = fullText.slice(0, maxPreviewChars) + "...";

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "toggle-note";
      toggle.textContent = "Show more";

      toggle.addEventListener("click", function () {
        expanded = !expanded;
        textEl.textContent = expanded ? fullText : fullText.slice(0, maxPreviewChars) + "...";
        toggle.textContent = expanded ? "Show less" : "Show more";
      });

      content.appendChild(textEl);
      content.appendChild(toggle);
    } else {
      const textEl = document.createElement("p");
      textEl.textContent = fullText;
      content.appendChild(textEl);
    }

    article.appendChild(content);
    article.appendChild(createThoughtComposer(note));
    return article;
  }

  function renderGroups(groups) {
    root.innerHTML = "";

    if (!groups || groups.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No notes yet.";
      root.appendChild(empty);
      return;
    }

    groups.forEach(function (group) {
      const section = document.createElement("section");
      section.className = "day-group";

      const heading = document.createElement("h3");
      heading.textContent = formatGroupDate(group.date_utc);
      section.appendChild(heading);

      group.notes.forEach(function (note) {
        section.appendChild(createNoteElement(note));
      });

      root.appendChild(section);
    });
  }

  async function fetchPage(page) {
    setStatus("Loading notes...", false);

    try {
      const url = new URL((NOTES_API_BASE || window.location.origin) + "/api/notes");
      url.searchParams.set("page", String(page));
      url.searchParams.set("page_size", String(PAGE_SIZE));
      url.searchParams.set("tz", "UTC");

      const response = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`API error ${response.status}`);
      }

      const payload = await response.json();
      renderGroups(payload.groups || []);

      currentPage = payload.page || page;
      pageLabel.textContent = `Page ${currentPage}`;
      prevBtn.disabled = !payload.has_prev;
      nextBtn.disabled = !payload.has_next;

      updateUrl(currentPage);
      setStatus("", false);
    } catch (error) {
      setStatus(`Could not load notes. ${error.message || "Unknown error"}`, true);
      root.innerHTML = "";
    }
  }

  prevBtn.addEventListener("click", function () {
    if (currentPage > 1) {
      fetchPage(currentPage - 1);
    }
  });

  nextBtn.addEventListener("click", function () {
    fetchPage(currentPage + 1);
  });

  retryBtn.addEventListener("click", function () {
    fetchPage(currentPage);
  });

  document.addEventListener("click", function (event) {
    if (!activeThoughtCallout) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!activeThoughtCallout.contains(target) && !target.closest(".thoughts-wrap")) {
      closeActiveThoughtCallout();
    }
  });

  fetchPage(currentPage);
})();
