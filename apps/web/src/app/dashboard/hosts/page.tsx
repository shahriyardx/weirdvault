"use client"

// Client component: hosts live in IndexedDB and the encrypted vault, so the
// list can only be read after decryption in the browser. There is no server
// render of this data — the server holds ciphertext it cannot open.

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  DotsThreeIcon,
  FingerprintIcon,
  HardDrivesIcon,
  InfoIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlusIcon,
  ShieldWarningIcon,
  TerminalWindowIcon,
  TrashIcon,
  UploadSimpleIcon,
  WarningIcon,
} from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { PageHeader } from "@/components/shell/page-shell"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { deleteHost, listHosts, saveHost, type Host, type HostAuth } from "@/lib/hosts"
import { listPins, type PinnedHostKey } from "@/lib/hostkeys"
import { listStoredKeys, type StoredKey } from "@/lib/keys"
import { CredentialPrompt, useCredentialPrompt } from "@/components/ssh/credential-prompt"
import { useSshSession } from "@/lib/ssh/session-provider"
import { useConnectHost } from "@/lib/ssh/use-connect-host"
import type { ParsedConfigHost } from "@/lib/ssh/types"
import { loadSSH, parseSSHConfig, type SshLoadProgress } from "@/lib/ssh/wasm"
import { getVaultKey } from "@/lib/vault/session"
import { syncVault } from "@/lib/vault/sync"
import { noAutofillText } from "@/lib/no-autofill"

/* -------------------------------------------------------------------- form */

interface HostForm {
  id?: string
  createdAt?: number
  lastUsedAt?: number
  label: string
  hostname: string
  port: string
  username: string
  auth: HostAuth
  keyId: string
  folder: string
  tags: string
}

const NO_KEY = "__none__"

const blankForm = (): HostForm => ({
  label: "",
  hostname: "",
  port: "22",
  username: "",
  auth: "key",
  keyId: NO_KEY,
  folder: "",
  tags: "",
})

const formFor = (host: Host): HostForm => ({
  id: host.id,
  createdAt: host.createdAt,
  lastUsedAt: host.lastUsedAt,
  label: host.label,
  hostname: host.hostname,
  port: String(host.port),
  username: host.username,
  auth: host.auth ?? "key",
  keyId: host.keyId ?? NO_KEY,
  folder: host.folder ?? "",
  tags: (host.tags ?? []).join(", "),
})

/* -------------------------------------------------------------------- page */

export default function HostsPage() {
  const router = useRouter()
  const { keys: usableKeys } = useSshSession()

  // Connecting straight from the list: a saved host already carries everything
  // the connect form would ask for, so sending someone back to that form to
  // retype it is friction. Whatever it genuinely lacks, the prompt asks for.
  const prompt = useCredentialPrompt()
  const { connectToHost, connecting } = useConnectHost({
    askFor: prompt.askFor,
    onConnected: () => router.push("/dashboard/terminal"),
  })

  const [hosts, setHosts] = React.useState<Host[]>([])
  const [pins, setPins] = React.useState<PinnedHostKey[]>([])
  const [keys, setKeys] = React.useState<StoredKey[]>([])
  const [loading, setLoading] = React.useState(true)
  const [query, setQuery] = React.useState("")

  const [form, setForm] = React.useState<HostForm | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [pendingDelete, setPendingDelete] = React.useState<Host | null>(null)
  const [importOpen, setImportOpen] = React.useState(false)

  const refresh = React.useCallback(async () => {
    const [h, p, k] = await Promise.all([listHosts(), listPins(), listStoredKeys()])
    setHosts(h)
    setPins(p)
    setKeys(k)
  }, [])

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [h, p, k] = await Promise.all([listHosts(), listPins(), listStoredKeys()])
        if (cancelled) return
        setHosts(h)
        setPins(p)
        setKeys(k)
      } catch {
        if (!cancelled) toast.error("Could not read the local host store.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const pinFor = React.useCallback(
    (host: Host) => pins.find((p) => p.id === `${host.hostname}:${host.port}`),
    [pins],
  )

  const keyLabel = React.useCallback(
    (id?: string) => (id ? keys.find((k) => k.id === id)?.label : undefined),
    [keys],
  )

  // Search is client-side because it has to be: the vault is a blob the server
  // cannot index. Matching on the fields a person actually remembers.
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return hosts
    return hosts.filter((h) =>
      [
        h.label,
        h.hostname,
        h.username,
        h.folder ?? "",
        (h.tags ?? []).join(" "),
        `${h.username}@${h.hostname}:${h.port}`,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q),
    )
  }, [hosts, query])

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!form) return

    const hostname = form.hostname.trim()
    const username = form.username.trim()
    const port = Number(form.port)

    if (!hostname || !username) {
      toast.error("Hostname and username are both required.")
      return
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast.error("Port must be a whole number between 1 and 65535.")
      return
    }

    setSaving(true)
    try {
      const tags = form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)

      await saveHost({
        id: form.id,
        createdAt: form.createdAt,
        lastUsedAt: form.lastUsedAt,
        label: form.label.trim() || `${username}@${hostname}`,
        hostname,
        port,
        username,
        auth: form.auth,
        // A password host has no key to remember; keeping a stale one would
        // make the row claim an authentication method it does not use.
        keyId: form.auth === "password" || form.keyId === NO_KEY ? undefined : form.keyId,
        folder: form.folder.trim() || undefined,
        tags: tags.length ? tags : undefined,
      })

      await refresh()
      setForm(null)
      toast.success(form.id ? "Host updated." : "Host added.")
    } catch {
      toast.error("Could not write to the local host store.")
    } finally {
      setSaving(false)
    }
  }

  /**
   * Imported hosts are worth pushing straight away: someone who has just added
   * fifteen servers from their ssh_config expects them on their phone, not
   * after the next successful connection. A failed push is not a failed import
   * — the records are already in this browser — so it is reported as such.
   */
  async function handleImported(count: number) {
    await refresh()

    const vaultKey = getVaultKey()
    if (!vaultKey) {
      toast.success(
        `Imported ${count} ${count === 1 ? "host" : "hosts"}. The vault is locked in this tab, so they stay here until you sign in.`,
      )
      return
    }
    try {
      // Read the result: an unreachable server is reported as a returned
      // status rather than a throw, so the catch below does not cover it and
      // "and synced" would be a claim about devices that got nothing.
      const result = await syncVault(vaultKey)
      if (result.status === "offline") {
        toast.message(
          `Imported ${count} ${count === 1 ? "host" : "hosts"} on this device. The server could not be reached, so they will sync on the next attempt.`,
        )
        return
      }
      toast.success(`Imported ${count} ${count === 1 ? "host" : "hosts"} and synced.`)
    } catch {
      toast.message(
        `Imported ${count} ${count === 1 ? "host" : "hosts"} on this device. The vault will sync on the next attempt.`,
      )
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return
    const { id, label } = pendingDelete
    setPendingDelete(null)
    try {
      await deleteHost(id)
      await refresh()
      toast.success(`Removed ${label}.`)
    } catch {
      toast.error("Could not remove the host.")
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Dashboard"
        title="Hosts"
        description="Saved connections, stored encrypted on this device and synced to your other devices as ciphertext. Editing one here changes it everywhere you are signed in."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <UploadSimpleIcon /> Import from ssh_config
            </Button>
            <Button onClick={() => setForm(blankForm())}>
              <PlusIcon /> Add host
            </Button>
          </div>
        }
      />

      <div className="py-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative w-full sm:max-w-xs">
            <MagnifyingGlassIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search hosts"
              aria-label="Search hosts"
              className="pl-8"
              type="search"
            />
          </div>
          <p className="text-xs text-muted-foreground sm:ml-auto">
            {loading
              ? "Reading the local store"
              : `${filtered.length} of ${hosts.length} ${hosts.length === 1 ? "host" : "hosts"}`}
          </p>
        </div>

        <div className="mt-4">
          {loading ? (
            <LoadingRows />
          ) : hosts.length === 0 ? (
            <EmptyState onAdd={() => setForm(blankForm())} onImport={() => setImportOpen(true)} />
          ) : filtered.length === 0 ? (
            <NoMatches query={query} onClear={() => setQuery("")} />
          ) : (
            <div className="rounded-sm border border-border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Host</TableHead>
                    <TableHead className="hidden md:table-cell">Authentication</TableHead>
                    <TableHead className="hidden lg:table-cell">Host key</TableHead>
                    <TableHead className="hidden sm:table-cell">Last used</TableHead>
                    <TableHead className="w-10">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((host) => (
                    <HostRow
                      key={host.id}
                      host={host}
                      pin={pinFor(host)}
                      keyLabel={keyLabel(host.keyId)}
                      busy={connecting === host.id}
                      onConnect={() => void connectToHost(host)}
                      onEdit={() => setForm(formFor(host))}
                      onDelete={() => setPendingDelete(host)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {!loading && hosts.length > 0 && (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Search runs in this tab. The vault syncs as an encrypted blob, so the server has nothing
            to query.
          </p>
        )}
      </div>

      {/* ------------------------------------------------ add / edit dialog */}
      <Dialog open={form !== null} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{form?.id ? "Edit host" : "Add host"}</DialogTitle>
            <DialogDescription>
              Saved to this browser and to the encrypted vault. Nothing here is readable by the
              relay or by us.
            </DialogDescription>
          </DialogHeader>

          {form && (
            <form onSubmit={handleSave} className="grid gap-3">
              <Field id="host-label" label="Label">
                <Input
                  id="host-label"
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  placeholder="build-01"
                  autoComplete="off"
                />
              </Field>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_5.5rem]">
                <Field id="host-hostname" label="Hostname" required>
                  <Input
                    id="host-hostname"
                    name="remote-hostname"
                    value={form.hostname}
                    onChange={(e) => setForm({ ...form, hostname: e.target.value })}
                    placeholder="10.0.4.21"
                    {...noAutofillText}
                    required
                  />
                </Field>
                <Field id="host-port" label="Port" required>
                  <Input
                    id="host-port"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: e.target.value })}
                    inputMode="numeric"
                    placeholder="22"
                    required
                  />
                </Field>
              </div>

              <Field id="host-username" label="Username" required>
                {/* The remote account's name. A field called "username" gets
                    filled by heuristic whatever the attributes say, so the name
                    goes too — see lib/no-autofill.ts. */}
                <Input
                  id="host-username"
                  name="remote-login"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  placeholder="deploy"
                  {...noAutofillText}
                  required
                />
              </Field>

              {/* Not every server is key-authenticated — plenty of boxes are
                  reached with a password and nothing else. Choosing the method
                  first keeps the fields below honest. */}
              <div className="grid gap-1.5">
                <Label htmlFor="host-auth">Authentication</Label>
                <Select
                  value={form.auth}
                  onValueChange={(v) => setForm({ ...form, auth: v as HostAuth })}
                >
                  <SelectTrigger id="host-auth" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="key">SSH key</SelectItem>
                    <SelectItem value="password">Password</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {form.auth === "key" ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="host-key">Key</Label>
                  <Select value={form.keyId} onValueChange={(v) => setForm({ ...form, keyId: v })}>
                    <SelectTrigger id="host-key" className="w-full">
                      <SelectValue placeholder="Choose a key" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_KEY}>Ask on connect</SelectItem>
                      {keys.map((k) => (
                        <SelectItem key={k.id} value={k.id}>
                          {k.label} · {k.mode}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Device-bound keys only work in this browser. Portable keys travel with the
                    vault.
                  </p>
                </div>
              ) : (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  You will be asked for the password each time you connect. We do not store it — a
                  saved password would be a plaintext credential in your vault, and the vault is the
                  one thing we cannot read.
                </p>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field id="host-folder" label="Folder">
                  <Input
                    id="host-folder"
                    value={form.folder}
                    onChange={(e) => setForm({ ...form, folder: e.target.value })}
                    placeholder="production"
                    autoComplete="off"
                  />
                </Field>
                <Field id="host-tags" label="Tags">
                  <Input
                    id="host-tags"
                    value={form.tags}
                    onChange={(e) => setForm({ ...form, tags: e.target.value })}
                    placeholder="eu-west, db"
                    autoComplete="off"
                  />
                </Field>
              </div>

              <DialogFooter className="mt-1">
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    Cancel
                  </Button>
                </DialogClose>
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving" : form.id ? "Save changes" : "Add host"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* ------------------------------------------------------ delete confirm */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pendingDelete?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the saved connection on every synced device. The pinned host key and any
              SSH keys stay where they are, and the server itself is untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDelete}>
              Remove host
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ------------------------------------------------- ssh_config import */}
      <ImportConfigDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        existing={hosts}
        onImported={handleImported}
      />

      <CredentialPrompt pending={prompt.pending} keys={usableKeys} onSettle={prompt.settle} />
    </>
  )
}

/* -------------------------------------------------------- ssh_config import */

interface ConfigSkip {
  pattern: string
  reason: string
}

interface ConfigAudit {
  skipped: ConfigSkip[]
  includes: number
  matches: number
}

/**
 * A second pass over the same text, purely to report what the parser dropped.
 *
 * sshconfig.go returns the blocks it understood and nothing about the ones it
 * walked past, so importing 12 entries from a 15-entry file would otherwise
 * look like a complete job. This mirrors the parser's own rules — patterns and
 * negations are skipped, "Host *" contributes defaults only — so that the
 * dialog can name each omission instead of quietly rounding down.
 */
function auditConfig(text: string): ConfigAudit {
  const skipped: ConfigSkip[] = []
  let includes = 0
  let matches = 0

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue

    const split = line.search(/[ \t=]/)
    if (split <= 0) continue
    const directive = line.slice(0, split).toLowerCase()
    const value = line
      .slice(split)
      .replace(/^[ \t=]+/, "")
      .trim()
      .replace(/^"|"$/g, "")

    if (directive === "include") includes++
    if (directive === "match") matches++
    if (directive !== "host" || !/[*?!]/.test(value)) continue

    // "Host prod prod-*" is the case worth naming separately: one of those two
    // is a real machine, but the parser takes a Host block whole and drops all
    // of it. Saying "a pattern rather than an address" there would be untrue,
    // and the concrete name is exactly what someone needs to add by hand.
    const concrete = value.split(/\s+/).filter((name) => !/[*?!]/.test(name))

    skipped.push({
      pattern: value,
      reason:
        value === "*"
          ? "Supplies defaults — user, port, identity file — to the blocks below it. Those defaults are already folded into the entries above; the pattern itself is not a machine."
          : concrete.length > 0
            ? `Names ${concrete.join(", ")} alongside a pattern. A Host block is read whole or not at all, so this one is skipped rather than half-understood — add ${concrete.length === 1 ? "it" : "them"} by hand if you need ${concrete.length === 1 ? "it" : "them"}.`
            : "A pattern rather than an address. Which machines it stands for depends on what you type at the ssh prompt, so there is nothing concrete to save.",
    })
  }

  return { skipped, includes, matches }
}

interface Candidate {
  key: string
  entry: ParsedConfigHost
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`

/**
 * Bulk import from ~/.ssh/config.
 *
 * The parser is deliberately partial, so the review step is not decoration:
 * it is where the difference between what the file says and what webxterm can
 * honour gets stated, entry by entry, before anything is written.
 */
function ImportConfigDialog({
  open,
  onOpenChange,
  existing,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  existing: Host[]
  onImported: (count: number) => Promise<void>
}) {
  const [text, setText] = React.useState("")
  const [fileName, setFileName] = React.useState("")
  const [candidates, setCandidates] = React.useState<Candidate[] | null>(null)
  const [audit, setAudit] = React.useState<ConfigAudit | null>(null)
  const [chosen, setChosen] = React.useState<Record<string, boolean>>({})
  const [fallbackUser, setFallbackUser] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [core, setCore] = React.useState<SshLoadProgress | null>(null)
  const [coreError, setCoreError] = React.useState<string | null>(null)
  // Bumped by the retry button. loadSSH() forgets a failed attempt, so calling
  // it again is a genuine second try rather than a replay of the same rejection.
  const [coreAttempt, setCoreAttempt] = React.useState(0)

  React.useEffect(() => {
    if (!open) return
    // Same 6 MB core the terminal uses; start it now so the parse is instant.
    // The previous attempt's error is cleared by whatever starts a new attempt
    // — closing the dialog, or the retry button — not from here. Clearing it in
    // the effect body would be a state write on every open that renders a
    // second time for no new information.
    let cancelled = false
    void loadSSH((p) => {
      if (!cancelled) setCore(p)
    }).catch((failure: unknown) => {
      if (cancelled) return
      // The progress line has to go with it. Nothing is downloading any more,
      // and a byte count left on screen claims otherwise.
      setCore(null)
      setCoreError(String((failure as Error).message ?? failure))
    })
    return () => {
      cancelled = true
    }
  }, [open, coreAttempt])

  /** Closing discards the review, so reopening never shows a stale file. */
  function handleOpenChange(next: boolean) {
    if (!next) {
      setText("")
      setFileName("")
      setCandidates(null)
      setAudit(null)
      setChosen({})
      setFallbackUser("")
      setError(null)
      setCoreError(null)
    }
    onOpenChange(next)
  }

  const userFor = React.useCallback(
    (entry: ParsedConfigHost) => entry.user || fallbackUser.trim(),
    [fallbackUser],
  )

  const isDuplicate = React.useCallback(
    (entry: ParsedConfigHost) => {
      const user = userFor(entry)
      return (
        user !== "" &&
        existing.some(
          (h) => h.hostname === entry.hostname && h.port === entry.port && h.username === user,
        )
      )
    },
    [existing, userFor],
  )

  const selected = React.useMemo(
    () =>
      (candidates ?? []).filter(
        (c) => chosen[c.key] && userFor(c.entry) !== "" && !isDuplicate(c.entry),
      ),
    [candidates, chosen, isDuplicate, userFor],
  )

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    if (file.size > 512_000) {
      setError(`${file.name} is ${megabytes(file.size)}, which is not an ssh_config.`)
      return
    }
    setError(null)
    setFileName(file.name)
    setText(await file.text())
  }

  async function handleParse(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const parsed = await parseSSHConfig(text)
      const found = parsed.map((entry, i) => ({ key: `${entry.alias}-${i}`, entry }))
      setCandidates(found)
      setAudit(auditConfig(text))
      // Everything on by default; the rows that cannot be saved as they stand
      // untick themselves below, where the reason can be shown next to them.
      setChosen(Object.fromEntries(found.map((c) => [c.key, true])))
    } catch (failure) {
      setError(String((failure as Error).message ?? failure))
    } finally {
      setBusy(false)
    }
  }

  async function handleImport() {
    const targets = selected
    setBusy(true)
    setError(null)

    // Counted rather than assumed: if the store gives up halfway, the number
    // reported has to be the number actually written.
    let written = 0
    try {
      for (const { entry } of targets) {
        await saveHost({
          label: entry.alias,
          hostname: entry.hostname,
          port: entry.port,
          username: userFor(entry),
          // The config's IdentityFile is a path this browser cannot open, so
          // the key is left unset and asked for at connect time rather than
          // pointing at a key that does not exist here.
          auth: "key",
        })
        written++
      }
    } catch {
      setBusy(false)
      setError(
        written === 0
          ? "Could not write to the local host store. Nothing was imported."
          : `The local host store failed after ${written} of ${targets.length}. Those ${written} are saved; the rest are not.`,
      )
      return
    }

    try {
      handleOpenChange(false)
      await onImported(written)
    } finally {
      setBusy(false)
    }
  }

  const loadingCore = core !== null && !core.done
  const percent =
    core && core.total > 0 ? Math.min(100, Math.round((core.loaded / core.total) * 100)) : null
  const needsFallback = (candidates ?? []).some((c) => c.entry.user === "")
  const duplicates = (candidates ?? []).filter((c) => isDuplicate(c.entry)).length

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import from ssh_config</DialogTitle>
          <DialogDescription>
            Reads the Host blocks out of an OpenSSH config and turns the ones that describe a
            specific machine into saved hosts. Nothing is written until you have looked at the list.
          </DialogDescription>
        </DialogHeader>

        {!candidates ? (
          <form onSubmit={handleParse} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="config-text">Config</Label>
              <textarea
                id="config-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={8}
                spellCheck={false}
                autoCapitalize="none"
                autoComplete="off"
                placeholder={"Host build-01\n  HostName 10.0.4.21\n  User deploy"}
                className="w-full resize-y rounded-none border border-input bg-transparent px-2.5 py-2 font-mono text-[11px] leading-relaxed transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
              />
              <p className="text-xs text-muted-foreground">
                Usually ~/.ssh/config. It is parsed in this tab and never sent anywhere.
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="config-file">Or choose the file</Label>
              <Input id="config-file" type="file" onChange={handleFile} />
              {fileName && <p className="text-xs text-muted-foreground">Read from {fileName}.</p>}
            </div>

            {loadingCore && (
              <div className="grid gap-1.5">
                {/* Without a Content-Length there is no percentage to show, and
                    a bar stuck at zero reads as broken. The byte count is the
                    honest fallback. */}
                {percent !== null && <Progress value={percent} />}
                <p className="text-xs text-muted-foreground">
                  {percent === null
                    ? `Loading the SSH core — ${megabytes(core.loaded)} so far`
                    : `Loading the SSH core — ${megabytes(core.loaded)} of about ${megabytes(core.total)}`}
                  . The config parser lives in the same WebAssembly module as SSH itself.
                </p>
              </div>
            )}

            {coreError && (
              <Alert className="border-destructive/40">
                <WarningIcon className="text-destructive" />
                <AlertTitle>The SSH core did not load</AlertTitle>
                <AlertDescription>
                  <p>{coreError}</p>
                  <p>
                    The config parser lives in that module, so there is nothing here to read the
                    file with until it arrives. It is a static file and a retry is usually all it
                    takes.
                  </p>
                  <p>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => {
                        setCoreError(null)
                        setCoreAttempt((n) => n + 1)
                      }}
                    >
                      Try again
                    </Button>
                  </p>
                </AlertDescription>
              </Alert>
            )}

            {error && (
              <Alert className="border-destructive/40">
                <WarningIcon className="text-destructive" />
                <AlertTitle>Could not read that file</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={busy || text.trim() === ""}>
                {busy ? "Reading" : "Read config"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="grid gap-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {candidates.length === 0
                ? "No Host block in that file names a specific machine."
                : `${candidates.length} ${candidates.length === 1 ? "entry" : "entries"} found${
                    duplicates > 0 ? `, ${duplicates} already saved` : ""
                  }.`}
              {audit &&
                audit.skipped.length > 0 &&
                ` ${audit.skipped.length} skipped — listed below.`}
            </p>

            {needsFallback && (
              <div className="grid gap-1.5">
                <Label htmlFor="config-fallback">Username for entries without one</Label>
                <Input
                  id="config-fallback"
                  value={fallbackUser}
                  onChange={(e) => setFallbackUser(e.target.value)}
                  placeholder="deploy"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  A Host block with no User leaves ssh to fall back on your local login name. A
                  browser cannot see that name, so those entries need one typed here before they can
                  be saved.
                </p>
              </div>
            )}

            {candidates.length > 0 && (
              <div className="max-h-72 overflow-y-auto rounded-sm border border-border">
                <ul className="divide-y divide-border">
                  {candidates.map(({ key, entry }) => {
                    const duplicate = isDuplicate(entry)
                    const user = userFor(entry)
                    const blocked = duplicate || user === ""
                    return (
                      <li key={key} className="p-2.5">
                        <label className="flex cursor-pointer items-start gap-2.5">
                          <input
                            type="checkbox"
                            className="mt-0.5 size-3.5 shrink-0 accent-primary disabled:cursor-not-allowed disabled:opacity-40"
                            checked={!blocked && (chosen[key] ?? false)}
                            disabled={blocked}
                            onChange={(e) =>
                              setChosen((prev) => ({ ...prev, [key]: e.target.checked }))
                            }
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="font-medium text-foreground">{entry.alias}</span>
                              {duplicate && (
                                <Badge variant="outline" className="font-normal">
                                  Already saved
                                </Badge>
                              )}
                              {user === "" && (
                                <Badge variant="outline" className="font-normal text-warning">
                                  Needs a username
                                </Badge>
                              )}
                            </span>
                            <span className="mt-0.5 block truncate text-muted-foreground">
                              {user || "?"}@{entry.hostname}:{entry.port}
                            </span>
                            {entry.identityFile && (
                              <span className="mt-1 block text-muted-foreground">
                                IdentityFile {entry.identityFile} — a path this browser cannot open.{" "}
                                <Link href="/dashboard/keys">Import that key</Link> and pick it on
                                the host afterwards.
                              </span>
                            )}
                            {entry.proxyJump && (
                              <span className="mt-1 block text-muted-foreground">
                                ProxyJump {entry.proxyJump} — not supported yet. This host is saved
                                as a direct connection, which will only work if the relay can reach
                                it.
                              </span>
                            )}
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}

            {audit && audit.skipped.length > 0 && (
              <div className="rounded-sm border border-border">
                <p className="border-b border-border px-2.5 py-1.5 text-muted-foreground">
                  Skipped
                </p>
                <ul className="divide-y divide-border">
                  {audit.skipped.map((skip, i) => (
                    <li key={`${skip.pattern}-${i}`} className="px-2.5 py-2">
                      <code className="text-foreground">Host {skip.pattern}</code>
                      <p className="mt-0.5 leading-relaxed text-muted-foreground">{skip.reason}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {audit && (audit.includes > 0 || audit.matches > 0) && (
              <Alert className="border-warning/40">
                <WarningIcon className="text-warning" />
                <AlertTitle>This file uses directives the parser does not model</AlertTitle>
                <AlertDescription>
                  {audit.includes > 0 && (
                    <p>
                      {audit.includes} Include {audit.includes === 1 ? "line is" : "lines are"}{" "}
                      ignored. Whatever those files declare is not in the list above; paste them in
                      separately.
                    </p>
                  )}
                  {audit.matches > 0 && (
                    <p>
                      {audit.matches} Match {audit.matches === 1 ? "block is" : "blocks are"} not
                      understood, and the options inside are read as though they applied
                      unconditionally. Check the addresses above against the file before importing.
                    </p>
                  )}
                </AlertDescription>
              </Alert>
            )}

            <Alert>
              <InfoIcon />
              <AlertTitle>What is not carried over</AlertTitle>
              <AlertDescription>
                <p>
                  Every entry is saved as a key-authenticated host with no key chosen, so you are
                  asked which one to use on the first connection. IdentityFile cannot be followed —
                  the file is on your disk, and this page has no access to it — so import the key
                  itself on the <Link href="/dashboard/keys">Keys page</Link>. ProxyJump is not
                  implemented at all.
                </p>
              </AlertDescription>
            </Alert>

            {error && (
              <Alert className="border-destructive/40">
                <WarningIcon className="text-destructive" />
                <AlertTitle>Import failed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setCandidates(null)
                  setAudit(null)
                  setError(null)
                }}
              >
                Back
              </Button>
              <Button type="button" onClick={handleImport} disabled={busy || selected.length === 0}>
                {busy
                  ? "Importing"
                  : selected.length === 0
                    ? "Nothing selected"
                    : `Import ${selected.length} ${selected.length === 1 ? "host" : "hosts"}`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/* --------------------------------------------------------------- table row */

function HostRow({
  host,
  pin,
  keyLabel,
  busy,
  onConnect,
  onEdit,
  onDelete,
}: {
  host: Host
  pin?: PinnedHostKey
  keyLabel?: string
  busy: boolean
  onConnect: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const target = `${host.username}@${host.hostname}:${host.port}`

  return (
    <TableRow>
      <TableCell className="max-w-[16rem] py-2.5 whitespace-normal">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium text-foreground">{host.label}</span>
          <span className="truncate text-muted-foreground">{target}</span>
          <div className="mt-1 flex flex-wrap items-center gap-1 sm:hidden">
            <span className="text-muted-foreground">{lastUsed(host)}</span>
          </div>
          {(host.folder || (host.tags?.length ?? 0) > 0) && (
            <div className="mt-1 flex flex-wrap gap-1">
              {host.folder && (
                <Badge variant="secondary" className="font-normal">
                  {host.folder}
                </Badge>
              )}
              {host.tags?.map((tag) => (
                <Badge key={tag} variant="outline" className="font-normal">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </TableCell>

      <TableCell className="hidden md:table-cell">
        {host.auth === "password" ? (
          <span className="text-muted-foreground">Password</span>
        ) : keyLabel ? (
          <span className="text-foreground">{keyLabel}</span>
        ) : (
          <span className="text-muted-foreground">Key — ask on connect</span>
        )}
      </TableCell>

      <TableCell className="hidden lg:table-cell">
        <Fingerprint pin={pin} />
      </TableCell>

      <TableCell className="hidden text-muted-foreground sm:table-cell">{lastUsed(host)}</TableCell>

      <TableCell className="text-right">
        {/* Connecting is why this list exists, so it is a button rather than
            something to go hunting for behind a menu. Edit and delete are rare
            and destructive, so they stay tucked away. */}
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" variant="secondary" onClick={onConnect} disabled={busy}>
            <TerminalWindowIcon /> {busy ? "Connecting" : "Connect"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${host.label}`}>
                <DotsThreeIcon weight="bold" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onSelect={onEdit}>
                <PencilSimpleIcon /> Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <TrashIcon /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  )
}

function Fingerprint({ pin }: { pin?: PinnedHostKey }) {
  if (!pin) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-default items-center gap-1.5 text-muted-foreground">
            <ShieldWarningIcon className="size-3.5" />
            Not pinned
          </span>
        </TooltipTrigger>
        <TooltipContent>
          No host key pinned yet. The first connection pins whatever the server presents, and every
          reconnect after that is checked against it.
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default items-center gap-1.5">
          <FingerprintIcon className="size-3.5 text-success" />
          <span className="text-muted-foreground">{truncate(pin.fingerprint)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <span className="flex flex-col gap-1">
          <span className="break-all">{pin.fingerprint}</span>
          <span className="opacity-70">
            {pin.type} · pinned {formatDate(pin.pinnedAt)}
          </span>
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

/* ------------------------------------------------------------ empty states */

function EmptyState({ onAdd, onImport }: { onAdd: () => void; onImport: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-4 py-10 sm:px-8">
        <div className="grid size-9 place-items-center rounded-sm border border-border bg-secondary text-primary">
          <HardDrivesIcon />
        </div>
        <div className="max-w-xl">
          <h2 className="font-heading text-sm font-medium">No hosts saved yet</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            A host is a label, an address and the key to use. Everything you add is encrypted in the
            browser before it is stored, and the ciphertext syncs to your other devices, so the same
            list is there when you open a tab somewhere else.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            The server holds a blob it has no key for, which means it cannot search your hosts on
            your behalf. That is why the search box above filters locally, over records this tab has
            already decrypted.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onAdd}>
            <PlusIcon /> Add host
          </Button>
          <Button variant="outline" onClick={onImport}>
            <UploadSimpleIcon /> Import from ssh_config
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard/terminal">Connect without saving</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function NoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-3 py-10">
        <h2 className="font-heading text-sm font-medium">Nothing matches &ldquo;{query}&rdquo;</h2>
        <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
          The filter looks at labels, addresses, usernames, folders and tags on the hosts this tab
          has decrypted.
        </p>
        <Button variant="outline" onClick={onClear}>
          Clear search
        </Button>
      </CardContent>
    </Card>
  )
}

function LoadingRows() {
  return (
    <div className="rounded-sm border border-border">
      <div className="divide-y divide-border">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-4 p-3">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="hidden h-3 w-24 sm:block" />
            <Skeleton className="size-7" />
          </div>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ pieces */

function Field({
  id,
  label,
  required,
  children,
}: {
  id: string
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {label}
        {!required && (
          <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
            optional
          </span>
        )}
      </Label>
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------ format */

/** SHA256:base64 fingerprints are too long for a column; the tooltip has it all. */
function truncate(fingerprint: string) {
  return fingerprint.length > 22 ? `${fingerprint.slice(0, 22)}…` : fingerprint
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
]

function lastUsed(host: Host) {
  if (!host.lastUsedAt) return "Never connected"
  const delta = host.lastUsedAt - Date.now()
  const abs = Math.abs(delta)
  if (abs < 60_000) return "Just now"

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
  for (const [unit, ms] of UNITS) {
    if (abs >= ms) return rtf.format(Math.round(delta / ms), unit)
  }
  return "Just now"
}
