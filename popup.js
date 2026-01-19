// Popup script for Copilot Chat Indexer

let currentAccountEmail = null;
let searchTimeout = null;
let chatsData = [];
let selectedChatIds = new Set();
let chatCheckboxes = new Map();

// UI Elements
const tabIndex = document.getElementById('tabIndex');
const tabSearch = document.getElementById('tabSearch');
const tabRequests = document.getElementById('tabRequests');
const tabContentIndex = document.getElementById('tabContentIndex');
const tabContentSearch = document.getElementById('tabContentSearch');
const tabContentRequests = document.getElementById('tabContentRequests');
const indexControlBtn = document.getElementById('indexControlBtn');
const indexingInfo = document.getElementById('indexingInfo');
const resumeIndexBtn = document.getElementById('resumeIndexBtn');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importFile = document.getElementById('importFile');
const resetBtn = document.getElementById('resetBtn');
const indexProgress = document.getElementById('indexProgress');
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
const searchEmpty = document.getElementById('searchEmpty');
const statusEl = document.getElementById('status');
const diagnosticsBtn = document.getElementById('diagnosticsBtn');
const diagnosticsInfo = document.getElementById('diagnosticsInfo');
const refreshRequestsBtn = document.getElementById('refreshRequestsBtn');
const clearRequestsBtn = document.getElementById('clearRequestsBtn');
const requestsList = document.getElementById('requestsList');
const requestsEmpty = document.getElementById('requestsEmpty');
const requestsCount = document.getElementById('requestsCount');
const responseViewer = document.getElementById('responseViewer');
const responseViewerTitle = document.getElementById('responseViewerTitle');
const responseViewerContent = document.getElementById('responseViewerContent');
const closeResponseViewer = document.getElementById('closeResponseViewer');
const indexToggleBtn = document.getElementById('indexToggleBtn');
const indexingStats = document.getElementById('indexingStats');
const indexingContent = document.getElementById('indexingContent');
const chatsList = document.getElementById('chatsList');
const selectAllChats = document.getElementById('selectAllChats');
const sortBy = document.getElementById('sortBy');
const mergeDialog = document.getElementById('mergeDialog');
const mergeDialogCancel = document.getElementById('mergeDialogCancel');
const mergeDialogConfirm = document.getElementById('mergeDialogConfirm');
const conflictInfo = document.getElementById('conflictInfo');

// Tab switching
function switchTab(tabName) {
  // Remove active from all tabs
  tabIndex.classList.remove('active');
  tabSearch.classList.remove('active');
  tabRequests.classList.remove('active');
  tabContentIndex.classList.remove('active');
  tabContentSearch.classList.remove('active');
  tabContentRequests.classList.remove('active');
  
  // Add active to selected tab
  if (tabName === 'index') {
    tabIndex.classList.add('active');
    tabContentIndex.classList.add('active');
  } else if (tabName === 'search') {
    tabSearch.classList.add('active');
    tabContentSearch.classList.add('active');
    // Reset chat selection when leaving index tab
    resetChatSelection();
  } else if (tabName === 'requests') {
    tabRequests.classList.add('active');
    tabContentRequests.classList.add('active');
    loadRequests();
    // Reset chat selection when leaving index tab
    resetChatSelection();
  }
}

// Reset chat selection state
function resetChatSelection() {
  chatsData = [];
  selectedChatIds.clear();
  chatCheckboxes.clear();
  if (selectAllChats) {
    selectAllChats.checked = false;
    selectAllChats.indeterminate = false;
  }
  if (chatsList) {
    chatsList.innerHTML = '';
  }
  if (indexingContent) {
    indexingContent.classList.add('collapsed');
  }
}

if (tabIndex) tabIndex.addEventListener('click', () => switchTab('index'));
if (tabSearch) tabSearch.addEventListener('click', () => switchTab('search'));
if (tabRequests) tabRequests.addEventListener('click', () => switchTab('requests'));

// Status messages
function setStatus(message, isError = false) {
  if (!message) {
    statusEl.textContent = '';
    statusEl.classList.add('hidden');
    return;
  }
  statusEl.textContent = message;
  statusEl.classList.remove('hidden');
  if (isError) {
    statusEl.style.background = '#ffebee';
    statusEl.style.color = '#c62828';
  } else {
    statusEl.style.background = '#fff4eb';
    statusEl.style.color = '#9a3b00';
  }
}

// Get account email
async function getAccountEmail() {
  try {
    const stored = await chrome.storage.local.get(['copilotAccountEmail']);
    if (stored.copilotAccountEmail) {
      return stored.copilotAccountEmail;
    }
    
    const tabs = await chrome.tabs.query({ url: "*://copilot.microsoft.com/*" });
    if (tabs.length > 0) {
      const response = await chrome.tabs.sendMessage(tabs[0].id, { action: 'getAccountInfo' });
      if (response && response.success && response.email) {
        await chrome.storage.local.set({ copilotAccountEmail: response.email });
        return response.email;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error getting account email:', error);
    return null;
  }
}

// Check if database has data
async function hasData() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CHECK_DATA' });
    return response && response.hasData;
  } catch (error) {
    return false;
  }
}

// Requests management
let requestsPort = null;
let currentRequests = [];

async function loadRequests() {
  try {
    // Try to get active Copilot tab
    const tabs = await chrome.tabs.query({ url: "*://copilot.microsoft.com/*" });
    if (tabs.length === 0) {
      requestsList.innerHTML = '';
      requestsEmpty.textContent = 'Откройте страницу Copilot для отслеживания запросов';
      requestsEmpty.style.display = 'block';
      requestsCount.textContent = '';
      return;
    }
    
    const copilotTab = tabs[0];
    
    // Connect to background via port
    if (requestsPort) {
      requestsPort.disconnect();
    }
    
    requestsPort = chrome.runtime.connect({ name: 'popup' });
    
    // Initialize connection
    requestsPort.postMessage({ type: 'init_active', tabId: copilotTab.id });
    
    // Listen for messages
    requestsPort.onMessage.addListener((message) => {
      if (message.type === 'init') {
        currentRequests = message.records || [];
        renderRequests();
      } else if (message.type === 'request_added' || message.type === 'request_updated') {
        // Update or add request
        const index = currentRequests.findIndex(r => r.id === message.record.id);
        if (index >= 0) {
          currentRequests[index] = message.record;
        } else {
          currentRequests.unshift(message.record);
        }
        renderRequests();
      } else if (message.type === 'request_removed') {
        currentRequests = currentRequests.filter(r => r.id !== message.requestId);
        renderRequests();
      } else if (message.type === 'cleared') {
        currentRequests = [];
        renderRequests();
      }
    });
    
    requestsPort.onDisconnect.addListener(() => {
      requestsPort = null;
    });
    
  } catch (error) {
    console.error('Error loading requests:', error);
    setStatus('Ошибка загрузки запросов: ' + error.message, true);
  }
}

function renderRequests() {
  // Filter only conversations API requests
  const conversationsRequests = currentRequests.filter(req => {
    const url = req.url || '';
    const isConversationsRequest = url.includes('/c/api/conversations') || url.includes('history?api-version=2');
    
    if (!isConversationsRequest) {
      return false;
    }
    
    // Проверяем, является ли это запросом истории чата с пустым результатом
    const isHistoryRequest = url.includes('/history?api-version=2');
    if (isHistoryRequest && req.responseBody && req.responseBody.text) {
      try {
        const data = JSON.parse(req.responseBody.text);
        // Пропускаем запросы истории с пустыми результатами
        if (data.results && Array.isArray(data.results) && data.results.length === 0 && 
            (data.next === null || data.next === undefined)) {
          return false; // Пропускаем пустые ответы истории
        }
      } catch (e) {
        // Если не удалось распарсить, оставляем запрос (может быть не JSON)
      }
    }
    
    return true;
  });
  
  requestsCount.textContent = conversationsRequests.length > 0 
    ? `Найдено: ${conversationsRequests.length}` 
    : '';
  
  if (conversationsRequests.length === 0) {
    requestsList.innerHTML = '';
    requestsEmpty.style.display = 'block';
    return;
  }
  
  requestsEmpty.style.display = 'none';
  requestsList.innerHTML = conversationsRequests.map(req => {
    const url = req.url || 'Unknown URL';
    const method = req.method || 'GET';
    const status = req.statusCode || 'N/A';
    const hasResponse = req.responseBody && req.responseBody.text;
    const isError = status >= 400;
    const isSuccess = status >= 200 && status < 300;
    
    let itemClass = 'request-item';
    if (hasResponse && isSuccess) {
      itemClass += ' has-response';
    } else if (hasResponse && isError) {
      itemClass += ' error';
    } else if (!hasResponse) {
      itemClass += ' no-response';
    }
    
    return `
      <div class="${itemClass}" data-request-id="${req.id}">
        <div class="request-url" title="${url}">${url}</div>
        <div class="request-meta">
          <span class="request-method">${method}</span>
          <span class="request-status ${isSuccess ? 'success' : isError ? 'error' : ''}">${status}</span>
          ${hasResponse ? '<span>✓ Response</span>' : '<span>⏳ Waiting...</span>'}
        </div>
      </div>
    `;
  }).join('');
  
  // Add click handlers
  requestsList.querySelectorAll('.request-item').forEach(item => {
    item.addEventListener('click', () => {
      const requestId = item.dataset.requestId;
      const request = currentRequests.find(r => r.id === requestId);
      if (request && request.responseBody && request.responseBody.text) {
        showResponse(request);
      } else {
        setStatus('Response body еще не загружен', true);
      }
    });
  });
}

function showResponse(request) {
  const url = request.url || 'Unknown URL';
  const responseBody = request.responseBody;
  
  responseViewerTitle.textContent = url;
  
  let content = '';
  if (responseBody.text) {
    try {
      // Try to parse as JSON for pretty printing
      const json = JSON.parse(responseBody.text);
      content = JSON.stringify(json, null, 2);
    } catch (e) {
      // Not JSON, show as is
      content = responseBody.text;
    }
  } else {
    content = 'Response body is empty or not available';
  }
  
  responseViewerContent.textContent = content;
  responseViewer.classList.remove('hidden');
}

if (closeResponseViewer) {
  closeResponseViewer.addEventListener('click', () => {
    if (responseViewer) responseViewer.classList.add('hidden');
  });
}

// Close response viewer when clicking on background
if (responseViewer) {
  responseViewer.addEventListener('click', (e) => {
    if (e.target === responseViewer) {
      responseViewer.classList.add('hidden');
    }
  });
}

// Cleanup on popup close
window.addEventListener('beforeunload', () => {
  if (requestsPort) {
    requestsPort.disconnect();
  }
});

if (refreshRequestsBtn) {
  refreshRequestsBtn.addEventListener('click', () => {
    loadRequests();
  });
}

if (clearRequestsBtn) {
  clearRequestsBtn.addEventListener('click', async () => {
    if (requestsPort) {
      requestsPort.postMessage({ type: 'clear' });
    }
    currentRequests = [];
    renderRequests();
  });
}

// Initialize - determine which tab to show
async function init() {
  currentAccountEmail = await getAccountEmail();
  await checkIndexingState();
  
  if (!currentAccountEmail) {
    setStatus('Откройте страницу Copilot для определения аккаунта', true);
    switchTab('index');
    tabSearch.disabled = true;
    return;
  }
  
  // Initialize chat selection
  setupChatSelection();
  
  const hasDataResult = await hasData();
  if (hasDataResult) {
    switchTab('search');
    tabSearch.disabled = false;
  } else {
    switchTab('index');
    tabSearch.disabled = true;
  }
}

// Setup chat selection UI
function setupChatSelection() {
  // Toggle indexing section
  if (indexToggleBtn && indexingContent) {
    indexToggleBtn.addEventListener('click', () => {
      indexingContent.classList.toggle('collapsed');
      if (!indexingContent.classList.contains('collapsed')) {
        loadChatsForSelection();
      }
    });
  }
  
  // Select all checkbox
  if (selectAllChats) {
    selectAllChats.addEventListener('change', (e) => {
      const checked = e.target.checked;
      chatCheckboxes.forEach((checkbox, chatId) => {
        checkbox.checked = checked;
        if (checked) {
          selectedChatIds.add(chatId);
        } else {
          selectedChatIds.delete(chatId);
        }
      });
      updateSelectAllState();
    });
  }
  
  // Sort control
  if (sortBy) {
    sortBy.addEventListener('change', () => {
      renderChatsList();
    });
  }
  
  // Reset state on popup close
  window.addEventListener('beforeunload', () => {
    chatsData = [];
    selectedChatIds.clear();
    chatCheckboxes.clear();
  });
}

// Load chats for selection
async function loadChatsForSelection() {
  if (!currentAccountEmail) return;
  
  chatsList.innerHTML = '<div class="loading-chats">Загрузка чатов...</div>';
  
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_CHATS_FOR_SELECTION',
      accountEmail: currentAccountEmail
    });
    
    if (response.success && response.chats) {
      chatsData = response.chats;
      initializeChatSelection();
      renderChatsList();
      updateIndexingStats();
    } else {
      chatsList.innerHTML = '<div class="empty-chats">Ошибка загрузки чатов</div>';
    }
  } catch (error) {
    chatsList.innerHTML = `<div class="empty-chats">Ошибка: ${error.message}</div>`;
  }
}

// Initialize chat selection state
function initializeChatSelection() {
  selectedChatIds.clear();
  chatCheckboxes.clear();
  
  // По умолчанию все неиндексированные чаты выбраны, индексированные - нет
  chatsData.forEach(chat => {
    if (!chat.isIndexed) {
      selectedChatIds.add(chat.chatId);
    }
  });
}

// Render chats list
function renderChatsList() {
  if (!chatsList || chatsData.length === 0) {
    chatsList.innerHTML = '<div class="empty-chats">Нет чатов для индексации</div>';
    return;
  }
  
  // Sort chats
  const sortedChats = [...chatsData];
  const sortValue = sortBy.value;
  
  sortedChats.sort((a, b) => {
    switch (sortValue) {
      case 'date-desc':
        return new Date(b.updatedAtUTC || 0) - new Date(a.updatedAtUTC || 0);
      case 'date-asc':
        return new Date(a.updatedAtUTC || 0) - new Date(b.updatedAtUTC || 0);
      case 'checked':
        const aChecked = selectedChatIds.has(a.chatId);
        const bChecked = selectedChatIds.has(b.chatId);
        if (aChecked === bChecked) return 0;
        return aChecked ? -1 : 1;
      case 'unchecked':
        const aUnchecked = !selectedChatIds.has(a.chatId);
        const bUnchecked = !selectedChatIds.has(b.chatId);
        if (aUnchecked === bUnchecked) return 0;
        return aUnchecked ? -1 : 1;
      case 'alphabet':
        return (a.title || '').localeCompare(b.title || '', 'ru');
      default:
        return 0;
    }
  });
  
  // Render
  chatsList.innerHTML = '';
  sortedChats.forEach(chat => {
    const item = document.createElement('div');
    item.className = `chat-item ${chat.isIndexed ? 'indexed' : ''}`;
    
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'chat-checkbox';
    checkbox.id = `chat-${chat.chatId}`;
    checkbox.checked = selectedChatIds.has(chat.chatId);
    checkbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedChatIds.add(chat.chatId);
      } else {
        selectedChatIds.delete(chat.chatId);
      }
      updateSelectAllState();
    });
    
    chatCheckboxes.set(chat.chatId, checkbox);
    
    const info = document.createElement('div');
    info.className = 'chat-info';
    
    const title = document.createElement('div');
    title.className = 'chat-title';
    title.textContent = chat.title || 'Без названия';
    
    const date = document.createElement('div');
    date.className = 'chat-date';
    date.textContent = chat.updatedAtUTC ? formatDate(chat.updatedAtUTC) : 'Дата неизвестна';
    
    info.appendChild(title);
    info.appendChild(date);
    
    item.appendChild(checkbox);
    item.appendChild(info);
    chatsList.appendChild(item);
  });
  
  updateSelectAllState();
  updateIndexingStats();
}

// Update select all checkbox state
function updateSelectAllState() {
  if (!selectAllChats) return;
  
  const total = chatCheckboxes.size;
  const checked = Array.from(chatCheckboxes.values()).filter(cb => cb.checked).length;
  
  if (checked === 0) {
    selectAllChats.indeterminate = false;
    selectAllChats.checked = false;
  } else if (checked === total) {
    selectAllChats.indeterminate = false;
    selectAllChats.checked = true;
  } else {
    selectAllChats.indeterminate = true;
    selectAllChats.checked = false;
  }
}

// Update indexing statistics
function updateIndexingStats() {
  if (!indexingStats || !chatsData || chatsData.length === 0) {
    if (indexingStats) {
      indexingStats.textContent = '';
    }
    return;
  }
  
  const indexedCount = chatsData.filter(chat => chat.isIndexed).length;
  const notIndexedCount = chatsData.length - indexedCount;
  
  indexingStats.textContent = `${indexedCount}/${notIndexedCount}`;
}

// Diagnostics
if (diagnosticsBtn) {
  diagnosticsBtn.addEventListener('click', async () => {
    if (!currentAccountEmail) {
      setStatus('Аккаунт не определен. Попробуйте импортировать базу данных или откройте страницу Copilot.', true);
      return;
    }
    
    if (diagnosticsBtn) diagnosticsBtn.disabled = true;
    if (diagnosticsInfo) {
      diagnosticsInfo.classList.remove('hidden');
      diagnosticsInfo.innerHTML = 'Проверка состояния базы данных...';
    }
    
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_DIAGNOSTICS',
        accountEmail: currentAccountEmail
      });
      
      if (response && response.success && response.diagnostics) {
        const d = response.diagnostics;
        let html = '<div style="font-family: monospace; font-size: 12px; line-height: 1.6;">';
        html += `<strong>Диагностика базы данных:</strong><br/>`;
        html += `<br/>`;
        html += `Текущий аккаунт: <strong>${d.accountEmail || 'не указан'}</strong><br/>`;
        html += `Всего чатов в БД: <strong>${d.totalChats}</strong><br/>`;
        html += `Чатов для текущего аккаунта: <strong>${d.accountChats}</strong><br/>`;
        html += `Всего аккаунтов: <strong>${d.totalAccounts}</strong><br/>`;
        
        if (d.accounts && d.accounts.length > 0) {
          html += `<br/><strong>Аккаунты в БД:</strong><br/>`;
          for (const email of d.accounts) {
            const count = d.chatsByAccount[email] || 0;
            html += `  • ${email}: ${count} чатов<br/>`;
          }
        }
        
        if (d.totalChats === 0) {
          html += `<br/><span style="color: #c62828;"><strong>⚠ Проблема:</strong> В базе данных нет чатов.</span><br/>`;
          html += `<span style="color: #2e7d32;">✓ Решение: Откройте страницу Copilot и дождитесь загрузки списка чатов.</span>`;
        } else if (d.accountChats === 0) {
          html += `<br/><span style="color: #c62828;"><strong>⚠ Проблема:</strong> Чаты не найдены для текущего аккаунта.</span><br/>`;
          if (d.accounts && d.accounts.length > 0) {
            html += `<span style="color: #2e7d32;">✓ Решение: Используйте правильный email или откройте Copilot с нужным аккаунтом.</span>`;
          }
        } else {
          html += `<br/><span style="color: #2e7d32;">✓ База данных в порядке. Можно запускать индексацию.</span>`;
        }
        
        html += '</div>';
        if (diagnosticsInfo) diagnosticsInfo.innerHTML = html;
      } else {
        if (diagnosticsInfo) {
          diagnosticsInfo.innerHTML = `<span style="color: #c62828;">Ошибка: ${response?.error || 'Неизвестная ошибка'}</span>`;
        }
      }
    } catch (error) {
      console.error('Diagnostics error:', error);
      if (diagnosticsInfo) {
        diagnosticsInfo.innerHTML = `<span style="color: #c62828;">Ошибка: ${error.message}</span>`;
      }
    } finally {
      if (diagnosticsBtn) diagnosticsBtn.disabled = false;
    }
  });
}

// Indexing control button (start/stop)
let isIndexing = false;

if (indexControlBtn) {
  indexControlBtn.addEventListener('click', async () => {
    if (!currentAccountEmail) {
      setStatus('Аккаунт не определен', true);
      return;
    }
    
    // Если индексация идет, останавливаем её
    if (isIndexing) {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'STOP_INDEXING' });
        if (response && response.success) {
          setStatus('Индексация остановлена');
          isIndexing = false;
          indexControlBtn.textContent = 'Начать индексацию';
          if (indexingInfo) {
            indexingInfo.classList.add('hidden');
          }
        }
      } catch (error) {
        setStatus(`Ошибка остановки: ${error.message}`, true);
      }
      return;
    }
  
    // Get selected chat IDs
    const selectedIds = Array.from(selectedChatIds);
    if (selectedIds.length === 0) {
      setStatus('Выберите хотя бы один чат для индексации', true);
      return;
    }
  
    isIndexing = true;
    indexControlBtn.textContent = 'Остановить индексацию';
    indexControlBtn.disabled = false;
    
    if (indexingInfo) {
      indexingInfo.classList.remove('hidden');
      indexingInfo.textContent = 'Начало индексации...';
    }
    
    if (indexProgress) {
      indexProgress.classList.remove('hidden');
      indexProgress.textContent = 'Начало индексации...';
    }
    setStatus('Индексация начата');
  
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'START_INDEXING',
        accountEmail: currentAccountEmail,
        incremental: false,  // Не инкрементальная, так как выбираем конкретные чаты
        selectedChatIds: selectedIds
      });
    
      if (response && response.success) {
        if (response.stopped) {
          setStatus('Индексация остановлена пользователем');
          isIndexing = false;
          indexControlBtn.textContent = 'Начать индексацию';
        } else {
          setStatus(`Индексация завершена: ${response.indexedCount} из ${response.totalCount} чатов`);
          isIndexing = false;
          indexControlBtn.textContent = 'Начать индексацию';
          
          if (indexingInfo) {
            indexingInfo.textContent = `Завершено: ${response.indexedCount}/${response.totalCount}`;
            setTimeout(() => {
              indexingInfo.classList.add('hidden');
            }, 3000);
          }
          
          // Переключаемся на вкладку поиска
          setTimeout(() => {
            if (tabSearch) tabSearch.disabled = false;
            switchTab('search');
            if (indexProgress) indexProgress.classList.add('hidden');
          }, 2000);
        }
      } else {
        // Отображаем ошибку с поддержкой многострочных сообщений
        const errorMsg = response?.error || 'Неизвестная ошибка';
        setStatus(`Ошибка индексации: ${errorMsg}`, true);
        isIndexing = false;
        indexControlBtn.textContent = 'Начать индексацию';
        if (indexingInfo) {
          indexingInfo.classList.add('hidden');
        }
        if (indexProgress) indexProgress.classList.add('hidden');
      
        // Если ошибка многострочная, показываем её в диагностике
        if (errorMsg.includes('\n') && diagnosticsInfo) {
          diagnosticsInfo.classList.remove('hidden');
          diagnosticsInfo.innerHTML = `<div style="font-family: monospace; font-size: 12px; line-height: 1.6; white-space: pre-wrap;">${errorMsg}</div>`;
        }
      }
    } catch (error) {
      setStatus(`Ошибка: ${error.message}`, true);
      isIndexing = false;
      indexControlBtn.textContent = 'Начать индексацию';
      if (indexingInfo) {
        indexingInfo.classList.add('hidden');
      }
      if (indexProgress) indexProgress.classList.add('hidden');
    }
  });
}

// Resume indexing
if (resumeIndexBtn) {
  resumeIndexBtn.addEventListener('click', async () => {
    if (!currentAccountEmail) {
      setStatus('Аккаунт не определен', true);
      return;
    }
    
    if (resumeIndexBtn) resumeIndexBtn.disabled = true;
    isIndexing = true;
    if (indexControlBtn) {
      indexControlBtn.disabled = false;
      indexControlBtn.textContent = 'Остановить индексацию';
    }
    if (indexingInfo) {
      indexingInfo.classList.remove('hidden');
      indexingInfo.textContent = 'Возобновление индексации...';
    }
    if (indexProgress) {
      indexProgress.classList.remove('hidden');
      indexProgress.textContent = 'Возобновление индексации...';
    }
    setStatus('Индексация возобновлена');
    
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'RESUME_INDEXING',
        accountEmail: currentAccountEmail
      });
      
      if (response && response.success) {
        if (response.stopped) {
          setStatus('Индексация остановлена пользователем');
          isIndexing = false;
          if (indexControlBtn) indexControlBtn.textContent = 'Начать индексацию';
          if (resumeIndexBtn) resumeIndexBtn.style.display = 'none';
        } else {
          setStatus(`Индексация завершена: ${response.indexedCount} из ${response.totalCount} чатов`);
          isIndexing = false;
          if (indexControlBtn) indexControlBtn.textContent = 'Начать индексацию';
          if (indexingInfo) {
            indexingInfo.textContent = `Завершено: ${response.indexedCount}/${response.totalCount}`;
            setTimeout(() => {
              if (indexingInfo) indexingInfo.classList.add('hidden');
            }, 3000);
          }
          if (indexProgress) {
            indexProgress.textContent = `Индексировано: ${response.indexedCount} из ${response.totalCount}`;
          }
          if (resumeIndexBtn) resumeIndexBtn.style.display = 'none';
          
          // Обновляем статистику и список чатов
          await loadChatsForSelection();
          
          // Переключаемся на вкладку поиска
          setTimeout(() => {
            if (tabSearch) tabSearch.disabled = false;
            switchTab('search');
            if (indexProgress) indexProgress.classList.add('hidden');
          }, 2000);
        }
      } else {
        const errorMsg = response?.error || 'Неизвестная ошибка';
        setStatus(`Ошибка индексации: ${errorMsg}`, true);
        isIndexing = false;
        if (indexControlBtn) indexControlBtn.textContent = 'Начать индексацию';
        if (indexingInfo) indexingInfo.classList.add('hidden');
        if (indexProgress) indexProgress.classList.add('hidden');
        
        if (errorMsg.includes('\n') && diagnosticsInfo) {
          diagnosticsInfo.classList.remove('hidden');
          diagnosticsInfo.innerHTML = `<div style="font-family: monospace; font-size: 12px; line-height: 1.6; white-space: pre-wrap;">${errorMsg}</div>`;
        }
      }
    } catch (error) {
      setStatus(`Ошибка: ${error.message}`, true);
      isIndexing = false;
      if (indexControlBtn) indexControlBtn.textContent = 'Начать индексацию';
      if (indexingInfo) indexingInfo.classList.add('hidden');
      if (indexProgress) indexProgress.classList.add('hidden');
    } finally {
      if (resumeIndexBtn) resumeIndexBtn.disabled = false;
    }
  });
}

// Check for saved indexing state on load
async function checkIndexingState() {
  if (!currentAccountEmail) return;
  
  try {
    const key = `indexing_${currentAccountEmail}`;
    const result = await chrome.storage.local.get([key]);
    if (result[key]) {
      const state = result[key];
      const stateAge = Date.now() - state.timestamp;
      // Показываем кнопку, если состояние не старше 1 часа
      if (stateAge < 3600000) {
        resumeIndexBtn.style.display = 'block';
        resumeIndexBtn.textContent = `Возобновить индексацию (${state.currentIndex + 1}/${state.totalCount})`;
      }
    }
  } catch (error) {
    console.error('Error checking indexing state:', error);
  }
}

// Listen for indexing progress
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'INDEX_PROGRESS') {
    if (message.status === 'completed') {
      const progressText = message.current && message.total 
        ? `Обработан чат ${message.current}/${message.total}: ${message.chatId} (${message.messageCount} сообщений)`
        : `Обработан чат: ${message.chatId} (${message.messageCount} сообщений)`;
      if (indexProgress) indexProgress.textContent = progressText;
      
      // Обновляем информационную строку
      if (indexingInfo && message.current && message.total) {
        const shortChatId = message.chatId.length > 20 ? message.chatId.substring(0, 20) + '...' : message.chatId;
        indexingInfo.textContent = `Обработка чата ${message.current}/${message.total}: ${shortChatId}`;
      }
    } else if (message.status === 'processing') {
      const progressText = message.current && message.total
        ? `Обработка чата ${message.current}/${message.total}: ${message.chatId}...`
        : `Обработка чата: ${message.chatId}...`;
      if (indexProgress) indexProgress.textContent = progressText;
      
      // Обновляем информационную строку
      if (indexingInfo && message.current && message.total) {
        const shortChatId = message.chatId.length > 20 ? message.chatId.substring(0, 20) + '...' : message.chatId;
        indexingInfo.textContent = `Обработка чата ${message.current}/${message.total}: ${shortChatId}`;
        indexingInfo.classList.remove('hidden');
      }
    } else if (message.status === 'error') {
      const progressText = message.current && message.total
        ? `Ошибка в чате ${message.current}/${message.total} (${message.chatId}): ${message.error}`
        : `Ошибка в чате ${message.chatId}: ${message.error}`;
      if (indexProgress) indexProgress.textContent = progressText;
    }
  } else if (message.type === 'INDEX_STOPPED') {
    isIndexing = false;
    if (indexControlBtn) indexControlBtn.textContent = 'Начать индексацию';
    if (indexingInfo) {
      indexingInfo.textContent = `Остановлено: ${message.currentIndex}/${message.totalCount}`;
      setTimeout(() => {
        if (indexingInfo) indexingInfo.classList.add('hidden');
      }, 3000);
    }
    setStatus('Индексация остановлена пользователем');
  } else if (message.type === 'INDEX_DONE') {
    const doneText = message.errorCount > 0
      ? `Индексация завершена: ${message.indexedCount} из ${message.totalCount} чатов (ошибок: ${message.errorCount})`
      : `Индексация завершена: ${message.indexedCount} из ${message.totalCount} чатов`;
    if (indexProgress) indexProgress.textContent = doneText;
    if (resumeIndexBtn) resumeIndexBtn.style.display = 'none';
    isIndexing = false;
    if (indexControlBtn) indexControlBtn.textContent = 'Начать индексацию';
    if (indexingInfo) {
      indexingInfo.textContent = `Завершено: ${message.indexedCount}/${message.totalCount}`;
      setTimeout(() => {
        if (indexingInfo) indexingInfo.classList.add('hidden');
      }, 3000);
    }
    // Обновляем статистику и список чатов
    loadChatsForSelection().catch(err => console.error('Error reloading chats:', err));
    setTimeout(() => {
      if (indexProgress) indexProgress.classList.add('hidden');
    }, 3000);
  } else if (message.type === 'INDEX_PAUSED') {
    setStatus(`Индексация приостановлена: ${message.error}`, true);
    if (indexProgress) indexProgress.textContent = 'Индексация приостановлена. Нажмите "Возобновить индексацию" для продолжения.';
    if (resumeIndexBtn) resumeIndexBtn.style.display = 'block';
    isIndexing = false;
    if (indexControlBtn) indexControlBtn.textContent = 'Начать индексацию';
    if (indexingInfo) indexingInfo.classList.add('hidden');
  } else if (message.type === 'INDEX_ERROR') {
    setStatus(`Ошибка индексации: ${message.error}`, true);
    if (indexProgress) indexProgress.classList.add('hidden');
    isIndexing = false;
    if (indexControlBtn) indexControlBtn.textContent = 'Начать индексацию';
    if (indexingInfo) indexingInfo.classList.add('hidden');
    
    // Проверяем, можно ли возобновить
    if (message.error && message.error.includes('потери соединения')) {
      if (resumeIndexBtn) resumeIndexBtn.style.display = 'block';
    }
  }
});

// Export
if (exportBtn) {
  exportBtn.addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'EXPORT_DB' });
      
      if (response && response.success) {
        const dataStr = JSON.stringify(response.data, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `copilot_index_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        setStatus('База данных экспортирована');
      } else {
        setStatus(`Ошибка экспорта: ${response?.error || 'Неизвестная ошибка'}`, true);
      }
    } catch (error) {
      console.error('Export error:', error);
      setStatus(`Ошибка: ${error.message}`, true);
    }
  });
}

// Import
let pendingImportData = null;

// Show merge dialog
function showMergeDialog(conflictCount) {
  if (!mergeDialog) return;
  
  if (conflictCount > 0) {
    conflictInfo.textContent = `Найдено пересечений: ${conflictCount} чат(ов) с одинаковыми ID`;
    conflictInfo.style.display = 'block';
  } else {
    conflictInfo.style.display = 'none';
  }
  
  mergeDialog.classList.remove('hidden');
}

// Hide merge dialog
function hideMergeDialog() {
  if (mergeDialog) {
    mergeDialog.classList.add('hidden');
  }
  pendingImportData = null;
}

// Perform import with strategy
async function performImport(data, mergeStrategy = 'replace') {
  if (importBtn) importBtn.disabled = true;
  setStatus('Импорт базы данных...');
  
  try {
    // Проверка данных перед отправкой
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Данные для импорта отсутствуют. Файл пуст или поврежден.');
    }
    
    // Проверка наличия обязательных полей
    if (!data.accounts || !data.chats || !data.messages || !data.indexes) {
      const missing = [];
      if (!data.accounts) missing.push('accounts');
      if (!data.chats) missing.push('chats');
      if (!data.messages) missing.push('messages');
      if (!data.indexes) missing.push('indexes');
      throw new Error(`Неверный формат данных импорта. Отсутствуют обязательные поля: ${missing.join(', ')}.`);
    }
    
    // Логирование для отладки
    console.log('Import: Sending data, accounts:', data.accounts?.length || 0, 
                'chats:', data.chats?.length || 0, 
                'messages:', data.messages?.length || 0, 
                'indexes:', data.indexes?.length || 0);
    
    // Проверка размера данных (Chrome имеет ограничение ~64MB для sendMessage)
    const dataSize = JSON.stringify(data).length;
    console.log('Import: Data size:', (dataSize / 1024 / 1024).toFixed(2), 'MB');
    
    if (dataSize > 60 * 1024 * 1024) { // 60MB для безопасности
      throw new Error('Файл слишком большой для импорта. Размер данных превышает 60MB.');
    }
    
    const response = await chrome.runtime.sendMessage({
      type: 'IMPORT_DB',
      data,
      mergeStrategy
    });
    
    // Проверка ответа
    if (!response) {
      throw new Error('Не получен ответ от фонового скрипта. Возможно, данные слишком большие или произошла ошибка при передаче.');
    }
    
    if (response && response.success) {
      const strategyText = mergeStrategy === 'keep_current' 
        ? ' (текущие версии сохранены)' 
        : mergeStrategy === 'keep_imported'
        ? ' (загружаемые версии применены)'
        : '';
      setStatus(`База данных импортирована${strategyText}`);
      importFile.value = '';
      
      // Обновляем email аккаунта, если он был в импортированных данных
      if (data.accounts && data.accounts.length > 0) {
        currentAccountEmail = data.accounts[0].email;
        await chrome.storage.local.set({ copilotAccountEmail: currentAccountEmail });
      }
      
      // Переключаемся на вкладку поиска
      setTimeout(() => {
        if (tabSearch) tabSearch.disabled = false;
        switchTab('search');
      }, 1000);
    } else {
      // Улучшенная обработка ошибок импорта
      const errorMsg = response?.error || 'Неизвестная ошибка';
      let userFriendlyError = errorMsg;
      
      // Переводим технические ошибки в понятные сообщения
      if (errorMsg.includes('Invalid import data format') || errorMsg.includes('Неверный формат данных')) {
        userFriendlyError = 'Неверный формат данных импорта. Убедитесь, что файл был экспортирован из этого расширения и содержит все необходимые поля (accounts, chats, messages, indexes).';
      } else if (errorMsg.includes('должно быть массивом')) {
        userFriendlyError = errorMsg; // Уже понятное сообщение
      } else if (errorMsg.includes('Отсутствуют обязательные поля')) {
        userFriendlyError = errorMsg; // Уже понятное сообщение
      } else if (errorMsg.includes('Данные для импорта отсутствуют')) {
        userFriendlyError = errorMsg; // Уже понятное сообщение
      }
      
      setStatus(`Ошибка импорта: ${userFriendlyError}`, true);
    }
  } catch (error) {
    console.error('Import error:', error);
    // Улучшенная обработка ошибок в catch блоке
    let errorMessage = error.message || 'Неизвестная ошибка';
    if (error.message && error.message.includes('Invalid import data format')) {
      errorMessage = 'Неверный формат данных импорта. Убедитесь, что файл был экспортирован из этого расширения.';
    }
    setStatus(`Ошибка импорта: ${errorMessage}`, true);
  } finally {
    if (importBtn) importBtn.disabled = false;
  }
}

if (importBtn && importFile) {
  importBtn.addEventListener('click', () => {
    try {
      importFile.click();
    } catch (error) {
      console.error('Import button click error:', error);
      setStatus('Ошибка открытия диалога выбора файла', true);
    }
  });

  importFile.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        // Проверка на пустой файл
        if (!e.target.result || e.target.result.trim().length === 0) {
          setStatus('Ошибка: Файл пуст. Выберите файл с данными для импорта.', true);
          importFile.value = '';
          return;
        }
        
        let data;
        try {
          data = JSON.parse(e.target.result);
        } catch (parseError) {
          if (parseError instanceof SyntaxError) {
            setStatus('Ошибка: Файл не является валидным JSON. Проверьте, что файл не поврежден и был экспортирован из этого расширения.', true);
          } else {
            setStatus(`Ошибка парсинга JSON: ${parseError.message}`, true);
          }
          importFile.value = '';
          return;
        }
        
        // Проверка, что это объект
        if (typeof data !== 'object' || data === null || Array.isArray(data)) {
          setStatus('Ошибка: Неверный формат данных. Ожидается объект с полями accounts, chats, messages, indexes.', true);
          importFile.value = '';
          return;
        }
        
        // Проверка наличия обязательных полей сразу после парсинга
        const missingFields = [];
        if (!data.accounts) missingFields.push('accounts');
        if (!data.chats) missingFields.push('chats');
        if (!data.messages) missingFields.push('messages');
        if (!data.indexes) missingFields.push('indexes');
        
        if (missingFields.length > 0) {
          setStatus(`Ошибка: Неверный формат данных импорта. Отсутствуют обязательные поля: ${missingFields.join(', ')}. Убедитесь, что файл был экспортирован из этого расширения.`, true);
          importFile.value = '';
          return;
        }
        
        // Проверка типов данных
        if (!Array.isArray(data.accounts) || !Array.isArray(data.chats) || 
            !Array.isArray(data.messages) || !Array.isArray(data.indexes)) {
          setStatus('Ошибка: Неверный формат данных. Поля accounts, chats, messages, indexes должны быть массивами.', true);
          importFile.value = '';
          return;
        }
        
        console.log('Import: File parsed successfully, accounts:', data.accounts.length, 
                    'chats:', data.chats.length, 
                    'messages:', data.messages.length, 
                    'indexes:', data.indexes.length);
        
        // Check if database has existing data
        const hasDataResult = await hasData();
        
        if (!hasDataResult) {
          // No existing data, import directly
          await performImport(data, 'replace');
        } else {
          // Has existing data, check for conflicts and show dialog
          pendingImportData = data;
          
          // Check for conflicts
          const conflictResponse = await chrome.runtime.sendMessage({
            type: 'CHECK_IMPORT_CONFLICTS',
            data
          });
          
          if (conflictResponse && conflictResponse.success) {
            showMergeDialog(conflictResponse.conflictCount || 0);
          } else {
            // If check fails, still show dialog
            showMergeDialog(0);
          }
        }
      } catch (error) {
        console.error('Import file read error:', error);
        // Различаем типы ошибок
        if (error.message && error.message.includes('Invalid import data format')) {
          setStatus('Ошибка: Неверный формат данных импорта. Убедитесь, что файл был экспортирован из этого расширения и содержит все необходимые поля.', true);
        } else {
          setStatus(`Ошибка импорта: ${error.message || 'Неизвестная ошибка'}`, true);
        }
        importFile.value = '';
      }
    };
    
    reader.onerror = () => {
      console.error('FileReader error');
      setStatus('Ошибка чтения файла', true);
      importFile.value = '';
    };
    
    reader.readAsText(file);
  });
}

// Merge dialog handlers
if (mergeDialogCancel) {
  mergeDialogCancel.addEventListener('click', () => {
    hideMergeDialog();
    if (importFile) importFile.value = '';
  });
}

if (mergeDialogConfirm) {
  mergeDialogConfirm.addEventListener('click', async () => {
    if (!pendingImportData) {
      hideMergeDialog();
      return;
    }
    
    // Сохраняем данные в локальную переменную перед очисткой
    const importData = pendingImportData;
    const selectedStrategy = document.querySelector('input[name="mergeStrategy"]:checked')?.value || 'keep_current';
    hideMergeDialog();
    
    await performImport(importData, selectedStrategy);
  });
}

// Close dialog on overlay click
if (mergeDialog) {
  mergeDialog.addEventListener('click', (e) => {
    if (e.target === mergeDialog) {
      hideMergeDialog();
      if (importFile) importFile.value = '';
    }
  });
}

// Reset
let resetConfirmCount = 0;
if (resetBtn) {
  resetBtn.addEventListener('click', () => {
    resetConfirmCount++;
    
    if (resetConfirmCount === 1) {
      setStatus('Нажмите еще раз для подтверждения сброса базы', true);
      setTimeout(() => {
        resetConfirmCount = 0;
      }, 3000);
    } else if (resetConfirmCount >= 2) {
      resetConfirmCount = 0;
      performReset();
    }
  });
}

async function performReset() {
  if (!currentAccountEmail) {
    setStatus('Аккаунт не определен', true);
    return;
  }
  
  if (!confirm('Вы уверены? Все данные будут удалены!')) {
    return;
  }
  
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'RESET_DB',
      accountEmail: currentAccountEmail
    });
    
    if (response.success) {
      setStatus('База данных сброшена');
      searchResults.innerHTML = '';
      searchEmpty.style.display = 'block';
      switchTab('index');
    } else {
      setStatus(`Ошибка сброса: ${response.error}`, true);
    }
  } catch (error) {
    setStatus(`Ошибка: ${error.message}`, true);
  }
}

// Search
function performSearch(query) {
  if (!currentAccountEmail) {
    setStatus('Аккаунт не определен', true);
    return;
  }
  
  if (query.length < 2) {
    searchResults.innerHTML = '';
    searchEmpty.style.display = 'block';
    return;
  }
  
  searchEmpty.style.display = 'none';
  searchResults.innerHTML = '<div style="padding: 12px; text-align: center; color: #666;">Поиск...</div>';
  
  chrome.runtime.sendMessage({
    type: 'SEARCH',
    accountEmail: currentAccountEmail,
    query
  }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus(`Ошибка поиска: ${chrome.runtime.lastError.message}`, true);
      return;
    }
    
    if (response.success) {
      displaySearchResults(response.results);
    } else {
      setStatus(`Ошибка поиска: ${response.error}`, true);
      searchResults.innerHTML = '';
      searchEmpty.style.display = 'block';
    }
  });
}

function formatDate(dateString) {
  if (!dateString) return '';
  
  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) {
      return 'только что';
    } else if (diffMins < 60) {
      return `${diffMins} ${getMinutesText(diffMins)} назад`;
    } else if (diffHours < 24) {
      return `${diffHours} ${getHoursText(diffHours)} назад`;
    } else if (diffDays < 7) {
      return `${diffDays} ${getDaysText(diffDays)} назад`;
    } else {
      // Форматируем дату: день.месяц.год
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      return `${day}.${month}.${year}`;
    }
  } catch (e) {
    return '';
  }
}

function getMinutesText(count) {
  const lastDigit = count % 10;
  const lastTwo = count % 100;
  
  if (lastTwo >= 11 && lastTwo <= 14) return 'минут';
  if (lastDigit === 1) return 'минуту';
  if (lastDigit >= 2 && lastDigit <= 4) return 'минуты';
  return 'минут';
}

function getHoursText(count) {
  const lastDigit = count % 10;
  const lastTwo = count % 100;
  
  if (lastTwo >= 11 && lastTwo <= 14) return 'часов';
  if (lastDigit === 1) return 'час';
  if (lastDigit >= 2 && lastDigit <= 4) return 'часа';
  return 'часов';
}

function getDaysText(count) {
  const lastDigit = count % 10;
  const lastTwo = count % 100;
  
  if (lastTwo >= 11 && lastTwo <= 14) return 'дней';
  if (lastDigit === 1) return 'день';
  if (lastDigit >= 2 && lastDigit <= 4) return 'дня';
  return 'дней';
}

function displaySearchResults(results) {
  if (!results || results.length === 0) {
    searchResults.innerHTML = '';
    searchEmpty.style.display = 'block';
    searchEmpty.textContent = 'Результаты не найдены';
    return;
  }
  
  searchEmpty.style.display = 'none';
  searchResults.innerHTML = '';
  
  // Показываем количество найденных чатов
  const resultsCount = document.createElement('div');
  resultsCount.style.fontSize = '12px';
  resultsCount.style.color = '#666';
  resultsCount.style.marginBottom = '8px';
  resultsCount.style.padding = '4px 0';
  resultsCount.textContent = `Найдено чатов: ${results.length}`;
  searchResults.appendChild(resultsCount);
  
  for (const result of results) {
    const item = document.createElement('div');
    item.className = 'search-result-item';
    
    const titleRow = document.createElement('div');
    titleRow.style.display = 'flex';
    titleRow.style.justifyContent = 'space-between';
    titleRow.style.alignItems = 'center';
    titleRow.style.marginBottom = '8px';
    
    const title = document.createElement('div');
    title.className = 'search-result-title';
    title.style.marginBottom = '0';
    title.textContent = result.title || 'Без названия';
    title.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: result.url });
    });
    
    const dateInfo = document.createElement('div');
    dateInfo.className = 'search-result-date';
    dateInfo.style.fontSize = '11px';
    dateInfo.style.color = '#666';
    dateInfo.style.marginLeft = '8px';
    dateInfo.textContent = result.updatedAtUTC ? formatDate(result.updatedAtUTC) : '';
    
    titleRow.appendChild(title);
    if (dateInfo.textContent) {
      titleRow.appendChild(dateInfo);
    }
    
    // Информация о количестве совпадений в чате
    const matchInfo = document.createElement('div');
    matchInfo.className = 'search-result-match-info';
    matchInfo.style.fontSize = '11px';
    matchInfo.style.color = '#666';
    matchInfo.style.marginBottom = '8px';
    matchInfo.style.padding = '4px 8px';
    matchInfo.style.backgroundColor = '#f5f5f5';
    matchInfo.style.borderRadius = '4px';
    matchInfo.style.display = 'inline-block';
    
    const matchCount = result.matchCount || result.snippets?.length || 0;
    if (matchCount > 0) {
      const matchText = matchCount === 1 ? 'совпадение' : 
                       matchCount >= 2 && matchCount <= 4 ? 'совпадения' : 'совпадений';
      matchInfo.textContent = `Найдено ${matchCount} ${matchText} в этом чате`;
    } else {
      matchInfo.textContent = 'Совпадения найдены в этом чате';
    }
    
    const snippets = document.createElement('div');
    snippets.className = 'search-result-snippets';
    
    // Показываем сниппеты (максимум 10, уже ограничено на сервере)
    if (result.snippets && result.snippets.length > 0) {
      for (const snippet of result.snippets) {
        const snippetEl = document.createElement('div');
        snippetEl.className = 'search-result-snippet';
        snippetEl.innerHTML = snippet;
        snippets.appendChild(snippetEl);
      }
    } else {
      // Если нет сниппетов, показываем сообщение
      const noSnippets = document.createElement('div');
      noSnippets.className = 'search-result-snippet';
      noSnippets.style.fontStyle = 'italic';
      noSnippets.style.color = '#999';
      noSnippets.textContent = 'Совпадения найдены в этом чате';
      snippets.appendChild(noSnippets);
    }
    
    item.appendChild(titleRow);
    item.appendChild(matchInfo);
    item.appendChild(snippets);
    searchResults.appendChild(item);
  }
}

if (searchInput) {
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }
    
    searchTimeout = setTimeout(() => {
      performSearch(query);
    }, 300);
  });
}

// Initialize on load
// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
