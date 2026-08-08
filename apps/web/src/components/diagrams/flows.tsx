import { cn } from "@/lib/utils";

/**
 * The split key derivation, drawn.
 *
 * One password stretched once, then forked into a branch that leaves the device
 * and a branch that never does. The asymmetry is the whole security argument,
 * so it is worth a picture rather than a paragraph.
 */
export function SplitKdfDiagram({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 380 250"
      className={cn("h-auto w-full", className)}
      role="img"
      aria-labelledby="kdf-title kdf-desc"
    >
      <title id="kdf-title">How your password is split</title>
      <desc id="kdf-desc">
        Your password is stretched with Argon2id in the browser. HKDF then
        derives two independent values: an auth token that is sent to the
        server, and a vault key that never leaves your device.
      </desc>

      <defs>
        <marker id="kdf-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" className="text-border" />
        </marker>
      </defs>

      <rect x="110" y="8" width="160" height="30" rx="5"
            className="fill-card stroke-border" strokeWidth="1" />
      <text x="190" y="27" textAnchor="middle" className="fill-foreground text-[11px]">
        Your password
      </text>

      <line x1="190" y1="38" x2="190" y2="62" className="stroke-border" strokeWidth="1"
            markerEnd="url(#kdf-arrow)" />

      <rect x="90" y="62" width="200" height="34" rx="5"
            className="fill-card stroke-primary/50" strokeWidth="1" />
      <text x="190" y="78" textAnchor="middle" className="fill-primary text-[11px] font-medium">
        Argon2id
      </text>
      <text x="190" y="90" textAnchor="middle" className="fill-muted-foreground text-[9px]">
        in your browser · 64 MiB · 3 passes
      </text>

      {/* fork */}
      <path d="M190 96 V116 H80 V136" className="fill-none stroke-border" strokeWidth="1"
            markerEnd="url(#kdf-arrow)" />
      <path d="M190 96 V116 H300 V136" className="fill-none stroke-border" strokeWidth="1"
            markerEnd="url(#kdf-arrow)" />
      <text x="190" y="112" textAnchor="middle" className="fill-muted-foreground text-[9px]">
        HKDF — one-way, domain separated
      </text>

      {/* auth branch */}
      <rect x="10" y="136" width="140" height="46" rx="5"
            className="fill-card stroke-warning/50" strokeWidth="1" />
      <text x="80" y="154" textAnchor="middle" className="fill-foreground text-[10px]">
        Auth token
      </text>
      <text x="80" y="170" textAnchor="middle" className="fill-muted-foreground text-[9px]">
        sent to the server
      </text>
      <text x="80" y="200" textAnchor="middle" className="fill-warning text-[9px]">
        Proves who you are
      </text>
      <text x="80" y="213" textAnchor="middle" className="fill-muted-foreground text-[9px]">
        Useless for decryption
      </text>

      {/* vault branch */}
      <rect x="230" y="136" width="140" height="46" rx="5"
            className="fill-card stroke-success/50" strokeWidth="1" />
      <text x="300" y="154" textAnchor="middle" className="fill-foreground text-[10px]">
        Vault key
      </text>
      <text x="300" y="170" textAnchor="middle" className="fill-muted-foreground text-[9px]">
        never transmitted
      </text>
      <text x="300" y="200" textAnchor="middle" className="fill-success text-[9px]">
        Decrypts your vault
      </text>
      <text x="300" y="213" textAnchor="middle" className="fill-muted-foreground text-[9px]">
        Memory only, on this device
      </text>

      <text x="190" y="240" textAnchor="middle" className="fill-muted-foreground text-[9px]">
        A full database dump does not yield the vault key.
      </text>
    </svg>
  );
}

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

/** Team key wrapping: the server distributes ciphertext it cannot open. */
export function TeamKeyDiagram({ className }: { className?: string }) {
  const members = [
    { name: "Ada", x: 20 },
    { name: "Grace", x: 150 },
    { name: "Alan", x: 280 },
  ];

  return (
    <svg
      viewBox="0 0 380 210"
      className={cn("h-auto w-full", className)}
      role="img"
      aria-labelledby="team-title team-desc"
    >
      <title id="team-title">How a team vault is shared</title>
      <desc id="team-desc">
        One team key encrypts the shared vault. A copy of that key is wrapped to
        each member&apos;s public key, so the server distributes ciphertext it
        cannot open. Removing a member rotates the key.
      </desc>

      <defs>
        <marker id="team-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" className="text-border" />
        </marker>
      </defs>

      <rect x="120" y="8" width="140" height="40" rx="5"
            className="fill-card stroke-primary/50" strokeWidth="1" />
      <text x="190" y="26" textAnchor="middle" className="fill-primary text-[11px] font-medium">
        Team key
      </text>
      <text x="190" y="40" textAnchor="middle" className="fill-muted-foreground text-[9px]">
        never stored in the clear
      </text>

      {members.map((m) => (
        <g key={m.name}>
          <path
            d={`M190 48 V70 H${m.x + 40} V96`}
            className="fill-none stroke-border"
            strokeWidth="1"
            markerEnd="url(#team-arrow)"
          />
          <rect x={m.x} y="96" width="80" height="46" rx="5"
                className="fill-card stroke-border" strokeWidth="1" />
          <text x={m.x + 40} y="114" textAnchor="middle" className="fill-foreground text-[10px]">
            {m.name}
          </text>
          <text x={m.x + 40} y="130" textAnchor="middle" className="fill-muted-foreground text-[8px]">
            wrapped to
          </text>
          <text x={m.x + 40} y="140" textAnchor="middle" className="fill-muted-foreground text-[8px]">
            their public key
          </text>
        </g>
      ))}

      <text x="190" y="172" textAnchor="middle" className="fill-muted-foreground text-[9px]">
        The server holds three sealed copies and can open none of them.
      </text>
      <text x="190" y="192" textAnchor="middle" className="fill-warning text-[9px]">
        Removing a member rotates the key — but not what they already read.
      </text>
    </svg>
  );
}
