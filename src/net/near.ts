// Minimal, dependency-free NEAR primitives for the browser (and Node 24): ed25519 keys via WebCrypto,
// base58, borsh for NEP-366 delegate actions, sha256, JSON-RPC views. Enough for a guest that signs
// gasless meta-transactions; the relayer submits them.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
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

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return new Uint8Array(out);
}

export const toBase64 = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};

const utf8 = (s: string) => new TextEncoder().encode(s);

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Canonical hash of a record's input log (= relayer/src/protocol.ts inputLogHash). */
export async function inputLogHash(inputs: unknown): Promise<string> {
  return hex(await sha256(JSON.stringify(inputs)));
}

/** What the player signs to authorise settlement (= relayer/src/protocol.ts settleMessage). */
export function settleMessage(matchId: string, logHash: string): Promise<Uint8Array> {
  return sha256(`bountyroyale:settle:${matchId}:${logHash}`);
}

// ---------------------------------------------------------------- ed25519 (WebCrypto)

export type StoredKey = { jwk: JsonWebKey; publicKey: string };

export async function ed25519Supported(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    return true;
  } catch {
    return false;
  }
}

export async function generateKey(): Promise<StoredKey> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { jwk, publicKey: `ed25519:${base58Encode(raw)}` };
}

export class Signer {
  private key: CryptoKey;
  readonly publicKey: string;
  private constructor(key: CryptoKey, publicKey: string) {
    this.key = key;
    this.publicKey = publicKey;
  }
  static async load(k: StoredKey): Promise<Signer> {
    const key = await crypto.subtle.importKey("jwk", k.jwk, { name: "Ed25519" }, false, ["sign"]);
    return new Signer(key, k.publicKey);
  }
  async sign(msg: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, this.key, msg as BufferSource));
  }
  get publicKeyBytes(): Uint8Array {
    return base58Decode(this.publicKey.slice("ed25519:".length));
  }
}

// ---------------------------------------------------------------- borsh (NEP-366)

class W {
  private parts: number[] = [];
  u8(x: number) {
    this.parts.push(x & 255);
  }
  u32(x: number) {
    for (let i = 0; i < 4; i++) this.parts.push((x >>> (8 * i)) & 255);
  }
  uN(x: bigint, bytes: number) {
    for (let i = 0; i < bytes; i++) this.parts.push(Number((x >> BigInt(8 * i)) & 255n));
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.parts.push(x);
  }
  vec(b: Uint8Array) {
    this.u32(b.length);
    this.bytes(b);
  }
  str(s: string) {
    this.vec(utf8(s));
  }
  out() {
    return new Uint8Array(this.parts);
  }
}

export type FunctionCall = { methodName: string; args: unknown; gas: bigint; deposit?: bigint };

/** borsh(DelegateAction) with one or more FunctionCall actions. */
export function encodeDelegate(d: { senderId: string; receiverId: string; actions: FunctionCall[]; nonce: bigint; maxBlockHeight: bigint; publicKey: Uint8Array }): Uint8Array {
  const w = new W();
  w.str(d.senderId);
  w.str(d.receiverId);
  w.u32(d.actions.length);
  for (const a of d.actions) {
    w.u8(2); // Action::FunctionCall
    w.str(a.methodName);
    w.vec(utf8(JSON.stringify(a.args ?? {})));
    w.uN(a.gas, 8);
    w.uN(a.deposit ?? 0n, 16);
  }
  w.uN(d.nonce, 8);
  w.uN(d.maxBlockHeight, 8);
  w.u8(0); // KeyType::ED25519
  w.bytes(d.publicKey);
  return w.out();
}

const NEP461_DELEGATE_PREFIX = 2 ** 30 + 366;

/** base64(borsh(SignedDelegateAction)) — what the relayer's /api/relay expects as `payload`. */
export async function signDelegate(signer: Signer, d: { senderId: string; receiverId: string; actions: FunctionCall[]; nonce: bigint; maxBlockHeight: bigint }): Promise<string> {
  const delegate = encodeDelegate({ ...d, publicKey: signer.publicKeyBytes });
  const prefix = new W();
  prefix.u32(NEP461_DELEGATE_PREFIX);
  const msg = new Uint8Array([...prefix.out(), ...delegate]);
  const sig = await signer.sign(await sha256(msg));
  return toBase64(new Uint8Array([...delegate, 0, ...sig]));
}

// ---------------------------------------------------------------- RPC

export async function rpc<T>(url: string, method: string, params: unknown, timeoutMs = 8000): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error?.cause?.name ?? j.error?.message ?? "rpc error");
  return j.result as T;
}

export async function viewCall<T>(url: string, contract: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>(url, "query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: contract,
    method_name: method,
    args_base64: toBase64(utf8(JSON.stringify(args))),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T;
}
