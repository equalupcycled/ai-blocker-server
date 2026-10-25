# AI Blocker community server
Node/Express + Postgres. Endpoints:
- `GET /api/global` – promoted entries `{domains, accounts, urls}` (extension syncs on startup + every 6h)
- `POST /api/report` `{installId, value, type: domain|account|url}` – one vote per install per entry; promoted at `PROMOTE_THRESHOLD` (default 5) unique installs
- `GET /api/admin/entries?status=pending|global|removed`, `POST /api/admin/entries/:id {status}`, `DELETE /api/admin/entries/:id` – need `Authorization: Bearer $ADMIN_TOKEN`
- `GET /healthz`

Abuse protection: per-IP limit (`REPORTS_PER_IP_PER_HOUR`, 60), per-install daily limit (`REPORTS_PER_INSTALL_PER_DAY`, 50), URL/handle normalization, protected allowlist (normalize.js), admin-rejected entries can't be re-reported.

Local: `npm install && npm test` (uses in-memory pg-mem when DATABASE_URL is unset) or `DATABASE_URL=postgres://... ADMIN_TOKEN=x npm start`.
Deploy: Render Blueprint (`render.yaml`) creates the web service + a free Postgres; ADMIN_TOKEN is generated (read it in the Render dashboard). Then set the server URL in the extension options.
