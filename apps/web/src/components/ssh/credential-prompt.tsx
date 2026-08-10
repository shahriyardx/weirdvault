"use client"

/**
 * Asking for whatever the host did not already specify.
 *
 * Two things can be missing at connect time: which key to use (a host saved
 * with "Ask on connect") and a password (we never store one, so a password host
 * asks every time). Both are the same interaction — a dialog that blocks the
 * connect until it is answered — so they are one component.
 *
 * Silently falling back to some other key was worse than asking: it produced a
 * handshake failure from the server instead of a question from us.
 */

import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { SshKey } from "@/lib/keys"

export type Need = "key" | "password"

/** What the prompt hands back: a chosen key id, or a password. */
export type Credential = { keyId: string } | { password: string }

interface Pending {
  /**
   * Identifies this one ask. It exists so the form below can be remounted per
   * prompt rather than reset by an effect — see the note on `PromptForm`.
   */
  id: string
  host: { label: string; username: string; hostname: string; port: number }
  need: Need
  resolve: (credential: Credential | null) => void
}

export function useCredentialPrompt() {
  const [pending, setPending] = React.useState<Pending | null>(null)

  const askFor = React.useCallback(
    (host: Pending["host"], need: Need) =>
      new Promise<Credential | null>((resolve) =>
        setPending({ id: crypto.randomUUID(), host, need, resolve }),
      ),
    [],
  )

  const settle = React.useCallback((credential: Credential | null) => {
    setPending((p) => {
      p?.resolve(credential)
      return null
    })
  }, [])

  return { pending, askFor, settle }
}

export function CredentialPrompt({
  pending,
  keys,
  onSettle,
}: {
  pending: Pick<Pending, "id" | "host" | "need"> | null
  keys: SshKey[]
  onSettle: (credential: Credential | null) => void
}) {
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && onSettle(null)}>
      <DialogContent className="sm:max-w-sm">
        {pending && (
          <PromptForm
            key={pending.id}
            host={pending.host}
            need={pending.need}
            keys={keys}
            onSettle={onSettle}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The fields, mounted fresh for each ask.
 *
 * This is a separate component keyed on the prompt id rather than one set of
 * fields cleared by an effect. Clearing in an effect meant the typed password
 * of the previous prompt was briefly present in the render that opened the
 * next one, and it left the reset one commit behind the dialog it belonged to.
 * Remounting makes "never let a password outlive its prompt" a property of the
 * tree instead of a step someone has to remember.
 *
 * The two choices default rather than initialise, so a key list that finishes
 * loading while the dialog is already open still fills the picker.
 */
function PromptForm({
  host,
  need,
  keys,
  onSettle,
}: {
  host: Pending["host"]
  need: Need
  keys: SshKey[]
  onSettle: (credential: Credential | null) => void
}) {
  const [password, setPassword] = React.useState("")
  const [chosenKeyId, setChosenKeyId] = React.useState<string | null>(null)
  /**
   * What is being entered right now, which starts at what the host asked for
   * but is not fixed to it — a key host might be reachable with a password
   * today, and a password host might be the one you have a key for.
   */
  const [chosenMode, setChosenMode] = React.useState<Need | null>(null)

  const keyId = chosenKeyId ?? keys[0]?.id ?? ""
  const mode = chosenMode ?? need
  const target = `${host.username}@${host.hostname}:${host.port}`
  const ready = mode === "password" ? password.length > 0 : keyId.length > 0
  const canUseKey = keys.length > 0

  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect to {host.label}</DialogTitle>
        <DialogDescription>
          {target} —{" "}
          {mode === "password"
            ? "the password is sent inside the encrypted SSH channel, and never stored."
            : "this host was saved without a key, so pick the one to authenticate with."}
        </DialogDescription>
      </DialogHeader>

      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!ready) return
          onSettle(mode === "password" ? { password } : { keyId })
        }}
      >
        {mode === "password" ? (
          <div className="grid gap-1.5">
            <Label htmlFor="connect-password">Password</Label>
            {/* Autofill is deliberately left available here, unlike the host
                form (see lib/no-autofill.ts). This prompt is a login moment:
                someone who keeps a server's password in a manager should be
                able to fill it rather than copy it across by hand every time.
                What is NOT declared is autoComplete="current-password" — that
                is the signal meaning "the login password for this site", and it
                is how the webxterm account password would end up being sent to
                a remote server. "off" is ignored by browsers on password fields,
                which is a nuisance elsewhere and exactly right here: managers
                still offer their entries, and nothing claims this is ours. */}
            <Input
              id="connect-password"
              name="remote-host-secret"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              autoFocus
              required
            />
          </div>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor="connect-key">Key</Label>
            <Select value={keyId} onValueChange={setChosenKeyId}>
              <SelectTrigger id="connect-key" className="w-full">
                <SelectValue placeholder="Choose a key" />
              </SelectTrigger>
              <SelectContent>
                {keys.map((k) => (
                  <SelectItem key={k.id} value={k.id}>
                    {k.label} · {k.mode}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Either method can be the right one for a given host, so the other
            is always one click away rather than a trip back to the form. */}
        {(mode === "password" ? canUseKey : true) && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="justify-self-start px-0"
            onClick={() => setChosenMode(mode === "password" ? "key" : "password")}
          >
            {mode === "password" ? "Use a key instead" : "Use a password instead"}
          </Button>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onSettle(null)}>
            Cancel
          </Button>
          <Button type="submit" disabled={!ready}>
            Connect
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}
