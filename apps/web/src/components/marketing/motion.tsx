"use client";

/**
 * Scroll motion for the marketing pages, built on browser primitives.
 *
 * No animation library. The app ships a 6 MB WASM SSH core and a Monaco editor
 * already, and adding a motion runtime so a landing page can fade some headings
 * in would be a poor trade on a page whose whole argument is that it is light.
 * IntersectionObserver covers reveals, one rAF-throttled scroll listener covers
 * the parallax, and CSS does the rest.
 *
 * Two rules everything here follows:
 *
 *  - Reduced motion is honoured by not animating at all, not by animating
 *    faster. Under the media query these components render their content in the
 *    final state on first paint and never attach a listener.
 *  - Content is visible without JavaScript. Reveals start visible and are hidden
 *    by an effect only once we know we can un-hide them, so a failed hydration
 *    leaves a readable page rather than a blank one. That ordering matters more
 *    than the flash it costs.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { cn } from "@/lib/utils";

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Reveals its children once they scroll into view.
 *
 * `delay` staggers siblings. Keep it under about 400ms — past that it stops
 * reading as one group arriving and starts reading as the page being slow.
 */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(true);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const el = ref.current;
    if (!el) return;

    // Hide only now that an observer is definitely coming to un-hide it.
    setShown(false);

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setShown(true);
          io.disconnect(); // one-way: re-hiding on scroll-up is nauseating
        }
      },
      // Fire slightly before the element is fully on screen, so the motion has
      // finished by the time it is centred and being read.
      { rootMargin: "0px 0px -12% 0px", threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={cn(shown ? "animate-rise" : "opacity-0", className)}
      style={shown && delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

/**
 * Publishes scroll progress through this element as a CSS variable.
 *
 * `--p` runs 0 → 1 as the element crosses the viewport, so the transforms that
 * consume it live in CSS and stay off the main thread. A React state update per
 * scroll frame would re-render the subtree sixty times a second to move one
 * element, which is the usual reason scroll effects feel worse than no effect.
 */
export function ScrollScene({
  children,
  className,
  style,
  decorative = false,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /**
   * Named rather than spread from `...rest`, so that passing `aria-hidden`
   * cannot silently do nothing. It did exactly that for a while: the prop was
   * accepted at the call site, dropped here, and the hero backdrop was in the
   * accessibility tree the whole time.
   */
  decorative?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const el = ref.current;
    if (!el) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      // 0 when the top edge is at the bottom of the viewport, 1 once the
      // element's bottom edge has passed the top.
      const raw = (vh - rect.top) / (vh + rect.height);
      el.style.setProperty("--p", String(Math.min(1, Math.max(0, raw))));
    };
    const onScroll = () => {
      // Coalesce to one write per frame; scroll fires far more often than that.
      if (!frame) frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden={decorative || undefined}
      className={className}
      style={{ "--p": 0, ...style } as CSSProperties}
    >
      {children}
    </div>
  );
}

/**
 * A card that tilts toward the pointer.
 *
 * Deliberately small — six degrees, not twenty. The effect should register as
 * the surface having depth, not as the card flinching away from the cursor.
 * Pointer-driven only: it never fires on touch, where there is no hover state
 * to speak of and a tilt would just fight the scroll.
 */
export function TiltCard({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType !== "mouse" || prefersReducedMotion()) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.style.setProperty("--tilt-x", `${(-y * 6).toFixed(2)}deg`);
    el.style.setProperty("--tilt-y", `${(x * 6).toFixed(2)}deg`);
    // Where the sheen sits, so the highlight tracks the pointer rather than
    // sitting in a fixed corner while the card moves under it.
    el.style.setProperty("--mx", `${((x + 0.5) * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${((y + 0.5) * 100).toFixed(1)}%`);
  }

  function reset() {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--tilt-x", "0deg");
    el.style.setProperty("--tilt-y", "0deg");
  }

  return (
    <div
      ref={ref}
      onPointerMove={onPointerMove}
      onPointerLeave={reset}
      className={cn(
        "group relative [transform:perspective(900px)_rotateX(var(--tilt-x,0deg))_rotateY(var(--tilt-y,0deg))] transition-transform duration-200 ease-out",
        className,
      )}
      style={{ transformStyle: "preserve-3d" }}
    >
      {children}
    </div>
  );
}
