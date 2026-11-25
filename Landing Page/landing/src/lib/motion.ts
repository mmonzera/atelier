import { spotlight } from "./pointer";
import { initNav } from "./nav";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
let cleanups: Array<() => void> = [];

function initReveal() {
  const els = document.querySelectorAll<HTMLElement>("[data-reveal]:not(.is-in)");
  if (reduced() || !("IntersectionObserver" in window)) {
    els.forEach((e) => e.classList.add("is-in"));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { en.target.classList.add("is-in"); io.unobserve(en.target); }
  }, { rootMargin: "0px 0px -10% 0px", threshold: 0.1 });
  els.forEach((e) => io.observe(e));
  cleanups.push(() => io.disconnect());
}

/** Pause loop CSS (edge-glow) saat di luar viewport. */
function initLoops() {
  const els = document.querySelectorAll<HTMLElement>(".btn-glow");
  if (!("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const t = en.target as HTMLElement;
      if (en.isIntersecting) t.removeAttribute("data-paused"); else t.setAttribute("data-paused", "");
    }
  });
  els.forEach((e) => { e.setAttribute("data-paused", ""); io.observe(e); });
  cleanups.push(() => io.disconnect());
}

function initSpotlight() {
  document.querySelectorAll<HTMLElement>(".glass-card").forEach((el) => cleanups.push(spotlight(el)));
}

export function initMotion() {
  cleanups.forEach((c) => c()); cleanups = [];
  initReveal(); initLoops(); initSpotlight();
  cleanups.push(initNav());
}
