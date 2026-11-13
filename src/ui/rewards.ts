// Daily check-in + daily quests (contract daily.rs): paid by the House treasury (never minted), real accounts only,
// only matches paid from your own NOX count. Rendered on the DAILY page for signed-in players.
import type { DailyInfo, GameClientDaily } from "../net/api";
import { h } from "./dom";

const fmt = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export async function renderRewards(host: HTMLElement, client: GameClientDaily, toast: (msg: string, err?: boolean) => void): Promise<void> {
  const box = h("section", "rw-box");
  box.setAttribute("aria-label", "Daily rewards");
  host.prepend(box);
  const draw = (d: DailyInfo) => {
    box.textContent = "";
    box.appendChild(h("h3", "rw-title", "DAILY REWARDS"));
    box.appendChild(h("p", "sc-note", "Paid by the House treasury from fees it collected — never minted. Only matches paid from your own NOX count."));
    const streak = h("div", "rw-row", undefined, h("span", "", `Check-in streak: ${d.streak} day${d.streak === 1 ? "" : "s"}`), h("b", "", `+${fmt(d.nextReward)} NOX`));
    const btn = h("button", "btn-primary small", d.checkedInToday ? "CHECKED IN ✓" : "CHECK IN") as HTMLButtonElement;
    btn.disabled = !d.canCheckIn;
    if (!d.canCheckIn && d.whyNot && !d.checkedInToday) btn.title = d.whyNot;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const r = await client.checkIn();
        toast(`Checked in: +${fmt(r.paid)} NOX from the House`);
        draw(await client.daily());
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
        btn.disabled = false;
      }
    });
    streak.appendChild(btn);
    box.appendChild(streak);
    if (!d.canCheckIn && d.whyNot && !d.checkedInToday) box.appendChild(h("p", "sc-note", d.whyNot));
    const list = h("ul", "rw-quests");
    for (const q of d.quests) {
      const li = h("li", q.claimed ? "done" : "", undefined, h("span", "", `${q.title} — ${q.progress}/${q.goal}`), h("b", "", `+${fmt(q.reward)} NOX`));
      if (q.done && !q.claimed) {
        const c = h("button", "btn-ghost small", "CLAIM") as HTMLButtonElement;
        c.addEventListener("click", async () => {
          c.disabled = true;
          try {
            const r = await client.claimQuest(q.id);
            toast(`Quest done: +${fmt(r.paid)} NOX from the House`);
            draw(await client.daily());
          } catch (e) {
            toast(e instanceof Error ? e.message : String(e), true);
            c.disabled = false;
          }
        });
        li.appendChild(c);
      } else if (q.claimed) li.appendChild(h("span", "sc-tag", "CLAIMED"));
      list.appendChild(li);
    }
    box.appendChild(h("h4", "rw-sub", "TODAY'S QUESTS (verified on chain from your matches)"));
    box.appendChild(list);
    box.appendChild(h("p", "sc-note", "Social links (follow NEAR on X) carry no reward: we only pay for what the chain can verify."));
  };
  try {
    draw(await client.daily());
  } catch {
    box.remove();
  }
}
