const MAX_REQUESTS = 500;
const FILTER_URL = "https://copilot.microsoft.com/c/api/conversations";
const requestsByTab = new Map();
const requestIndexById = new Map();
const portsByTab = new Map();
const tabOrigins = new Map();
const debuggerTabs = new Set();
const debuggerAttachInFlight = new Map();
let lastActiveHttpTabId = null;
let isIndexingActive = false; // Флаг активной индексации
let shouldStopIndexing = false; // Флаг для остановки индексации

function shouldStoreRequest(url) {
  if (!url) {
    return false;
  }
  // Normalize URL for comparison - handle both absolute and relative URLs
  const normalizedUrl = url.toLowerCase().trim();
  const filterPattern = "/c/api/conversations";
  const historyPattern = "history?api-version=2";
  
  // Check if URL contains the filter pattern (works for both absolute and relative URLs)
  // This matches URLs like:
  // - https://copilot.microsoft.com/c/api/conversations?types=...
  // - /c/api/conversations?types=...
  // - copilot.microsoft.com/c/api/conversations?types=...
  if (normalizedUrl.includes(filterPattern)) {
    return true;
  }
  
  // Check for history API requests
  if (normalizedUrl.includes(historyPattern)) {
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
  // Не сохраняем новые запросы во время активной индексации
  const key = `${tabId}:${requestId}`;
  const existing = requestIndexById.get(key);
  
  // Если идет индексация и это новый запрос (не обновление существующего), пропускаем его
  if (isIndexingActive && !existing) {
    return;
  }
  
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

// ========== IndexedDB Functions (inline for service worker) ==========
const DB_NAME = 'copilot_indexer';
const DB_VERSION = 1;

let dbInstance = null;

async function initDB() {
  if (dbInstance) return dbInstance;
  
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('accounts')) {
        const accountsStore = db.createObjectStore('accounts', { keyPath: 'email' });
        accountsStore.createIndex('email', 'email', { unique: true });
      }
      if (!db.objectStoreNames.contains('chats')) {
        const chatsStore = db.createObjectStore('chats', { keyPath: 'chatId' });
        chatsStore.createIndex('accountEmail', 'accountEmail', { unique: false });
        chatsStore.createIndex('lastIndexedUTC', 'lastIndexedUTC', { unique: false });
      }
      if (!db.objectStoreNames.contains('messages')) {
        const messagesStore = db.createObjectStore('messages', { keyPath: 'id' });
        messagesStore.createIndex('chatId', 'chatId', { unique: false });
      }
      if (!db.objectStoreNames.contains('indexes')) {
        db.createObjectStore('indexes', { keyPath: 'accountEmail' });
      }
    };
  });
}

function toUTCString(date = new Date()) {
  return date.toISOString();
}

async function getAccount(email) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['accounts'], 'readonly');
    const store = transaction.objectStore('accounts');
    const request = store.get(email);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAllAccounts() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['accounts'], 'readonly');
    const store = transaction.objectStore('accounts');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function createAccount(email, data = {}) {
  const db = await initDB();
  const account = {
    email,
    lastIndexedUTC: null,
    createdAtUTC: toUTCString(),
    ...data
  };
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['accounts'], 'readwrite');
    const store = transaction.objectStore('accounts');
    const request = store.put(account);
    request.onsuccess = () => resolve(account);
    request.onerror = () => reject(request.error);
  });
}

async function createChat(chatData) {
  const db = await initDB();
  const chat = {
    chatId: chatData.chatId,
    accountEmail: chatData.accountEmail,
    title: chatData.title || '',
    url: chatData.url || `https://copilot.microsoft.com/chats/${chatData.chatId}`,
    updatedAtUTC: chatData.updatedAtUTC || toUTCString(),
    lastIndexedUTC: chatData.lastIndexedUTC || null
  };
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['chats'], 'readwrite');
    const store = transaction.objectStore('chats');
    const request = store.put(chat);
    request.onsuccess = () => resolve(chat);
    request.onerror = () => reject(request.error);
  });
}

async function getChatsByAccount(accountEmail) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['chats'], 'readonly');
    const store = transaction.objectStore('chats');
    const index = store.index('accountEmail');
    const request = index.getAll(accountEmail);
    request.onsuccess = () => {
      const chats = request.result || [];
      // Дедупликация по chatId (на случай, если есть дубликаты)
      const uniqueChats = new Map();
      for (const chat of chats) {
        if (chat.chatId && !uniqueChats.has(chat.chatId)) {
          uniqueChats.set(chat.chatId, chat);
        }
      }
      resolve(Array.from(uniqueChats.values()));
    };
    request.onerror = () => reject(request.error);
  });
}

async function updateChat(chatId, updates) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['chats'], 'readwrite');
    const store = transaction.objectStore('chats');
    const getRequest = store.get(chatId);
    getRequest.onsuccess = () => {
      const chat = getRequest.result;
      if (!chat) {
        reject(new Error(`Chat ${chatId} not found`));
        return;
      }
      const updated = { ...chat, ...updates };
      const putRequest = store.put(updated);
      putRequest.onsuccess = () => resolve(updated);
      putRequest.onerror = () => reject(putRequest.error);
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
}

async function createMessage(messageData) {
  const db = await initDB();
  const message = {
    id: messageData.id || `${messageData.chatId}_${Date.now()}_${Math.random()}`,
    chatId: messageData.chatId,
    role: messageData.role || 'user',
    text: messageData.text || '',
    timestampUTC: messageData.timestampUTC || toUTCString()
  };
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['messages'], 'readwrite');
    const store = transaction.objectStore('messages');
    const request = store.put(message);
    request.onsuccess = () => resolve(message);
    request.onerror = () => reject(request.error);
  });
}

// Батчинг для сохранения множества сообщений одной транзакцией
async function createMessagesBatch(messages) {
  if (!messages || messages.length === 0) {
    return;
  }
  
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['messages'], 'readwrite');
    const store = transaction.objectStore('messages');
    let completed = 0;
    let hasError = false;
    
    for (const msg of messages) {
      const message = {
        id: msg.id || `${msg.chatId}_${Date.now()}_${Math.random()}`,
        chatId: msg.chatId,
        role: msg.role || 'user',
        text: msg.text || '',
        timestampUTC: msg.timestampUTC || toUTCString()
      };
      
      const request = store.put(message);
      request.onsuccess = () => {
        completed++;
        if (completed === messages.length && !hasError) {
          resolve();
        }
      };
      request.onerror = () => {
        if (!hasError) {
          hasError = true;
          reject(request.error);
        }
      };
    }
    
    // Если массив пустой после фильтрации
    if (messages.length === 0) {
      resolve();
    }
  });
}

async function getMessagesByChat(chatId) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['messages'], 'readonly');
    const store = transaction.objectStore('messages');
    const index = store.index('chatId');
    const request = index.getAll(chatId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function deleteMessagesByChat(chatId) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['messages'], 'readwrite');
    const store = transaction.objectStore('messages');
    const index = store.index('chatId');
    const request = index.openCursor(IDBKeyRange.only(chatId));
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    request.onerror = () => reject(request.error);
  });
}

async function saveIndex(accountEmail, indexData) {
  const db = await initDB();
  const indexRecord = {
    accountEmail,
    flexIndexJSON: indexData,
    updatedAtUTC: toUTCString()
  };
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['indexes'], 'readwrite');
    const store = transaction.objectStore('indexes');
    const request = store.put(indexRecord);
    request.onsuccess = () => resolve(indexRecord);
    request.onerror = () => reject(request.error);
  });
}

async function getIndex(accountEmail) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['indexes'], 'readonly');
    const store = transaction.objectStore('indexes');
    const request = store.get(accountEmail);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ========== JWT Decoding ==========
function decodeJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      console.log('decodeJWT: Invalid token format, parts count:', parts.length);
      return null;
    }
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    const payload = JSON.parse(atob(base64));
    console.log('decodeJWT: Decoded payload keys:', Object.keys(payload));
    return payload;
  } catch (error) {
    console.error('decodeJWT: Error decoding token:', error);
    return null;
  }
}

function extractEmailFromRequest(record) {
  if (!record.requestHeaders) {
    console.log('extractEmailFromRequest: No request headers');
    return null;
  }
  
  console.log('extractEmailFromRequest: Checking headers, count:', record.requestHeaders.length);
  
  for (const header of record.requestHeaders) {
    const name = (header.name || '').toLowerCase();
    const value = header.value || '';
    
    if (name === 'authorization' && value.startsWith('Bearer ')) {
      const token = value.substring(7).trim();
      console.log('extractEmailFromRequest: Found Bearer token, length:', token.length);
      const payload = decodeJWT(token);
      if (payload) {
        // Пробуем разные поля, которые могут содержать email
        const email = payload.email || 
                     payload.upn || 
                     payload.unique_name || 
                     payload.preferred_username ||
                     payload.oid || // Object ID (может использоваться как идентификатор)
                     payload.sub || // Subject
                     payload.name ||
                     payload.aud; // Audience (может содержать email)
        
        // Если нашли что-то похожее на email
        if (email && typeof email === 'string' && email.includes('@')) {
          console.log('extractEmailFromRequest: Decoded JWT, found email:', email, 'payload keys:', Object.keys(payload));
          return email;
        } else {
          console.log('extractEmailFromRequest: JWT decoded but no email found. Payload:', JSON.stringify(payload).substring(0, 500));
        }
      } else {
        console.log('extractEmailFromRequest: Failed to decode JWT');
      }
    }
  }
  
  console.log('extractEmailFromRequest: No email found in headers');
  return null;
}

// ========== Chat Parsing ==========
async function parseChatsFromResponse(responseBody, accountEmail) {
  if (!responseBody || !responseBody.text) {
    console.log('parseChatsFromResponse: No response body or text');
    return;
  }
  
  try {
    const data = JSON.parse(responseBody.text);
    
    // Логируем структуру ответа для отладки
    console.log('parseChatsFromResponse: Response structure:', {
      isArray: Array.isArray(data),
      hasValue: !!data.value,
      hasItems: !!data.items,
      hasConversations: !!data.conversations,
      keys: !Array.isArray(data) ? Object.keys(data) : [],
      dataPreview: JSON.stringify(data).substring(0, 200)
    });
    
    // Структура ответа может быть разной, пробуем разные варианты
    let chats = [];
    
    if (Array.isArray(data)) {
      chats = data;
      console.log('parseChatsFromResponse: Using direct array, length:', chats.length);
    } else if (data.value && Array.isArray(data.value)) {
      chats = data.value;
      console.log('parseChatsFromResponse: Using data.value, length:', chats.length);
    } else if (data.items && Array.isArray(data.items)) {
      chats = data.items;
      console.log('parseChatsFromResponse: Using data.items, length:', chats.length);
    } else if (data.conversations && Array.isArray(data.conversations)) {
      chats = data.conversations;
      console.log('parseChatsFromResponse: Using data.conversations, length:', chats.length);
    } else if (data.data && Array.isArray(data.data)) {
      chats = data.data;
      console.log('parseChatsFromResponse: Using data.data, length:', chats.length);
    } else if (data.results && Array.isArray(data.results)) {
      chats = data.results;
      console.log('parseChatsFromResponse: Using data.results, length:', chats.length);
      
      // Проверяем на пустой ответ истории чата (results пустой и next null)
      // Это нормальная ситуация для пустых чатов, просто пропускаем
      if (chats.length === 0 && (data.next === null || data.next === undefined)) {
        console.log('parseChatsFromResponse: Empty history response (results: [], next: null), skipping');
        return;
      }
    } else {
      // Если структура не распознана, логируем полный ответ для анализа
      console.warn('parseChatsFromResponse: Unknown response structure:', {
        type: typeof data,
        keys: Object.keys(data || {}),
        sample: JSON.stringify(data).substring(0, 1000)
      });
    }
    
    console.log(`parseChatsFromResponse: Found ${chats.length} chats for account ${accountEmail}`);
    
    if (chats.length === 0) {
      // Для запросов истории чата это нормально, просто логируем и выходим
      console.log('parseChatsFromResponse: No chats found in response, skipping processing');
      return;
    }
    
    // Получаем существующие чаты для аккаунта, чтобы избежать дубликатов
    const existingChats = await getChatsByAccount(accountEmail);
    const existingChatIds = new Set(existingChats.map(c => c.chatId));
    
    let savedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    for (const chat of chats) {
      // Извлекаем данные чата (структура может отличаться)
      const chatId = chat.id || chat.chatId || chat.conversationId || chat.conversation_id || chat.conversationId;
      const title = chat.title || chat.name || chat.displayName || chat.subject || '';
      const updatedAt = chat.updatedAt || chat.updated_at || chat.lastModified || chat.modifiedTime || chat.updatedDateTime;
      
      if (!chatId) {
        console.log('parseChatsFromResponse: Skipping chat without ID:', {
          chatKeys: Object.keys(chat),
          chatSample: JSON.stringify(chat).substring(0, 200)
        });
        skippedCount++;
        continue;
      }
      
      // Пропускаем чаты с пустым title или с title "Без названия"
      const hasTitle = title && title.trim() && title.trim() !== 'Без названия';
      if (!hasTitle) {
        console.log(`parseChatsFromResponse: Skipping chat ${chatId} - no title or title is "Без названия"`);
        skippedCount++;
        continue;
      }
      
      // Преобразуем время в UTC строку
      let updatedAtUTC = toUTCString();
      if (updatedAt) {
        try {
          updatedAtUTC = toUTCString(new Date(updatedAt));
        } catch (e) {
          console.warn('parseChatsFromResponse: Failed to parse date:', updatedAt, e);
          // Используем текущее время
        }
      }
      
      try {
        // Проверяем, существует ли чат в БД
        const existingChat = existingChatIds.has(chatId) 
          ? existingChats.find(c => c.chatId === chatId)
          : null;
        
        if (existingChat) {
          // Чат существует - обновляем только если данные изменились
          const needsUpdate = existingChat.title !== title || 
                             existingChat.updatedAtUTC !== updatedAtUTC ||
                             existingChat.accountEmail !== accountEmail;
          
          if (needsUpdate) {
            await updateChat(chatId, {
              title,
              updatedAtUTC,
              accountEmail
            });
            updatedCount++;
          }
          // Если данные не изменились, пропускаем
        } else {
          // Чат новый - создаем
      await createChat({
        chatId,
        accountEmail,
        title,
        updatedAtUTC,
        url: `https://copilot.microsoft.com/chats/${chatId}`
      });
      savedCount++;
          // Добавляем в множество существующих, чтобы не обрабатывать повторно в этом цикле
          existingChatIds.add(chatId);
        }
      } catch (error) {
        console.error(`parseChatsFromResponse: Error saving chat ${chatId}:`, error);
      }
    }
    
    console.log(`parseChatsFromResponse: Saved ${savedCount} new chats, updated ${updatedCount} existing chats, skipped ${skippedCount} for account ${accountEmail}`);
  } catch (error) {
    console.error('Error parsing chats:', error);
    console.error('Response body preview:', responseBody.text?.substring(0, 1000));
    throw error; // Пробрасываем ошибку дальше для лучшей диагностики
  }
}

// ========== Process Conversations Response ==========
async function processConversationsResponse(tabId, requestId) {
  const key = `${tabId}:${requestId}`;
  const record = requestIndexById.get(key);
  
  // Проверяем, не обработан ли уже этот запрос
  if (record && record.conversationsProcessed) {
    console.log('processConversationsResponse: Request already processed, skipping', {
      tabId,
      requestId,
      url: record.url
    });
    return;
  }
  
  console.log('processConversationsResponse: Starting processing', {
    tabId,
    requestId,
    hasRecord: !!record,
    hasResponseBody: !!(record && record.responseBody),
    hasText: !!(record && record.responseBody && record.responseBody.text),
    url: record?.url
  });
  
  if (!record || !record.responseBody || !record.responseBody.text) {
    console.log('processConversationsResponse: No record or response body', {
      hasRecord: !!record,
      hasResponseBody: !!(record && record.responseBody),
      hasText: !!(record && record.responseBody && record.responseBody.text)
    });
    return;
  }
  
  // Извлекаем email из запроса
  let accountEmail = extractEmailFromRequest(record);
  console.log('processConversationsResponse: Email from request headers:', accountEmail);
  
  // Если не нашли в заголовках, пробуем получить из storage
  if (!accountEmail) {
    try {
      const stored = await chrome.storage.local.get(['copilotAccountEmail']);
      accountEmail = stored.copilotAccountEmail;
      console.log('processConversationsResponse: Email from storage:', accountEmail);
    } catch (e) {
      console.error('processConversationsResponse: Error getting email from storage:', e);
    }
  }
  
  // Если все еще не нашли, пробуем получить из content script
  if (!accountEmail) {
    try {
      const tabs = await chrome.tabs.query({ url: "*://copilot.microsoft.com/*" });
      if (tabs.length > 0) {
        const response = await chrome.tabs.sendMessage(tabs[0].id, { action: 'getAccountInfo' });
        if (response && response.success && response.email) {
          accountEmail = response.email;
          // Сохраняем в storage для будущего использования
          await chrome.storage.local.set({ copilotAccountEmail: accountEmail });
          console.log('processConversationsResponse: Email from content script:', accountEmail);
        }
      }
    } catch (e) {
      console.error('processConversationsResponse: Error getting email from content script:', e);
    }
  }
  
  if (!accountEmail) {
    console.warn('processConversationsResponse: Account email not found, skipping chat parsing. Response body length:', record.responseBody.text?.length);
    // Логируем структуру ответа для анализа
    try {
      const data = JSON.parse(record.responseBody.text);
      console.warn('processConversationsResponse: Response structure (for debugging):', {
        isArray: Array.isArray(data),
        keys: !Array.isArray(data) ? Object.keys(data) : [],
        preview: JSON.stringify(data).substring(0, 500)
      });
    } catch (e) {
      console.warn('processConversationsResponse: Could not parse response as JSON');
    }
    return;
  }
  
  // Проверяем, является ли это запросом истории чата (history?api-version=2)
  const isHistoryRequest = record.url && record.url.includes('/history?api-version=2');
  
  if (isHistoryRequest) {
    try {
      const data = JSON.parse(record.responseBody.text);
      
      // Проверяем на пустой ответ истории чата
      // Если results пустой массив и next null, пропускаем обработку и удаляем из списка запросов
      if (data.results && Array.isArray(data.results) && data.results.length === 0 && 
          (data.next === null || data.next === undefined)) {
        console.log('processConversationsResponse: Skipping empty history response', {
          url: record.url,
          resultsLength: data.results.length,
          next: data.next
        });
        
        // Помечаем запрос как обработанный перед удалением
        storeRequest(tabId, requestId, {
          conversationsProcessed: true
        });
        
        // Удаляем пустой запрос из списка запросов
        const list = getTabRequests(tabId);
        const index = list.findIndex((r) => r.id === requestId);
        if (index !== -1) {
          list.splice(index, 1);
          requestIndexById.delete(key);
          console.log('processConversationsResponse: Removed empty history request from list');
        }
        
        return;
      }
      
      // Если results не пустой, продолжаем обработку
      if (data.results && Array.isArray(data.results) && data.results.length > 0) {
        console.log('processConversationsResponse: History response has data', {
          url: record.url,
          resultsLength: data.results.length,
          next: data.next
        });
      }
    } catch (parseError) {
      // Если не удалось распарсить JSON, продолжаем обычную обработку
      console.warn('processConversationsResponse: Could not parse response to check for empty history:', parseError);
    }
  }
  
  // Создаем или обновляем аккаунт
  try {
  await createAccount(accountEmail);
  console.log('processConversationsResponse: Account created/updated:', accountEmail);
  } catch (error) {
    console.error('processConversationsResponse: Error creating account:', error);
  }
  
  // Парсим чаты
  try {
  await parseChatsFromResponse(record.responseBody, accountEmail);
    console.log('processConversationsResponse: Successfully processed conversations response');
  } catch (error) {
    console.error('processConversationsResponse: Error parsing chats:', error);
    // Не пробрасываем ошибку дальше, чтобы не прерывать другие процессы
  }
}

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
      const key = `${tabId}:${params.requestId}`;
      const existing = requestIndexById.get(key);
      const requestUrl = existing ? existing.url : (response.url || '');
      const isConversationsRequest = requestUrl && shouldStoreRequest(requestUrl);
      
      storeRequest(tabId, params.requestId, {
        responseHeaders: headersObjectToArray(response.headers || {}),
        statusCode: response.status || null,
        statusLine: response.statusText || "",
        type: params.type || ""
      });
      // Не получаем body здесь - дождемся Network.loadingFinished, когда body точно готов
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
      const url = existing ? existing.url : '';
      
      storeRequest(tabId, params.requestId, {
        completed: true
      });
      
      // Check if this is a conversations API request - we need to process it
      const isConversationsRequest = url && shouldStoreRequest(url);
      
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
          
          // Если это запрос к conversations API, обрабатываем после успешного получения body
          // Это единственное место обработки - когда body точно готов
          if (isConversationsRequest) {
            // Небольшая задержка, чтобы убедиться, что responseBody сохранен в storeRequest
            setTimeout(() => {
              processConversationsResponse(tabId, params.requestId).catch(err => {
                console.error('Error processing conversations response:', err);
              });
            }, 150);
          }
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
              } else {
                // Если после всех попыток не удалось получить body, пропускаем обработку
                console.warn('processConversationsResponse: Could not get response body after all attempts, skipping');
              }
              return;
            }
            if (response) {
              processResponseBody(response);
            }
          });
        }
        
        // Try with initial delay to ensure response is fully loaded, then with retries if needed
        setTimeout(() => {
          fetchResponseBody();
        }, 100);
      }
      // Для не-debugger запросов body получить нельзя, поэтому не обрабатываем
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


// ========== Additional DB Functions ==========
async function getChat(chatId) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['chats'], 'readonly');
    const store = transaction.objectStore('chats');
    const request = store.get(chatId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getChatsByAccount(accountEmail) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['chats'], 'readonly');
    const store = transaction.objectStore('chats');
    const index = store.index('accountEmail');
    const request = index.getAll(accountEmail);
    request.onsuccess = () => {
      const chats = request.result || [];
      // Дедупликация по chatId (на случай, если есть дубликаты)
      const uniqueChats = new Map();
      for (const chat of chats) {
        if (chat.chatId && !uniqueChats.has(chat.chatId)) {
          uniqueChats.set(chat.chatId, chat);
        }
      }
      resolve(Array.from(uniqueChats.values()));
    };
    request.onerror = () => reject(request.error);
  });
}

async function updateChat(chatId, updates) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['chats'], 'readwrite');
    const store = transaction.objectStore('chats');
    const getRequest = store.get(chatId);
    getRequest.onsuccess = () => {
      const chat = getRequest.result;
      if (!chat) {
        reject(new Error(`Chat ${chatId} not found`));
        return;
      }
      const updated = { ...chat, ...updates };
      const putRequest = store.put(updated);
      putRequest.onsuccess = () => resolve(updated);
      putRequest.onerror = () => reject(putRequest.error);
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
}

async function deleteMessagesByChat(chatId) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['messages'], 'readwrite');
    const store = transaction.objectStore('messages');
    const index = store.index('chatId');
    const request = index.openCursor(IDBKeyRange.only(chatId));
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    request.onerror = () => reject(request.error);
  });
}

async function updateAccount(email, updates) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['accounts'], 'readwrite');
    const store = transaction.objectStore('accounts');
    const getRequest = store.get(email);
    getRequest.onsuccess = () => {
      const account = getRequest.result || { email, createdAtUTC: toUTCString() };
      const updated = { ...account, ...updates };
      const putRequest = store.put(updated);
      putRequest.onsuccess = () => resolve(updated);
      putRequest.onerror = () => reject(putRequest.error);
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
}

async function saveIndex(accountEmail, indexData) {
  const db = await initDB();
  const indexRecord = {
    accountEmail,
    flexIndexJSON: indexData,
    updatedAtUTC: toUTCString()
  };
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['indexes'], 'readwrite');
    const store = transaction.objectStore('indexes');
    const request = store.put(indexRecord);
    request.onsuccess = () => resolve(indexRecord);
    request.onerror = () => reject(request.error);
  });
}

async function getIndex(accountEmail) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['indexes'], 'readonly');
    const store = transaction.objectStore('indexes');
    const request = store.get(accountEmail);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ========== Simple Full-Text Search Index (no external dependencies) ==========
class SimpleSearchIndex {
  constructor() {
    // Map: term -> Set of document IDs
    this.termIndex = new Map();
    // Map: document ID -> document data
    this.documents = new Map();
  }
  
  // Tokenize text into searchable terms
  tokenize(text) {
    if (!text) return [];
    // Convert to lowercase, split by non-word characters, filter empty
    return text.toLowerCase()
      .replace(/[^\w\s\u0400-\u04FF]/g, ' ') // Support Cyrillic
      .split(/\s+/)
      .filter(term => term.length >= 2); // Minimum 2 characters
  }
  
  // Add or update document
  add(doc) {
    const docId = doc.id;
    const searchableText = `${doc.title || ''} ${doc.text || ''}`.trim().toLowerCase();
    
    // Remove old terms for this document
    if (this.documents.has(docId)) {
      const oldDoc = this.documents.get(docId);
      const oldText = `${oldDoc.title || ''} ${oldDoc.text || ''}`.trim().toLowerCase();
      const oldTerms = this.tokenize(oldText);
      for (const term of oldTerms) {
        const docSet = this.termIndex.get(term);
        if (docSet) {
          docSet.delete(docId);
          if (docSet.size === 0) {
            this.termIndex.delete(term);
          }
        }
      }
    }
    
    // Add document
    this.documents.set(docId, doc);
    
    // Index terms
    const terms = this.tokenize(searchableText);
    for (const term of terms) {
      if (!this.termIndex.has(term)) {
        this.termIndex.set(term, new Set());
      }
      this.termIndex.get(term).add(docId);
    }
  }
  
  // Remove document
  remove(docId) {
    if (!this.documents.has(docId)) return;
    
    const doc = this.documents.get(docId);
    const searchableText = `${doc.title || ''} ${doc.text || ''}`.trim().toLowerCase();
    const terms = this.tokenize(searchableText);
    
    for (const term of terms) {
      const docSet = this.termIndex.get(term);
      if (docSet) {
        docSet.delete(docId);
        if (docSet.size === 0) {
          this.termIndex.delete(term);
        }
      }
    }
    
    this.documents.delete(docId);
  }
  
  // Remove all documents for a specific chat (except chat title document)
  removeByChatId(chatId) {
    const docIdsToRemove = [];
    
    // Находим все документы для этого чата (кроме документа с названием чата)
    for (const [docId, doc] of this.documents.entries()) {
      if (doc.chatId === chatId && docId !== `chat_${chatId}`) {
        docIdsToRemove.push(docId);
      }
    }
    
    // Удаляем найденные документы
    for (const docId of docIdsToRemove) {
      this.remove(docId);
    }
    
    return docIdsToRemove.length;
  }
  
  // Search for query with partial word matching
  search(query, options = {}) {
    const { limit = 100, enrich = false } = options;
    if (!query || query.trim().length < 2) {
      return enrich ? [] : [];
    }
    
    const queryLower = query.toLowerCase().trim();
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) {
      return enrich ? [] : [];
    }
    
    // Find documents that match all terms (AND search)
    // Support partial word matching: if query is "прим", find "пример", "примерочная", "примерно"
    const docScores = new Map();
    const docMatchDetails = new Map(); // Store match details for scoring
    const docMatchedTerms = new Map(); // Track which query terms matched for each document
    
    for (const queryTerm of queryTerms) {
      let termMatched = false; // Track if this query term matched any document
      
      // First, try exact match
      const exactMatch = this.termIndex.get(queryTerm);
      if (exactMatch) {
        termMatched = true;
        for (const docId of exactMatch) {
          if (!docScores.has(docId)) {
            docScores.set(docId, 0);
            docMatchDetails.set(docId, { exact: 0, prefix: 0, contains: 0 });
            docMatchedTerms.set(docId, new Set());
          }
          const doc = this.documents.get(docId);
          // Повышенный вес для совпадений в названиях чатов
          const isTitleMatch = doc && doc.title && doc.title.toLowerCase().includes(queryTerm);
          const isChatTitleDoc = doc && doc.isChatTitle;
          const baseScore = isChatTitleDoc ? 5 : (isTitleMatch ? 4 : 3); // Chat title gets highest, title match gets higher
          docScores.set(docId, docScores.get(docId) + baseScore);
          docMatchDetails.get(docId).exact++;
          docMatchedTerms.get(docId).add(queryTerm);
        }
      }
      
      // Then, find all terms that start with the query term (prefix match)
      for (const [indexedTerm, docSet] of this.termIndex.entries()) {
        if (indexedTerm.startsWith(queryTerm) && indexedTerm !== queryTerm) {
          termMatched = true;
          for (const docId of docSet) {
            if (!docScores.has(docId)) {
              docScores.set(docId, 0);
              docMatchDetails.set(docId, { exact: 0, prefix: 0, contains: 0 });
              docMatchedTerms.set(docId, new Set());
            }
            // Only add score if this query term hasn't matched this document yet
            if (!docMatchedTerms.get(docId).has(queryTerm)) {
              const doc = this.documents.get(docId);
              // Повышенный вес для совпадений в названиях чатов
              const isTitleMatch = doc && doc.title && doc.title.toLowerCase().includes(queryTerm);
              const isChatTitleDoc = doc && doc.isChatTitle;
              const baseScore = isChatTitleDoc ? 4 : (isTitleMatch ? 3 : 2); // Chat title gets higher, title match gets medium
              docScores.set(docId, docScores.get(docId) + baseScore);
              docMatchedTerms.get(docId).add(queryTerm);
            }
            docMatchDetails.get(docId).prefix++;
          }
        }
        // Also check if indexed term contains the query term (substring match)
        else if (indexedTerm.includes(queryTerm) && indexedTerm !== queryTerm && !indexedTerm.startsWith(queryTerm)) {
          termMatched = true;
          for (const docId of docSet) {
            if (!docScores.has(docId)) {
              docScores.set(docId, 0);
              docMatchDetails.set(docId, { exact: 0, prefix: 0, contains: 0 });
              docMatchedTerms.set(docId, new Set());
            }
            // Only add score if this query term hasn't matched this document yet
            if (!docMatchedTerms.get(docId).has(queryTerm)) {
              const doc = this.documents.get(docId);
              // Повышенный вес для совпадений в названиях чатов
              const isTitleMatch = doc && doc.title && doc.title.toLowerCase().includes(queryTerm);
              const isChatTitleDoc = doc && doc.isChatTitle;
              const baseScore = isChatTitleDoc ? 3 : (isTitleMatch ? 2 : 1); // Chat title gets higher, title match gets medium
              docScores.set(docId, docScores.get(docId) + baseScore);
              docMatchedTerms.get(docId).add(queryTerm);
            }
            docMatchDetails.get(docId).contains++;
          }
        }
      }
    }
    
    // Filter documents based on query length
    // For short queries (1-2 words): use OR logic (at least one match)
    // For longer queries (3+ words): use AND logic (all words should match, but with partial matching)
    const isShortQuery = queryTerms.length <= 2;
    const minRequiredMatches = isShortQuery ? 1 : queryTerms.length;
    
    const results = Array.from(docScores.entries())
      .filter(([docId, score]) => {
        const matchedTermsSet = docMatchedTerms.get(docId);
        const matchedTermsCount = matchedTermsSet ? matchedTermsSet.size : 0;
        return matchedTermsCount >= minRequiredMatches;
      })
      .sort((a, b) => {
        // Primary sort: by score (higher is better)
        if (b[1] !== a[1]) {
          return b[1] - a[1];
        }
        // Secondary sort: by number of matched terms
        const termsA = docMatchedTerms.get(a[0]);
        const termsB = docMatchedTerms.get(b[0]);
        const countA = termsA ? termsA.size : 0;
        const countB = termsB ? termsB.size : 0;
        if (countB !== countA) {
          return countB - countA;
        }
        // Tertiary sort: prefer exact matches
        const detailsA = docMatchDetails.get(a[0]);
        const detailsB = docMatchDetails.get(b[0]);
        if (detailsA && detailsB) {
          if (detailsB.exact !== detailsA.exact) {
            return detailsB.exact - detailsA.exact;
          }
          if (detailsB.prefix !== detailsA.prefix) {
            return detailsB.prefix - detailsA.prefix;
          }
        }
        return 0;
      })
      .slice(0, limit)
      .map(([docId]) => {
        if (enrich) {
          return this.documents.get(docId);
        }
        return docId;
      })
      .filter(Boolean);
    
    return enrich ? results : results;
  }
  
  // Export index for storage
  export() {
    return {
      documents: Array.from(this.documents.entries()),
      termIndex: Array.from(this.termIndex.entries()).map(([term, docSet]) => [term, Array.from(docSet)])
    };
  }
  
  // Import index from storage
  import(data) {
    if (!data) return;
    
    if (data.documents) {
      this.documents = new Map(data.documents);
    }
    
    if (data.termIndex) {
      this.termIndex = new Map(
        data.termIndex.map(([term, docArray]) => [term, new Set(docArray)])
      );
    }
  }
  
  // Get document by ID
  get(docId) {
    return this.documents.get(docId);
  }
}

const indexCache = new Map();

async function getOrCreateIndex(accountEmail) {
  // Check cache first
  if (indexCache.has(accountEmail)) {
    // Verify that account still exists in database
    // If account was deleted, index should not be in cache
    const account = await getAccount(accountEmail);
    if (!account) {
      // Account was deleted, remove from cache
      console.log(`getOrCreateIndex: Account ${accountEmail} not found, removing from cache`);
      indexCache.delete(accountEmail);
    } else {
      return indexCache.get(accountEmail);
    }
  }
  
  const index = new SimpleSearchIndex();
  
  // Try to load from stored index
  const storedIndex = await getIndex(accountEmail);
  if (storedIndex && storedIndex.flexIndexJSON) {
    try {
      // Handle both old format (flexIndexJSON.export) and new format (direct data)
      const indexData = storedIndex.flexIndexJSON.export || storedIndex.flexIndexJSON;
      // Import serialized index
      index.import(indexData);
    } catch (e) {
      console.error('Error importing stored index, rebuilding:', e);
      // If import fails, rebuild from messages
      const chats = await getChatsByAccount(accountEmail);
      const allMessages = [];
      for (const chat of chats) {
        const messages = await getMessagesByChat(chat.chatId);
        allMessages.push(...messages);
      }
      
      // Пропускаем чаты без сообщений пользователя
      const chatsWithUserMessages = new Set();
      for (const msg of allMessages) {
        if (msg.role === 'user' && msg.text && msg.text.trim().length > 0) {
          chatsWithUserMessages.add(msg.chatId);
        }
      }
      
      // Добавляем документы для названий чатов только для чатов с сообщениями пользователя и с названием
      for (const chat of chats) {
        const hasTitle = chat.title && chat.title.trim() && chat.title.trim() !== 'Без названия';
        if (chatsWithUserMessages.has(chat.chatId) && hasTitle) {
          index.add({
            id: `chat_${chat.chatId}`,
            text: '',
            title: chat.title,
            chatId: chat.chatId,
            isChatTitle: true
          });
        }
      }
      
      // Добавляем документы для сообщений
      // Важно: индексируем текст сообщений для поиска по содержимому
      // Пропускаем чаты без сообщений пользователя и без названия
      for (const msg of allMessages) {
        // Индексируем только сообщения из чатов, где есть сообщения пользователя и есть название
        if (chatsWithUserMessages.has(msg.chatId) && msg.text && msg.text.trim().length > 0) {
          const chat = chats.find(c => c.chatId === msg.chatId);
          const hasTitle = chat && chat.title && chat.title.trim() && chat.title.trim() !== 'Без названия';
          // Индексируем только если у чата есть название
          if (hasTitle) {
            index.add({
              id: msg.id,
              text: msg.text.trim(), // Убеждаемся, что текст не пустой
              title: chat.title,
              chatId: msg.chatId,
              isChatTitle: false
            });
          }
        }
      }
    }
  } else {
    // No stored index, build from messages
    const chats = await getChatsByAccount(accountEmail);
    const allMessages = [];
    for (const chat of chats) {
      const messages = await getMessagesByChat(chat.chatId);
      allMessages.push(...messages);
    }
    
    // Пропускаем чаты без сообщений пользователя
    const chatsWithUserMessages = new Set();
    for (const msg of allMessages) {
      if (msg.role === 'user' && msg.text && msg.text.trim().length > 0) {
        chatsWithUserMessages.add(msg.chatId);
      }
    }
    
    // Добавляем документы для названий чатов только для чатов с сообщениями пользователя и с названием
    for (const chat of chats) {
      const hasTitle = chat.title && chat.title.trim() && chat.title.trim() !== 'Без названия';
      if (chatsWithUserMessages.has(chat.chatId) && hasTitle) {
        index.add({
          id: `chat_${chat.chatId}`,
          text: '',
          title: chat.title,
          chatId: chat.chatId,
          isChatTitle: true
        });
      }
    }
    
    // Добавляем документы для сообщений
    // Важно: индексируем текст сообщений для поиска по содержимому
    // Пропускаем чаты без сообщений пользователя и без названия
    for (const msg of allMessages) {
      // Индексируем только сообщения из чатов, где есть сообщения пользователя и есть название
      if (chatsWithUserMessages.has(msg.chatId) && msg.text && msg.text.trim().length > 0) {
        const chat = chats.find(c => c.chatId === msg.chatId);
        const hasTitle = chat && chat.title && chat.title.trim() && chat.title.trim() !== 'Без названия';
        // Индексируем только если у чата есть название
        if (hasTitle) {
          index.add({
            id: msg.id,
            text: msg.text.trim(), // Убеждаемся, что текст не пустой
            title: chat.title,
            chatId: msg.chatId,
            isChatTitle: false
          });
        }
      }
    }
  }
  
  indexCache.set(accountEmail, index);
  console.log(`getOrCreateIndex: Cached index for ${accountEmail} with ${index.documents?.size || 0} documents, ${index.termIndex?.size || 0} terms`);
  return index;
}

function highlightSearchTerms(text, query) {
  if (!text || !query) return text;
  
  const queryTrimmed = query.trim();
  if (!queryTrimmed) return text;
  
  // Разбиваем запрос на слова
  const words = queryTrimmed.split(/\s+/).filter(t => t.length > 0);
  
  if (words.length > 1) {
    // Если запрос содержит несколько слов, сначала подсвечиваем всю последовательность
    const phrase = queryTrimmed;
    const escapedPhrase = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const phraseRegex = new RegExp(`(${escapedPhrase})`, 'gi');
    
    // Находим все вхождения полной фразы
    const phraseMatches = [];
    let match;
    const regex = new RegExp(escapedPhrase, 'gi');
    while ((match = regex.exec(text)) !== null) {
      phraseMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0]
      });
    }
    
    if (phraseMatches.length > 0) {
      // Есть вхождения полной фразы - подсвечиваем только их
      const parts = [];
      let lastIndex = 0;
      
      for (const phraseMatch of phraseMatches) {
        // Текст до совпадения - добавляем как есть (без подсветки отдельных слов)
        if (phraseMatch.start > lastIndex) {
          parts.push(text.substring(lastIndex, phraseMatch.start));
        }
        // Само совпадение - подсвечиваем
        parts.push(`<mark>${phraseMatch.text}</mark>`);
        lastIndex = phraseMatch.end;
      }
      
      // Оставшийся текст после последнего совпадения
      if (lastIndex < text.length) {
        parts.push(text.substring(lastIndex));
      }
      
      return parts.join('');
    } else {
      // Если полная фраза не найдена, подсвечиваем отдельные слова
      return highlightWordsInText(text, words);
    }
  } else {
    // Одно слово - просто подсвечиваем его
    const word = words[0];
    const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedWord})`, 'gi');
    return text.replace(regex, '<mark>$1</mark>');
  }
}

/**
 * Подсвечивает отдельные слова в тексте
 * @param {string} text - Текст для обработки
 * @param {string[]} words - Массив слов для подсветки
 * @returns {string} - Текст с подсвеченными словами
 */
function highlightWordsInText(text, words) {
  let result = text;
  
  for (const word of words) {
    const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedWord})`, 'gi');
    result = result.replace(regex, '<mark>$1</mark>');
  }
  
  return result;
}

/**
 * Обрезает текст до указанной длины, центрируя вокруг найденного совпадения
 * @param {string} html - HTML текст с разметкой
 * @param {number} maxLength - Максимальная длина в символах
 * @returns {string} - Обрезанный текст с контекстом вокруг совпадения
 */
function truncateHtml(html, maxLength = 150) {
  if (!html) return '';
  
  // Удаляем HTML теги для подсчета длины текста
  const plainText = html.replace(/<[^>]*>/g, '');
  
  if (plainText.length <= maxLength) {
    return html;
  }
  
  // Находим первое совпадение (подсвеченный текст)
  const markStartRegex = /<mark[^>]*>/gi;
  const markEndRegex = /<\/mark>/gi;
  
  let firstMarkStart = -1;
  let firstMarkEnd = -1;
  let markStartPos = 0;
  
  // Находим позицию первого <mark> в исходном HTML
  const markStartMatch = markStartRegex.exec(html);
  if (markStartMatch) {
    firstMarkStart = markStartMatch.index;
    markStartPos = firstMarkStart;
    
    // Находим позицию соответствующего </mark>
    const htmlAfterMark = html.substring(firstMarkStart + markStartMatch[0].length);
    const markEndMatch = markEndRegex.exec(htmlAfterMark);
    if (markEndMatch) {
      firstMarkEnd = firstMarkStart + markStartMatch[0].length + markEndMatch.index;
    }
  }
  
  // Если нет подсветки, обрезаем с начала
  if (firstMarkStart === -1) {
    return truncateFromStart(html, maxLength);
  }
  
  // Вычисляем позицию совпадения в plainText (без HTML тегов)
  const textBeforeMark = html.substring(0, firstMarkStart).replace(/<[^>]*>/g, '');
  const matchStartInPlainText = textBeforeMark.length;
  const matchText = html.substring(firstMarkStart + 5, firstMarkEnd).replace(/<[^>]*>/g, '');
  const matchEndInPlainText = matchStartInPlainText + matchText.length;
  
  // Вычисляем центр совпадения
  const matchCenter = Math.floor((matchStartInPlainText + matchEndInPlainText) / 2);
  
  // Вычисляем границы сниппета (центрируем вокруг совпадения)
  const contextBefore = Math.floor(maxLength * 0.4); // 40% до совпадения
  const contextAfter = Math.floor(maxLength * 0.6); // 60% после совпадения
  
  let snippetStart = Math.max(0, matchCenter - contextBefore);
  let snippetEnd = Math.min(plainText.length, matchCenter + contextAfter);
  
  // Расширяем до границ, если есть место
  if (snippetEnd - snippetStart < maxLength) {
    const remaining = maxLength - (snippetEnd - snippetStart);
    snippetStart = Math.max(0, snippetStart - Math.floor(remaining / 2));
    snippetEnd = Math.min(plainText.length, snippetEnd + Math.ceil(remaining / 2));
  }
  
  // Обрезаем по границам слов
  if (snippetStart > 0) {
    const spaceBefore = plainText.lastIndexOf(' ', snippetStart);
    if (spaceBefore > snippetStart - 20) {
      snippetStart = spaceBefore + 1;
    }
  }
  
  if (snippetEnd < plainText.length) {
    const spaceAfter = plainText.indexOf(' ', snippetEnd);
    if (spaceAfter !== -1 && spaceAfter < snippetEnd + 20) {
      snippetEnd = spaceAfter;
    }
  }
  
  // Извлекаем нужный фрагмент из HTML, сохраняя разметку
  return extractHtmlFragment(html, snippetStart, snippetEnd, plainText);
}

/**
 * Обрезает HTML с начала до указанной длины
 */
function truncateFromStart(html, maxLength) {
  const plainText = html.replace(/<[^>]*>/g, '');
  
  if (plainText.length <= maxLength) {
    return html;
  }
  
  let result = '';
  let currentLength = 0;
  let inTag = false;
  let tagBuffer = '';
  
  for (let i = 0; i < html.length; i++) {
    const char = html[i];
    
    if (char === '<') {
      inTag = true;
      tagBuffer = '<';
    } else if (char === '>') {
      inTag = false;
      tagBuffer += '>';
      result += tagBuffer;
      tagBuffer = '';
    } else if (inTag) {
      tagBuffer += char;
    } else {
      if (currentLength >= maxLength) {
        break;
      }
      result += char;
      currentLength++;
    }
  }
  
  if (currentLength < plainText.length) {
    const lastSpace = result.lastIndexOf(' ');
    if (lastSpace > maxLength * 0.8) {
      result = result.substring(0, lastSpace);
    }
    result += '…';
  }
  
  return result;
}

/**
 * Извлекает фрагмент HTML, соответствующий указанному диапазону в plainText
 */
function extractHtmlFragment(html, startPos, endPos, plainText) {
  // Проходим по HTML и отслеживаем позиции в plainText
  let result = '';
  let plainTextPos = 0;
  let inTag = false;
  let tagBuffer = '';
  let started = false;
  
  for (let i = 0; i < html.length; i++) {
    const char = html[i];
    
    if (char === '<') {
      inTag = true;
      tagBuffer = '<';
    } else if (char === '>') {
      inTag = false;
      tagBuffer += '>';
      
      // Добавляем тег, если мы в нужном диапазоне
      if (started || plainTextPos >= startPos) {
        if (!started && plainTextPos >= startPos) {
          started = true;
        }
        result += tagBuffer;
      }
      
      tagBuffer = '';
    } else if (inTag) {
      tagBuffer += char;
    } else {
      // Обычный текст
      if (plainTextPos >= startPos && plainTextPos < endPos) {
        if (!started) {
          started = true;
        }
        result += char;
      }
      
      plainTextPos++;
      
      if (plainTextPos >= endPos) {
        break;
      }
    }
  }
  
  // Добавляем многоточие в начале и конце, если текст обрезан
  if (startPos > 0) {
    result = '…' + result;
  }
  if (endPos < plainText.length) {
    result = result + '…';
  }
  
  return result;
}

// ========== Indexing Logic ==========
async function indexChat(accountEmail, chatId, sendProgress, maxRetries = 3, reusableTab = null) {
  let attempt = 0;
  const baseDelay = 1000; // Базовая задержка 1 секунда
  let tab = null;
  let tabCreatedByUs = false; // Флаг, что вкладка создана нами
  let isReusable = !!reusableTab; // Флаг, что вкладка переиспользуется
  let response = null;
  
  while (attempt < maxRetries) {
    try {
    const chat = await getChat(chatId);
    if (!chat) {
      throw new Error(`Chat ${chatId} not found`);
    }
    
      // Сбрасываем флаг при новой попытке (если вкладка уже была создана ранее)
      if (attempt > 0 && tabCreatedByUs) {
        // Закрываем предыдущую вкладку при повторной попытке
        try {
          if (tab && tab.id) {
            await chrome.tabs.remove(tab.id);
          }
        } catch (e) {
          // Игнорируем ошибки
        }
        tab = null;
        tabCreatedByUs = false;
      }
      
      // Ищем существующую вкладку с нужным URL
    const tabs = await chrome.tabs.query({ url: chat.url });
    if (tabs.length > 0) {
      tab = tabs[0];
        // Проверяем, что вкладка все еще существует и загружена
        try {
          const tabInfo = await chrome.tabs.get(tab.id);
          if (tabInfo.status !== 'complete') {
            // Вкладка еще загружается, ждем
      await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (e) {
          // Вкладка была закрыта, создаем новую
          tab = null;
        }
      }
      
      // Если есть переиспользуемая вкладка - обновляем её URL
      if (isReusable && reusableTab && reusableTab.id) {
        try {
          // Проверяем, что вкладка еще существует
          const tabInfo = await chrome.tabs.get(reusableTab.id);
          await chrome.tabs.update(reusableTab.id, { url: chat.url });
          tab = reusableTab;
          // Ждем загрузки новой страницы
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Дополнительно ждем, пока страница полностью загрузится
          let loadRetries = 7;
          while (loadRetries > 0) {
            try {
              const updatedTabInfo = await chrome.tabs.get(tab.id);
              if (updatedTabInfo.status === 'complete' && updatedTabInfo.url === chat.url) {
                break;
              }
              await new Promise(resolve => setTimeout(resolve, 300));
            } catch (e) {
              // Вкладка была закрыта
              throw new Error('Tab was closed during loading');
            }
            loadRetries--;
          }
        } catch (e) {
          // Если не удалось обновить вкладку, создаем новую
          console.warn(`indexChat: Could not reuse tab, creating new one:`, e.message);
          tab = null;
          isReusable = false;
        }
      }
      
      // Если вкладки нет, сначала ищем существующие вкладки Copilot для переиспользования
      if (!tab) {
        // Ищем открытые вкладки Copilot (они имеют сессию)
        const copilotTabs = await chrome.tabs.query({ url: "*://copilot.microsoft.com/*" });
        if (copilotTabs.length > 0) {
          // Используем первую открытую вкладку Copilot (она имеет сессию)
          tab = copilotTabs[0];
          console.log(`indexChat: Reusing existing Copilot tab ${tab.id} for chat ${chatId}`);
          // Обновляем URL на нужный чат
          await chrome.tabs.update(tab.id, { url: chat.url });
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          // Если нет открытых вкладок, создаем новую
          // ВАЖНО: создаем активной, чтобы она могла получить сессию
          tab = await chrome.tabs.create({ 
            url: chat.url, 
            active: true, // Активируем для получения сессии
            pinned: false
          });
          console.log(`indexChat: Created new tab ${tab.id} for chat ${chatId} (active to get session)`);
          tabCreatedByUs = true;
          // Деактивируем после небольшой задержки, чтобы сессия успела установиться
          setTimeout(() => {
            chrome.tabs.update(tab.id, { active: false }).catch(() => {});
          }, 2000);
          // Ждем загрузки страницы
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Дополнительно ждем, пока страница полностью загрузится
          let loadRetries = 7;
          while (loadRetries > 0) {
            try {
              const tabInfo = await chrome.tabs.get(tab.id);
              if (tabInfo.status === 'complete') {
                break;
              }
              await new Promise(resolve => setTimeout(resolve, 300));
            } catch (e) {
              // Вкладка была закрыта
              throw new Error('Tab was closed during loading');
            }
            loadRetries--;
          }
        }
      }
      
      // Если вкладка уже существует (найдена ранее), обновляем её URL
      if (tab && !tabCreatedByUs && tab.id) {
        // Переиспользуем существующую вкладку - меняем URL
        try {
          await chrome.tabs.update(tab.id, { url: chat.url });
          // Ждем загрузки новой страницы
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Дополнительно ждем, пока страница полностью загрузится
          let loadRetries = 7;
          while (loadRetries > 0) {
            try {
              const tabInfo = await chrome.tabs.get(tab.id);
              if (tabInfo.status === 'complete' && tabInfo.url === chat.url) {
                break;
              }
              await new Promise(resolve => setTimeout(resolve, 300));
            } catch (e) {
              // Вкладка была закрыта
              throw new Error('Tab was closed during loading');
            }
            loadRetries--;
          }
        } catch (e) {
          // Если не удалось обновить вкладку, создаем новую
          console.warn(`indexChat: Could not reuse tab, creating new one:`, e.message);
          // Ищем существующие вкладки Copilot
          const copilotTabs = await chrome.tabs.query({ url: "*://copilot.microsoft.com/*" });
          if (copilotTabs.length > 0) {
            tab = copilotTabs[0];
            await chrome.tabs.update(tab.id, { url: chat.url });
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            // Создаем новую активную вкладку для получения сессии
            tab = await chrome.tabs.create({ 
              url: chat.url, 
              active: true, // Активируем для получения сессии
              pinned: false
            });
            tabCreatedByUs = true;
            setTimeout(() => {
              chrome.tabs.update(tab.id, { active: false }).catch(() => {});
            }, 2000);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }
      
      // Ждем, пока страница полностью загрузится и content script будет готов
      // Увеличиваем начальную задержку, чтобы content script успел загрузиться
      await new Promise(resolve => setTimeout(resolve, 2500));
      
      // Используем объединенный запрос: проверка готовности + получение контента
      // Это позволяет избежать двойных запросов и проблем с таймингом
      let maxAttempts = 15; // Максимум попыток (увеличено, так как ждем дольше между попытками)
      const waitDelay = 500; // Фиксированная задержка 500ms между проверками, если контент не готов
      
      while (maxAttempts > 0) {
        try {
          // Объединенный запрос: проверяем готовность и получаем контент одновременно
          const checkResponse = await chrome.tabs.sendMessage(tab.id, { 
            action: 'checkContentReadyAndGet',
            chatId: chatId 
          });
          
          if (checkResponse && checkResponse.success) {
            if (checkResponse.ready && checkResponse.messages) {
              // Контент готов и получен - используем его и выходим
              console.log(`indexChat: Content ready and retrieved (${checkResponse.messageCount} messages, ${checkResponse.userMessageCount} user messages)`);
              response = checkResponse;
              break;
            } else {
              // Контент еще не готов - ждем 500ms и проверяем снова
              console.log(`indexChat: Content not ready yet (${checkResponse.messageCount || 0} messages), waiting 500ms before next check... (${maxAttempts} attempts left)`);
              await new Promise(resolve => setTimeout(resolve, waitDelay));
              // Продолжаем цикл для следующей проверки
            }
          } else {
            // Ошибка в ответе, ждем и пробуем снова
            console.log(`indexChat: Invalid response, waiting 500ms before retry... (${maxAttempts} attempts left)`);
            await new Promise(resolve => setTimeout(resolve, waitDelay));
          }
          
        } catch (error) {
          const errorMsg = error.message || String(error);
          
          // Ошибки соединения - content script может быть еще не готов
          if (errorMsg.includes('Could not establish connection') || 
              errorMsg.includes('Receiving end does not exist') ||
              errorMsg.includes('Extension context invalidated') ||
              errorMsg.includes('message port closed')) {
            console.log(`indexChat: Connection error (content script may not be ready), waiting 500ms... (${maxAttempts} attempts left)`);
            await new Promise(resolve => setTimeout(resolve, waitDelay));
          } else {
            // Другие ошибки - пробрасываем
            throw error;
          }
        }
        
        maxAttempts--;
      }
      
      // Если после всех попыток не получили контент, пробуем получить через обычный запрос
      if (!response || !response.success || !response.messages) {
        console.log(`indexChat: Trying fallback getChatContent after ready checks`);
        let retries = 3;
        
        while (retries > 0) {
          try {
            response = await chrome.tabs.sendMessage(tab.id, { 
              action: 'getChatContent',
              chatId: chatId 
            });
            
            if (response && response.success) {
              break;
            }
            
            if (response && response.error && response.error.includes('Chat ID not found')) {
              console.warn(`indexChat: Chat ID not found in URL for ${chatId}, but we provided it. Retrying...`);
              await new Promise(resolve => setTimeout(resolve, 500));
            } else if (response && response.error) {
              throw new Error(response.error);
            }
          } catch (error) {
            const errorMsg = error.message || String(error);
            
            if (errorMsg.includes('Could not establish connection') || 
                errorMsg.includes('Receiving end does not exist') ||
                errorMsg.includes('Extension context invalidated') ||
                errorMsg.includes('message port closed')) {
              console.log(`indexChat: Connection error in fallback, waiting... (${retries} retries left)`);
              await new Promise(resolve => setTimeout(resolve, 500));
            } else {
              throw error;
            }
          }
          
          retries--;
        }
      }
    
    if (!response || !response.success || !response.messages) {
        const errorMsg = response?.error || 'Failed to get chat content';
        console.error(`indexChat: Failed to get chat content for ${chatId}:`, errorMsg);
        if (response?.debug) {
          console.error('indexChat: Debug info:', response.debug);
        }
        
        // Проверяем, является ли это ошибкой аутентификации
        if (errorMsg.includes('Access token is empty') || errorMsg.includes('InvalidAuthenticationToken')) {
          throw new Error(`Authentication error: Access token is empty. Please ensure you are logged in to Copilot in an active tab.`);
        }
        
        throw new Error(errorMsg);
      }
      
      // Если дошли сюда, значит успешно получили данные
      break; // Выходим из цикла попыток
      
    } catch (error) {
      attempt++;
      const errorMsg = error.message || String(error);
      
      // Проверяем, является ли это ошибкой аутентификации
      const isAuthError = errorMsg.includes('Access token is empty') || 
                         errorMsg.includes('InvalidAuthenticationToken') ||
                         errorMsg.includes('Authentication error') ||
                         errorMsg.includes('Authentication failed');
      
      if (isAuthError) {
        // Ошибка аутентификации - не повторяем, пробрасываем сразу
        console.error(`indexChat: Authentication error for chat ${chatId}. The tab may not have a valid session.`);
        throw new Error(`Authentication failed: Please ensure you are logged in to Copilot and have an active tab open. Background tabs cannot access the session.`);
      }
      
      // Проверяем, является ли это ошибкой соединения
      const isConnectionError = errorMsg.includes('Could not establish connection') ||
                                errorMsg.includes('Receiving end does not exist') ||
                                errorMsg.includes('Extension context invalidated') ||
                                errorMsg.includes('message port closed') ||
                                errorMsg.includes('No tab with id');
      
      if (isConnectionError && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1); // Экспоненциальная задержка
        console.warn(`indexChat: Connection error (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms:`, errorMsg);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue; // Пробуем еще раз
      } else {
        // Не ошибка соединения или исчерпаны попытки
        throw error;
      }
    }
  }
  
  // Если мы здесь, значит успешно получили response
  try {
    const chat = await getChat(chatId);
    
    if (!chat) {
      throw new Error(`Chat ${chatId} not found in database`);
    }
    
    const messages = response.messages || [];
    console.log(`indexChat: Got ${messages.length} messages for chat ${chatId}, title: "${chat.title}"`);
    
    // Проверяем, есть ли название у чата
    const hasTitle = chat.title && chat.title.trim() && chat.title.trim() !== 'Без названия';
    
    // Если нет названия или название "Без названия", пропускаем индексацию
    if (!hasTitle) {
      console.log(`indexChat: Skipping chat ${chatId} - no title or title is "Без названия" (title: "${chat.title}")`);
      if (sendProgress) {
        chrome.runtime.sendMessage({
          type: 'INDEX_PROGRESS',
          chatId,
          status: 'skipped',
          reason: 'No title'
        }).catch(() => {});
      }
      
      // Закрываем вкладку, если она была создана нами и не переиспользуется
      if (tabCreatedByUs && !isReusable && tab && tab.id) {
        try {
          await chrome.tabs.remove(tab.id);
          console.log(`indexChat: Closed background tab for skipped chat ${chatId}`);
        } catch (e) {
          console.log(`indexChat: Could not close tab ${tab.id} for skipped chat:`, e.message);
        }
      }
      
      return { 
        messageCount: 0, 
        skipped: true,
        reusableTab: (isReusable && tab) ? tab : null
      };
    }
    
    // Проверяем, есть ли в чате сообщения пользователя (диалог)
    const userMessages = messages.filter(msg => msg.role === 'user' && msg.text && msg.text.trim().length > 0);
    console.log(`indexChat: Found ${userMessages.length} user messages out of ${messages.length} total messages for chat ${chatId}`);
    
    // Если нет сообщений пользователя, пропускаем индексацию
    if (userMessages.length === 0) {
      console.log(`indexChat: Skipping chat ${chatId} - no user messages found (total messages: ${messages.length})`);
      if (sendProgress) {
        chrome.runtime.sendMessage({
          type: 'INDEX_PROGRESS',
          chatId,
          status: 'skipped',
          reason: 'No user messages'
        }).catch(() => {});
      }
      
      // Закрываем вкладку, если она была создана нами и не переиспользуется
      if (tabCreatedByUs && !isReusable && tab && tab.id) {
        try {
          await chrome.tabs.remove(tab.id);
          console.log(`indexChat: Closed background tab for skipped chat ${chatId}`);
        } catch (e) {
          console.log(`indexChat: Could not close tab ${tab.id} for skipped chat:`, e.message);
        }
      }
      
      return { 
        messageCount: 0, 
        skipped: true,
        reusableTab: (isReusable && tab) ? tab : null
      };
    }
    
    console.log(`indexChat: Starting indexing for chat ${chatId} with ${messages.length} messages`);
    
    await deleteMessagesByChat(chatId);
    
    // Используем батчинг для сохранения всех сообщений одной транзакцией
    await createMessagesBatch(messages);
    console.log(`indexChat: Saved ${messages.length} messages to database for chat ${chatId}`);
    
    const index = await getOrCreateIndex(accountEmail);
    console.log(`indexChat: Got index for account ${accountEmail}, current documents: ${index.documents?.size || 0}, terms: ${index.termIndex?.size || 0}`);
    
    // Удаляем старые документы для этого чата из индекса перед добавлением новых
    // Это предотвращает накопление дубликатов при повторной индексации
    const removedCount = index.removeByChatId(chatId);
    if (removedCount > 0) {
      console.log(`indexChat: Removed ${removedCount} old documents from index for chat ${chatId}`);
    }
    
    // Добавляем отдельный документ для чата (название чата)
    // Это позволяет искать по названиям чатов напрямую
    if (chat.title && chat.title.trim()) {
      index.add({
        id: `chat_${chat.chatId}`,
        text: '', // Название чата в title, не в text
        title: chat.title,
        chatId: chat.chatId,
        isChatTitle: true // Флаг для повышенного приоритета
      });
    }
    
    // Добавляем документы для сообщений
    // Важно: индексируем текст сообщений для поиска по содержимому
    const documents = messages
      .filter(msg => msg.text && msg.text.trim().length > 0) // Фильтруем пустые сообщения
      .map(msg => ({
      id: msg.id,
        text: msg.text.trim(), // Убеждаемся, что текст не пустой
      title: chat.title,
        chatId: chat.chatId,
        isChatTitle: false
    }));
    
    let indexedDocs = 0;
    for (const doc of documents) {
      // Индексируем только если есть текст для поиска
      if (doc.text && doc.text.length > 0) {
        index.add(doc);
        indexedDocs++;
      }
    }
    console.log(`indexChat: Added ${indexedDocs} documents to index for chat ${chatId}`);
    console.log(`indexChat: Index state after adding - documents: ${index.documents?.size || 0}, terms: ${index.termIndex?.size || 0}`);
    
    await updateChat(chatId, { lastIndexedUTC: toUTCString() });
    console.log(`indexChat: Successfully indexed chat ${chatId}`);
    
    // Сохраняем индекс после каждого чата, чтобы не потерять прогресс
    try {
      if (typeof index.export === 'function') {
        const serializedIndex = index.export();
        console.log(`indexChat: Exported index - documents array length: ${serializedIndex?.documents?.length || 0}, termIndex array length: ${serializedIndex?.termIndex?.length || 0}`);
        
        if (serializedIndex && (serializedIndex.documents || serializedIndex.termIndex)) {
          // Проверяем, что есть данные для сохранения
          const hasDocuments = serializedIndex.documents && serializedIndex.documents.length > 0;
          const hasTerms = serializedIndex.termIndex && serializedIndex.termIndex.length > 0;
          
          if (hasDocuments || hasTerms) {
            await saveIndex(accountEmail, serializedIndex);
            console.log(`indexChat: Saved index to database for account ${accountEmail} (${serializedIndex.documents?.length || 0} documents, ${serializedIndex.termIndex?.length || 0} terms)`);
          } else {
            console.warn(`indexChat: Index export is empty - documents: ${hasDocuments}, terms: ${hasTerms}`);
          }
        } else {
          console.warn(`indexChat: Index export returned invalid data:`, serializedIndex);
        }
      } else {
        console.warn(`indexChat: Index does not have export method, type: ${typeof index.export}`);
      }
    } catch (e) {
      console.error(`indexChat: Error saving index:`, e);
      console.error(`indexChat: Error stack:`, e.stack);
      // Не пробрасываем ошибку - индексация успешна, просто не сохранили
    }
    
    // Закрываем вкладку, если она была создана нами (в фоновом режиме) и не переиспользуется
    // НЕ закрываем, если вкладка переиспользуется - она будет закрыта в startIndexing
    if (tabCreatedByUs && !isReusable && tab && tab.id) {
      try {
        await chrome.tabs.remove(tab.id);
        console.log(`indexChat: Closed background tab for chat ${chatId}`);
        tab = null; // Обнуляем ссылку на закрытую вкладку
      } catch (e) {
        // Игнорируем ошибки при закрытии (вкладка могла быть закрыта пользователем)
        console.log(`indexChat: Could not close tab ${tab.id}:`, e.message);
      }
    }
    
    if (sendProgress) {
      chrome.runtime.sendMessage({
        type: 'INDEX_PROGRESS',
        chatId,
        status: 'completed',
        messageCount: messages.length
      }).catch(() => {});
    }
    
    // Возвращаем информацию о вкладке для переиспользования
    // Если вкладка переиспользуется, возвращаем её для следующего чата
    // Если вкладка была создана нами и может быть переиспользована, возвращаем её
    return { 
      messageCount: messages.length,
      reusableTab: (isReusable && tab) ? tab : ((tabCreatedByUs && tab) ? tab : null)
    };
  } catch (error) {
    console.error(`Error indexing chat ${chatId}:`, error);
    
    // Закрываем вкладку при ошибке, если она была создана нами и не переиспользуется
    if (tabCreatedByUs && !isReusable && tab && tab.id) {
      try {
        await chrome.tabs.remove(tab.id);
        console.log(`indexChat: Closed background tab after error for chat ${chatId}`);
        tab = null;
      } catch (e) {
        // Игнорируем ошибки при закрытии
        console.log(`indexChat: Could not close tab ${tab?.id} after error:`, e.message);
      }
    }
    
    // Если вкладка переиспользуется, не закрываем её - она будет закрыта в startIndexing
    
    if (sendProgress) {
      chrome.runtime.sendMessage({
        type: 'INDEX_PROGRESS',
        chatId,
        status: 'error',
        error: error.message
      }).catch(() => {});
    }
    throw error;
  }
}

async function getDatabaseDiagnostics(accountEmail) {
  const db = await initDB();
  
  // Чаты для текущего аккаунта (это правильное число уникальных чатов)
  const accountChats = await getChatsByAccount(accountEmail);
  
  // Все аккаунты
  const allAccounts = await new Promise((resolve, reject) => {
    const transaction = db.transaction(['accounts'], 'readonly');
    const store = transaction.objectStore('accounts');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  
  // Чаты по аккаунтам
  const chatsByAccount = {};
  let totalUniqueChats = 0;
  for (const account of allAccounts) {
    const chats = await getChatsByAccount(account.email);
    chatsByAccount[account.email] = chats.length;
    totalUniqueChats += chats.length;
  }
  
  // Общее количество уникальных чатов (сумма по всем аккаунтам)
  // Это правильное число, так как каждый чат принадлежит одному аккаунту
  const allChatsCount = totalUniqueChats;
  
  return {
    accountEmail,
    totalChats: allChatsCount, // Теперь это сумма уникальных чатов по всем аккаунтам
    accountChats: accountChats.length,
    totalAccounts: allAccounts.length,
    accounts: allAccounts.map(a => a.email),
    chatsByAccount
  };
}

// Сохранение состояния индексации
async function saveIndexingState(accountEmail, currentIndex, totalCount, lastChatId) {
  try {
    await chrome.storage.local.set({
      [`indexing_${accountEmail}`]: {
        currentIndex,
        totalCount,
        lastChatId,
        timestamp: Date.now()
      }
    });
  } catch (error) {
    console.error('Error saving indexing state:', error);
  }
}

// Получение состояния индексации
async function getIndexingState(accountEmail) {
  try {
    const key = `indexing_${accountEmail}`;
    const result = await chrome.storage.local.get([key]);
    return result[key] || null;
  } catch (error) {
    console.error('Error getting indexing state:', error);
    return null;
  }
}

// Очистка состояния индексации
async function clearIndexingState(accountEmail) {
  try {
    await chrome.storage.local.remove([`indexing_${accountEmail}`]);
  } catch (error) {
    console.error('Error clearing indexing state:', error);
  }
}

/**
 * Получить чаты, которые нужно проиндексировать
 * @param {Array} chats - Все чаты аккаунта
 * @param {boolean} incremental - Инкрементальная индексация (только непроиндексированные/обновленные)
 * @returns {Array} - Чаты, требующие индексации
 */
function getChatsNeedingIndexing(chats, incremental = true) {
  if (!incremental) {
    // Полная переиндексация - индексируем все чаты
    return chats;
  }
  
  // Инкрементальная индексация - только непроиндексированные или обновленные
  return chats.filter(chat => {
    // Если чат не проиндексирован
    if (!chat.lastIndexedUTC) {
      return true;
    }
    
    // Если чат обновлен после индексации
    const updatedDate = new Date(chat.updatedAtUTC);
    const indexedDate = new Date(chat.lastIndexedUTC);
    return updatedDate > indexedDate;
  });
}

async function startIndexing(accountEmail, incremental = false, resume = false, sendProgress = true, selectedChatIds = null) {
  // Устанавливаем флаг активной индексации и сбрасываем флаг остановки
  isIndexingActive = true;
  shouldStopIndexing = false;
  
  try {
    if (!accountEmail) {
      throw new Error('Email аккаунта не указан');
    }
    
    const account = await getAccount(accountEmail);
    if (!account) {
      await createAccount(accountEmail);
    }
    
    const allChats = await getChatsByAccount(accountEmail);
    
    if (allChats.length === 0) {
      // Получаем диагностическую информацию
      const diagnostics = await getDatabaseDiagnostics(accountEmail);
      
      let errorMessage = `Чаты не найдены для аккаунта "${accountEmail}".\n\n`;
      errorMessage += `Диагностика:\n`;
      errorMessage += `- Всего чатов в БД: ${diagnostics.totalChats}\n`;
      errorMessage += `- Чатов для "${accountEmail}": ${diagnostics.accountChats}\n`;
      errorMessage += `- Всего аккаунтов: ${diagnostics.totalAccounts}\n`;
      
      if (diagnostics.totalChats === 0) {
        errorMessage += `\nПроблема: В базе данных нет чатов.\n`;
        errorMessage += `Решение: Откройте страницу Copilot (https://copilot.microsoft.com), дождитесь полной загрузки страницы и списка чатов. Расширение автоматически сохранит чаты в базу данных.`;
      } else if (diagnostics.accounts.length > 0) {
        errorMessage += `\nПроблема: Чаты найдены, но для другого аккаунта.\n`;
        errorMessage += `Найдены чаты для аккаунтов:\n`;
        for (const [email, count] of Object.entries(diagnostics.chatsByAccount)) {
          errorMessage += `  - ${email}: ${count} чатов\n`;
        }
        errorMessage += `\nРешение: Убедитесь, что вы используете правильный email аккаунта. Или откройте Copilot с нужным аккаунтом и дождитесь загрузки чатов.`;
      } else {
        errorMessage += `\nПроблема: Чаты есть в БД, но не привязаны к аккаунтам.\n`;
        errorMessage += `Решение: Откройте страницу Copilot и дождитесь загрузки списка чатов.`;
      }
      
      throw new Error(errorMessage);
    }
    
    // Если указаны выбранные чаты, используем их напрямую, иначе фильтруем
    let chatsToIndex;
    if (selectedChatIds && selectedChatIds.length > 0) {
      // Используем выбранные чаты напрямую
      const selectedSet = new Set(selectedChatIds);
      chatsToIndex = allChats.filter(chat => selectedSet.has(chat.chatId));
      console.log(`startIndexing: Using ${chatsToIndex.length} selected chats out of ${allChats.length} total`);
    } else {
      // Фильтруем чаты на основе их индивидуального lastIndexedUTC
      chatsToIndex = getChatsNeedingIndexing(allChats, incremental);
      console.log(`startIndexing: Found ${allChats.length} total chats, ${chatsToIndex.length} need indexing (incremental: ${incremental})`);
    }
    
    if (chatsToIndex.length === 0) {
      console.log('startIndexing: No chats need indexing');
      chrome.runtime.sendMessage({
        type: 'INDEX_DONE',
        accountEmail,
        indexedCount: 0,
        totalCount: allChats.length,
        errorCount: 0
      }).catch(() => {});
      return { 
        indexedCount: 0, 
        totalCount: allChats.length,
        errorCount: 0
      };
    }
    
    // Проверяем, есть ли сохраненное состояние индексации
    let startIndex = 0;
    if (resume) {
      const savedState = await getIndexingState(accountEmail);
      if (savedState && savedState.currentIndex < chatsToIndex.length) {
        // Проверяем, не устарело ли состояние (больше 1 часа)
        const stateAge = Date.now() - savedState.timestamp;
        if (stateAge < 3600000) { // 1 час
          startIndex = savedState.currentIndex;
          console.log(`Resuming indexing from chat ${startIndex + 1} of ${chatsToIndex.length}`);
          
          // Пропускаем уже проиндексированные чаты
          // (те, у которых есть lastIndexedUTC и он недавний)
          while (startIndex < chatsToIndex.length) {
            const chat = chatsToIndex[startIndex];
            if (!chat.lastIndexedUTC) {
              break; // Этот чат не проиндексирован, начинаем с него
            }
            // Проверяем, не слишком ли старый индекс (больше 1 дня - переиндексируем)
            const indexedDate = new Date(chat.lastIndexedUTC);
            const daysSinceIndexed = (Date.now() - indexedDate.getTime()) / (1000 * 60 * 60 * 24);
            if (daysSinceIndexed > 1) {
              break; // Индекс устарел, переиндексируем
            }
            startIndex++;
          }
        }
      }
    }
    
    let successCount = 0;
    let errorCount = 0;
    const errors = [];
    
    // Переиспользуем одну вкладку для всех чатов (оптимизация)
    let reusableTab = null;
    let reusableTabCreated = false;
    
    for (let i = startIndex; i < chatsToIndex.length; i++) {
      // Проверяем флаг остановки индексации
      if (shouldStopIndexing) {
        console.log('Indexing stopped by user');
        await saveIndexingState(accountEmail, i, chatsToIndex.length, chat.chatId);
        chrome.runtime.sendMessage({
          type: 'INDEX_STOPPED',
          accountEmail,
          currentIndex: i,
          totalCount: chatsToIndex.length
        }).catch(() => {});
        return {
          indexedCount: successCount,
          totalCount: chatsToIndex.length,
          errorCount: errorCount,
          stopped: true
        };
      }
      
      const chat = chatsToIndex[i];
      
      try {
        // Сохраняем прогресс перед обработкой каждого чата (только каждые 5 чатов или последний)
        if (i % 5 === 0 || i === 0) {
          await saveIndexingState(accountEmail, i, chatsToIndex.length, chat.chatId);
        }
        
        // Отправляем прогресс
        if (sendProgress) {
          chrome.runtime.sendMessage({
            type: 'INDEX_PROGRESS',
            chatId: chat.chatId,
            status: 'processing',
            current: i + 1,
            total: chatsToIndex.length
          }).catch(() => {});
        }
        
        // Передаем переиспользуемую вкладку, если она есть
        const result = await indexChat(accountEmail, chat.chatId, sendProgress, 3, reusableTab); // 3 попытки при ошибках соединения
        
        // Если вкладка была создана и может быть переиспользована, сохраняем её
        if (result && result.reusableTab) {
          // Проверяем, что вкладка еще существует
          try {
            const tabInfo = await chrome.tabs.get(result.reusableTab.id);
            reusableTab = result.reusableTab;
            reusableTabCreated = true;
          } catch (e) {
            // Вкладка была закрыта, сбрасываем
            reusableTab = null;
            reusableTabCreated = false;
            console.log(`startIndexing: Reusable tab was closed, will create new one for next chat`);
          }
        }
        
        successCount++;
        
        // Сохраняем прогресс после успешной обработки (только каждые 5 чатов или последний)
        if ((i + 1) % 5 === 0 || i === chatsToIndex.length - 1) {
          await saveIndexingState(accountEmail, i + 1, chatsToIndex.length, chat.chatId);
        }
      
      if (i < chatsToIndex.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
        }
      } catch (error) {
        errorCount++;
        const errorMsg = error.message || String(error);
        errors.push({ chatId: chat.chatId, error: errorMsg });
        
        console.error(`Error indexing chat ${chat.chatId}:`, error);
        
        // Проверяем, является ли это ошибкой соединения
        const isConnectionError = errorMsg.includes('Could not establish connection') ||
                                  errorMsg.includes('Receiving end does not exist') ||
                                  errorMsg.includes('Extension context invalidated') ||
                                  errorMsg.includes('message port closed');
        
        if (isConnectionError) {
          // При ошибке соединения сохраняем состояние и пробрасываем ошибку
          // чтобы можно было возобновить индексацию
          await saveIndexingState(accountEmail, i, chatsToIndex.length, chat.chatId);
          throw new Error(`Индексация прервана из-за потери соединения на чате ${i + 1} из ${chatsToIndex.length}. Используйте "Возобновить индексацию" для продолжения.`);
        }
        
        // Для других ошибок продолжаем со следующим чатом
        if (sendProgress) {
          chrome.runtime.sendMessage({
            type: 'INDEX_PROGRESS',
            chatId: chat.chatId,
            status: 'error',
            error: errorMsg,
            current: i + 1,
            total: chatsToIndex.length
          }).catch(() => {});
        }
      }
    }
    
    const index = await getOrCreateIndex(accountEmail);
    
    // Serialize index for storage
    let serializedIndex = null;
    try {
      if (index.export) {
        serializedIndex = index.export();
      } else {
        // Fallback: save index metadata
        serializedIndex = { metadata: { messageCount: chatsToIndex.length } };
      }
    } catch (e) {
      console.error('Error serializing index:', e);
      serializedIndex = {};
    }
    
    await saveIndex(accountEmail, serializedIndex);
    
    await updateAccount(accountEmail, { lastIndexedUTC: toUTCString() });
    
    // Закрываем переиспользуемую вкладку после завершения индексации
    if (reusableTab && reusableTab.id) {
      try {
        // Проверяем, что вкладка еще существует перед закрытием
        await chrome.tabs.get(reusableTab.id);
        await chrome.tabs.remove(reusableTab.id);
        console.log(`startIndexing: Closed reusable tab after indexing completion`);
      } catch (e) {
        // Вкладка уже была закрыта или не существует
        console.log(`startIndexing: Reusable tab already closed or doesn't exist:`, e.message);
      }
      reusableTab = null;
      reusableTabCreated = false;
    }
    
    // Очищаем состояние индексации после успешного завершения
    await clearIndexingState(accountEmail);
    
    chrome.runtime.sendMessage({
      type: 'INDEX_DONE',
      accountEmail,
      indexedCount: successCount,
      totalCount: allChats.length,
      errorCount: errorCount,
      errors: errors.length > 0 ? errors : undefined
    }).catch(() => {});
    
    return { 
      indexedCount: successCount, 
      totalCount: allChats.length,
      errorCount: errorCount,
      errors: errors.length > 0 ? errors : undefined
    };
  } catch (error) {
    console.error('Error during indexing:', error);
    
    // Сохраняем состояние при ошибке, чтобы можно было возобновить
    const errorMsg = error.message || String(error);
    const isConnectionError = errorMsg.includes('потери соединения') ||
                              errorMsg.includes('Could not establish connection');
    
    if (isConnectionError) {
      // Состояние уже сохранено в цикле
      chrome.runtime.sendMessage({
        type: 'INDEX_PAUSED',
        accountEmail,
        error: errorMsg,
        canResume: true
      }).catch(() => {});
    } else {
    chrome.runtime.sendMessage({
      type: 'INDEX_ERROR',
        error: errorMsg
    }).catch(() => {});
    }
    
    throw error;
  } finally {
    // Всегда сбрасываем флаги индексации в конце, даже при ошибке
    isIndexingActive = false;
    shouldStopIndexing = false;
  }
}

// ========== Export/Import/Reset Functions ==========
// Maximum message size for Chrome Extension messaging (64MB, but use 50MB for safety)
const MAX_MESSAGE_SIZE = 50 * 1024 * 1024; // 50MB

// Helper function to estimate JSON size
function estimateJSONSize(obj) {
  try {
    return JSON.stringify(obj).length;
  } catch (e) {
    // If stringify fails, return a large number to trigger direct download
    return MAX_MESSAGE_SIZE + 1;
  }
}

// Note: ZIP creation is done in popup.js where JSZip library is available
// Background script cannot load JSZip due to CSP restrictions in service worker

// Helper function to download file directly using chrome.downloads API
async function downloadFileDirectly(filename, data) {
  return new Promise((resolve, reject) => {
    try {
      // Sanitize data first with context
      const sanitizedData = sanitizeForSerialization(data, new WeakSet(), 0, {
        operation: 'directDownload',
        filename: filename
      });
      const jsonString = JSON.stringify(sanitizedData, null, 2);
      
      // Create data URL (base64 encoded)
      // Note: Data URLs have a size limit (~2MB in some browsers), but for larger files
      // we'll use a workaround with blob URL in the same context
      const base64Data = btoa(unescape(encodeURIComponent(jsonString)));
      const dataUrl = `data:application/json;base64,${base64Data}`;
      
      // Check if data URL is too large (some browsers limit data URLs to ~2MB)
      // For larger files, we need to use a different approach
      const fileSizeMB = jsonString.length / 1024 / 1024;
      if (dataUrl.length > 2 * 1024 * 1024) {
        // For very large files, recommend using by_parts strategy
        throw new Error(
          `Файл слишком большой для прямого скачивания (${fileSizeMB.toFixed(2)} MB). ` +
          `Рекомендуется использовать стратегию "По частям" (by_parts) с большим количеством частей. ` +
          `Попробуйте экспортировать с ${Math.ceil(fileSizeMB / 2)} частями или больше.`
        );
      }
      
      // Use chrome.downloads API to download the file
      chrome.downloads.download({
        url: dataUrl,
        filename: filename,
        saveAs: true
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          console.log(`Export: Started download ${filename} with ID ${downloadId}`);
          resolve(downloadId);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

// Helper function to sanitize data for JSON serialization
// Removes non-serializable objects (functions, circular references, etc.)
// context: { chatId, messageId, fieldName } - для детального логирования
function sanitizeForSerialization(obj, visited = new WeakSet(), depth = 0, context = {}) {
  // Prevent infinite recursion
  if (depth > 100) {
    const contextInfo = context.chatId ? ` (chatId: ${context.chatId}${context.messageId ? `, messageId: ${context.messageId}` : ''})` : '';
    console.error(`[Serialization] Max depth reached${contextInfo}`);
    return '[Max Depth Reached]';
  }
  
  // Handle null and undefined
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  // Handle primitive types
  const objType = typeof obj;
  if (objType !== 'object' && objType !== 'function') {
    return obj;
  }
  
  // Handle Date objects
  if (obj instanceof Date) {
    return obj.toISOString();
  }
  
  // Handle RegExp objects
  if (obj instanceof RegExp) {
    return obj.toString();
  }
  
  // Handle Error objects
  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: obj.message,
      stack: obj.stack
    };
  }
  
  // Skip functions
  if (objType === 'function') {
    const contextInfo = context.chatId ? ` (chatId: ${context.chatId}${context.messageId ? `, messageId: ${context.messageId}` : ''}${context.fieldName ? `, field: ${context.fieldName}` : ''})` : '';
    console.warn(`[Serialization] Skipping function${contextInfo}`);
    return undefined;
  }
  
  // Skip non-serializable objects like Map, Set, WeakMap, WeakSet
  if (obj instanceof Map || obj instanceof Set || 
      obj instanceof WeakMap || obj instanceof WeakSet) {
    const objTypeName = obj.constructor.name;
    const contextInfo = context.chatId ? ` (chatId: ${context.chatId}${context.messageId ? `, messageId: ${context.messageId}` : ''}${context.fieldName ? `, field: ${context.fieldName}` : ''})` : '';
    console.warn(`[Serialization] Skipping ${objTypeName}${contextInfo}`);
    return undefined;
  }
  
  // Handle arrays
  if (Array.isArray(obj)) {
    const sanitized = [];
    const arrayContext = { ...context, isArray: true };
    
    for (let i = 0; i < obj.length; i++) {
      try {
        const itemContext = { ...arrayContext, arrayIndex: i };
        const item = sanitizeForSerialization(obj[i], visited, depth + 1, itemContext);
        if (item !== undefined) {
          sanitized.push(item);
        }
      } catch (e) {
        const contextInfo = context.chatId ? ` (chatId: ${context.chatId}${context.messageId ? `, messageId: ${context.messageId}` : ''}, array index: ${i})` : ` (array index: ${i})`;
        console.error(`[Serialization] Failed to sanitize array item${contextInfo}:`, e);
        console.error(`[Serialization] Item type: ${typeof obj[i]}, constructor: ${obj[i]?.constructor?.name || 'unknown'}`);
        // Continue with next item
      }
    }
    return sanitized;
  }
  
  // Handle circular references
  if (visited.has(obj)) {
    const contextInfo = context.chatId ? ` (chatId: ${context.chatId}${context.messageId ? `, messageId: ${context.messageId}` : ''}${context.fieldName ? `, field: ${context.fieldName}` : ''})` : '';
    console.warn(`[Serialization] Circular reference detected${contextInfo}`);
    return '[Circular Reference]';
  }
  visited.add(obj);
  
  // Handle objects - try to identify if it's a message or chat
  let objectType = 'object';
  let objectId = null;
  if (obj.chatId) {
    objectType = 'chat';
    objectId = obj.chatId;
  } else if (obj.id && (obj.role === 'user' || obj.role === 'assistant')) {
    objectType = 'message';
    objectId = obj.id;
  }
  
  const currentContext = {
    ...context,
    chatId: objectId && objectType === 'chat' ? objectId : (context.chatId || (obj.chatId ? obj.chatId : null)),
    messageId: objectId && objectType === 'message' ? objectId : (context.messageId || (obj.id ? obj.id : null)),
    objectType: objectType
  };
  
  const sanitized = {};
  const skippedFields = [];
  const errorFields = [];
  
  try {
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        try {
          const value = obj[key];
          const fieldContext = { ...currentContext, fieldName: key };
          
          // Skip functions
          if (typeof value === 'function') {
            skippedFields.push({ field: key, reason: 'function' });
            continue;
          }
          
          // Check for non-serializable types
          if (value instanceof Map || value instanceof Set || 
              value instanceof WeakMap || value instanceof WeakSet) {
            skippedFields.push({ 
              field: key, 
              reason: value.constructor.name,
              type: typeof value
            });
            continue;
          }
          
          // Recursively sanitize value
          const sanitizedValue = sanitizeForSerialization(value, visited, depth + 1, fieldContext);
          if (sanitizedValue !== undefined) {
            sanitized[key] = sanitizedValue;
          } else {
            skippedFields.push({ 
              field: key, 
              reason: 'returned undefined',
              valueType: typeof value,
              valueConstructor: value?.constructor?.name
            });
          }
        } catch (e) {
          // If serialization fails for a property, skip it
          errorFields.push({
            field: key,
            error: e.message,
            errorType: e.constructor.name,
            valueType: typeof obj[key],
            valueConstructor: obj[key]?.constructor?.name
          });
          
          const contextInfo = currentContext.chatId ? 
            ` (chatId: ${currentContext.chatId}${currentContext.messageId ? `, messageId: ${currentContext.messageId}` : ''}, field: ${key})` : 
            ` (field: ${key})`;
          console.error(`[Serialization] Failed to sanitize property${contextInfo}:`, e);
          console.error(`[Serialization] Property value type: ${typeof obj[key]}, constructor: ${obj[key]?.constructor?.name || 'unknown'}`);
          if (obj[key] && typeof obj[key] === 'object') {
            console.error(`[Serialization] Property value keys:`, Object.keys(obj[key]).slice(0, 10));
          }
          continue;
        }
      }
    }
    
    // Log summary if there were issues
    if (skippedFields.length > 0 || errorFields.length > 0) {
      const contextInfo = currentContext.chatId ? 
        `chatId: ${currentContext.chatId}${currentContext.messageId ? `, messageId: ${currentContext.messageId}` : ''}` : 
        'unknown object';
      
      if (skippedFields.length > 0) {
        console.warn(`[Serialization] Skipped ${skippedFields.length} field(s) in ${contextInfo}:`, skippedFields);
      }
      if (errorFields.length > 0) {
        console.error(`[Serialization] Errors in ${errorFields.length} field(s) in ${contextInfo}:`, errorFields);
      }
    }
  } catch (e) {
    const contextInfo = currentContext.chatId ? 
      ` (chatId: ${currentContext.chatId}${currentContext.messageId ? `, messageId: ${currentContext.messageId}` : ''})` : '';
    console.error(`[Serialization] Error during object sanitization${contextInfo}:`, e);
    console.error(`[Serialization] Object keys:`, Object.keys(obj).slice(0, 20));
    return { error: 'Failed to sanitize object', context: contextInfo };
  } finally {
    visited.delete(obj);
  }
  
  return sanitized;
}

// Helper function to sanitize account email for filename
function sanitizeAccountForFilename(accountEmail) {
  if (!accountEmail) {
    return 'unknown';
  }
  return accountEmail
    .replace(/[/\\:*?"<>|@\s]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

// Helper function to get month key from date string
function getMonthKey(dateString) {
  if (!dateString) {
    return null;
  }
  
  try {
    const date = new Date(dateString);
    
    // Check if date is valid
    if (isNaN(date.getTime())) {
      return null;
    }
    
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const monthKey = `${year}_${month}`;
    
    return monthKey;
  } catch (e) {
    return null;
  }
}

// Helper function to get date string for filename (YYYY-MM-DD)
function getDateStringForFilename(date = new Date()) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Split data by months
function splitDataByMonths(accounts, chats, messages, indexes, accountEmail) {
  const sanitizedAccount = sanitizeAccountForFilename(accountEmail || 'unknown');
  const files = [];
  
  console.log(`splitDataByMonths: Starting with ${messages.length} messages, ${chats.length} chats`);
  
  // Group chats by month based on their updatedAtUTC (date of last modification)
  // This is the actual date when the chat was last updated, not the indexing date
  const chatsByMonth = new Map();
  const chatIdsByMonth = new Map();
  let skippedChats = 0;
  const monthKeySamples = new Map(); // Store sample timestamps for debugging
  
  // Debug: Check chat update dates distribution
  const sampleDates = chats.slice(0, Math.min(10, chats.length)).map(c => c.updatedAtUTC);
  console.log(`splitDataByMonths: Sample chat update dates (first 10):`, sampleDates);
  
  // Check date range of all chats
  const allDates = chats
    .map(c => c.updatedAtUTC ? new Date(c.updatedAtUTC) : null)
    .filter(d => d && !isNaN(d.getTime()))
    .sort((a, b) => a - b);
  
  if (allDates.length > 0) {
    const minDate = allDates[0];
    const maxDate = allDates[allDates.length - 1];
    console.log(`splitDataByMonths: Chat update date range: ${minDate.toISOString()} to ${maxDate.toISOString()}`);
    console.log(`splitDataByMonths: Time span: ${Math.round((maxDate - minDate) / (1000 * 60 * 60 * 24))} days`);
  }
  
  // Group chats by month based on updatedAtUTC
  for (const chat of chats) {
    const monthKey = getMonthKey(chat.updatedAtUTC);
    if (!monthKey) {
      skippedChats++;
      console.warn(`splitDataByMonths: Skipped chat with invalid updatedAtUTC: ${chat.updatedAtUTC}, chatId: ${chat.chatId}`);
      continue;
    }
    
    if (!chatsByMonth.has(monthKey)) {
      chatsByMonth.set(monthKey, []);
      chatIdsByMonth.set(monthKey, new Set());
      monthKeySamples.set(monthKey, chat.updatedAtUTC);
      console.log(`splitDataByMonths: New month key found: ${monthKey} from chat updatedAtUTC: ${chat.updatedAtUTC}`);
    }
    chatsByMonth.get(monthKey).push(chat);
    chatIdsByMonth.get(monthKey).add(chat.chatId);
  }
  
  console.log(`splitDataByMonths: Grouped chats into ${chatsByMonth.size} months, skipped ${skippedChats} chats`);
  console.log(`splitDataByMonths: Month keys found:`, Array.from(chatsByMonth.keys()));
  
  // Log sample dates for each month
  for (const [monthKey, sampleDate] of monthKeySamples.entries()) {
    console.log(`splitDataByMonths: Month ${monthKey} sample date: ${sampleDate}, chats: ${chatsByMonth.get(monthKey).length}`);
  }
  
  // Get all unique month keys and sort them chronologically
  // This will include all months from all years where chats were updated
  const allMonthKeys = Array.from(chatsByMonth.keys()).sort((a, b) => {
    // Compare year_month format: "2025_12" vs "2026_01" or "2026_01" vs "2026_02"
    const [yearA, monthA] = a.split('_').map(Number);
    const [yearB, monthB] = b.split('_').map(Number);
    if (yearA !== yearB) return yearA - yearB;
    return monthA - monthB;
  });
  
  console.log(`splitDataByMonths: Processing ${chats.length} chats total`);
  console.log(`splitDataByMonths: Found ${allMonthKeys.length} unique months across all years: ${allMonthKeys.join(', ')}`);
  
  // Create a file for each month that has chats
  // Messages are included based on which chat they belong to
  for (const monthKey of allMonthKeys) {
    const monthChats = chatsByMonth.get(monthKey) || [];
    const monthChatIds = chatIdsByMonth.get(monthKey) || new Set();
    
    // Skip months with no chats (should not happen due to filtering above, but safety check)
    if (monthChats.length === 0) {
      console.log(`splitDataByMonths: Skipping ${monthKey} - no chats`);
      continue;
    }
    
    // Get messages that belong to chats in this month
    const monthMessages = messages.filter(msg => monthChatIds.has(msg.chatId));
    
    // Include all accounts and indexes in each file (they are shared)
    const filename = `copilot_ind_${sanitizedAccount}_${monthKey}.json`;
    
    console.log(`splitDataByMonths: Creating file for ${monthKey}: ${monthMessages.length} messages, ${monthChats.length} chats`);
    
    files.push({
      filename,
      data: {
        accounts,
        chats: monthChats,
        messages: monthMessages,
        indexes,
        exportDate: toUTCString(),
        version: '1.0',
        monthKey
      }
    });
  }
  
  console.log(`splitDataByMonths: Created ${files.length} files total for export`);
  console.log(`splitDataByMonths: File names:`, files.map(f => f.filename).join(', '));
  
  return files;
}

// Split data into N parts
function splitDataIntoParts(accounts, chats, messages, indexes, partsCount, accountEmail) {
  const sanitizedAccount = sanitizeAccountForFilename(accountEmail || 'unknown');
  const dateStr = getDateStringForFilename();
  const files = [];
  
  console.log(`splitDataIntoParts: Starting split into ${partsCount} parts`);
  console.log(`splitDataIntoParts: Total messages: ${messages.length}, chats: ${chats.length}`);
  
  // Sort messages by timestamp for consistent splitting
  const sortedMessages = [...messages].sort((a, b) => {
    const dateA = new Date(a.timestampUTC || 0);
    const dateB = new Date(b.timestampUTC || 0);
    return dateA - dateB;
  });
  
  // Calculate sizes
  const messagesPerPart = Math.ceil(sortedMessages.length / partsCount);
  console.log(`splitDataIntoParts: Messages per part: ${messagesPerPart}`);
  
  // Create chat ID sets for each part to track which chats belong to which part
  const chatIdsByPart = [];
  
  for (let i = 0; i < partsCount; i++) {
    const startMsg = i * messagesPerPart;
    const endMsg = Math.min(startMsg + messagesPerPart, sortedMessages.length);
    const partMessages = sortedMessages.slice(startMsg, endMsg);
    
    console.log(`splitDataIntoParts: Part ${i + 1}/${partsCount}: messages ${startMsg} to ${endMsg} (${partMessages.length} messages)`);
    
    // Collect chat IDs from messages in this part
    const partChatIds = new Set();
    for (const msg of partMessages) {
      if (msg.chatId) {
        partChatIds.add(msg.chatId);
      }
    }
    
    chatIdsByPart.push(partChatIds);
    
    // Get chats that have messages in this part
    const partChats = chats.filter(chat => partChatIds.has(chat.chatId));
    
    // Include all accounts and indexes in each file (they are shared)
    const partNumber = String(i + 1).padStart(2, '0');
    const filename = `copilot_ind_${sanitizedAccount}_${dateStr}_${partNumber}.json`;
    
    const fileData = {
      filename,
      data: {
        accounts,
        chats: partChats,
        messages: partMessages,
        indexes,
        exportDate: toUTCString(),
        version: '1.0',
        partNumber: i + 1,
        totalParts: partsCount
      }
    };
    
    files.push(fileData);
    console.log(`splitDataIntoParts: Created part ${i + 1}: ${filename} with ${partMessages.length} messages, ${partChats.length} chats`);
  }
  
  console.log(`splitDataIntoParts: Created ${files.length} files total`);
  return files;
}

async function exportDatabase(strategy = 'single', partsCount = null) {
  const db = await initDB();
  
  const accounts = await new Promise((resolve, reject) => {
    const transaction = db.transaction(['accounts'], 'readonly');
    const store = transaction.objectStore('accounts');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  
  const chats = await new Promise((resolve, reject) => {
    const transaction = db.transaction(['chats'], 'readonly');
    const store = transaction.objectStore('chats');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  
  const messages = await new Promise((resolve, reject) => {
    const transaction = db.transaction(['messages'], 'readonly');
    const store = transaction.objectStore('messages');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  
  const indexes = await new Promise((resolve, reject) => {
    const transaction = db.transaction(['indexes'], 'readonly');
    const store = transaction.objectStore('indexes');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  
  // Get account email for filename
  const accountEmail = accounts.length > 0 ? accounts[0].email : null;
  
  console.log(`exportDatabase: Strategy: ${strategy}, Messages: ${messages.length}, Chats: ${chats.length}, AccountEmail: ${accountEmail}`);
  
  if (strategy === 'single') {
    return {
      accounts,
      chats,
      messages,
      indexes,
      exportDate: toUTCString(),
      version: '1.0'
    };
  } else if (strategy === 'by_month') {
    console.log(`exportDatabase: Calling splitDataByMonths with ${messages.length} messages`);
    const files = splitDataByMonths(accounts, chats, messages, indexes, accountEmail);
    console.log(`exportDatabase: splitDataByMonths returned ${files.length} files`);
    
    // Verify files array
    if (!Array.isArray(files)) {
      console.error('exportDatabase: splitDataByMonths did not return an array!', typeof files);
      throw new Error('splitDataByMonths returned invalid data');
    }
    
    if (files.length === 0) {
      console.warn('exportDatabase: splitDataByMonths returned 0 files!');
    }
    
    // Log each file that will be returned
    files.forEach((f, i) => {
      console.log(`exportDatabase: File ${i + 1}: ${f.filename}, messages: ${f.data?.messages?.length || 0}`);
    });
    
    return { files };
  } else if (strategy === 'by_parts') {
    const count = partsCount || 2;
    const files = splitDataIntoParts(accounts, chats, messages, indexes, count, accountEmail);
    return { files };
  } else {
    throw new Error(`Unknown export strategy: ${strategy}`);
  }
}

// Helper function to get all data from database
async function getAllDatabaseData() {
  const db = await initDB();
  
  const accounts = await new Promise((resolve, reject) => {
    const transaction = db.transaction(['accounts'], 'readonly');
    const store = transaction.objectStore('accounts');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  
  const chats = await new Promise((resolve, reject) => {
    const transaction = db.transaction(['chats'], 'readonly');
    const store = transaction.objectStore('chats');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  
  const messages = await new Promise((resolve, reject) => {
    const transaction = db.transaction(['messages'], 'readonly');
    const store = transaction.objectStore('messages');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  
  const indexes = await new Promise((resolve, reject) => {
    const transaction = db.transaction(['indexes'], 'readonly');
    const store = transaction.objectStore('indexes');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  
  return { accounts, chats, messages, indexes };
}

// Merge imported data with existing database
async function mergeDatabase(existingData, importData, mergeStrategy) {
  const db = await initDB();
  const stats = {
    accountsAdded: 0,
    accountsUpdated: 0,
    chatsAdded: 0,
    chatsMerged: 0,
    chatsKept: 0,
    messagesAdded: 0,
    messagesRemoved: 0,
    indexesMerged: 0
  };
  
  // Create maps for quick lookup
  const existingChatIds = new Set(existingData.chats.map(c => c.chatId));
  const existingAccountEmails = new Set(existingData.accounts.map(a => a.email));
  const existingIndexByAccount = new Map();
  existingData.indexes.forEach(idx => {
    if (idx.accountEmail) {
      existingIndexByAccount.set(idx.accountEmail, idx);
    }
  });
  
  // Determine conflicting chat IDs
  const conflictingChatIds = new Set();
  importData.chats.forEach(chat => {
    if (existingChatIds.has(chat.chatId)) {
      conflictingChatIds.add(chat.chatId);
    }
  });
  
  // Merge accounts (add new, update existing)
  for (const account of importData.accounts) {
    const exists = existingAccountEmails.has(account.email);
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(['accounts'], 'readwrite');
      const store = transaction.objectStore('accounts');
      const request = store.put(account);
      request.onsuccess = () => {
        if (exists) {
          stats.accountsUpdated++;
        } else {
          stats.accountsAdded++;
        }
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  }
  
  // Merge chats based on strategy
  for (const chat of importData.chats) {
    const isConflict = conflictingChatIds.has(chat.chatId);
    
    if (isConflict) {
      // Apply merge strategy
      if (mergeStrategy === 'keep_current') {
        // Skip this chat, keep existing
        stats.chatsKept++;
        continue;
      } else if (mergeStrategy === 'keep_imported') {
        // Replace existing chat
        await new Promise((resolve, reject) => {
          const transaction = db.transaction(['chats'], 'readwrite');
          const store = transaction.objectStore('chats');
          const request = store.put(chat);
          request.onsuccess = () => {
            stats.chatsMerged++;
            resolve();
          };
          request.onerror = () => reject(request.error);
        });
        
        // Remove existing messages for this chat
        const existingMessages = existingData.messages.filter(m => m.chatId === chat.chatId);
        for (const msg of existingMessages) {
          await new Promise((resolve, reject) => {
            const transaction = db.transaction(['messages'], 'readwrite');
            const store = transaction.objectStore('messages');
            const request = store.delete(msg.id);
            request.onsuccess = () => {
              stats.messagesRemoved++;
              resolve();
            };
            request.onerror = () => reject(request.error);
          });
        }
      }
    } else {
      // New chat, add it
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(['chats'], 'readwrite');
        const store = transaction.objectStore('chats');
        const request = store.put(chat);
        request.onsuccess = () => {
          stats.chatsAdded++;
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
    }
  }
  
  // Merge messages
  // If keep_current strategy, skip messages for conflicting chats
  const chatsToSkipMessages = mergeStrategy === 'keep_current' ? conflictingChatIds : new Set();
  
  for (const message of importData.messages) {
    if (chatsToSkipMessages.has(message.chatId)) {
      continue; // Skip messages for chats we're keeping current version
    }
    
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(['messages'], 'readwrite');
      const store = transaction.objectStore('messages');
      const request = store.put(message);
      request.onsuccess = () => {
        stats.messagesAdded++;
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  }
  
  // Merge indexes by accountEmail
  for (const importIndex of importData.indexes) {
    if (!importIndex.accountEmail) continue;
    
    const existingIndex = existingIndexByAccount.get(importIndex.accountEmail);
    
    if (existingIndex) {
      // Merge index data - combine documents and termIndex
      try {
        // Try to merge index data if it's in export format
        const existingIndexData = existingIndex.flexIndexJSON || existingIndex;
        const importIndexData = importIndex.flexIndexJSON || importIndex;
        
        // For now, we'll keep the existing index and add new documents from import
        // This is a simplified merge - full index merge would require rebuilding
        // Just update the index with import data (replace strategy for indexes)
        await new Promise((resolve, reject) => {
          const transaction = db.transaction(['indexes'], 'readwrite');
          const store = transaction.objectStore('indexes');
          const request = store.put(importIndex);
          request.onsuccess = () => {
            stats.indexesMerged++;
            resolve();
          };
          request.onerror = () => reject(request.error);
        });
      } catch (e) {
        console.error('Error merging index:', e);
        // Fallback: just replace
        await new Promise((resolve, reject) => {
          const transaction = db.transaction(['indexes'], 'readwrite');
          const store = transaction.objectStore('indexes');
          const request = store.put(importIndex);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      }
    } else {
      // New index, add it
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(['indexes'], 'readwrite');
        const store = transaction.objectStore('indexes');
        const request = store.put(importIndex);
        request.onsuccess = () => {
          stats.indexesMerged++;
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
    }
  }
  
  return stats;
}

async function importDatabase(data, mergeStrategy = 'replace') {
  // Проверка наличия данных
  if (!data) {
    throw new Error('Данные для импорта отсутствуют. Файл пуст или поврежден.');
  }
  
  // Проверка, что data - это объект
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Данные для импорта отсутствуют. Файл пуст или поврежден.');
  }
  
  // Проверка структуры данных
  const missingFields = [];
  if (!data.accounts) missingFields.push('accounts');
  if (!data.chats) missingFields.push('chats');
  if (!data.messages) missingFields.push('messages');
  if (!data.indexes) missingFields.push('indexes');
  
  if (missingFields.length > 0) {
    throw new Error(`Неверный формат данных импорта. Отсутствуют обязательные поля: ${missingFields.join(', ')}. Убедитесь, что файл был экспортирован из этого расширения.`);
  }
  
  // Проверка типов данных
  if (!Array.isArray(data.accounts)) {
    throw new Error('Неверный формат данных: поле "accounts" должно быть массивом.');
  }
  if (!Array.isArray(data.chats)) {
    throw new Error('Неверный формат данных: поле "chats" должно быть массивом.');
  }
  if (!Array.isArray(data.messages)) {
    throw new Error('Неверный формат данных: поле "messages" должно быть массивом.');
  }
  if (!Array.isArray(data.indexes)) {
    throw new Error('Неверный формат данных: поле "indexes" должно быть массивом.');
  }
  
  // Предупреждение о пустых данных (но не ошибка, так как это может быть валидный экспорт пустой базы)
  const isEmpty = data.accounts.length === 0 && data.chats.length === 0 && 
                  data.messages.length === 0 && data.indexes.length === 0;
  if (isEmpty) {
    console.warn('Import: Importing empty database. This is valid but will clear existing data.');
  }
  
  const db = await initDB();
  const hasExistingData = await checkHasData();
  
  // If no existing data or explicit replace strategy, do full replace
  if (!hasExistingData || mergeStrategy === 'replace') {
    // Clear existing data
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(['accounts', 'chats', 'messages', 'indexes'], 'readwrite');
      
      transaction.objectStore('accounts').clear();
      transaction.objectStore('chats').clear();
      transaction.objectStore('messages').clear();
      transaction.objectStore('indexes').clear();
      
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    
    // Import accounts
    try {
      for (let i = 0; i < data.accounts.length; i++) {
        const account = data.accounts[i];
        await new Promise((resolve, reject) => {
          const transaction = db.transaction(['accounts'], 'readwrite');
          // Set up transaction handlers before making requests
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(new Error(`Ошибка транзакции при импорте аккаунта ${i + 1}/${data.accounts.length}: ${transaction.error?.message || 'Неизвестная ошибка'}`));
          
          const store = transaction.objectStore('accounts');
          const request = store.put(account);
          request.onsuccess = () => {
            // Request succeeded, transaction will complete automatically
          };
          request.onerror = () => reject(new Error(`Ошибка импорта аккаунта ${i + 1}/${data.accounts.length}: ${request.error?.message || 'Неизвестная ошибка'}`));
        });
      }
    } catch (error) {
      throw new Error(`Ошибка при импорте аккаунтов: ${error.message}`);
    }
    
    // Import chats
    try {
      for (let i = 0; i < data.chats.length; i++) {
        const chat = data.chats[i];
        await new Promise((resolve, reject) => {
          const transaction = db.transaction(['chats'], 'readwrite');
          // Set up transaction handlers before making requests
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(new Error(`Ошибка транзакции при импорте чата ${i + 1}/${data.chats.length}: ${transaction.error?.message || 'Неизвестная ошибка'}`));
          
          const store = transaction.objectStore('chats');
          const request = store.put(chat);
          request.onsuccess = () => {
            // Request succeeded, transaction will complete automatically
          };
          request.onerror = () => reject(new Error(`Ошибка импорта чата ${i + 1}/${data.chats.length} (ID: ${chat.chatId || 'неизвестен'}): ${request.error?.message || 'Неизвестная ошибка'}`));
        });
      }
    } catch (error) {
      throw new Error(`Ошибка при импорте чатов: ${error.message}`);
    }
    
    // Import messages
    try {
      for (let i = 0; i < data.messages.length; i++) {
        const message = data.messages[i];
        await new Promise((resolve, reject) => {
          const transaction = db.transaction(['messages'], 'readwrite');
          // Set up transaction handlers before making requests
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(new Error(`Ошибка транзакции при импорте сообщения ${i + 1}/${data.messages.length}: ${transaction.error?.message || 'Неизвестная ошибка'}`));
          
          const store = transaction.objectStore('messages');
          const request = store.put(message);
          request.onsuccess = () => {
            // Request succeeded, transaction will complete automatically
          };
          request.onerror = () => reject(new Error(`Ошибка импорта сообщения ${i + 1}/${data.messages.length}: ${request.error?.message || 'Неизвестная ошибка'}`));
        });
      }
    } catch (error) {
      throw new Error(`Ошибка при импорте сообщений: ${error.message}`);
    }
    
    // Import indexes
    try {
      for (let i = 0; i < data.indexes.length; i++) {
        const indexData = data.indexes[i];
        await new Promise((resolve, reject) => {
          const transaction = db.transaction(['indexes'], 'readwrite');
          // Set up transaction handlers before making requests
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(new Error(`Ошибка транзакции при импорте индекса ${i + 1}/${data.indexes.length}: ${transaction.error?.message || 'Неизвестная ошибка'}`));
          
          const store = transaction.objectStore('indexes');
          const request = store.put(indexData);
          request.onsuccess = () => {
            // Request succeeded, transaction will complete automatically
          };
          request.onerror = () => reject(new Error(`Ошибка импорта индекса ${i + 1}/${data.indexes.length}: ${request.error?.message || 'Неизвестная ошибка'}`));
        });
      }
    } catch (error) {
      throw new Error(`Ошибка при импорте индексов: ${error.message}`);
    }
  } else {
    // Merge mode
    const existingData = await getAllDatabaseData();
    await mergeDatabase(existingData, data, mergeStrategy);
  }
  
  // Verify that data was saved correctly
  const verifyData = await checkHasData();
  if (!verifyData && (data.chats && data.chats.length > 0)) {
    console.warn('Import: Warning - data may not have been saved correctly. Verification failed.');
  }
  
  // Clear index cache to force reload
  indexCache.clear();
  
  console.log('Import: Database import completed successfully. Data persisted to IndexedDB.');
}

async function resetAccountData(accountEmail) {
  const db = await initDB();
  
  // Delete chats
  const chats = await getChatsByAccount(accountEmail);
  for (const chat of chats) {
    await deleteMessagesByChat(chat.chatId);
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(['chats'], 'readwrite');
      const store = transaction.objectStore('chats');
      const request = store.delete(chat.chatId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
  
  // Clear from cache FIRST (before deleting from DB)
  // This ensures that any subsequent search won't use cached index
  const wasInCache = indexCache.has(accountEmail);
  indexCache.delete(accountEmail);
  console.log(`Reset: Cleared index cache for ${accountEmail} (was in cache: ${wasInCache})`);
  
  // Delete index from database
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(['indexes'], 'readwrite');
    const store = transaction.objectStore('indexes');
    const request = store.delete(accountEmail);
    request.onsuccess = () => {
      console.log(`Reset: Deleted index from database for ${accountEmail}`);
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
  
  // Delete account
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(['accounts'], 'readwrite');
    const store = transaction.objectStore('accounts');
    const request = store.delete(accountEmail);
    request.onsuccess = () => {
      console.log(`Reset: Deleted account ${accountEmail} from database`);
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
  
  // Double-check: ensure cache is cleared (in case it was re-added somehow)
  if (indexCache.has(accountEmail)) {
    console.warn(`Reset: WARNING! Index still in cache after reset for ${accountEmail}, removing again`);
    indexCache.delete(accountEmail);
  }
}

async function checkHasData() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['chats'], 'readonly');
    const store = transaction.objectStore('chats');
    const request = store.count();
    request.onsuccess = () => resolve(request.result > 0);
    request.onerror = () => reject(request.error);
  });
}

// ========== Message Handlers ==========
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'START_INDEXING') {
    const accountEmail = request.accountEmail;
    const incremental = request.incremental || false;
    const resume = request.resume || false;
    const selectedChatIds = request.selectedChatIds || null;
    
    startIndexing(accountEmail, incremental, resume, true, selectedChatIds)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    
    return true;
  }
  
  if (request.type === 'RESUME_INDEXING') {
    const accountEmail = request.accountEmail;
    
    startIndexing(accountEmail, false, true) // resume = true
      .then(result => sendResponse({ success: true, ...result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    
    return true;
  }
  
  if (request.type === 'STOP_INDEXING') {
    shouldStopIndexing = true;
    sendResponse({ success: true });
    return true;
  }
  
  if (request.type === 'CHAT_CONTENT') {
    const { chatId, messages } = request;
    
    Promise.all(messages.map(msg => createMessage(msg)))
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    
    return true;
  }
  
  if (request.type === 'SEARCH') {
    const { accountEmail, query } = request;
    
    // Ищем по всем аккаунтам, если не указан конкретный
    const searchAllAccounts = !accountEmail;
    
    Promise.resolve()
      .then(async () => {
        let allAccounts = [];
        if (searchAllAccounts) {
          // Получаем все аккаунты из базы
          allAccounts = await getAllAccounts();
        } else {
          // Ищем только по указанному аккаунту
          const account = await getAccount(accountEmail);
          if (account) {
            allAccounts = [account];
          }
        }
        
        if (allAccounts.length === 0) {
          sendResponse({ success: true, results: [] });
          return;
        }
        
        // Ищем во всех индексах аккаунтов
        const allResults = [];
        const accountIndexMap = new Map(); // Для отслеживания, какой аккаунт соответствует какому индексу
        
        for (const account of allAccounts) {
          const email = account.email;
          if (!email) continue;
          
          try {
            // Double-check that account still exists (in case it was deleted during search)
            const accountStillExists = await getAccount(email);
            if (!accountStillExists) {
              console.log(`Search: Account ${email} was deleted, skipping search`);
              // Remove from cache if it exists
              if (indexCache.has(email)) {
                indexCache.delete(email);
              }
              continue;
            }
            
            const index = await getOrCreateIndex(email);
            
            // Verify index is not empty (should have documents if account exists)
            // If index is empty, skip it (account might have been reset)
            const indexSize = index.documents?.size || 0;
            if (indexSize === 0) {
              console.log(`Search: Index for ${email} is empty, skipping search`);
              continue;
            }
            
            const results = index.search(query, { limit: 1000, enrich: true });
            
            // Сохраняем связь между результатами и аккаунтом
            for (const result of results) {
              result._accountEmail = email; // Временно сохраняем email аккаунта
              allResults.push(result);
            }
          } catch (error) {
            console.warn(`Error searching in index for account ${email}:`, error);
            // Remove from cache on error
            if (indexCache.has(email)) {
              indexCache.delete(email);
            }
          }
        }
        
        // Группируем результаты по chatId
        const chatIds = [...new Set(allResults.map(r => r.chatId))];
        const chats = await Promise.all(chatIds.map(id => getChat(id)));
        const chatMap = new Map(chats.map(c => [c.chatId, c]));
        
        const searchResults = [];
        const resultMap = new Map();
        
        for (const result of allResults) {
          const chat = chatMap.get(result.chatId);
          if (!chat) continue;
          
          // Определяем accountEmail: сначала из чата, потом из результата поиска, потом fallback
          const resultAccountEmail = chat.accountEmail || result._accountEmail || accountEmail || null;
          
          if (!resultMap.has(result.chatId)) {
            resultMap.set(result.chatId, {
              chatId: result.chatId,
              title: chat.title,
              url: chat.url,
              updatedAtUTC: chat.updatedAtUTC,
              accountEmail: resultAccountEmail, // Добавляем email аккаунта для различения
              snippets: [],
              matchCount: 0 // Счетчик совпадений в чате
            });
          }
          
          const resultItem = resultMap.get(result.chatId);
          resultItem.matchCount++; // Увеличиваем счетчик совпадений
          
          // Ограничиваем количество сниппетов до 10
          if (resultItem.snippets.length >= 10) {
            continue; // Пропускаем, если уже есть 10 сниппетов
          }
          
          // Если это документ с названием чата, добавляем название как сниппет
          if (result.isChatTitle && result.title) {
            const highlightedTitle = highlightSearchTerms(result.title, query);
            const truncated = truncateHtml(highlightedTitle, 150);
            resultItem.snippets.push(`…${truncated}…`);
          } else if (result.text) {
            // Обычное сообщение - обрезаем до 150 символов
          const highlighted = highlightSearchTerms(result.text, query);
            const truncated = truncateHtml(highlighted, 150);
            resultItem.snippets.push(truncated);
          } else if (result.title && !result.isChatTitle) {
            // Сообщение с названием в title (для обратной совместимости)
            const highlighted = highlightSearchTerms(result.title, query);
            const truncated = truncateHtml(highlighted, 150);
            resultItem.snippets.push(truncated);
          }
        }
        
        // Сортируем результаты по дате обновления (свежие сверху, старые внизу)
        const sortedResults = Array.from(resultMap.values()).sort((a, b) => {
          const dateA = a.updatedAtUTC ? new Date(a.updatedAtUTC).getTime() : 0;
          const dateB = b.updatedAtUTC ? new Date(b.updatedAtUTC).getTime() : 0;
          return dateB - dateA; // Убывание: более свежие даты первыми
        });
        
        sendResponse({
          success: true,
          results: sortedResults
        });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    
    return true;
  }
  
  if (request.type === 'EXPORT_DB') {
    const strategy = request.strategy || 'single';
    const partsCount = request.partsCount || null;
    
    exportDatabase(strategy, partsCount)
      .then(async data => {
        if (strategy === 'by_month' || strategy === 'by_parts') {
          console.log(`Export: Created ${data.files?.length || 0} files for strategy ${strategy}`);
          if (data.files && data.files.length > 0) {
            console.log('Export: File names:', data.files.map(f => f.filename).join(', '));
          }
        }
        
        try {
          console.log('Export: Starting data sanitization...');
          console.log(`Export: Data contains ${data.accounts?.length || 0} account(s), ${data.chats?.length || 0} chat(s), ${data.messages?.length || 0} message(s)`);
          
          // Track problematic chats
          const problematicChats = new Map();
          
          // Try to sanitize with detailed error tracking
          let sanitizedData;
          try {
            sanitizedData = sanitizeForSerialization(data, new WeakSet(), 0, {
              strategy: strategy,
              accountCount: data.accounts?.length || 0,
              chatCount: data.chats?.length || 0,
              messageCount: data.messages?.length || 0
            });
            console.log('Export: Data sanitized successfully');
          } catch (sanitizeError) {
            console.error('Export: Sanitization failed:', sanitizeError);
            console.error('Export: Error stack:', sanitizeError.stack);
            
            // Try to identify problematic chats by checking messages
            if (data.messages && Array.isArray(data.messages)) {
              console.log(`Export: Checking ${data.messages.length} messages for serialization issues...`);
              const sampleSize = Math.min(100, data.messages.length);
              
              for (let msgIdx = 0; msgIdx < sampleSize; msgIdx++) {
                const msg = data.messages[msgIdx];
                try {
                  JSON.stringify(msg);
                } catch (msgError) {
                  const chatId = msg.chatId || 'unknown';
                  if (!problematicChats.has(chatId)) {
                    problematicChats.set(chatId, { errors: [], messageCount: 0, chatTitle: null });
                  }
                  const chatInfo = problematicChats.get(chatId);
                  chatInfo.errors.push({
                    messageId: msg.id,
                    error: msgError.message,
                    errorType: msgError.constructor.name,
                    role: msg.role,
                    textPreview: msg.text ? msg.text.substring(0, 100) : null
                  });
                  chatInfo.messageCount++;
                  
                  // Try to get chat title
                  if (!chatInfo.chatTitle && data.chats) {
                    const chat = data.chats.find(c => c.chatId === chatId);
                    if (chat) {
                      chatInfo.chatTitle = chat.title || chat.url || 'Untitled';
                    }
                  }
                  
                  console.error(`Export: Problematic message in chat ${chatId} (${chatInfo.chatTitle || 'unknown'}):`, {
                    messageId: msg.id,
                    role: msg.role,
                    error: msgError.message,
                    textPreview: msg.text ? msg.text.substring(0, 200) : null
                  });
                }
              }
              
              // Log summary
              if (problematicChats.size > 0) {
                console.error(`Export: Found ${problematicChats.size} problematic chat(s) out of ${sampleSize} checked messages:`);
                problematicChats.forEach((info, chatId) => {
                  console.error(`Export:   Chat: ${chatId} (${info.chatTitle || 'unknown'})`);
                  console.error(`Export:     - ${info.messageCount} problematic message(s)`);
                  console.error(`Export:     - First error: ${info.errors[0].errorType} - ${info.errors[0].error}`);
                  if (info.errors[0].textPreview) {
                    console.error(`Export:     - Message preview: ${info.errors[0].textPreview}`);
                  }
                });
              }
            }
            
            // Create detailed error message
            let errorMessage = `Serialization error: ${sanitizeError.message}`;
            if (problematicChats.size > 0) {
              errorMessage += `\n\nПроблемные чаты (${problematicChats.size}):\n`;
              problematicChats.forEach((info, chatId) => {
                errorMessage += `  - ${info.chatTitle || chatId}: ${info.messageCount} сообщение(й) с ошибками\n`;
                errorMessage += `    Причина: ${info.errors[0].errorType} - ${info.errors[0].error}\n`;
              });
            }
            
            throw new Error(errorMessage);
          }
          
          // Check if data is too large for messaging
          const dataSize = estimateJSONSize(sanitizedData);
          console.log(`Export: Estimated data size: ${(dataSize / 1024 / 1024).toFixed(2)} MB`);
          
          if (strategy === 'single') {
            // For single file, check if we need direct download
            if (dataSize > MAX_MESSAGE_SIZE) {
              console.log('Export: Data too large, using direct download...');
              const sanitizedAccount = sanitizeAccountForFilename(data.accounts?.[0]?.email || 'unknown');
              const dateStr = getDateStringForFilename();
              const filename = `copilot_ind_${sanitizedAccount}_${dateStr}.json`;
              
              try {
                await downloadFileDirectly(filename, sanitizedData);
                sendResponse({ 
                  success: true, 
                  directDownload: true,
                  filename: filename
                });
              } catch (downloadError) {
                console.error('Export: Direct download error:', downloadError);
                sendResponse({ 
                  success: false, 
                  error: `Download error: ${downloadError.message}` 
                });
              }
              return;
            }
            
            // Small enough to send via message
            sendResponse({ 
              success: true, 
              data: sanitizedData
            });
            return;
          }
          
          // For multiple files (by_month or by_parts)
          if (data.files && Array.isArray(data.files)) {
            console.log(`Export: Processing ${data.files.length} files...`);
            console.log(`Export: File names from exportDatabase:`, data.files.map(f => f.filename));
            const sanitizedFiles = [];
            const filesToDownload = [];
            const problematicChats = new Map(); // Map<chatId, {errors: [], messages: []}>
            
            for (let i = 0; i < data.files.length; i++) {
              try {
                const file = data.files[i];
                console.log(`Export: Processing file ${i + 1}/${data.files.length}: ${file.filename}`);
                
                // Collect chat IDs from this file for context
                const chatIdsInFile = new Set();
                if (file.data?.chats) {
                  file.data.chats.forEach(chat => {
                    if (chat.chatId) chatIdsInFile.add(chat.chatId);
                  });
                }
                if (file.data?.messages) {
                  file.data.messages.forEach(msg => {
                    if (msg.chatId) chatIdsInFile.add(msg.chatId);
                  });
                }
                
                console.log(`Export: File ${i + 1} contains ${chatIdsInFile.size} unique chat(s), ${file.data?.messages?.length || 0} message(s)`);
                
                // Try to sanitize with detailed error tracking
                let sanitizedFileData;
                try {
                  sanitizedFileData = sanitizeForSerialization(file.data, new WeakSet(), 0, {
                    fileIndex: i,
                    filename: file.filename,
                    chatCount: chatIdsInFile.size
                  });
                } catch (sanitizeError) {
                  console.error(`Export: Sanitization failed for file ${i + 1} (${file.filename}):`, sanitizeError);
                  console.error(`Export: File contains ${file.data?.chats?.length || 0} chats, ${file.data?.messages?.length || 0} messages`);
                  
                  // Try to identify problematic chats
                  if (file.data?.messages) {
                    console.log(`Export: Checking messages for serialization issues...`);
                    for (let msgIdx = 0; msgIdx < Math.min(10, file.data.messages.length); msgIdx++) {
                      const msg = file.data.messages[msgIdx];
                      try {
                        JSON.stringify(msg);
                      } catch (msgError) {
                        const chatId = msg.chatId || 'unknown';
                        if (!problematicChats.has(chatId)) {
                          problematicChats.set(chatId, { errors: [], messages: [] });
                        }
                        problematicChats.get(chatId).errors.push({
                          messageId: msg.id,
                          error: msgError.message,
                          errorType: msgError.constructor.name
                        });
                        problematicChats.get(chatId).messages.push({
                          id: msg.id,
                          role: msg.role,
                          textLength: msg.text?.length || 0
                        });
                        console.error(`Export: Problematic message in chat ${chatId}, messageId: ${msg.id}:`, msgError);
                      }
                    }
                  }
                  
                  throw sanitizeError;
                }
                
                const fileSize = estimateJSONSize(sanitizedFileData);
                
                if (fileSize > MAX_MESSAGE_SIZE) {
                  console.log(`Export: File ${i + 1} (${file.filename}) too large (${(fileSize / 1024 / 1024).toFixed(2)} MB), will download directly`);
                  filesToDownload.push({
                    index: i,
                    filename: file.filename,
                    data: sanitizedFileData
                  });
                } else {
                  sanitizedFiles.push({
                    filename: file.filename,
                    data: sanitizedFileData
                  });
                }
                
                if ((i + 1) % 5 === 0) {
                  console.log(`Export: Processed ${i + 1}/${data.files.length} files...`);
                }
              } catch (fileError) {
                console.error(`Export: Error processing file ${i + 1} (${data.files[i]?.filename}):`, fileError);
                console.error(`Export: Error stack:`, fileError.stack);
                
                // Log problematic chats if found
                if (problematicChats.size > 0) {
                  console.error(`Export: Found ${problematicChats.size} problematic chat(s):`);
                  problematicChats.forEach((info, chatId) => {
                    console.error(`Export: Chat ${chatId}: ${info.errors.length} error(s), ${info.messages.length} message(s) affected`);
                    info.errors.forEach(err => {
                      console.error(`Export:   - Message ${err.messageId}: ${err.errorType} - ${err.error}`);
                    });
                  });
                }
                
                // Skip this file but continue with others
              }
            }
            
            // Log summary of problematic chats
            if (problematicChats.size > 0) {
              console.error(`Export: Summary - ${problematicChats.size} chat(s) have serialization issues:`);
              problematicChats.forEach((info, chatId) => {
                console.error(`Export:   Chat ${chatId}: ${info.errors.length} message(s) with errors`);
              });
            }
            
            // Combine all files (both small and large)
            const allFiles = [
              ...sanitizedFiles,
              ...filesToDownload.map(f => ({
                filename: f.filename,
                data: f.data
              }))
            ];
            
            console.log(`Export: Combined files - sanitized: ${sanitizedFiles.length}, toDownload: ${filesToDownload.length}, total: ${allFiles.length}`);
            console.log(`Export: All file names:`, allFiles.map(f => f.filename));
            
            // Calculate total size
            let totalSize = 0;
            for (const file of allFiles) {
              totalSize += estimateJSONSize(file);
            }
            
            const totalSizeMB = totalSize / 1024 / 1024;
            console.log(`Export: Total size of ${allFiles.length} files: ${totalSizeMB.toFixed(2)} MB`);
            
            // Log each file's size
            allFiles.forEach((file, idx) => {
              const fileSize = estimateJSONSize(file);
              const fileSizeMB = fileSize / 1024 / 1024;
              console.log(`Export: File ${idx + 1}: ${file.filename} - ${fileSizeMB.toFixed(2)} MB, ${file.data?.messages?.length || 0} messages, part ${file.data?.partNumber || 'N/A'}/${file.data?.totalParts || 'N/A'}`);
            });
            
            // If total size exceeds limit, we need to split or use alternative approach
            // Since ZIP creation in background script has issues, we'll send files to popup.js
            // where JSZip already works, or split into smaller chunks
            if (totalSize > MAX_MESSAGE_SIZE) {
              console.log(`Export: Total size (${totalSizeMB.toFixed(2)} MB) exceeds message limit`);
              
              // Strategy: Send files in chunks that fit within message limit
              // Each chunk will be processed separately in popup.js
              const chunks = [];
              let currentChunk = [];
              let currentChunkSize = 0;
              
              for (const file of allFiles) {
                const fileSize = estimateJSONSize(file);
                
                // If single file is too large, we can't send it
                if (fileSize > MAX_MESSAGE_SIZE) {
                  console.warn(`Export: File ${file.filename} (${(fileSize / 1024 / 1024).toFixed(2)} MB) is too large to send`);
                  // Try to download it directly (may be blocked by browser)
                  try {
                    await downloadFileDirectly(file.filename, file.data);
                    console.log(`Export: Downloaded large file ${file.filename} directly`);
                  } catch (downloadError) {
                    console.error(`Export: Failed to download ${file.filename}:`, downloadError);
                  }
                  continue;
                }
                
                // Check if adding this file would exceed chunk limit
                if (currentChunkSize + fileSize > MAX_MESSAGE_SIZE && currentChunk.length > 0) {
                  chunks.push(currentChunk);
                  currentChunk = [];
                  currentChunkSize = 0;
                }
                
                currentChunk.push(file);
                currentChunkSize += fileSize;
              }
              
              // Add remaining chunk
              if (currentChunk.length > 0) {
                chunks.push(currentChunk);
              }
              
              console.log(`Export: Split ${allFiles.length} files into ${chunks.length} chunk(s) for transmission`);
              
              // If we have multiple chunks, we need to send them all
              // Flatten all chunks into a single array of files
              const allFilesFromChunks = chunks.flat();
              console.log(`Export: Flattened ${chunks.length} chunks into ${allFilesFromChunks.length} files`);
              
              // Check if all files from chunks fit in one message
              let chunkTotalSize = 0;
              for (const file of allFilesFromChunks) {
                chunkTotalSize += estimateJSONSize(file);
              }
              const chunkTotalSizeMB = chunkTotalSize / 1024 / 1024;
              
              if (chunkTotalSize <= MAX_MESSAGE_SIZE) {
                // All files fit - send them all
                console.log(`Export: All ${allFilesFromChunks.length} files fit in message (${chunkTotalSizeMB.toFixed(2)} MB), sending all...`);
                sendResponse({ 
                  success: true, 
                  files: allFilesFromChunks,
                  directDownloadCount: 0,
                  needsZipCreation: true,
                  message: `Отправлено ${allFilesFromChunks.length} файл(ов) для создания ZIP архива`
                });
              } else {
                // Files don't fit - send first chunk and indicate more chunks needed
                console.warn(`Export: Files don't fit in one message (${chunkTotalSizeMB.toFixed(2)} MB), sending first chunk only`);
                sendResponse({ 
                  success: true, 
                  files: chunks[0] || [],
                  directDownloadCount: 0,
                  totalChunks: chunks.length,
                  currentChunk: 0,
                  totalFiles: allFilesFromChunks.length,
                  needsZipCreation: true,
                  message: `Файлы слишком большие. Отправлена первая часть (${chunks[0]?.length || 0} из ${allFilesFromChunks.length} файлов). Попробуйте использовать больше частей при экспорте.`
                });
              }
            } else if (allFiles.length > 1 || filesToDownload.length > 0) {
              // Multiple files but total size is OK - send ALL files to popup.js for ZIP creation
              console.log(`Export: Sending ${allFiles.length} files to popup.js for ZIP creation (total size: ${totalSizeMB.toFixed(2)} MB)...`);
              console.log(`Export: Files breakdown - sanitized: ${sanitizedFiles.length}, to download: ${filesToDownload.length}, total: ${allFiles.length}`);
              sendResponse({ 
                success: true, 
                files: allFiles, // Send ALL files (both sanitized and those marked for download)
                directDownloadCount: 0, // All files will be in ZIP, no direct downloads needed
                needsZipCreation: true, // Signal popup.js to create ZIP
                message: `Отправлено ${allFiles.length} файл(ов) для создания ZIP архива`
              });
            } else {
              // Single small file - send via message
              console.log(`Export: Sending response with ${sanitizedFiles.length} files via message (total size: ${totalSizeMB.toFixed(2)} MB)...`);
              sendResponse({ 
                success: true, 
                files: sanitizedFiles,
                directDownloadCount: 0
              });
            }
          } else {
            sendResponse({ 
              success: true, 
              files: []
            });
          }
        } catch (serializationError) {
          console.error('Export: Serialization error:', serializationError);
          console.error('Export: Error stack:', serializationError.stack);
          
          // Extract detailed error information
          let errorMessage = serializationError.message || 'Unknown serialization error';
          let errorDetails = '';
          
          // Check if error message contains chat information
          if (serializationError.message && serializationError.message.includes('Проблемные чаты')) {
            errorDetails = serializationError.message;
          } else {
            // Try to provide more context
            errorDetails = `Ошибка сериализации: ${errorMessage}`;
            if (data?.chats?.length) {
              errorDetails += `\nВсего чатов: ${data.chats.length}`;
            }
            if (data?.messages?.length) {
              errorDetails += `\nВсего сообщений: ${data.messages.length}`;
            }
          }
          
          sendResponse({ 
            success: false, 
            error: errorDetails,
            errorType: 'serialization',
            chatCount: data?.chats?.length || 0,
            messageCount: data?.messages?.length || 0
          });
        }
      })
      .catch(error => {
        console.error('Export error:', error);
        console.error('Export error stack:', error.stack);
        sendResponse({ 
          success: false, 
          error: error.message || 'Unknown export error',
          errorType: 'export'
        });
      });
    
    return true;
  }
  
  if (request.type === 'EXPORT_MD') {
    (async () => {
      try {
        const { chatIds, accountEmail } = request;
        
        if (!chatIds || !Array.isArray(chatIds) || chatIds.length === 0) {
          sendResponse({ success: false, error: 'No chat IDs provided' });
          return;
        }
        
        if (!accountEmail) {
          sendResponse({ success: false, error: 'Account email not provided' });
          return;
        }
        
        // Get chats data from DB (only for URLs and titles)
        const chatsData = [];
        for (const chatId of chatIds) {
          try {
            const chat = await getChat(chatId);
            if (!chat) {
              console.warn(`Chat ${chatId} not found, skipping`);
              continue;
            }
            chatsData.push({ chatId, chat });
          } catch (error) {
            console.error(`Error getting chat ${chatId}:`, error);
          }
        }
        
        // Open each chat in a new tab and extract HTML directly
        const exportData = [];
        
        for (const { chatId, chat } of chatsData) {
          let tab = null;
          try {
            console.log(`Export MD: Opening chat ${chatId} in new tab...`);
            
            // Open chat in new tab
            tab = await chrome.tabs.create({
              url: chat.url || `https://copilot.microsoft.com/chats/${chatId}`,
              active: false // Open in background
            });
            
            // Wait for page to load
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Wait for content to be ready
            let loadRetries = 10;
            while (loadRetries > 0) {
              try {
                const tabInfo = await chrome.tabs.get(tab.id);
                if (tabInfo.status === 'complete') {
                  // Wait a bit more for content to render
                  await new Promise(resolve => setTimeout(resolve, 2000));
                  break;
                }
                await new Promise(resolve => setTimeout(resolve, 500));
              } catch (e) {
                throw new Error('Tab was closed during loading');
              }
              loadRetries--;
            }
            
            // Request HTML content from content script
            let response = null;
            let retries = 5;
            while (retries > 0) {
              try {
                response = await chrome.tabs.sendMessage(tab.id, {
                  action: 'getChatContentWithHtml',
                  chatId: chatId
                });
                if (response && response.success) {
                  break;
                }
              } catch (e) {
                // Content script might not be ready yet
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
              retries--;
            }
            
            if (response && response.success && response.messages) {
              exportData.push({
                chatId: chatId,
                chat: chat,
                messages: response.messages
              });
              console.log(`Export MD: Successfully extracted ${response.messages.length} messages from chat ${chatId}`);
            } else {
              console.warn(`Export MD: Failed to extract messages from chat ${chatId}`);
              // Still add chat with empty messages
              exportData.push({
                chatId: chatId,
                chat: chat,
                messages: []
              });
            }
          } catch (error) {
            console.error(`Export MD: Error processing chat ${chatId}:`, error);
            // Still add chat even if extraction failed
            exportData.push({
              chatId: chatId,
              chat: chat,
              messages: []
            });
          } finally {
            // Close the tab
            if (tab && tab.id) {
              try {
                await chrome.tabs.remove(tab.id);
              } catch (e) {
                console.warn(`Export MD: Failed to close tab ${tab.id}:`, e);
              }
            }
          }
        }
        
        sendResponse({
          success: true,
          data: exportData
        });
      } catch (error) {
        console.error('Export MD error:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    
    return true;
  }
  
  if (request.type === 'IMPORT_DB') {
    const mergeStrategy = request.mergeStrategy || 'replace';
    
    // Проверка наличия данных перед вызовом importDatabase
    if (!request.data) {
      sendResponse({ 
        success: false, 
        error: 'Данные для импорта отсутствуют. Файл пуст или поврежден.' 
      });
      return true;
    }
    
    // Логирование для отладки
    console.log('Import: Received data type:', typeof request.data);
    console.log('Import: Has accounts:', !!request.data.accounts);
    console.log('Import: Has chats:', !!request.data.chats);
    console.log('Import: Has messages:', !!request.data.messages);
    console.log('Import: Has indexes:', !!request.data.indexes);
    
    importDatabase(request.data, mergeStrategy)
      .then(() => sendResponse({ success: true }))
      .catch(error => {
        console.error('Import error:', error);
        sendResponse({ success: false, error: error.message });
      });
    
    return true;
  }
  
  if (request.type === 'CHECK_IMPORT_CONFLICTS') {
    (async () => {
      try {
        const hasData = await checkHasData();
        if (!hasData) {
          sendResponse({ success: true, hasConflicts: false, conflictCount: 0 });
          return;
        }
        
        if (!request.data || !request.data.chats) {
          sendResponse({ success: true, hasConflicts: false, conflictCount: 0 });
          return;
        }
        
        const existingData = await getAllDatabaseData();
        const existingChatIds = new Set(existingData.chats.map(c => c.chatId));
        const importChatIds = new Set(request.data.chats.map(c => c.chatId));
        
        let conflictCount = 0;
        importChatIds.forEach(chatId => {
          if (existingChatIds.has(chatId)) {
            conflictCount++;
          }
        });
        
        sendResponse({ 
          success: true, 
          hasConflicts: conflictCount > 0, 
          conflictCount 
        });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    
    return true;
  }
  
  if (request.type === 'RESET_DB') {
    resetAccountData(request.accountEmail)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    
    return true;
  }
  
  if (request.type === 'CHECK_DATA') {
    checkHasData()
      .then(hasData => sendResponse({ success: true, hasData }))
      .catch(error => sendResponse({ success: false, hasData: false, error: error.message }));
    
    return true;
  }
  
  if (request.type === 'GET_ACCOUNTS') {
    (async () => {
      try {
        const db = await initDB();
        const accounts = await new Promise((resolve, reject) => {
          const transaction = db.transaction(['accounts'], 'readonly');
          const store = transaction.objectStore('accounts');
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
        });
        
        // Для каждого аккаунта получаем количество индексированных чатов
        const accountsWithChats = await Promise.all(accounts.map(async (account) => {
          const chats = await getChatsByAccount(account.email);
          // Считаем только индексированные чаты (те, у которых есть lastIndexedUTC)
          const indexedChats = chats.filter(chat => chat.lastIndexedUTC !== null && chat.lastIndexedUTC !== undefined);
          return {
            email: account.email,
            chatCount: indexedChats.length,
            lastIndexedUTC: account.lastIndexedUTC
          };
        }));
        
        sendResponse({ success: true, accounts: accountsWithChats });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }
  
  if (request.type === 'GET_DIAGNOSTICS') {
    getDatabaseDiagnostics(request.accountEmail)
      .then(diagnostics => sendResponse({ success: true, diagnostics }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    
    return true;
  }
  
  if (request.type === 'GET_CHATS_FOR_SELECTION') {
    (async () => {
      try {
        const { accountEmail } = request;
        const chats = await getChatsByAccount(accountEmail);
        
        // Фильтруем только чаты с названием (не "Без названия")
        const chatsWithTitle = chats.filter(chat => 
          chat.title && chat.title.trim() && chat.title.trim() !== 'Без названия'
        );
        
        // Форматируем для отправки
        const formattedChats = chatsWithTitle.map(chat => ({
          chatId: chat.chatId,
          title: chat.title,
          updatedAtUTC: chat.updatedAtUTC,
          lastIndexedUTC: chat.lastIndexedUTC,
          isIndexed: !!chat.lastIndexedUTC
        }));
        
        sendResponse({ success: true, chats: formattedChats });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }
  
  return false;
});

