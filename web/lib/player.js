// Shared by the player's endpoints: read a JSON body and check that the request comes from the
// browser that sent this guest's clones in (it holds the token sign-up returned).

const { claimToken } = require("../api/enlist.js");

function body(req) {
  let b = req.body;
  if (typeof b === "string") {
    try {
      b = JSON.parse(b);
    } catch {
      b = {};
    }
  }
  return b || {};
}

// Returns {guest, clone} or sends an error and returns null.
function authorise(req, res, house) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return null;
  }
  const b = body(req);
  const guest = String(b.guest || "");
  const clone = String(b.clone || "");
  if (!guest.endsWith(`.${house}`) || String(b.token || "") !== claimToken(guest)) {
    res.status(403).json({ error: "Only the browser that sent these clones in can do that." });
    return null;
  }
  if (clone && !/^clone-[123]\./.test(clone)) {
    res.status(400).json({ error: "That is not one of your clones." });
    return null;
  }
  if (clone && clone.slice(clone.indexOf(".") + 1) !== guest) {
    res.status(403).json({ error: "That clone is not yours." });
    return null;
  }
  return { guest, clone, body: b };
}

module.exports = { body, authorise };
