import { describe, expect, it } from "vitest";
import { truncAcct } from "../../src/net/acctname";
import { shortName } from "../../relayer/src/client";

const hex = "a".repeat(20) + "0123456789".repeat(4) + "abcd";
const cases: [string, string][] = [
  ["testnet bot", "brindle.royale.br-7e8492.testnet"],
  ["mainnet bot", "brindle.noxara.near"],
  ["mainnet guest", "g-3fa9c2.noxara.near"],
  ["old testnet guest", "g-3fa9c2.relay.br-7e8492.testnet"],
  ["long testnet guest", "g-3fa9c2deadbeef01.relay.br-7e8492.testnet"],
  ["real player", "alice.near"],
  ["long real player", "very-long-player-name-here.near"],
  ["long real testnet", "somebody-with-a-long-name.testnet"],
];
describe("account name truncation", () => {
  for (const [label, id] of cases)
    for (const max of [20, 22, 28]) {
      it(`${label} keeps its suffix (max ${max})`, () => {
        for (const f of [(x: string) => truncAcct(x, max), (x: string) => shortName(x, max)]) {
          const s = f(id);
          expect(s.endsWith(id.split(".").slice(-1)[0] === "near" ? ".near" : ".testnet")).toBe(true);
          expect(id.endsWith(s.split("…").pop()!)).toBe(true);
          if (id.length > max) expect(s.length).toBeLessThanOrEqual(max + 1);
          if (!s.includes("…")) expect(s).toBe(id);
        }
      });
    }
  it("short ids are untouched; no invented names", () => {
    expect(truncAcct("alice.near")).toBe("alice.near");
    expect(shortName("g-3fa9.noxara.near")).toBe("g-3fa9.noxara.near");
    expect(truncAcct("g-3fa9c2deadbeef01.relay.br-7e8492.testnet", 24)).toMatch(/^g-3fa9.*…br-7e8492\.testnet$/);
  });
  it("64-hex implicit accounts keep head and tail", () => {
    expect(hex.length).toBe(64);
    expect(truncAcct(hex)).toBe(`${hex.slice(0, 8)}…${hex.slice(-6)}`);
  });
});
