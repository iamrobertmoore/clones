// Sign in with Google: verify a Google ID token in this function, with Google's published keys,
// and map the Google account to one guest account in the town, the same on every device.
//
// The guest id is derived from the Google subject with the house secret, so nobody can pick
// someone else's account and the Google id never appears on chain. For these accounts the house
// keeps a full-access key (it must, to send new clones in from any device), like an exchange
// holding a key for you. The clones themselves are on the same leash as every other clone.

const crypto = require("crypto");

const ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const CERTS = "https://www.googleapis.com/oauth2/v3/certs";
let jwks = null;
let jwksAt = 0;

const b64url = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

async function googleKeys(fetchFn = fetch) {
  if (jwks && Date.now() - jwksAt < 3600e3) return jwks;
  const r = await fetchFn(CERTS);
  if (!r.ok) throw new Error(`Google keys HTTP ${r.status}`);
  jwks = (await r.json()).keys || [];
  jwksAt = Date.now();
  return jwks;
}

// Returns the token's claims, or throws. `keys` can be passed in for tests.
async function verifyIdToken(token, clientId, keys) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("not a Google sign-in token");
  const header = JSON.parse(b64url(parts[0]).toString("utf8"));
  const claims = JSON.parse(b64url(parts[1]).toString("utf8"));
  if (header.alg !== "RS256") throw new Error("unexpected token algorithm");
  const jwk = (keys || (await googleKeys())).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown Google key");
  const ok = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    crypto.createPublicKey({ key: jwk, format: "jwk" }),
    b64url(parts[2]),
  );
  if (!ok) throw new Error("bad signature");
  if (!ISSUERS.includes(claims.iss)) throw new Error("not issued by Google");
  if (!clientId || claims.aud !== clientId) throw new Error("token is for another app");
  if (!(Number(claims.exp) * 1000 > Date.now())) throw new Error("token expired");
  if (!claims.sub) throw new Error("no Google account id");
  return claims;
}

// One guest account per Google account: g + six characters, like every other guest.
function googleGuest(sub, env = process.env) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const mac = crypto.createHmac("sha256", env.HOUSE_KEY.trim()).update(`google:${sub}`).digest();
  return "g" + Array.from(mac.subarray(0, 6), (b) => alphabet[b % alphabet.length]).join("") + "." + env.HOUSE_ACCOUNT;
}

module.exports = { verifyIdToken, googleGuest, googleKeys };
