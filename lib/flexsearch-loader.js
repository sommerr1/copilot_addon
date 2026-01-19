// FlexSearch loader - loads from CDN if not available
let FlexSearch = null;

async function loadFlexSearch() {
  if (FlexSearch) {
    return FlexSearch;
  }

  try {
    // Try to load from CDN
    const response = await fetch('https://cdn.jsdelivr.net/npm/flexsearch@0.7.43/dist/flexsearch.min.js');
    const script = await response.text();
    eval(script);
    FlexSearch = window.FlexSearch || globalThis.FlexSearch;
  } catch (error) {
    console.error('Failed to load FlexSearch from CDN:', error);
    // Fallback: try to use import if available
    try {
      const module = await import('https://cdn.jsdelivr.net/npm/flexsearch@0.7.43/+esm');
      FlexSearch = module.default || module.FlexSearch;
    } catch (e) {
      console.error('Failed to load FlexSearch:', e);
      throw new Error('FlexSearch library could not be loaded');
    }
  }

  return FlexSearch;
}

// For service worker context
if (typeof self !== 'undefined') {
  self.loadFlexSearch = loadFlexSearch;
}

// For window context
if (typeof window !== 'undefined') {
  window.loadFlexSearch = loadFlexSearch;
}

export { loadFlexSearch };

