import { cn } from "@/lib/utils";

/**
 * The trust-boundary diagram.
 *
 * Drawn as SVG rather than box-drawing characters: ASCII art depends on the
 * reader's font metrics, breaks the moment a line wraps, and is invisible to
 * screen readers. This scales, respects the theme tokens, and carries a real
 * description.
 */
export function ArchitectureDiagram({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 420 340"
      className={cn("h-auto w-full", className)}
      role="img"
      aria-labelledby="arch-title arch-desc"
    >
      <title id="arch-title">How a webxterm connection is encrypted</title>
      <desc id="arch-desc">
        The SSH client runs inside your browser, holding non-extractable keys.
        It sends SSH ciphertext over a WebSocket to the webxterm relay, which
        forwards it to your server on TCP port 22 and cannot decrypt it. Your
        server runs unmodified sshd.
      </desc>

      <defs>
        <marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" className="text-border" />
        </marker>
      </defs>

      {/* browser */}
      <g>
        <rect x="40" y="10" width="340" height="86" rx="6"
              className="fill-card stroke-primary/50" strokeWidth="1" />
        <text x="56" y="32" className="fill-primary text-[11px] font-medium">Your browser</text>
        <text x="56" y="52" className="fill-foreground text-[11px]">Terminal · SFTP · Editor</text>
        <text x="56" y="68" className="fill-foreground text-[11px]">WASM SSH client</text>
        <text x="56" y="84" className="fill-muted-foreground text-[10px]">
          Non-extractable keys — never readable
        </text>
      </g>

      <line x1="210" y1="96" x2="210" y2="140" strokeWidth="1"
            className="stroke-border" markerEnd="url(#arch-arrow)" />
      <text x="222" y="122" className="fill-muted-foreground text-[10px]">SSH ciphertext</text>

      {/* relay */}
      <g>
        <rect x="40" y="140" width="340" height="66" rx="6"
              className="fill-card stroke-border" strokeWidth="1" strokeDasharray="4 3" />
        <text x="56" y="162" className="fill-foreground text-[11px] font-medium">webxterm relay</text>
        <text x="56" y="180" className="fill-muted-foreground text-[10px]">
          Stateless · forwards bytes
        </text>
        <text x="56" y="196" className="fill-muted-foreground text-[10px]">
          Cannot decrypt any of them
        </text>
      </g>

      <line x1="210" y1="206" x2="210" y2="250" strokeWidth="1"
            className="stroke-border" markerEnd="url(#arch-arrow)" />
      <text x="222" y="232" className="fill-muted-foreground text-[10px]">TCP :22</text>

      {/* server */}
      <g>
        <rect x="40" y="250" width="340" height="60" rx="6"
              className="fill-card stroke-success/50" strokeWidth="1" />
        <text x="56" y="272" className="fill-foreground text-[11px] font-medium">Your server</text>
        <text x="56" y="292" className="fill-muted-foreground text-[10px]">
          Unmodified sshd — nothing installed
        </text>
      </g>

      <text x="40" y="330" className="fill-muted-foreground text-[9px]">
        Encryption begins and ends inside the tab.
      </text>
    </svg>
  );
}

/**
 * What each party can and cannot see. A two-column comparison rather than a
 * wall of prose, because the asymmetry is the point.
 */
export function VisibilityDiagram({ className }: { className?: string }) {
  const rows = [
    { label: "Destination host and port", relay: true, control: false },
    { label: "Connection timing and volume", relay: true, control: false },
    { label: "Your host list and labels", relay: false, control: false },
    { label: "Keystrokes and terminal output", relay: false, control: false },
    { label: "File contents you transfer", relay: false, control: false },
    { label: "SSH private keys", relay: false, control: false },
    { label: "Your password", relay: false, control: false },
  ];

  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full min-w-[26rem] text-left text-sm">
        <caption className="sr-only">
          What the relay and control plane can observe
        </caption>
        <thead>
          <tr className="border-border border-b">
            <th scope="col" className="text-muted-foreground py-2 pr-4 text-xs font-medium">
              Can they see it?
            </th>
            <th scope="col" className="text-muted-foreground py-2 pr-4 text-xs font-medium">
              Relay
            </th>
            <th scope="col" className="text-muted-foreground py-2 text-xs font-medium">
              Control plane
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-border/60 border-b last:border-0">
              <td className="py-2 pr-4">{r.label}</td>
              <td className="py-2 pr-4">
                <Verdict yes={r.relay} />
              </td>
              <td className="py-2">
                <Verdict yes={r.control} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Verdict({ yes }: { yes: boolean }) {
  return yes ? (
    <span className="text-warning inline-flex items-center gap-1.5 text-xs">
      <span aria-hidden className="bg-warning size-1.5 rounded-full" />
      Yes
      <span className="sr-only">— visible</span>
    </span>
  ) : (
    <span className="text-success inline-flex items-center gap-1.5 text-xs">
      <span aria-hidden className="bg-success size-1.5 rounded-full" />
      No
      <span className="sr-only">— not visible</span>
    </span>
  );
}
