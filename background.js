/*
 * Pearl Dupe Checker — background service worker
 *
 * 1. getCsrf — CSRF cookie fallback for the content script (HttpOnly / rotated).
 * 2. checkHours — fetches the practice's website and extracts business hours.
 *    Content scripts can't fetch cross-origin; the service worker can (with
 *    host permissions), so all external requests live here.
 */

// ── Hours parsing ────────────────────────────────────────────────────────────

const DAY_IDX = {
  su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

// "09:00", "9:00 AM", "17:00:00" → minutes since midnight (or null)
function toMin(t) {
  if (t == null) return null;
  const m = String(t).trim().match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = +m[1];
  const min = +(m[2] || 0);
  const ap = (m[3] || "").toLowerCase();
  if (ap === "pm" && h !== 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function addInterval(days, idx, o, c) {
  if (idx == null || o == null || c == null) return;
  if (o >= c || c - o < 60 || c - o > 16 * 60) return; // sanity: 1–16h shifts only
  (days[idx] = days[idx] || []).push({ o, c });
}

function expandDayRange(a, b) {
  const out = [];
  for (let i = a; ; i = (i + 1) % 7) {
    out.push(i);
    if (i === b || out.length > 7) break;
  }
  return out;
}

// schema.org openingHours string: "Mo-Fr 09:00-17:00" or "Mo,We 08:00-16:00"
function parseOhString(s, days) {
  const m = String(s).trim().match(/^([A-Za-z,\- ]+?)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (!m) return;
  const o = toMin(m[2]), c = toMin(m[3]);
  m[1].split(",").forEach((part) => {
    const r = part.trim().split(/\s*-\s*/);
    const a = DAY_IDX[r[0].slice(0, 2).toLowerCase()];
    if (a == null) return;
    if (r.length === 2) {
      const b = DAY_IDX[r[1].slice(0, 2).toLowerCase()];
      if (b != null) expandDayRange(a, b).forEach((i) => addInterval(days, i, o, c));
    } else {
      addInterval(days, a, o, c);
    }
  });
}

// schema.org JSON-LD — most site builders (incl. dental templates) embed this
function parseJsonLd(html) {
  const days = {};
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  const addSpec = (spec) => {
    if (!spec || typeof spec !== "object") return;
    const o = toMin(spec.opens), c = toMin(spec.closes);
    [].concat(spec.dayOfWeek || []).forEach((d) => {
      const name = String(typeof d === "object" ? d["@id"] || d.name || "" : d).split("/").pop().toLowerCase();
      addInterval(days, DAY_IDX[name], o, c);
    });
  };
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.openingHoursSpecification) [].concat(node.openingHoursSpecification).forEach(addSpec);
    if (node.openingHours) [].concat(node.openingHours).forEach((s) => parseOhString(s, days));
    for (const k in node) { if (node[k] && typeof node[k] === "object") walk(node[k]); }
  };

  let m;
  while ((m = re.exec(html))) {
    try { walk(JSON.parse(m[1].trim())); } catch (e) {}
  }
  return Object.keys(days).length ? days : null;
}

// Fallback: scan visible page text for "Mon - Fri: 8:00am - 5:00pm" patterns
function parseTextHours(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ").replace(/&#160;/g, " ")
    .replace(/&ndash;/gi, "–").replace(/&mdash;/gi, "—")
    .replace(/&#(\d+);/g, (_, c) => +c === 160 ? " " : String.fromCharCode(+c))
    .replace(/([ap])\.m\./gi, "$1m")
    .replace(/\s+/g, " ");

  const days = {};
  const re = /\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*\.?\s*(?:(?:[-–—]|to|thru|through)\s*(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*\.?)?\s*:?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:[-–—]|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi;

  let m, n = 0;
  while ((m = re.exec(text)) && n++ < 50) {
    let o = toMin(`${m[3]}:${m[4] || "00"} ${m[5] || "am"}`);
    const c = toMin(`${m[6]}:${m[7] || "00"} ${m[8]}`);
    // "1:00 - 5:00pm" with no am/pm on the open time → if am gives an absurdly
    // long day, the open time was actually pm
    if (!m[5] && o != null && c != null && c - o > 13 * 60) {
      const alt = toMin(`${m[3]}:${m[4] || "00"} pm`);
      if (alt != null && alt < c) o = alt;
    }
    const a = DAY_IDX[m[1].toLowerCase()];
    if (m[2]) {
      const b = DAY_IDX[m[2].toLowerCase()];
      if (a != null && b != null) expandDayRange(a, b).forEach((i) => addInterval(days, i, o, c));
    } else {
      addInterval(days, a, o, c);
    }
  }

  // Pass 2: comma-listed days sharing one time range — "Mon, Wed: 7AM – 5PM"
  const DAY_WORD = "(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*\\.?";
  const reComma = new RegExp(
    `\\b((?:${DAY_WORD}\\s*,\\s*)+${DAY_WORD})\\s*:?\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?\\s*(?:[-–—]|to|until)\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)\\b`,
    "gi"
  );
  while ((m = reComma.exec(text)) && n++ < 50) {
    let o = toMin(`${m[2]}:${m[3] || "00"} ${m[4] || "am"}`);
    const c = toMin(`${m[5]}:${m[6] || "00"} ${m[7]}`);
    if (!m[4] && o != null && c != null && c - o > 13 * 60) {
      const alt = toMin(`${m[2]}:${m[3] || "00"} pm`);
      if (alt != null && alt < c) o = alt;
    }
    m[1].split(/\s*,\s*/).forEach((d) => {
      addInterval(days, DAY_IDX[d.trim().replace(/\.$/, "").toLowerCase()], o, c);
    });
  }

  return Object.keys(days).length ? days : null;
}

// ── Fetching ─────────────────────────────────────────────────────────────────

async function fetchPage(url, timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { accept: "text/html" } });
    if (!r.ok) throw new Error(`status ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

// Find likely contact/hours subpage URLs by scanning the root page for relevant links
// and appending common paths. Returns absolute URLs on the same origin.
function findHoursSubpages(siteRoot, rootHtml) {
  const candidates = new Set();
  const origin = (() => { try { return new URL(siteRoot).origin; } catch (e) { return ""; } })();
  if (!origin) return [];

  // Scan <a href> for pages whose path suggests hours/contact/location
  const re = /href=["']([^"'#?]+)["']/gi;
  let m;
  while ((m = re.exec(rootHtml)) && candidates.size < 20) {
    try {
      const abs = new URL(m[1], siteRoot).href;
      if (!abs.startsWith(origin)) continue;
      if (/contact|hours|location|office|about|info/i.test(abs)) candidates.add(abs);
    } catch (e) {}
  }

  // Common paths: contact first (most sites put hours there), then hours-specific, then locations
  const root = siteRoot.replace(/\/$/, "");
  for (const p of ["/contact", "/contact-us", "/hours", "/office-hours", "/our-hours",
                   "/locations", "/location", "/our-locations", "/about", "/our-office"]) {
    candidates.add(root + p);
  }

  return [...candidates].filter((u) => u !== siteRoot && u !== siteRoot + "/");
}

// Returns { days, pageUrl } — pageUrl is the exact URL the hours were read from.
async function fetchHours(siteRoot) {
  // Normalise: try with and without www.
  const rootUrls = [siteRoot];
  try {
    const u = new URL(siteRoot);
    if (!u.hostname.startsWith("www.") && u.pathname === "/")
      rootUrls.push(siteRoot.replace("://", "://www."));
  } catch (e) {}

  let rootHtml = "", rootUrl = siteRoot;
  for (const u of rootUrls) {
    try { rootHtml = await fetchPage(u); rootUrl = u; if (rootHtml) break; } catch (e) {}
  }
  if (!rootHtml) throw new Error("unreachable");

  // 1. Try subpages. Text-visible hours are the ground truth — if a page only has JSON-LD
  //    (e.g. a site-wide schema block in the footer) without displayed hours text, it's not
  //    the right source link. Keep the first JSON-LD-only result as a fallback but keep
  //    searching until we find a page with text-visible hours.
  const subpages = findHoursSubpages(rootUrl, rootHtml);
  let jsonLdFallback = null;
  for (const url of subpages.slice(0, 8)) {
    try {
      const html = await fetchPage(url, 6000);
      const textDays = parseTextHours(html);
      if (textDays) {
        console.log("[Pearl Dupe Checker] text hours found on subpage:", url);
        return { days: textDays, pageUrl: url };
      }
      if (!jsonLdFallback) {
        const jsonDays = parseJsonLd(html);
        if (jsonDays) jsonLdFallback = { days: jsonDays, pageUrl: url };
      }
    } catch (e) {}
  }
  if (jsonLdFallback) {
    console.log("[Pearl Dupe Checker] JSON-LD fallback:", jsonLdFallback.pageUrl);
    return jsonLdFallback;
  }

  // 2. Fall back to root page — text first, then JSON-LD
  const days = parseTextHours(rootHtml) || parseJsonLd(rootHtml);
  if (days) return { days, pageUrl: rootUrl };

  throw new Error("no_hours_on_page");
}

// No website on the record → DuckDuckGo HTML search, try the top results
async function searchSiteUrls(query) {
  try {
    const html = await fetchPage("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query));
    const urls = [];
    const re = /uddg=([^&"']+)/g;
    let m;
    while ((m = re.exec(html)) && urls.length < 5) {
      try {
        const u = decodeURIComponent(m[1]);
        if (/duckduckgo|facebook\.|instagram\.|linkedin\.|youtube\.|twitter\.|x\.com/.test(u)) continue;
        if (!urls.includes(u)) urls.push(u);
      } catch (e) {}
    }
    return urls;
  } catch (e) {
    return [];
  }
}

// ── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // CSRF fallback: content script asks for the hubspotapi-csrf cookie when it
  // can't read it from document.cookie (HttpOnly, or rotated after idle).
  if (msg.type === "getCsrf") {
    chrome.cookies.get(
      { url: "https://app.hubspot.com", name: "hubspotapi-csrf" },
      (cookie) => sendResponse({ csrf: cookie ? cookie.value : "" })
    );
    return true; // async response
  }

  if (msg.type === "checkHours") {
    (async () => {
      let days = null, source = "";
      if (msg.site) {
        try {
          const result = await fetchHours(msg.site);
          days = result.days; source = result.pageUrl;
        } catch (e) { console.log("[Pearl Dupe Checker] hours from site failed:", e.message); }
      }
      if (!days && msg.query) {
        const urls = await searchSiteUrls(msg.query);
        for (const u of urls.slice(0, 2)) {
          try {
            const result = await fetchHours(u);
            days = result.days; source = result.pageUrl;
            break;
          } catch (e) {}
        }
      }
      if (days) {
        console.log("[Pearl Dupe Checker] hours found via", source);
        sendResponse({ ok: true, days, source });
      } else {
        sendResponse({ ok: false, error: "no_hours_found" });
      }
    })();
    return true; // async response
  }
});
