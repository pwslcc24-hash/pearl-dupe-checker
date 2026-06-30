/*
 * Pearl Dupe Checker — content script
 *
 * Runs on HubSpot Contact (/record/0-1/) and Company (/record/0-2/) records.
 * Detects SPA navigation via history.pushState override + polling fallback.
 *
 * Contact page checks:
 *   1. Unlinked company matches (catches "about to call a customer")
 *   2. Duplicate contacts (same email/phone, different company)
 *      — contacts sharing the same linked company are NOT flagged (normal)
 *
 * Company page checks:
 *   1. Duplicate company records (same name/phone/domain)
 */
(function () {
  "use strict";

  const LOG = (...a) => console.log("[Pearl Dupe Checker]", ...a);

  const OT_CONTACT = "0-1";
  const OT_COMPANY = "0-2";
  const PORTAL_ID  = location.pathname.split("/")[2] || "";

  const CONTACT_PROPS = [
    "firstname", "lastname", "email", "phone",
    "company", "associatedcompanyid", "hubspot_owner_id",
    "lifecyclestage", "hs_lead_status", "state",
    "hs_last_activity_date", // used to detect if record has been worked
  ];
  const COMPANY_PROPS = [
    "name", "phone", "domain", "website", "hubspot_owner_id", "state", "city",
    "lifecyclestage", "hs_latest_deal_stage",
    "products", "pearl_products", "active_products", "current_products",
    "account_status", "customer_status", "csm_owner", "subscription_status",
    "hs_parent_company_id",   // used to detect parent/child/sibling relationships
    "hs_last_activity_date",  // used to detect if record has been worked
    "notes_last_updated",     // fallback: company-level notes/activity date
    "notable_status",         // "Enterprise (DSO)", "Multi-office", "KOL"
    "primary_segment",        // "Domestic - Enterprise" / "Domestic - SMB"
    "number_of_locations",    // Pearl custom — integer, 10+ = enterprise DSO territory
    "account_status_is_active", // "false" = reliably churned; blank = unknown (new customers often not set)
  ];

  // ── HubSpot API ────────────────────────────────────────────────────────────

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // True only while the extension context is still valid.
  function extensionAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  }

  function csrfFromDoc() {
    const m = document.cookie.match(/(?:^|;\s*)hubspotapi-csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  // Read the CSRF token. Fast path is document.cookie (no service worker
  // needed). If that's empty (HttpOnly or rotated after idle), fall back to
  // asking the background worker via chrome.cookies.
  async function getCsrf() {
    const direct = csrfFromDoc();
    if (direct) return direct;
    if (!extensionAlive()) return "";
    try {
      return await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "getCsrf" }, (resp) => {
          if (chrome.runtime.lastError) return resolve("");
          resolve((resp && resp.csrf) || "");
        });
      });
    } catch (e) { return ""; }
  }

  async function hsSearch(objectTypeId, props, filterGroups, query) {
    const url = `/api/crm-search/search?portalId=${PORTAL_ID}&hs_static_app=crm-index-ui`;
    const body = {
      objectTypeId, count: 50, offset: 0,
      requestOptions: { properties: props },
      filterGroups: filterGroups || [], sorts: [],
    };
    if (query) body.query = query;
    const res = await fetch(url, {
      method: "POST", credentials: "include",
      headers: {
        "content-type": "application/json",
        "x-hubspot-csrf-hubspotapi": await getCsrf(),
        "x-hs-locale": "EN",
        "accept": "application/json, text/javascript, */*; q=0.01",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`hsSearch ${objectTypeId} → ${res.status}`);
    return (await res.json()).results || [];
  }

  // Fetch the current record by ID, with retries — covers the stale-CSRF /
  // transient-403 / HubSpot-warming-up window right after the tab was idle.
  async function fetchCurrentRecord(objectTypeId, props, id, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      try {
        const rows = await hsSearch(objectTypeId, props, [{ filters: [{ property: "hs_object_id", operator: "IN", values: [id] }] }]);
        const cur = rows.map(flatten)[0];
        if (cur) return cur;
      } catch (e) {
        LOG(`record fetch failed (attempt ${i + 1}/${attempts}): ${e.message}`);
      }
      if (i < attempts - 1) await sleep(500 * (i + 1));
    }
    return null;
  }

  // ── Normalisation ──────────────────────────────────────────────────────────

  function val(p) {
    if (p && typeof p === "object") return p.value || "";
    return p == null ? "" : String(p);
  }
  function flatten(r) {
    const props = r.properties || {};
    const out = { id: String(r.objectId || r.id || "") };
    for (const k in props) out[k] = val(props[k]);
    return out;
  }
  const norm      = (s) => (s || "").trim().toLowerCase();
  const normPhone = (p) => { const d = (p || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };

  // Returns every common format of a phone number so we catch however HubSpot stored it.
  // e.g. "3016568788" → ["3016568788", "(301) 656-8788", "301-656-8788", "+13016568788"]
  function phoneSearchQueries(raw) {
    const digits = normPhone(raw);
    if (!digits) return raw ? [raw.trim()] : [];
    const q = new Set([digits]);
    if (raw && raw.trim() !== digits) q.add(raw.trim()); // original as stored
    if (digits.length === 10) {
      const [a, b, c] = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)];
      q.add(`(${a}) ${b}-${c}`);   // (301) 656-8788
      q.add(`${a}-${b}-${c}`);     // 301-656-8788
      q.add(`${a}.${b}.${c}`);     // 301.656.8788
      q.add(`+1${digits}`);        // +13016568788
    }
    return [...q];
  }

  // Domains that are NOT practice-specific — never use for duplicate matching.
  const GENERIC_DOMAINS = new Set([
    // Email providers
    "gmail.com","googlemail.com","yahoo.com","yahoo.co.uk","ymail.com",
    "hotmail.com","hotmail.co.uk","outlook.com","live.com","msn.com",
    "icloud.com","me.com","mac.com","aol.com","aim.com",
    "mail.com","protonmail.com","proton.me","zoho.com","zohomail.com",
    "fastmail.com","tutanota.com","yandex.com","inbox.com",
    // Big-business / tech that would never be a dental practice
    "google.com","microsoft.com","apple.com","amazon.com","facebook.com",
    "instagram.com","twitter.com","x.com","linkedin.com","salesforce.com",
    "hubspot.com","intuit.com","quickbooks.com","stripe.com","square.com",
    // Placeholder / test
    "example.com","test.com","temp.com","noreply.com",
  ]);
  function normName(s) {
    return norm(s)
      .replace(/\b(llc|inc|corp|ltd|dds|dmd|pa|pc|pllc|dental|dentistry|group|associates|practice)\b/g, "")
      .replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  }
  function isFormerCustomer(co) {
    if (!co || co.account_status_is_active !== "false") return false;
    // Active customers with a stale inactive flag still have lifecyclestage = "customer"
    if (norm(co.lifecyclestage) === "customer") return false;
    // Products still set after churn — proves they were a Pearl customer
    const products = [co.products, co.pearl_products, co.active_products, co.current_products];
    return products.some((f) => f && f.trim());
  }

  function isCustomer(co) {
    if (norm(co.lifecyclestage) === "customer") return true; // lifecycle stage wins over stale inactive flag
    if (co.account_status_is_active === "false") return false; // churned — lifecycle was cleared
    if (norm(co.account_status) === "active")   return true;
    const products = [co.products, co.pearl_products, co.active_products, co.current_products];
    if (products.some((f) => f && f.trim()))    return true;
    return false;
  }

  // ── Finders ────────────────────────────────────────────────────────────────
  // Every match has: { objectType, name, meta, href, typeLabel, reasons[], strong, customer }

  async function findUnlinkedCompanies(cur) {
    const companyText = (cur.company || "").trim();
    const phone       = normPhone(cur.phone);
    const linkedId    = (cur.associatedcompanyid || "").trim();
    const curState    = norm(cur.state || "");
    // Extract domain from contact's email (e.g. john@smithdental.com → smithdental.com)
    const emailParts  = (cur.email || "").split("@");
    const emailDomain = emailParts.length === 2 ? norm(emailParts[1]) : "";
    const candidates  = {};
    const collect = (rows) => rows.forEach((r) => { const c = flatten(r); if (c.id && c.id !== linkedId) candidates[c.id] = c; });

    if (companyText) {
      try { collect(await hsSearch(OT_COMPANY, COMPANY_PROPS, [{ filters: [{ property: "name", operator: "CONTAINS_TOKEN", value: companyText.split(" ")[0] }] }])); } catch (e) {}
      try { collect(await hsSearch(OT_COMPANY, COMPANY_PROPS, null, companyText)); } catch (e) {}
    }
    // Search all phone formats in parallel — catches (301) 656-8788 vs 3016568788 asymmetry
    if (phone) await Promise.all(phoneSearchQueries(cur.phone).map(q =>
      hsSearch(OT_COMPANY, COMPANY_PROPS, null, q).then(collect).catch(() => {})));
    // Search by email domain — only if it's a real practice domain, not a generic provider
    if (emailDomain && !GENERIC_DOMAINS.has(emailDomain)) {
      try { collect(await hsSearch(OT_COMPANY, COMPANY_PROPS, [{ filters: [{ property: "domain", operator: "EQ", value: emailDomain }] }])); } catch (e) {}
    }

    const curNorm = normName(companyText);
    return Object.values(candidates).reduce((acc, co) => {
      const reasons = []; let strong = false;
      const coNorm   = normName(co.name);
      const coPhone  = normPhone(co.phone);
      const coDomain = norm(co.domain || co.website || "");
      const coState  = norm(co.state || "");

      // Phone / domain = definitive → strong (red). Skip generic domains on both sides.
      if (phone && coPhone && phone === coPhone)                                                                               { reasons.push("same phone");  strong = true; }
      if (emailDomain && !GENERIC_DOMAINS.has(emailDomain) && coDomain && !GENERIC_DOMAINS.has(coDomain) && emailDomain === coDomain) { reasons.push("same domain"); strong = true; }
      // Name matches = name-only overlap (stays green) — same name across states is common
      if (curNorm && curNorm === coNorm && curNorm.length > 3)                                        { reasons.push("same practice name"); }
      if (!reasons.some(r => r === "same practice name") && curNorm.length > 5 && coNorm.length > 5 &&
          (curNorm.includes(coNorm) || coNorm.includes(curNorm))) {
        const coState = norm(co.state || "");
        if (!curState || !coState || curState === coState) reasons.push("similar practice name");
      }
      if (!reasons.length) return acc;
      const customer = isCustomer(co);
      const active = !!(co.hs_last_activity_date || co.notes_last_updated) || !!(cur.hs_last_activity_date || cur.notes_last_updated);
      const meta = [co.phone, co.domain || co.website, co.state].filter(Boolean).join(" · ");
      acc.push({ objectType: OT_COMPANY, name: co.name || "(no name)", meta, href: recordUrl(OT_COMPANY, co.id), typeLabel: customer ? "Company · CUSTOMER" : "Company", reasons, strong, active, customer, curIsCustomer: isCustomer(cur) });
      return acc;
    }, []).sort((a, b) => b.customer !== a.customer ? (b.customer ? 1 : -1) : (b.strong === a.strong ? 0 : b.strong ? 1 : -1));
  }

  // Check if the contact's linked company is a Pearl customer.
  // Tries by associatedcompanyid first, then falls back to searching by company name —
  // because associatedcompanyid isn't always returned by the CRM search API.
  async function checkLinkedCompanyCustomer(linkedId, companyName) {
    const seen = new Set();
    const candidates = [];

    // 1. Look up by explicit ID
    if (linkedId) {
      try {
        const rows = await hsSearch(OT_COMPANY, COMPANY_PROPS, [{ filters: [{ property: "hs_object_id", operator: "IN", values: [linkedId] }] }]);
        rows.map(flatten).forEach((c) => { if (c.id && !seen.has(c.id)) { seen.add(c.id); candidates.push(c); } });
      } catch (e) {}
    }

    // 2. Fall back to searching by company name (catches when associatedcompanyid is empty)
    if (companyName && !candidates.some(isCustomer)) {
      try {
        const curNorm = normName(companyName);
        const rows = await hsSearch(OT_COMPANY, COMPANY_PROPS, null, companyName);
        rows.map(flatten)
          .filter((c) => normName(c.name) === curNorm && !seen.has(c.id))
          .forEach((c) => { seen.add(c.id); candidates.push(c); });
      } catch (e) {}
    }

    const co = candidates.find(isCustomer);
    if (!co) return null;
    return {
      objectType: OT_COMPANY,
      name: co.name || "(no name)",
      meta: [co.phone, co.domain || co.website, co.state].filter(Boolean).join(" · "),
      href: recordUrl(OT_COMPANY, co.id),
      typeLabel: "Company · CUSTOMER",
      reasons: ["linked company is a Pearl customer"],
      strong: true, customer: true, linkedCustomer: true,
    };
  }

  async function findDuplicateContacts(cur) {
    const linkedId   = (cur.associatedcompanyid || "").trim();
    const candidates = {};
    const collect = (rows) => rows.forEach((r) => {
      const c = flatten(r);
      if (!c.id || c.id === cur.id) return;
      if (linkedId && c.associatedcompanyid === linkedId) return;
      candidates[c.id] = c;
    });

    if (cur.email) { try { collect(await hsSearch(OT_CONTACT, CONTACT_PROPS, [{ filters: [{ property: "email", operator: "EQ", value: cur.email }] }])); } catch (e) {} }
    const ph = normPhone(cur.phone);
    if (ph) await Promise.all(phoneSearchQueries(cur.phone).map(q =>
      hsSearch(OT_CONTACT, CONTACT_PROPS, null, q).then(collect).catch(() => {})));

    return Object.values(candidates).reduce((acc, cand) => {
      const reasons = []; let strong = false;
      if (cur.email && norm(cur.email) === norm(cand.email)) { reasons.push("same email"); strong = true; }
      const cp = normPhone(cur.phone), dp = normPhone(cand.phone);
      if (cp && dp && cp === dp) { reasons.push("same phone"); strong = true; }
      if (!reasons.length) return acc;
      const active = !!(cand.hs_last_activity_date || cand.notes_last_updated) || !!(cur.hs_last_activity_date || cur.notes_last_updated);
      acc.push({ objectType: OT_CONTACT, name: `${cand.firstname || ""} ${cand.lastname || ""}`.trim() || cand.email || "(no name)", meta: [cand.email, cand.phone, cand.company].filter(Boolean).join(" · "), href: recordUrl(OT_CONTACT, cand.id), typeLabel: "Contact", reasons, strong, active, customer: false, curIsCustomer: false });
      return acc;
    }, []).sort((a, b) => b.strong === a.strong ? 0 : b.strong ? 1 : -1);
  }

  async function findDuplicateCompanies(cur, excludeIds = new Set()) {
    const name   = (cur.name || "").trim();
    const phone  = normPhone(cur.phone);
    // Only use domain for matching if it's a real practice domain
    const rawDomain = norm(cur.domain || cur.website || "");
    const domain = rawDomain && !GENERIC_DOMAINS.has(rawDomain) ? rawDomain : "";
    const candidates = {};
    const collect = (rows) => rows.forEach((r) => { const c = flatten(r); if (c.id && c.id !== cur.id && !excludeIds.has(c.id)) candidates[c.id] = c; });

    if (name)   { try { collect(await hsSearch(OT_COMPANY, COMPANY_PROPS, null, name.split(" ")[0])); } catch (e) {}
                  try { collect(await hsSearch(OT_COMPANY, COMPANY_PROPS, null, name)); } catch (e) {} }
    if (phone)  await Promise.all(phoneSearchQueries(cur.phone).map(q =>
      hsSearch(OT_COMPANY, COMPANY_PROPS, null, q).then(collect).catch(() => {})));
    if (domain) { try { collect(await hsSearch(OT_COMPANY, COMPANY_PROPS, [{ filters: [{ property: "domain", operator: "EQ", value: domain }] }])); } catch (e) {} }

    const curNorm     = normName(name);
    const curParentId = (cur.hs_parent_company_id || "").trim();

    return Object.values(candidates).reduce((acc, cand) => {
      // ── Skip already-related companies ────────────────────────────────────
      // 1. Manually excluded (passed in from run())
      if (excludeIds.has(cand.id)) return acc;
      // 2. Direct parent/child relationship
      const candParentId = (cand.hs_parent_company_id || "").trim();
      const isParent   = curParentId  && cand.id === curParentId;   // cand IS our parent
      const isChild    = candParentId && candParentId === cur.id;   // cand is our child
      // 3. Siblings — both share the same non-empty parent company
      const isSibling  = curParentId && candParentId && curParentId === candParentId;
      if (isParent || isChild || isSibling) {
        LOG(`Skipping related company "${cand.name}" (parent/child/sibling of "${cur.name}")`);
        return acc;
      }

      const reasons = []; let strong = false;
      const candRawDomain = norm(cand.domain || cand.website || "");
      const candDomain = candRawDomain && !GENERIC_DOMAINS.has(candRawDomain) ? candRawDomain : "";
      const candPhone = normPhone(cand.phone), candNorm = normName(cand.name);
      // Phone / domain = definitive → strong (red). Generic domains ignored on both sides.
      if (domain && candDomain && domain === candDomain) { reasons.push("same domain"); strong = true; }
      if (phone  && candPhone  && phone  === candPhone)  { reasons.push("same phone");  strong = true; }
      // Name matches = name-only overlap (stays green)
      if (curNorm && candNorm && curNorm === candNorm && curNorm.length > 3) {
        reasons.push("same company name");
      } else if (curNorm.length > 5 && candNorm.length > 5 && (curNorm.includes(candNorm) || candNorm.includes(curNorm))) {
        const curState = norm(cur.state || ""), candState = norm(cand.state || "");
        if (!curState || !candState || curState === candState) reasons.push("similar company name");
      }
      if (!reasons.length) return acc;
      const customer = isCustomer(cand);
      const active = !!(cand.hs_last_activity_date || cand.notes_last_updated) || !!(cur.hs_last_activity_date || cur.notes_last_updated);
      acc.push({ objectType: OT_COMPANY, name: cand.name || "(no name)", meta: [cand.phone, cand.domain || cand.website].filter(Boolean).join(" · "), href: recordUrl(OT_COMPANY, cand.id), typeLabel: customer ? "Company · CUSTOMER" : "Company", reasons, strong, active, customer, curIsCustomer: isCustomer(cur) });
      return acc;
    }, []).sort((a, b) => b.customer !== a.customer ? (b.customer ? 1 : -1) : (b.strong === a.strong ? 0 : b.strong ? 1 : -1));
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  const LS_POS = "pdc:pos2"; // v2 — uses top instead of bottom

  function loadPos()     { try { return JSON.parse(localStorage.getItem(LS_POS)); } catch (e) { return null; } }
  function savePos(r, t) { try { localStorage.setItem(LS_POS, JSON.stringify({ right: r, top: t })); } catch (e) {} }

  // ── Widget state ───────────────────────────────────────────────────────────

  let widgetExpanded = false; // always start collapsed; only true after user explicitly opens

  // ── Business hours / open-now check ────────────────────────────────────────
  // After the dupe check renders, the background worker fetches the practice's
  // website and extracts business hours. We compute open/closed in the
  // practice's own timezone (from its state) and show a pill on the header.

  const STATE_TZ = (() => {
    const zones = {
      "America/New_York":    "ct connecticut de delaware fl florida ga georgia in indiana ky kentucky me maine md maryland ma massachusetts mi michigan nh newhampshire nj newjersey ny newyork nc northcarolina oh ohio pa pennsylvania ri rhodeisland sc southcarolina vt vermont va virginia wv westvirginia dc",
      "America/Chicago":     "al alabama ar arkansas il illinois ia iowa ks kansas la louisiana mn minnesota ms mississippi mo missouri ne nebraska nd northdakota ok oklahoma sd southdakota tn tennessee tx texas wi wisconsin",
      "America/Denver":      "co colorado id idaho mt montana nm newmexico ut utah wy wyoming",
      "America/Phoenix":     "az arizona",
      "America/Los_Angeles": "ca california nv nevada or oregon wa washington",
      "America/Anchorage":   "ak alaska",
      "Pacific/Honolulu":    "hi hawaii",
    };
    const map = {};
    for (const tz in zones) zones[tz].split(" ").forEach((k) => { map[k] = tz; });
    return map;
  })();
  function tzForState(state) { return STATE_TZ[norm(state).replace(/\s+/g, "")] || ""; }

  // Named DSO accounts owned by Pearl's enterprise team — SDRs should not cold-call these.
  // Source: Spencer Ellena account list (Q2 2026) + SDR training knowledge base.
  const ENTERPRISE_DSO_NAMES = [
    "heartland dental", "synergy dental partners", "sonrava health",
    "western dental", "brident dental", "smile doctors", "affordable care",
    "dental care alliance", "smile source", "unified smiles", "freedom dental",
    "specialized dental partners", "nadg", "gen4 dental", "lone peak dental",
    "salt dental", "american dental partners", "interdent", "gentle dental",
    "signature dental partners", "specialty1 partners", "benevis", "sage dental",
    "prosmile", "dental365", "cornerstone dental", "beacon oral specialists",
    "the smilist", "imagen dental", "smile partners usa", "passion dental",
    "community dental partners", "smile design dentistry", "chord specialty dental",
    "p1 dental", "kids dental brands", "west coast dental", "smile brands",
    "eastern dental", "peak dental services", "sga dental",
  ];

  // Returns "enterprise" (route to DSO team), "dso" (SDR can work, multi-location),
  // or null (single practice, normal SDR target).
  const PRODUCT_DEFS = [
    { key: "SO",  signals: ["sod", "second opinion"] },
    { key: "PI",  signals: ["practice intell", "practice intel"] },
    { key: "Pre", signals: ["precheck"] },
    { key: "VO",  signals: ["voice"] },
  ];

  function detectProducts(co) {
    if (!co) return null;
    const raw = [co.products, co.pearl_products, co.active_products, co.current_products]
      .filter(Boolean).join(";").toLowerCase();
    if (!raw) return null;
    const result = {};
    for (const { key, signals } of PRODUCT_DEFS) {
      result[key] = signals.some((s) => raw.includes(s));
    }
    return result;
  }

  function detectDso(cur) {
    if (!cur) return null;
    const seg     = norm(cur.primary_segment  || "");
    const notable = norm(cur.notable_status   || "");
    const locs    = parseInt(cur.number_of_locations || "0") || 0;
    const name    = norm(cur.name || "");

    // primary_segment "Domestic - Enterprise" or notable_status containing DSO/Enterprise
    const enterpriseSeg = seg.includes("enterprise") ||
      notable.includes("enterprise") || notable.includes("dso");

    // Named account on the enterprise team's list
    const namedEnterprise = ENTERPRISE_DSO_NAMES.some((n) => name.includes(n));

    // 9+ locations = SDR handoff threshold; 10+ = HubSpot enterprise protection
    if (locs >= 9 || enterpriseSeg || namedEnterprise) return "enterprise";
    return null;
  }

  let hoursKey      = null;  // record key the cached hours belong to
  let hoursDays     = null;  // { dayIdx(0=Sun) : [{o, c}] } minutes since midnight
  let hoursTz       = "";
  let hoursSource   = "";    // URL of the page the hours were found on (the proof)
  let hoursFetched  = false; // true once the check has completed (success or fail)
  let dsoRecord     = null;  // current record snapshot used for DSO pill

  // Recomputed on every pill render so a long-open tab flips open→closed correctly
  function computeOpenStatus(days, tz) {
    const SHORT = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    let idx, nowMin;
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz || undefined, weekday: "short", hour: "numeric", minute: "numeric", hour12: false,
      }).formatToParts(new Date());
      const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
      idx = SHORT[get("weekday").toLowerCase()];
      nowMin = (parseInt(get("hour"), 10) % 24) * 60 + parseInt(get("minute"), 10);
    } catch (e) {
      const d = new Date(); idx = d.getDay(); nowMin = d.getHours() * 60 + d.getMinutes();
    }
    const today = days[idx] || [];
    const open = today.some((iv) => nowMin >= iv.o && nowMin < iv.c);

    // Detect lunch break: current time falls in a gap between two sessions on the same day
    let isLunch = false, minutesUntilReturn = null;
    if (!open && today.length > 1) {
      const sorted = [...today].sort((a, b) => a.o - b.o);
      for (let i = 0; i < sorted.length - 1; i++) {
        if (nowMin >= sorted[i].c && nowMin < sorted[i + 1].o) {
          isLunch = true;
          minutesUntilReturn = sorted[i + 1].o - nowMin;
          break;
        }
      }
    }

    const fmt = (min) => {
      const h12 = ((Math.floor(min / 60) + 11) % 12) + 1;
      return `${h12}:${String(min % 60).padStart(2, "0")} ${min < 720 ? "AM" : "PM"}`;
    };
    const todayLabel = today.length ? today.map((iv) => `${fmt(iv.o)}–${fmt(iv.c)}`).join(", ") : "Closed today";
    return { open, isLunch, minutesUntilReturn, todayLabel };
  }

  function getOrCreatePill(head) {
    let pill = head.querySelector(".pdc-hours");
    if (!pill) {
      pill = document.createElement("a");
      pill.className = "pdc-hours";
      pill.target = "_blank";
      pill.rel = "noopener";
      pill.addEventListener("click", (e) => e.stopPropagation());
      head.insertBefore(pill, head.querySelector(".pdc-controls"));
    }
    return pill;
  }

  function getOrCreateDsoPill(head) {
    let pill = head.querySelector(".pdc-dso");
    if (!pill) {
      pill = document.createElement("span");
      pill.className = "pdc-dso";
      pill.addEventListener("click", (e) => e.stopPropagation());
      // DSO pill goes before the hours pill (or before controls if no hours pill yet)
      head.insertBefore(pill, head.querySelector(".pdc-hours") || head.querySelector(".pdc-controls"));
    }
    return pill;
  }

  function updateDsoPill() {
    const head = document.querySelector(`#${WIDGET_ID} .pdc-head`);
    if (!head || !dsoRecord) return;
    const dsoType = detectDso(dsoRecord);
    if (!dsoType) return;
    const pill = getOrCreateDsoPill(head);
    pill.textContent = "DSO";
    pill.title = "9+ locations — route to enterprise team, do not cold call";
    pill.className = "pdc-dso pdc-dso-enterprise";
  }

  function updateHoursPill() {
    const head = document.querySelector(`#${WIDGET_ID} .pdc-head`);
    if (!head) return;
    const pill = getOrCreatePill(head);

    if (!hoursFetched || hoursKey !== lastKey) {
      // Still loading
      pill.textContent = "·";
      pill.href = "#";
      pill.title = "Checking hours…";
      pill.className = "pdc-hours pdc-hours-loading";
      return;
    }

    if (!hoursDays) {
      // Check completed but no hours found
      pill.textContent = "UNKNOWN";
      pill.href = "#";
      pill.title = "Couldn't find hours for this practice";
      pill.className = "pdc-hours pdc-hours-unknown";
      return;
    }

    const status = computeOpenStatus(hoursDays, hoursTz);
    pill.href = hoursSource || "#";

    if (!status.open && status.isLunch && status.minutesUntilReturn != null) {
      // Convert minutes-until-return to an absolute timestamp, then format in user's local timezone
      const returnDate = new Date(Date.now() + status.minutesUntilReturn * 60000);
      const timeParts = new Intl.DateTimeFormat("en-US", {
        hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
      }).formatToParts(returnDate);
      const get = (t) => (timeParts.find((p) => p.type === t) || {}).value || "";
      const returnTime = `${get("hour")}:${get("minute")} ${get("dayPeriod")} ${get("timeZoneName")}`;
      pill.textContent = `LUNCH until ${returnTime}`;
      pill.title = `Today: ${status.todayLabel}${hoursTz ? " (their local time)" : ""} — click to see source`;
      pill.className = "pdc-hours pdc-hours-lunch";
      return;
    }

    pill.textContent = status.open ? "OPEN" : "CLOSED";
    pill.title = `Today: ${status.todayLabel}${hoursTz ? " (their local time)" : ""} — click to see source`;
    pill.className = "pdc-hours " + (status.open ? "pdc-hours-open" : "pdc-hours-closed");
  }

  async function checkBusinessHours(cur) {
    const myKey = lastKey;

    // Already fetched for this record — just re-draw the pill
    if (hoursKey === myKey && hoursFetched) { updateHoursPill(); return; }

    // Show loading pill immediately
    hoursFetched = false;
    updateHoursPill();

    // Best source: the record's own website/domain (skip generic providers)
    let site = "";
    const rawSite = norm(cur.domain || cur.website || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    if (rawSite && !GENERIC_DOMAINS.has(rawSite)) site = "https://" + rawSite;
    if (!site) {
      const ep = (cur.email || "").split("@");
      if (ep.length === 2 && ep[1] && !GENERIC_DOMAINS.has(norm(ep[1]))) site = "https://" + norm(ep[1]);
    }
    // No website on the record → let the background worker web-search for it
    const bizName = (cur.name || cur.company || "").trim();
    const query = !site && bizName
      ? `${bizName} ${cur.city || ""} ${cur.state || ""} hours`.replace(/\s+/g, " ").trim()
      : "";

    if (!site && !query) {
      // Nothing to search with — mark unknown immediately
      hoursKey = myKey; hoursFetched = true; hoursDays = null;
      updateHoursPill();
      return;
    }
    if (!extensionAlive()) return;

    let resp = null;
    try {
      resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "checkHours", site, query }, (r) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(r);
        });
      });
    } catch (e) { resp = null; }

    if (lastKey !== myKey) return; // user navigated away while we fetched

    hoursKey    = myKey;
    hoursFetched = true;

    if (!resp || !resp.ok || !resp.days) {
      hoursDays = null;
      LOG("Hours lookup: nothing found", resp && resp.error ? `(${resp.error})` : "");
    } else {
      hoursDays   = resp.days;
      hoursTz     = tzForState(cur.state) || tzForState(resp.pageState || "");
      hoursSource = resp.source || "";
      LOG(`Hours found via ${resp.source} — ${computeOpenStatus(hoursDays, hoursTz).open ? "OPEN" : "CLOSED"} now`);
    }
    updateHoursPill();
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────

  const WIDGET_ID = "pearl-dupe-widget";
  function removeWidget() { document.getElementById(WIDGET_ID)?.remove(); }

  function recordUrl(ot, id) {
    return `https://app.hubspot.com/contacts/${PORTAL_ID}/${ot === OT_COMPANY ? "record/0-2" : "record/0-1"}/${id}`;
  }
  function esc(s) {
    return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function applyPos(el) {
    const pos = loadPos();
    if (pos) {
      const clampedRight = Math.min(Math.max(4, pos.right), window.innerWidth - 80);
      const clampedTop   = Math.min(Math.max(4, pos.top),   window.innerHeight - 80);
      el.style.right = clampedRight + "px";
      el.style.top   = clampedTop   + "px";
    }
  }
  function makeDraggable(wrap, handle) {
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest(".pdc-btn, .pdc-hours")) return;
      e.preventDefault();
      handle.style.cursor = "grabbing";
      const rect = wrap.getBoundingClientRect();
      const initR = window.innerWidth - rect.right, initB = rect.top;
      const initX = e.clientX, initY = e.clientY;
      const onMove = (e) => {
        wrap.style.right = Math.max(4, initR - (e.clientX - initX)) + "px";
        wrap.style.top   = Math.max(4, initB + (e.clientY - initY)) + "px";
      };
      const onUp = () => {
        handle.style.cursor = "grab";
        const r = wrap.getBoundingClientRect();
        savePos(window.innerWidth - r.right, r.top);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
  function buildCard(m) {
    const card = document.createElement("div");
    card.className = "pdc-card" + (m.strong ? " pdc-card-strong" : "");
    const isConnectedCustomer = m.linkedCustomer || m.selfRecord;
    const customerInvolved    = m.customer || m.curIsCustomer; // either record is a customer
    const isInactiveStrong    = m.strong && m.active === false && !customerInvolved;
    const severityText  = isConnectedCustomer ? "Pearl customer" : m.strong ? "Likely duplicate found" : "Name overlap";
    const severityClass = isConnectedCustomer ? "pdc-sev-customer"
      : m.strong && !isInactiveStrong ? "pdc-sev-likely"    // red — active dupe
      : m.strong ? "pdc-sev-inactive"                       // amber — no activity
      : "pdc-sev-name";                                     // gray — name only
    const linkText = m.selfRecord ? null : isConnectedCustomer ? "View customer record →" : m.strong ? "Open possible duplicate →" : "View record →";
    card.innerHTML =
      `<div class="pdc-card-severity ${severityClass}">${esc(severityText)}</div>` +
      `<div class="pdc-card-name">${esc(m.name)}<span class="pdc-card-type">${esc(m.typeLabel)}</span></div>` +
      (m.meta ? `<div class="pdc-card-meta">${esc(m.meta)}</div>` : "") +
      `<div class="pdc-card-reasons">${esc(m.reasons.join(", "))}</div>` +
      (linkText ? `<a class="pdc-card-link" href="${esc(m.href)}" target="_blank" rel="noopener">${esc(linkText)}</a>` : "");
    return card;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  let userDismissed = false;

  function render(matches) {
    removeWidget();
    if (userDismissed) return;

    // Separate connected-customer matches (blue) from unconnected duplicate matches.
    // An unconnected company that happens to be a customer is still a DUPLICATE, not a customer flag.
    const connectedCustomer   = matches.filter((m) => m.linkedCustomer || m.selfRecord);
    const dupes               = matches.filter((m) => !m.linkedCustomer && !m.selfRecord);
    const strongDupes         = dupes.filter((m) => m.strong);
    const activeStrongDupes   = strongDupes.filter((m) => m.active !== false || m.customer || m.curIsCustomer); // activity or customer → red
    const inactiveStrongDupes = strongDupes.filter((m) => m.active === false && !m.customer && !m.curIsCustomer); // no activity, no customer → amber
    const nameOnlyDupes       = dupes.filter((m) => !m.strong); // name-only — stays green

    let state, label;
    if (activeStrongDupes.length > 0) {
      // Priority 1: strong dupe that has been actively worked — urgent
      state = "red";
      label = `⚠ ${activeStrongDupes.length} likely duplicate${activeStrongDupes.length === 1 ? "" : "s"} found`;
    } else if (inactiveStrongDupes.length > 0) {
      // Priority 2: strong dupe but no activity logged on it — still flag, but less urgent
      state = "amber";
      label = `⚠ ${inactiveStrongDupes.length} likely duplicate${inactiveStrongDupes.length === 1 ? "" : "s"} found`;
    } else if (connectedCustomer.length > 0) {
      // Priority 3: connected/linked customer, no strong dupes
      state = "blue";
      label = "Existing customer";
    } else if (isFormerCustomer(dsoRecord)) {
      // Priority 4: ex-customer — account_status_is_active=false, no products, was lifecyclestage=customer
      state = "purple";
      label = "EX-CUSTOMER";
    } else {
      // Priority 5: clean — name-only overlaps don't change the badge color
      state = "green";
      label = "✓ No duplicates found";
    }

    const total = matches.length;

    const collapsed = !widgetExpanded; // never auto-open; user must click to expand
    const wrap = document.createElement("div");
    wrap.id = WIDGET_ID;
    wrap.className = "pdc-" + state + (collapsed ? " pdc-collapsed" : "");
    applyPos(wrap);

    // ── Header ──
    const head = document.createElement("div");
    head.className = "pdc-head";

    const headLabel = document.createElement("span");
    headLabel.className = "pdc-head-label";
    headLabel.textContent = label;
    // Subtle name-overlap hint — stays green but shows count in faded text
    if (nameOnlyDupes.length > 0 && state !== "red") {
      const hint = document.createElement("span");
      hint.className = "pdc-name-hint";
      hint.textContent = ` · ${nameOnlyDupes.length} similar name${nameOnlyDupes.length === 1 ? "" : "s"}`;
      headLabel.appendChild(hint);
    }
    head.appendChild(headLabel);

    const controls = document.createElement("span");
    controls.className = "pdc-controls";

    const refreshBtn = document.createElement("button");
    refreshBtn.className = "pdc-btn pdc-refresh";
    refreshBtn.title = "Re-check now";
    refreshBtn.textContent = "↺";

    const closeBtn = document.createElement("button");
    closeBtn.className = "pdc-btn pdc-close";
    closeBtn.title = "Dismiss";
    closeBtn.textContent = "×";

    controls.append(refreshBtn, closeBtn);
    head.appendChild(controls);
    wrap.appendChild(head);

    // ── Product row (always visible) ──
    const prods = detectProducts(dsoRecord);
    if (prods) {
      const prodRow = document.createElement("div");
      prodRow.className = "pdc-products";
      for (const { key } of PRODUCT_DEFS) {
        const pill = document.createElement("span");
        pill.textContent = key;
        pill.className = "pdc-prod " + (prods[key] ? "pdc-prod-has" : "pdc-prod-sell");
        pill.title = prods[key] ? `Has ${key}` : `Can sell ${key}`;
        prodRow.appendChild(pill);
      }
      wrap.appendChild(prodRow);
    }

    // ── Body ──
    const body = document.createElement("div");
    body.className = "pdc-body";
    body.style.display = !collapsed ? "" : "none";

    if (total > 0) {
      matches.slice(0, 15).forEach((m) => body.appendChild(buildCard(m)));
    } else {
      const note = document.createElement("div");
      note.className = "pdc-clear-note";
      note.textContent = "Checked: email, phone, company name, domain";
      body.appendChild(note);
    }
    wrap.appendChild(body);

    document.body.appendChild(wrap);
    updateHoursPill(); // restore open/closed pill if we already have hours for this record
    updateDsoPill();   // show DSO badge if applicable

    // ── Collapse toggle ──
    function setCollapsed(v) {
      widgetExpanded = !v;
      wrap.classList.toggle("pdc-collapsed", v);
      body.style.display = v ? "none" : "";
    }
    head.addEventListener("click", (e) => { if (!e.target.closest(".pdc-btn, .pdc-hours")) setCollapsed(!wrap.classList.contains("pdc-collapsed")); });

    // ── Re-check ──
    refreshBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const info = getRecordInfo();
      if (!info) return;
      lastResult = null; lastResultAt = 0;
      run(info.type, info.id);
    });

    // ── Dismiss ──
    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); userDismissed = true; removeWidget(); });

    makeDraggable(wrap, head);
  }

  function renderLoading() {
    removeWidget();
    if (userDismissed) return;
    const wrap = document.createElement("div");
    wrap.id = WIDGET_ID;
    wrap.className = "pdc-loading";
    applyPos(wrap);
    const head = document.createElement("div");
    head.className = "pdc-head";
    const lbl = document.createElement("span");
    lbl.className = "pdc-head-label";
    lbl.textContent = "Checking for duplicates…";
    head.appendChild(lbl);
    wrap.appendChild(head);
    document.body.appendChild(wrap);
    makeDraggable(wrap, head);
  }

  // ── Run ────────────────────────────────────────────────────────────────────

  let lastResult   = null;
  let lastResultAt = 0;     // timestamp of when lastResult was set
  let currentRunId = 0;
  let runPending   = false; // true while a run() is in flight
  let runStartedAt = 0;     // timestamp, used to detect a stuck/stale run

  async function run(type, id) {
    const runId = ++currentRunId;
    runPending     = true;
    runStartedAt   = Date.now();
    userDismissed  = false;
    lastResult     = null;
    lastResultAt   = 0;
    widgetExpanded = false;
    hoursFetched   = false;
    dsoRecord      = null;
    renderLoading();
    LOG(`Running check — type=${type === OT_CONTACT ? "Contact" : "Company"}, id=${id}`);

    try {
      let matches = [];
      let curForHours = null; // record data handed to the hours check after render

      if (type === OT_CONTACT) {
        const cur = await fetchCurrentRecord(OT_CONTACT, CONTACT_PROPS, id);
        if (runId !== currentRunId) return;
        // No data (transient) — remove widget so the watchdog re-runs shortly.
        if (!cur) { LOG("No record data yet — watchdog will retry"); removeWidget(); return; }
        curForHours = cur;
        const linkedCustomer = await checkLinkedCompanyCustomer(cur.associatedcompanyid, cur.company);
        if (runId !== currentRunId) return;
        if (linkedCustomer) {
          // Contact is already at a customer company — no need to surface other dupes
          matches = [linkedCustomer];
        } else {
          const [coMatches, ctMatches] = await Promise.all([
            findUnlinkedCompanies(cur),
            findDuplicateContacts(cur),
          ]);
          if (runId !== currentRunId) return;
          matches = [...coMatches, ...ctMatches];
        }

      } else if (type === OT_COMPANY) {
        const cur = await fetchCurrentRecord(OT_COMPANY, COMPANY_PROPS, id);
        if (runId !== currentRunId) return;
        if (!cur) { LOG("No record data yet — watchdog will retry"); removeWidget(); return; }
        curForHours = cur;
        const dupeMatches = await findDuplicateCompanies(cur);
        if (runId !== currentRunId) return;
        // If this company is itself a customer, prepend a self-customer marker
        if (isCustomer(cur)) {
          matches = [{
            objectType: OT_COMPANY,
            name: cur.name || "(no name)",
            meta: [cur.phone, cur.domain || cur.website, cur.state].filter(Boolean).join(" · "),
            href: recordUrl(OT_COMPANY, cur.id),
            typeLabel: "Company · CUSTOMER",
            reasons: ["this is a Pearl customer"],
            strong: true, customer: true, linkedCustomer: true, selfRecord: true,
          }, ...dupeMatches];
        } else {
          matches = dupeMatches;
        }
      }

      if (runId !== currentRunId) return;
      LOG(`Duplicate check refreshed — ${matches.length} match(es):`, matches.map((m) => `${m.typeLabel} "${m.name}" [${m.reasons.join(", ")}]`));
      lastResult = { matches };
      lastResultAt = Date.now();
      dsoRecord = curForHours; // set before render so updateDsoPill() can read it
      render(matches);
      // Widget is on screen — now look up their business hours in the background
      if (curForHours) checkBusinessHours(curForHours).catch((e) => LOG("hours check error:", e.message));
    } catch (e) {
      if (runId !== currentRunId) return;
      console.warn("[Pearl Dupe Checker] Error:", e);
      // Leave lastResult null so the watchdog re-runs on its next tick.
      removeWidget();
    } finally {
      // CRITICAL: only the current run owns the flag.
      if (runId === currentRunId) runPending = false;
    }
  }

  // ── SPA navigation detection + watchdog ───────────────────────────────────

  function getRecordInfo() {
    const m = location.pathname.match(/\/record\/(0-[12])\/(\d+)|\/contact\/(\d+)/);
    if (!m) return null;
    if (m[3]) return { type: OT_CONTACT, id: m[3] };
    return { type: m[1], id: m[2] };
  }

  // Patch pushState AND replaceState — HubSpot uses both for SPA navigation.
  (function patchHistory() {
    function fire() { window.dispatchEvent(new Event("pdc:nav")); }
    const origPush    = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState    = function (...a) { origPush(...a);    fire(); };
    history.replaceState = function (...a) { origReplace(...a); fire(); };
    window.addEventListener("popstate", fire);
  })();

  let lastKey = null;
  const STALE_RUN_MS = 20000; // a run still "pending" past this is considered dead

  function checkLocation(reason) {
    try {
      // Safety net: if a run somehow stayed "pending" too long (network hang,
      // unhandled path), force-clear it so the watchdog isn't stuck forever.
      if (runPending && Date.now() - runStartedAt > STALE_RUN_MS) {
        LOG("Stale run detected — clearing runPending so watchdog can recover");
        runPending = false;
      }

      const info = getRecordInfo();
      const key  = info ? `${info.type}:${info.id}` : null;

      if (key !== lastKey) {
        // URL changed — reset everything and run fresh check
        lastKey = key;
        lastResult = null;
        lastResultAt = 0;
        widgetExpanded = false;
        LOG(`HubSpot URL changed → ${key || "(no record)"}${reason ? ` [${reason}]` : ""}`);
        if (info) run(info.type, info.id);
        else removeWidget();
        return;
      }

      if (!key || userDismissed) return;

      const widgetEl = document.getElementById(WIDGET_ID);
      if (widgetEl) return; // already present, nothing to do

      // Cache expires after 60 seconds — force a fresh check if user links/unlinks during that window
      const cacheExpired = lastResult && Date.now() - lastResultAt > 60000;

      if (lastResult && !cacheExpired) {
        // Widget was removed by HubSpot React re-render — reattach cached data
        LOG("Panel missing, reinjecting");
        render(lastResult.matches);
      } else if (!runPending) {
        // Widget gone, no cached result, cache expired, or no run in flight — re-run the check
        if (cacheExpired) LOG("Cached result expired — re-running duplicate check");
        else LOG("Panel missing, reinjecting — re-running duplicate check");
        run(info.type, info.id);
      }
    } catch (e) {
      // Never let a watchdog tick throw — that would silently kill recovery.
      console.warn("[Pearl Dupe Checker] watchdog tick error:", e);
    }
  }

  // Fire on SPA navigation events
  window.addEventListener("pdc:nav", () => checkLocation("nav"));

  // Re-check when tab becomes visible again (fixes idle/background tab issue)
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      LOG("Tab became visible — checking location");
      checkLocation("visibilitychange");
    }
  });

  // Re-check when the window regains focus (user clicks back into the tab)
  window.addEventListener("focus", () => checkLocation("focus"));

  // Re-check on bfcache restore (back/forward navigation can restore a frozen
  // page whose timers were paused while it sat idle).
  window.addEventListener("pageshow", () => checkLocation("pageshow"));

  // Polling fallback every 3 seconds — catches anything events missed.
  setInterval(() => checkLocation("interval"), 3000);

  LOG("Pearl Dupe Checker initialized — portal:", PORTAL_ID);
  checkLocation("init");

})();
