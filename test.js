const assert = require("assert"); process.env.ADMIN_TOKEN = "secret"; process.env.PROMOTE_THRESHOLD = "5";
const { createApp } = require("./server");
(async () => {
  const app = await createApp(); const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (body) => fetch(base + "/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async r => ({ s: r.status, j: await r.json() }));
  const id = i => `00000000-0000-4000-8000-00000000000${i}`;
  let r = await post({ installId: id(1), value: "https://www.Example-AI-Farm.com/some/page?x=1", type: "domain" });
  assert.equal(r.j.value, "example-ai-farm.com"); assert.equal(r.j.reporters, 1);
  r = await post({ installId: id(1), value: "example-ai-farm.com", type: "domain" }); assert.equal(r.j.reporters, 1); assert.ok(r.j.duplicate);
  for (let i = 2; i <= 5; i++) r = await post({ installId: id(i), value: "http://example-ai-farm.com/", type: "domain" });
  assert.equal(r.j.status, "global");
  assert.equal((await post({ installId: id(1), value: "en.wikipedia.org", type: "domain" })).s, 403);
  assert.equal((await post({ installId: id(1), value: "google.com", type: "domain" })).s, 403);
  assert.equal((await post({ installId: id(1), value: "someone.github.io", type: "domain" })).j.value, "someone.github.io");
  assert.equal((await post({ installId: id(1), value: "https://twitter.com/SomeAIBot?s=20", type: "url" })).j.value, "x.com/someaibot");
  assert.equal((await post({ installId: "bad", value: "x.com", type: "domain" })).s, 400);
  const g = await (await fetch(base + "/api/global")).json(); assert.deepEqual(g.domains, ["example-ai-farm.com"]);
  assert.equal((await fetch(base + "/api/admin/entries")).status, 401);
  const list = await (await fetch(base + "/api/admin/entries", { headers: { Authorization: "Bearer secret" } })).json();
  const e = list.find(x => x.value === "example-ai-farm.com");
  await fetch(base + "/api/admin/entries/" + e.id, { method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" }, body: JSON.stringify({ status: "removed" }) });
  assert.deepEqual((await (await fetch(base + "/api/global")).json()).domains, []);
  // disputes: new domain promoted at 5, then 3 disputes demote it
  for (let i = 1; i <= 5; i++) r = await post({ installId: id(i), value: "farm2.com", type: "domain" });
  assert.equal(r.j.status, "global");
  const disp = (i) => fetch(base + "/api/dispute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ installId: `00000000-0000-4000-8000-00000000010${i}`, value: "farm2.com", type: "domain" }) }).then(r => r.json());
  let d; for (let i = 1; i <= 3; i++) d = await disp(i);
  assert.equal(d.disputes, 3); assert.equal(d.status, "pending");
  assert.ok(!(await (await fetch(base + "/api/global")).json()).domains.includes("farm2.com"));
  // switching opinion: install 1 disputes -> its report is removed
  d = await fetch(base + "/api/dispute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ installId: id(1), value: "farm2.com", type: "domain" }) }).then(r => r.json());
  assert.equal(d.reporters, 4); assert.equal(d.disputes, 4);
  // rules endpoint + signature verify
  const rr = await (await fetch(base + "/api/rules")).json();
  if (require("fs").existsSync("/workspace/ai-blocker-keys/pub.jwk")) { const pub = require("crypto").createPublicKey({ key: JSON.parse(require("fs").readFileSync("/workspace/ai-blocker-keys/pub.jwk", "utf8")), format: "jwk" });
  assert.ok(require("crypto").verify("sha256", Buffer.from(rr.rules), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(rr.signature, "base64"))); }
  assert.equal(JSON.parse(rr.rules).version, rr.version);
  console.log("all tests passed"); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
