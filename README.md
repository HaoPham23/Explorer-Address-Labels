# Ronin Explorer Address Labels (Popup)

A minimal Chrome extension to add labels to addresses you visit on the Ronin explorer (`app.roninchain.com`). It provides a popup UI and stores labels locally in your browser profile—no Google Sheets, CSV import, or inline content script.

## Features
- Popup-only label editor for the current page’s address  
- Recognizes both `0x…` and `ronin:…` formats (normalized to lowercase `0x…`)  
- Local-only storage via `chrome.storage.local` (per profile, not cloud-synced)

## Install / Load Unpacked
1. Open Chrome → `chrome://extensions`  
2. Enable “Developer mode”  
3. Click “Load unpacked” and select this folder  
4. Browse to an address page on Ronin explorer (e.g. `https://app.roninchain.com/address/0x5Fa076fADFcEdA601D092CACc30D2cEd936f3036`)  
5. Click the extension icon to open the popup

## Usage
1. On an address page, open the popup.  
2. Enter a label and press **Save**.  
3. Re-open the popup on the same address to view or update the label.  
4. Press **Delete** to remove the stored label.

## Data Model & Storage
- Stored under key `labels` in `chrome.storage.local`  
- Shape: `{ "<normalizedAddress>": { "label": string, "updatedAt": number } }`  
- Normalization: `ronin:xxxxxxxx…` → `0xxxxxxxxx…` (lower-cased)  
- Data lives only in the current browser profile; removing the extension deletes it.

## File Structure
- `manifest.json` – MV3 manifest (popup only, Ronin host permission)  
- `popup.html` – Popup UI  
- `popup.js` – Detects address from URL, save/delete logic

## Permissions
- `storage`, `activeTab`, `tabs`  
- Host permissions: `*://app.roninchain.com/*`

## Customization
- Support more explorers: add domains to `host_permissions` and update `extractAddressFromUrl` in `popup.js`.  
- Adjust address detection logic or UI as needed.

## Future Enhancements
- Inline badges via content script  
- Import/export (CSV, Google Sheets)  
- Sync labels across devices

## Notes
This MVP avoids external services entirely—everything is processed and saved locally for maximum simplicity and privacy.
