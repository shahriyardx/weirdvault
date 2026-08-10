"use client"

/**
 * Starting and stopping a recording, from anywhere.
 *
 * Recording used to be reachable only from the Recordings page, which is the
 * wrong place for it: you decide to record while you are in a shell, not while
 * you are looking at a list of shells you have already recorded. Now the
 * terminal toolbar can do it too — and the moment there were two callers, the
 * setup below had to stop living inside a page component.
 *
 * It is more than a call to `startRecording`. A recording is encrypted with the
 * vault key, stamped with a blinded host reference derived from the audit key,
 * attributed to a device, and sized from whatever the pane last reported. Every
 * one of those has a failure mode worth naming rather than swallowing, and a
 * second copy of the sequence would have drifted from the first within a week.
 */

import * as React from "react"
import { toast } from "sonner"

import { blindHost } from "@/lib/audit/blind"
import { getCurrentDeviceId } from "@/lib/device"
import { startRecording, stopRecording } from "@/lib/recording/capture"
import { useSshSession, type SessionEntry } from "@/lib/ssh/session-provider"
import { getAuditKey, getVaultKey, requestUnlock } from "@/lib/vault/session"

export function useSessionRecorder() {
  const { tapSession, sizeFor } = useSshSession()

  const start = React.useCallback(
    async (session: SessionEntry) => {
      if (!getVaultKey()) {
        // Not a silent no-op and not a failure at the end: the vault is what
        // encrypts the transcript, so there is nothing to do until it is open.
        requestUnlock()
        toast.error("The vault is locked", {
          description:
            "A recording is encrypted with the vault key before it is stored, so recording cannot start until you unlock.",
        })
        return
      }

      const auditKey = getAuditKey()
      const targetRef = auditKey
        ? await blindHost(auditKey, session.target.hostname, session.target.port)
        : null
      const deviceId = (await getCurrentDeviceId()) ?? null
      const size = sizeFor(session.id)

      try {
        startRecording({
          sessionId: session.id,
          label: session.label,
          host: `${session.target.username}@${session.target.hostname}:${session.target.port}`,
          targetRef,
          deviceId,
          cols: size?.cols ?? 80,
          rows: size?.rows ?? 24,
          tap: (fn) => tapSession(session.id, fn),
        })
      } catch (error) {
        toast.error("Could not start recording", { description: message(error) })
        return
      }

      toast.success(`Recording ${session.label}`, {
        description: size
          ? "Everything the shell prints from now on is captured in this tab."
          : "This pane has not reported its size yet, so the recording assumes 80×24 until it does.",
      })
    },
    [sizeFor, tapSession],
  )

  const stop = React.useCallback(async (sessionId: string) => {
    try {
      await stopRecording(sessionId)
    } catch (error) {
      toast.error("Could not save the recording", { description: message(error) })
    }
  }, [])

  return { start, stop }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
