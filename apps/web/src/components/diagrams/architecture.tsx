import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
 * What each party can and cannot see.
 *
 * A grid of mostly-"No" was unreadable and buried the point. Two columns, each
 * splitting into what that party observes and what it cannot, puts the
 * asymmetry — which is the entire argument — in front of you at a glance.
 */
export function VisibilityDiagram({ className }: { className?: string }) {
  const parties = [
    {
      name: "The relay",
      role: "Forwards bytes between your browser and your server",
      sees: [
        "Which host and port you connect to",
        "When you connect, and for how long",
        "How many bytes move, in each direction",
      ],
      blind: [
        "Any plaintext byte of the session",
        "Keystrokes, commands and output",
        "Files you transfer",
        "Your SSH keys",
      ],
    },
    {
      name: "The control plane",
      role: "Stores your account and your encrypted vault",
      sees: [
        "Your email and sign-in times",
        "The size of your vault, and when it changed",
        "Which devices you use",
      ],
      blind: [
        "Your host list, usernames and labels",
        "Your snippets and saved settings",
        "Your SSH keys, even the synced ones",
        "Your password and vault key",
      ],
    },
  ];

  return (
    <div className={cn("grid gap-4 sm:grid-cols-2", className)}>
      {parties.map((p) => (
        <Card key={p.name}>
          <CardHeader>
            <CardTitle className="text-sm">{p.name}</CardTitle>
            <CardDescription>{p.role}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Visibility tone="warning" heading="Can see" items={p.sees} />
            <Visibility tone="success" heading="Cannot see" items={p.blind} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Visibility({
  tone,
  heading,
  items,
}: {
  tone: "warning" | "success";
  heading: string;
  items: string[];
}) {
  return (
    <div>
      <p
        className={cn(
          "mb-1.5 text-[11px] font-medium tracking-wide uppercase",
          tone === "warning" ? "text-warning" : "text-success",
        )}
      >
        {heading}
      </p>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item} className="text-muted-foreground flex gap-2 text-xs leading-relaxed">
            <span
              aria-hidden
              className={cn(
                "mt-1.5 size-1 shrink-0 rounded-full",
                tone === "warning" ? "bg-warning" : "bg-success",
              )}
            />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
