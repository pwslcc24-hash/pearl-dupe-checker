/*
 * Pearl Dupe Checker — content script
 *
 * Runs on HubSpot Contact (/record/0-1/), Company (/record/0-2/), and Deal
 * (/record/0-3/) records, plus Lead (0-136) previews opened from the Leads list.
 * Detects SPA navigation via history.pushState override + polling fallback.
 *
 * Contact page checks:
 *   1. Unlinked company matches (catches "about to call a customer")
 *   2. Duplicate contacts (same email/phone, different company)
 *      — contacts sharing the same linked company are NOT flagged (normal)
 *
 * Company page checks:
 *   1. Duplicate company records (same name/phone/domain)
 *
 * Deal/Lead checks:
 *   Deals and Leads don't carry their own name/phone/domain, so both resolve to
 *   their associated Company (read straight off the page's own "Companies"
 *   association card — same data HubSpot already shows a human) and then run
 *   the identical Company checks against that id. Leads have no full-page URL
 *   at all (HubSpot only ever shows them in a slide-out Preview panel on the
 *   Leads list), so they're detected by watching for that panel instead of a
 *   URL change.
 */
(function () {
  "use strict";

  const VERSION = (chrome.runtime?.getManifest?.() || {}).version || "?";
  const LOG = (...a) => console.log(`[Pearl Dupe Checker v${VERSION}]`, ...a);
  LOG("loaded");

  // Admin build flag — flipped to `true` only in the separate admin zip
  // (build_admin.sh). When on, every badge/pill's hover tooltip shows the
  // exact logic + real field values that produced it, instead of the short
  // rep-facing text. Never true in the version shipped to the sales team.
  const ADMIN_MODE = false;

  const OT_CONTACT = "0-1";
  const OT_COMPANY = "0-2";
  const OT_DEAL    = "0-3";
  const OT_LEAD    = "0-136";
  const PORTAL_ID  = location.pathname.split("/")[2] || "";

  const CONTACT_PROPS = [
    "firstname", "lastname", "email", "phone",
    "company", "associatedcompanyid", "hubspot_owner_id",
    "lifecyclestage", "hs_lead_status", "state",
    "hs_last_activity_date", // used to detect if record has been worked
    "notes_last_updated",    // fallback: hs_last_activity_date is often empty
    "number_of_associated_open_deals", // ROE: owner + open deal(s) = don't poach
    "demo_completed_date",              // ROE: "Completed Demo within ROE" — 30-day window
    "most_recent_demo_request_date",   // ROE: recent inbound demo = inbound is handling it
    "hs_latest_disqualified_lead_date", // ROE: 60-day disqualify-recycle cooldown
    "notes_next_activity_date", // ROE: future task within 14 days — extends demo-completed window past 30 days
    // Compat-check fields — Contact carries its OWN imaging/PMS answers
    // (e.g. from a form fill), separate from the linked Company's. Note the
    // portal uses a DIFFERENT internal name for imaging on Contact vs.
    // Company (imaging_software_new vs. imaging_software) for what's the
    // same concept — aliased onto `imaging_software` right after fetch (see
    // below) so compatCheck() can read one consistent field name regardless
    // of object type. PMS's internal name happens to already match Company's.
    "imaging_software_new",
    "practice_management_system__cloned_",
  ];
  const COMPANY_PROPS = [
    "name", "phone", "domain", "website", "hubspot_owner_id", "state", "city",
    "lifecyclestage", "hs_latest_deal_stage",
    "products", "pearl_products", "active_products", "current_products",
    "products_based_on_associated_deals", // deal-derived product list — catches products not in the free-text "products" field
    "number_of_second_opinion_applications", "number_of_practice_intelligence_applications",
    "number_of_precheck_applications", "number_of_voice_applications", // per-product app counts: >0 = they have it
    "onboarding_status",      // "Cancelled"/"Reversing" = signed up but never onboarded (reversed)
    "location_status",        // enum: Active/Paused/Inactive/Parent/... — the REAL "Account Status" field (internal name "account_status" doesn't exist in this portal)
    "customer_status", "csm_owner", "subscription_status",
    "hs_parent_company_id",   // used to detect parent/child/sibling relationships
    "hs_last_activity_date",  // used to detect if record has been worked
    "notes_last_updated",     // fallback: company-level notes/activity date
    "notable_status",         // "Enterprise (DSO)", "Multi-office", "KOL"
    "primary_segment",        // "Domestic - Enterprise" / "Domestic - SMB"
    "number_of_locations",    // Pearl custom — integer, 10+ = enterprise DSO territory
    "previously_reversed_deal", // "Yes" when an associated Deal went Closed Won then back to Closed Lost (deal-stage-history rollup)
    "recent_deal_close_date",  // date of the company's last CLOSED WON deal — used to confirm lifecyclestage=customer isn't stale when previously_reversed_deal=Yes
    "number_of_open_reversal_tickets", // ticket-history rollup — open reversal/cancellation tickets
    "number_of_associated_open_deals", // ROE: owner + open deal(s) = don't poach
    "notes_next_activity_date", // ROE: future task within 14 days — extends demo-completed window past 30 days
    "hs_last_open_task_date",   // ROE: due date of the last OPEN task — >24h overdue + no contact 14d+ = free game
    "onboarding_complete_date", // ROE: AE has priority for 90 days from onboarding completion (not deal close date)
    "number_of_associated_closed_won_deals", // ROE: onboarding-priority only applies to the FIRST closed-won deal — a repeat/expansion customer's later re-onboarding shouldn't reset the clock
    "deal_owner_of_most_recent_closed_deal", // ROE: the specific AE who gets priority — only unambiguous because of the closed_won===1 gate above (their most recent closed-won deal IS their first)
    "imaging_software",         // enum — drives SO/PI upsell-compatibility signal
    "practice_management_system__cloned_", // enum, label "Practice Management System" — drives PI/RCM/Voice compatibility
    "native",                   // "Yes"/"No" — picks the native-vs-standalone compatibility row where the sheet splits on it
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

  // Phone numbers that are NOT practice-specific — never use for duplicate
  // matching. Found via a HubSpot GROUP BY phone, COUNT(*) query (2026-08-21)
  // that surfaced numbers shared across dozens to hundreds of companies. Two
  // kinds, both handled the same way here: (1) obvious junk/test data (a
  // well-known placeholder number, internal QA sandbox records), (2) real
  // numbers legitimately shared by many distinct DSO locations — a shared
  // corporate switchboard, not a per-practice line. The existing DSO badge
  // (detectDso — notable_status/number_of_locations) already flags
  // multi-location accounts separately, so suppressing the phone match here
  // doesn't lose that signal, it just stops it from being misread as one
  // company duplicated many times. Re-run the same query if a new shared
  // number starts causing false "likely duplicate" flags.
  const GENERIC_PHONES = new Set([
    "4258828080", // well-known placeholder (a large tech company's switchboard) — 10 unrelated junk/test records
    "4142945870", // internal QA/sandbox test data ("Office1"/"Office2" in "ShinyPearl"/"BlackPearl")
    "7148458500", // shared corporate line — multi-brand DSO chain, 312 real but distinct locations
    "4083493300", // shared corporate line, 22 companies
    "8007825150", // shared toll-free line, 19 companies
    "8137260350", // shared corporate line, 13 companies
    "2039057800", // shared corporate line, 10 companies
    "2314371272", // shared corporate line, 23 companies
    "1231231234", // placeholder pattern (repeating "123")
  ]);
  // Obvious junk patterns (all digits the same, or strictly sequential) —
  // catches future placeholder numbers automatically, no new entry needed.
  function isJunkPhonePattern(digits) {
    if (/^(\d)\1{9}$/.test(digits)) return true; // "1111111111", "5555555555", etc.
    let ascending = true, descending = true;
    for (let i = 1; i < digits.length; i++) {
      const diff = (Number(digits[i]) - Number(digits[i - 1]) + 10) % 10;
      if (diff !== 1) ascending = false;
      if (diff !== 9) descending = false;
    }
    return ascending || descending; // "0123456789", "9876543210", etc.
  }
  function isGenericPhone(digits) {
    return !digits || GENERIC_PHONES.has(digits) || isJunkPhonePattern(digits);
  }

  function normName(s) {
    return norm(s)
      .replace(/\b(llc|inc|corp|ltd|dds|dmd|pa|pc|pllc|dental|dentistry|group|associates|practice)\b/g, "")
      .replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  }
  // Customer = lifecyclestage says "Customer", OR the account is confirmed
  // Active. Products are deliberately NOT part of this determination — a
  // products field can be set on a prospect being scoped, or on an account
  // that signed but never went live (see isReversed below), so it's too weak
  // a signal for "is this a real customer." Products only come into play
  // AFTER customer status is settled, to show what they already own for
  // upsell purposes (see the product-pill rendering in render()).
  //
  // An explicit `location_status = Inactive` overrides a "Customer"
  // lifecycle stage — that combination means the account was provisioned as
  // a customer but has since been marked inactive, i.e. churned (see
  // isFormerCustomer below), not a currently-active customer.
  // Single source of truth for the isCustomer decision AND its admin-mode
  // explanation — kept as one function so the two can never drift apart.
  function isCustomerWithReason(co) {
    if (!co) return { result: false, reason: "no record data" };
    if (norm(co.location_status) === "inactive") return { result: false, reason: `location_status="${co.location_status}" (Inactive overrides everything else) → not a customer` };
    if (norm(co.lifecyclestage) === "customer") {
      // lifecyclestage="customer" alone isn't trustworthy when
      // previously_reversed_deal="Yes" contradicts it — checked against real
      // data (2026-08-21): of 1,049 companies with both, only 385 (37%) had
      // any real product usage, and every one of those 385 also had a real
      // recent_deal_close_date. The other 664 had neither — stale/wrong
      // "customer" labels. So require an actual closed-won deal on record
      // before trusting "customer" in that specific contradiction case.
      const reversedFlag = norm(co.previously_reversed_deal) === "yes";
      const hasClosedWon = !!(co.recent_deal_close_date && String(co.recent_deal_close_date).trim());
      if (reversedFlag && !hasClosedWon) {
        return { result: false, reason: `lifecyclestage="customer" but previously_reversed_deal="Yes" AND recent_deal_close_date is blank (no confirmed closed-won deal) → not trusted as customer, falls through to the reversed check` };
      }
      return { result: true, reason: `lifecyclestage="customer"${reversedFlag ? ` (previously_reversed_deal="Yes", but recent_deal_close_date="${co.recent_deal_close_date}" confirms a real deal)` : ""} → customer` };
    }
    if (norm(co.location_status) === "active") return { result: true, reason: `location_status="${co.location_status}" → customer` };
    return { result: false, reason: `lifecyclestage="${co.lifecyclestage || "(blank)"}" (not "customer") and location_status="${co.location_status || "(blank)"}" (not "active") → not a customer` };
  }
  function isCustomer(co) { return isCustomerWithReason(co).result; }
  function explainIsCustomer(co) { return isCustomerWithReason(co).reason; }

  // Ex-customer = "Cancelled customer — could win back." `location_status`
  // is the real "Account Status" field (the internal name "account_status"
  // doesn't actually exist in this portal — was silently dead code before).
  function isFormerCustomerWithReason(co) {
    if (!co || norm(co.location_status) !== "inactive") {
      return { result: false, reason: `location_status="${co ? (co.location_status || "(blank)") : "(no record)"}" (must be "Inactive" to even consider ex-customer) → no` };
    }
    // Was provisioned as a customer per lifecycle, account is now inactive —
    // a real cancellation, not a stale flag (location_status has proven
    // reliable everywhere else this session, so it's trusted here too).
    if (norm(co.lifecyclestage) === "customer") {
      return { result: true, reason: `location_status="Inactive" + lifecyclestage="customer" → ex-customer (churned)` };
    }
    // Lifecycle already got reset off "customer" after churn — fall back to
    // product history proving they used to be one.
    const productFields = { products: co.products, pearl_products: co.pearl_products, active_products: co.active_products, current_products: co.current_products };
    const hit = Object.entries(productFields).find(([, v]) => v && v.trim());
    if (hit) {
      return { result: true, reason: `location_status="Inactive", lifecyclestage="${co.lifecyclestage || "(blank)"}" (not "customer"), but ${hit[0]}="${hit[1]}" is set → ex-customer (product history proves they used to be one)` };
    }
    return { result: false, reason: `location_status="Inactive" but lifecyclestage="${co.lifecyclestage || "(blank)"}" (not "customer") and no product field (products/pearl_products/active_products/current_products) is set → no` };
  }
  function isFormerCustomer(co) { return isFormerCustomerWithReason(co).result; }
  function explainIsFormerCustomer(co) { return isFormerCustomerWithReason(co).reason; }

  // "Reversed" = signed a deal that later got walked back — never a live,
  // stable customer. Distinct from a currently-active customer (isCustomer)
  // and from a churned ex-customer who WAS live (isFormerCustomer) — those
  // two are checked first and take priority. What's left relies only on
  // explicit, hard signals — no guessing from products/usage-counts/Stripe
  // data, which is exactly what caused real customers (American Dental
  // Systems) to get misclassified reversed before. Trade-off: an account
  // with genuinely no owner-set signal at all (no reversed-deal flag, no
  // reversal ticket, no onboarding_status) won't be caught — accepted, since
  // that's better than false-flagging real customers.
  const REVERSED_ONBOARDING = new Set(["cancelled", "reversing"]);
  function isReversedWithReason(co) {
    if (!co) return { result: false, reason: "no record data" };
    const custom = isCustomerWithReason(co);
    if (custom.result) return { result: false, reason: `isCustomer=true (${custom.reason}) → not reversed, they're an active customer` };
    // Two signals of live current interest override any historical reversal
    // flag (confirmed bug: a brand new inbound deal was showing REVERSED
    // because of old company history): a currently OPEN deal (a new deal
    // cycle has started, whatever happened to the old one is moot), or a
    // recent inbound demo request (contact-level only in this portal).
    const openDeals = parseInt(co.number_of_associated_open_deals || "0", 10) || 0;
    if (openDeals > 0) return { result: false, reason: `number_of_associated_open_deals=${openDeals} (>0, a new deal cycle is active) → not reversed` };
    const demoReqMs = withinWindowMs(co.most_recent_demo_request_date, ROE_DEMO_REQUEST_WINDOW_MS);
    if (demoReqMs) return { result: false, reason: `most_recent_demo_request_date="${co.most_recent_demo_request_date}" (within ${Math.round(ROE_DEMO_REQUEST_WINDOW_MS / 86400000)} days) → not reversed, treated as live interest` };
    // onboarding_status and an OPEN reversal ticket are specific, current
    // signals that THIS account never went live — checked before
    // isFormerCustomer so they aren't masked by its inactive+has-products
    // churn heuristic (confirmed bug: Georgeann C. Vargas had
    // onboarding_status=Reversing but showed EX-CUSTOMER instead, because it
    // also had location_status=Inactive + leftover product data from the
    // reversed onboarding).
    if (REVERSED_ONBOARDING.has(norm(co.onboarding_status || ""))) {
      return { result: true, reason: `onboarding_status="${co.onboarding_status}" → reversed` };
    }
    const openTickets = parseInt(co.number_of_open_reversal_tickets || "0", 10) || 0;
    if (openTickets > 0) return { result: true, reason: `number_of_open_reversal_tickets=${openTickets} (>0) → reversed` };
    // previously_reversed_deal is a lifetime company rollup with no attached
    // date — could be from before OR after a genuine customer relationship,
    // so a real past customer (isFormerCustomer) still wins over it.
    const former = isFormerCustomerWithReason(co);
    if (former.result) return { result: false, reason: `isFormerCustomer=true (${former.reason}) → treated as ex-customer, not reversed` };
    if (norm(co.previously_reversed_deal) === "yes") {
      return { result: true, reason: `previously_reversed_deal="Yes" (no current signal contradicts it) → reversed` };
    }
    return { result: false, reason: `no reversed signal found — onboarding_status="${co.onboarding_status || "(blank)"}", number_of_open_reversal_tickets=${openTickets}, previously_reversed_deal="${co.previously_reversed_deal || "(blank)"}" → not reversed` };
  }
  function isReversed(co) { return isReversedWithReason(co).result; }
  function explainIsReversed(co) { return isReversedWithReason(co).reason; }

  // ── ROE (Rules of Engagement) caution ─────────────────────────────────────
  // Ported from the SDR agent's roe_enforcer.py — flags accounts that look
  // like someone is actively working them, so a rep doesn't step on it.
  // Doesn't try to determine "is the owner ME" (the extension has no reliable
  // way to know which teammate is using it) — just surfaces who owns it and
  // their most recent signal; the viewing rep judges for themselves.
  //
  // Owner id → name, baked in from the `hubspot_owner_id` property's own enum
  // options (the portal's official owner list) — same approach as the
  // Imaging/PMS compatibility tables. Re-sync if the sales team roster changes.
  const OWNER_NAMES = {
    "4949497": "Brandon Trevino", "36407764": "Régis Guillermin", "36949312": "Ophir Tanz",
    "47539501": "Josh Silverbauer", "50231797": "Nick Garrison", "60727228": "Omar Villegas",
    "62219014": "Frank Devine", "63439000": "Laura Alvarez", "64497903": "Neiel Urbano",
    "64566177": "Sam Hogg", "64781574": "Matt Ceran", "68287364": "Cristhian Lunardi",
    "74421341": "Chris Taylor", "75559357": "Logan Baker", "75559358": "Payton Clayson",
    "75635423": "Chandra Simms", "76348092": "Gad Sakin", "76769946": "Compliance Compliance",
    "76804340": "Plandent Norway", "76804367": "Plandent Finland", "76804536": "Plandent Denmark",
    "76804544": "Plandent Germany", "76804548": "Plandent Sweden", "76804555": "Unident Dental",
    "77007228": "Ty Armstrong", "77273426": "Cason Clarke", "77551641": "Kody Davis",
    "77591895": "Sarah Parker", "78033849": "Tab Thirty-Two", "78129569": "Tyler Crump",
    "78402046": "Bari Stern", "78694853": "Stephen Randall", "78869608": "Kana Makuakane",
    "78893024": "Laura Jeyaseelan", "78942046": "Brianne Adams", "79032738": "Lexee Cheney",
    "79054674": "Nicolas Balladares", "79110087": "Plandent Iceland", "79190747": "Matthew Larsen",
    "79254842": "Pearl", "79364751": "Joseph Britt", "79364752": "Esther Dorsey",
    "79370229": "Christian Hawkins", "79527250": "Mia Pecek", "79910839": "Aali Rehman",
    "79958839": "Ronald So", "80338024": "Sarah Schuhmacher", "80592157": "Kaladent Dental",
    "80652203": "Price Change", "80684835": "Nicolas", "715298350": "Ethan Sherman",
  };
  function ownerName(id) { return OWNER_NAMES[String(id || "")] || ""; }

  // Porter, 2026-09-03: the AE who closed/onboarded an account has priority
  // for 90 days — the clock starts at ONBOARDING COMPLETION (onboarding_complete_date,
  // seen on the onboarding ticket and rolled up to the Company), not the deal
  // close date. This is the main ROE flag when it applies — checked first in
  // checkRoe() below, ahead of every other signal (still yields to the
  // 24h-overdue-task "all rules go out the window" exception).
  const ROE_ONBOARDING_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
  const ROE_DEMO_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;         // completed demo / upcoming meeting
  const ROE_DISQUALIFIED_WINDOW_MS = 60 * 24 * 60 * 60 * 1000; // 60-day recycle
  const ROE_DEMO_REQUEST_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
  const ROE_CLOSED_LOST_COOLDOWN_MS = 60 * 24 * 60 * 60 * 1000; // don't contact within 60 days of Closed Lost, unless Neglected
  // PDF: "If there is activity following the 30 days and a future task
  // within 14 days the account can remain with the AE" — same 14-day span
  // used for the overdue-task free-game rule below.
  const ROE_FOLLOWUP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
  // PDF (SDR): "If a follow-up task is more than 24 Hours overdue, and there
  // has been no contact in more than two weeks, that lead is free game."
  // PDF (AE): "Within 24 hours of an overdue task - all rules go out the
  // window when no demo has been set or completed by that rep." Only a
  // Company record exposes the open-task-due-date rollup (hs_last_open_task_date
  // doesn't exist on Contact) — so this only fires where that data exists.
  const ROE_OVERDUE_TASK_GRACE_MS = 24 * 60 * 60 * 1000;

  // HubSpot's internal search API serializes plain "Date" properties (no
  // time-of-day, e.g. onboarding_complete_date) as a raw epoch-MILLISECOND
  // string ("1782691200000") — `new Date()` on that string alone returns
  // Invalid Date (confirmed via real browser console, 2026-09-03: this
  // silently broke the onboarding-priority ROE rule for a real account).
  // "DateTime" properties come back as normal ISO strings and parse fine
  // either way. Every raw HubSpot date value in this file should go through
  // this, not a bare `new Date(...)`, to be safe regardless of property type.
  function parseHsDate(v) {
    if (v == null || v === "") return NaN;
    const s = String(v).trim();
    return /^\d+$/.test(s) ? Number(s) : new Date(s).getTime();
  }

  // PDF: >24h-overdue open task + no contact in the last 14 days = "all
  // rules go out the window" for that record — checkRoe() should return
  // nothing at all. Deliberately conservative: missing task/contact data
  // never triggers this (absence of data isn't evidence of "free game").
  function roeOverdueTaskFreeGame(co) {
    if (!co || !co.hs_last_open_task_date) return false;
    const dueMs = parseHsDate(co.hs_last_open_task_date);
    if (!dueMs || Date.now() - dueMs < ROE_OVERDUE_TASK_GRACE_MS) return false;
    const lastContact = co.hs_last_activity_date || co.notes_last_updated;
    const lastContactMs = lastContact ? parseHsDate(lastContact) : null;
    if (!lastContactMs) return false;
    return Date.now() - lastContactMs >= ROE_FOLLOWUP_WINDOW_MS;
  }

  // `dealstage` is a per-pipeline enum — the SAME stage name ("Contract
  // Sent", "Closed lost", etc.) has a DIFFERENT raw id in every pipeline, so
  // matching by id directly isn't possible. Baked in from the property's own
  // enum options across every pipeline in this portal (same approach as
  // OWNER_NAMES/compatibility tables) — re-sync if a pipeline is added/changed.
  const DEALSTAGE_LABELS = {
    qualifiedtobuy: "Qualified to buy", presentationscheduled: "Demo Scheduled",
    "67162484": "No Show/Reschedule", "2106867": "Follow-up to Close", contractsent: "Contract sent",
    "46380623": "Sale Pending", "32526356": "Freemium", closedwon: "Closed won",
    "1086484865": "Inactive Holding", "39685786": "Billing Change", closedlost: "Closed lost",
    "14673937": "Pre-Pilot", "14673938": "Pilot", "14673939": "Expansion Contract Sent",
    "14673940": "Renewal Contract Sent", "14673942": "Closed won", "14673943": "Closed lost",
    "103334066": "Billing Change", "1086484873": "Inactive Holding", "15595952": "Qualified to Buy",
    "121722790": "Demo Scheduled", "121722791": "No Show/Reschedule", "15595953": "Follow-up to Close",
    "15595955": "Contract Sent", "121722792": "Sale Pending", "121722793": "Freemium",
    "15595956": "Closed won", "1086534415": "Inactive Holding", "121722794": "Billing Change",
    "15595957": "Closed lost", "13029964": "Qualified to buy", "13029965": "Demo Scheduled",
    "67211858": "No Show/Reschedule", "13029966": "Follow-up to Close", "13029967": "Contract Sent",
    "47703091": "Sale Pending", "13029968": "Closed won", "32912801": "Free Trial",
    "1086525496": "Inactive Holding", "39657305": "Billing Change", "13029969": "Closed lost",
    "21904129": "Inbound Lead", "222985378": "Engaged Prospect", "1231124004": "Demo Scheduled",
    "1299015836": "Actively Working", "21904130": "Best Case (This Quarter)",
    "1299015837": "Best Case (Next Quarter)", "21904131": "Commit (This Quarter)",
    "48843958": "Deal Signed", "21904133": "Closed won",
  };
  function dealStageLabel(id) { return DEALSTAGE_LABELS[String(id || "")] || ""; }
  function normStage(s) { return norm(s).replace(/[^a-z]/g, ""); } // "Follow-up to Close" -> "followuptoclose"
  // Inbound AEs (roe_enforcer.py's INBOUND_TEAM_NAMES) — owned-by-them means
  // it came in inbound and that AE is already handling it, don't poach.
  const ROE_INBOUND_TEAM = new Set([
    "branson lewis", "brody wright", "cameron forte", "chad tippets",
    "chase meyer", "colin anderson", "jace rogers", "jared povey",
    "joshua sharp", "justin rindt", "kaylee bott", "kyle lemperle", "matt larsen",
  ]);
  // Guards every date-window check below: requires the timestamp to be a
  // real, PAST date within the window — not just "less than N ms away",
  // which a bad/future-shifted timestamp would satisfy trivially. This is
  // also what fixes a confirmed bug: a lifecycle-stage-only trigger (no date
  // check at all) was flagging a record whose real activity was a year old.
  function withinWindowMs(dateVal, windowMs) {
    if (!dateVal) return null;
    const ms = parseHsDate(dateVal);
    const diff = Date.now() - ms;
    if (!ms || diff < 0 || diff >= windowMs) return null;
    return ms;
  }

  // Rule set per Colin's ROE spec (Slack, 2026-08-09) — no more lifecycle-
  // stage-only triggers ("Active opportunity/SQL/MQL" used to fire with zero
  // regard for how old the record was). Fast — uses data already fetched via
  // the API, so it applies to duplicate match cards too.
  // Standalone (not just a branch inside checkRoe below) so updateRoePill()
  // can check it BEFORE the DOM-scraped call/meeting override too — this is
  // the main ROE flag when it applies, full stop, not just "first among the
  // rules inside checkRoe." A freshly-onboarded account's AE priority isn't
  // superseded by someone else scheduling a call with them. Still yields to
  // the 24h-overdue-task "all rules go out the window" exception.
  function checkRoeOnboardingPriority(co) {
    if (!co) return null;
    if (roeOverdueTaskFreeGame(co)) return null;
    const onboardMs = withinWindowMs(co.onboarding_complete_date, ROE_ONBOARDING_WINDOW_MS);
    if (!onboardMs) return null;
    // Porter, 2026-09-03: "only first closed won should trigger" — a repeat
    // customer's later expansion/renewal deal gets its own re-onboarding
    // ticket, which would refresh onboarding_complete_date without this being
    // a NEW account at all. Only trust the 90-day clock when this is their
    // one and only closed-won deal ever (their original signing).
    const closedWonCount = parseInt(co.number_of_associated_closed_won_deals || "0", 10) || 0;
    if (closedWonCount !== 1) return null;
    // Prefer the AE who actually owns the closed-won deal over the Company's
    // generic hubspot_owner_id (can be a different person — e.g. an SDR, or
    // stale reassignment). Only unambiguous because of the closed_won===1
    // gate above: their most recent closed-won deal IS their first.
    const ownerId = co.deal_owner_of_most_recent_closed_deal || co.hubspot_owner_id || "";
    const ownerLabel = ownerName(ownerId) || (ownerId ? "the assigned owner" : "");
    return { reason: `Onboarding completed ${new Date(onboardMs).toLocaleDateString()} (<90 days) — ${ownerLabel || "AE"} has priority`, severity: "red" };
  }

  function checkRoe(co) {
    if (!co) return null;
    const ownerId = co.hubspot_owner_id || "";
    const owner = ownerName(ownerId);
    // Roster table (OWNER_NAMES) is baked in and WILL go stale — an unmapped
    // id must still trigger owner-based rules below, just with a plainer label.
    const ownerLabel = owner || (ownerId ? "the assigned owner" : "");

    // PDF: 24h-overdue task + no contact in 14+ days = "all rules go out
    // the window" for this record — skip everything else below.
    if (roeOverdueTaskFreeGame(co)) return null;

    // Onboarding-priority is the main ROE flag when it applies — checked
    // first here too, so card-level checkRoe() calls (buildCard, etc.) get
    // the same answer as the header pill.
    const onboarding = checkRoeOnboardingPriority(co);
    if (onboarding) return onboarding;

    // "Completed Demo within ROE" — demo completed in the last 30 days.
    if (co.demo_completed_date) {
      const demoMs = parseHsDate(co.demo_completed_date);
      const sinceDemo = demoMs ? Date.now() - demoMs : null;
      if (sinceDemo != null && sinceDemo >= 0 && sinceDemo < ROE_DEMO_WINDOW_MS) {
        return { reason: `Completed demo ${new Date(demoMs).toLocaleDateString()}${ownerLabel ? ` — ${ownerLabel}` : ""}` };
      }
      // Past 30 days — PDF: stays with the AE if there's been activity after
      // the 30-day mark AND a future task within 14 days.
      if (sinceDemo != null && sinceDemo >= ROE_DEMO_WINDOW_MS) {
        const thirtyDayMark = demoMs + ROE_DEMO_WINDOW_MS;
        const lastActivity = co.hs_last_activity_date || co.notes_last_updated;
        const lastActivityMs = lastActivity ? parseHsDate(lastActivity) : null;
        const nextTaskMs = co.notes_next_activity_date ? parseHsDate(co.notes_next_activity_date) : null;
        const activeAfter30 = lastActivityMs && lastActivityMs > thirtyDayMark;
        const futureTaskSoon = nextTaskMs && nextTaskMs > Date.now() && nextTaskMs - Date.now() < ROE_FOLLOWUP_WINDOW_MS;
        if (activeAfter30 && futureTaskSoon) {
          return { reason: `Demo ${new Date(demoMs).toLocaleDateString()}, active since + task due ${new Date(nextTaskMs).toLocaleDateString()} — stays with ${ownerLabel || "owner"}` };
        }
      }
    }

    // Recent inbound demo request — restricted to inbound SDRs/senior AEs.
    const demoReqMs = withinWindowMs(co.most_recent_demo_request_date, ROE_DEMO_REQUEST_WINDOW_MS);
    if (demoReqMs) return { reason: `Inbound demo requested ${new Date(demoReqMs).toLocaleDateString()} — inbound SDRs/senior AEs only` };

    // Owned by an inbound-team AE. (Name-based match — can't do this by id
    // alone, ROE_INBOUND_TEAM is a name set.)
    if (owner && ROE_INBOUND_TEAM.has(norm(owner))) {
      return { reason: `${owner} (inbound team) — don't poach` };
    }
    // Owner + open deal(s) — fires on any assigned owner, whether or not
    // their id happens to be in the OWNER_NAMES roster table. Colin: "Flagged
    // as open deal but demo set date was over a month ago. This would be
    // fair game since there's no activity in the last 14 days" — an open
    // deal alone doesn't protect a record that hasn't actually been worked
    // recently, so this only fires if there's been activity in the last 14
    // days (no activity data at all also doesn't count as "recently worked").
    const openDeals = parseInt(co.number_of_associated_open_deals || "0", 10) || 0;
    if (ownerId && openDeals > 0) {
      const lastActivity = co.hs_last_activity_date || co.notes_last_updated;
      const lastActivityMs = lastActivity ? parseHsDate(lastActivity) : null;
      const recentlyWorked = lastActivityMs && Date.now() - lastActivityMs < ROE_FOLLOWUP_WINDOW_MS;
      if (recentlyWorked) {
        return { reason: `${ownerLabel} has ${openDeals} open deal${openDeals === 1 ? "" : "s"} — don't poach` };
      }
    }
    // Recently disqualified — 60-day recycle cooldown.
    const dqMs = withinWindowMs(co.hs_latest_disqualified_lead_date, ROE_DISQUALIFIED_WINDOW_MS);
    if (dqMs) return { reason: `Disqualified ${new Date(dqMs).toLocaleDateString()} (60-day recycle)` };

    return null;
  }

  const DEAL_PROPS = ["dealstage", "closed_lost___reason", "closedate", "dealname", "upcoming_demo_date"];

  // Deal-stage-aware ROE, per Colin's spec — only meaningful on an actual
  // Deal record (its own dealstage/closed_lost_reason/closedate aren't
  // available on the associated Company). A hard override: takes priority
  // over the DOM-scraped call/meeting signal, since the whole point of the
  // cooldown is "don't contact this even if something recent shows up."
  //   - Closed Lost, reason = Neglected → 48-HOUR cooldown (confirmed 3x in
  //     the official Rules of Engagement doc — NOT zero, as Colin's Slack
  //     shorthand ("original ROE stands") had first suggested).
  //   - Closed Lost, any other reason → 60-day cooldown from the close date.
  //   - Follow-up to Close / Contract Sent / Sale Pending / Qualified to Buy
  //     → no deal-specific override needed: these all resolve to checking
  //     the associated Company's activity, which the existing Deal → Company
  //     flow (runCompanyCheck) and the DOM-scraped call check already do.
  const ROE_NEGLECTED_COOLDOWN_MS = 48 * 60 * 60 * 1000;
  function checkRoeForClosedLostDeal(deal) {
    if (!deal) return null;
    const label = normStage(dealStageLabel(deal.dealstage));
    if (label !== "closedlost") return null;
    const reason = deal.closed_lost___reason || "";
    const isNeglected = norm(reason) === "neglected";
    const windowMs = isNeglected ? ROE_NEGLECTED_COOLDOWN_MS : ROE_CLOSED_LOST_COOLDOWN_MS;
    const ms = withinWindowMs(deal.closedate, windowMs);
    if (!ms) return null; // outside the cooldown — fair game again
    const cooldownLabel = isNeglected ? "48-hour cooldown" : "60-day cooldown";
    return { reason: `Closed lost ${new Date(ms).toLocaleDateString()} (${reason || "reason not set"}) — ${cooldownLabel}` };
  }

  // Colin: "Demo set date should be 14 days BEFORE the date the demo is
  // supposed to happen so assume if it's in demo scheduled 14 days AFTER
  // that it's stale and fair game." A deal can sit in "Demo Scheduled" long
  // after the actual appointment date has come and gone (no-show/reschedule
  // never logged) — 14+ days past that date with no stage movement means
  // the demo never happened and nothing protects it anymore. Unlike the
  // Closed Lost cooldown above, this is a SOFT signal: a genuine fresh call
  // or meeting found by the DOM scan can still override it (see
  // updateRoePill) — staleness just means the deal itself no longer counts.
  function checkRoeForStaleDemoScheduled(deal) {
    if (!deal) return false;
    const label = normStage(dealStageLabel(deal.dealstage));
    if (label !== "demoscheduled") return false;
    const demoMs = deal.upcoming_demo_date ? parseHsDate(deal.upcoming_demo_date) : null;
    if (!demoMs) return false; // no demo date on file — can't judge staleness, leave it alone
    return Date.now() - demoMs >= ROE_FOLLOWUP_WINDOW_MS;
  }

  // Fetches the raw linked-Company record (regardless of customer status) so
  // its own ROE signals (owner, open deals, etc.) can be checked too — per
  // Colin: "Always check the company for activity not JUST the contact."
  async function fetchLinkedCompanyForRoe(linkedId, companyName) {
    const curNormForId = companyName ? normName(companyName) : "";
    if (linkedId) {
      try {
        const rows = await hsSearch(OT_COMPANY, COMPANY_PROPS, [{ filters: [{ property: "hs_object_id", operator: "IN", values: [linkedId] }] }]);
        const co = rows.map(flatten)[0];
        // Don't blindly trust the id-resolved company if it doesn't even
        // match the contact's own "Company Name" text field — associatedcompanyid
        // can be a contact's PRIMARY association that HubSpot auto-set to a
        // generic domain-matched company (e.g. a personal .edu email pulling
        // in a junk "nyu" record) while their REAL practice is only a
        // secondary association. Confirmed real case, 2026-09-03: Ravinder
        // Samdhu's associatedcompanyid pointed at "nyu" (closed_won=0) while
        // his actual practice "Clarkson Village Dental Clinic" was only
        // findable by name. If there's no companyName to sanity-check
        // against, fall back to trusting the id (nothing better to go on).
        if (co && (!curNormForId || normName(co.name) === curNormForId)) {
          LOG(`fetchLinkedCompanyForRoe: found "${co.name}" by id ${linkedId}, onboarding_complete_date="${co.onboarding_complete_date || "(blank)"}"`);
          return co;
        }
        if (co) LOG(`fetchLinkedCompanyForRoe: id ${linkedId} resolved to "${co.name}", which doesn't match contact's Company Name "${companyName}" — distrusting it, trying name search instead`);
      } catch (e) { LOG(`fetchLinkedCompanyForRoe: id lookup failed: ${e.message}`); }
    }
    if (companyName) {
      try {
        const curNorm = normName(companyName);
        const rows = await hsSearch(OT_COMPANY, COMPANY_PROPS, null, companyName);
        const co = rows.map(flatten).find((c) => normName(c.name) === curNorm);
        if (co) { LOG(`fetchLinkedCompanyForRoe: found "${co.name}" by name match on "${companyName}", onboarding_complete_date="${co.onboarding_complete_date || "(blank)"}"`); return co; }
        LOG(`fetchLinkedCompanyForRoe: name search for "${companyName}" returned ${rows.length} row(s), none matched normalized name "${curNorm}"`);
      } catch (e) { LOG(`fetchLinkedCompanyForRoe: name lookup failed: ${e.message}`); }
    }
    LOG(`fetchLinkedCompanyForRoe: no linked company found (linkedId="${linkedId || "(blank)"}", companyName="${companyName || "(blank)"}")`);
    return null;
  }

  // Slower, more accurate ROE signal: reads the record's own rendered
  // activity timeline for the most recent Call/Task and who did it — catches
  // poaching even when the caller/assignee isn't the record's formal
  // `hubspot_owner_id` (e.g. someone working an account they don't own, like
  // Kody Davis calling a Samuel F. Jirik DDS he wasn't assigned). Only works
  // on the CURRENTLY VIEWED record's own page — HubSpot doesn't render an
  // activity feed for the other duplicate candidates found by search, so
  // those stay on the faster checkRoe() above.
  //
  // Heuristic DOM scrape, not an API call — matches the exact phrasing
  // HubSpot's timeline uses today ("Call - Connected made by X", "Task
  // assigned to X"). If HubSpot changes that wording this silently stops
  // matching rather than breaking, so it's safe to ship, but re-check the
  // patterns below if it stops finding hits that are visibly there.
  // Task assignment alone isn't ROE-breaking contact — it's often automated
  // ("Task assigned to X via Random...") and doesn't mean anyone actually
  // reached out. Any CALL, connected or not, is a real attempt — the official
  // Rules of Engagement doc bases the 14-day clock on "the last call placed,"
  // not the last connected call, matching roe_enforcer.py's own Rule 7 ("any
  // call by another rep = clear active work").
  const ROE_CALL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // last call — "just look at last call" per Colin
  // Matches "Call - Connected made by X", "Call - Busy made by X", "Call -
  // No Answer made by X", "Call - Left Voicemail made by X", etc. — any
  // outcome word(s) between "Call -" and "made by", since an unanswered
  // attempt still counts as "the last call placed."
  //
  // Each "word" requires a lowercase run after its leading capital, only
  // resuming on another capital right after an apostrophe/hyphen (O'Brien,
  // Smith-Jones) — HubSpot's DOM has no space between this sibling's name
  // and the next sibling's label, so raw text often reads "...made by Paul
  // BillsCall - Busy 8/11/2026...". This stops each word right at a
  // glued-on capital with no separator ("BillsCall" -> "Bills") while still
  // allowing real compound names. NOTE: no `i` flag — under /i, `[a-z]` also
  // matches uppercase, which would silently defeat this whole guard.
  // "Call"/"made by" casing is assumed consistent, same risk tolerance as
  // the rest of this DOM-scrape.
  const NAME_WORD = "[A-Za-z][a-z]*\\.?(?:['-][A-Za-z][a-z]*\\.?)*";
  const CALL_RE = new RegExp(`Call\\s*-\\s*[A-Za-z][A-Za-z /]*?\\s+made by\\s+(${NAME_WORD}(?:\\s+${NAME_WORD}){0,2})`);
  // Per the official Rules of Engagement doc: "Text messages must be logged
  // in HubSpot and are recognized like a call." STILL UNVERIFIED — no way to
  // load a real HubSpot timeline in this environment (no live browser
  // access), so this is still a best guess, just a wider one: covers SMS,
  // "Text message", and WhatsApp as the leading label, and "to/from/with/by"
  // as the connector before the name, over a longer lookahead window. If
  // texts still aren't getting picked up, send a screenshot of one logged
  // text's timeline card — the exact wording it renders is the only thing
  // that will make this reliable instead of best-effort.
  const TEXT_RE = new RegExp(`(?:SMS|Text message|WhatsApp message)\\b[\\s\\S]{0,80}?\\b(?:to|from|with|by)\\s+(${NAME_WORD}(?:\\s+${NAME_WORD}){0,2})`);
  const MEETING_RE = /Meeting\s*-\s*.+?hosted\s+by/i; // upcoming meeting — who hosted isn't needed, just that one's scheduled
  const TIMELINE_DATE_RE = /[A-Za-z]{3}\s+\d{1,2},\s*\d{4}\s+at\s+\d{1,2}:\d{2}\s*[AP]M\s*\w*/;
  const MONTH_ABBR_RE = /\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/i; // trim if a date ran into the capture

  // Date usually lives a few rows up from the matched text, in the same
  // timeline card — walk up and grab the first HubSpot-style timestamp found.
  function findNearbyTimestampMs(el) {
    let row = el;
    for (let d = 0; d < 6 && row; d++, row = row.parentElement) {
      const dm = (row.textContent || "").match(TIMELINE_DATE_RE);
      if (dm) {
        const ts = Date.parse(dm[0].replace(" at ", " "));
        if (ts) return ts;
      }
    }
    return null;
  }

  function findRecentEngagementRoe() {
    // HubSpot renders the verb in bold and the rest of the sentence as a
    // separate sibling — "Call - Connected" and "made by Kody Davis" are two
    // elements, not one — so a single leaf never contains the whole phrase.
    // Scan any short-enough element's AGGREGATED text instead; the length
    // cap keeps this from matching a giant container that just happens to
    // contain the phrase somewhere deep inside along with unrelated text.
    const candidates = [...document.querySelectorAll("div, p, span, a, li")].filter((el) => {
      const t = el.textContent || "";
      return t.length > 0 && t.length <= 220 && /made by|hosted by|SMS|Text message/i.test(t);
    });
    let bestCall = null, soonestMeeting = null;
    for (const el of candidates) {
      const text = (el.textContent || "").trim();

      const callMatch = text.match(CALL_RE);
      const textMatch = !callMatch && text.match(TEXT_RE);
      const cm = callMatch || textMatch;
      if (cm && cm[1].trim()) {
        // Aggregated text can run the name straight into a trailing date
        // with no separator ("Kody DavisAug 4, 2026...") — strip a month
        // abbreviation if the capture ran into one.
        const name = cm[1].trim().replace(MONTH_ABBR_RE, "").trim();
        const ts = findNearbyTimestampMs(el);
        if (name && ts != null) {
          const diff = Date.now() - ts; // must be a real PAST date within the window
          if (diff >= 0 && diff < ROE_CALL_WINDOW_MS && (!bestCall || ts > bestCall.ts)) {
            bestCall = { ts, name, verb: callMatch ? "called" : "texted" };
          }
        }
      }

      if (MEETING_RE.test(text)) {
        const ts = findNearbyTimestampMs(el);
        if (ts != null) {
          const diff = ts - Date.now(); // must be a real FUTURE date within the window
          if (diff >= 0 && diff < ROE_DEMO_WINDOW_MS && (!soonestMeeting || ts < soonestMeeting)) soonestMeeting = ts;
        }
      }
    }
    if (bestCall) return { reason: `${bestCall.name} ${bestCall.verb} ${new Date(bestCall.ts).toLocaleDateString()}` };
    if (soonestMeeting) return { reason: `Upcoming meeting ${new Date(soonestMeeting).toLocaleDateString()}` };
    return null;
  }

  // The activity feed can still be loading right after navigation — give it
  // a few short retries before giving up.
  async function scanEngagementRoe(attempts = 6, delayMs = 500) {
    for (let i = 0; i < attempts; i++) {
      const found = findRecentEngagementRoe();
      if (found) return found;
      await sleep(delayMs);
    }
    return null;
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
    if (phone && !isGenericPhone(phone)) await Promise.all(phoneSearchQueries(cur.phone).map(q =>
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

      // Phone / domain = definitive → strong (red). Skip generic domains/phones on both sides.
      if (phone && coPhone && phone === coPhone && !isGenericPhone(phone))                                                     { reasons.push("same phone");  strong = true; }
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
      acc.push({ objectType: OT_COMPANY, name: co.name || "(no name)", meta, href: recordUrl(OT_COMPANY, co.id), typeLabel: customer ? "Company · CUSTOMER" : "Company", reasons, strong, active, customer, curIsCustomer: isCustomer(cur), record: co });
      return acc;
    }, []).sort((a, b) => b.customer !== a.customer ? (b.customer ? 1 : -1) : (b.strong === a.strong ? 0 : b.strong ? 1 : -1));
  }

  // Check if the contact's linked company is a Pearl customer.
  // Tries by associatedcompanyid first, then falls back to searching by company name —
  // because associatedcompanyid isn't always returned by the CRM search API.
  // The name-only fallback requires a corroborating signal (phone or email
  // domain) before it's trusted — a bare name match (e.g. a contact's
  // "Company" field coincidentally matching an unrelated real customer's
  // name, like "Coco" vs. "COCO Dental") is not proof of an actual link.
  async function checkLinkedCompanyCustomer(cur) {
    const linkedId    = (cur.associatedcompanyid || "").trim();
    const companyName = cur.company;
    const phone       = normPhone(cur.phone);
    const emailParts  = (cur.email || "").split("@");
    const emailDomain = emailParts.length === 2 ? norm(emailParts[1]) : "";
    const seen = new Set();
    const candidates = [];

    // 1. Look up by explicit ID
    if (linkedId) {
      try {
        const rows = await hsSearch(OT_COMPANY, COMPANY_PROPS, [{ filters: [{ property: "hs_object_id", operator: "IN", values: [linkedId] }] }]);
        rows.map(flatten).forEach((c) => { if (c.id && !seen.has(c.id)) { seen.add(c.id); candidates.push(c); } });
      } catch (e) {}
    }

    // 2. Fall back to searching by company name (catches when associatedcompanyid is empty).
    // Name match alone isn't enough — also require matching phone or email domain
    // so a generic/short name collision can't masquerade as a real linked company.
    if (companyName && !candidates.some(isCustomer)) {
      try {
        const curNorm = normName(companyName);
        const rows = await hsSearch(OT_COMPANY, COMPANY_PROPS, null, companyName);
        rows.map(flatten)
          .filter((c) => {
            if (normName(c.name) !== curNorm || seen.has(c.id)) return false;
            const coPhone  = normPhone(c.phone);
            const coDomain = norm(c.domain || c.website || "");
            const phoneMatches  = phone && coPhone && phone === coPhone && !isGenericPhone(phone);
            const domainMatches = emailDomain && !GENERIC_DOMAINS.has(emailDomain) && coDomain && !GENERIC_DOMAINS.has(coDomain) && emailDomain === coDomain;
            return phoneMatches || domainMatches;
          })
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
      record: co, // carry full company record so the product row can read its products
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
    if (ph && !isGenericPhone(ph)) await Promise.all(phoneSearchQueries(cur.phone).map(q =>
      hsSearch(OT_CONTACT, CONTACT_PROPS, null, q).then(collect).catch(() => {})));

    return Object.values(candidates).reduce((acc, cand) => {
      const reasons = []; let strong = false;
      if (cur.email && norm(cur.email) === norm(cand.email)) { reasons.push("same email"); strong = true; }
      const cp = normPhone(cur.phone), dp = normPhone(cand.phone);
      if (cp && dp && cp === dp && !isGenericPhone(cp)) { reasons.push("same phone"); strong = true; }
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
    if (phone && !isGenericPhone(phone)) await Promise.all(phoneSearchQueries(cur.phone).map(q =>
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
      // Phone / domain = definitive → strong (red). Generic domains/phones ignored on both sides.
      if (domain && candDomain && domain === candDomain) { reasons.push("same domain"); strong = true; }
      if (phone  && candPhone  && phone  === candPhone && !isGenericPhone(phone)) { reasons.push("same phone"); strong = true; }
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
      acc.push({ objectType: OT_COMPANY, name: cand.name || "(no name)", meta: [cand.phone, cand.domain || cand.website].filter(Boolean).join(" · "), href: recordUrl(OT_COMPANY, cand.id), typeLabel: customer ? "Company · CUSTOMER" : "Company", reasons, strong, active, customer, curIsCustomer: isCustomer(cur), record: cand });
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
  // Each product can appear either as a short code (a discrete token like "PI",
  // "SOD", "Voice" in "PI;SOD;Voice") or as a full phrase ("Practice Intelligence").
  // `tokens` match a whole delimited token exactly (so "pi" doesn't hit inside a word);
  // `phrases` match anywhere in the text.
  const PRODUCT_DEFS = [
    { key: "SO",  tokens: ["so", "sod", "sos"],   phrases: ["second opinion"] },
    { key: "PI",  tokens: ["pi"],                 phrases: ["practice intell", "practice intel"] },
    { key: "Pre", tokens: ["pre", "rcm"],         phrases: ["precheck"] },
    { key: "VO",  tokens: ["vo", "voice"],        phrases: ["voice"] },
  ];

  // Returns { SO, PI, Pre, VO } booleans for which products a customer has.
  // Always returns an object (never null) so the row renders for every customer —
  // when no product field is populated, all pills come back false (gray = sellable).
  // Product text fields, in priority order. products_based_on_associated_deals is
  // key — the plain "products" field often lists only one product, while the
  // deal-derived list captures everything they've actually bought.
  const PRODUCT_TEXT_FIELDS = [
    "products", "pearl_products", "active_products", "current_products",
    "products_based_on_associated_deals",
  ];
  // Per-product application-count fields. A count > 0 is the most reliable signal
  // that they have that product, independent of how the text fields are filled in.
  const PRODUCT_COUNT_FIELDS = {
    SO:  "number_of_second_opinion_applications",
    PI:  "number_of_practice_intelligence_applications",
    Pre: "number_of_precheck_applications",
    VO:  "number_of_voice_applications",
  };

  // True if this record actually carries product data (only company records do).
  // Used to pick the right customer record for the product row — a contact can be
  // lifecyclestage=customer but never holds the products fields.
  function hasProductData(co) {
    if (!co) return false;
    if (PRODUCT_TEXT_FIELDS.some((f) => co[f] && String(co[f]).trim())) return true;
    return Object.values(PRODUCT_COUNT_FIELDS).some((f) => (parseInt(co[f] || "0", 10) || 0) > 0);
  }

  function detectProductsWithReasons(co) {
    const result  = { SO: false, PI: false, Pre: false, VO: false };
    const reasons = { SO: "", PI: "", Pre: "", VO: "" };
    if (!co) return { result, reasons };
    // 1. Text match across all product fields (incl. the deal-derived list) —
    // only trusted for actual customers. The `products` field gets populated
    // way before any purchase happens (95%+ of ALL customers AND prospects
    // carry a value in it — it's set at deal-creation time, describing what's
    // being pitched, not what's owned), so on a non-customer it just means
    // "this is what we're selling them," not "they already have it."
    const custom = isCustomerWithReason(co);
    const textFieldsSet = PRODUCT_TEXT_FIELDS.filter((f) => co[f] && String(co[f]).trim());
    const textSummary = textFieldsSet.length ? textFieldsSet.map((f) => `${f}="${co[f]}"`).join(", ") : "(all blank)";
    if (custom.result) {
      const raw = PRODUCT_TEXT_FIELDS.map((f) => co[f]).filter(Boolean).join(";").toLowerCase();
      // Split into discrete tokens so short codes ("PI", "SOD", "Voice") match exactly —
      // the plain products field often uses codes, not the full product name.
      const tokens = new Set(raw.split(/[;,/|]+|\s+/).map((t) => t.trim()).filter(Boolean));
      for (const { key, tokens: toks, phrases } of PRODUCT_DEFS) {
        const matched = toks.find((t) => tokens.has(t)) || phrases.find((p) => raw.includes(p));
        if (matched) { result[key] = true; reasons[key] = `isCustomer=true (${custom.reason}); text fields [${textSummary}] contain "${matched}" → Has ${key}`; }
        else reasons[key] = `isCustomer=true (${custom.reason}); text fields [${textSummary}] don't mention ${key}`;
      }
    } else {
      for (const { key } of PRODUCT_DEFS) reasons[key] = `isCustomer=false (${custom.reason}) → text fields [${textSummary}] ignored (only trusted for actual customers)`;
    }
    // 2. Application counts — a positive count means they have it, even if the
    //    text fields missed it (this is what "Products" alone was getting wrong).
    for (const [key, field] of Object.entries(PRODUCT_COUNT_FIELDS)) {
      const count = parseInt(co[field] || "0", 10) || 0;
      if (count > 0) { result[key] = true; reasons[key] += ` — also ${field}=${count} (>0)`; }
      else reasons[key] += ` — ${field}=${co[field] || "(blank)"} (not >0)`;
    }
    return { result, reasons };
  }
  function detectProducts(co) { return detectProductsWithReasons(co).result; }
  function explainProductHas(key, co) { return co ? detectProductsWithReasons(co).reasons[key] || "" : ""; }

  // ── Upsell compatibility (Imaging Software + PMS) ─────────────────────────
  // Source: Pearl's SO/PI/RCM/Voice compatibility spreadsheet (integrations
  // team, "compatibility" tabs only — NOT the "Integrations Coming Soon"
  // roadmap tab, which intentionally shows different, not-yet-live statuses).
  // This is a point-in-time snapshot, not a live link — re-sync this table
  // when the spreadsheet changes.
  //
  // SO and PI are gated by Imaging Software (imaging_software). PI is ALSO
  // gated by PMS (practice_management_system__cloned_, via the sheet's "Perio
  // Exam Alerts in PI" table — its Status column is the real PMS-side PI gate,
  // not just the perio sub-feature). RCM/Precheck and Voice are gated by PMS
  // only. Worst status wins when a product depends on more than one signal.
  const COMPAT = { SUPPORTED: "ok", CAVEAT: "caveat", NOT_SUPPORTED: "no" };

  // Imaging Software (exact `imaging_software` enum values) → { SO, PI }.
  // null = no PI row in the sheet for that software (no signal either way).
  const IMAGING_COMPAT = {
    "Apteryx - XRayVision":        { SO: COMPAT.SUPPORTED, PI: COMPAT.SUPPORTED },
    "Apteryx - XVWeb":             { SO: COMPAT.CAVEAT,    PI: COMPAT.CAVEAT }, // native; multi-office needs a supported PMS; no SO with Fuse PMS
    "Archy":                       { SO: COMPAT.SUPPORTED, PI: COMPAT.NOT_SUPPORTED },
    "CADI":                        { SO: COMPAT.SUPPORTED, PI: COMPAT.NOT_SUPPORTED }, // SO in testing
    "Carestream Dental Imaging Software": { SO: COMPAT.SUPPORTED, PI: COMPAT.SUPPORTED }, // PI's old "needs 6mo of SO" caveat is gone as of the latest sheet sync
    "Carestream (Version 8.0.29 or higher)": { SO: COMPAT.SUPPORTED, PI: COMPAT.SUPPORTED },
    "ClearDent":                   { SO: COMPAT.SUPPORTED, PI: COMPAT.NOT_SUPPORTED },
    "CliniView":                   { SO: COMPAT.CAVEAT,    PI: null }, // no historical imagery
    "Dentrix Ascend Imaging":      { SO: COMPAT.SUPPORTED, PI: COMPAT.CAVEAT }, // SO caveat cleared ("no historicals" note remains, but status is Supported); PI still in beta
    "Dentrix Imaging Center":      { SO: COMPAT.SUPPORTED, PI: COMPAT.SUPPORTED },
    "Dexis":                       { SO: COMPAT.SUPPORTED, PI: COMPAT.SUPPORTED },
    "DBSWin":                      { SO: COMPAT.CAVEAT,    PI: COMPAT.CAVEAT }, // image quality may degrade vs native
    "DentalEye":                   { SO: COMPAT.SUPPORTED, PI: COMPAT.NOT_SUPPORTED },
    "Dentally":                    { SO: COMPAT.SUPPORTED, PI: COMPAT.NOT_SUPPORTED }, // Pearl can't sell — supported by HS1
    "Dentimax":                    { SO: COMPAT.CAVEAT,    PI: COMPAT.NOT_SUPPORTED }, // cloud=not supported, on-prem=supported — confirm which
    "DTX Studio":                  { SO: COMPAT.NOT_SUPPORTED, PI: COMPAT.NOT_SUPPORTED },
    "Eaglesoft Imaging":           { SO: COMPAT.SUPPORTED, PI: COMPAT.CAVEAT }, // v24 or lower
    "Eaglesoft Imaging (Version 25 or higher)": { SO: COMPAT.SUPPORTED, PI: COMPAT.CAVEAT },
    "Exact":                       { SO: COMPAT.SUPPORTED, PI: COMPAT.NOT_SUPPORTED }, // Pearl can't sell — supported by HS1
    "ExaminePro":                  { SO: COMPAT.SUPPORTED, PI: COMPAT.NOT_SUPPORTED }, // Pearl can't sell — supported by HS1
    "Exquise (Cloud-based)":       { SO: COMPAT.SUPPORTED, PI: COMPAT.NOT_SUPPORTED },
    "Exquise NG":                  { SO: COMPAT.SUPPORTED, PI: null }, // on-prem only
    "Dolphin Blue Imaging":        { SO: COMPAT.CAVEAT,    PI: COMPAT.NOT_SUPPORTED }, // in testing
    "VixWin Platinum Digital X-ray Software": { SO: COMPAT.CAVEAT, PI: COMPAT.NOT_SUPPORTED }, // version-dependent
    "MiPACS":                      { SO: COMPAT.SUPPORTED, PI: COMPAT.NOT_SUPPORTED },
    "MediaDent":                   { SO: COMPAT.SUPPORTED, PI: COMPAT.NOT_SUPPORTED },
    "MediaSuite/D4W/Centaur":      { SO: COMPAT.CAVEAT,    PI: COMPAT.NOT_SUPPORTED }, // on-prem only, build reqs
    "OnePix":                      { SO: COMPAT.SUPPORTED, PI: COMPAT.NOT_SUPPORTED },
    "Open Dental Imaging Module":  { SO: COMPAT.SUPPORTED, PI: COMPAT.CAVEAT },
    "Oryx":                        { SO: COMPAT.SUPPORTED, PI: COMPAT.NOT_SUPPORTED }, // Pearl can't sell — supported by Oryx
    "Paterson imaging":            { SO: COMPAT.NOT_SUPPORTED, PI: COMPAT.NOT_SUPPORTED },
    "Rayscan":                     { SO: COMPAT.SUPPORTED, PI: COMPAT.NOT_SUPPORTED },
    "Planmeca Romexis":            { SO: COMPAT.SUPPORTED, PI: COMPAT.CAVEAT },
    "Planmeca Romexis (Version 6.4.5 or Higher)": { SO: COMPAT.SUPPORTED, PI: COMPAT.CAVEAT },
    "Planmeca Romexis (Version 6.4.7 or Higher)": { SO: COMPAT.SUPPORTED, PI: COMPAT.CAVEAT }, // native from 6.4.7
    "Safecom":                     { SO: COMPAT.NOT_SUPPORTED, PI: null },
    "SIDEXIS (Version 4.4 or higher)": { SO: COMPAT.SUPPORTED, PI: COMPAT.CAVEAT },
    "SIDEXIS 4.3":                 { SO: COMPAT.SUPPORTED, PI: COMPAT.CAVEAT },
    "SIDEXIS XG":                  { SO: COMPAT.SUPPORTED, PI: COMPAT.NOT_SUPPORTED },
    "SoPro":                       { SO: COMPAT.SUPPORTED, PI: COMPAT.CAVEAT },
    "Acteon":                      { SO: COMPAT.NOT_SUPPORTED, PI: null }, // Acteon Imaging Suite — distinct from SoPro, NOT supported
    "SOTA Cloud":                  { SO: COMPAT.SUPPORTED, PI: COMPAT.SUPPORTED },
    "SOTA Image":                  { SO: COMPAT.NOT_SUPPORTED, PI: null }, // server-based, currently unavailable
    "Tab 32":                      { SO: COMPAT.SUPPORTED, PI: COMPAT.NOT_SUPPORTED },
    "TigerView Image Management Software": { SO: COMPAT.CAVEAT, PI: COMPAT.CAVEAT },
    "Tracker":                     { SO: COMPAT.SUPPORTED, PI: COMPAT.NOT_SUPPORTED },
    "Twelve":                      { SO: COMPAT.NOT_SUPPORTED, PI: COMPAT.NOT_SUPPORTED },
    "Vatech Clever One":           { SO: COMPAT.NOT_SUPPORTED, PI: COMPAT.NOT_SUPPORTED },
    "Vatech":                      { SO: COMPAT.SUPPORTED, PI: COMPAT.CAVEAT }, // standalone row; see IMAGING_NATIVE_OVERRIDE
    "Visiquick":                   { SO: COMPAT.SUPPORTED, PI: COMPAT.NOT_SUPPORTED },
    "VistaSoft":                   { SO: COMPAT.CAVEAT,    PI: COMPAT.CAVEAT },
    "XDR":                         { SO: COMPAT.SUPPORTED, PI: COMPAT.SUPPORTED },
  };

  // A few imaging systems have a separate "Native" row in the sheet with a
  // different status than the standalone row — `native` (Yes/No) on the
  // company picks which one applies.
  const IMAGING_NATIVE_OVERRIDE = {
    "Vatech": { SO: COMPAT.CAVEAT, PI: COMPAT.NOT_SUPPORTED }, // "Vatech EzDent-i Native" — beta
  };

  // PMS (exact `practice_management_system__cloned_` enum values) → status,
  // one table per product. HubSpot's "OpenDental" value doesn't distinguish
  // standalone/Clinics/Cloud (the sheet does, with different statuses) — mapped
  // to the standalone row as the most common case.
  const PMS_PI_COMPAT = { // "Perio Exam Alerts in PI" table's Status column
    "Carestack": COMPAT.SUPPORTED, "ClearDent": COMPAT.NOT_SUPPORTED, "Curve": COMPAT.SUPPORTED,
    "Denticon": COMPAT.SUPPORTED, "Dentrix Ascend": COMPAT.CAVEAT, "Dentrix": COMPAT.SUPPORTED,
    "Dentrix Enterprise": COMPAT.SUPPORTED, "Eaglesoft": COMPAT.SUPPORTED, "OpenDental": COMPAT.SUPPORTED,
  };
  const PMS_RCM_COMPAT = {
    "Carestack": COMPAT.SUPPORTED, "Curve": COMPAT.NOT_SUPPORTED, "Denticon": COMPAT.SUPPORTED,
    "Dentrix Ascend": COMPAT.SUPPORTED, "Dentrix": COMPAT.SUPPORTED, "Dentrix Enterprise": COMPAT.CAVEAT,
    "Eaglesoft": COMPAT.SUPPORTED, "OpenDental": COMPAT.SUPPORTED,
  };
  const PMS_VOICE_COMPAT = {
    "Carestack": COMPAT.SUPPORTED, "Curve": COMPAT.SUPPORTED, "Denticon": COMPAT.SUPPORTED,
    "Dentrix Ascend": COMPAT.NOT_SUPPORTED, "Dentrix": COMPAT.SUPPORTED, "Dentrix Enterprise": COMPAT.NOT_SUPPORTED,
    "Eaglesoft": COMPAT.SUPPORTED, "OpenDental": COMPAT.SUPPORTED,
  };

  // Returns { status, reason }: status is COMPAT.SUPPORTED / CAVEAT /
  // NOT_SUPPORTED / null (no compatibility data either way), and `reason`
  // names the SPECIFIC signal that produced it (e.g. "PMS: Curve") — not
  // every signal checked, so the tooltip explains exactly why a pill is
  // red/yellow instead of listing data that wasn't actually the blocker.
  // When a product depends on more than one signal (PI needs both Imaging
  // AND PMS), the worst one wins and becomes the reported reason.
  const COMPAT_RANK = { [COMPAT.NOT_SUPPORTED]: 2, [COMPAT.CAVEAT]: 1, [COMPAT.SUPPORTED]: 0 };
  function compatCheck(productKey, co) {
    if (!co) return { status: null, reason: "" };
    const signals = []; // { label, status }
    if (productKey === "SO" || productKey === "PI") {
      const img = co.imaging_software;
      if (img) {
        const native = norm(co.native) === "yes";
        const row = (native && IMAGING_NATIVE_OVERRIDE[img]) || IMAGING_COMPAT[img];
        if (row && row[productKey] != null) signals.push({ label: `Imaging: ${img}`, status: row[productKey] });
      }
    }
    if (productKey === "PI" || productKey === "Pre" || productKey === "VO") {
      const table = productKey === "PI" ? PMS_PI_COMPAT : productKey === "Pre" ? PMS_RCM_COMPAT : PMS_VOICE_COMPAT;
      const pms = co.practice_management_system__cloned_;
      if (pms) {
        // Checkbox field — can hold more than one selected system. The sheet's
        // PMS tables only list systems with a built integration; a PMS that's
        // set but NOT in the table isn't "unknown" — it genuinely has no
        // integration yet, so it's not supported (e.g. PracticeWorks + RCM).
        for (const s of pms.split(/[;,]+/).map((s) => s.trim()).filter(Boolean)) {
          signals.push({ label: `PMS: ${s}`, status: table[s] || COMPAT.NOT_SUPPORTED });
        }
      }
    }
    if (!signals.length) return { status: null, reason: "" };
    const worst = signals.reduce((a, b) => (COMPAT_RANK[b.status] > COMPAT_RANK[a.status] ? b : a));
    return { status: worst.status, reason: worst.label };
  }

  function detectDsoWithReason(cur) {
    if (!cur) return { result: null, reason: "no record data" };
    const seg     = norm(cur.primary_segment  || "");
    const notable = norm(cur.notable_status   || "");
    const locs    = parseInt(cur.number_of_locations || "0") || 0;
    const name    = norm(cur.name || "");

    // primary_segment "Domestic - Enterprise" or notable_status containing DSO/Enterprise
    const enterpriseSeg = seg.includes("enterprise") ||
      notable.includes("enterprise") || notable.includes("dso");

    // Named account on the enterprise team's list
    const namedEnterprise = ENTERPRISE_DSO_NAMES.some((n) => name.includes(n));

    // 10+ locations = DSO/Enterprise threshold (9 and under is not a DSO)
    if (locs >= 10) return { result: "enterprise", reason: `number_of_locations=${locs} (>=10) → DSO/Enterprise` };
    if (enterpriseSeg) return { result: "enterprise", reason: `primary_segment="${cur.primary_segment || ""}" / notable_status="${cur.notable_status || ""}" contains "enterprise" or "dso" → DSO/Enterprise` };
    if (namedEnterprise) return { result: "enterprise", reason: `company name "${cur.name}" matches an entry on the named enterprise-accounts list → DSO/Enterprise` };
    return { result: null, reason: `number_of_locations=${locs} (<10), primary_segment="${cur.primary_segment || "(blank)"}", notable_status="${cur.notable_status || "(blank)"}", name doesn't match the named list → not a DSO` };
  }
  function detectDso(cur) { return detectDsoWithReason(cur).result; }
  function explainDso(cur) { return detectDsoWithReason(cur).reason; }

  let hoursKey      = null;  // record key the cached hours belong to
  let hoursDays     = null;  // { dayIdx(0=Sun) : [{o, c}] } minutes since midnight
  let hoursTz       = "";
  let hoursSource   = "";    // URL of the page the hours were found on (the proof)
  let hoursFetched  = false; // true once the check has completed (success or fail)
  let dsoRecord     = null;  // current record snapshot used for DSO pill
  let roeDealOverride  = null; // hard override from checkRoeForClosedLostDeal — outranks the DOM-scraped call/meeting
  let roeStaleDemoScheduled = false; // true when checkRoeForStaleDemoScheduled says this deal is stale — suppresses everything except a genuine fresh DOM-scraped call/meeting
  let roeLinkedCompany = null; // Contact pages only — the linked Company record, checked as a second ROE source

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
      pill.addEventListener("mouseenter", () => showPdcTooltip(pill));
      pill.addEventListener("mouseleave", hidePdcTooltip);
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
    pill.dataset.tip = ADMIN_MODE ? explainDso(dsoRecord) : "9+ locations — route to enterprise team, do not cold call";
    pill.className = "pdc-dso pdc-dso-enterprise";
  }

  // Appended to document.body (not nested in the widget) so it isn't clipped
  // by #pearl-dupe-widget's `overflow: hidden` — a CSS ::after tooltip nested
  // inside the widget gets cut off at the widget's edge instead of floating
  // over the page. Shared by the ROE badge AND the product-compatibility
  // pills — anything using it just needs `el.dataset.tip` set and these two
  // listeners wired up; a native `title` attribute has a slow, inconsistent
  // browser delay that's too slow for something you want to check at a glance.
  let pdcTooltipEl = null;
  function showPdcTooltip(el) {
    const text = el.dataset.tip;
    if (!text) return;
    hidePdcTooltip();
    const tip = document.createElement("div");
    tip.className = "pdc-roe-tooltip";
    tip.textContent = text;
    document.body.appendChild(tip);
    const elRect = el.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    let left = elRect.left;
    if (left + tipRect.width > window.innerWidth - 8) left = window.innerWidth - tipRect.width - 8;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${elRect.bottom + 6}px`;
    pdcTooltipEl = tip;
  }
  function hidePdcTooltip() {
    if (pdcTooltipEl) { pdcTooltipEl.remove(); pdcTooltipEl = null; }
  }

  function getOrCreateRoePill(head) {
    let pill = head.querySelector(".pdc-roe");
    if (!pill) {
      pill = document.createElement("span");
      pill.className = "pdc-roe";
      pill.addEventListener("click", (e) => e.stopPropagation());
      pill.addEventListener("mouseenter", () => showPdcTooltip(pill));
      pill.addEventListener("mouseleave", hidePdcTooltip);
      // ROE pill goes first — before DSO, hours, or controls, whichever exists
      head.insertBefore(pill, head.querySelector(".pdc-dso") || head.querySelector(".pdc-hours") || head.querySelector(".pdc-controls"));
    }
    return pill;
  }

  // Priority: roeDealOverride (a hard Closed-Lost-cooldown rule) always wins
  // — that's the whole point of a cooldown, it shouldn't get papered over by
  // a coincidental old call. Otherwise `override` lets the slower engagement
  // scan replace/add a reason the fast checks missed, falling back to the
  // contact's own signals and then (Contact pages only) the linked Company's.
  // A stale Demo Scheduled deal (roeStaleDemoScheduled) suppresses all of
  // that EXCEPT `override` — a genuine fresh call/meeting found by the DOM
  // scan is more current evidence than a stale deal-stage rule, so it can
  // still flag the pill; nothing else can.
  function updateRoePill(override) {
    const head = document.querySelector(`#${WIDGET_ID} .pdc-head`);
    if (!head || !dsoRecord) return;
    // Onboarding-priority outranks EVERYTHING below, including the
    // DOM-scraped call/meeting override — an upcoming meeting someone else
    // booked doesn't erase the AE's 90-day priority window.
    const onboardingRoe = checkRoeOnboardingPriority(dsoRecord) || (roeLinkedCompany && checkRoeOnboardingPriority(roeLinkedCompany));
    LOG(`updateRoePill: onboardingRoe=${onboardingRoe ? "YES — " + onboardingRoe.reason : "no"}; roeLinkedCompany=${roeLinkedCompany ? `"${roeLinkedCompany.name}" (onboarding_complete_date="${roeLinkedCompany.onboarding_complete_date || "(blank)"}", closed_won=${roeLinkedCompany.number_of_associated_closed_won_deals || "(blank)"})` : "not yet resolved"}; override=${override ? override.reason : "none"}`);
    const roe = onboardingRoe || (roeStaleDemoScheduled
      ? override
      : (roeDealOverride || override || checkRoe(dsoRecord) || (roeLinkedCompany && checkRoe(roeLinkedCompany))));
    if (!roe) { const existing = head.querySelector(".pdc-roe"); if (existing) existing.remove(); return; }
    const pill = getOrCreateRoePill(head);
    pill.textContent = "⚠ ROE";
    // A native `title` tooltip has a slow, inconsistent browser delay before
    // it appears — use data-tip + CSS ::after instead so it shows instantly.
    pill.dataset.tip = roe.reason;
    // Red for the strongest ROE signals (e.g. within the 90-day post-onboarding
    // AE-priority window) — just the pill itself, not the whole widget header
    // the way a customer/dupe match colors it.
    pill.classList.toggle("pdc-roe-red", roe.severity === "red");
  }

  // Runs the slower DOM-scrape ROE pass and upgrades the pill if it finds a
  // more specific hit than the fast owner+date check. Skipped when a harder
  // deal-stage rule already applies — that shouldn't get overwritten by a
  // less authoritative signal.
  async function checkRoeEngagements() {
    const myKey = lastKey;
    if (roeDealOverride) return;
    const found = await scanEngagementRoe();
    if (lastKey !== myKey) return; // navigated away while scanning
    if (found) updateRoePill(found);
  }

  function updateHoursPill() {
    const head = document.querySelector(`#${WIDGET_ID} .pdc-head`);
    if (!head) return;

    if (!hoursFetched || hoursKey !== lastKey) {
      // Still loading
      const pill = getOrCreatePill(head);
      pill.textContent = "·";
      pill.href = "#";
      pill.title = "Checking hours…";
      pill.className = "pdc-hours pdc-hours-loading";
      return;
    }

    if (!hoursDays) {
      // Couldn't determine hours (no website on file, or the scan found
      // nothing) — don't show a placeholder badge, just don't show one.
      const existing = head.querySelector(".pdc-hours");
      if (existing) existing.remove();
      return;
    }

    const pill = getOrCreatePill(head);
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
      pill.title = ADMIN_MODE
        ? `Today: ${status.todayLabel}${hoursTz ? ` (tz: ${hoursTz})` : ""} — scanned ${hoursSource || "(no source)"}`
        : `Today: ${status.todayLabel}${hoursTz ? " (their local time)" : ""} — click to see source`;
      pill.className = "pdc-hours pdc-hours-lunch";
      return;
    }

    pill.textContent = status.open ? "OPEN" : "CLOSED";
    pill.title = ADMIN_MODE
      ? `Today: ${status.todayLabel}${hoursTz ? ` (tz: ${hoursTz})` : ""} — scanned ${hoursSource || "(no source)"}`
      : `Today: ${status.todayLabel}${hoursTz ? " (their local time)" : ""} — click to see source`;
    pill.className = "pdc-hours " + (status.open ? "pdc-hours-open" : "pdc-hours-closed");
  }

  async function checkBusinessHours(cur) {
    const myKey = lastKey;

    // Already fetched for this record — just re-draw the pill
    if (hoursKey === myKey && hoursFetched) { updateHoursPill(); return; }

    // Show loading pill immediately
    hoursFetched = false;
    updateHoursPill();

    // Best source: the record's own website/domain (skip generic providers).
    // If there's no real website on file, there's nothing reliable to scan or
    // link to — no name-based web search fallback, just show "no website."
    let site = "";
    const rawSite = norm(cur.domain || cur.website || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    if (rawSite && !GENERIC_DOMAINS.has(rawSite)) site = "https://" + rawSite;
    if (!site) {
      const ep = (cur.email || "").split("@");
      if (ep.length === 2 && ep[1] && !GENERIC_DOMAINS.has(norm(ep[1]))) site = "https://" + norm(ep[1]);
    }
    if (!site) {
      hoursKey = myKey; hoursFetched = true; hoursDays = null;
      updateHoursPill();
      return;
    }
    if (!extensionAlive()) return;

    let resp = null;
    try {
      resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "checkHours", site }, (r) => {
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
  function removeWidget() { document.getElementById(WIDGET_ID)?.remove(); hidePdcTooltip(); }

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
    const roe = checkRoe(m.record);
    card.innerHTML =
      `<div class="pdc-card-severity ${severityClass}">${esc(severityText)}</div>` +
      (roe ? `<div class="pdc-card-roe${roe.severity === "red" ? " pdc-card-roe-red" : ""}" title="${esc(roe.reason)}">⚠ ROE — ${esc(roe.reason)}</div>` : "") +
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

    // A reversed account can be the current record (company page) or the
    // connected company (contact page) — so check the current record plus
    // strongly-matched companies (phone/domain match, linked, or self). NOT
    // name-only matches: those are frequently unrelated businesses that just
    // happen to share a common word ("Lifetime Dental" turning up 38 loose
    // name matches), and an unrelated company's reversed history has nothing
    // to do with the record actually being viewed (confirmed bug: it was
    // bleeding through from a same-named-but-different business).
    const reversedCandidates = [dsoRecord, ...matches.filter((m) => m.strong || m.linkedCustomer || m.selfRecord).map((m) => m.record)];
    const reversed = reversedCandidates.some(isReversed);

    let state, label, headerExplain;
    if (activeStrongDupes.length > 0) {
      // Priority 1: strong dupe that has been actively worked — urgent
      state = "red";
      label = `⚠ ${activeStrongDupes.length} likely duplicate${activeStrongDupes.length === 1 ? "" : "s"} found`;
      headerExplain = `RED — ${activeStrongDupes.length} strong match(es) with activity/customer status: ` +
        activeStrongDupes.map((m) => `"${m.name}" [${m.reasons.join(", ")}]${m.customer ? " (is a customer)" : m.curIsCustomer ? " (viewer is a customer)" : " (has recent activity)"}`).join("; ");
    } else if (inactiveStrongDupes.length > 0) {
      // Priority 2: strong dupe but no activity logged on it — still flag, but less urgent
      state = "amber";
      label = `⚠ ${inactiveStrongDupes.length} likely duplicate${inactiveStrongDupes.length === 1 ? "" : "s"} found`;
      headerExplain = `AMBER — ${inactiveStrongDupes.length} strong match(es), but no activity and not a customer: ` +
        inactiveStrongDupes.map((m) => `"${m.name}" [${m.reasons.join(", ")}]`).join("; ");
    } else if (reversed) {
      // Priority 3: reversed — signed up but onboarding was cancelled/reversing (never went live).
      // Ranks above the customer badge so a reversed account isn't mistaken for an active one.
      state = "reversed";
      label = "REVERSED";
      const hit = reversedCandidates.find((c) => isReversed(c));
      headerExplain = `REVERSED — ${explainIsReversed(hit)}`;
    } else if (connectedCustomer.length > 0) {
      // Priority 4: connected/linked customer, no strong dupes
      state = "blue";
      label = "Existing customer";
      const cc = connectedCustomer[0];
      headerExplain = `BLUE — matched via [${cc.reasons.join(", ")}] to "${cc.name}"; ${explainIsCustomer(cc.record)}`;
    } else if (isFormerCustomer(dsoRecord)) {
      // Priority 5: ex-customer — location_status=Inactive, has product data, not lifecyclestage=customer
      state = "purple";
      label = "EX-CUSTOMER";
      headerExplain = `PURPLE — ${explainIsFormerCustomer(dsoRecord)}`;
    } else {
      // Priority 5: clean — name-only overlaps don't change the badge color
      state = "green";
      label = "✓ No duplicates found";
      headerExplain = `GREEN — no strong dupes, no connected customer; ${explainIsReversed(dsoRecord)}; ${explainIsFormerCustomer(dsoRecord)}`;
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
    if (ADMIN_MODE) {
      headLabel.dataset.tip = headerExplain;
      headLabel.addEventListener("mouseenter", () => showPdcTooltip(headLabel));
      headLabel.addEventListener("mouseleave", hidePdcTooltip);
    }
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

    // ── Product row — customers AND prospects ──
    // Read products from the record's COMPANY data. On a company/deal/lead page
    // that's dsoRecord itself; on a contact (or any connected match) it rides
    // along on the connected-customer match as m.record, so we still know what
    // they have. The record currently on screen always gets a compat check —
    // upsell-compatibility (yellow/red) matters during prospecting too, not
    // just upsell to an existing customer. Other MATCHED companies only
    // contribute product/compat data when they're an actual customer AND a
    // strong/linked match — a loose NAME-ONLY match (e.g. "Kissimmee Dental"
    // matching "Ideal Dental Kissimmee" on word overlap alone) is an unrelated
    // business; its products aren't this record's products. Same scoping as
    // reversedCandidates above, for the same reason.
    // A Contact can also carry its own imaging/PMS answers directly (aliased
    // onto imaging_software above) even with no linked company at all — that's
    // real compat data too, so it counts as an on-screen candidate just like
    // a company-shaped record does.
    const isCompanyShaped = (co) => co && co.name !== undefined; // Contacts have no `name` field
    const hasCompatData   = (co) => !!(co && (co.imaging_software || co.practice_management_system__cloned_));
    const showProductsFor = (m) => m.record && (m.strong || m.linkedCustomer || m.selfRecord) && (isCustomer(m.record) || isReversed(m.record));
    const productCandidates = [];
    if (isCompanyShaped(dsoRecord) || hasCompatData(dsoRecord)) productCandidates.push(dsoRecord);
    for (const m of matches) if (showProductsFor(m)) productCandidates.push(m.record);
    const customerRecord = productCandidates.find(hasProductData) || productCandidates[0] || null;
    const prods = customerRecord ? detectProducts(customerRecord) : null;
    if (prods) {
      const prodRow = document.createElement("div");
      prodRow.className = "pdc-products";
      for (const { key } of PRODUCT_DEFS) {
        const pill = document.createElement("span");
        pill.textContent = key;
        pill.addEventListener("mouseenter", () => showPdcTooltip(pill));
        pill.addEventListener("mouseleave", hidePdcTooltip);
        if (prods[key]) {
          pill.className = "pdc-prod pdc-prod-has";
          pill.dataset.tip = ADMIN_MODE ? explainProductHas(key, customerRecord) : `Has ${key}`;
        } else {
          const { status: compat, reason } = compatCheck(key, customerRecord);
          if (compat === COMPAT.NOT_SUPPORTED) {
            pill.className = "pdc-prod pdc-prod-blocked";
            pill.dataset.tip = `${reason} — not compatible`;
          } else if (compat === COMPAT.CAVEAT) {
            pill.className = "pdc-prod pdc-prod-caveat";
            pill.dataset.tip = `${reason} — check compatibility before selling`;
          } else if (compat === COMPAT.SUPPORTED) {
            pill.className = "pdc-prod pdc-prod-sell";
            pill.dataset.tip = `${reason} — can sell ${key}`;
          } else {
            // No Imaging Software / PMS on file at all — genuinely unknown,
            // not a confirmed "can sell." Don't claim compatibility we don't
            // actually have data for.
            pill.className = "pdc-prod pdc-prod-unknown";
            pill.dataset.tip = ADMIN_MODE
              ? `imaging_software="${customerRecord?.imaging_software || "(blank)"}", PMS="${customerRecord?.practice_management_system__cloned_ || "(blank)"}" — no compatibility row for either → unknown`
              : "No Imaging Software/PMS on file — compatibility unknown";
          }
        }
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
    updateRoePill();   // show ROE caution if this record looks actively worked

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

  // Shared by the Company branch and the Deal/Lead branch below — given a
  // Company id, returns the same { matches, cur } shape run() renders either way.
  async function runCompanyCheck(companyId, runId) {
    const cur = await fetchCurrentRecord(OT_COMPANY, COMPANY_PROPS, companyId);
    if (runId !== currentRunId) return null;
    if (!cur) { LOG("No record data yet — watchdog will retry"); removeWidget(); return null; }
    const dupeMatches = await findDuplicateCompanies(cur);
    if (runId !== currentRunId) return null;
    // If this company is itself a customer, prepend a self-customer marker
    let matches;
    if (isCustomer(cur)) {
      matches = [{
        objectType: OT_COMPANY,
        name: cur.name || "(no name)",
        meta: [cur.phone, cur.domain || cur.website, cur.state].filter(Boolean).join(" · "),
        href: recordUrl(OT_COMPANY, cur.id),
        typeLabel: "Company · CUSTOMER",
        reasons: ["this is a Pearl customer"],
        strong: true, customer: true, linkedCustomer: true, selfRecord: true,
        record: cur, // carry record so the product row can read its products
      }, ...dupeMatches];
    } else {
      matches = dupeMatches;
    }
    return { matches, cur };
  }

  const TYPE_LABELS = { [OT_CONTACT]: "Contact", [OT_COMPANY]: "Company", [OT_DEAL]: "Deal", [OT_LEAD]: "Lead" };

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
    roeDealOverride  = null;
    roeStaleDemoScheduled = false;
    roeLinkedCompany = null;
    renderLoading();
    LOG(`Running check — type=${TYPE_LABELS[type] || type}, id=${id}`);

    try {
      let matches = [];
      let curForHours = null; // record data handed to the hours check after render

      if (type === OT_CONTACT) {
        const cur = await fetchCurrentRecord(OT_CONTACT, CONTACT_PROPS, id);
        if (runId !== currentRunId) return;
        // No data (transient) — remove widget so the watchdog re-runs shortly.
        if (!cur) { LOG("No record data yet — watchdog will retry"); removeWidget(); return; }
        // Alias the Contact's own imaging field onto the name compatCheck()
        // actually reads (imaging_software) — see CONTACT_PROPS comment.
        if (!cur.imaging_software && cur.imaging_software_new) cur.imaging_software = cur.imaging_software_new;
        curForHours = cur;
        // Per Colin: "Always check the company for activity not JUST the
        // contact" — fetch the linked Company regardless of customer status
        // so its ROE signals (owner, open deals) get considered too.
        fetchLinkedCompanyForRoe(cur.associatedcompanyid, cur.company).then((co) => {
          if (runId === currentRunId) { roeLinkedCompany = co; updateRoePill(); }
        }).catch(() => {});
        const linkedCustomer = await checkLinkedCompanyCustomer(cur);
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
        const result = await runCompanyCheck(id, runId);
        if (!result) return;
        matches = result.matches;
        curForHours = result.cur;

      } else if (type === OT_DEAL || type === OT_LEAD) {
        // Deals/Leads carry no name/phone/domain of their own — resolve to the
        // associated Company (already resolved for OT_LEAD by getRecordInfo;
        // look it up fresh here for OT_DEAL since the record page needs a beat
        // to render its association card) and run the normal Company checks.
        if (type === OT_DEAL) {
          // Deal-stage-specific ROE (Closed Lost cooldown) needs the deal's
          // OWN fields — the associated Company doesn't carry dealstage/
          // closed_lost_reason/closedate. Fetched in the background; doesn't
          // block the main company-resolution flow below.
          fetchCurrentRecord(OT_DEAL, DEAL_PROPS, id).then((deal) => {
            if (runId === currentRunId) {
              roeDealOverride = checkRoeForClosedLostDeal(deal);
              roeStaleDemoScheduled = checkRoeForStaleDemoScheduled(deal);
              updateRoePill();
            }
          }).catch(() => {});
        }
        const companyId = type === OT_DEAL ? await waitForAssociatedCompanyId() : id;
        if (runId !== currentRunId) return;
        if (!companyId) { LOG("No associated company found yet — watchdog will retry"); removeWidget(); return; }
        const result = await runCompanyCheck(companyId, runId);
        if (!result) return;
        matches = result.matches;
        curForHours = result.cur;
      }

      if (runId !== currentRunId) return;
      LOG(`Duplicate check refreshed — ${matches.length} match(es):`, matches.map((m) => `${m.typeLabel} "${m.name}" [${m.reasons.join(", ")}]`));
      lastResult = { matches };
      lastResultAt = Date.now();
      dsoRecord = curForHours; // set before render so updateDsoPill() can read it
      render(matches);
      // Widget is on screen — background checks run in priority order: ROE
      // (safety — don't poach) ahead of hours (a nice-to-have).
      checkRoeEngagements().catch((e) => LOG("ROE scan error:", e.message));
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

  // Reads a Deal/Lead's associated Company id straight off the page's own
  // "Companies" association card (the same data HubSpot already renders for a
  // human) instead of calling an associations API. Scoped to a "Companies (N)"
  // card when one is found, so an inline-expanded table row elsewhere on a
  // Leads list page doesn't get picked up by mistake; falls back to the first
  // company link on the page otherwise.
  function findAssociatedCompanyId() {
    const links = [...document.querySelectorAll('a[href*="/record/0-2/"]')];
    if (!links.length) return null;
    const inCompaniesCard = (a) => {
      let el = a, depth = 0;
      while (el && depth++ < 8) {
        if (/^Companies \(\d+\)/.test((el.textContent || "").trim())) return true;
        el = el.parentElement;
      }
      return false;
    };
    const isPrimary = (a) => {
      let el = a, depth = 0;
      while (el && depth++ < 6) { if (/primary/i.test(el.textContent || "")) return true; el = el.parentElement; }
      return false;
    };
    const scoped = links.filter(inCompaniesCard);
    const pool = scoped.length ? scoped : links;
    const chosen = pool.find(isPrimary) || pool[0];
    const m = chosen.href.match(/\/record\/0-2\/(\d+)/);
    return m ? m[1] : null;
  }

  // Deal pages render the association card asynchronously — give it a moment.
  async function waitForAssociatedCompanyId(attempts = 8) {
    for (let i = 0; i < attempts; i++) {
      const id = findAssociatedCompanyId();
      if (id) return id;
      await sleep(350);
    }
    return null;
  }

  function getRecordInfo() {
    const m = location.pathname.match(/\/record\/(0-[123])\/(\d+)|\/contact\/(\d+)/);
    if (m) {
      if (m[3]) return { type: OT_CONTACT, id: m[3] };
      return { type: m[1], id: m[2] };
    }
    // Leads have no full-page URL — HubSpot only ever shows them in a slide-out
    // Preview panel on the Leads list. Key off whichever company is linked so a
    // watchdog tick naturally detects when the rep switches to a different lead.
    if (location.pathname.includes(`/objects/${OT_LEAD}/`)) {
      const companyId = findAssociatedCompanyId();
      if (companyId) return { type: OT_LEAD, id: companyId };
    }
    return null;
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
