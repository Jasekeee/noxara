import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SpendBudget, RESERVE, near } from "../src/budget.ts";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "budget-")), "b.json");
// measured on testnet: a new guest = 0.003 funding + 0.01514 storage + ~0.006 gas (account + first start)
const PER_GUEST = near("0.0242");

test("a 0.25 NEAR guest budget closes after ~9 new guests; the real-account budget is separate and stays open", () => {
  const guests = new SpendBudget(tmp(), "0.25", 1000);
  const real = new SpendBudget(tmp(), "1", Number.MAX_SAFE_INTEGER);
  let n = 0;
  while (!guests.closed("guest", RESERVE.guest)) {
    guests.spend(PER_GUEST, "guest");
    n++;
  }
  assert.equal(guests.closed("guest", RESERVE.guest), "budget");
  assert.ok(n >= 9 && n <= 10, `guests before closing: ${n}`);
  assert.equal(guests.status().guests, "closed");
  assert.equal(real.closed("register", RESERVE.register), null);
  assert.equal(real.closed("relay", RESERVE.relay), null);
});

test("the daily guest cap closes new guests for the rest of the UTC day, then reopens", () => {
  const day = 86_400_000;
  const g = new SpendBudget(tmp(), "0.25", 3, 10 * day);
  for (let i = 0; i < 3; i++) g.spend(near("0.001"), "guest");
  assert.equal(g.closed("guest", RESERVE.guest, 10 * day + 1000), "daily_cap");
  assert.equal(g.closed("guest", RESERVE.guest, 11 * day + 1), null);
});
