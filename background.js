/*
 * Pearl Dupe Checker — background service worker
 *
 * Provides a CSRF cookie fallback for the content script: when the
 * hubspotapi-csrf cookie is HttpOnly (or rotated after idle), the content
 * script can't read it from document.cookie, so it asks here instead.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "getCsrf") {
    chrome.cookies.get(
      { url: "https://app.hubspot.com", name: "hubspotapi-csrf" },
      (cookie) => sendResponse({ csrf: cookie ? cookie.value : "" })
    );
    return true; // async response
  }
});
