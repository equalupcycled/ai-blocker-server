const assert = require("assert"); process.env.ADMIN_TOKEN = "secret"; process.env.PROMOTE_THRESHOLD = "5";
const { createApp } = require("./server");
(async () => {
  const app = await createApp(); const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const J = { "Content-Type": "application/json" }, A = { ...J, Authorization: "Bearer secret" };
  const send = (path, body) => fetch(base + path, { method: "POST", headers: J, body: JSON.stringify(body) }).then(async r => ({ s: r.status, j: await r.json() }));
  const post = b => send("/api/report", b), disp = b => send("/api/dispute", b);
  const adm = (p, body) => fetch(base + p, body ? { method: "POST", headers: A, body: JSON.stringify(body) } : { headers: A }).then(r => r.json());
  const id = i => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const global = async () => (await (await fetch(base + "/api/global")).json());

  // normalization / dedupe / allowlist / validation
  let r = await post({ installId: id(1), value: "https://www.Example-AI-Farm.com/some/page?x=1", type: "domain" });
  assert.equal(r.j.value, "example-ai-farm.com"); assert.equal(r.j.reporters, 1);
  r = await post({ installId: id(1), value: "example-ai-farm.com", type: "domain" }); assert.equal(r.j.reporters, 1); assert.ok(r.j.duplicate);
  assert.equal((await post({ installId: id(1), value: "en.wikipedia.org", type: "domain" })).s, 403);
  assert.equal((await post({ installId: id(1), value: "google.com", type: "domain" })).s, 403);
  assert.equal((await post({ installId: id(1), value: "https://twitter.com/SomeAIBot?s=20", type: "url" })).j.value, "x.com/someaibot");
  assert.equal((await post({ installId: "bad", value: "x.com", type: "domain" })).s, 400);

  // 5 reports => review queue, NOT global
  for (let i = 2; i <= 5; i++) r = await post({ installId: id(i), value: "http://example-ai-farm.com/", type: "domain" });
  assert.equal(r.j.status, "pending"); assert.equal(r.j.inReview, true); assert.equal(r.j.score, 2.5); // 5 new installs x 0.5
  assert.deepEqual((await global()).domains, []);
  assert.equal((await fetch(base + "/api/admin/queue")).status, 401);
  let q = await adm("/api/admin/queue"); const e1 = q.find(x => x.value === "example-ai-farm.com"); assert.equal(e1.review_reason, "reports");

  // approve with note => global, reporters gain reputation, locked
  let d = await adm(`/api/admin/entries/${e1.id}/approve`, { note: "content farm, checked" });
  assert.equal(d.entry.status, "global"); assert.ok(d.entry.notes.includes("content farm")); assert.ok(d.entry.locked_until);
  assert.deepEqual((await global()).domains, ["example-ai-farm.com"]);
  let inst = await adm("/api/admin/installs"); assert.equal(inst.find(x => x.install_id === id(1)).reputation, 1);

  // reputable reporters weigh more: score with rep 1 installs = 0.75 each
  for (let i = 1; i <= 5; i++) r = await post({ installId: id(i), value: "farm2.com", type: "domain" });
  assert.equal(r.j.score, 3.75); assert.equal(r.j.inReview, true);

  // reject => removed; reporters lose reputation; further reports refused
  const e2 = (await adm("/api/admin/queue")).find(x => x.value === "farm2.com");
  d = await adm(`/api/admin/entries/${e2.id}/reject`, { note: "human studio" }); assert.equal(d.entry.status, "removed");
  inst = await adm("/api/admin/installs"); assert.equal(inst.find(x => x.install_id === id(1)).reputation, 0);
  assert.equal((await post({ installId: id(9), value: "farm2.com", type: "domain" })).s, 403);

  // disputes on an upheld (locked) entry do NOT requeue or demote it
  for (let i = 101; i <= 104; i++) d = await disp({ installId: id(i), value: "example-ai-farm.com", type: "domain" });
  assert.equal(d.j.status, "global"); assert.equal(d.j.inReview, false);
  assert.ok((await global()).domains.includes("example-ai-farm.com"));

  // second server with no cooldown: disputes put promoted entry into review (still listed), admin can reject
  process.env.DECISION_COOLDOWN_DAYS = "0"; delete require.cache[require.resolve("./server")];
  const app2 = await require("./server").createApp(); const srv2 = app2.listen(0); const b2 = `http://127.0.0.1:${srv2.address().port}`;
  const s2 = (p, body, h = J) => fetch(b2 + p, { method: "POST", headers: h, body: JSON.stringify(body) }).then(r => r.json());
  for (let i = 1; i <= 5; i++) await s2("/api/report", { installId: id(i), value: "farm3.com", type: "domain" });
  let e3 = (await (await fetch(b2 + "/api/admin/queue", { headers: A })).json())[0];
  await s2(`/api/admin/entries/${e3.id}/approve`, {}, A);
  for (let i = 201; i <= 203; i++) d = await s2("/api/dispute", { installId: id(i), value: "farm3.com", type: "domain" });
  assert.equal(d.status, "global"); assert.equal(d.inReview, true);
  e3 = (await (await fetch(b2 + "/api/admin/queue", { headers: A })).json())[0]; assert.equal(e3.review_reason, "disputed");
  assert.ok((await (await fetch(b2 + "/api/global")).json()).domains.includes("farm3.com"));
  d = await s2(`/api/admin/entries/${e3.id}/reject`, { note: "disputers were right" }, A); assert.equal(d.entry.status, "removed");
  assert.ok(!(await (await fetch(b2 + "/api/global")).json()).domains.includes("farm3.com"));
  // switching opinion: install 1's report is replaced by its dispute
  d = await s2("/api/dispute", { installId: id(1), value: "farm3.com", type: "domain" }); assert.equal(d.reporters, 4); assert.equal(d.disputes, 4);
  srv2.close();

  // optional narrow auto-promotion (urls only, reputable reporters) – off by default
  process.env.AUTO_PROMOTE_URLS = "true"; process.env.AUTO_PROMOTE_SCORE = "2.5"; process.env.AUTO_PROMOTE_MIN_REP = "0";
  delete require.cache[require.resolve("./server")];
  const app3 = await require("./server").createApp(); const srv3 = app3.listen(0); const b3 = `http://127.0.0.1:${srv3.address().port}`;
  const s3 = (p, body) => fetch(b3 + p, { method: "POST", headers: J, body: JSON.stringify(body) }).then(r => r.json());
  for (let i = 1; i <= 5; i++) d = await s3("/api/report", { installId: id(i), value: "https://imgs.example.net/ai/123.png", type: "url" });
  for (let i = 1; i <= 5; i++) r = await s3("/api/report", { installId: id(i), value: "domainstill.com", type: "domain" });
  assert.equal(r.inReview, true); assert.equal(r.status, "pending"); // domains never auto-promote
  srv3.close();
  assert.equal(d.status, "global"); assert.equal(d.inReview, false); // narrow url auto-promoted only because enabled + score met

  // rules endpoint + signature verify
  const rr = await (await fetch(base + "/api/rules")).json();
  if (require("fs").existsSync("/workspace/ai-blocker-keys/pub.jwk")) { const pub = require("crypto").createPublicKey({ key: JSON.parse(require("fs").readFileSync("/workspace/ai-blocker-keys/pub.jwk", "utf8")), format: "jwk" });
  assert.ok(require("crypto").verify("sha256", Buffer.from(rr.rules), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(rr.signature, "base64"))); }
  assert.equal(JSON.parse(rr.rules).version, rr.version);
  assert.equal((await fetch(base + "/admin")).status, 200);
  console.log("all tests passed"); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
