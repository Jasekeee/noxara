// Verify a NEP-366 signed delegate action BEFORE spending anything on it:
//  1. the ed25519 signature over sha256(NEP-461 prefix || borsh(DelegateAction)) is valid, and
//  2. the signing key is an access key of the claimed sender (looked up once, then cached).
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

const NEP461_DELEGATE_PREFIX = 1073742190; // 2^30 + 366

export function signatureOk(payloadB64: string): { ok: boolean; publicKey?: string } {
  const bytes = Buffer.from(payloadB64, "base64");
  // SignedDelegateAction = DelegateAction ++ Signature(enum tag u8 + 64 bytes for ed25519)
  if (bytes.length < 66 || bytes[bytes.length - 65] !== 0) return { ok: false };
  const delegate = bytes.subarray(0, bytes.length - 65);
  const sig = bytes.subarray(bytes.length - 64);
  // the public key sits right before nothing else we need to parse: read it from the delegate's tail
  // DelegateAction = sender, receiver, actions, nonce(u64), max_block_height(u64), public_key(enum u8 + 32)
  if (delegate[delegate.length - 33] !== 0) return { ok: false };
  const pub = delegate.subarray(delegate.length - 32);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(NEP461_DELEGATE_PREFIX);
  const msg = sha256(Buffer.concat([prefix, delegate]));
  try {
    return { ok: ed25519.verify(sig, msg, pub), publicKey: `ed25519:${base58.encode(pub)}` };
  } catch {
    return { ok: false };
  }
}

/** sender:key -> expiry. Guests are added at creation; others are looked up once. */
export class KeyOwners {
  private known = new Map<string, number>();
  private rpc: string;
  private ttlMs: number;
  constructor(rpc: string, ttlMs = 15 * 60_000) {
    this.rpc = rpc;
    this.ttlMs = ttlMs;
  }
  add(sender: string, publicKey: string) {
    this.known.set(`${sender}:${publicKey}`, Date.now() + this.ttlMs);
    if (this.known.size > 100_000) for (const [k, t] of this.known) if (t < Date.now()) this.known.delete(k);
  }
  async owns(sender: string, publicKey: string): Promise<boolean> {
    const k = `${sender}:${publicKey}`;
    const t = this.known.get(k);
    if (t && t > Date.now()) return true;
    const r = await fetch(this.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key", finality: "optimistic", account_id: sender, public_key: publicKey } }),
    }).then((x) => x.json()).catch(() => null);
    if (!r?.result || r.error) return false;
    this.add(sender, publicKey);
    return true;
  }
}

/**
 * A settle request is authorised by the match's player: an ed25519 signature (base64) over
 * `settleMessage(matchId, inputLogHash)` by one of the player's access keys (checked by the
 * caller with `KeyOwners.owns`). Returns false for malformed input instead of throwing.
 */
export function settleSignatureOk(message: Uint8Array, publicKey: string, signatureB64: string): boolean {
  try {
    const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]{32,64})$/.exec(publicKey);
    if (!m) return false;
    const pub = base58.decode(m[1]);
    const sig = Buffer.from(signatureB64, "base64");
    if (pub.length !== 32 || sig.length !== 64) return false;
    return ed25519.verify(sig, message, pub);
  } catch {
    return false;
  }
}
