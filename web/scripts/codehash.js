// Print a wasm file's code hash as NEAR reports it (view_account code_hash): base58 of its sha256.
//
//     node scripts/codehash.js api/leash.wasm

const crypto = require("crypto");
const fs = require("fs");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

const codeHash = (wasm) => base58(crypto.createHash("sha256").update(wasm).digest());

if (require.main === module) console.log(codeHash(fs.readFileSync(process.argv[2])));
module.exports = { codeHash, base58 };
