# Pearl Dupe Checker

A tiny Chrome extension that flags duplicate HubSpot contacts in real time. Open
a contact → a colored badge appears bottom-right:

- 🟢 **Green** — no duplicates found
- 🟠 **Amber** — possible match (same name, or same last-name + company)
- 🔴 **Red** — likely duplicate (same email, same phone, or same name + company)

Click a red/amber badge to expand the list of matches and click through to each
record.

**How it works:** runs entirely in your browser using *your own* HubSpot login.
It calls HubSpot's internal search API the same way the HubSpot UI does — no API
token, no admin setup, no data leaves your machine. Everyone just needs to be
signed in to HubSpot.

---

## Install (you — 2 minutes)

1. Open Chrome → `chrome://extensions`
2. Toggle **Developer mode** on (top-right)
3. Click **Load unpacked**
4. Select this `pearl-dupe-checker` folder
5. Open any HubSpot contact and look bottom-right

If you don't see the badge: make sure the URL is `app.hubspot.com/contacts/...`
and you're logged in. Right-click the badge area → Inspect → Console for any
`[Pearl Dupe Checker]` messages.

---

## Share with coworkers (free, fastest)

1. Zip this folder (`pearl-dupe-checker.zip`)
2. Send it to them (Slack/Drive)
3. They unzip and follow the 5 install steps above

That's it — free, no store, no review wait.

**Optional upgrade — a clean one-click install link:** publish to the Chrome Web
Store ($5 one-time developer fee). Gives a normal install button and auto-updates
for the whole team. Worth it once the tool is stable.

---

## Tuning the match rules

All logic is in `content.js`:

- `classify()` — decides red (strong) vs amber (possible) and the reason text.
- `findDuplicates()` — which searches run (email, company+lastname, phone, name).

v1 is duplicates-only. Owner / open-deal / ROE warnings can be layered in later
by adding `hubspot_owner_id` and deal checks to `classify()`.
