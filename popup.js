const requestListEl = document.getElementById("requestList");
const detailsBodyEl = document.getElementById("detailsBody");
const emptyStateEl = document.getElementById("emptyState");
const clearBtn = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");

const requestMap = new Map();
let activeRequestId = null;
let port = null;
let currentTabId = null;

function formatTime(timeStamp) {
  if (!timeStamp) {
    return "";
  }
  return new Date(timeStamp).toLocaleTimeString();
}

function setEmptyState(visible) {
  emptyStateEl.style.display = visible ? "block" : "none";
}

function setStatus(message) {
  if (!message) {
    statusEl.textContent = "";
    statusEl.classList.add("hidden");
    return;
  }
  statusEl.textContent = message;
  statusEl.classList.remove("hidden");
}

function renderListItem(record, isNew) {
  let item = document.querySelector(`[data-request-id="${record.id}"]`);
  if (!item) {
    item = document.createElement("li");
    item.className = "request-item";
    item.dataset.requestId = record.id;
    item.addEventListener("click", () => {
      setActiveRequest(record.id);
    });
    if (isNew) {
      requestListEl.prepend(item);
    } else {
      requestListEl.appendChild(item);
    }
  }

  if (record.id === activeRequestId) {
    item.classList.add("request-item--active");
  } else {
    item.classList.remove("request-item--active");
  }

  const meta = `${record.method || "-"} • ${record.statusCode || "..."}`;
  item.innerHTML = `
    <div class="request-item__row">
      <div class="request-item__url">${record.url}</div>
      <div class="request-item__meta">${meta}</div>
    </div>
    <div class="request-item__row">
      <div class="request-item__meta">${record.type || "other"}</div>
      <div class="request-item__meta">${formatTime(record.timeStamp)}</div>
    </div>
  `;
}

function renderList() {
  requestListEl.innerHTML = "";
  const records = Array.from(requestMap.values());
  setEmptyState(records.length === 0);
  records.forEach((record) => renderListItem(record, false));
}

function setActiveRequest(requestId) {
  activeRequestId = requestId;
  renderList();
  const record = requestMap.get(requestId);
  if (record) {
    renderDetails(record);
  }
}

function renderSection(title, body) {
  const section = document.createElement("div");
  section.className = "details__section";
  section.innerHTML = `<div class="details__section-title">${title}</div>`;
  section.appendChild(body);
  return section;
}

function createFieldRow(key, value, withLink) {
  const row = document.createElement("div");
  row.className = withLink ? "details__field" : "details__field details__field--single";

  const keyEl = document.createElement("div");
  keyEl.className = "details__key";
  keyEl.textContent = key;

  const valueEl = document.createElement("div");
  valueEl.className = "details__value";
  valueEl.textContent = value || "-";

  row.appendChild(keyEl);
  row.appendChild(valueEl);

  if (withLink) {
    const linkEl = document.createElement("div");
    linkEl.className = "details__link";
    linkEl.textContent = "Open";
    linkEl.addEventListener("click", () => {
      openValueAsUrl(value, true);
    });
    row.appendChild(linkEl);
  }

  return row;
}

function openValueAsUrl(value, allowRelative) {
  if (!value) {
    return;
  }
  try {
    const url = allowRelative && currentTabId !== null
      ? new URL(value, requestMap.get(activeRequestId)?.url || undefined)
      : new URL(value);
    chrome.tabs.create({ url: url.toString() });
  } catch (error) {
    // Ignore invalid URLs
  }
}

function renderHeaders(headers, withLinks) {
  const container = document.createElement("div");
  if (!headers || headers.length === 0) {
    container.textContent = "No data.";
    return container;
  }
  headers.forEach((header) => {
    const row = createFieldRow(header.name, header.value || "", withLinks);
    container.appendChild(row);
  });
  return container;
}

function renderRequestBody(body) {
  const container = document.createElement("div");
  if (!body) {
    container.textContent = "No data.";
    return container;
  }
  
  let bodyText = "";
  if (body.text) {
    // Try to parse as JSON for pretty printing
    try {
      const parsed = JSON.parse(body.text);
      bodyText = JSON.stringify(parsed, null, 2);
    } catch (error) {
      bodyText = body.text;
    }
  } else if (body.raw) {
    bodyText = body.raw;
  } else {
    bodyText = JSON.stringify(body, null, 2);
  }
  
  const pre = document.createElement("pre");
  pre.textContent = bodyText;
  container.appendChild(pre);
  return container;
}

function renderDetails(record) {
  detailsBodyEl.innerHTML = "";
  detailsBodyEl.classList.remove("empty");

  const generalBody = document.createElement("div");
  generalBody.appendChild(createFieldRow("URL", record.url));
  generalBody.appendChild(createFieldRow("Method", record.method));
  generalBody.appendChild(createFieldRow("Type", record.type));
  generalBody.appendChild(createFieldRow("Time", formatTime(record.timeStamp)));
  generalBody.appendChild(createFieldRow("Initiator", record.initiator));
  generalBody.appendChild(createFieldRow("Status", record.statusCode ? String(record.statusCode) : "-"));
  generalBody.appendChild(createFieldRow("Status line", record.statusLine || "-"));
  generalBody.appendChild(createFieldRow("From cache", record.fromCache ? "Yes" : "No"));
  generalBody.appendChild(createFieldRow("IP", record.ip || "-"));
  generalBody.appendChild(createFieldRow("Completed", record.completed ? "Yes" : "No"));

  const requestHeadersBody = renderHeaders(record.requestHeaders, false);
  const responseHeadersBody = renderHeaders(record.responseHeaders, true);
  const requestBody = renderRequestBody(record.requestBody);
  const responseBody = renderRequestBody(record.responseBody);

  detailsBodyEl.appendChild(renderSection("General", generalBody));
  detailsBodyEl.appendChild(renderSection("Request headers", requestHeadersBody));
  detailsBodyEl.appendChild(renderSection("Request body", requestBody));
  detailsBodyEl.appendChild(renderSection("Response headers", responseHeadersBody));
  detailsBodyEl.appendChild(renderSection("Response body", responseBody));
}

function handleUpdate(record) {
  const existed = requestMap.has(record.id);
  requestMap.set(record.id, record);
  renderListItem(record, !existed);
  setEmptyState(requestMap.size === 0);
  if (record.id === activeRequestId) {
    renderDetails(record);
  }
}

function connectToBackground() {
  port = chrome.runtime.connect({ name: "popup" });
  port.onMessage.addListener((message) => {
    if (message.type === "init") {
      requestMap.clear();
      setStatus("");
      message.records.forEach((record) => requestMap.set(record.id, record));
      renderList();
      if (message.records.length > 0) {
        setActiveRequest(message.records[0].id);
      } else {
        detailsBodyEl.textContent = "Select a request to see all fields.";
        detailsBodyEl.classList.add("empty");
      }
    }
    if (message.type === "request_added" || message.type === "request_updated") {
      handleUpdate(message.record);
    }
    if (message.type === "cleared") {
      requestMap.clear();
      renderList();
      detailsBodyEl.textContent = "Select a request to see all fields.";
      detailsBodyEl.classList.add("empty");
    }
    if (message.type === "debugger_error") {
      setStatus(`Debugger error: ${message.message}`);
    }
    if (message.type === "debugger_ready") {
      setStatus("");
    }
    if (message.type === "tab_selected") {
      if (message.url) {
        setStatus(`Using tab: ${message.url}`);
      } else {
        setStatus("");
      }
    }
    if (message.type === "init_error") {
      setStatus(message.message || "Unable to select a web tab.");
    }
  });

  port.onDisconnect.addListener(() => {
    port = null;
  });
}

clearBtn.addEventListener("click", () => {
  if (port) {
    port.postMessage({ type: "clear" });
  }
});

setStatus("Connecting...");
connectToBackground();
port.postMessage({ type: "init_active" });

