import { LazyMotion, m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

const loadFeatures = () => import("./motionFeatures").then((r) => r.default);

interface Props { children: ReactNode; delay?: number; y?: number; className?: string }

/** Hanya opacity dan transform (§8.5). Reduced motion: tampil langsung. */
export default function Reveal({ children, delay = 0, y = 16, className }: Props) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <LazyMotion features={loadFeatures} strict>
      <m.div
        className={className}
        initial={{ opacity: 0, y }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-10% 0px" }}
        transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
      >
        {children}
      </m.div>
    </LazyMotion>
  );
}
