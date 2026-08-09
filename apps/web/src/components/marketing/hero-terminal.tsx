import {
  FolderIcon,
  LockKeyIcon,
  RecordIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react/dist/ssr";

/**
 * The hero's terminal, drawn rather than screenshotted.
 *
 * A screenshot would be one raster that goes soft on a retina display, has to
 * be re-cut whenever the UI moves, and says nothing to a screen reader. This is
 * markup: it stays sharp, it restyles itself with the theme tokens, and the
 * transcript inside it is real text.
 *
 * It is decorative, so the whole thing is aria-hidden. Everything it claims is
 * claimed again in prose beside it — a person using a screen reader gets the
 * argument, not a wall of fake shell output.
 *
 * The 3D is in the parent: this renders flat and the section tilts it, so the
 * component has no opinion about where it sits.
 */
export function HeroTerminal() {
  return (
    <div
      aria-hidden
      className="relative overflow-hidden rounded-lg border border-border bg-card shadow-2xl shadow-black/40 ring-1 ring-white/5"
    >
      {/* Title bar */}
      <div className="flex items-center gap-2 border-b border-border bg-secondary/40 px-3 py-2">
        <span className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-destructive/50" />
          <span className="size-2.5 rounded-full bg-warning/50" />
          <span className="size-2.5 rounded-full bg-success/50" />
        </span>
        <span className="ml-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <TerminalWindowIcon className="size-3" />
          deploy@edge-01
        </span>
        <span className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1 text-success">
            <LockKeyIcon weight="fill" className="size-3" />
            ed25519
          </span>
          <span className="flex items-center gap-1">
            <RecordIcon weight="fill" className="size-3 text-destructive/70" />
            rec
          </span>
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_150px]">
        {/* Transcript */}
        <div className="relative bg-terminal px-4 py-3 font-mono text-[11px] leading-[1.7]">
          {/* A slow scanline, so the surface reads as live rather than as an
              image of a terminal. Low contrast on purpose. */}
          <span className="pointer-events-none absolute inset-x-0 top-0 h-16 animate-sweep bg-gradient-to-b from-transparent via-primary/5 to-transparent" />

          <Line prompt>ssh deploy@edge-01</Line>
          <Line muted>· relay ws → tcp, ciphertext only</Line>
          <Line muted>· host key SHA256:kR2q…9vX pinned, verified</Line>
          <Line muted>· signed by a key this tab cannot read</Line>
          <div className="h-2" />
          <Line prompt>systemctl status api</Line>
          <Line>
            <span className="text-success">●</span> api.service — active{" "}
            <span className="text-muted-foreground">(running) 6d 4h</span>
          </Line>
          <div className="h-2" />
          <Line prompt>tail -f /var/log/api.log</Line>
          <Line muted>17:04:11 request served in 12ms</Line>
          <Line muted>17:04:12 request served in 9ms</Line>
          <Line prompt>
            <span className="ml-0.5 inline-block h-3.5 w-[7px] translate-y-[2px] animate-caret bg-primary/80" />
          </Line>
        </div>

        {/* File rail, so the "not just a web terminal" claim is visible */}
        <div className="hidden border-l border-border bg-card/60 px-3 py-3 sm:block">
          <p className="mb-2 flex items-center gap-1.5 text-[10px] tracking-wider text-muted-foreground uppercase">
            <FolderIcon className="size-3" />
            /srv/api
          </p>
          <ul className="space-y-1 font-mono text-[10px] text-muted-foreground">
            <li className="text-foreground">config.yaml</li>
            <li>docker-compose.yml</li>
            <li>.env</li>
            <li className="text-primary">deploy.sh</li>
            <li>logs/</li>
          </ul>
          <div className="mt-3 border-t border-border pt-2">
            <p className="text-[10px] text-muted-foreground">upload</p>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-secondary">
              <div className="h-full w-2/3 rounded-full bg-primary/70" />
            </div>
            <p className="mt-1 font-mono text-[9px] text-muted-foreground">
              build.tar · 62%
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Line({
  children,
  prompt,
  muted,
}: {
  children: React.ReactNode;
  prompt?: boolean;
  muted?: boolean;
}) {
  return (
    <div className={muted ? "text-muted-foreground/70" : "text-foreground/90"}>
      {prompt && <span className="text-primary">$ </span>}
      {children}
    </div>
  );
}
