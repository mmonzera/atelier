/** Satu listener pointermove per elemen, di-throttle lewat rAF. */
export function spotlight(el: HTMLElement): () => void {
  if (matchMedia("(hover: none)").matches) return () => {};
  let raf = 0, x = 0, y = 0;
  const flush = () => {
    raf = 0;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${x - r.left}px`);
    el.style.setProperty("--my", `${y - r.top}px`);
  };
  const onMove = (e: PointerEvent) => {
    x = e.clientX; y = e.clientY;
    if (!raf) raf = requestAnimationFrame(flush);
  };
  el.addEventListener("pointermove", onMove, { passive: true });
  return () => { el.removeEventListener("pointermove", onMove); if (raf) cancelAnimationFrame(raf); };
}
