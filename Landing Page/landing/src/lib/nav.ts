import { PREF_KEY } from "./i18n";

/** Scroll progress + scroll-spy + mobile sheet. Mengembalikan fungsi cleanup. */
export function initNav(): () => void {
  const root = document.querySelector<HTMLElement>("[data-nav]");
  if (!root) return () => {};
  const off: Array<() => void> = [];

  // --- Scroll progress (transform saja, satu rAF per frame) ---
  const bar = root.querySelector<HTMLElement>("[data-progress]");
  if (bar) {
    let ticking = false;
    const update = () => {
      ticking = false;
      const max = document.documentElement.scrollHeight - innerHeight;
      bar.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
    };
    const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } };
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll, { passive: true });
    update();
    off.push(() => { removeEventListener("scroll", onScroll); removeEventListener("resize", onScroll); });
  }

  // --- Scroll-spy ---
  const spyLinks = root.querySelectorAll<HTMLAnchorElement>("[data-spy]");
  const ids = [...new Set([...spyLinks].map((a) => a.dataset.spy!))];
  const sections = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
  if (sections.length && "IntersectionObserver" in window) {
    const setActive = (id: string | null) =>
      spyLinks.forEach((a) => (a.dataset.spy === id ? a.setAttribute("aria-current", "true") : a.removeAttribute("aria-current")));
    const io = new IntersectionObserver((entries) => {
      const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (hit) setActive(hit.target.id);
      else if (scrollY < innerHeight * 0.3) setActive(null);
    }, { rootMargin: "-40% 0px -55% 0px", threshold: [0, 0.25, 0.5, 1] });
    sections.forEach((s) => io.observe(s));
    off.push(() => io.disconnect());
  }

  // --- Mobile sheet ---
  const toggle = root.querySelector<HTMLButtonElement>(".nav-toggle");
  const sheet = root.querySelector<HTMLElement>("#nav-sheet");
  if (toggle && sheet) {
    const set = (open: boolean) => {
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", (open ? toggle.dataset.closeLabel : toggle.dataset.openLabel) ?? "");
      sheet.hidden = !open;
      document.body.toggleAttribute("data-sheet-open", open);
    };
    const onToggle = () => set(sheet.hidden);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sheet.hidden) { set(false); toggle.focus(); }
    };
    const onSheetClick = (e: Event) => { if ((e.target as HTMLElement).closest("a")) set(false); };
    const mq = matchMedia("(min-width: 900px)");
    const onMq = () => { if (mq.matches) set(false); };
    toggle.addEventListener("click", onToggle);
    sheet.addEventListener("click", onSheetClick);
    document.addEventListener("keydown", onKey);
    mq.addEventListener("change", onMq);
    off.push(() => {
      toggle.removeEventListener("click", onToggle);
      sheet.removeEventListener("click", onSheetClick);
      document.removeEventListener("keydown", onKey);
      mq.removeEventListener("change", onMq);
      document.body.removeAttribute("data-sheet-open");
    });
  }

  // --- Simpan preferensi bahasa saat user memilih ---
  const onLang = (e: Event) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("[data-lang]");
    if (a?.dataset.lang) { try { localStorage.setItem(PREF_KEY, a.dataset.lang); } catch { /* storage diblokir */ } }
  };
  root.addEventListener("click", onLang);
  off.push(() => root.removeEventListener("click", onLang));

  return () => off.forEach((f) => f());
}
