/**
 * The weirdvault mark.
 *
 * A vault door with a prompt inside it. The two halves of the name are the two
 * halves of the product — an encrypted vault the server cannot open, and a
 * terminal — so the mark is the chevron-and-cursor of a shell sitting inside a
 * door with a seam down it.
 *
 * Drawn on a 32-unit grid with nothing thinner than two units, because the size
 * it has to survive is 16 pixels in a browser tab. Detail that reads at 512 and
 * turns to mush at 16 is worse than no detail: the favicon is the only place
 * most people will ever see this.
 *
 * `currentColor` throughout, so the same file is a sidebar glyph, a marketing
 * header and a 180-pixel touch icon without a second copy. The standalone
 * `app/icon.svg` is the exception and has colours baked in, because a favicon
 * is rendered with no CSS around it.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* The door. Two arcs rather than one rect: the gap on the right edge is
          the seam it opens on, and it is what stops this reading as a generic
          rounded square at a glance. */}
      <path
        d="M20 4.2H10A5.8 5.8 0 0 0 4.2 10v12A5.8 5.8 0 0 0 10 27.8h10"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M24 6.1A5.8 5.8 0 0 1 27.8 11.5v9A5.8 5.8 0 0 1 24 25.9"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />

      {/* The prompt: chevron and cursor, the shape a terminal has had since
          before any of this. */}
      <path
        d="m11.4 12.2 3.6 3.8-3.6 3.8"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M17.6 19.8h3.8" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  )
}
