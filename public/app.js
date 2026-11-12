const messagesEl = document.getElementById("messages");
const emptyStateEl = document.getElementById("empty-state");
const formEl = document.getElementById("chat-form");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");
const clearBtn = document.getElementById("clear-btn");

/** @type {Array<{ role: "user" | "assistant", content: string }>} */
const conversation = [];
let isStreaming = false;

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isSafeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Lightweight, safe formatter: escapes HTML first, then converts markdown
 * links, bare URLs, inline code, bold text, and line breaks.
 */
function formatAssistantText(raw) {
  let html = escapeHtml(raw);

  // Markdown links: [label](https://...)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
    if (!isSafeHttpUrl(url)) return label;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // Bare URLs not already inside an href="..." attribute
  html = html.replace(/(^|[\s(>])(https?:\/\/[^\s<)]+)/g, (_match, prefix, url) => {
    const cleaned = url.replace(/[.,;:!?]+$/, "");
    const trailing = url.slice(cleaned.length);
    if (!isSafeHttpUrl(cleaned)) return `${prefix}${url}`;
    return `${prefix}<a href="${cleaned}" target="_blank" rel="noopener noreferrer">${cleaned}</a>${trailing}`;
  });

  // Inline code and bold
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\n/g, "<br>");

  return html;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideEmptyState() {
  if (emptyStateEl) {
    emptyStateEl.hidden = true;
  }
}

function appendUserMessage(text) {
  hideEmptyState();
  const wrapper = document.createElement("div");
  wrapper.className = "message user";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  wrapper.appendChild(bubble);
  messagesEl.appendChild(wrapper);
  scrollToBottom();
}

function createAssistantTurnUI() {
  hideEmptyState();
  const wrapper = document.createElement("div");
  wrapper.className = "message assistant";

  const statusEl = document.createElement("div");
  statusEl.className = "status-line";
  statusEl.hidden = true;

  const bubbleEl = document.createElement("div");
  bubbleEl.className = "bubble";
  bubbleEl.hidden = true;

  const sourcesEl = document.createElement("div");
  sourcesEl.className = "sources";
  sourcesEl.hidden = true;

  wrapper.appendChild(statusEl);
  wrapper.appendChild(bubbleEl);
  wrapper.appendChild(sourcesEl);
  messagesEl.appendChild(wrapper);
  scrollToBottom();

  return {
    wrapper,
    setStatus(text) {
      statusEl.innerHTML = `<span class="status-dot"></span><span>${escapeHtml(text)}</span>`;
      statusEl.hidden = false;
      scrollToBottom();
    },
    clearStatus() {
      statusEl.hidden = true;
      statusEl.innerHTML = "";
    },
    setText(text) {
      bubbleEl.hidden = false;
      bubbleEl.innerHTML = formatAssistantText(text);
      scrollToBottom();
    },
    setSources(sources) {
      if (!Array.isArray(sources) || sources.length === 0) return;
      sourcesEl.innerHTML = "";
      for (const src of sources) {
        if (!src || !isSafeHttpUrl(src.url)) continue;
        const link = document.createElement("a");
        link.className = "source-chip";
        link.href = src.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        const dateSuffix = src.date && src.date !== "unknown" ? ` (${src.date})` : "";
        link.textContent = `${src.title || src.url}${dateSuffix}`;
        link.title = `${src.title || src.url}${dateSuffix}`;
        sourcesEl.appendChild(link);
      }
      if (sourcesEl.childElementCount > 0) {
        sourcesEl.hidden = false;
        scrollToBottom();
      }
    },
    removeIfEmpty() {
      if (bubbleEl.hidden) {
        wrapper.remove();
      }
    },
  };
}

function appendInlineError(message) {
  hideEmptyState();
  const errEl = document.createElement("div");
  errEl.className = "error-inline";
  errEl.textContent = `Error: ${message}`;
  messagesEl.appendChild(errEl);
  scrollToBottom();
}

function setStreaming(active) {
  isStreaming = active;
  sendBtn.disabled = active;
}

function resizeTextarea() {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
}

/**
 * Parses an SSE stream from fetch() and dispatches complete event blocks.
 */
async function readSseStream(response, onEvent) {
  if (!response.body) {
    throw new Error("Server did not return a readable response stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const processBlock = (block) => {
    const lines = block.split("\n");
    let eventName = "message";
    const dataLines = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (dataLines.length === 0) return;
    const rawData = dataLines.join("\n");
    try {
      onEvent(eventName, JSON.parse(rawData));
    } catch {
      throw new Error("Received malformed event data from server.");
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const block = buffer.slice(0, separatorIndex).trim();
      buffer = buffer.slice(separatorIndex + 2);
      if (block) {
        processBlock(block);
      }
      separatorIndex = buffer.indexOf("\n\n");
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    processBlock(trailing);
  }
}

async function sendMessage() {
  if (isStreaming) return;
  const text = inputEl.value.trim();
  if (!text) return;

  inputEl.value = "";
  resizeTextarea();
  appendUserMessage(text);
  conversation.push({ role: "user", content: text });

  setStreaming(true);
  const turnUI = createAssistantTurnUI();
  let assistantText = "";
  let receivedDone = false;
  let receivedError = false;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: conversation }),
    });

    if (!response.ok) {
      let errMsg = `Request failed (${response.status})`;
      try {
        const errJson = await response.json();
        if (errJson && typeof errJson.error === "string") {
          errMsg = errJson.error;
        }
      } catch {
        // Ignore JSON parse failure and keep HTTP status message.
      }
      throw new Error(errMsg);
    }

    await readSseStream(response, (event, payload) => {
      if (event === "status" && payload?.message) {
        turnUI.setStatus(payload.message);
      } else if (event === "token" && typeof payload?.text === "string") {
        // Remove the muted status line as soon as answer tokens begin streaming.
        turnUI.clearStatus();
        assistantText += payload.text;
        turnUI.setText(assistantText);
      } else if (event === "done") {
        receivedDone = true;
        turnUI.clearStatus();
        const finalContent =
          typeof payload?.content === "string" ? payload.content : assistantText;
        if (finalContent) {
          turnUI.setText(finalContent);
          conversation.push({ role: "assistant", content: finalContent });
        }
        turnUI.setSources(payload?.sources);
      } else if (event === "error") {
        receivedError = true;
        turnUI.clearStatus();
        turnUI.removeIfEmpty();
        appendInlineError(payload?.error || "Unknown server error.");
      }
    });

    if (!receivedDone && !receivedError) {
      conversation.pop();
      turnUI.clearStatus();
      turnUI.removeIfEmpty();
      appendInlineError("Connection closed before the reply finished.");
    } else if (receivedError) {
      conversation.pop();
    }
  } catch (err) {
    conversation.pop();
    turnUI.clearStatus();
    turnUI.removeIfEmpty();
    const message =
      err instanceof Error ? err.message : "Network error while contacting server.";
    appendInlineError(message);
  } finally {
    setStreaming(false);
    inputEl.focus();
  }
}

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendMessage();
});

inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void sendMessage();
  }
});

inputEl.addEventListener("input", resizeTextarea);

clearBtn.addEventListener("click", () => {
  if (isStreaming) return;
  conversation.length = 0;
  messagesEl.innerHTML = "";
  if (emptyStateEl) {
    emptyStateEl.hidden = false;
    messagesEl.appendChild(emptyStateEl);
  }
  inputEl.focus();
});
