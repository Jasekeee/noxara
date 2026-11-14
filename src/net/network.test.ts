import { describe, expect, it } from "vitest";
import { NETWORK_DEFAULTS } from "./client";

describe("mainnet config produces .noxara.near everywhere", () => {
  it("mainnet defaults: contract noxara.near, mainnet RPC/explorer", () => {
    expect(NETWORK_DEFAULTS.mainnet.contract).toBe("noxara.near");
    expect(NETWORK_DEFAULTS.mainnet.explorer).toBe("https://nearblocks.io");
    expect(NETWORK_DEFAULTS.mainnet.rpc).not.toMatch(/test/);
  });
  it("bots on mainnet are <name>.noxara.near (deploy.ts: contract on the root, bots = <name>.<contract>)", () => {
    const contract = NETWORK_DEFAULTS.mainnet.contract;
    for (const b of ["brindle", "quillon", "vesper", "magpie", "tallow", "dorrit", "zinnia", "okapi", "fenwick"]) expect(`${b}.${contract}`).toMatch(/^[a-z]+\.noxara\.near$/);
  });
  it("testnet stays on .testnet", () => {
    expect(NETWORK_DEFAULTS.testnet.contract.endsWith(".testnet")).toBe(true);
  });
});
