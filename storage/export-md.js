// Export to Markdown module for Copilot Chat Indexer

/**
 * Convert HTML to Markdown format
 * Preserves basic formatting: headers, lists, code blocks, links, bold, italic
 * @param {string} html - HTML string to convert
 * @returns {string} Markdown formatted text
 */
function convertHtmlToMarkdown(html) {
  if (!html || typeof html !== 'string') {
    return '';
  }

  // Create a temporary DOM element
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const body = doc.body;

  if (!body) {
    return '';
  }

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
    'footer'
  ];
  
  selectorsToRemove.forEach(sel => {
    try {
      body.querySelectorAll(sel).forEach(el => el.remove());
    } catch (e) {
      // Ignore selector errors
    }
  });

  /**
   * Convert a DOM node to Markdown
   * @param {Node} node - DOM node to convert
   * @returns {string} Markdown string
   */
  function nodeToMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || '';
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const tagName = node.tagName?.toLowerCase();
    const children = Array.from(node.childNodes);
    const childText = children.map(child => nodeToMarkdown(child)).join('').trim();

    // Skip empty elements
    if (!childText && !['img', 'br', 'hr'].includes(tagName)) {
      return '';
    }

    switch (tagName) {
      case 'h1':
        return `# ${childText}\n\n`;
      case 'h2':
        return `## ${childText}\n\n`;
      case 'h3':
        return `### ${childText}\n\n`;
      case 'h4':
        return `#### ${childText}\n\n`;
      case 'h5':
        return `##### ${childText}\n\n`;
      case 'h6':
        return `###### ${childText}\n\n`;
      case 'p':
        return `${childText}\n\n`;
      case 'br':
        return '\n';
      case 'hr':
        return '---\n\n';
      case 'strong':
      case 'b':
        return `**${childText}**`;
      case 'em':
      case 'i':
        return `*${childText}*`;
      case 'code':
        // Inline code
        if (node.parentElement?.tagName?.toLowerCase() === 'pre') {
          return childText;
        }
        return `\`${childText}\``;
      case 'pre':
        const codeContent = node.querySelector('code')?.textContent || childText;
        const language = node.querySelector('code')?.className?.match(/language-(\w+)/)?.[1] || '';
        return `\`\`\`${language}\n${codeContent}\n\`\`\`\n\n`;
      case 'ul':
      case 'ol':
        return `${childText}\n`;
      case 'li':
        const parent = node.parentElement;
        const isOrdered = parent?.tagName?.toLowerCase() === 'ol';
        const index = Array.from(parent?.children || []).indexOf(node) + 1;
        const prefix = isOrdered ? `${index}. ` : '- ';
        // Indent nested lists
        const indent = node.closest('ul, ol') !== parent ? '  ' : '';
        return `${indent}${prefix}${childText}\n`;
      case 'a':
        const href = node.getAttribute('href') || '';
        const linkText = childText || href;
        return href ? `[${linkText}](${href})` : linkText;
      case 'blockquote':
        return childText.split('\n').map(line => line.trim() ? `> ${line}` : '').join('\n') + '\n\n';
      case 'table':
        return `${childText}\n\n`;
      case 'tr':
        return `${childText}\n`;
      case 'th':
      case 'td':
        const cellText = childText.replace(/\|/g, '\\|');
        return ` ${cellText} |`;
      case 'div':
        // Check if it's a Copilot separator (divider)
        const classList = node.classList?.toString() || '';
        if (classList.includes('relative') && classList.includes('pb-6') && 
            classList.includes('w-full') && (classList.includes('after:border-b') || 
            node.getAttribute('class')?.includes('after:border-b'))) {
          return '---\n\n';
        }
        // Check if it's a code block wrapper
        if (node.classList?.contains('code') || node.querySelector('pre, code')) {
          return childText;
        }
        return childText;
      default:
        return childText;
    }
  }

  // Convert the entire body
  let markdown = nodeToMarkdown(body).trim();

  // Clean up multiple blank lines
  markdown = markdown.replace(/\n{3,}/g, '\n\n');

  // Clean up trailing whitespace
  markdown = markdown.split('\n').map(line => line.trimEnd()).join('\n');

  return markdown;
}

/**
 * Format a chat message for Markdown export
 * @param {Object} message - Message object with role, text, timestampUTC
 * @param {string} [htmlContent] - Optional HTML content for better formatting
 * @returns {string} Formatted markdown string
 */
function formatMessageForMarkdown(message, htmlContent = null) {
  const role = message.role || 'user';
  const text = message.text || '';
  const timestamp = message.timestampUTC ? new Date(message.timestampUTC).toLocaleString('ru-RU') : '';

  // Use HTML if provided, otherwise use plain text
  let content = text;
  if (htmlContent) {
    content = convertHtmlToMarkdown(htmlContent);
  }

  // Format based on role
  if (role === 'user') {
    return `## 👤 Пользователь${timestamp ? ` (${timestamp})` : ''}\n\n${content}\n\n`;
  } else if (role === 'assistant') {
    return `## 🤖 Copilot${timestamp ? ` (${timestamp})` : ''}\n\n${content}\n\n`;
  } else {
    return `## ${role}${timestamp ? ` (${timestamp})` : ''}\n\n${content}\n\n`;
  }
}

/**
 * Export a single chat to Markdown
 * @param {string} chatId - Chat ID
 * @param {string} accountEmail - Account email
 * @param {Function} getMessagesHtml - Function to get HTML content of messages (optional)
 * @returns {Promise<string>} Markdown content
 */
async function exportChatToMarkdown(chatId, accountEmail, getMessagesHtml = null) {
  // Import DB functions dynamically
  const { getChat, getMessagesByChat } = await import('./db.js');

  // Get chat info
  const chat = await getChat(chatId);
  if (!chat) {
    throw new Error(`Chat ${chatId} not found`);
  }

  // Get messages
  const messages = await getMessagesByChat(chatId);
  if (!messages || messages.length === 0) {
    throw new Error(`No messages found for chat ${chatId}`);
  }

  // Build markdown content
  let markdown = `# ${chat.title || 'Безымянный чат'}\n\n`;
  
  if (chat.url) {
    markdown += `**Ссылка:** [${chat.url}](${chat.url})\n\n`;
  }
  
  if (chat.updatedAtUTC) {
    const date = new Date(chat.updatedAtUTC).toLocaleString('ru-RU');
    markdown += `**Дата обновления:** ${date}\n\n`;
  }
  
  markdown += '---\n\n';

  // Export messages
  for (const message of messages) {
    let htmlContent = null;
    
    // Try to get HTML content if function provided
    if (getMessagesHtml && typeof getMessagesHtml === 'function') {
      try {
        htmlContent = await getMessagesHtml(chatId, message.id);
      } catch (e) {
        console.warn(`Failed to get HTML for message ${message.id}:`, e);
      }
    }
    
    markdown += formatMessageForMarkdown(message, htmlContent);
  }

  return markdown;
}

/**
 * Export multiple chats to Markdown files
 * @param {Array<string>} chatIds - Array of chat IDs
 * @param {string} accountEmail - Account email
 * @param {Function} getMessagesHtml - Function to get HTML content (optional)
 * @returns {Promise<Array<{chatId: string, filename: string, content: string}>>} Array of exported chats
 */
async function exportChatsToMarkdown(chatIds, accountEmail, getMessagesHtml = null) {
  const results = [];
  const { getChat } = await import('./db.js');

  for (const chatId of chatIds) {
    try {
      const chat = await getChat(chatId);
      if (!chat) {
        console.warn(`Chat ${chatId} not found, skipping`);
        continue;
      }

      const markdown = await exportChatToMarkdown(chatId, accountEmail, getMessagesHtml);
      
      // Create filename from chat title
      const title = chat.title || 'Безымянный чат';
      const sanitizedTitle = title
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, '_')
        .substring(0, 100);
      const filename = `${sanitizedTitle}_${chatId.substring(0, 8)}.md`;

      results.push({
        chatId,
        filename,
        content: markdown,
        title: chat.title
      });
    } catch (error) {
      console.error(`Error exporting chat ${chatId}:`, error);
      results.push({
        chatId,
        filename: null,
        content: null,
        error: error.message
      });
    }
  }

  return results;
}

/**
 * Convert full Copilot HTML file to Markdown for Obsidian
 * Extracts messages with proper dialog separation, formatting, and pseudocode
 * @param {string} htmlContent - Full HTML content from Copilot page
 * @returns {string} Markdown formatted text for Obsidian
 */
function convertCopilotHtmlFileToMarkdown(htmlContent) {
  if (!htmlContent || typeof htmlContent !== 'string') {
    return '';
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlContent, 'text/html');
  const body = doc.body;

  if (!body) {
    return '';
  }

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
    '[data-testid="message-item-reactions"]',
    '[aria-hidden="true"]',
    '.hidden',
    '[style*="display: none"]',
    'script',
    'style'
  ];
  
  selectorsToRemove.forEach(sel => {
    try {
      body.querySelectorAll(sel).forEach(el => el.remove());
    } catch (e) {
      // Ignore selector errors
    }
  });

  // Extract messages in order
  const messages = [];
  const messageElements = body.querySelectorAll('[role="article"]');

  for (const msgEl of messageElements) {
    // Determine message type
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

    // Get content element
    let contentElement = msgEl;
    if (isAssistant) {
      const contentContainer = msgEl.querySelector('[data-content="ai-message"]') || 
                              msgEl.querySelector('[class*="message-content"]') ||
                              msgEl.querySelector('[class*="response-content"]') ||
                              msgEl.querySelector('[class*="ai-message-item"]') ||
                              msgEl;
      contentElement = contentContainer;
    }

    // Extract HTML content
    const html = contentElement.innerHTML || '';
    const text = contentElement.textContent?.trim() || '';
    
    if (text.length > 0) {
      // Try to get timestamp
      const timeEl = msgEl.querySelector('time') || 
                    msgEl.querySelector('[data-testid*="date"]') ||
                    msgEl.closest('[role="article"]')?.querySelector('time');
      const timestamp = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent) : null;
      
      messages.push({
        role: isUser ? 'user' : 'assistant',
        html: html,
        text: text,
        timestamp: timestamp,
        domOrder: Array.from(messageElements).indexOf(msgEl)
      });
    }
  }

  // If no messages found via role="article", try alternative selectors
  if (messages.length === 0) {
    const userMessages = body.querySelectorAll('[data-content="user-message"]');
    const aiMessages = body.querySelectorAll('[data-content="ai-message"]');
    
    const allElements = [];
    userMessages.forEach(el => allElements.push({ el, role: 'user' }));
    aiMessages.forEach(el => allElements.push({ el, role: 'assistant' }));
    
    // Sort by DOM position
    allElements.sort((a, b) => {
      const posA = Array.from(body.querySelectorAll('*')).indexOf(a.el);
      const posB = Array.from(body.querySelectorAll('*')).indexOf(b.el);
      return posA - posB;
    });

    allElements.forEach(({ el, role }) => {
      const html = el.innerHTML || '';
      const text = el.textContent?.trim() || '';
      if (text.length > 0) {
        messages.push({
          role: role,
          html: html,
          text: text,
          timestamp: null,
          domOrder: Array.from(body.querySelectorAll('*')).indexOf(el)
        });
      }
    });
  }

  // Sort messages by DOM order
  messages.sort((a, b) => a.domOrder - b.domOrder);

  // Build markdown
  let markdown = '# Диалог Copilot\n\n';
  markdown += `**Дата конвертации:** ${new Date().toLocaleString('ru-RU')}\n\n`;
  markdown += '---\n\n';

  // Convert each message
  for (const message of messages) {
    const role = message.role;
    const content = convertHtmlToMarkdown(message.html || message.text);
    
    if (role === 'user') {
      markdown += `## 👤 Пользователь${message.timestamp ? ` (${message.timestamp})` : ''}\n\n${content}\n\n`;
    } else if (role === 'assistant') {
      markdown += `## 🤖 Copilot${message.timestamp ? ` (${message.timestamp})` : ''}\n\n${content}\n\n`;
    }
  }

  // Clean up multiple blank lines
  markdown = markdown.replace(/\n{3,}/g, '\n\n');
  
  // Clean up trailing whitespace
  markdown = markdown.split('\n').map(line => line.trimEnd()).join('\n');

  return markdown.trim();
}

// Export for use in service worker
if (typeof self !== 'undefined') {
  self.ExportMD = {
    convertHtmlToMarkdown,
    formatMessageForMarkdown,
    exportChatToMarkdown,
    exportChatsToMarkdown,
    convertCopilotHtmlFileToMarkdown
  };
}

// Export for ES modules
// Note: When loaded via importScripts() in service worker, these exports are ignored
// and self.ExportMD is used instead
export {
  convertHtmlToMarkdown,
  formatMessageForMarkdown,
  exportChatToMarkdown,
  exportChatsToMarkdown,
  convertCopilotHtmlFileToMarkdown
};
