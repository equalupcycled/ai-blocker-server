// Signs rules.json with an ECDSA P-256 key (kept OFF the server/repo). Output: rules.sig (base64, IEEE-P1363, WebCrypto-compatible)
const fs = require("fs"), crypto = require("crypto");
const key = fs.readFileSync(process.argv[2] || process.env.RULES_KEY);
const data = fs.readFileSync(__dirname + "/rules.json");
fs.writeFileSync(__dirname + "/rules.sig", crypto.sign("sha256", data, { key, dsaEncoding: "ieee-p1363" }).toString("base64"));
console.log("signed");
