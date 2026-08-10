"use client"

import { useState } from "react"
import { WarningIcon } from "@phosphor-icons/react/dist/ssr"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { unpin } from "@/lib/hostkeys"
import { useSshSession } from "@/lib/ssh/session-provider"

/**
 * A host key mismatch is either a rebuilt server or an active interception, and
 * the UI cannot tell which. So it blocks, explains, and makes clearing the pin
 * a deliberate act — never a "trust anyway" button sitting beside the warning.
 */
export function HostKeyMismatchWarning() {
  const { mismatch, dismissMismatch } = useSshSession()
  const [confirmText, setConfirmText] = useState("")

  if (!mismatch) return null

  return (
    <Alert variant="destructive" className="mb-6">
      <WarningIcon />
      <AlertTitle>Host key mismatch</AlertTitle>
      <AlertDescription className="space-y-4">
        <p className="text-sm leading-relaxed">
          The key presented by{" "}
          <b>
            {mismatch.host}:{mismatch.port}
          </b>{" "}
          is not the one pinned for this host. Either the server was rebuilt, or something is
          intercepting this connection. webxterm refused to continue.
        </p>

        <dl className="space-y-1 text-[11px]">
          <div>
            <dt className="text-muted-foreground inline">pinned: </dt>
            <dd className="inline break-all">
              {mismatch.expected.type} {mismatch.expected.fingerprint}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground inline">presented: </dt>
            <dd className="text-destructive inline break-all">
              {mismatch.presented.type} {mismatch.presented.fingerprint}
            </dd>
          </div>
        </dl>

        <p className="text-muted-foreground text-xs leading-relaxed">
          Only clear the pin if you know why the key changed. Verify the new fingerprint out of band
          first — run <code>ssh-keyscan</code> from a trusted network, or check your provider&apos;s
          console.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="h-8 max-w-56 text-xs"
            placeholder='type "clear pin" to confirm'
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
          />
          <Button
            size="sm"
            variant="destructive"
            disabled={confirmText !== "clear pin"}
            onClick={async () => {
              await unpin(mismatch.host, mismatch.port)
              dismissMismatch()
            }}
          >
            Clear pin
          </Button>
          <Button size="sm" variant="ghost" onClick={dismissMismatch}>
            Cancel
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}
