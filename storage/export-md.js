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

// Export for use in service worker
if (typeof self !== 'undefined') {
  self.ExportMD = {
    convertHtmlToMarkdown,
    formatMessageForMarkdown,
    exportChatToMarkdown,
    exportChatsToMarkdown
  };
}

// Export for ES modules
export {
  convertHtmlToMarkdown,
  formatMessageForMarkdown,
  exportChatToMarkdown,
  exportChatsToMarkdown
};
