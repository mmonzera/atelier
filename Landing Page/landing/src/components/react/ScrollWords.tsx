import { useEffect, useRef, useState, type RefObject } from "react";
import {
  LazyMotion,
  domAnimation,
  m,
  useReducedMotion,
  useScroll,
  useTransform,
  type MotionValue,
} from "motion/react";

interface WordProps {
  children: string;
  index: number;
  total: number;
  progress: MotionValue<number>;
  ready: boolean;
  reduced: boolean;
  accent: boolean;
}

/** Satu kata = satu useTransform, sesuai PRD 8.2. Hanya opacity yang berubah. */
function Word({ children, index, total, progress, ready, reduced, accent }: WordProps) {
  const start = total > 1 ? (index / total) * 0.82 : 0;
  const end = Math.min(1, start + 0.2);
  const opacity = useTransform(progress, [start, end], [0.18, 1]);

  // Sebelum hydrate (dan saat reduced-motion) kata tetap terbaca penuh, jadi tidak ada
  // teks yang hilang kalau JS gagal jalan.
  return (
    <m.span
      className={accent ? "sw__word sw__word--accent" : "sw__word"}
      style={ready && !reduced ? { opacity } : undefined}
    >
      {children}
    </m.span>
  );
}

interface Props {
  text: string;
  accent?: string;
}

export default function ScrollWords({ text, accent }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion() ?? false;
  const [ready, setReady] = useState(false);

  const { scrollYProgress } = useScroll({
    target: ref as unknown as RefObject<HTMLElement | null>,
    offset: ["start 0.85", "end 0.5"],
  });

  useEffect(() => setReady(true), []);

  const head = text.split(/\s+/).filter(Boolean);
  const tail = (accent ?? "").split(/\s+/).filter(Boolean);
  const total = head.length + tail.length;

  return (
    <LazyMotion features={domAnimation} strict>
      <div ref={ref} className="sw">
        <p className="sw__text">
          <span className="sw__sr">{[...head, ...tail].join(" ")}</span>
          <span aria-hidden="true">
            {head.map((word, i) => (
              <Word
                key={`h${i}`}
                index={i}
                total={total}
                progress={scrollYProgress}
                ready={ready}
                reduced={reduced}
                accent={false}
              >
                {word}
              </Word>
            ))}
            {tail.map((word, i) => (
              <Word
                key={`t${i}`}
                index={head.length + i}
                total={total}
                progress={scrollYProgress}
                ready={ready}
                reduced={reduced}
                accent
              >
                {word}
              </Word>
            ))}
          </span>
        </p>
      </div>
    </LazyMotion>
  );
}
