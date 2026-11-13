// Sign in with Google. POST /api/google {"credential": "<Google ID token>"}
//   -> {"guest", "token", "name", "exists", "inTown"}
//
// The token is verified here with Google's published keys. The guest account is derived from the
// Google account (lib/google.js), so the same person gets the same account on any device, and the
// page gets the same player token sign-up hands out (lib/player.js).

const { verifyIdToken, googleGuest } = require("../lib/google.js");
const { claimToken } = require("./enlist.js");
const { openTown, readState, patient } = require("../lib/night.js");
const { body } = require("../lib/player.js");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const b = body(req);
  let claims;
  try {
    claims = await verifyIdToken(b.credential, process.env.GOOGLE_CLIENT_ID);
  } catch (e) {
    res.status(401).json({ error: `Google sign-in did not check out: ${e.message}` });
    return;
  }
  try {
    const guest = googleGuest(claims.sub);
    const t = await openTown();
    let exists = true;
    try {
      await patient(() => t.near.connection.provider.query({ request_type: "view_account", finality: "optimistic", account_id: guest }));
    } catch {
      exists = false;
    }
    const { clones } = exists ? await readState(t) : { clones: [] };
    const inTown = clones.filter((c) => c.player === guest).length;
    res.status(200).json({ guest, token: claimToken(guest), name: claims.given_name || claims.name || "", exists, inTown });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not reach the chain. Try again in a moment." });
  }
};
