import { test } from "node:test";
import assert from "node:assert/strict";
import { shortName } from "../src/client.ts";

test("relayer client shortName keeps the real NEAR suffix (guests and bots)", () => {
  assert.equal(shortName("g-3fa9.noxara.near"), "g-3fa9.noxara.near");
  for (const id of ["brindle.royale.br-7e8492.testnet", "g-490a458fa3.royale.br-7e8492.testnet", "brindle.noxara.near", "g-0123456789abcdef.noxara.near"]) {
    const s = shortName(id, 20);
    assert.ok(s.endsWith(id.endsWith(".testnet") ? ".testnet" : ".near"), `${id} -> ${s}`);
    assert.ok(id.endsWith(s.split("…").pop()!), `${id} -> ${s}`);
  }
});
