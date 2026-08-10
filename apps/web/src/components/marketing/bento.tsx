"use client";

/**
 * The feature bento.
 *
 * One idea per cell: a large tonal object, a two-line title, two lines of copy.
 * An earlier version put an icon, a heading and a paragraph in every box, which
 * is a list of assertions wearing a grid's clothes — every cell the same weight,
 * the reader doing all the work.
 *
 * The objects are built rather than rendered or downloaded. Each is a Phosphor
 * glyph turned in perspective and stacked three deep — a dark offset copy for
 * the extrusion, the face, and a light copy clipped to the top edge — which
 * reads as a matte solid under a single soft light. That is a lot of trouble to
 * avoid a few hundred kilobytes of PNG, and it is worth it: it stays sharp at
 * any density, it re-tones itself from the theme tokens, and a landing page
 * whose argument is that the product is light should not open with a megabyte
 * of hero art.
 *
 * Tonal on purpose. The palette here is greys with the brand colour used once,
 * on the cell that matters most, so it lands as emphasis instead of decoration.
 *
 * All motion is hover-driven CSS plus the tilt from TiltCard. Nothing runs a
 * loop or holds state, so an idle section costs one paint, and the global
 * reduced-motion rule in globals.css flattens every duration without changing
 * the layout.
 */

import Link from "next/link";
import {
  ArrowUpRightIcon,
  CloudCheckIcon,
  FolderOpenIcon,
  KeyIcon,
  PlayCircleIcon,
  ShieldCheckIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react/dist/ssr";

import { TiltCard } from "@/components/marketing/motion";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------- sculpture */

/**
 * A glyph made to look like a solid object under one light.
 *
 * Three layers: an offset dark copy for the extruded body, the face itself, and
 * a highlight copy clipped to its top half. The perspective is shared with the
 * cell so objects across the grid look lit from the same direction — vary it
 * per cell and the section stops reading as one surface.
 */
function Sculpture({
  icon,
  className,
  accent = false,
}: {
  icon: React.ReactNode;
  className?: string;
  accent?: boolean;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute [transform:perspective(900px)_rotateX(22deg)_rotateY(-24deg)] transition-transform duration-700 ease-out group-hover:[transform:perspective(900px)_rotateX(16deg)_rotateY(-16deg)_scale(1.04)]",
        className,
      )}
    >
      {/* Extruded body: pushed down-right and very dark. */}
      <div className="absolute inset-0 translate-x-[6px] translate-y-[10px] text-black/70 blur-[1px]">
        {icon}
      </div>
      {/* Face. */}
      <div className={cn("relative", accent ? "text-primary/25" : "text-foreground/[0.09]")}>
        {icon}
      </div>
      {/* Highlight, clipped to the upper half so the light has a direction. */}
      <div
        className={cn(
          "absolute inset-0 [clip-path:inset(0_0_55%_0)]",
          accent ? "text-primary/40" : "text-foreground/[0.16]",
        )}
      >
        {icon}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ shell */

function Cell({
  className,
  tone = "base",
  wide = false,
  title,
  body,
  href,
  above,
  children,
}: {
  className?: string;
  /** Tonal steps, so neighbouring cells separate without a border doing it. */
  tone?: "base" | "raised" | "sunken";
  /**
   * Two-column cells reserve the right-hand share for the object, so the copy
   * has a column of its own rather than a width that happens to clear the
   * artwork. Getting this wrong is what made the setup cell rag badly: the
   * command sat at one width, the paragraph at another, and neither lined up.
   */
  wide?: boolean;
  title: string;
  body: string;
  href?: string;
  /** Rendered inside the content column, above the title, at the same width. */
  above?: React.ReactNode;
  /** The object. Absolutely positioned by the caller. */
  children?: React.ReactNode;
}) {
  const inner = (
    <div
      className={cn(
        "relative flex h-full flex-col justify-end overflow-hidden rounded-2xl border border-white/[0.06] p-6 transition-colors duration-300 group-hover:border-white/[0.12] sm:p-7",
        tone === "base" && "bg-card",
        tone === "raised" && "bg-[color-mix(in_oklch,var(--card)_60%,var(--secondary))]",
        tone === "sunken" && "bg-[color-mix(in_oklch,var(--card)_55%,black)]",
      )}
    >
      {children}

      {/* One content column. Everything textual lives in it and shares its
          measure, so the left edges stack and the right edges rag together. */}
      <div className={cn("relative", wide ? "w-full lg:max-w-[58%]" : "max-w-[30ch]")}>
        {above}
        <h3 className="font-heading text-xl leading-[1.15] font-semibold tracking-tight text-balance sm:text-2xl">
          {title}
        </h3>
        <p className="mt-2.5 text-sm leading-relaxed text-pretty text-muted-foreground">{body}</p>
      </div>

      {href && (
        <ArrowUpRightIcon
          aria-hidden
          className="absolute top-6 right-6 size-4 text-muted-foreground opacity-0 transition-all duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground group-hover:opacity-100"
        />
      )}
    </div>
  );

  return (
    <TiltCard className={cn("h-full", className)}>
      {href ? (
        <Link href={href} className="block h-full rounded-2xl focus-visible:outline-none">
          {inner}
        </Link>
      ) : (
        inner
      )}
    </TiltCard>
  );
}

/* ------------------------------------------------------------------- grid */

export function FeatureBento() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:auto-rows-[15rem] lg:grid-cols-3">
      {/* Tall, and the only cell carrying the brand colour: key custody is the
          claim the rest of the product rests on. */}
      <Cell
        className="lg:row-span-2"
        tone="sunken"
        title="Keys that cannot leak"
        body="Generated non-extractable in WebCrypto. Our own code gets the same refusal an injected script does."
        href="/security"
      >
        <Sculpture
          accent
          className="-top-6 -left-4"
          icon={<KeyIcon weight="fill" className="size-64" />}
        />
      </Cell>

      {/* Wide: title left, object bleeding off the right edge. */}
      <Cell
        className="lg:col-span-2"
        tone="raised"
        wide
        title="A real terminal, in a tab"
        body="xterm.js on WebGL. True colour, full VT, tabs and splits — and a key bar so a phone can still send Ctrl-C."
      >
        <Sculpture
          className="top-1/2 -right-10 -translate-y-1/2"
          icon={<TerminalWindowIcon weight="fill" className="size-60" />}
        />
      </Cell>

      <Cell
        title="Files on the same connection"
        body="SFTP rides the session you already opened. Drag folders in; large files stream straight to disk."
      >
        <Sculpture
          className="-top-8 -right-8"
          icon={<FolderOpenIcon weight="fill" className="size-52" />}
        />
      </Cell>

      <Cell
        tone="sunken"
        title="Sync we cannot read"
        body="Hosts, snippets and keys are encrypted in your browser. We store one opaque blob and a version number."
        href="/security"
      >
        <Sculpture
          className="-top-8 -right-8"
          icon={<CloudCheckIcon weight="fill" className="size-52" />}
        />
      </Cell>

      {/* Wide: the one-line setup, which is the whole zero-install argument. */}
      <Cell
        className="lg:col-span-2"
        tone="raised"
        wide
        title="Nothing to install on your server"
        body="One line in authorized_keys and stock sshd. No agent, no daemon, no port you have not already opened."
        above={<SetupLine />}
      >
        <Sculpture
          className="top-1/2 -right-8 -translate-y-1/2"
          icon={<ShieldCheckIcon weight="fill" className="size-60" />}
        />
      </Cell>

      <Cell
        title="Record and replay"
        body="Capture a session and watch it back. Encrypted in the tab, like everything else."
      >
        <Sculpture
          className="-top-8 -right-8"
          icon={<PlayCircleIcon weight="fill" className="size-52" />}
        />
      </Cell>
    </div>
  );
}

/**
 * The command itself, sitting above the copy in the wide cell.
 *
 * Shown rather than described, because the claim is precisely that it is one
 * line — a sentence saying so is weaker than the line.
 */
function SetupLine() {
  return (
    <div
      aria-hidden
      // Full width of the content column, not a width of its own — that
      // mismatch is what made this cell look misaligned.
      className="mb-5 w-full overflow-hidden rounded-lg border border-white/[0.06] bg-terminal/70 px-3.5 py-2.5 font-mono text-[11px] leading-relaxed"
    >
      <span className="text-muted-foreground">$ </span>
      <span className="text-foreground/80">echo </span>
      <span className="text-success/80">&apos;ssh-ed25519 AAAA…&apos;</span>
      <span className="text-foreground/80"> &gt;&gt; authorized_keys</span>
    </div>
  );
}
