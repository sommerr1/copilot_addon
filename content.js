// Content script для извлечения информации об аккаунте из попапа Copilot

function convertHtmlToPlainText(html) {
    // 1. Создаём DOM
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    // 2. Удаляем элементы, которые точно не нужны
    const selectorsToRemove = [
        "img",
        ".sr-only",
        "[data-testid='sticky-header']",
        "[data-testid='date-divider']",
        "svg",
        "button:not([data-content])",
        "nav",
        "header",
        "footer"
    ];
    selectorsToRemove.forEach(sel => {
        doc.querySelectorAll(sel).forEach(el => el.remove());
    });

    // 3. Теги, из которых извлекаем текст
    const allowedTags = [
        "p", "li", "h1", "h2", "h3", "h4", "h5", "h6",
        "code", "pre", "td", "th", "span", "div"
    ];

    let fragments = [];

    allowedTags.forEach(tag => {
        doc.querySelectorAll(tag).forEach(el => {
            // Пропускаем элементы, которые являются частью UI, а не контента
            if (el.closest('button') && !el.hasAttribute('data-content')) return;
            if (el.closest('nav') || el.closest('header') || el.closest('footer')) return;
            
            let text = el.textContent || "";

            // 4. Удаляем эмодзи
            text = text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");

            // 5. Нормализуем пробелы
            text = text.replace(/\s+/g, " ").trim();

            if (text.length < 2) return;

            // 6. Разбиваем на предложения
            const sentences = splitIntoSentences(text);

            // 7. Добавляем предложения в общий массив
            sentences.forEach(s => {
                if (s.length > 1) fragments.push(s);
            });
        });
    });

    // 8. Удаляем дубликаты
    fragments = [...new Set(fragments)];

    return fragments;
}

// --- Вспомогательная функция разбиения на предложения ---
function splitIntoSentences(text) {
    // Разбиваем по . ! ? с учётом кириллицы и латиницы
    const raw = text.split(/(?<=[.!?])\s+/g);

    return raw
        .map(s => s.trim())
        .filter(s => s.length > 1);
}

// Функция для поиска email в DOM
function findEmailInDOM() {
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  let email = null;
  let accountName = null;
  let accountInfo = null;

  // Стратегия 1: Поиск по текстовому содержимому с паттерном email
  function searchForEmail(element = document.body, depth = 0) {
    if (depth > 10) return null; // Ограничение глубины поиска
    
    if (!element) return null;
    
    // Проверяем текстовое содержимое элемента
    const text = element.textContent || element.innerText || '';
    const emailMatch = text.match(emailPattern);
    if (emailMatch) {
      // Проверяем, что это не случайное совпадение в URL или коде
      const emailCandidate = emailMatch[0];
      if (emailCandidate.includes('@') && !emailCandidate.includes('http') && 
          !emailCandidate.includes('//') && emailCandidate.length < 100) {
        return emailCandidate;
      }
    }
    
    // Рекурсивно проверяем дочерние элементы
    for (const child of Array.from(element.children || [])) {
      const found = searchForEmail(child, depth + 1);
      if (found) return found;
    }
    
    return null;
  }

  // Стратегия 2: Поиск в попапе аккаунта (обычно внизу слева)
  function findAccountPopup() {
    // Ищем элементы, которые могут содержать информацию об аккаунте
    // Copilot обычно использует определенные селекторы
    
    // Попытка найти по атрибутам и классам
    const possibleSelectors = [
      '[data-testid*="account"]',
      '[data-testid*="user"]',
      '[data-testid*="profile"]',
      '[aria-label*="account" i]',
      '[aria-label*="user" i]',
      '[aria-label*="profile" i]',
      '.account-info',
      '.user-info',
      '.profile-info',
      '[class*="account"]',
      '[class*="user"]',
      '[class*="profile"]',
      'button[aria-label*="account" i]',
      'button[aria-label*="user" i]'
    ];

    for (const selector of possibleSelectors) {
      try {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const text = el.textContent || el.innerText || '';
          const emailMatch = text.match(emailPattern);
          if (emailMatch) {
            const emailCandidate = emailMatch[0];
            if (emailCandidate.includes('@') && emailCandidate.length < 100) {
              return {
                email: emailCandidate,
                element: el,
                text: text.trim()
              };
            }
          }
        }
      } catch (e) {
        // Игнорируем ошибки селекторов
      }
    }
    return null;
  }

  // Стратегия 3: Поиск в localStorage/sessionStorage (может содержать информацию о пользователе)
  function searchInStorage() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        const value = localStorage.getItem(key);
        if (value && typeof value === 'string') {
          const emailMatch = value.match(emailPattern);
          if (emailMatch) {
            return emailMatch[0];
          }
          // Пытаемся распарсить как JSON
          try {
            const parsed = JSON.parse(value);
            const jsonStr = JSON.stringify(parsed);
            const emailMatch = jsonStr.match(emailPattern);
            if (emailMatch) {
              return emailMatch[0];
            }
          } catch (e) {
            // Не JSON
          }
        }
      }
    } catch (e) {
      // Доступ к storage может быть ограничен
    }
    return null;
  }

  // Стратегия 4: Поиск в data-атрибутах
  function searchInDataAttributes() {
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      for (const attr of el.attributes || []) {
        if (attr.value && typeof attr.value === 'string') {
          const emailMatch = attr.value.match(emailPattern);
          if (emailMatch && emailMatch[0].length < 100) {
            return emailMatch[0];
          }
        }
      }
    }
    return null;
  }

  // Пробуем все стратегии
  email = findAccountPopup()?.email || 
          searchForEmail() || 
          searchInStorage() || 
          searchInDataAttributes();

  // Если нашли email, пытаемся найти имя пользователя рядом
  if (email) {
    const accountPopup = findAccountPopup();
    if (accountPopup && accountPopup.element) {
      const parentText = accountPopup.element.textContent || '';
      // Ищем имя пользователя (обычно перед email или в том же элементе)
      const lines = parentText.split('\n').map(l => l.trim()).filter(l => l);
      for (const line of lines) {
        if (line && !line.includes('@') && line.length > 2 && line.length < 50) {
          accountName = line;
          break;
        }
      }
    }
  }

  return {
    email: email,
    name: accountName,
    found: !!email
  };
}

// Функция для ожидания появления попапа (если он еще не загружен)
function waitForAccountPopup(maxAttempts = 10, delay = 500) {
  return new Promise((resolve) => {
    let attempts = 0;
    
    const checkInterval = setInterval(() => {
      attempts++;
      const result = findEmailInDOM();
      
      if (result.email || attempts >= maxAttempts) {
        clearInterval(checkInterval);
        resolve(result);
      }
    }, delay);
    
    // Также проверяем сразу
    const immediateResult = findEmailInDOM();
    if (immediateResult.email) {
      clearInterval(checkInterval);
      resolve(immediateResult);
    }
  });
}

// Функция для извлечения сообщений из чата
function extractChatMessages() {
  const messages = [];
  
  // Ищем сообщения пользователя и ассистента
  // Copilot использует определенные селекторы для сообщений
  const userMessageSelectors = [
    '[data-content="user-message"]',
    '[data-testid*="user-message"]',
    '[role="article"][aria-labelledby*="user-message"]',
    '.user-message',
    '[class*="user-message"]'
  ];
  
  const assistantMessageSelectors = [
    '[data-content="ai-message"]',
    '[data-testid*="ai-message"]',
    '[role="article"][aria-labelledby*="ai-message"]',
    '.ai-message',
    '[class*="ai-message"]',
    '[class*="assistant-message"]'
  ];
  
  // Извлекаем сообщения пользователя
  for (const selector of userMessageSelectors) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      // Используем улучшенный парсинг для извлечения текста
      const fragments = convertHtmlToPlainText(el.innerHTML);
      const fullText = fragments.join(' ').trim();
      
      if (fullText.length > 0) {
        // Извлекаем временную метку если есть
        const timeEl = el.querySelector('time') || 
                      el.closest('[role="article"]')?.querySelector('time') ||
                      el.closest('[role="article"]')?.querySelector('[data-testid*="date"]');
        let timestamp = null;
        if (timeEl) {
          timestamp = timeEl.getAttribute('datetime') || 
                     timeEl.getAttribute('title') || 
                     timeEl.textContent;
        }
        
        // Если нашли несколько фрагментов, создаем отдельные сообщения
        if (fragments.length > 1) {
          fragments.forEach(fragment => {
            if (fragment.trim().length > 1) {
              messages.push({
                role: 'user',
                text: fragment.trim(),
                timestampUTC: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString()
              });
            }
          });
        } else {
          messages.push({
            role: 'user',
            text: fullText,
            timestampUTC: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString()
          });
        }
      }
    }
  }
  
  // Извлекаем сообщения ассистента
  for (const selector of assistantMessageSelectors) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      const fragments = convertHtmlToPlainText(el.innerHTML);
      const fullText = fragments.join(' ').trim();
      
      if (fullText.length > 0) {
        const timeEl = el.querySelector('time') || 
                      el.closest('[role="article"]')?.querySelector('time') ||
                      el.closest('[role="article"]')?.querySelector('[data-testid*="date"]');
        let timestamp = null;
        if (timeEl) {
          timestamp = timeEl.getAttribute('datetime') || 
                     timeEl.getAttribute('title') || 
                     timeEl.textContent;
        }
        
        if (fragments.length > 1) {
          fragments.forEach(fragment => {
            if (fragment.trim().length > 1) {
              messages.push({
                role: 'assistant',
                text: fragment.trim(),
                timestampUTC: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString()
              });
            }
          });
        } else {
          messages.push({
            role: 'assistant',
            text: fullText,
            timestampUTC: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString()
          });
        }
      }
    }
  }
  
  // Если не нашли через селекторы, используем улучшенный парсинг
  if (messages.length === 0) {
    const allMessages = document.querySelectorAll('[role="article"]');
    for (const msgEl of allMessages) {
      const isUser = msgEl.querySelector('[data-content="user-message"]') || 
                     msgEl.getAttribute('aria-labelledby')?.includes('user-message');
      const isAssistant = msgEl.querySelector('[data-content="ai-message"]') ||
                          msgEl.getAttribute('aria-labelledby')?.includes('ai-message') ||
                          msgEl.getAttribute('aria-labelledby')?.includes('author') ||
                          msgEl.classList.toString().includes('ai-message');
      
      if (isUser || isAssistant) {
        const fragments = convertHtmlToPlainText(msgEl.innerHTML);
        const fullText = fragments.join(' ').trim();
        
        if (fullText.length > 0) {
          const timeEl = msgEl.querySelector('time') || msgEl.querySelector('[data-testid*="date"]');
          const timestamp = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent) : null;
          
          messages.push({
            role: isUser ? 'user' : 'assistant',
            text: fullText,
            timestampUTC: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString()
          });
        }
      }
    }
  }
  
  // Сортируем сообщения по времени (если есть временные метки)
  messages.sort((a, b) => {
    const timeA = new Date(a.timestampUTC).getTime();
    const timeB = new Date(b.timestampUTC).getTime();
    return timeA - timeB;
  });
  
  // Удаляем дубликаты по тексту
  const uniqueMessages = [];
  const seenTexts = new Set();
  for (const msg of messages) {
    const textKey = msg.text.substring(0, 150).toLowerCase().trim(); // Первые 150 символов для сравнения
    if (!seenTexts.has(textKey) && textKey.length > 2) {
      seenTexts.add(textKey);
      uniqueMessages.push(msg);
    }
  }
  
  return uniqueMessages;
}

// Улучшенная функция для извлечения текста из HTML с разделением на сообщения
function extractMessagesFromChat() {
  const messages = extractChatMessages();
  
  // Если не нашли через селекторы, используем общий парсинг
  if (messages.length === 0) {
    const chatContainer = document.querySelector('[data-content="conversation"]') || 
                          document.querySelector('[data-testid="chat-page"]') ||
                          document.body;
    
    if (chatContainer) {
      const fragments = convertHtmlToPlainText(chatContainer.innerHTML);
      // Пытаемся определить роль по контексту (это упрощенный подход)
      let currentRole = 'user';
      for (const fragment of fragments) {
        if (fragment.trim().length > 1) {
          // Простая эвристика: если фраза начинается с определенных слов, это может быть ассистент
          const isAssistant = /^(отлично|давайте|можно|рекомендую|согласно|вот|это|таким образом)/i.test(fragment.trim());
          messages.push({
            role: isAssistant ? 'assistant' : currentRole,
            text: fragment.trim(),
            timestampUTC: new Date().toISOString()
          });
          // Чередуем роли для следующих сообщений
          currentRole = currentRole === 'user' ? 'assistant' : 'user';
        }
      }
    }
  }
  
  return messages;
}

// Функция для извлечения HTML сообщений из чата (с сохранением форматирования и порядка)
function extractChatMessagesWithHtml() {
  const messages = [];
  const messageElements = new Map(); // Для сохранения порядка DOM

  // Helper function to clean HTML while preserving formatting
  function cleanMessageHtml(html) {
    if (!html) return '';
    
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    // Remove UI elements
    const selectorsToRemove = [
      'img',
      '.sr-only',
      '[data-testid="sticky-header"]',
      '[data-testid="date-divider"]',
      'svg',
      'button:not([data-content])',
      'nav',
      'header',
      'footer',
      'script',
      'style',
      '[aria-hidden="true"]',
      '.hidden',
      '[style*="display: none"]'
    ];
    
    selectorsToRemove.forEach(sel => {
      try {
        doc.querySelectorAll(sel).forEach(el => el.remove());
      } catch (e) {
        // Ignore
      }
    });
    
    // Удаляем атрибуты стилей, но сохраняем структуру
    doc.querySelectorAll('*').forEach(el => {
      // Удаляем инлайн стили, data-атрибуты (кроме важных), классы
      el.removeAttribute('style');
      el.removeAttribute('class');
      Array.from(el.attributes).forEach(attr => {
        if (attr.name.startsWith('data-') && !['data-content'].includes(attr.name)) {
          el.removeAttribute(attr.name);
        }
      });
    });
    
    // Удаляем пустые элементы (кроме форматирующих тегов)
    const formattingTags = ['p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'blockquote', 'div', 'span'];
    doc.querySelectorAll('*').forEach(el => {
      const tagName = el.tagName?.toLowerCase();
      // Удаляем только если элемент пустой и не является форматирующим тегом
      if (el.children.length === 0 && !el.textContent?.trim() && !formattingTags.includes(tagName)) {
        el.remove();
      }
    });
    
    // Получаем очищенный HTML
    let cleanedHtml = doc.body.innerHTML || '';
    
    // Нормализуем пробелы, но сохраняем структуру
    cleanedHtml = cleanedHtml
      .replace(/>\s+</g, '><') // Пробелы между тегами
      .trim();
    
    return cleanedHtml;
  }
  
  // Извлекаем все сообщения в порядке появления в DOM
  // Используем общий селектор для всех сообщений
  const allMessageElements = document.querySelectorAll('[role="article"]');
  
  for (const msgEl of allMessageElements) {
    // Определяем тип сообщения
    const isUser = msgEl.querySelector('[data-content="user-message"]') || 
                   msgEl.getAttribute('aria-labelledby')?.includes('user-message') ||
                   msgEl.querySelector('[data-testid*="user-message"]') ||
                   msgEl.classList.toString().includes('user-message');
    
    const isAssistant = msgEl.querySelector('[data-content="ai-message"]') ||
                        msgEl.getAttribute('aria-labelledby')?.includes('ai-message') ||
                        msgEl.getAttribute('aria-labelledby')?.includes('author') ||
                        msgEl.querySelector('[data-testid*="ai-message"]') ||
                        msgEl.classList.toString().includes('ai-message') ||
                        msgEl.classList.toString().includes('assistant-message');
    
    if (!isUser && !isAssistant) {
      continue;
    }
    
    // Для ответов Copilot ищем более широкий контейнер с контентом
    let contentElement = msgEl;
    if (isAssistant) {
      // Ищем контейнер с основным контентом ответа
      const contentContainer = msgEl.querySelector('[data-content="ai-message"]') || 
                              msgEl.querySelector('[class*="message-content"]') ||
                              msgEl.querySelector('[class*="response-content"]') ||
                              msgEl;
      contentElement = contentContainer;
    }
    
    const html = cleanMessageHtml(contentElement.innerHTML);
    // Берем весь текст целиком, не разбивая на предложения
    const text = contentElement.textContent?.trim() || '';
    
    if (text.length > 0) {
      const timeEl = msgEl.querySelector('time') || 
                    msgEl.querySelector('[data-testid*="date"]') ||
                    msgEl.closest('[role="article"]')?.querySelector('time');
      const timestamp = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent) : null;
      
      // Сохраняем порядок появления в DOM
      const domOrder = Array.from(allMessageElements).indexOf(msgEl);
      
      messages.push({
        role: isUser ? 'user' : 'assistant',
        text: text,
        html: html,
        timestampUTC: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString(),
        domOrder: domOrder // Для сохранения порядка
      });
    }
  }
  
  // Если не нашли через role="article", пробуем другие селекторы
  if (messages.length === 0) {
    const userMessageSelectors = [
      '[data-content="user-message"]',
      '[data-testid*="user-message"]',
      '.user-message',
      '[class*="user-message"]'
    ];
    
    const assistantMessageSelectors = [
      '[data-content="ai-message"]',
      '[data-testid*="ai-message"]',
      '.ai-message',
      '[class*="ai-message"]',
      '[class*="assistant-message"]'
    ];
    
    // Собираем все элементы и сортируем по позиции в DOM
    const allElements = [];
    
    userMessageSelectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(el => {
        allElements.push({ el, role: 'user', selector });
      });
    });
    
    assistantMessageSelectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(el => {
        allElements.push({ el, role: 'assistant', selector });
      });
    });
    
    // Сортируем по позиции в DOM
    allElements.sort((a, b) => {
      const posA = Array.from(document.body.querySelectorAll('*')).indexOf(a.el);
      const posB = Array.from(document.body.querySelectorAll('*')).indexOf(b.el);
      return posA - posB;
    });
    
    // Удаляем дубликаты (один элемент может соответствовать нескольким селекторам)
    const seenElements = new Set();
    for (const { el, role } of allElements) {
      if (seenElements.has(el)) continue;
      seenElements.add(el);
      
      const html = cleanMessageHtml(el.innerHTML);
      const text = el.textContent?.trim() || '';
      
      if (text.length > 0) {
        const timeEl = el.querySelector('time') || 
                      el.closest('[role="article"]')?.querySelector('time') ||
                      el.closest('[role="article"]')?.querySelector('[data-testid*="date"]');
        const timestamp = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent) : null;
        
        messages.push({
          role: role,
          text: text,
          html: html,
          timestampUTC: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString(),
          domOrder: Array.from(document.body.querySelectorAll('*')).indexOf(el)
        });
      }
    }
  }
  
  // Сортируем по порядку в DOM (domOrder), а не по времени
  messages.sort((a, b) => {
    if (a.domOrder !== undefined && b.domOrder !== undefined) {
      return a.domOrder - b.domOrder;
    }
    // Fallback: сортировка по времени
    const timeA = new Date(a.timestampUTC).getTime();
    const timeB = new Date(b.timestampUTC).getTime();
    return timeA - timeB;
  });
  
  // Remove duplicates but keep order
  const uniqueMessages = [];
  const seenTexts = new Set();
  for (const msg of messages) {
    // Use full text for comparison to avoid merging different messages
    const textKey = msg.text.toLowerCase().trim();
    if (!seenTexts.has(textKey) && textKey.length > 2) {
      seenTexts.add(textKey);
      uniqueMessages.push(msg);
    }
  }
  
  return uniqueMessages;
}

// Слушаем сообщения от popup/background
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getAccountInfo') {
    // Пытаемся найти email
    const result = findEmailInDOM();
    
    // Если не нашли сразу, ждем появления попапа
    if (!result.email) {
      waitForAccountPopup().then((finalResult) => {
        sendResponse({
          success: !!finalResult.email,
          email: finalResult.email || null,
          name: finalResult.name || null,
          source: 'content_script'
        });
      });
      return true; // Асинхронный ответ
    } else {
      sendResponse({
        success: true,
        email: result.email,
        name: result.name || null,
        source: 'content_script'
      });
    }
    return true;
  }
  
  if (request.action === 'checkContentReady') {
    // Проверяем, готов ли контент к индексации (есть ли сообщения)
    const messages = extractMessagesFromChat();
    const hasUserMessages = messages.some(msg => msg.role === 'user' && msg.text && msg.text.trim().length > 0);
    
    sendResponse({
      success: true,
      ready: hasUserMessages && messages.length > 0,
      messageCount: messages.length,
      userMessageCount: messages.filter(msg => msg.role === 'user').length
    });
    return true;
  }
  
  if (request.action === 'checkContentReadyAndGet') {
    // Объединенная проверка готовности и получение контента
    // Это позволяет избежать двойных запросов
    let chatId = request.chatId || null;
    
    // Извлекаем chatId если не передан
    if (!chatId) {
      const url = window.location.href;
      let urlMatch = url.match(/\/chats\/([^\/\?]+)/);
      if (urlMatch) {
        chatId = urlMatch[1];
      } else {
        const urlParams = new URLSearchParams(window.location.search);
        chatId = urlParams.get('chatId') || urlParams.get('id') || urlParams.get('conversationId');
      }
    }
    
    const messages = extractMessagesFromChat();
    const hasUserMessages = messages.some(msg => msg.role === 'user' && msg.text && msg.text.trim().length > 0);
    const isReady = hasUserMessages && messages.length > 0;
    
    // Если готов, возвращаем контент сразу
    if (isReady && chatId) {
      sendResponse({
        success: true,
        ready: true,
        chatId,
        messages: messages.map((msg, index) => ({
          id: `${chatId}_${index}_${Date.now()}`,
          chatId,
          role: msg.role,
          text: msg.text,
          timestampUTC: msg.timestampUTC
        })),
        messageCount: messages.length,
        userMessageCount: messages.filter(msg => msg.role === 'user').length
      });
    } else {
      // Если не готов, возвращаем только статус
      sendResponse({
        success: true,
        ready: false,
        messageCount: messages.length,
        userMessageCount: messages.filter(msg => msg.role === 'user').length,
        chatId: chatId || null
      });
    }
    return true;
  }
  
  if (request.action === 'getChatContent') {
    // Извлекаем ID чата из параметров запроса (приоритет) или из URL
    let chatId = request.chatId || null;
    const chatIdFromRequest = chatId; // Сохраняем, был ли chatId передан в запросе
    
    if (!chatId) {
      // Пробуем разные форматы URL
      const url = window.location.href;
      
      // Формат 1: /chats/{chatId}
      let urlMatch = url.match(/\/chats\/([^\/\?]+)/);
      if (urlMatch) {
        chatId = urlMatch[1];
      }
      
      // Формат 2: ?chatId=... или ?id=...
      if (!chatId) {
        const urlParams = new URLSearchParams(window.location.search);
        chatId = urlParams.get('chatId') || urlParams.get('id') || urlParams.get('conversationId');
      }
      
      // Формат 3: Из hash (#chatId=...)
      if (!chatId) {
        const hashParams = new URLSearchParams(window.location.hash.substring(1));
        chatId = hashParams.get('chatId') || hashParams.get('id');
      }
      
      // Формат 4: Пробуем извлечь из пути, если формат другой
      if (!chatId) {
        const pathMatch = url.match(/\/conversation[s]?\/([^\/\?]+)/i);
        if (pathMatch) {
          chatId = pathMatch[1];
        }
      }
      
      // Формат 5: Пробуем найти в DOM (если чат открыт)
      if (!chatId) {
        // Ищем в data-атрибутах
        const chatElement = document.querySelector('[data-chat-id], [data-conversation-id], [data-chatid]');
        if (chatElement) {
          chatId = chatElement.getAttribute('data-chat-id') || 
                   chatElement.getAttribute('data-conversation-id') || 
                   chatElement.getAttribute('data-chatid');
        }
      }
      
      // Формат 6: Пробуем извлечь из window.location.pathname
      if (!chatId) {
        const pathParts = window.location.pathname.split('/').filter(p => p);
        const chatsIndex = pathParts.indexOf('chats');
        if (chatsIndex >= 0 && chatsIndex < pathParts.length - 1) {
          chatId = pathParts[chatsIndex + 1];
        }
      }
    }
    
    // Если chatId был передан в запросе, используем его даже если не найден в URL
    if (!chatId && chatIdFromRequest) {
      chatId = chatIdFromRequest;
      console.log('getChatContent: Using chatId from request:', chatId);
    }
    
    // Если все еще не нашли, логируем для отладки
    if (!chatId) {
      console.warn('getChatContent: Chat ID not found. URL:', window.location.href);
      console.warn('getChatContent: Pathname:', window.location.pathname);
      console.warn('getChatContent: Search:', window.location.search);
      console.warn('getChatContent: Hash:', window.location.hash);
      console.warn('getChatContent: Request chatId:', request.chatId);
      
      sendResponse({
        success: false,
        error: 'Chat ID not found in URL',
        debug: {
          url: window.location.href,
          pathname: window.location.pathname,
          search: window.location.search,
          hash: window.location.hash,
          requestChatId: request.chatId
        }
      });
      return true;
    }
    
    console.log('getChatContent: Using chatId:', chatId, 'fromRequest:', !!chatIdFromRequest);
    
    // Извлекаем сообщения
    const messages = extractMessagesFromChat();
    
    sendResponse({
      success: true,
      chatId,
      messages: messages.map((msg, index) => ({
        id: `${chatId}_${index}_${Date.now()}`,
        chatId,
        role: msg.role,
        text: msg.text,
        timestampUTC: msg.timestampUTC
      }))
    });
    return true;
  }
  
  if (request.action === 'clickAccountButton') {
    // Пытаемся найти и кликнуть на кнопку аккаунта, чтобы открыть попап
    const accountButtons = [
      'button[aria-label*="account" i]',
      'button[aria-label*="user" i]',
      'button[aria-label*="profile" i]',
      '[data-testid*="account"]',
      '[data-testid*="user"]',
      '[data-testid*="profile"]',
      'button[class*="account"]',
      'button[class*="user"]'
    ];
    
    for (const selector of accountButtons) {
      try {
        const button = document.querySelector(selector);
        if (button) {
          button.click();
          // Ждем немного и затем ищем email
          setTimeout(() => {
            const result = findEmailInDOM();
            sendResponse({
              success: !!result.email,
              email: result.email || null,
              name: result.name || null,
              clicked: true,
              source: 'content_script'
            });
          }, 1000);
          return true;
        }
      } catch (e) {
        // Продолжаем поиск
      }
    }
    
    sendResponse({
      success: false,
      email: null,
      name: null,
      clicked: false,
      error: 'Account button not found'
    });
    return true;
  }
  
  if (request.action === 'getChatContentWithHtml') {
    // Extract chat ID
    let chatId = request.chatId || null;
    
    if (!chatId) {
      const url = window.location.href;
      let urlMatch = url.match(/\/chats\/([^\/\?]+)/);
      if (urlMatch) {
        chatId = urlMatch[1];
      } else {
        const urlParams = new URLSearchParams(window.location.search);
        chatId = urlParams.get('chatId') || urlParams.get('id') || urlParams.get('conversationId');
      }
    }
    
    if (!chatId) {
      sendResponse({
        success: false,
        error: 'Chat ID not found in URL'
      });
      return true;
    }
    
    // Extract messages with HTML
    const messages = extractChatMessagesWithHtml();
    
    sendResponse({
      success: true,
      chatId,
      messages: messages.map((msg, index) => ({
        id: `${chatId}_${index}_${Date.now()}`,
        chatId,
        role: msg.role,
        text: msg.text,
        html: msg.html || null,
        timestampUTC: msg.timestampUTC,
        domOrder: msg.domOrder !== undefined ? msg.domOrder : index // Сохраняем порядок DOM
      }))
    });
    return true;
  }
});

// Автоматически пытаемся найти email при загрузке страницы
// (можно отключить, если не нужна автоматическая проверка)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      const result = findEmailInDOM();
      if (result.email) {
        // Сохраняем в chrome.storage для быстрого доступа
        chrome.storage.local.set({ copilotAccountEmail: result.email });
      }
    }, 2000);
  });
} else {
  setTimeout(() => {
    const result = findEmailInDOM();
    if (result.email) {
      chrome.storage.local.set({ copilotAccountEmail: result.email });
    }
  }, 2000);
}

