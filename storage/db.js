// IndexedDB module for Copilot Chat Indexer
const DB_NAME = 'copilot_indexer';
const DB_VERSION = 1;

let dbInstance = null;

/**
 * Initialize IndexedDB database
 * @returns {Promise<IDBDatabase>}
 */
function initDB() {
  return new Promise((resolve, reject) => {
    if (dbInstance) {
      resolve(dbInstance);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error('Failed to open IndexedDB: ' + request.error));
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Create accounts store
      if (!db.objectStoreNames.contains('accounts')) {
        const accountsStore = db.createObjectStore('accounts', { keyPath: 'email' });
        accountsStore.createIndex('createdAtUTC', 'createdAtUTC', { unique: false });
      }

      // Create chats store
      if (!db.objectStoreNames.contains('chats')) {
        const chatsStore = db.createObjectStore('chats', { keyPath: 'chatId' });
        chatsStore.createIndex('accountEmail', 'accountEmail', { unique: false });
        chatsStore.createIndex('updatedAtUTC', 'updatedAtUTC', { unique: false });
        chatsStore.createIndex('lastIndexedUTC', 'lastIndexedUTC', { unique: false });
      }

      // Create messages store
      if (!db.objectStoreNames.contains('messages')) {
        const messagesStore = db.createObjectStore('messages', { keyPath: 'id' });
        messagesStore.createIndex('chatId', 'chatId', { unique: false });
        messagesStore.createIndex('timestampUTC', 'timestampUTC', { unique: false });
      }

      // Create indexes store (for FlexSearch serialized indexes)
      if (!db.objectStoreNames.contains('indexes')) {
        db.createObjectStore('indexes', { keyPath: 'accountEmail' });
      }
    };
  });
}

/**
 * Get database instance
 * @returns {Promise<IDBDatabase>}
 */
async function getDB() {
  if (!dbInstance) {
    await initDB();
  }
  return dbInstance;
}

/**
 * Convert date to UTC ISO string
 * @param {Date|string|number} date
 * @returns {string}
 */
function toUTCString(date) {
  if (!date) {
    return new Date().toISOString();
  }
  if (typeof date === 'string') {
    return new Date(date).toISOString();
  }
  if (typeof date === 'number') {
    return new Date(date).toISOString();
  }
  return date.toISOString();
}

// ========== Accounts CRUD ==========

/**
 * Create or update account
 * @param {Object} account
 * @param {string} account.email
 * @param {string} [account.lastIndexedUTC]
 * @param {string} [account.createdAtUTC]
 * @returns {Promise<void>}
 */
async function upsertAccount(account) {
  const db = await getDB();
  const transaction = db.transaction(['accounts'], 'readwrite');
  const store = transaction.objectStore('accounts');

  const accountData = {
    email: account.email,
    lastIndexedUTC: account.lastIndexedUTC || null,
    createdAtUTC: account.createdAtUTC || toUTCString(new Date())
  };

  // If updating, preserve createdAtUTC
  if (account.createdAtUTC) {
    accountData.createdAtUTC = account.createdAtUTC;
  }

  return new Promise((resolve, reject) => {
    const request = store.put(accountData);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
  });
}

/**
 * Get account by email
 * @param {string} email
 * @returns {Promise<Object|null>}
 */
async function getAccount(email) {
  const db = await getDB();
  const transaction = db.transaction(['accounts'], 'readonly');
  const store = transaction.objectStore('accounts');

  return new Promise((resolve, reject) => {
    const request = store.get(email);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all accounts
 * @returns {Promise<Array>}
 */
async function getAllAccounts() {
  const db = await getDB();
  const transaction = db.transaction(['accounts'], 'readonly');
  const store = transaction.objectStore('accounts');

  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

// ========== Chats CRUD ==========

/**
 * Create or update chat
 * @param {Object} chat
 * @param {string} chat.chatId
 * @param {string} chat.accountEmail
 * @param {string} chat.title
 * @param {string} chat.url
 * @param {string} [chat.updatedAtUTC]
 * @param {string} [chat.lastIndexedUTC]
 * @returns {Promise<void>}
 */
async function upsertChat(chat) {
  const db = await getDB();
  const transaction = db.transaction(['chats'], 'readwrite');
  const store = transaction.objectStore('chats');

  const chatData = {
    chatId: chat.chatId,
    accountEmail: chat.accountEmail,
    title: chat.title || '',
    url: chat.url || `https://copilot.microsoft.com/chats/${chat.chatId}`,
    updatedAtUTC: chat.updatedAtUTC || toUTCString(new Date()),
    lastIndexedUTC: chat.lastIndexedUTC || null
  };

  return new Promise((resolve, reject) => {
    const request = store.put(chatData);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get chat by ID
 * @param {string} chatId
 * @returns {Promise<Object|null>}
 */
async function getChat(chatId) {
  const db = await getDB();
  const transaction = db.transaction(['chats'], 'readonly');
  const store = transaction.objectStore('chats');

  return new Promise((resolve, reject) => {
    const request = store.get(chatId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all chats for account
 * @param {string} accountEmail
 * @returns {Promise<Array>}
 */
async function getChatsByAccount(accountEmail) {
  const db = await getDB();
  const transaction = db.transaction(['chats'], 'readonly');
  const store = transaction.objectStore('chats');
  const index = store.index('accountEmail');

  return new Promise((resolve, reject) => {
    const request = index.getAll(accountEmail);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get chats that need indexing (updated after lastIndexedUTC)
 * @param {string} accountEmail
 * @param {string} lastIndexedUTC
 * @returns {Promise<Array>}
 */
async function getChatsToIndex(accountEmail, lastIndexedUTC) {
  const db = await getDB();
  const transaction = db.transaction(['chats'], 'readonly');
  const store = transaction.objectStore('chats');
  const index = store.index('accountEmail');

  return new Promise((resolve, reject) => {
    const request = index.getAll(accountEmail);
    request.onsuccess = () => {
      const allChats = request.result || [];
      if (!lastIndexedUTC) {
        resolve(allChats);
        return;
      }
      // Filter chats that were updated after lastIndexedUTC
      const chatsToIndex = allChats.filter(chat => {
        if (!chat.lastIndexedUTC) return true;
        return new Date(chat.updatedAtUTC) > new Date(chat.lastIndexedUTC);
      });
      resolve(chatsToIndex);
    };
    request.onerror = () => reject(request.error);
  });
}

// ========== Messages CRUD ==========

/**
 * Create or update message
 * @param {Object} message
 * @param {string} message.id
 * @param {string} message.chatId
 * @param {string} message.role - "user" | "assistant"
 * @param {string} message.text
 * @param {string} [message.timestampUTC]
 * @returns {Promise<void>}
 */
async function upsertMessage(message) {
  const db = await getDB();
  const transaction = db.transaction(['messages'], 'readwrite');
  const store = transaction.objectStore('messages');

  const messageData = {
    id: message.id,
    chatId: message.chatId,
    role: message.role,
    text: message.text || '',
    timestampUTC: message.timestampUTC || toUTCString(new Date())
  };

  return new Promise((resolve, reject) => {
    const request = store.put(messageData);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get messages by chat ID
 * @param {string} chatId
 * @returns {Promise<Array>}
 */
async function getMessagesByChat(chatId) {
  const db = await getDB();
  const transaction = db.transaction(['messages'], 'readonly');
  const store = transaction.objectStore('messages');
  const index = store.index('chatId');

  return new Promise((resolve, reject) => {
    const request = index.getAll(chatId);
    request.onsuccess = () => {
      const messages = request.result || [];
      // Sort by timestamp
      messages.sort((a, b) => new Date(a.timestampUTC) - new Date(b.timestampUTC));
      resolve(messages);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Delete messages by chat ID
 * @param {string} chatId
 * @returns {Promise<void>}
 */
async function deleteMessagesByChat(chatId) {
  const db = await getDB();
  const transaction = db.transaction(['messages'], 'readwrite');
  const store = transaction.objectStore('messages');
  const index = store.index('chatId');

  return new Promise((resolve, reject) => {
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

// ========== Indexes CRUD ==========

/**
 * Save FlexSearch index
 * @param {string} accountEmail
 * @param {Object} indexData - Serialized FlexSearch index
 * @returns {Promise<void>}
 */
async function saveIndex(accountEmail, indexData) {
  const db = await getDB();
  const transaction = db.transaction(['indexes'], 'readwrite');
  const store = transaction.objectStore('indexes');

  return new Promise((resolve, reject) => {
    const request = store.put({
      accountEmail: accountEmail,
      flexIndexJSON: indexData
    });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get FlexSearch index
 * @param {string} accountEmail
 * @returns {Promise<Object|null>}
 */
async function getIndex(accountEmail) {
  const db = await getDB();
  const transaction = db.transaction(['indexes'], 'readonly');
  const store = transaction.objectStore('indexes');

  return new Promise((resolve, reject) => {
    const request = store.get(accountEmail);
    request.onsuccess = () => {
      const result = request.result;
      resolve(result ? result.flexIndexJSON : null);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Delete index
 * @param {string} accountEmail
 * @returns {Promise<void>}
 */
async function deleteIndex(accountEmail) {
  const db = await getDB();
  const transaction = db.transaction(['indexes'], 'readwrite');
  const store = transaction.objectStore('indexes');

  return new Promise((resolve, reject) => {
    const request = store.delete(accountEmail);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ========== Reset operations ==========

/**
 * Reset all data for account
 * @param {string} accountEmail
 * @returns {Promise<void>}
 */
async function resetAccountData(accountEmail) {
  const db = await getDB();

  // Delete chats
  const chatsTransaction = db.transaction(['chats'], 'readwrite');
  const chatsStore = chatsTransaction.objectStore('chats');
  const chatsIndex = chatsStore.index('accountEmail');
  
  await new Promise((resolve, reject) => {
    const request = chatsIndex.openCursor(IDBKeyRange.only(accountEmail));
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

  // Delete messages (via chats)
  const chats = await getChatsByAccount(accountEmail);
  for (const chat of chats) {
    await deleteMessagesByChat(chat.chatId);
  }

  // Delete index
  await deleteIndex(accountEmail);

  // Delete account
  const accountsTransaction = db.transaction(['accounts'], 'readwrite');
  const accountsStore = accountsTransaction.objectStore('accounts');
  await new Promise((resolve, reject) => {
    const request = accountsStore.delete(accountEmail);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Check if database has any data
 * @returns {Promise<boolean>}
 */
async function hasData() {
  const db = await getDB();
  const transaction = db.transaction(['chats'], 'readonly');
  const store = transaction.objectStore('chats');

  return new Promise((resolve, reject) => {
    const request = store.count();
    request.onsuccess = () => resolve(request.result > 0);
    request.onerror = () => reject(request.error);
  });
}

// Export for use in service worker
if (typeof self !== 'undefined') {
  self.DB = {
    initDB,
    getDB,
    toUTCString,
    upsertAccount,
    getAccount,
    getAllAccounts,
    upsertChat,
    getChat,
    getChatsByAccount,
    getChatsToIndex,
    upsertMessage,
    getMessagesByChat,
    deleteMessagesByChat,
    saveIndex,
    getIndex,
    deleteIndex,
    resetAccountData,
    hasData
  };
}

// Export for ES modules
export {
  initDB,
  getDB,
  toUTCString,
  upsertAccount,
  getAccount,
  getAllAccounts,
  upsertChat,
  getChat,
  getChatsByAccount,
  getChatsToIndex,
  upsertMessage,
  getMessagesByChat,
  deleteMessagesByChat,
  saveIndex,
  getIndex,
  deleteIndex,
  resetAccountData,
  hasData
};
