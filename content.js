// Content script для извлечения информации об аккаунте из попапа Copilot

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

