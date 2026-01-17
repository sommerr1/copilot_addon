const requestListEl = document.getElementById("requestList");
const detailsBodyEl = document.getElementById("detailsBody");
const emptyStateEl = document.getElementById("emptyState");
const clearBtn = document.getElementById("clearBtn");
const getAccountBtn = document.getElementById("getAccountBtn");
const statusEl = document.getElementById("status");

const requestMap = new Map();
let activeRequestId = null;
let port = null;
let currentTabId = null;
let copilotAccountEmail = null;

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

function decodeJWT(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    
    // Декодируем payload JWT токена
    let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    // Добавляем padding если нужно
    while (base64.length % 4) {
      base64 += "=";
    }
    
    const payload = JSON.parse(atob(base64));
    return payload;
  } catch (error) {
    return null;
  }
}

function extractAccountInfo(record) {
  const accountInfo = {
    email: null,
    name: null,
    userId: null
  };

  // Проверяем заголовки запроса
  if (record.requestHeaders && Array.isArray(record.requestHeaders)) {
    for (const header of record.requestHeaders) {
      const name = (header.name || "").toLowerCase();
      const value = header.value || "";
      
      if (!value) continue;
      
      // Ищем информацию в различных заголовках Microsoft
      if (name.includes("user") && name.includes("email")) {
        accountInfo.email = value;
      }
      if (name.includes("user") && name.includes("name")) {
        accountInfo.name = value;
      }
      if (name.includes("user") && (name.includes("id") || name.includes("oid"))) {
        accountInfo.userId = value;
      }
      
      // Проверяем специфичные заголовки Microsoft
      if (name === "x-ms-client-request-id" || name === "x-request-id") {
        // Эти заголовки могут содержать информацию, но обычно нет
      }
      
      // Пытаемся извлечь из Authorization header (JWT токен)
      if (name === "authorization") {
        if (value.startsWith("Bearer ")) {
          const token = value.substring(7).trim();
          const payload = decodeJWT(token);
          if (payload) {
            // Microsoft JWT токены обычно содержат:
            // - upn (User Principal Name) - email
            // - unique_name - email или имя
            // - name - полное имя
            // - given_name - имя
            // - family_name - фамилия
            // - oid - Object ID пользователя
            // - sub - Subject (обычно тот же oid)
            // - email - email (может отсутствовать)
            
            accountInfo.email = accountInfo.email || payload.email || payload.upn || payload.unique_name || payload.preferred_username;
            accountInfo.name = accountInfo.name || payload.name || payload.given_name || (payload.given_name && payload.family_name ? `${payload.given_name} ${payload.family_name}` : null);
            accountInfo.userId = accountInfo.userId || payload.oid || payload.sub || payload.user_id || payload.appid;
          }
        } else if (value.startsWith("Bearer%20")) {
          // URL-encoded Bearer token
          const token = decodeURIComponent(value.substring(8)).trim();
          const payload = decodeJWT(token);
          if (payload) {
            accountInfo.email = accountInfo.email || payload.email || payload.upn || payload.unique_name || payload.preferred_username;
            accountInfo.name = accountInfo.name || payload.name || payload.given_name;
            accountInfo.userId = accountInfo.userId || payload.oid || payload.sub || payload.user_id;
          }
        }
      }
    }
  }

  // Проверяем заголовки ответа
  if (record.responseHeaders && Array.isArray(record.responseHeaders)) {
    for (const header of record.responseHeaders) {
      const name = (header.name || "").toLowerCase();
      const value = header.value || "";
      
      if (!value) continue;
      
      if (name.includes("user") && name.includes("email")) {
        accountInfo.email = accountInfo.email || value;
      }
      if (name.includes("user") && name.includes("name")) {
        accountInfo.name = accountInfo.name || value;
      }
    }
  }

  // Рекурсивная функция для поиска информации об аккаунте в объектах
  function searchInObject(obj, depth = 0) {
    if (depth > 5 || !obj || typeof obj !== "object") {
      return;
    }
    
    // Проверяем прямые поля
    const keys = Object.keys(obj);
    for (const key of keys) {
      const lowerKey = key.toLowerCase();
      const value = obj[key];
      
      if (typeof value === "string" && value) {
        // Проверяем, что значение похоже на email или содержит @
        const looksLikeEmail = value.includes("@") && value.includes(".");
        
        if ((lowerKey === "email" || lowerKey === "upn" || lowerKey === "unique_name" || lowerKey === "preferred_username" || lowerKey === "mail" || (lowerKey.includes("email") && looksLikeEmail)) && !accountInfo.email) {
          accountInfo.email = value;
        }
        if ((lowerKey === "name" || lowerKey === "displayname" || lowerKey === "display_name" || lowerKey === "given_name" || lowerKey === "fullname" || lowerKey === "full_name") && !accountInfo.name && !value.includes("@")) {
          accountInfo.name = value;
        }
        if ((lowerKey === "userid" || lowerKey === "user_id" || lowerKey === "oid" || lowerKey === "id" || lowerKey === "sub" || lowerKey === "objectid") && !accountInfo.userId) {
          accountInfo.userId = value;
        }
      }
      
      // Рекурсивно ищем в вложенных объектах
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        searchInObject(value, depth + 1);
      } else if (Array.isArray(value)) {
        // Для массивов проверяем первый элемент
        if (value.length > 0 && typeof value[0] === "object") {
          searchInObject(value[0], depth + 1);
        }
      }
    }
    
    // Специальная обработка для известных структур Microsoft
    if (obj.user) {
      searchInObject(obj.user, depth + 1);
    }
    if (obj.account) {
      searchInObject(obj.account, depth + 1);
    }
    if (obj.identity) {
      searchInObject(obj.identity, depth + 1);
    }
    if (obj.principal) {
      searchInObject(obj.principal, depth + 1);
    }
  }

  // Проверяем тело запроса (JSON) - может содержать информацию об аккаунте
  if (record.requestBody) {
    try {
      let requestData = null;
      if (record.requestBody.text) {
        requestData = JSON.parse(record.requestBody.text);
      } else if (record.requestBody.raw) {
        try {
          requestData = JSON.parse(record.requestBody.raw);
        } catch (e) {
          // Может быть не JSON
        }
      } else if (typeof record.requestBody === "string") {
        requestData = JSON.parse(record.requestBody);
      } else if (typeof record.requestBody === "object") {
        requestData = record.requestBody;
      }

      if (requestData) {
        searchInObject(requestData);
      }
    } catch (error) {
      // Игнорируем ошибки парсинга
    }
  }

  if (record.responseBody) {
    try {
      let responseData = null;
      if (record.responseBody.text) {
        responseData = JSON.parse(record.responseBody.text);
      } else if (typeof record.responseBody === "string") {
        responseData = JSON.parse(record.responseBody);
      } else if (typeof record.responseBody === "object") {
        responseData = record.responseBody;
      }

      if (responseData) {
        searchInObject(responseData);
      }
    } catch (error) {
      // Игнорируем ошибки парсинга
    }
  }

  return accountInfo;
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

  // Извлекаем информацию об учетной записи
  const accountInfo = extractAccountInfo(record);
  
  // Отладочный вывод в консоль (можно убрать позже)
  console.log("Account info extracted:", accountInfo);
  if (!accountInfo.email && !accountInfo.name && !accountInfo.userId) {
    console.log("No account info found. Checking headers...");
    if (record.requestHeaders) {
      console.log("Request headers:", record.requestHeaders.map(h => `${h.name}: ${h.value?.substring(0, 50)}...`));
    }
    if (record.responseHeaders) {
      console.log("Response headers:", record.responseHeaders.map(h => `${h.name}: ${h.value?.substring(0, 50)}...`));
    }
  }

  const generalBody = document.createElement("div");
  generalBody.appendChild(createFieldRow("URL", record.url));
  generalBody.appendChild(createFieldRow("Method", record.method));
  generalBody.appendChild(createFieldRow("Type", record.type));
  generalBody.appendChild(createFieldRow("Time", formatTime(record.timeStamp)));
  generalBody.appendChild(createFieldRow("Initiator", record.initiator));
  
  // Добавляем информацию об учетной записи, если она найдена
  if (accountInfo.email || accountInfo.name || accountInfo.userId) {
    if (accountInfo.name) {
      generalBody.appendChild(createFieldRow("Account Name", accountInfo.name));
    }
    if (accountInfo.email) {
      generalBody.appendChild(createFieldRow("Account Email", accountInfo.email));
    }
    if (accountInfo.userId) {
      generalBody.appendChild(createFieldRow("User ID", accountInfo.userId));
    }
  } else {
    // Показываем сообщение, если информация не найдена
    const debugRow = document.createElement("div");
    debugRow.className = "details__field details__field--single";
    debugRow.style.color = "#999";
    debugRow.style.fontSize = "12px";
    debugRow.textContent = "Account info: Not found. Check console for details.";
    generalBody.appendChild(debugRow);
  }
  
  // Добавляем email из Copilot попапа, если он был получен
  if (copilotAccountEmail) {
    generalBody.appendChild(createFieldRow("Copilot Account Email", copilotAccountEmail));
  }
  
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

// Функция для получения информации об аккаунте Copilot
async function getCopilotAccountInfo() {
  setStatus("Поиск информации об аккаунте...");
  
  try {
    // Сначала проверяем сохраненное значение
    const stored = await chrome.storage.local.get(['copilotAccountEmail']);
    if (stored.copilotAccountEmail) {
      copilotAccountEmail = stored.copilotAccountEmail;
      setStatus(`Найден email: ${copilotAccountEmail}`);
      return { email: copilotAccountEmail, source: 'storage' };
    }

    // Ищем активную вкладку с Copilot
    const tabs = await chrome.tabs.query({ 
      url: "*://copilot.microsoft.com/*",
      active: true 
    });
    
    if (tabs.length === 0) {
      // Пробуем найти любую вкладку с Copilot
      const allCopilotTabs = await chrome.tabs.query({ 
        url: "*://copilot.microsoft.com/*" 
      });
      
      if (allCopilotTabs.length === 0) {
        setStatus("Откройте страницу Copilot для получения email");
        return { email: null, error: "No Copilot tab found" };
      }
      
      // Используем первую найденную вкладку
      const tabId = allCopilotTabs[0].id;
      
      // Отправляем сообщение в content script
      try {
        const response = await chrome.tabs.sendMessage(tabId, { action: 'getAccountInfo' });
        if (response && response.success && response.email) {
          copilotAccountEmail = response.email;
          // Сохраняем для быстрого доступа
          await chrome.storage.local.set({ copilotAccountEmail: response.email });
          setStatus(`Email найден: ${response.email}`);
          return { 
            email: response.email, 
            name: response.name || null,
            source: 'content_script' 
          };
        } else {
          // Если не нашли, пробуем кликнуть на кнопку аккаунта
          setStatus("Попытка открыть попап аккаунта...");
          const clickResponse = await chrome.tabs.sendMessage(tabId, { action: 'clickAccountButton' });
          if (clickResponse && clickResponse.success && clickResponse.email) {
            copilotAccountEmail = clickResponse.email;
            await chrome.storage.local.set({ copilotAccountEmail: clickResponse.email });
            setStatus(`Email найден: ${clickResponse.email}`);
            return { 
              email: clickResponse.email, 
              name: clickResponse.name || null,
              source: 'content_script_clicked' 
            };
          } else {
            setStatus("Email не найден. Убедитесь, что попап аккаунта открыт.");
            return { email: null, error: "Email not found in DOM" };
          }
        }
      } catch (error) {
        console.error("Ошибка при получении информации об аккаунте:", error);
        setStatus("Ошибка: " + (error.message || "Не удалось получить информацию"));
        return { email: null, error: error.message };
      }
    } else {
      // Используем активную вкладку
      const tabId = tabs[0].id;
      try {
        const response = await chrome.tabs.sendMessage(tabId, { action: 'getAccountInfo' });
        if (response && response.success && response.email) {
          copilotAccountEmail = response.email;
          await chrome.storage.local.set({ copilotAccountEmail: response.email });
          setStatus(`Email найден: ${response.email}`);
          return { 
            email: response.email, 
            name: response.name || null,
            source: 'content_script' 
          };
        } else {
          setStatus("Email не найден. Попробуйте кликнуть на кнопку аккаунта в Copilot.");
          return { email: null, error: "Email not found" };
        }
      } catch (error) {
        console.error("Ошибка:", error);
        setStatus("Ошибка: " + (error.message || "Не удалось получить информацию"));
        return { email: null, error: error.message };
      }
    }
  } catch (error) {
    console.error("Ошибка при получении информации об аккаунте:", error);
    setStatus("Ошибка: " + (error.message || "Не удалось получить информацию"));
    return { email: null, error: error.message };
  }
}

// Обработчик кнопки получения аккаунта
getAccountBtn.addEventListener("click", async () => {
  const accountInfo = await getCopilotAccountInfo();
  if (accountInfo.email) {
    // Показываем информацию в деталях, если есть активный запрос
    if (activeRequestId && requestMap.has(activeRequestId)) {
      const record = requestMap.get(activeRequestId);
      renderDetails(record);
    }
  }
});

clearBtn.addEventListener("click", () => {
  if (port) {
    port.postMessage({ type: "clear" });
  }
});

// Автоматически пытаемся получить email при загрузке popup
async function initAccountInfo() {
  try {
    const stored = await chrome.storage.local.get(['copilotAccountEmail']);
    if (stored.copilotAccountEmail) {
      copilotAccountEmail = stored.copilotAccountEmail;
    } else {
      // Пробуем получить автоматически, если открыта вкладка Copilot
      const tabs = await chrome.tabs.query({ url: "*://copilot.microsoft.com/*" });
      if (tabs.length > 0) {
        // Получаем в фоне, не показывая статус
        getCopilotAccountInfo().catch(() => {
          // Игнорируем ошибки при автоматической проверке
        });
      }
    }
  } catch (error) {
    // Игнорируем ошибки при инициализации
  }
}

setStatus("Connecting...");
connectToBackground();
port.postMessage({ type: "init_active" });
initAccountInfo();

