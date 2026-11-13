const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { verifyIdToken, googleGuest } = require("./google.js");

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(claims, kid = "k1", key = privateKey) {
  const head = enc({ alg: "RS256", kid, typ: "JWT" });
  const body = enc(claims);
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key).toString("base64url");
  return `${head}.${body}.${sig}`;
}
const good = () => ({ iss: "https://accounts.google.com", aud: "app.apps.googleusercontent.com", sub: "1234", exp: Math.floor(Date.now() / 1000) + 600, name: "Ada" });

test("a Google token signed by Google's key, for this app, is accepted", async () => {
  const c = await verifyIdToken(token(good()), "app.apps.googleusercontent.com", [jwk]);
  assert.equal(c.sub, "1234");
});

test("a token for another app, expired, unsigned or from another key is refused", async () => {
  await assert.rejects(verifyIdToken(token(good()), "other.apps.googleusercontent.com", [jwk]), /another app/);
  await assert.rejects(verifyIdToken(token({ ...good(), exp: 1 }), "app.apps.googleusercontent.com", [jwk]), /expired/);
  await assert.rejects(verifyIdToken(token({ ...good(), iss: "evil.example" }), "app.apps.googleusercontent.com", [jwk]), /not issued by Google/);
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  await assert.rejects(verifyIdToken(token(good(), "k1", other), "app.apps.googleusercontent.com", [jwk]), /bad signature/);
  await assert.rejects(verifyIdToken(token(good(), "nope"), "app.apps.googleusercontent.com", [jwk]), /unknown Google key/);
});

test("one Google account maps to one guest account, the same every time", () => {
  const env = { HOUSE_KEY: "ed25519:test-secret", HOUSE_ACCOUNT: "clonestown.testnet" };
  const a = googleGuest("1234", env);
  assert.match(a, /^g[a-z0-9]{6}\.clonestown\.testnet$/);
  assert.equal(googleGuest("1234", env), a);
  assert.notEqual(googleGuest("5678", env), a);
});
