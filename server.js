const express = require("express");
const rateLimit = require("express-rate-limit");
const { normalize } = require("./normalize");

const THRESHOLD = parseInt(process.env.PROMOTE_THRESHOLD || "5", 10);
const DAILY_LIMIT = parseInt(process.env.REPORTS_PER_INSTALL_PER_DAY || "50", 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const DISPUTE_MIN = parseInt(process.env.REVIEW_MIN_DISPUTES || process.env.DEMOTE_MIN_DISPUTES || "3", 10); // disputes that send a promoted entry back to review
const COOLDOWN_DAYS = parseFloat(process.env.DECISION_COOLDOWN_DAYS || "30"); // after an admin decision, disputes/reports can't requeue it
// Optional auto-promotion for NARROW entries only (single URLs / images). Off by default: everything goes to review.
const AUTO_PROMOTE_URLS = process.env.AUTO_PROMOTE_URLS === "true";
const AUTO_SCORE = parseFloat(process.env.AUTO_PROMOTE_SCORE || "8");
const AUTO_MIN_REP = parseFloat(process.env.AUTO_PROMOTE_MIN_REP || "2");
// Reporter weight from reputation: new installs (rep 0) count 0.5, each approved report adds 0.25 up to 2.0, rejections push toward 0.1.
const weightOf = rep => Math.max(0.1, Math.min(2, 0.5 + 0.25 * rep));
const fs = require("fs");
const RULES = fs.readFileSync(__dirname + "/rules/rules.json", "utf8");
const RULES_SIG = fs.readFileSync(__dirname + "/rules/rules.sig", "utf8").trim();
const RULES_VERSION = JSON.parse(RULES).version;

function makePool() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    return new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false } });
  }
  const { newDb } = require("pg-mem"); // dev/test only
  console.warn("DATABASE_URL not set: using in-memory pg-mem (data is lost on restart)");
  const { Pool } = newDb().adapters.createPg(); return new Pool();
}

async function createApp(pool = makePool()) {
  await pool.query(`CREATE TABLE IF NOT EXISTS entries (
    id SERIAL PRIMARY KEY, type TEXT NOT NULL, value TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', reporters INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), promoted_at TIMESTAMPTZ, UNIQUE(type, value))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reports (
    entry_id INTEGER NOT NULL, install_id TEXT NOT NULL, ip TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(entry_id, install_id))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS disputes (
    entry_id INTEGER NOT NULL, install_id TEXT NOT NULL, ip TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(entry_id, install_id))`);
  for (const col of ["disputes INTEGER NOT NULL DEFAULT 0", "score REAL NOT NULL DEFAULT 0", "in_review BOOLEAN NOT NULL DEFAULT false",
    "review_reason TEXT", "notes TEXT NOT NULL DEFAULT ''", "decided_at TIMESTAMPTZ", "locked_until TIMESTAMPTZ"])
    await pool.query("ALTER TABLE entries ADD COLUMN IF NOT EXISTS " + col);
  for (const t of ["reports", "disputes"]) await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS rep_applied BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`CREATE TABLE IF NOT EXISTS installs (install_id TEXT PRIMARY KEY, reputation REAL NOT NULL DEFAULT 0,
    approved INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0, first_seen TIMESTAMPTZ NOT NULL DEFAULT now())`);

  async function reps(ids) {
    if (!ids.length) return {};
    const { rows } = await pool.query(`SELECT install_id, reputation FROM installs WHERE install_id IN (${ids.map((_, i) => "$" + (i + 1)).join(",")})`, ids);
    const m = Object.fromEntries(ids.map(i => [i, 0])); rows.forEach(r => m[r.install_id] = Number(r.reputation)); return m;
  }
  // Recount votes and decide the moderation state. Reports never auto-promote domains/accounts:
  //   pending --(net reports >= THRESHOLD)--> in review queue --(admin approve)--> global / (admin reject)--> removed
  //   global  --(>= DISPUTE_MIN disputes since last decision, not in cooldown)--> stays global but goes into the review queue
  async function recompute(e) {
    const rr = (await pool.query("SELECT install_id FROM reports WHERE entry_id = $1", [e.id])).rows.map(r => r.install_id);
    const dd = (await pool.query("SELECT install_id, created_at FROM disputes WHERE entry_id = $1", [e.id])).rows;
    const R = await reps([...rr, ...dd.map(d => d.install_id)]);
    const score = rr.reduce((n, i) => n + weightOf(R[i]), 0) - dd.reduce((n, d) => n + weightOf(R[d.install_id]), 0);
    const locked = e.locked_until && new Date(e.locked_until) > new Date();
    const freshDisputes = dd.filter(d => !e.decided_at || new Date(d.created_at) > new Date(e.decided_at)).length;
    let { status, in_review: inReview, review_reason: reason } = e;
    if (status === "pending" && !inReview && !locked && rr.length - dd.length >= THRESHOLD) {
      const reputableScore = rr.filter(i => R[i] >= AUTO_MIN_REP).reduce((n, i) => n + weightOf(R[i]), 0);
      if (AUTO_PROMOTE_URLS && e.type === "url" && reputableScore >= AUTO_SCORE && score >= AUTO_SCORE) { status = "global"; reason = "auto-promoted (narrow url, reputable reporters)"; }
      else { inReview = true; reason = "reports"; }
    }
    if (status === "global" && !inReview && !locked && freshDisputes >= DISPUTE_MIN) { inReview = true; reason = "disputed"; }
    await pool.query(`UPDATE entries SET reporters = $2, disputes = $3, status = $4, score = $5, in_review = $6, review_reason = $7,
      promoted_at = CASE WHEN $4 = 'global' AND status <> 'global' THEN now() ELSE promoted_at END WHERE id = $1`,
      [e.id, rr.length, dd.length, status, Math.round(score * 100) / 100, inReview, reason]);
    return { reporters: rr.length, disputes: dd.length, status, inReview, score: Math.round(score * 100) / 100 };
  }
  async function bumpRep(id, delta, field) {
    await pool.query("INSERT INTO installs (install_id) VALUES ($1) ON CONFLICT (install_id) DO NOTHING", [id]);
    await pool.query(`UPDATE installs SET reputation = reputation + $2, ${field} = ${field} + 1 WHERE install_id = $1`, [id, delta]);
  }
  // Admin decision: approve => entry is (or stays) global; reject => removed. Reporters/disputers gain or lose reputation once per vote.
  async function decide(id, approve, note) {
    const e = (await pool.query("SELECT * FROM entries WHERE id = $1", [id])).rows[0]; if (!e) return null;
    for (const [t, right] of [["reports", approve], ["disputes", !approve]]) {
      const { rows } = await pool.query(`SELECT install_id FROM ${t} WHERE entry_id = $1 AND rep_applied = false`, [id]);
      for (const r of rows) await bumpRep(r.install_id, right ? 1 : (t === "reports" ? -1 : -0.5), right ? "approved" : "rejected");
      await pool.query(`UPDATE ${t} SET rep_applied = true WHERE entry_id = $1`, [id]);
    }
    const stamp = `[${new Date().toISOString()}] ${approve ? "APPROVED" : "REJECTED"} (${e.review_reason || "manual"})${note ? ": " + String(note).slice(0, 500) : ""}`;
    const locked = new Date(Date.now() + COOLDOWN_DAYS * 864e5);
    await pool.query(`UPDATE entries SET status = $2, in_review = false, review_reason = NULL, decided_at = now(), locked_until = $3,
      notes = $4, promoted_at = CASE WHEN $2 = 'global' AND status <> 'global' THEN now() ELSE promoted_at END WHERE id = $1`,
      [id, approve ? "global" : "removed", locked, e.notes ? e.notes + "\n" + stamp : stamp]);
    return (await pool.query("SELECT * FROM entries WHERE id = $1", [id])).rows[0];
  }
  async function dailyCount(installId) {
    const a = await pool.query("SELECT COUNT(*)::int AS c FROM reports WHERE install_id = $1 AND created_at > now() - interval '1 day'", [installId]);
    const b = await pool.query("SELECT COUNT(*)::int AS c FROM disputes WHERE install_id = $1 AND created_at > now() - interval '1 day'", [installId]);
    return a.rows[0].c + b.rows[0].c;
  }

  const app = express();
  app.set("trust proxy", 1); // Render sits behind a proxy
  app.use(express.json({ limit: "4kb" }));
  app.use((req, res, next) => { res.set("Access-Control-Allow-Origin", "*"); res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Allow-Methods", "GET, POST, DELETE"); if (req.method === "OPTIONS") return res.sendStatus(204); next(); });

  app.get("/healthz", (req, res) => res.json({ ok: true, rulesVersion: RULES_VERSION }));
  app.get("/api/rules", (req, res) => { res.set("Cache-Control", "public, max-age=3600"); res.json({ version: RULES_VERSION, rules: RULES, signature: RULES_SIG, alg: "ECDSA-P256-SHA256" }); });

  app.get("/api/global", async (req, res) => {
    const { rows } = await pool.query("SELECT type, value FROM entries WHERE status = 'global' ORDER BY value");
    const out = { threshold: THRESHOLD, domains: [], accounts: [], urls: [], updatedAt: new Date().toISOString() };
    for (const r of rows) out[r.type === "domain" ? "domains" : r.type === "account" ? "accounts" : "urls"].push(r.value);
    res.set("Cache-Control", "public, max-age=600"); res.json(out);
  });

  const ipLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: parseInt(process.env.REPORTS_PER_IP_PER_HOUR || "60", 10), standardHeaders: true, legacyHeaders: false, message: { error: "rate limited (ip)" } });
  async function vote(req, res) {
    const { installId, value, type } = req.body || {};
    if (typeof installId !== "string" || !/^[0-9a-f-]{36}$/i.test(installId)) return res.status(400).json({ error: "invalid installId" });
    const n = normalize(value, type, { dispute: req.path.endsWith("/dispute") });
    if (n.error) return res.status(n.status || 400).json({ error: n.error });
    if (await dailyCount(installId) >= DAILY_LIMIT) return res.status(429).json({ error: "rate limited (install)" });
    const isDispute = req.path.endsWith("/dispute");
    if (!isDispute) await pool.query("INSERT INTO entries (type, value) VALUES ($1, $2) ON CONFLICT (type, value) DO NOTHING", [n.type, n.value]);
    const e = (await pool.query("SELECT * FROM entries WHERE type = $1 AND value = $2", [n.type, n.value])).rows[0];
    if (!e) return res.json({ ok: true, type: n.type, value: n.value, status: "unknown", note: "entry not in community list" });
    if (e.status === "removed" && !isDispute) return res.status(403).json({ error: "entry was rejected by an admin" });
    const table = isDispute ? "disputes" : "reports", other = isDispute ? "reports" : "disputes";
    const dup = (await pool.query(`SELECT 1 FROM ${table} WHERE entry_id = $1 AND install_id = $2`, [e.id, installId])).rows.length > 0;
    if (!dup) {
      await pool.query("INSERT INTO installs (install_id) VALUES ($1) ON CONFLICT (install_id) DO NOTHING", [installId]);
      await pool.query(`DELETE FROM ${other} WHERE entry_id = $1 AND install_id = $2`, [e.id, installId]); // one opinion per install
      await pool.query(`INSERT INTO ${table} (entry_id, install_id, ip) VALUES ($1, $2, $3) ON CONFLICT (entry_id, install_id) DO NOTHING`, [e.id, installId, req.ip]);
    }
    const r = await recompute(e);
    res.json({ ok: true, type: n.type, value: n.value, duplicate: dup, ...r, threshold: THRESHOLD, note: r.inReview ? "queued for moderator review" : undefined });
  }
  app.post("/api/report", ipLimiter, vote);
  app.post("/api/dispute", ipLimiter, vote);

  const admin = (req, res, next) => { const t = (req.get("authorization") || "").replace(/^Bearer /, "");
    if (!ADMIN_TOKEN || t !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" }); next(); };
  app.get("/api/admin/entries", admin, async (req, res) => {
    const st = req.query.status; const q = st ? ["SELECT * FROM entries WHERE status = $1 ORDER BY reporters DESC LIMIT 500", [st]] : ["SELECT * FROM entries ORDER BY reporters DESC LIMIT 500", []];
    res.json((await pool.query(...q)).rows);
  });
  app.post("/api/admin/entries/:id", admin, async (req, res) => { // body {status: pending|global|removed}
    if (!["pending", "global", "removed"].includes(req.body?.status)) return res.status(400).json({ error: "bad status" });
    const r = await pool.query("UPDATE entries SET status = $2 WHERE id = $1", [parseInt(req.params.id, 10), req.body.status]); res.json({ ok: r.rowCount === 1 });
  });
  app.get("/api/admin/queue", admin, async (req, res) =>
    res.json((await pool.query("SELECT * FROM entries WHERE in_review = true ORDER BY score DESC, reporters DESC LIMIT 500")).rows));
  app.post("/api/admin/entries/:id/approve", admin, async (req, res) => { const e = await decide(parseInt(req.params.id, 10), true, req.body?.note); e ? res.json({ ok: true, entry: e }) : res.status(404).json({ error: "not found" }); });
  app.post("/api/admin/entries/:id/reject", admin, async (req, res) => { const e = await decide(parseInt(req.params.id, 10), false, req.body?.note); e ? res.json({ ok: true, entry: e }) : res.status(404).json({ error: "not found" }); });
  app.get("/api/admin/installs", admin, async (req, res) => res.json((await pool.query("SELECT * FROM installs ORDER BY reputation DESC LIMIT 200")).rows));
  app.get("/admin", (req, res) => res.sendFile(__dirname + "/admin.html")); // page shell only; every data call needs the Bearer token
  app.delete("/api/admin/entries/:id", admin, async (req, res) => {
    const id = parseInt(req.params.id, 10); await pool.query("DELETE FROM reports WHERE entry_id = $1", [id]);
    await pool.query("DELETE FROM disputes WHERE entry_id = $1", [id]); const r = await pool.query("DELETE FROM entries WHERE id = $1", [id]); res.json({ ok: r.rowCount === 1 });
  });
  app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: "server error" }); });
  return app;
}

if (require.main === module) createApp().then(app => { const p = process.env.PORT || 3000; app.listen(p, () => console.log("listening on " + p)); });
module.exports = { createApp };
