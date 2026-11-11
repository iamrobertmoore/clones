// Each clone gets its own key, derived from the house's secret and the clone's account id, so no
// two clones share a key and the house can re-derive any clone's key without storing it. The key
// is still only ever a function-call key for the market's `trade`.

const crypto = require("crypto");
const { utils } = require("near-api-js");

const isClone = (id) => /^clone-[123]\./.test(id);

function cloneKey(houseSecret, cloneId) {
  const seed = crypto.createHmac("sha256", String(houseSecret).trim()).update(`clone-key:${cloneId}`).digest();
  // near-api-js derives the public key from the first 32 bytes (the seed).
  const extended = Buffer.concat([seed, Buffer.alloc(32)]);
  return new utils.KeyPairEd25519(utils.serialize.base_encode(extended));
}

module.exports = { cloneKey, isClone };
