const MAX_REQUESTS = 500;
const FILTER_URL = "https://copilot.microsoft.com/c/api/conversations";
const requestsByTab = new Map();
const requestIndexById = new Map();
const portsByTab = new Map();
const tabOrigins = new Map();
const debuggerTabs = new Set();
const debuggerAttachInFlight = new Map();
let lastActiveHttpTabId = null;

function shouldStoreRequest(url) {
  if (!url) {
    return false;
  }
  // Normalize URL for comparison - handle both absolute and relative URLs
  const normalizedUrl = url.toLowerCase().trim();
  const filterPattern = "/c/api/conversations";
  
  // Check if URL contains the filter pattern (works for both absolute and relative URLs)
  // This matches URLs like:
  // - https://copilot.microsoft.com/c/api/conversations?types=...
  // - /c/api/conversations?types=...
  // - copilot.microsoft.com/c/api/conversations?types=...
  if (normalizedUrl.includes(filterPattern)) {
    return true;
  }
  
  // Also check the full filter URL (case-insensitive)
  if (normalizedUrl.includes(FILTER_URL.toLowerCase())) {
    return true;
  }
  
  return false;
}

function getOrigin(value) {
  if (!value) {
    return "";
  }
  try {
    return new URL(value).origin;
  } catch (error) {
    return "";
  }
}

function isHttpUrl(url) {
  return Boolean(url) && (url.startsWith("http://") || url.startsWith("https://"));
}

function rememberActiveTab(tab) {
  if (!tab || !isHttpUrl(tab.url)) {
    return;
  }
  lastActiveHttpTabId = tab.id;
  const origin = getOrigin(tab.url);
  if (origin) {
    tabOrigins.set(tab.id, origin);
  }
}

function headersObjectToArray(headers) {
  if (!headers) {
    return [];
  }
  if (Array.isArray(headers)) {
    return headers;
  }
  return Object.entries(headers).map(([name, value]) => ({
    name,
    value: Array.isArray(value) ? value.join(", ") : String(value)
  }));
}

function ensureDebuggerAttached(tabId) {
  if (debuggerTabs.has(tabId)) {
    return Promise.resolve();
  }
  if (debuggerAttachInFlight.has(tabId)) {
    return debuggerAttachInFlight.get(tabId);
  }
  const attachPromise = new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        debuggerAttachInFlight.delete(tabId);
        reject(chrome.runtime.lastError);
        return;
      }
      chrome.debugger.sendCommand({ tabId }, "Network.enable", {}, () => {
        debuggerAttachInFlight.delete(tabId);
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        debuggerTabs.add(tabId);
        resolve();
      });
    });
  });
  debuggerAttachInFlight.set(tabId, attachPromise);
  return attachPromise;
}

function detachDebugger(tabId) {
  if (!debuggerTabs.has(tabId)) {
    return;
  }
  chrome.debugger.detach({ tabId }, () => {
    debuggerTabs.delete(tabId);
  });
}

function getTabRequests(tabId) {
  if (!requestsByTab.has(tabId)) {
    requestsByTab.set(tabId, []);
  }
  return requestsByTab.get(tabId);
}

function broadcastToTab(tabId, message) {
  const ports = portsByTab.get(tabId);
  if (!ports || ports.size === 0) {
    return;
  }
  ports.forEach((port) => {
    try {
      port.postMessage(message);
    } catch (error) {
      // Ignore disconnected ports
    }
  });
}

function trimRequests(tabId) {
  const list = getTabRequests(tabId);
  while (list.length > MAX_REQUESTS) {
    const removed = list.shift();
    if (removed) {
      requestIndexById.delete(removed.id);
    }
  }
}

function upsertRequest(tabId, requestId, update) {
  const key = `${tabId}:${requestId}`;
  const existing = requestIndexById.get(key);
  if (existing) {
    Object.assign(existing, update);
    return { record: existing, isNew: false };
  }
  const record = {
    id: requestId,
    tabId,
    url: update.url || "",
    method: update.method || "",
    type: update.type || "",
    timeStamp: update.timeStamp || Date.now(),
    initiator: update.initiator || "",
    requestHeaders: [],
    responseHeaders: [],
    requestBody: null,
    responseBody: null,
    statusCode: null,
    statusLine: "",
    fromCache: false,
    ip: "",
    completed: false,
    fromDebugger: update.fromDebugger || false
  };
  const list = getTabRequests(tabId);
  list.unshift(record);
  requestIndexById.set(key, record);
  trimRequests(tabId);
  return { record, isNew: true };
}

function storeRequest(tabId, requestId, update) {
  const key = `${tabId}:${requestId}`;
  const existing = requestIndexById.get(key);
  
  // For new requests, check if URL matches filter
  if (!existing) {
    const urlToCheck = update.url || "";
    if (!shouldStoreRequest(urlToCheck)) {
      // Log skipped URLs for debugging (only for conversations API to avoid spam)
      if (urlToCheck && urlToCheck.includes("conversations")) {
        console.log("Skipped request (doesn't match filter):", urlToCheck);
      }
      return;
    }
  } else {
    // For existing requests, check URL from existing record or update
    const urlToCheck = update.url || existing.url || "";
    if (!shouldStoreRequest(urlToCheck)) {
      // If URL doesn't match filter, remove the request
      const list = getTabRequests(tabId);
      const index = list.findIndex((r) => r.id === requestId);
      if (index !== -1) {
        list.splice(index, 1);
        requestIndexById.delete(key);
        broadcastToTab(tabId, { type: "request_removed", requestId });
      }
      return;
    }
  }
  
  const { record, isNew } = upsertRequest(tabId, requestId, update);
  broadcastToTab(tabId, {
    type: isNew ? "request_added" : "request_updated",
    record
  });
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Skip webRequest for filtered URLs - they will be captured by debugger API
    // This ensures we only capture them through debugger API to get response body
    if (shouldStoreRequest(details.url)) {
      return;
    }
    
    const update = {
      url: details.url,
      method: details.method,
      type: details.type,
      timeStamp: details.timeStamp,
      initiator: details.initiator,
      requestBody: details.requestBody || null
    };

    if (details.tabId === -1) {
      const origin = getOrigin(details.initiator || details.documentUrl);
      if (!origin) {
        return;
      }
      for (const [tabId, tabOrigin] of tabOrigins.entries()) {
        if (tabOrigin === origin) {
          storeRequest(tabId, details.requestId, update);
        }
      }
      return;
    }

    storeRequest(details.tabId, details.requestId, update);
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // Skip webRequest for filtered URLs - they will be captured by debugger API
    if (shouldStoreRequest(details.url)) {
      return;
    }
    
    if (details.tabId === -1) {
      const origin = getOrigin(details.initiator || details.documentUrl);
      if (!origin) {
        return;
      }
      for (const [tabId, tabOrigin] of tabOrigins.entries()) {
        if (tabOrigin === origin) {
          storeRequest(tabId, details.requestId, {
            requestHeaders: details.requestHeaders || []
          });
        }
      }
      return;
    }
    storeRequest(details.tabId, details.requestId, {
      requestHeaders: details.requestHeaders || []
    });
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    // Skip webRequest for filtered URLs - they will be captured by debugger API
    if (shouldStoreRequest(details.url)) {
      return;
    }
    
    if (details.tabId === -1) {
      const origin = getOrigin(details.initiator || details.documentUrl);
      if (!origin) {
        return;
      }
      for (const [tabId, tabOrigin] of tabOrigins.entries()) {
        if (tabOrigin === origin) {
          storeRequest(tabId, details.requestId, {
            responseHeaders: details.responseHeaders || [],
            statusLine: details.statusLine || ""
          });
        }
      }
      return;
    }
    storeRequest(details.tabId, details.requestId, {
      responseHeaders: details.responseHeaders || [],
      statusLine: details.statusLine || ""
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    // Skip webRequest for filtered URLs - they will be captured by debugger API
    if (shouldStoreRequest(details.url)) {
      return;
    }
    
    if (details.tabId === -1) {
      const origin = getOrigin(details.initiator || details.documentUrl);
      if (!origin) {
        return;
      }
      for (const [tabId, tabOrigin] of tabOrigins.entries()) {
        if (tabOrigin === origin) {
          storeRequest(tabId, details.requestId, {
            statusCode: details.statusCode,
            fromCache: details.fromCache,
            ip: details.ip || "",
            completed: true
          });
        }
      }
      return;
    }
    storeRequest(details.tabId, details.requestId, {
      statusCode: details.statusCode,
      fromCache: details.fromCache,
      ip: details.ip || "",
      completed: true
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const origin = getOrigin(changeInfo.url);
    if (origin) {
      tabOrigins.set(tabId, origin);
    }
    if (tab && tab.active && isHttpUrl(changeInfo.url)) {
      lastActiveHttpTabId = tabId;
    }
    // Auto-attach debugger for copilot.microsoft.com to catch early requests
    // This ensures we capture the first request even before popup is opened
    if (changeInfo.url && changeInfo.url.includes("copilot.microsoft.com") && changeInfo.status === "loading") {
      // Attach debugger early to catch the first request
      ensureDebuggerAttached(tabId).catch(() => {
        // Ignore errors - debugger might already be attached or tab might be closing
      });
    }
    return;
  }
  if (tab && tab.active) {
    rememberActiveTab(tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabOrigins.delete(tabId);
  if (lastActiveHttpTabId === tabId) {
    lastActiveHttpTabId = null;
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError) {
      return;
    }
    rememberActiveTab(tab);
  });
});

chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
  if (tabs && tabs[0]) {
    rememberActiveTab(tabs[0]);
  }
});

// On extension startup, attach debugger to any open copilot.microsoft.com tabs
chrome.tabs.query({ url: "*://copilot.microsoft.com/*" }, (tabs) => {
  if (tabs && tabs.length > 0) {
    tabs.forEach((tab) => {
      if (tab.id) {
        ensureDebuggerAttached(tab.id).catch(() => {
          // Ignore errors
        });
      }
    });
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") {
    return;
  }

  let currentTabId = null;

  function attachPort(tabId) {
    if (!portsByTab.has(tabId)) {
      portsByTab.set(tabId, new Set());
    }
    portsByTab.get(tabId).add(port);
  }

  function detachPort(tabId) {
    const ports = portsByTab.get(tabId);
    if (!ports) {
      return;
    }
    ports.delete(port);
    if (ports.size === 0) {
      portsByTab.delete(tabId);
    }
  }

  port.onMessage.addListener((message) => {
    if (message.type === "init") {
      currentTabId = message.tabId;
      attachPort(currentTabId);
      ensureDebuggerAttached(currentTabId)
        .then(() => {
          port.postMessage({ type: "debugger_ready" });
        })
        .catch((error) => {
          port.postMessage({
            type: "debugger_error",
            message: error && error.message ? error.message : "Debugger attach failed."
          });
        });
      const list = getTabRequests(currentTabId);
      port.postMessage({ type: "init", records: list });
    }

    if (message.type === "init_active") {
      const targetTabId = message.tabId || lastActiveHttpTabId;
      if (!targetTabId) {
        port.postMessage({
          type: "init_error",
          message: "Open a web page tab and try again."
        });
        return;
      }
      currentTabId = targetTabId;
      attachPort(currentTabId);
      chrome.tabs.get(currentTabId, (tab) => {
        if (chrome.runtime.lastError || !tab || !isHttpUrl(tab.url || "")) {
          port.postMessage({
            type: "init_error",
            message: "Open a normal web page tab to capture requests."
          });
          return;
        }
        port.postMessage({ type: "tab_selected", url: tab.url });
      });
      ensureDebuggerAttached(currentTabId)
        .then(() => {
          port.postMessage({ type: "debugger_ready" });
          // Try to get response body for any completed requests that might have been missed
          // This helps catch the first request that might have finished before debugger was ready
          setTimeout(() => {
            const list = getTabRequests(currentTabId);
            list.forEach((record) => {
              if (record.completed && !record.responseBody && record.fromDebugger) {
                // Try to get body for completed requests that don't have it yet
                chrome.debugger.sendCommand({ tabId: currentTabId }, "Network.getResponseBody", { requestId: record.id }, (response) => {
                  if (!chrome.runtime.lastError && response) {
                    let responseBody = null;
                    if (response.base64Encoded) {
                      try {
                        const text = atob(response.body);
                        responseBody = { text, base64Encoded: true };
                      } catch (error) {
                        responseBody = { raw: response.body, base64Encoded: true };
                      }
                    } else {
                      responseBody = { text: response.body, base64Encoded: false };
                    }
                    storeRequest(currentTabId, record.id, {
                      responseBody
                    });
                  }
                });
              }
            });
          }, 300);
        })
        .catch((error) => {
          port.postMessage({
            type: "debugger_error",
            message: error && error.message ? error.message : "Debugger attach failed."
          });
        });
      const list = getTabRequests(currentTabId);
      port.postMessage({ type: "init", records: list });
    }

    if (message.type === "clear" && currentTabId !== null) {
      requestsByTab.set(currentTabId, []);
      for (const key of requestIndexById.keys()) {
        if (key.startsWith(`${currentTabId}:`)) {
          requestIndexById.delete(key);
        }
      }
      broadcastToTab(currentTabId, { type: "cleared" });
    }
  });

  port.onDisconnect.addListener(() => {
    if (currentTabId !== null) {
      detachPort(currentTabId);
      if (!portsByTab.has(currentTabId)) {
        detachDebugger(currentTabId);
      }
    }
  });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) {
    return;
  }
  const tabId = source.tabId;

  switch (method) {
    case "Network.requestWillBeSent": {
      const request = params.request || {};
      const initiator = params.initiator && params.initiator.url ? params.initiator.url : "";
      storeRequest(tabId, params.requestId, {
        url: request.url || "",
        method: request.method || "",
        type: params.type || "",
        timeStamp: params.timestamp ? params.timestamp * 1000 : Date.now(),
        initiator,
        requestHeaders: headersObjectToArray(request.headers || {}),
        requestBody: request.postData ? { raw: request.postData } : null,
        fromDebugger: true
      });
      break;
    }
    case "Network.requestWillBeSentExtraInfo": {
      storeRequest(tabId, params.requestId, {
        requestHeaders: headersObjectToArray(params.headers || {})
      });
      break;
    }
    case "Network.responseReceived": {
      const response = params.response || {};
      storeRequest(tabId, params.requestId, {
        responseHeaders: headersObjectToArray(response.headers || {}),
        statusCode: response.status || null,
        statusLine: response.statusText || "",
        type: params.type || ""
      });
      // Try to get response body early if it's available
      // Some responses may be available immediately
      if (response.status >= 200 && response.status < 300) {
        setTimeout(() => {
          chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId: params.requestId }, (bodyResponse) => {
            if (!chrome.runtime.lastError && bodyResponse) {
              let responseBody = null;
              if (bodyResponse.base64Encoded) {
                try {
                  const text = atob(bodyResponse.body);
                  responseBody = { text, base64Encoded: true };
                } catch (error) {
                  responseBody = { raw: bodyResponse.body, base64Encoded: true };
                }
              } else {
                responseBody = { text: bodyResponse.body, base64Encoded: false };
              }
              storeRequest(tabId, params.requestId, {
                responseBody
              });
            }
          });
        }, 50);
      }
      break;
    }
    case "Network.responseReceivedExtraInfo": {
      storeRequest(tabId, params.requestId, {
        responseHeaders: headersObjectToArray(params.headers || {})
      });
      break;
    }
    case "Network.loadingFinished": {
      // Check if this request came from debugger (only those can have response body retrieved)
      const key = `${tabId}:${params.requestId}`;
      const existing = requestIndexById.get(key);
      const isFromDebugger = existing ? existing.fromDebugger : false;
      
      storeRequest(tabId, params.requestId, {
        completed: true
      });
      
      // Only try to get response body for requests that came through debugger API
      if (isFromDebugger) {
        // Get response body - try with multiple attempts
        function processResponseBody(response) {
          if (!response || !response.body) {
            return;
          }
          let responseBody = null;
          if (response.base64Encoded) {
            try {
              const text = atob(response.body);
              responseBody = { text, base64Encoded: true };
            } catch (error) {
              responseBody = { raw: response.body, base64Encoded: true };
            }
          } else {
            responseBody = { text: response.body, base64Encoded: false };
          }
          storeRequest(tabId, params.requestId, {
            responseBody
          });
        }
        
        function fetchResponseBody(attempt = 0) {
          chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId: params.requestId }, (response) => {
            if (chrome.runtime.lastError) {
              const errorMsg = chrome.runtime.lastError.message || "";
              // Retry up to 5 times with increasing delays (first request might need more time)
              if (attempt < 5 && (errorMsg.includes("No resource") || errorMsg.includes("not found") || errorMsg.includes("No data") || errorMsg.includes("No such"))) {
                setTimeout(() => {
                  fetchResponseBody(attempt + 1);
                }, 150 * (attempt + 1));
              }
              return;
            }
            if (response) {
              processResponseBody(response);
            }
          });
        }
        
        // Try with initial delay to ensure response is fully loaded, then with retries if needed
        // Use longer delay for first attempt to ensure response is ready
        setTimeout(() => {
          fetchResponseBody();
        }, 100);
      }
      break;
    }
    case "Network.loadingFailed": {
      storeRequest(tabId, params.requestId, {
        completed: true
      });
      break;
    }
    default:
      break;
  }
});


