# AI Blocker community server
Node/Express + Postgres. Endpoints:
- `GET /api/global` – promoted entries `{domains, accounts, urls}` (extension syncs on startup + every 6h)
- `POST /api/report` `{installId, value, type: domain|account|url}` – one vote per install per entry; promoted at `PROMOTE_THRESHOLD` (default 5) unique installs
- `GET /api/admin/entries?status=pending|global|removed`, `POST /api/admin/entries/:id {status}`, `DELETE /api/admin/entries/:id` – need `Authorization: Bearer $ADMIN_TOKEN`
- `GET /healthz`

Abuse protection: per-IP limit (`REPORTS_PER_IP_PER_HOUR`, 60), per-install daily limit (`REPORTS_PER_INSTALL_PER_DAY`, 50), URL/handle normalization, protected allowlist (normalize.js), admin-rejected entries can't be re-reported.

Local: `npm install && npm test` (uses in-memory pg-mem when DATABASE_URL is unset) or `DATABASE_URL=postgres://... ADMIN_TOKEN=x npm start`.
Deploy: Render Blueprint (`render.yaml`) creates the web service + a free Postgres; ADMIN_TOKEN is generated (read it in the Render dashboard). Then set the server URL in the extension options.

## Moderation (v1.2)
- Reports never add an entry to the list automatically. When an entry reaches `PROMOTE_THRESHOLD` (5) net reports (reports minus disputes), it goes into a **review queue**. An admin approves or rejects it and can add a note.
- **Reputation:** each install starts at 0. It gains +1 for every approved report and loses 1 for every rejected report; disputes gain +1 or lose 0.5. A vote's weight is `clamp(0.5 + 0.25*rep, 0.1, 2)`, so new installs count half. The weighted `score` is shown in the queue.
- **Disputes:** `REVIEW_MIN_DISPUTES` (3) fresh disputes send a promoted entry back to review. It stays on the list until an admin decides; disputes never remove it automatically.
- **Cooldown:** after any admin decision the entry is locked for `DECISION_COOLDOWN_DAYS` (30). Disputes or reports during that time don't requeue it. Only disputes made after the decision count toward the next review.
- **Optional auto-promotion:** single-URL entries can be promoted automatically, but this is off by default. Set `AUTO_PROMOTE_URLS=true`. It also requires a weighted score from reputable reporters (rep ≥ `AUTO_PROMOTE_MIN_REP`, default 2) of at least `AUTO_PROMOTE_SCORE` (default 8). Domains and accounts always need admin approval.
- **Admin endpoints** (all need `Authorization: Bearer $ADMIN_TOKEN`):
  - `GET /api/admin/queue`
  - `POST /api/admin/entries/:id/approve {note}`
  - `POST /api/admin/entries/:id/reject {note}`
  - `GET /api/admin/installs`
- **Review page:** `GET /admin` serves the page itself. You paste your token there, it's kept in sessionStorage, and it's sent with every API call.
