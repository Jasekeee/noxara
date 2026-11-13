// Shared by the browser client and the match server (isomorphic: no node: imports).
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { MatchRecord } from "../../src/sim/types.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Canonical hash of the input log, stored on chain: sha256(JSON.stringify(inputs)) as hex. */
export function inputLogHash(inputs: MatchRecord["inputs"]): string {
  return bytesToHex(sha256(utf8(JSON.stringify(inputs))));
}

/** What the player signs (raw ed25519) to authorise settlement of their match. */
export function settleMessage(matchId: string, logHash: string): Uint8Array {
  return sha256(utf8(`bountyroyale:settle:${matchId}:${logHash}`));
}
