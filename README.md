# Copilot Addon

Chrome extension for monitoring and viewing network requests from Microsoft Copilot API.

## Features

- Real-time monitoring of network requests
- Filtered view of Copilot API conversations endpoint
- Detailed request/response inspection
- Request headers, body, and response data viewing

## Installation

1. Clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked" and select the extension directory
5. The extension icon will appear in your toolbar

## Usage

1. Open Microsoft Copilot in your browser
2. Click the extension icon to view captured requests
3. Select any request to see detailed information including headers and body

## Files

- `manifest.json` - Extension manifest
- `background.js` - Service worker for request monitoring
- `popup.html` - Extension popup UI
- `popup.js` - Popup functionality
- `popup.css` - Popup styling

## Permissions

This extension requires the following permissions:
- `tabs` - To access tab information
- `webRequest` - To monitor network requests
- `storage` - To store request data
- `debugger` - To capture response bodies
- `windows` - To access window information

