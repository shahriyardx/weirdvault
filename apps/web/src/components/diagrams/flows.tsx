import { cn } from "@/lib/utils";

/**
 * Audit blinding: the server groups your activity by host without learning
 * which host.
 */
export function AuditBlindingDiagram({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 380 170"
      className={cn("h-auto w-full", className)}
      role="img"
      aria-labelledby="blind-title blind-desc"
    >
      <title id="blind-title">How the activity log hides your hosts</title>
      <desc id="blind-desc">
        Your browser turns a hostname into an HMAC using a key derived from your
        password. The server stores only that opaque reference, so it can group
        events by host without ever learning the hostname.
      </desc>

      <defs>
        <marker id="blind-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" className="text-border" />
        </marker>
      </defs>

      <rect x="8" y="40" width="120" height="44" rx="5"
            className="fill-card stroke-success/50" strokeWidth="1" />
      <text x="68" y="60" textAnchor="middle" className="fill-foreground text-[10px]">
        prod-db.internal
      </text>
      <text x="68" y="75" textAnchor="middle" className="fill-muted-foreground text-[9px]">
        in your browser
      </text>

      <line x1="128" y1="62" x2="168" y2="62" className="stroke-border" strokeWidth="1"
            markerEnd="url(#blind-arrow)" />
      <text x="148" y="52" textAnchor="middle" className="fill-muted-foreground text-[8px]">
        HMAC
      </text>

      <rect x="168" y="40" width="120" height="44" rx="5"
            className="fill-card stroke-border" strokeWidth="1" strokeDasharray="4 3" />
      <text x="228" y="60" textAnchor="middle" className="fill-foreground text-[10px]">
        7f3a9c2e…
      </text>
      <text x="228" y="75" textAnchor="middle" className="fill-muted-foreground text-[9px]">
        stored by the server
      </text>

      <text x="190" y="120" textAnchor="middle" className="fill-muted-foreground text-[9px]">
        The server can group your timeline by host.
      </text>
      <text x="190" y="136" textAnchor="middle" className="fill-muted-foreground text-[9px]">
        It cannot tell which host that is.
      </text>
      <text x="190" y="158" textAnchor="middle" className="fill-muted-foreground text-[8px]">
        The key is derived from your password and stays on this device.
      </text>
    </svg>
  );
}
