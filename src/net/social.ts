// Browser side of "Challenge a friend" and the "Daily tournament" (docs/SOCIAL.md). Plain fetch to the
// relayer; never throws (the UI shows a friendly message when the server is unreachable).
import { SIM_VERSION, type MatchConfig, type MatchRecord } from "../sim/types";
import type { FighterSpec } from "../sim/types";

const env = ((import.meta as { env?: Record<string, string | undefined> }).env ?? {}) as Record<string, string | undefined>;
export const SOCIAL_BASE = (env.VITE_RELAYER_URL ?? "http://127.0.0.1:8788").replace(/\/$/, "");

export interface RunResult {
  name: string;
  placement: number;
  kills: number;
  ticksSurvived: number;
  ticksTotal: number;
  bountyKilled: boolean;
  won: boolean;
}
export interface ChallengeInfo {
  id: string;
  result: RunResult;
  bountyCarrier: string | null;
  cfg: MatchConfig;
  token: string;
  answers: Omit<RunResult, "ticksTotal">[];
  maxAnswers: number;
}
export interface AnswerResult {
  ok: true;
  you: RunResult;
  them: RunResult;
  winner: "you" | "them" | "tie";
  answers: number;
  bountyCarrier: string | null;
}
export interface DailyInfo {
  day: string;
  seed: number;
  roster: FighterSpec[];
  endsAt: number;
  token: string;
  players: number;
}
export interface DailyRow {
  rank: number;
  name: string;
  kind: "real" | "guest" | "unverified";
  account: string | null;
  placement: number;
  kills: number;
  ticksSurvived: number;
  bountyKilled: boolean;
  earns: 0 | null;
}
export interface DailyBoard {
  day: string;
  seed: number;
  endsAt: number;
  total: number;
  rows: DailyRow[];
}
export interface DailySubmitResult {
  ok: true;
  day: string;
  kind: "real" | "guest" | "unverified";
  name: string;
  earns: 0 | null;
  improved: boolean;
  rank: number;
  run: { placement: number; kills: number; ticksSurvived: number; bountyKilled: boolean };
  best: { placement: number; kills: number; ticksSurvived: number };
}

export type Res<T> = { ok: true; json: T } | { ok: false; status: number; code: string; error: string };

async function call<T>(path: string, body?: unknown, timeoutMs = 6000): Promise<Res<T>> {
  try {
    const r = await fetch(SOCIAL_BASE + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await r.json().catch(() => ({}))) as T & { error?: string; code?: string };
    if (!r.ok) return { ok: false, status: r.status, code: json.code ?? "refused", error: json.error ?? `HTTP ${r.status}` };
    return { ok: true, json };
  } catch {
    return { ok: false, status: 0, code: "unreachable", error: "Can't reach the NOXARA server right now." };
  }
}

const sv = { simVersion: SIM_VERSION };
export const social = {
  createChallenge: (record: MatchRecord, name: string) =>
    call<{ id: string; path: string; result: RunResult }>("/api/challenge", { record, name, game: location.origin + location.pathname, ...sv }, 20_000),
  getChallenge: (id: string) => call<ChallengeInfo>(`/api/challenge/${encodeURIComponent(id)}`),
  answerChallenge: (id: string, token: string, record: MatchRecord, name: string) =>
    call<AnswerResult>(`/api/challenge/${encodeURIComponent(id)}/answer`, { record, token, name, ...sv }, 20_000),
  daily: () => call<DailyInfo>("/api/daily"),
  leaderboard: (day?: string) => call<DailyBoard>(`/api/daily/leaderboard${day ? `?day=${day}` : ""}`),
  submitDaily: (record: MatchRecord, token: string, who: Record<string, unknown>) => call<DailySubmitResult>("/api/daily/submit", { record, token, ...who, ...sv }, 20_000),
};

// ------------------------------------------------------------------ small local identity (no wallet needed)
const GID_KEY = "noxara.gid.v1";
const NAME_KEY = "noxara.name.v1";
let memGid: string | null = null;
export function guestId(): string {
  try {
    let g = localStorage.getItem(GID_KEY);
    if (!g || !/^[a-z0-9]{8,32}$/.test(g)) {
      g = randomId();
      localStorage.setItem(GID_KEY, g);
    }
    return g;
  } catch {
    return (memGid ??= randomId());
  }
}
function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
export const guestName = () => `Guest ${guestId().slice(0, 4)}`;
export function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}
export function saveName(n: string) {
  try {
    localStorage.setItem(NAME_KEY, n);
  } catch {
    /* private mode */
  }
}
