// Popup script for Copilot Chat Indexer

// JSZip loader - library is loaded via script tag in popup.html
async function loadJSZip() {
  // JSZip should be available globally after script tag loads
  if (typeof JSZip !== 'undefined') {
    return JSZip;
  }
  
  if (typeof window !== 'undefined' && window.JSZip) {
    return window.JSZip;
  }
  
  // Wait a bit for script to load if it's still loading
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = 10;
    
    const checkJSZip = () => {
      attempts++;
      if (typeof JSZip !== 'undefined') {
        resolve(JSZip);
      } else if (typeof window !== 'undefined' && window.JSZip) {
        resolve(window.JSZip);
      } else if (attempts < maxAttempts) {
        setTimeout(checkJSZip, 100);
      } else {
        reject(new Error('JSZip library could not be loaded. Please reload the extension.'));
      }
    };
    
    checkJSZip();
  });
}

let currentAccountEmail = null;
let searchTimeout = null;
let chatsData = [];
let selectedChatIds = new Set();
let chatCheckboxes = new Map();
let collapsedChats = new Set(); // Для отслеживания свернутых чатов
let allChatsCollapsed = false; // Состояние "свернуть все"

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
const exportMdBtn = document.getElementById('exportMdBtn');
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
const exportOptionsDialog = document.getElementById('exportOptionsDialog');
const exportOptionsCancel = document.getElementById('exportOptionsCancel');
const exportOptionsConfirm = document.getElementById('exportOptionsConfirm');
const partsInputContainer = document.getElementById('partsInputContainer');
const partsCountInput = document.getElementById('partsCountInput');

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
      try {
        const response = await chrome.tabs.sendMessage(tabs[0].id, { action: 'getAccountInfo' });
        if (response && response.success && response.email) {
          await chrome.storage.local.set({ copilotAccountEmail: response.email });
          return response.email;
        }
      } catch (msgError) {
        // Tab might not be ready or content script not loaded - this is OK
        console.log('Could not get account email from tab (this is normal if Copilot page is not open):', msgError.message);
      }
    }
    
    return null;
  } catch (error) {
    // Don't log as error if it's just a connection issue
    if (error.message && error.message.includes('Could not establish connection')) {
      console.log('Account email not available (Copilot page may not be open)');
    } else {
      console.error('Error getting account email:', error);
    }
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
  
  // Initialize reset buttons (multiple if multiple accounts)
  await initializeResetButtons();
  
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
      
      // Update month checkboxes if date sorting is active
      const sortValue = sortBy.value;
      if (chatsList && (sortValue === 'date-desc' || sortValue === 'date-asc')) {
        const monthCheckboxes = chatsList.querySelectorAll('.month-checkbox');
        monthCheckboxes.forEach(monthCheckbox => {
          monthCheckbox.checked = checked;
          monthCheckbox.indeterminate = false;
        });
      }
      
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
  if (!chatsList) return;
  
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
      if (chatsList) {
        chatsList.innerHTML = '<div class="empty-chats">Ошибка загрузки чатов</div>';
      }
    }
  } catch (error) {
    if (chatsList) {
      chatsList.innerHTML = `<div class="empty-chats">Ошибка: ${error.message}</div>`;
    }
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

// Helper function to get month key from date
function getMonthKey(dateString) {
  if (!dateString) return null;
  try {
    const date = new Date(dateString);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  } catch (e) {
    return null;
  }
}

// Helper function to format month name
function formatMonthName(dateString) {
  if (!dateString) return 'Без даты';
  try {
    const date = new Date(dateString);
    const months = [
      'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
      'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
    ];
    return `${months[date.getMonth()]} ${date.getFullYear()}`;
  } catch (e) {
    return 'Без даты';
  }
}

// Render chats list
function renderChatsList() {
  if (!chatsList) return;
  
  if (chatsData.length === 0) {
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
  
  // Check if sorting by date
  const isDateSorting = sortValue === 'date-desc' || sortValue === 'date-asc';
  
  // Render
  chatsList.innerHTML = '';
  
  if (isDateSorting) {
    // Group chats by month
    const chatsByMonth = new Map();
    sortedChats.forEach(chat => {
      const monthKey = getMonthKey(chat.updatedAtUTC) || 'no-date';
      if (!chatsByMonth.has(monthKey)) {
        chatsByMonth.set(monthKey, []);
      }
      chatsByMonth.get(monthKey).push(chat);
    });
    
    // Sort month keys (descending for date-desc, ascending for date-asc)
    const sortedMonthKeys = Array.from(chatsByMonth.keys()).sort((a, b) => {
      if (a === 'no-date') return 1;
      if (b === 'no-date') return -1;
      return sortValue === 'date-desc' ? b.localeCompare(a) : a.localeCompare(b);
    });
    
    // Render with month separators
    sortedMonthKeys.forEach((monthKey, monthIndex) => {
      const monthChats = chatsByMonth.get(monthKey);
      const monthName = monthKey === 'no-date' 
        ? 'Без даты' 
        : formatMonthName(monthChats[0].updatedAtUTC);
      
      // Month separator with checkbox
      const monthSeparator = document.createElement('div');
      monthSeparator.className = 'month-separator';
      monthSeparator.dataset.monthKey = monthKey;
      monthSeparator.id = `month-separator-${monthKey}`;
      
      const monthCheckbox = document.createElement('input');
      monthCheckbox.type = 'checkbox';
      monthCheckbox.className = 'month-checkbox';
      monthCheckbox.id = `month-${monthKey}`;
      
      // Check if all chats in this month are selected
      const allSelected = monthChats.every(chat => selectedChatIds.has(chat.chatId));
      const someSelected = monthChats.some(chat => selectedChatIds.has(chat.chatId));
      monthCheckbox.checked = allSelected;
      monthCheckbox.indeterminate = someSelected && !allSelected;
      
      // Store month chats for checkbox handler
      monthCheckbox.dataset.monthKey = monthKey;
      
      monthCheckbox.addEventListener('change', (e) => {
        const checked = e.target.checked;
        monthChats.forEach(chat => {
          if (checked) {
            selectedChatIds.add(chat.chatId);
          } else {
            selectedChatIds.delete(chat.chatId);
          }
          // Update individual chat checkbox if it exists
          const chatCheckbox = chatCheckboxes.get(chat.chatId);
          if (chatCheckbox) {
            chatCheckbox.checked = checked;
          }
        });
        updateSelectAllState();
        updateIndexingStats();
      });
      
      const monthLabel = document.createElement('label');
      monthLabel.className = 'month-label';
      monthLabel.htmlFor = `month-${monthKey}`;
      monthLabel.textContent = monthName;
      
      const monthCount = document.createElement('span');
      monthCount.className = 'month-count';
      monthCount.textContent = `(${monthChats.length})`;
      
      // Navigation arrows container
      const navArrows = document.createElement('div');
      navArrows.className = 'month-nav-arrows';
      
      // Up arrow (previous month)
      const upArrow = document.createElement('button');
      upArrow.className = 'month-nav-arrow month-nav-arrow-up';
      upArrow.type = 'button';
      upArrow.innerHTML = '▲';
      upArrow.title = 'Предыдущий месяц';
      upArrow.setAttribute('aria-label', 'Предыдущий месяц');
      
      // Down arrow (next month)
      const downArrow = document.createElement('button');
      downArrow.className = 'month-nav-arrow month-nav-arrow-down';
      downArrow.type = 'button';
      downArrow.innerHTML = '▼';
      downArrow.title = 'Следующий месяц';
      downArrow.setAttribute('aria-label', 'Следующий месяц');
      
      // Determine if arrows should be disabled
      const isFirstMonth = monthIndex === 0;
      const isLastMonth = monthIndex === sortedMonthKeys.length - 1;
      
      if (isFirstMonth) {
        upArrow.disabled = true;
        upArrow.classList.add('disabled');
      }
      
      if (isLastMonth) {
        downArrow.disabled = true;
        downArrow.classList.add('disabled');
      }
      
      // Navigation handlers
      upArrow.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!isFirstMonth && monthIndex > 0) {
          const prevMonthKey = sortedMonthKeys[monthIndex - 1];
          scrollToMonth(prevMonthKey);
        }
      });
      
      downArrow.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!isLastMonth && monthIndex < sortedMonthKeys.length - 1) {
          const nextMonthKey = sortedMonthKeys[monthIndex + 1];
          scrollToMonth(nextMonthKey);
        }
      });
      
      navArrows.appendChild(upArrow);
      navArrows.appendChild(downArrow);
      
      monthSeparator.appendChild(monthCheckbox);
      monthSeparator.appendChild(monthLabel);
      monthSeparator.appendChild(monthCount);
      monthSeparator.appendChild(navArrows);
      chatsList.appendChild(monthSeparator);
      
      // Render chats for this month
      monthChats.forEach(chat => {
        const item = document.createElement('div');
        item.className = `chat-item ${chat.isIndexed ? 'indexed' : ''}`;
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'chat-checkbox';
        checkbox.id = `chat-${chat.chatId}`;
        checkbox.checked = selectedChatIds.has(chat.chatId);
        checkbox.dataset.monthKey = monthKey;
        checkbox.addEventListener('change', (e) => {
          if (e.target.checked) {
            selectedChatIds.add(chat.chatId);
          } else {
            selectedChatIds.delete(chat.chatId);
          }
          // Update month checkbox state
          updateMonthCheckboxState(monthKey);
          updateSelectAllState();
          updateIndexingStats();
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
    });
  } else {
    // Render without month separators
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
  }
  
  updateSelectAllState();
  updateIndexingStats();
}

// Update month checkbox state based on individual chat checkboxes
function updateMonthCheckboxState(monthKey) {
  const monthCheckbox = document.getElementById(`month-${monthKey}`);
  if (!monthCheckbox) return;
  
  // Find all chats with this monthKey
  const monthChats = chatsData.filter(chat => {
    const chatMonthKey = getMonthKey(chat.updatedAtUTC) || 'no-date';
    return chatMonthKey === monthKey;
  });
  
  if (monthChats.length === 0) return;
  
  const allSelected = monthChats.every(chat => selectedChatIds.has(chat.chatId));
  const someSelected = monthChats.some(chat => selectedChatIds.has(chat.chatId));
  
  monthCheckbox.checked = allSelected;
  monthCheckbox.indeterminate = someSelected && !allSelected;
}

// Scroll to specific month separator with smooth scrolling
function scrollToMonth(monthKey) {
  const monthSeparator = document.getElementById(`month-separator-${monthKey}`);
  if (!monthSeparator || !chatsList) {
    console.warn('scrollToMonth: separator or container not found', monthKey);
    return;
  }
  
  // Find all children of chatsList to calculate position
  const children = Array.from(chatsList.children);
  const separatorIndex = children.indexOf(monthSeparator);
  
  if (separatorIndex === -1) {
    console.warn('scrollToMonth: separator not found in container children');
    // Fallback to scrollIntoView
    monthSeparator.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
      inline: 'nearest'
    });
    monthSeparator.classList.add('month-highlight');
    setTimeout(() => {
      monthSeparator.classList.remove('month-highlight');
    }, 1000);
    return;
  }
  
  // Calculate total height of all elements before the separator
  let totalHeight = 0;
  for (let i = 0; i < separatorIndex; i++) {
    const child = children[i];
    const style = window.getComputedStyle(child);
    const marginTop = parseFloat(style.marginTop) || 0;
    const marginBottom = parseFloat(style.marginBottom) || 0;
    totalHeight += child.offsetHeight + marginTop + marginBottom;
  }
  
  // Scroll to calculated position with small offset
  const offset = 4;
  const targetScrollTop = Math.max(0, totalHeight - offset);
  
  chatsList.scrollTo({
    top: targetScrollTop,
    behavior: 'smooth'
  });
  
  // Add highlight effect
  monthSeparator.classList.add('month-highlight');
  setTimeout(() => {
    monthSeparator.classList.remove('month-highlight');
  }, 1000);
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

// Helper function to sanitize account email for filename
function sanitizeAccountForFilename(accountEmail) {
  if (!accountEmail) {
    return 'unknown';
  }
  // Replace forbidden characters: / \ : * ? " < > |
  // Also replace @ with underscore and remove spaces
  return accountEmail
    .replace(/[/\\:*?"<>|@\s]/g, '_')
    .replace(/_+/g, '_') // Replace multiple underscores with single
    .replace(/^_|_$/g, ''); // Remove leading/trailing underscores
}

// Export Options Dialog
function showExportOptionsDialog() {
  if (!exportOptionsDialog) return;
  exportOptionsDialog.classList.remove('hidden');
  // Reset to default
  const singleOption = document.querySelector('input[name="exportStrategy"][value="single"]');
  if (singleOption) singleOption.checked = true;
  if (partsInputContainer) partsInputContainer.classList.add('hidden');
  if (partsCountInput) partsCountInput.value = '2';
}

function hideExportOptionsDialog() {
  if (exportOptionsDialog) {
    exportOptionsDialog.classList.add('hidden');
  }
}

// Handle export strategy selection
function setupExportStrategyHandlers() {
  const strategyRadios = document.querySelectorAll('input[name="exportStrategy"]');
  if (strategyRadios.length > 0) {
    strategyRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        if (e.target.value === 'by_parts' && partsInputContainer) {
          partsInputContainer.classList.remove('hidden');
        } else if (partsInputContainer) {
          partsInputContainer.classList.add('hidden');
        }
      });
    });
  }
}

// Setup handlers when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupExportStrategyHandlers);
} else {
  setupExportStrategyHandlers();
}

// Export
if (exportBtn) {
  exportBtn.addEventListener('click', async () => {
    showExportOptionsDialog();
  });
}

// Export Options Dialog handlers
if (exportOptionsCancel) {
  exportOptionsCancel.addEventListener('click', () => {
    hideExportOptionsDialog();
  });
}

if (exportOptionsConfirm) {
  exportOptionsConfirm.addEventListener('click', async () => {
    if (!exportOptionsDialog) return;
    
    const selectedStrategy = document.querySelector('input[name="exportStrategy"]:checked')?.value || 'single';
    let partsCount = null;
    
    if (selectedStrategy === 'by_parts') {
      partsCount = parseInt(partsCountInput?.value || '2', 10);
      if (isNaN(partsCount) || partsCount < 2 || partsCount > 100) {
        setStatus('Ошибка: Количество частей должно быть от 2 до 100', true);
        return;
      }
    }
    
    hideExportOptionsDialog();
    
    try {
      setStatus('Экспорт базы данных...');
      
      const response = await chrome.runtime.sendMessage({ 
        type: 'EXPORT_DB',
        strategy: selectedStrategy,
        partsCount: partsCount
      });
      
      if (response && response.success) {
        const sanitizedAccount = sanitizeAccountForFilename(currentAccountEmail);
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        
        if (selectedStrategy === 'single') {
          // Check if file was downloaded directly (too large for messaging)
          if (response.directDownload) {
            setStatus(`Файл ${response.filename} скачан напрямую (слишком большой для передачи)`);
            return;
          }
          
          // Single file export - original behavior
          const dataStr = JSON.stringify(response.data, null, 2);
          const blob = new Blob([dataStr], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `copilot_ind_${sanitizedAccount}_${dateStr}.json`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          setStatus('База данных экспортирована');
        } else if (selectedStrategy === 'by_month' || selectedStrategy === 'by_parts') {
          // Check if ZIP was already created in background script
          if (response.zipDownloaded) {
            console.log(`Export: ZIP archive already created: ${response.zipFilename}`);
            setStatus(response.reason || `ZIP архив ${response.zipFilename} успешно создан и скачан`);
            return;
          }
          
          // Check if some files were downloaded directly
          if (response.directDownloadCount > 0) {
            console.log(`Export: ${response.directDownloadCount} file(s) were downloaded directly`);
            setStatus(`Экспорт: ${response.directDownloadCount} файл(ов) скачан(ы) напрямую (слишком большие)`);
          }
          
          // Multiple files export - create ZIP archive in popup.js (JSZip works here)
          const files = response.files || [];
          const directDownloadCount = response.directDownloadCount || 0;
          const needsZipCreation = response.needsZipCreation || false;
          console.log(`Export: Received response with files array:`, response);
          console.log(`Export: Received ${files.length} files to archive, ${directDownloadCount} downloaded directly, needsZipCreation: ${needsZipCreation}`);
          console.log(`Export: File names:`, files.map(f => f.filename));
          
          // If all files were downloaded directly and no ZIP needed, just show status
          if (files.length === 0 && directDownloadCount > 0 && !needsZipCreation) {
            setStatus(`Все ${directDownloadCount} файл(ов) скачан(ы) напрямую (слишком большие для передачи)`);
            return;
          }
          
          // If no files and ZIP error, show error
          if (files.length === 0 && response.zipError) {
            setStatus(`Ошибка создания ZIP: ${response.zipError}`, true);
            return;
          }
          
          // If needsZipCreation but no files, it means files were too large to send
          if (files.length === 0 && needsZipCreation) {
            setStatus(`Файлы слишком большие для передачи. Попробуйте использовать больше частей при экспорте.`, true);
            return;
          }
          
          // Debug: Check file contents
          if (files.length > 0) {
            console.log(`Export: First file has ${files[0].data?.messages?.length || 0} messages`);
            if (files.length > 1) {
              console.log(`Export: Second file has ${files[1].data?.messages?.length || 0} messages`);
            }
          }
          
          if (files.length === 0) {
            setStatus('Ошибка: Не удалось создать файлы для экспорта', true);
            return;
          }
          
          // Always create ZIP if multiple files or needsZipCreation flag is set
          if (needsZipCreation || files.length > 1) {
            setStatus(`Создание ZIP архива из ${files.length} файл(ов)...`);
          } else {
            setStatus(`Создание архива из ${files.length} файл(ов)...`);
          }
          
          // Log to console for debugging (open popup console with right-click -> Inspect)
          console.log('=== EXPORT DEBUG INFO ===');
          console.log('Files received:', files.length);
          console.log('Response object:', response);
          console.log('File details:', files.map(f => ({
            filename: f.filename,
            messages: f.data?.messages?.length || 0,
            chats: f.data?.chats?.length || 0,
            partNumber: f.data?.partNumber,
            totalParts: f.data?.totalParts
          })));
          console.log('File names:', files.map(f => f.filename));
          console.log('=======================');
          
          // Verify we have all expected parts
          if (files.length > 0 && files[0].data?.totalParts) {
            const expectedParts = files[0].data.totalParts;
            if (files.length !== expectedParts) {
              console.warn(`Export: WARNING! Expected ${expectedParts} parts, but received ${files.length} files!`);
              setStatus(`Предупреждение: Ожидалось ${expectedParts} частей, получено ${files.length}`, true);
            }
          }
          
          try {
            // Load JSZip library
            const zipLib = await loadJSZip();
            
            // Create ZIP archive
            const zip = new zipLib();
            
            console.log(`Export: Starting to add ${files.length} files to ZIP archive`);
            
            // Add ALL files to the archive BEFORE generating
            // This ensures all months/parts are included
            for (let i = 0; i < files.length; i++) {
              const fileData = files[i];
              
              if (!fileData || !fileData.data) {
                console.warn(`Export: Skipping invalid file at index ${i}`);
                continue;
              }
              
              const dataStr = JSON.stringify(fileData.data, null, 2);
              const messagesCount = fileData.data?.messages?.length || 0;
              const chatsCount = fileData.data?.chats?.length || 0;
              
              // Add file to archive
              zip.file(fileData.filename, dataStr);
              console.log(`Export: Added file ${i + 1}/${files.length}: ${fileData.filename} (${messagesCount} messages, ${chatsCount} chats)`);
            }
            
            // Verify all files were added BEFORE generating ZIP
            const zipFiles = Object.keys(zip.files || {});
            console.log(`Export: ZIP archive contains ${zipFiles.length} files before generation:`, zipFiles);
            
            if (zipFiles.length !== files.length) {
              console.error(`Export: WARNING! Expected ${files.length} files, but only ${zipFiles.length} were added to archive!`);
              setStatus(`Предупреждение: В архив добавлено ${zipFiles.length} из ${files.length} файлов`, true);
            }
            
            // Generate ZIP file ONLY AFTER all files are added
            setStatus(`Генерация ZIP архива из ${zipFiles.length} файл(ов)...`);
            const zipBlob = await zip.generateAsync({ 
              type: 'blob',
              compression: 'DEFLATE',
              compressionOptions: { level: 6 }
            });
            
            // Verify after generation
            console.log(`Export: ZIP archive generated, size: ${(zipBlob.size / 1024 / 1024).toFixed(2)} MB`);
            
            // Create download link for ZIP
            const sanitizedAccount = sanitizeAccountForFilename(currentAccountEmail);
            const now = new Date();
            const dateStr = now.toISOString().split('T')[0];
            
            let zipFilename;
            if (selectedStrategy === 'by_month') {
              zipFilename = `copilot_ind_${sanitizedAccount}_by_month_${dateStr}.zip`;
            } else {
              zipFilename = `copilot_ind_${sanitizedAccount}_by_parts_${dateStr}.zip`;
            }
            
            const url = URL.createObjectURL(zipBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = zipFilename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            console.log(`Export: Successfully created and downloaded ZIP archive: ${zipFilename}`);
            let statusMsg = `Экспортировано ${files.length} файл(ов) в архив ${zipFilename}`;
            if (directDownloadCount > 0) {
              statusMsg += ` (+ ${directDownloadCount} файл(ов) скачан(ы) отдельно)`;
            }
            setStatus(statusMsg);
          } catch (error) {
            console.error('Export: Error creating ZIP archive:', error);
            setStatus(`Ошибка создания архива: ${error.message}`, true);
          }
        }
      } else {
        // Show detailed error information
        let errorMsg = response?.error || 'Неизвестная ошибка';
        
        // If it's a serialization error, show additional details
        if (response?.errorType === 'serialization') {
          errorMsg = `Ошибка сериализации данных:\n${errorMsg}`;
          if (response.chatCount || response.messageCount) {
            errorMsg += `\n\nСтатистика:\n`;
            if (response.chatCount) {
              errorMsg += `- Чатов: ${response.chatCount}\n`;
            }
            if (response.messageCount) {
              errorMsg += `- Сообщений: ${response.messageCount}`;
            }
          }
          errorMsg += `\n\nПроверьте консоль браузера (F12) для детальной информации о проблемных чатах.`;
        }
        
        setStatus(errorMsg, true);
        console.error('Export error details:', response);
      }
    } catch (error) {
      console.error('Export error:', error);
      setStatus(`Ошибка: ${error.message}`, true);
    }
  });
}

// Close export dialog on overlay click
if (exportOptionsDialog) {
  exportOptionsDialog.addEventListener('click', (e) => {
    if (e.target === exportOptionsDialog) {
      hideExportOptionsDialog();
    }
  });
}

// Export to Markdown
if (exportMdBtn) {
  exportMdBtn.addEventListener('click', async () => {
    if (!currentAccountEmail) {
      setStatus('Ошибка: Аккаунт не определен', true);
      return;
    }

    try {
      setStatus('Подготовка экспорта в MD...');
      
      // Get selected chats or all chats
      const selectedChats = Array.from(selectedChatIds);
      if (selectedChats.length === 0) {
        // If no chats selected, ask user
        const allChats = chatsData.map(c => c.chatId);
        if (allChats.length === 0) {
          setStatus('Ошибка: Нет чатов для экспорта', true);
          return;
        }
        
        // Ask user if they want to export all chats
        const exportAll = confirm(`Экспортировать все ${allChats.length} чат(ов) в MD?`);
        if (!exportAll) {
          setStatus('Экспорт отменен');
          return;
        }
        
        selectedChats.push(...allChats);
      }

      setStatus(`Экспорт ${selectedChats.length} чат(ов) в MD...`);
      
      const response = await chrome.runtime.sendMessage({
        type: 'EXPORT_MD',
        chatIds: selectedChats,
        accountEmail: currentAccountEmail
      });

      if (response && response.success && response.data) {
        // Load export-md module
        const { exportChatsToMarkdown, convertHtmlToMarkdown, formatMessageForMarkdown } = 
          await import(chrome.runtime.getURL('storage/export-md.js'));
        
        // Convert data to markdown
        const files = [];
        for (const chatData of response.data) {
          try {
            const chat = chatData.chat;
            const messages = chatData.messages || [];
            
            if (messages.length === 0) {
              continue;
            }
            
            // Build markdown content with chat-like formatting
            let markdown = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body {
  background-color: #ffffff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  max-width: 900px;
  margin: 0 auto;
  padding: 20px;
  line-height: 1.6;
  color: #333;
}
.chat-header {
  border-bottom: 1px solid #e0e0e0;
  padding-bottom: 10px;
  margin-bottom: 20px;
}
.message {
  margin: 16px 0;
  display: flex;
  flex-direction: column;
}
.message-header {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  color: #666;
}
.message-user .message-bubble {
  background-color: #f28b82;
  color: #000;
  border-radius: 18px;
  padding: 12px 16px;
  max-width: 85%;
  align-self: flex-start;
  word-wrap: break-word;
}
.message-assistant .message-bubble {
  background-color: #f1f3f4;
  color: #000;
  border-radius: 18px;
  padding: 12px 16px;
  max-width: 85%;
  align-self: flex-start;
  word-wrap: break-word;
}
.message-bubble p {
  margin: 0 0 12px 0;
  line-height: 1.6;
}
.message-bubble p:last-child {
  margin-bottom: 0;
}
.message-bubble h1, .message-bubble h2, .message-bubble h3, 
.message-bubble h4, .message-bubble h5, .message-bubble h6 {
  margin: 16px 0 8px 0;
  font-weight: 600;
  line-height: 1.4;
}
.message-bubble h1 { font-size: 1.5em; }
.message-bubble h2 { font-size: 1.3em; }
.message-bubble h3 { font-size: 1.1em; }
.message-bubble code {
  background-color: rgba(0,0,0,0.1);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: "Courier New", "Consolas", monospace;
  font-size: 0.9em;
}
.message-bubble pre {
  background-color: rgba(0,0,0,0.05);
  padding: 12px 16px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 12px 0;
  border: 1px solid rgba(0,0,0,0.1);
}
.message-bubble pre code {
  background: none;
  padding: 0;
  border-radius: 0;
}
.message-bubble ul, .message-bubble ol {
  margin: 12px 0;
  padding-left: 24px;
}
.message-bubble li {
  margin: 6px 0;
  line-height: 1.5;
}
.message-bubble a {
  color: #1a73e8;
  text-decoration: none;
}
.message-bubble a:hover {
  text-decoration: underline;
}
.message-bubble strong {
  font-weight: 600;
}
.message-bubble em {
  font-style: italic;
}
.separator {
  height: 1px;
  background-color: #e0e0e0;
  margin: 20px 0;
}
</style>
</head>
<body>
<div class="chat-header">
<h1>${chat.title || 'Безымянный чат'}</h1>`;

            if (chat.url) {
              markdown += `<p><strong>Ссылка:</strong> <a href="${chat.url}">${chat.url}</a></p>`;
            }
            
            if (chat.updatedAtUTC) {
              const date = new Date(chat.updatedAtUTC).toLocaleString('ru-RU');
              markdown += `<p><strong>Дата обновления:</strong> ${date}</p>`;
            }
            
            markdown += `</div>
<div class="separator"></div>
`;
            
            // Объединяем последовательные сообщения одного типа
            const mergedMessages = [];
            let currentGroup = null;
            
            for (const message of messages) {
              const role = message.role || 'user';
              
              if (!currentGroup || currentGroup.role !== role) {
                // Начинаем новую группу
                if (currentGroup) {
                  mergedMessages.push(currentGroup);
                }
                currentGroup = {
                  role: role,
                  messages: [message],
                  timestampUTC: message.timestampUTC
                };
              } else {
                // Добавляем к текущей группе
                currentGroup.messages.push(message);
              }
            }
            
            // Добавляем последнюю группу
            if (currentGroup) {
              mergedMessages.push(currentGroup);
            }
            
            // Export merged messages
            for (const group of mergedMessages) {
              const role = group.role;
              const timestamp = group.timestampUTC ? new Date(group.timestampUTC).toLocaleString('ru-RU') : '';
              
              // Объединяем все сообщения группы
              let combinedHtml = '';
              let combinedText = '';
              
              for (let i = 0; i < group.messages.length; i++) {
                const message = group.messages[i];
                if (message.html && message.html.trim()) {
                  // Если есть HTML, используем его
                  if (combinedHtml) {
                    combinedHtml += ' ';
                  }
                  combinedHtml += message.html;
                } else if (message.text) {
                  // Если нет HTML, используем текст
                  if (combinedText) {
                    combinedText += ' ';
                  }
                  combinedText += message.text;
                }
              }
              
              // Используем HTML напрямую, если есть, иначе текст как параграф
              let htmlContent = '';
              if (combinedHtml.trim()) {
                // Используем HTML напрямую, только очистим от лишних пробелов
                htmlContent = combinedHtml.trim();
              } else if (combinedText.trim()) {
                // Если только текст, оборачиваем в параграфы
                const paragraphs = combinedText.trim().split(/\n\n+/).filter(p => p.trim());
                htmlContent = paragraphs.map(p => `<p>${p.trim()}</p>`).join('\n');
              }
              
              if (role === 'user') {
                markdown += `<div class="message message-user">
  <div class="message-header">👤 Пользователь${timestamp ? ` • ${timestamp}` : ''}</div>
  <div class="message-bubble">${htmlContent}</div>
</div>
`;
              } else if (role === 'assistant') {
                markdown += `<div class="message message-assistant">
  <div class="message-header">🤖 Copilot${timestamp ? ` • ${timestamp}` : ''}</div>
  <div class="message-bubble">${htmlContent}</div>
</div>
`;
              } else {
                markdown += `<div class="message">
  <div class="message-header">${role}${timestamp ? ` • ${timestamp}` : ''}</div>
  <div class="message-bubble">${htmlContent}</div>
</div>
`;
              }
            }
            
            markdown += `</body>
</html>`;
            
            // Create filename
            const title = chat.title || 'Безымянный чат';
            const sanitizedTitle = title
              .replace(/[<>:"/\\|?*]/g, '_')
              .replace(/\s+/g, '_')
              .substring(0, 100);
            const filename = `${sanitizedTitle}_${chat.chatId.substring(0, 8)}.html`;
            
            files.push({
              chatId: chat.chatId,
              filename: filename,
              content: markdown,
              title: chat.title
            });
          } catch (error) {
            console.error(`Error converting chat ${chatData.chat?.chatId} to MD:`, error);
          }
        }
        
        if (files.length === 0) {
          setStatus('Ошибка: Не удалось экспортировать чаты', true);
          return;
        }

        // If single file, download directly
        if (files.length === 1 && files[0].content) {
          const file = files[0];
          const blob = new Blob([file.content], { type: 'text/html;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = file.filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          setStatus(`Экспортирован 1 файл: ${file.filename}`);
        } else {
          // Multiple files - create ZIP
          try {
            const JSZip = await loadJSZip();
            const zip = new JSZip();
            
            for (const file of files) {
              if (file.content && file.filename) {
                zip.file(file.filename, file.content);
              }
            }
            
            const zipBlob = await zip.generateAsync({ type: 'blob' });
            const zipUrl = URL.createObjectURL(zipBlob);
            const a = document.createElement('a');
            a.href = zipUrl;
            a.download = `copilot_chats_${new Date().toISOString().split('T')[0]}.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(zipUrl);
            
            setStatus(`Экспортировано ${files.length} файл(ов) в ZIP архив`);
          } catch (zipError) {
            console.error('Error creating ZIP:', zipError);
            setStatus('Ошибка создания ZIP архива', true);
          }
        }
      } else {
        setStatus(`Ошибка экспорта: ${response?.error || 'Неизвестная ошибка'}`, true);
      }
    } catch (error) {
      console.error('Export MD error:', error);
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
      
      // Проверяем, что данные действительно сохранены и доступны
      const verifyResponse = await chrome.runtime.sendMessage({ type: 'CHECK_DATA' });
      if (verifyResponse && verifyResponse.hasData) {
        console.log('Import: Data verified - database contains data after import');
        setStatus(`База данных импортирована и сохранена${strategyText}. Данные доступны для использования.`);
      } else {
        console.warn('Import: Warning - data verification failed after import');
        setStatus(`База данных импортирована${strategyText}. Проверка данных...`, true);
      }
      
      // Reinitialize reset buttons in case number of accounts changed
      await initializeResetButtons();
      
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
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    
    try {
      setStatus(`Чтение ${files.length} файл(ов)...`);
      
      // Helper function to validate data structure
      const validateDataStructure = (data, filename) => {
        // Проверка, что это объект
        if (typeof data !== 'object' || data === null || Array.isArray(data)) {
          throw new Error(`Неверный формат данных в файле ${filename}. Ожидается объект с полями accounts, chats, messages, indexes.`);
        }
        
        // Проверка наличия обязательных полей
        const missingFields = [];
        if (!data.accounts) missingFields.push('accounts');
        if (!data.chats) missingFields.push('chats');
        if (!data.messages) missingFields.push('messages');
        if (!data.indexes) missingFields.push('indexes');
        
        if (missingFields.length > 0) {
          throw new Error(`Неверный формат данных в файле ${filename}. Отсутствуют обязательные поля: ${missingFields.join(', ')}.`);
        }
        
        // Проверка типов данных
        if (!Array.isArray(data.accounts) || !Array.isArray(data.chats) || 
            !Array.isArray(data.messages) || !Array.isArray(data.indexes)) {
          throw new Error(`Неверный формат данных в файле ${filename}. Поля accounts, chats, messages, indexes должны быть массивами.`);
        }
        
        return true;
      };
      
      // Helper function to parse JSON file
      const parseJSONFile = async (file) => {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => {
            try {
              if (!e.target.result || e.target.result.trim().length === 0) {
                reject(new Error(`Файл ${file.name} пуст`));
                return;
              }
              
              let data;
              try {
                data = JSON.parse(e.target.result);
              } catch (parseError) {
                if (parseError instanceof SyntaxError) {
                  reject(new Error(`Файл ${file.name} не является валидным JSON`));
                } else {
                  reject(new Error(`Ошибка парсинга JSON в файле ${file.name}: ${parseError.message}`));
                }
                return;
              }
              
              // Validate structure using common function
              validateDataStructure(data, file.name);
              
              resolve(data);
            } catch (error) {
              reject(error);
            }
          };
          reader.onerror = () => {
            reject(new Error(`Ошибка чтения файла ${file.name}`));
          };
          reader.readAsText(file);
        });
      };
      
      // Process all files (including ZIP archives)
      const allFileData = [];
      let processedFilesCount = 0;
      let successfulFilesCount = 0;
      let failedFilesCount = 0;
      const failedFiles = [];
      
      for (const file of files) {
        processedFilesCount++;
        if (file.name.toLowerCase().endsWith('.zip')) {
          // Handle ZIP archive
          setStatus(`Распаковка архива ${file.name} (${processedFilesCount}/${files.length})...`);
          try {
            const zipLib = await loadJSZip();
            const zipData = await file.arrayBuffer();
            const zip = await zipLib.loadAsync(zipData);
            
            // Extract all JSON files from ZIP
            const jsonFiles = [];
            let zipFilesProcessed = 0;
            let zipFilesSuccessful = 0;
            let zipFilesFailed = 0;
            
            for (const filename in zip.files) {
              const zipFile = zip.files[filename];
              if (!zipFile.dir && filename.toLowerCase().endsWith('.json')) {
                zipFilesProcessed++;
                setStatus(`Обработка файла ${zipFilesProcessed} из архива ${file.name}...`);
                try {
                  const content = await zipFile.async('string');
                  
                  if (!content || content.trim().length === 0) {
                    zipFilesFailed++;
                    console.warn(`Skipping empty JSON file in ZIP: ${filename}`);
                    continue;
                  }
                  
                  let data;
                  try {
                    data = JSON.parse(content);
                  } catch (parseError) {
                    zipFilesFailed++;
                    console.warn(`Skipping invalid JSON file in ZIP: ${filename}`, parseError);
                    continue;
                  }
                  
                  // Validate structure using common function
                  try {
                    validateDataStructure(data, filename);
                    jsonFiles.push(data);
                    zipFilesSuccessful++;
                  } catch (validationError) {
                    zipFilesFailed++;
                    console.warn(`Skipping invalid data structure in ZIP file: ${filename}`, validationError);
                  }
                } catch (e) {
                  zipFilesFailed++;
                  console.warn(`Skipping file in ZIP due to error: ${filename}`, e);
                }
              }
            }
            
            if (jsonFiles.length === 0) {
              if (zipFilesProcessed === 0) {
                throw new Error(`В архиве ${file.name} не найдено JSON файлов`);
              } else {
                throw new Error(`В архиве ${file.name} не найдено валидных JSON файлов (обработано: ${zipFilesProcessed}, успешно: ${zipFilesSuccessful}, ошибок: ${zipFilesFailed})`);
              }
            }
            
            allFileData.push(...jsonFiles);
            successfulFilesCount++;
            console.log(`Import: Extracted ${jsonFiles.length} JSON files from ZIP ${file.name} (успешно: ${zipFilesSuccessful}, ошибок: ${zipFilesFailed})`);
            
            if (zipFilesFailed > 0) {
              setStatus(`Архив ${file.name}: обработано ${zipFilesSuccessful} из ${zipFilesProcessed} файлов (${zipFilesFailed} ошибок)`);
            }
          } catch (error) {
            console.error(`Import: Error processing ZIP file ${file.name}:`, error);
            failedFilesCount++;
            failedFiles.push({ name: file.name, error: error.message });
            // Continue processing other files instead of throwing
            setStatus(`Ошибка обработки архива ${file.name}: ${error.message}`, true);
          }
        } else {
          // Handle regular JSON file
          setStatus(`Обработка файла ${file.name} (${processedFilesCount}/${files.length})...`);
          try {
            const data = await parseJSONFile(file);
            allFileData.push(data);
            successfulFilesCount++;
          } catch (error) {
            console.error(`Import: Error processing file ${file.name}:`, error);
            failedFilesCount++;
            failedFiles.push({ name: file.name, error: error.message });
            // Continue processing other files instead of throwing
            setStatus(`Ошибка обработки файла ${file.name}: ${error.message}`, true);
          }
        }
      }
      
      // Show final statistics
      if (failedFilesCount > 0) {
        const failedNames = failedFiles.map(f => f.name).join(', ');
        setStatus(`Обработано файлов: ${successfulFilesCount} успешно, ${failedFilesCount} с ошибками. Проблемные файлы: ${failedNames}`, true);
      } else {
        setStatus(`Обработано файлов: ${successfulFilesCount} успешно`);
      }
      
      if (allFileData.length === 0) {
        setStatus('Ошибка: Не найдено валидных данных для импорта', true);
        importFile.value = '';
        return;
      }
      
      const fileDataArray = allFileData;
      
      // Merge all file data
      const mergedData = {
        accounts: [],
        chats: [],
        messages: [],
        indexes: []
      };
      
      // Merge accounts from all files, avoiding duplicates by email
      const accountEmails = new Set();
      for (const fileData of fileDataArray) {
        if (fileData.accounts && Array.isArray(fileData.accounts)) {
          for (const account of fileData.accounts) {
            if (account.email && !accountEmails.has(account.email)) {
              mergedData.accounts.push(account);
              accountEmails.add(account.email);
            }
          }
        }
      }
      
      // Merge chats, messages, indexes from all files
      const chatIds = new Set();
      const messageIds = new Set();
      // accountEmails already declared above for accounts merging
      
      for (const fileData of fileDataArray) {
        // Merge chats (avoid duplicates by chatId)
        if (fileData.chats) {
          for (const chat of fileData.chats) {
            if (!chatIds.has(chat.chatId)) {
              mergedData.chats.push(chat);
              chatIds.add(chat.chatId);
            }
          }
        }
        
        // Merge messages (avoid duplicates by id)
        if (fileData.messages) {
          for (const msg of fileData.messages) {
            if (!messageIds.has(msg.id)) {
              mergedData.messages.push(msg);
              messageIds.add(msg.id);
            }
          }
        }
        
        // Merge indexes (by accountEmail, keep latest)
        if (fileData.indexes) {
          for (const idx of fileData.indexes) {
            if (idx.accountEmail && !accountEmails.has(idx.accountEmail)) {
              mergedData.indexes.push(idx);
              accountEmails.add(idx.accountEmail);
            } else if (idx.accountEmail) {
              // Replace existing index for this account
              const existingIndex = mergedData.indexes.find(i => i.accountEmail === idx.accountEmail);
              if (existingIndex) {
                const index = mergedData.indexes.indexOf(existingIndex);
                mergedData.indexes[index] = idx;
              }
            }
          }
        }
      }
      
      console.log('Import: Merged data from', fileDataArray.length, 'files:', 
                  'accounts:', mergedData.accounts.length,
                  'chats:', mergedData.chats.length, 
                  'messages:', mergedData.messages.length, 
                  'indexes:', mergedData.indexes.length);
      
      // Check if database has existing data
      const hasDataResult = await hasData();
      
      if (!hasDataResult) {
        // No existing data, import directly
        await performImport(mergedData, 'replace');
      } else {
        // Has existing data, check for conflicts and show dialog
        pendingImportData = mergedData;
        
        // Check for conflicts
        const conflictResponse = await chrome.runtime.sendMessage({
          type: 'CHECK_IMPORT_CONFLICTS',
          data: mergedData
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
      setStatus(`Ошибка импорта: ${error.message || 'Неизвестная ошибка'}`, true);
      importFile.value = '';
    }
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
let resetConfirmCounts = new Map(); // Map<accountEmail, count>

// Helper function to get correct form of "чатов/чата/чат"
function getChatsText(count) {
  const lastDigit = count % 10;
  const lastTwoDigits = count % 100;
  
  if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
    return 'чатов';
  }
  
  if (lastDigit === 1) {
    return 'чат';
  } else if (lastDigit >= 2 && lastDigit <= 4) {
    return 'чата';
  } else {
    return 'чатов';
  }
}

// Get all accounts from database
async function getAllAccounts() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_ACCOUNTS'
    });
    
    if (response.success && response.accounts) {
      return response.accounts;
    }
    return [];
  } catch (error) {
    console.error('Error getting accounts:', error);
    return [];
  }
}

// Initialize reset buttons based on number of accounts
async function initializeResetButtons() {
  if (!resetBtn) return;
  
  const accounts = await getAllAccounts();
  const resetBtnContainer = resetBtn.parentElement;
  
  // Check if container exists
  if (!resetBtnContainer) {
    console.error('Reset button container not found');
    return;
  }
  
  // Remove old reset buttons if they exist
  const oldResetButtons = resetBtnContainer.querySelectorAll('.reset-btn-account');
  oldResetButtons.forEach(btn => btn.remove());
  
  if (accounts.length > 1) {
    // Hide original button for multiple accounts
    resetBtn.style.display = 'none';
    // Create multiple buttons for each account
    accounts.forEach(account => {
      const accountEmail = account.email;
      if (!accountEmail) return;
      
      const btn = document.createElement('button');
      btn.className = 'action-button danger reset-btn-account';
      btn.textContent = 'Сбросить базу';
      const chatCount = account.chatCount || 0;
      const chatCountText = `${chatCount} ${getChatsText(chatCount)}`;
      btn.title = `Сбросить базу: ${accountEmail} (${chatCountText})`;
      btn.style.position = 'relative';
      btn.style.marginTop = '4px';
      
      // Add tooltip on hover
      let tooltip = null;
      btn.addEventListener('mouseenter', (e) => {
        tooltip = document.createElement('div');
        tooltip.innerHTML = `Сбросить базу: ${accountEmail}<br/><strong>${chatCountText}</strong>`;
        tooltip.style.position = 'absolute';
        tooltip.style.bottom = '100%';
        tooltip.style.left = '50%';
        tooltip.style.transform = 'translateX(-50%)';
        tooltip.style.marginBottom = '4px';
        tooltip.style.padding = '6px 10px';
        tooltip.style.backgroundColor = '#333';
        tooltip.style.color = '#fff';
        tooltip.style.borderRadius = '4px';
        tooltip.style.fontSize = '12px';
        tooltip.style.zIndex = '10000';
        tooltip.style.pointerEvents = 'none';
        tooltip.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
        tooltip.style.maxWidth = '300px';
        tooltip.style.wordBreak = 'break-word';
        tooltip.style.whiteSpace = 'normal';
        tooltip.style.textAlign = 'center';
        tooltip.style.lineHeight = '1.4';
        btn.style.position = 'relative';
        btn.appendChild(tooltip);
      });
      
      btn.addEventListener('mouseleave', () => {
        if (tooltip && tooltip.parentElement) {
          tooltip.remove();
          tooltip = null;
        }
      });
      
      // Add click handler
      btn.addEventListener('click', () => {
        const count = resetConfirmCounts.get(accountEmail) || 0;
        resetConfirmCounts.set(accountEmail, count + 1);
        
        if (count === 0) {
          setStatus(`Нажмите еще раз для подтверждения сброса базы для ${accountEmail}`, true);
          setTimeout(() => {
            resetConfirmCounts.set(accountEmail, 0);
          }, 3000);
        } else if (count >= 1) {
          resetConfirmCounts.set(accountEmail, 0);
          performReset(accountEmail);
        }
      });
      
      resetBtnContainer.appendChild(btn);
    });
  } else {
    // Single account - show original button with tooltip
    // Get account info for tooltip
    const account = accounts.length > 0 ? accounts[0] : null;
    
    // Remove old handlers by cloning button to avoid duplicate handlers
    if (resetBtn.parentNode) {
      const newResetBtn = resetBtn.cloneNode(true);
      resetBtn.parentNode.replaceChild(newResetBtn, resetBtn);
    }
    const resetBtnRef = document.getElementById('resetBtn');
    if (!resetBtnRef) {
      console.error('Reset button not found after clone');
      return;
    }
    resetBtnRef.style.display = '';
    resetBtnRef.style.position = 'relative';
    
    if (account) {
      const accountEmail = account.email;
      const chatCount = account.chatCount || 0;
      const chatCountText = `${chatCount} ${getChatsText(chatCount)}`;
      
      // Add tooltip on hover
      let tooltip = null;
      resetBtnRef.addEventListener('mouseenter', () => {
        if (tooltip) return; // Avoid duplicates
        
        tooltip = document.createElement('div');
        tooltip.className = 'reset-tooltip';
        tooltip.innerHTML = `Сбросить базу: ${accountEmail}<br/><strong>${chatCountText}</strong>`;
        tooltip.style.position = 'absolute';
        tooltip.style.bottom = '100%';
        tooltip.style.left = '50%';
        tooltip.style.transform = 'translateX(-50%)';
        tooltip.style.marginBottom = '4px';
        tooltip.style.padding = '6px 10px';
        tooltip.style.backgroundColor = '#333';
        tooltip.style.color = '#fff';
        tooltip.style.borderRadius = '4px';
        tooltip.style.fontSize = '12px';
        tooltip.style.zIndex = '10000';
        tooltip.style.pointerEvents = 'none';
        tooltip.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
        tooltip.style.maxWidth = '300px';
        tooltip.style.wordBreak = 'break-word';
        tooltip.style.whiteSpace = 'normal';
        tooltip.style.textAlign = 'center';
        tooltip.style.lineHeight = '1.4';
        resetBtnRef.appendChild(tooltip);
      });
      
      resetBtnRef.addEventListener('mouseleave', () => {
        if (tooltip && tooltip.parentElement) {
          tooltip.remove();
          tooltip = null;
        }
      });
    }
    
    // Add click handler
    resetBtnRef.addEventListener('click', () => {
      // Use account.email from the account object, not currentAccountEmail
      // This ensures we reset the correct account even if currentAccountEmail is different
      const accountEmail = account ? account.email : (currentAccountEmail || null);
      if (!accountEmail) {
        setStatus('Аккаунт не определен', true);
        return;
      }
      
      const count = resetConfirmCounts.get(accountEmail) || 0;
      resetConfirmCounts.set(accountEmail, count + 1);
      
      if (count === 0) {
        setStatus(`Нажмите еще раз для подтверждения сброса базы для ${accountEmail}`, true);
        setTimeout(() => {
          resetConfirmCounts.set(accountEmail, 0);
        }, 3000);
      } else if (count >= 1) {
        resetConfirmCounts.set(accountEmail, 0);
        performReset(accountEmail);
      }
    });
  }
}

async function performReset(accountEmail) {
  // Store the original accountEmail parameter to ensure we use the correct one
  const targetAccountEmail = accountEmail || currentAccountEmail;
  
  if (!targetAccountEmail) {
    setStatus('Аккаунт не определен', true);
    return;
  }
  
  // Use the target account email consistently throughout the function
  if (!confirm(`Вы уверены? Все данные для аккаунта ${targetAccountEmail} будут удалены!`)) {
    return;
  }
  
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'RESET_DB',
      accountEmail: targetAccountEmail
    });
    
    if (response.success) {
      // Clear in-memory data only if reset account is current account
      if (targetAccountEmail === currentAccountEmail) {
        chatsData = [];
        selectedChatIds.clear();
        chatCheckboxes.clear();
        
        // Clear search results and input
        if (searchResults) {
          searchResults.innerHTML = '';
        }
        if (searchEmpty) {
          searchEmpty.style.display = 'block';
        }
        if (searchInput) {
          searchInput.value = '';
        }
        
        // Reload chats list to show empty state
        await loadChatsForSelection();
      }
      
      setStatus(`База данных для аккаунта ${targetAccountEmail} сброшена`);
      
      // Reinitialize reset buttons in case account was deleted
      await initializeResetButtons();
      
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
  // Убираем проверку currentAccountEmail - теперь поиск работает по всем аккаунтам
  if (query.length < 2) {
    searchResults.innerHTML = '';
    searchEmpty.style.display = 'block';
    return;
  }
  
  searchEmpty.style.display = 'none';
  searchResults.innerHTML = '<div style="padding: 12px; text-align: center; color: #666;">Поиск...</div>';
  
  // Передаем null для поиска по всем аккаунтам, или currentAccountEmail для поиска только по текущему
  chrome.runtime.sendMessage({
    type: 'SEARCH',
    accountEmail: null, // null означает поиск по всем аккаунтам
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

// Функция для генерации пастельного цвета на основе email
function getPastelColorForAccount(email) {
  if (!email) return '#f0f0f0';
  
  // Генерируем хеш из email для стабильного цвета
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = email.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  // Генерируем пастельные цвета (высокая яркость, низкая насыщенность)
  const hue = Math.abs(hash) % 360;
  // Используем HSL для пастельных тонов: высокая яркость (85-95%), средняя насыщенность (40-60%)
  const saturation = 45 + (Math.abs(hash) % 20); // 45-65%
  const lightness = 88 + (Math.abs(hash) % 7); // 88-95%
  
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

// Функция для применения пастельных фонов к буквам в HTML тексте
function applyPastelBackgroundToText(html, accountEmail, colorMap) {
  if (!accountEmail || !colorMap || !colorMap.has(accountEmail)) {
    return html;
  }
  
  const color = colorMap.get(accountEmail);
  
  // Создаем временный элемент для парсинга HTML
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;
  
  // Рекурсивно обрабатываем все текстовые узлы
  function processNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      if (text && text.trim().length > 0) {
        // Заменяем каждую букву на span с фоном
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < text.length; i++) {
          const char = text[i];
          const span = document.createElement('span');
          span.style.backgroundColor = color;
          span.style.padding = '0 1px';
          span.style.borderRadius = '2px';
          span.style.display = 'inline-block';
          span.textContent = char;
          fragment.appendChild(span);
        }
        if (node.parentNode) {
          node.parentNode.replaceChild(fragment, node);
        }
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      // Рекурсивно обрабатываем дочерние узлы (копируем массив, так как он может измениться)
      const children = Array.from(node.childNodes);
      children.forEach(processNode);
    }
  }
  
  // Обрабатываем все узлы
  const children = Array.from(tempDiv.childNodes);
  children.forEach(processNode);
  
  return tempDiv.innerHTML;
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
  collapsedChats.clear();
  allChatsCollapsed = false;
  
  // Удаляем старые обработчики скролла, если они есть
  const oldScrollHandler = searchResults._scrollHandler;
  if (oldScrollHandler) {
    searchResults.removeEventListener('scroll', oldScrollHandler);
  }
  
  // Определяем уникальные аккаунты из результатов
  const uniqueAccounts = new Set();
  results.forEach(result => {
    if (result.accountEmail) {
      uniqueAccounts.add(result.accountEmail);
    }
  });
  
  // Создаем карту цветов для аккаунтов
  const accountColorMap = new Map();
  uniqueAccounts.forEach(email => {
    accountColorMap.set(email, getPastelColorForAccount(email));
  });
  
  // Заголовок с кнопкой "Свернуть все/Развернуть все"
  const resultsHeader = document.createElement('div');
  resultsHeader.className = 'search-results-header';
  resultsHeader.style.display = 'flex';
  resultsHeader.style.justifyContent = 'space-between';
  resultsHeader.style.alignItems = 'center';
  resultsHeader.style.marginBottom = '8px';
  resultsHeader.style.padding = '4px 0';
  resultsHeader.style.transition = 'transform 0.3s ease-in-out, opacity 0.3s ease-in-out';
  resultsHeader.style.opacity = '1';
  
  // Контейнер для счетчика и легенды
  const headerLeft = document.createElement('div');
  headerLeft.style.display = 'flex';
  headerLeft.style.flexDirection = 'column';
  headerLeft.style.gap = '4px';
  headerLeft.style.flex = '1';
  
  const resultsCount = document.createElement('div');
  resultsCount.className = 'search-results-count';
  resultsCount.style.fontSize = '12px';
  resultsCount.style.color = '#666';
  resultsCount.textContent = `Найдено чатов: ${results.length}`;
  
  headerLeft.appendChild(resultsCount);
  
  // Легенда аккаунтов (только если аккаунтов больше 1)
  if (uniqueAccounts.size > 1) {
    const legendContainer = document.createElement('div');
    legendContainer.className = 'search-accounts-legend';
    legendContainer.style.display = 'flex';
    legendContainer.style.flexWrap = 'wrap';
    legendContainer.style.gap = '6px';
    legendContainer.style.fontSize = '10px';
    legendContainer.style.marginTop = '2px';
    
    Array.from(uniqueAccounts).forEach(email => {
      const legendItem = document.createElement('div');
      legendItem.style.display = 'flex';
      legendItem.style.alignItems = 'center';
      legendItem.style.gap = '4px';
      
      const colorBox = document.createElement('span');
      colorBox.style.width = '12px';
      colorBox.style.height = '12px';
      colorBox.style.borderRadius = '2px';
      colorBox.style.backgroundColor = accountColorMap.get(email);
      colorBox.style.border = '1px solid rgba(0,0,0,0.1)';
      colorBox.style.flexShrink = '0';
      
      const emailLabel = document.createElement('span');
      emailLabel.style.color = '#666';
      // Показываем короткий email (до @ или первые 15 символов)
      const shortEmail = email.includes('@') ? email.split('@')[0] : email.substring(0, 15);
      emailLabel.textContent = shortEmail;
      
      legendItem.appendChild(colorBox);
      legendItem.appendChild(emailLabel);
      legendContainer.appendChild(legendItem);
    });
    
    headerLeft.appendChild(legendContainer);
  }
  
  const toggleAllBtn = document.createElement('button');
  toggleAllBtn.className = 'search-toggle-all-btn';
  toggleAllBtn.style.padding = '4px 8px';
  toggleAllBtn.style.border = '1px solid #c7c7c7';
  toggleAllBtn.style.background = '#fff';
  toggleAllBtn.style.borderRadius = '4px';
  toggleAllBtn.style.cursor = 'pointer';
  toggleAllBtn.style.fontSize = '11px';
  toggleAllBtn.style.color = '#666';
  toggleAllBtn.style.alignSelf = 'flex-start';
  toggleAllBtn.style.marginTop = '2px';
  toggleAllBtn.textContent = 'Свернуть все';
  toggleAllBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAllChats(results);
  });
  
  resultsHeader.appendChild(headerLeft);
  resultsHeader.appendChild(toggleAllBtn);
  searchResults.appendChild(resultsHeader);
  
  // Функция для переключения состояния всех чатов
  function toggleAllChats(results) {
    allChatsCollapsed = !allChatsCollapsed;
    toggleAllBtn.textContent = allChatsCollapsed ? 'Развернуть все' : 'Свернуть все';
    
    const items = searchResults.querySelectorAll('.search-result-item');
    items.forEach((item, index) => {
      const chatId = results[index]?.chatId || index;
      const collapseBtn = item.querySelector('.search-collapse-btn');
      
      if (allChatsCollapsed) {
        collapsedChats.add(chatId);
        item.classList.add('collapsed');
        if (collapseBtn) {
          collapseBtn.textContent = '▶';
        }
      } else {
        collapsedChats.delete(chatId);
        item.classList.remove('collapsed');
        if (collapseBtn) {
          collapseBtn.textContent = '▼';
        }
      }
    });
  }
  
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const chatId = result.chatId || i;
    const item = document.createElement('div');
    item.className = 'search-result-item';
    item.dataset.chatId = chatId;
    
    // Заголовок чата с кнопкой сворачивания
    const titleRow = document.createElement('div');
    titleRow.className = 'search-result-title-row';
    titleRow.style.display = 'flex';
    titleRow.style.justifyContent = 'space-between';
    titleRow.style.alignItems = 'center';
    titleRow.style.marginBottom = '8px';
    titleRow.style.cursor = 'pointer';
    
    const titleLeft = document.createElement('div');
    titleLeft.style.display = 'flex';
    titleLeft.style.alignItems = 'center';
    titleLeft.style.flex = '1';
    titleLeft.style.minWidth = '0';
    titleLeft.style.gap = '8px';
    
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'search-collapse-btn';
    collapseBtn.style.padding = '2px 4px';
    collapseBtn.style.border = 'none';
    collapseBtn.style.background = 'transparent';
    collapseBtn.style.cursor = 'pointer';
    collapseBtn.style.fontSize = '12px';
    collapseBtn.style.color = '#666';
    collapseBtn.style.width = '20px';
    collapseBtn.style.height = '20px';
    collapseBtn.style.display = 'flex';
    collapseBtn.style.alignItems = 'center';
    collapseBtn.style.justifyContent = 'center';
    collapseBtn.textContent = '▼';
    collapseBtn.style.transition = 'transform 0.2s';
    
    const title = document.createElement('div');
    title.className = 'search-result-title';
    title.style.marginBottom = '0';
    title.style.flex = '1';
    title.style.minWidth = '0';
    title.textContent = result.title || 'Без названия';
    title.style.textDecoration = 'underline';
    title.style.color = '#1a66d4';
    title.style.cursor = 'pointer';
    
    // Применяем пастельный фон к заголовку, если аккаунтов больше 1
    if (uniqueAccounts.size > 1 && result.accountEmail && accountColorMap.has(result.accountEmail)) {
      const accountColor = accountColorMap.get(result.accountEmail);
      title.style.backgroundColor = accountColor;
      title.style.padding = '2px 6px';
      title.style.borderRadius = '4px';
      title.style.display = 'inline-block';
    }
    
    title.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.tabs.create({ url: result.url });
    });
    
    const dateInfo = document.createElement('div');
    dateInfo.className = 'search-result-date';
    dateInfo.style.fontSize = '11px';
    dateInfo.style.color = '#666';
    dateInfo.style.marginLeft = '8px';
    dateInfo.style.flexShrink = '0';
    dateInfo.textContent = result.updatedAtUTC ? formatDate(result.updatedAtUTC) : '';
    
    titleLeft.appendChild(collapseBtn);
    titleLeft.appendChild(title);
    titleRow.appendChild(titleLeft);
    if (dateInfo.textContent) {
      titleRow.appendChild(dateInfo);
    }
    
    // Обработчик сворачивания/разворачивания отдельного чата
    const toggleChat = () => {
      const isCollapsed = collapsedChats.has(chatId);
      if (isCollapsed) {
        collapsedChats.delete(chatId);
        item.classList.remove('collapsed');
        collapseBtn.textContent = '▼';
        collapseBtn.style.transform = 'rotate(0deg)';
      } else {
        collapsedChats.add(chatId);
        item.classList.add('collapsed');
        collapseBtn.textContent = '▶';
        collapseBtn.style.transform = 'rotate(0deg)';
      }
      // Обновляем состояние кнопки "Свернуть все"
      updateToggleAllButton();
    };
    
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleChat();
    });
    
    titleRow.addEventListener('click', (e) => {
      if (e.target !== title && e.target !== collapseBtn) {
        toggleChat();
      }
    });
    
    // Контент чата (matchInfo + snippets)
    const chatContent = document.createElement('div');
    chatContent.className = 'search-result-content';
    
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
        snippetEl.innerHTML = snippet; // Убрали применение пастельных цветов к тексту
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
    
    chatContent.appendChild(matchInfo);
    chatContent.appendChild(snippets);
    
    item.appendChild(titleRow);
    item.appendChild(chatContent);
    searchResults.appendChild(item);
  }
  
  // Функция для обновления состояния кнопки "Свернуть все"
  function updateToggleAllButton() {
    const items = searchResults.querySelectorAll('.search-result-item');
    const allCollapsed = items.length > 0 && Array.from(items).every(item => item.classList.contains('collapsed'));
    const allExpanded = items.length > 0 && Array.from(items).every(item => !item.classList.contains('collapsed'));
    
    if (allCollapsed) {
      toggleAllBtn.textContent = 'Развернуть все';
      allChatsCollapsed = true;
    } else if (allExpanded) {
      toggleAllBtn.textContent = 'Свернуть все';
      allChatsCollapsed = false;
    } else {
      toggleAllBtn.textContent = 'Свернуть все';
      allChatsCollapsed = false;
    }
  }
  
  // Обработчик скролла для скрытия/показа заголовка
  let lastScrollTop = 0;
  let scrollTimeout = null;
  
  const scrollHandler = () => {
    const currentScrollTop = searchResults.scrollTop;
    
    if (scrollTimeout) {
      clearTimeout(scrollTimeout);
    }
    
    // Плавное скрытие/показ при скролле
    if (currentScrollTop > lastScrollTop && currentScrollTop > 10) {
      // Скролл вниз - скрываем заголовок
      resultsHeader.style.transform = 'translateY(-100%)';
      resultsHeader.style.opacity = '0';
    } else if (currentScrollTop < lastScrollTop) {
      // Скролл вверх - показываем заголовок
      resultsHeader.style.transform = 'translateY(0)';
      resultsHeader.style.opacity = '1';
    }
    
    lastScrollTop = currentScrollTop;
    
    // Небольшая задержка перед скрытием при остановке скролла
    scrollTimeout = setTimeout(() => {
      if (currentScrollTop === 0) {
        resultsHeader.style.transform = 'translateY(0)';
        resultsHeader.style.opacity = '1';
      }
    }, 150);
  };
  
  // Сохраняем ссылку на обработчик для возможности удаления
  searchResults._scrollHandler = scrollHandler;
  searchResults.addEventListener('scroll', scrollHandler);
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
