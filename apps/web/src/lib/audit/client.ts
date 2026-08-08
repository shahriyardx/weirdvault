"use client";

/**
 * Client-side audit reporting.
 *
 * Deliberately best-effort: an audit write must never delay or fail an SSH
 * connection. These events are also self-reported, so the server records them
 * with `source: "client"` — a compromised tab can simply not call this, and the
 * log is honest about that rather than implying completeness.
 */

import type { AuditEventType } from "./events";
import { blindHost } from "./blind";
import { getCurrentDeviceId } from "@/lib/device";

interface ReportOptions {
  /** Blinded on this device before sending. Never send a hostname. */
  target?: { host: string; port: number };
  metadata?: Record<string, unknown>;
  auditKey?: CryptoKey | null;
}

export async function reportAudit(
  eventType: AuditEventType,
  opts: ReportOptions = {},
): Promise<void> {
  try {
    let targetRef: string | undefined;
    if (opts.target && opts.auditKey) {
      targetRef = await blindHost(opts.auditKey, opts.target.host, opts.target.port);
    }

    await fetch("/api/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType,
        targetRef,
        metadata: opts.metadata,
        deviceId: await getCurrentDeviceId(),
      }),
      keepalive: true, // survive a tab closing mid-report
    });
  } catch {
    // Signed out, offline, or the control plane is down. None of those are
    // reasons to interrupt what the user is actually doing.
  }
}
