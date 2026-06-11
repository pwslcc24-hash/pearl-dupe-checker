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
  function isCustomer(co) {
    if (norm(co.lifecyclestage) === "customer") return true;
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
      const active = !!(co.hs_last_activity_date);
      const meta = [co.phone, co.domain || co.website, co.state].filter(Boolean).join(" · ");
      acc.push({ objectType: OT_COMPANY, name: co.name || "(no name)", meta, href: recordUrl(OT_COMPANY, co.id), typeLabel: customer ? "Company · CUSTOMER" : "Company", reasons, strong, active, customer });
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
      const active = !!(cand.hs_last_activity_date);
      acc.push({ objectType: OT_CONTACT, name: `${cand.firstname || ""} ${cand.lastname || ""}`.trim() || cand.email || "(no name)", meta: [cand.email, cand.phone, cand.company].filter(Boolean).join(" · "), href: recordUrl(OT_CONTACT, cand.id), typeLabel: "Contact", reasons, strong, active, customer: false });
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
      const active = !!(cand.hs_last_activity_date);
      acc.push({ objectType: OT_COMPANY, name: cand.name || "(no name)", meta: [cand.phone, cand.domain || cand.website].filter(Boolean).join(" · "), href: recordUrl(OT_COMPANY, cand.id), typeLabel: customer ? "Company · CUSTOMER" : "Company", reasons, strong, active, customer });
      return acc;
    }, []).sort((a, b) => b.customer !== a.customer ? (b.customer ? 1 : -1) : (b.strong === a.strong ? 0 : b.strong ? 1 : -1));
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  const LS_POS = "pdc:pos2"; // v2 — uses top instead of bottom

  function loadPos()     { try { return JSON.parse(localStorage.getItem(LS_POS)); } catch (e) { return null; } }
  function savePos(r, t) { try { localStorage.setItem(LS_POS, JSON.stringify({ right: r, top: t })); } catch (e) {} }

  // ── Widget state ───────────────────────────────────────────────────────────

  let widgetExpanded = false; // always start collapsed; only true after user explicitly opens

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
    if (pos) { el.style.right = Math.max(4, pos.right) + "px"; el.style.top = Math.max(4, pos.top) + "px"; }
  }
  function makeDraggable(wrap, handle) {
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest(".pdc-btn")) return;
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
    const isInactiveStrong    = m.strong && m.active === false;
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
    const activeStrongDupes   = strongDupes.filter((m) => m.active !== false); // has activity → red
    const inactiveStrongDupes = strongDupes.filter((m) => m.active === false);  // no activity → amber
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
    } else {
      // Priority 4: clean — name-only overlaps don't change the badge color
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

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "pdc-btn pdc-toggle";
    toggleBtn.title = "Expand / collapse";
    toggleBtn.textContent = collapsed ? "▸" : "▾";

    const refreshBtn = document.createElement("button");
    refreshBtn.className = "pdc-btn pdc-refresh";
    refreshBtn.title = "Re-check now";
    refreshBtn.textContent = "↺";

    const closeBtn = document.createElement("button");
    closeBtn.className = "pdc-btn pdc-close";
    closeBtn.title = "Dismiss";
    closeBtn.textContent = "×";

    controls.append(refreshBtn, toggleBtn, closeBtn);
    head.appendChild(controls);
    wrap.appendChild(head);

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

    // ── Collapse toggle ──
    function setCollapsed(v) {
      widgetExpanded = !v;
      wrap.classList.toggle("pdc-collapsed", v);
      toggleBtn.textContent = v ? "▸" : "▾";
      body.style.display = v ? "none" : "";
    }
    head.addEventListener("click", (e) => { if (!e.target.closest(".pdc-btn")) setCollapsed(!wrap.classList.contains("pdc-collapsed")); });
    toggleBtn.addEventListener("click", (e) => { e.stopPropagation(); setCollapsed(!wrap.classList.contains("pdc-collapsed")); });

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
    renderLoading();
    LOG(`Running check — type=${type === OT_CONTACT ? "Contact" : "Company"}, id=${id}`);

    try {
      let matches = [];

      if (type === OT_CONTACT) {
        const cur = await fetchCurrentRecord(OT_CONTACT, CONTACT_PROPS, id);
        if (runId !== currentRunId) return;
        // No data (transient) — remove widget so the watchdog re-runs shortly.
        if (!cur) { LOG("No record data yet — watchdog will retry"); removeWidget(); return; }
        const [linkedCustomer, coMatches, ctMatches] = await Promise.all([
          checkLinkedCompanyCustomer(cur.associatedcompanyid, cur.company),
          findUnlinkedCompanies(cur),
          findDuplicateContacts(cur),
        ]);
        if (runId !== currentRunId) return;
        // Linked company customer check goes first — highest priority
        matches = [...(linkedCustomer ? [linkedCustomer] : []), ...coMatches, ...ctMatches];

      } else if (type === OT_COMPANY) {
        const cur = await fetchCurrentRecord(OT_COMPANY, COMPANY_PROPS, id);
        if (runId !== currentRunId) return;
        if (!cur) { LOG("No record data yet — watchdog will retry"); removeWidget(); return; }
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
      render(matches);
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
