// In-match menu: ⏸ button + Esc/P overlay (Resume, Sound, Aim assist, Controls, Exit to lobby).
// Chain matches keep ticking underneath (honest note); offline practice really pauses (game.ts reads `paused`).
import { h } from "./dom";

export interface MenuDeps {
  /** menu may open right now (a match is being played, not the end screen / lobby) */
  canOpen(): boolean;
  /** offline practice: the game really stops while the menu is open */
  offline(): boolean;
  muted(): boolean;
  toggleMute(): void;
  aimAssist(): boolean;
  setAimAssist(on: boolean): void;
  /** leave the match (game decides what that means for chain matches: left unsettled) */
  exit(): void;
  onChange(open: boolean): void;
  sfx(): void;
}

const PAUSE_PATH = "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z";

export class PauseMenu {
  open = false;
  readonly btn: HTMLButtonElement;
  private root: HTMLElement;
  private card: HTMLElement;
  private returnFocus: HTMLElement | null = null;

  constructor(private d: MenuDeps) {
    this.btn = h("button", "icon-btn pause-btn");
    this.btn.type = "button";
    this.btn.id = "pause-btn";
    this.btn.setAttribute("aria-label", "Pause menu (Esc)");
    this.btn.title = "Menu (Esc)";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", PAUSE_PATH);
    svg.appendChild(p);
    this.btn.appendChild(svg);
    this.btn.addEventListener("click", () => this.show());

    this.card = h("div", "modal-card pause-card");
    this.root = h("div", "modal pause hidden", undefined, this.card);
    this.root.id = "pause";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-labelledby", "pause-title");
    // never let a click on the overlay reach the game's pointer handlers (it would start a stick)
    for (const t of ["pointerdown", "pointerup", "pointermove"]) this.root.addEventListener(t, (e) => e.stopPropagation());

    addEventListener("keydown", (e) => {
      if (this.open) {
        if (e.code === "Escape") { e.preventDefault(); e.stopPropagation(); this.confirming ? this.render() : this.hide(); }
        else if (e.code === "Tab") this.trap(e);
        return;
      }
      if ((e.code === "Escape" || e.code === "KeyP") && !e.repeat && this.d.canOpen()) { e.preventDefault(); this.show(); }
    });
  }

  mount(app: HTMLElement, hud: HTMLElement) {
    hud.appendChild(this.btn);
    app.appendChild(this.root);
  }

  private confirming = false;

  show() {
    if (this.open || !this.d.canOpen()) return;
    this.open = true;
    this.confirming = false;
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.root.classList.remove("hidden");
    this.render();
    this.d.sfx();
    this.d.onChange(true);
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.confirming = false;
    this.root.classList.add("hidden");
    this.d.sfx();
    this.d.onChange(false);
    (this.returnFocus && document.contains(this.returnFocus) ? this.returnFocus : document.getElementById("view"))?.focus?.({ preventScroll: true });
  }

  /** close without sounds/focus work (match ended, left, etc.) */
  forceClose() {
    if (!this.open) return;
    this.open = false;
    this.confirming = false;
    this.root.classList.add("hidden");
    this.d.onChange(false);
  }

  private trap(e: KeyboardEvent) {
    const els = [...this.card.querySelectorAll<HTMLElement>("button, [href], input, [tabindex]:not([tabindex='-1'])")].filter((x) => !x.hasAttribute("disabled"));
    if (!els.length) return;
    const first = els[0], last = els[els.length - 1];
    const a = document.activeElement;
    if (!this.card.contains(a)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
  }

  private btnEl(label: string, cls: string, fn: () => void, aria?: string) {
    const b = h("button", cls, label);
    b.type = "button";
    if (aria) b.setAttribute("aria-label", aria);
    b.addEventListener("click", fn);
    return b;
  }

  private render() {
    this.confirming = false;
    const c = this.card;
    c.textContent = "";
    const title = h("h2", "", "PAUSED");
    title.id = "pause-title";
    const note = h("p", "pause-note", this.d.offline() ? "Practice match: the game is paused." : "The match continues while this menu is open.");
    const resume = this.btnEl("RESUME", "btn-primary", () => this.hide());
    const toggle = (label: string, on: () => boolean, fn: () => void) => {
      const b = h("button", "btn-ghost pause-toggle") as HTMLButtonElement;
      b.type = "button";
      const upd = () => {
        b.textContent = `${label}: ${on() ? "ON" : "OFF"}`;
        b.setAttribute("aria-pressed", String(on()));
      };
      upd();
      b.addEventListener("click", () => { fn(); upd(); });
      return b;
    };
    const sound = toggle("SOUND", () => !this.d.muted(), () => this.d.toggleMute());
    const assist = toggle("AIM ASSIST", () => this.d.aimAssist(), () => this.d.setAimAssist(!this.d.aimAssist()));
    const help = h("div", "pause-help hidden");
    help.id = "pause-help";
    help.append(
      h("h3", "", "Desktop"),
      h("p", "", "WASD / arrows move. Mouse aims. Click or Space fires. Hold fire and keep the mouse still to auto-aim at the nearest enemy you can see. M mutes, Esc or P opens this menu."),
      h("h3", "", "Touch"),
      h("p", "", "Left thumb moves. Tap the right side to auto-aim and fire at the nearest visible enemy; drag the right thumb to aim by hand (it nudges onto a target that is close to your line)."),
    );
    const hb = this.btnEl("CONTROLS", "btn-ghost", () => {
      const hidden = help.classList.toggle("hidden");
      hb.setAttribute("aria-expanded", String(!hidden));
    });
    hb.setAttribute("aria-expanded", "false");
    hb.setAttribute("aria-controls", "pause-help");
    const exit = this.btnEl("EXIT TO LOBBY", "btn-ghost danger", () => this.confirm());
    c.append(title, note, resume, sound, assist, hb, help, exit);
    resume.focus();
  }

  private confirm() {
    this.confirming = true;
    const c = this.card;
    c.textContent = "";
    const title = h("h2", "", "Leave the match?");
    title.id = "pause-title";
    const stay = this.btnEl("STAY", "btn-primary", () => this.render());
    const leave = this.btnEl("LEAVE", "btn-ghost danger", () => { this.forceClose(); this.d.exit(); });
    c.append(title, h("p", "pause-note", "It counts as a loss."), stay, leave);
    stay.focus();
  }
}
