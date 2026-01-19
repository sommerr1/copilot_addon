// FlexSearch indexer module for Copilot Chat Indexer
// In-memory cache of indexes
const indexCache = new Map();
let FlexSearchLib = null;

/**
 * Load FlexSearch library
 * @returns {Promise<Object>}
 */
async function loadFlexSearchLib() {
  if (FlexSearchLib) {
    return FlexSearchLib;
  }
  
  // Try to use global FlexSearch if already loaded
  if (typeof FlexSearch !== 'undefined') {
    FlexSearchLib = FlexSearch;
    return FlexSearchLib;
  }
  
  // Try to load from CDN using importScripts (for service worker)
  try {
    // Use dynamic import for ES modules or fetch + eval for service worker
    if (typeof importScripts !== 'undefined') {
      // Service worker context - use fetch and eval
      const response = await fetch('https://cdn.jsdelivr.net/npm/flexsearch@0.7.43/dist/flexsearch.min.js');
      const script = await response.text();
      // Create a function context to avoid polluting global scope
      const func = new Function('return ' + script);
      const result = func();
      FlexSearchLib = result || (typeof FlexSearch !== 'undefined' ? FlexSearch : null);
    } else {
      // Regular context - try dynamic import
      const module = await import('https://cdn.jsdelivr.net/npm/flexsearch@0.7.43/+esm');
      FlexSearchLib = module.default || module.FlexSearch;
    }
    
    if (!FlexSearchLib) {
      throw new Error('FlexSearch not found after loading');
    }
    
    return FlexSearchLib;
  } catch (error) {
    console.error('Failed to load FlexSearch:', error);
    // Fallback: try unpkg
    try {
      const response = await fetch('https://unpkg.com/flexsearch@0.7.43/dist/flexsearch.min.js');
      const script = await response.text();
      const func = new Function('return ' + script);
      const result = func();
      FlexSearchLib = result;
      return FlexSearchLib;
    } catch (e) {
      console.error('Failed to load FlexSearch from fallback:', e);
      throw new Error('FlexSearch library could not be loaded');
    }
  }
}

/**
 * Create new FlexSearch index for account
 * @param {string} accountEmail
 * @returns {Promise<Object>}
 */
async function createIndex(accountEmail) {
  const FlexSearch = await loadFlexSearchLib();
  
  const index = new FlexSearch.Index({
    preset: 'default',
    tokenize: 'forward',
    cache: 100,
    context: {
      resolution: 9,
      depth: 2,
      bidirectional: true
    },
    // Support Cyrillic and Latin
    encode: (str) => {
      return str.toLowerCase()
        .split(/\s+/)
        .filter(word => word.length > 0);
    }
  });

  indexCache.set(accountEmail, index);
  return index;
}

/**
 * Get index for account (from cache or create new)
 * @param {string} accountEmail
 * @returns {Promise<Object>}
 */
async function getIndex(accountEmail) {
  if (indexCache.has(accountEmail)) {
    return indexCache.get(accountEmail);
  }

  // Try to load from IndexedDB
  const { getIndex: getIndexFromDB } = await import('./db.js');
  const savedIndex = await getIndexFromDB(accountEmail);
  
  if (savedIndex) {
    // Deserialize index
    const FlexSearch = await loadFlexSearchLib();
    const index = new FlexSearch.Index({
      preset: 'default',
      tokenize: 'forward',
      cache: 100,
      context: {
        resolution: 9,
        depth: 2,
        bidirectional: true
      },
      encode: (str) => {
        return str.toLowerCase()
          .split(/\s+/)
          .filter(word => word.length > 0);
      }
    });
    
    // Import serialized data
    if (savedIndex.export) {
      index.import(savedIndex.export);
    }
    
    indexCache.set(accountEmail, index);
    return index;
  }

  // Create new index
  return await createIndex(accountEmail);
}

/**
 * Add documents to index
 * @param {string} accountEmail
 * @param {Array<Object>} documents - Array of {id, text, chatId, title}
 * @returns {Promise<void>}
 */
async function addToIndex(accountEmail, documents) {
  const index = await getIndex(accountEmail);
  
  for (const doc of documents) {
    const searchableText = `${doc.title || ''} ${doc.text || ''}`.trim();
    if (searchableText) {
      index.add(doc.id, searchableText);
    }
  }
}

/**
 * Update documents in index
 * @param {string} accountEmail
 * @param {Array<Object>} documents - Array of {id, text, chatId, title}
 * @returns {Promise<void>}
 */
async function updateIndex(accountEmail, documents) {
  const index = await getIndex(accountEmail);
  
  for (const doc of documents) {
    const searchableText = `${doc.title || ''} ${doc.text || ''}`.trim();
    if (searchableText) {
      index.update(doc.id, searchableText);
    } else {
      index.remove(doc.id);
    }
  }
}

/**
 * Remove documents from index
 * @param {string} accountEmail
 * @param {Array<string>} ids - Array of document IDs
 * @returns {Promise<void>}
 */
async function removeFromIndex(accountEmail, ids) {
  const index = await getIndex(accountEmail);
  
  for (const id of ids) {
    index.remove(id);
  }
}

/**
 * Search in index
 * @param {string} accountEmail
 * @param {string} query - Search query (min 2 characters)
 * @param {number} [limit=50] - Maximum number of results
 * @returns {Promise<Array<string>>} - Array of document IDs
 */
async function search(accountEmail, query, limit = 50) {
  if (!query || query.trim().length < 2) {
    return [];
  }

  const index = await getIndex(accountEmail);
  const results = index.search(query.trim(), limit);
  return results;
}

/**
 * Serialize index for storage
 * @param {string} accountEmail
 * @returns {Promise<Object>}
 */
async function serializeIndex(accountEmail) {
  const index = await getIndex(accountEmail);
  
  // FlexSearch export method
  if (index.export) {
    return {
      export: index.export(),
      version: '0.7.43'
    };
  }
  
  // Fallback: return empty object
  return { export: null, version: '0.7.43' };
}

/**
 * Deserialize index from storage
 * @param {string} accountEmail
 * @param {Object} data - Serialized index data
 * @returns {Promise<Object>}
 */
async function deserializeIndex(accountEmail, data) {
  const index = await createIndex(accountEmail);
  
  if (data && data.export && index.import) {
    index.import(data.export);
  }
  
  indexCache.set(accountEmail, index);
  return index;
}

/**
 * Clear index cache
 * @param {string} accountEmail
 */
function clearIndexCache(accountEmail) {
  if (accountEmail) {
    indexCache.delete(accountEmail);
  } else {
    indexCache.clear();
  }
}

// Export for service worker
if (typeof self !== 'undefined') {
  self.Indexer = {
    createIndex,
    getIndex,
    addToIndex,
    updateIndex,
    removeFromIndex,
    search,
    serializeIndex,
    deserializeIndex,
    clearIndexCache
  };
}

// Export for ES modules
export {
  createIndex,
  getIndex,
  addToIndex,
  updateIndex,
  removeFromIndex,
  search,
  serializeIndex,
  deserializeIndex,
  clearIndexCache
};
