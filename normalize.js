// Major sites that can never be auto-blocked as a whole domain.
const ALLOWLIST = ["google.com","youtube.com","wikipedia.org","wikimedia.org","facebook.com","instagram.com","x.com","twitter.com","reddit.com","tiktok.com","pinterest.com","linkedin.com","amazon.com","apple.com","microsoft.com","bing.com","duckduckgo.com","yahoo.com","github.com","medium.com","substack.com","tumblr.com","deviantart.com","artstation.com","behance.net","etsy.com","ebay.com","nytimes.com","bbc.co.uk","bbc.com","cnn.com","reuters.com","apnews.com","gov","edu","mozilla.org","cloudflare.com","netflix.com","spotify.com","twitch.tv","discord.com","whatsapp.com","imgur.com","flickr.com","archive.org","blogspot.com","wordpress.com","github.io","pages.dev","vercel.app","netlify.app"];
const MULTI_TLD = ["co.uk","com.au","co.jp","com.br","co.in"];
function isAllowlisted(host) { return ALLOWLIST.some(a => host === a || host.endsWith("." + a)); }
// Shared hosting where a subdomain is a separate site: subdomains OK, the root is not.
const SHARED = ["github.io","blogspot.com","wordpress.com","pages.dev","vercel.app","netlify.app","tumblr.com","substack.com"];
const ACCOUNT_HOSTS = { "twitter.com": "x.com", "mobile.twitter.com": "x.com", "m.youtube.com": "youtube.com", "old.reddit.com": "reddit.com", "m.facebook.com": "facebook.com" };

function parse(v) { v = String(v || "").trim(); if (!v || v.length > 500) return null; if (!/^[a-z]+:\/\//i.test(v)) v = "https://" + v;
  try { const u = new URL(v); if (!/^https?:$/.test(u.protocol)) return null; return u; } catch { return null; } }

function normalize(value, type) {
  const u = parse(value); if (!u) return { error: "invalid value" };
  let host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return { error: "invalid host" };
  host = ACCOUNT_HOSTS[host] || host;
  const path = u.pathname.replace(/\/+$/, "").toLowerCase();
  if (type === "domain" || ((!type || type === "url") && !path)) {
    const shared = SHARED.find(s => host.endsWith("." + s));
    if (isAllowlisted(host) && !shared) return { error: "domain is on the protected allowlist", status: 403 };
    if (MULTI_TLD.includes(host) || SHARED.includes(host)) return { error: "invalid host" };
    return { type: "domain", value: host };
  }
  if (type === "account" || type === "url" || !type) {
    // Accounts: keep first path segment(s) identifying a profile/channel/subreddit
    const segs = path.split("/").filter(Boolean);
    let acct = null;
    if (host === "reddit.com" && ["r", "user", "u"].includes(segs[0]) && segs[1]) acct = `reddit.com/${segs[0] === "u" ? "user" : segs[0]}/${segs[1]}`;
    else if (host === "youtube.com" && (segs[0]?.startsWith("@"))) acct = `youtube.com/${segs[0]}`;
    else if (host === "youtube.com" && ["channel", "c", "user"].includes(segs[0]) && segs[1]) acct = `youtube.com/${segs[0]}/${segs[1]}`;
    else if (["x.com", "instagram.com", "pinterest.com", "tiktok.com", "facebook.com", "deviantart.com", "artstation.com", "behance.net", "threads.net"].includes(host) && segs[0] && !["status", "p", "pin", "reel", "watch", "search", "explore", "home", "i"].includes(segs[0]) && segs.length === 1)
      acct = `${host}/${segs[0]}`;
    if (acct) return { type: "account", value: acct };
    if (type === "account") return { error: "not a recognised account URL" };
    if (!segs.length) return { error: "invalid url" };
    return { type: "url", value: host + path }; // query + fragment stripped
  }
  return { error: "invalid type" };
}
module.exports = { normalize, ALLOWLIST };
