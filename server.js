const express = require("express");
const rateLimit = require("express-rate-limit");
const { normalize } = require("./normalize");

const THRESHOLD = parseInt(process.env.PROMOTE_THRESHOLD || "5", 10);
const DAILY_LIMIT = parseInt(process.env.REPORTS_PER_INSTALL_PER_DAY || "50", 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const DISPUTE_MIN = parseInt(process.env.DEMOTE_MIN_DISPUTES || "3", 10);
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
  await pool.query("ALTER TABLE entries ADD COLUMN IF NOT EXISTS disputes INTEGER NOT NULL DEFAULT 0");

  // Recount votes; promotion uses net score (reporters - disputes); global entries with enough disputes are demoted.
  async function recompute(e) {
    const rep = (await pool.query("SELECT COUNT(*)::int AS c FROM reports WHERE entry_id = $1", [e.id])).rows[0].c;
    const dis = (await pool.query("SELECT COUNT(*)::int AS c FROM disputes WHERE entry_id = $1", [e.id])).rows[0].c;
    let status = e.status;
    if (status !== "removed") {
      if (rep - dis >= THRESHOLD) status = "global";
      else if (status === "global" && dis >= DISPUTE_MIN) status = "pending";
    }
    await pool.query("UPDATE entries SET reporters = $2, disputes = $3, status = $4, promoted_at = CASE WHEN $4 = 'global' AND status <> 'global' THEN now() ELSE promoted_at END WHERE id = $1", [e.id, rep, dis, status]);
    return { reporters: rep, disputes: dis, status };
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
      await pool.query(`DELETE FROM ${other} WHERE entry_id = $1 AND install_id = $2`, [e.id, installId]); // one opinion per install
      await pool.query(`INSERT INTO ${table} (entry_id, install_id, ip) VALUES ($1, $2, $3) ON CONFLICT (entry_id, install_id) DO NOTHING`, [e.id, installId, req.ip]);
    }
    const r = await recompute(e);
    res.json({ ok: true, type: n.type, value: n.value, duplicate: dup, ...r, threshold: THRESHOLD });
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
  app.delete("/api/admin/entries/:id", admin, async (req, res) => {
    const id = parseInt(req.params.id, 10); await pool.query("DELETE FROM reports WHERE entry_id = $1", [id]);
    const r = await pool.query("DELETE FROM entries WHERE id = $1", [id]); res.json({ ok: r.rowCount === 1 });
  });
  app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: "server error" }); });
  return app;
}

if (require.main === module) createApp().then(app => { const p = process.env.PORT || 3000; app.listen(p, () => console.log("listening on " + p)); });
module.exports = { createApp };
