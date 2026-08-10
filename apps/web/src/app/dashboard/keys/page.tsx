"use client"

// Client component: keys live in this browser's IndexedDB as non-extractable
// WebCrypto handles, and the vault key exists only in this tab's memory. The
// server holds ciphertext it has no key for, so there is nothing to render on
// it — the list can only be read after the browser has decrypted it.

import * as React from "react"
import Link from "next/link"
import {
  CheckIcon,
  CloudArrowUpIcon,
  CopyIcon,
  DesktopTowerIcon,
  FingerprintIcon,
  KeyIcon,
  LockKeyIcon,
  PlusIcon,
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import {
  authorizedKeysLine,
  deleteKey,
  generateKey,
  importKey,
  inspectImportedKey,
  KeyPassphraseError,
  listStoredKeys,
  listUnwrappableKeyIds,
  type KeyMode,
  type KeyPreview,
  type StoredKey,
} from "@/lib/keys"
import { loadSSH, type SshLoadProgress } from "@/lib/ssh/wasm"
import type { SshKeyType } from "@/lib/ssh/types"
import { getVaultKey, useVaultUnlocked } from "@/lib/vault/session"
import { syncVault } from "@/lib/vault/sync"
import { cn } from "@/lib/utils"
import { noAutofillSecret } from "@/lib/no-autofill"

/* ------------------------------------------------------------------ helpers */

/** The line as it must appear in ~/.ssh/authorized_keys. */
function lineFor(key: StoredKey): string {
  return authorizedKeysLine({
    publicKeyRaw: new Uint8Array(key.publicKeyRaw),
    label: key.label,
  })
}

/** What we put on the clipboard: the whole command, not just the key. */
function installCommand(line: string): string {
  return `echo '${line}' >> ~/.ssh/authorized_keys`
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

/* --------------------------------------------------------------------- page */

export default function KeysPage() {
  const [keys, setKeys] = React.useState<StoredKey[]>([])
  const [loading, setLoading] = React.useState(true)
  const unlocked = useVaultUnlocked()
  // Ids of portable keys the current vault key does not open. Empty while
  // locked, because "cannot open it" and "have no key to try" are different
  // facts and only the first is a broken key.
  const [broken, setBroken] = React.useState<Set<string>>(new Set())

  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [importOpen, setImportOpen] = React.useState(false)
  const [label, setLabel] = React.useState("webxterm")
  const [mode, setMode] = React.useState<KeyMode>("device-bound")
  const [generating, setGenerating] = React.useState(false)

  const [pendingDelete, setPendingDelete] = React.useState<StoredKey | null>(null)

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const stored = await listStoredKeys()
        if (cancelled) return
        setKeys(stored)
      } catch {
        if (!cancelled) toast.error("Could not read the local key store.")
      } finally {
        if (!cancelled) {
          // The vault key is held in memory only, so this is a per-tab fact and
          // can only be read after mount.
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Re-run whenever the list or the unlock state changes: unwrapping is the only
  // way to answer the question, and it needs both.
  React.useEffect(() => {
    let cancelled = false
    const vaultKey = getVaultKey()
    // One code path, resolved rather than branched, so the state update always
    // happens in a callback: a synchronous setState in an effect body is a
    // cascading render, and the "nothing to check" case would otherwise take it.
    const probe =
      unlocked && vaultKey && keys.length > 0
        ? listUnwrappableKeyIds(vaultKey)
        : Promise.resolve(new Set<string>())
    void probe.then((ids) => {
      if (!cancelled) setBroken(ids)
    })
    return () => {
      cancelled = true
    }
  }, [keys, unlocked])

  /** Best-effort push of the encrypted vault; never blocks the local write. */
  const pushVault = React.useCallback(async () => {
    const vaultKey = getVaultKey()
    if (!vaultKey) return
    try {
      const result = await syncVault(vaultKey)
      if (result.status === "offline") {
        toast.message("Saved on this device. The server could not be reached.")
      } else if (result.keysWithheld > 0) {
        // Not a failure of this write, but the user has to hear it from
        // somewhere and this page is where the affected keys are.
        toast.warning(
          `${result.keysWithheld} portable ${result.keysWithheld === 1 ? "key was" : "keys were"} not uploaded`,
          {
            description:
              "Their wrapping does not open with your current vault key, so uploading them would copy unusable ciphertext to every device. They are marked below.",
          },
        )
      }
    } catch {
      toast.message("Saved on this device. The vault will sync on the next attempt.")
    }
  }, [])

  function openDialog() {
    // `unlocked` is reactive, so it is already current here.
    setMode(unlocked ? "portable" : "device-bound")
    setLabel("webxterm")
    setDialogOpen(true)
  }

  /** Shared by both dialogs: land the new key in the list and push it. */
  const afterCreated = React.useCallback(
    async (created: { label: string; mode: KeyMode }, verb: "Generated" | "Imported") => {
      setKeys(await listStoredKeys())
      toast.success(`${verb} ${created.label}. Add its line to your server.`)
      if (created.mode === "portable") await pushVault()
    },
    [pushVault],
  )

  async function handleGenerate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const vaultKey = getVaultKey()

    if (mode === "portable" && !vaultKey) {
      toast.error("The vault is locked, so a portable key cannot be wrapped.")
      return
    }

    setGenerating(true)
    try {
      const created = await generateKey(label.trim() || "webxterm", mode, vaultKey ?? undefined)
      setDialogOpen(false)
      await afterCreated(created, "Generated")
    } catch (error) {
      // generateKey refuses a portable key without a vault key; surface its
      // message rather than a generic failure.
      toast.error(String((error as Error).message ?? error))
    } finally {
      setGenerating(false)
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return
    const { id, label: name } = pendingDelete
    setPendingDelete(null)
    try {
      await deleteKey(id)
      setKeys(await listStoredKeys())
      toast.success(`Deleted ${name}. Remove its line from your servers.`)
      await pushVault()
    } catch {
      toast.error("Could not delete the key from the local store.")
    }
  }

  const deviceBoundCount = keys.filter((k) => k.mode === "device-bound").length

  return (
    <>
      <PageHeader
        eyebrow="Dashboard"
        title="Keys"
        description="Ed25519 keys, generated in this browser or imported from one you already have. The private half is a non-extractable WebCrypto handle: it signs the SSH handshake, and nothing — our code included — can read its bytes."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <UploadSimpleIcon /> Import a key
            </Button>
            <Button onClick={openDialog}>
              <PlusIcon /> Generate key
            </Button>
          </div>
        }
      />

      <div className="flex flex-col gap-4 py-6">
        {!loading && !unlocked && keys.some((k) => k.mode === "portable") && (
          <Alert>
            <LockKeyIcon />
            <AlertTitle>The vault is locked in this tab</AlertTitle>
            <AlertDescription>
              <p>
                Portable keys are stored wrapped with your vault key, which lives only in memory and
                is cleared on reload. They are listed below, but they cannot sign until you sign in
                again. Device-bound keys are unaffected.
              </p>
              <p>
                <Link href="/sign-in">Sign in to unlock</Link>
              </p>
            </AlertDescription>
          </Alert>
        )}

        {loading ? (
          <LoadingCards />
        ) : keys.length === 0 ? (
          <EmptyState onGenerate={openDialog} onImport={() => setImportOpen(true)} />
        ) : (
          <>
            <div className="flex flex-col gap-3">
              {keys.map((key) => (
                <KeyCard
                  key={key.id}
                  storedKey={key}
                  vaultUnlocked={unlocked}
                  unwrappable={broken.has(key.id)}
                  onDelete={() => setPendingDelete(key)}
                />
              ))}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {deviceBoundCount > 0
                ? `${deviceBoundCount} of these ${
                    deviceBoundCount === 1 ? "key exists" : "keys exist"
                  } only in this browser profile. Clearing site data for this origin deletes ${
                    deviceBoundCount === 1 ? "it" : "them"
                  } with no way back.`
                : "Every key here is portable, so the same set is available on any device you sign in on."}
            </p>
          </>
        )}
      </div>

      {/* ------------------------------------------------------ generate key */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Generate key</DialogTitle>
            <DialogDescription>
              An Ed25519 pair is created in WebCrypto. The private key is non-extractable in use;
              only the public half ever leaves this page.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleGenerate} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="key-label">Label</Label>
              <Input
                id="key-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="webxterm"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                Becomes the comment at the end of the authorized_keys line, so you can tell your
                keys apart in the file.
              </p>
            </div>

            <fieldset className="grid gap-2">
              <legend className="mb-2 text-xs font-medium">Custody</legend>

              <ModeOption
                id="mode-portable"
                name="key-mode"
                checked={mode === "portable"}
                disabled={!unlocked}
                onSelect={() => setMode("portable")}
                icon={<CloudArrowUpIcon />}
                title="Portable"
                body="Wrapped with your vault key the moment it is generated, then re-imported non-extractable. The wrapped copy syncs as ciphertext, so this key is usable on every device you sign in on, and one authorized_keys line covers all of them."
              />

              <ModeOption
                id="mode-device-bound"
                name="key-mode"
                checked={mode === "device-bound"}
                onSelect={() => setMode("device-bound")}
                icon={<DesktopTowerIcon />}
                title="Device-bound"
                body="Generated non-extractable from the start and never wrapped, so it cannot sync anywhere. Each browser you work from needs its own key, and therefore its own line on every server."
              />
            </fieldset>

            {!unlocked && (
              <Alert>
                <LockKeyIcon />
                <AlertTitle>Portable needs the vault unlocked</AlertTitle>
                <AlertDescription>
                  <p>
                    Wrapping happens with the vault key, which is derived from your password in the
                    browser and never persisted. This tab does not have it, so portable is
                    unavailable until you sign in again. A device-bound key can be generated right
                    now.
                  </p>
                  <p>
                    <Link href="/sign-in">Sign in to unlock the vault</Link>
                  </p>
                </AlertDescription>
              </Alert>
            )}

            {mode === "device-bound" && (
              <Alert className="border-warning/40">
                <WarningIcon className="text-warning" />
                <AlertTitle>This key cannot be recovered</AlertTitle>
                <AlertDescription>
                  There is no wrapped copy and no export, so clearing site data, using a private
                  window, or reinstalling this browser destroys it permanently. Recovering means
                  generating a new key and adding its line to every server again.
                </AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={generating}>
                {generating ? "Generating" : "Generate key"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* -------------------------------------------------------- import key */}
      <ImportKeyDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        vaultUnlocked={unlocked}
        onImported={(created) => afterCreated(created, "Imported")}
      />

      {/* -------------------------------------------------------- delete key */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.mode === "device-bound"
                ? "This key exists only in this browser and cannot be exported, so deleting it is final. Its line stays in ~/.ssh/authorized_keys on every server you added it to — the server will keep offering it until you remove the line yourself."
                : "The wrapped copy is deleted here and on your other devices at the next sync. Its line stays in ~/.ssh/authorized_keys on every server you added it to — the server will keep offering it until you remove the line yourself."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDelete}>
              Delete key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/* ------------------------------------------------------------- import key */

/** The SSH wire name for a parsed key type, which is what people recognise. */
const SSH_NAME: Record<SshKeyType, string> = {
  ed25519: "ssh-ed25519",
  "ecdsa-p256": "ecdsa-sha2-nistp256",
  rsa: "ssh-rsa",
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`

/**
 * A file name makes a good default label — id_ed25519 is more use than
 * "imported" — but it lands in the authorized_keys comment, and the installer
 * rejects anything outside [A-Za-z0-9@._-].
 */
function labelFromFileName(name: string): string {
  const base = name.replace(/\.(pem|key|txt|priv)$/i, "").replace(/[^A-Za-z0-9@._-]/g, "-")
  return base || "imported"
}

/**
 * Import in two steps: read the key, then look at what came back before it is
 * stored. The parse is repeated on save so that plaintext PKCS#8 never waits
 * around in component state while the review panel is open — see the note in
 * lib/keys.ts.
 */
function ImportKeyDialog({
  open,
  onOpenChange,
  vaultUnlocked,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  vaultUnlocked: boolean
  onImported: (created: { label: string; mode: KeyMode }) => Promise<void>
}) {
  const [pem, setPem] = React.useState("")
  const [fileName, setFileName] = React.useState("")
  const [passphrase, setPassphrase] = React.useState("")
  const [askPassphrase, setAskPassphrase] = React.useState(false)
  const [preview, setPreview] = React.useState<KeyPreview | null>(null)
  const [label, setLabel] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [core, setCore] = React.useState<SshLoadProgress | null>(null)
  const [coreError, setCoreError] = React.useState<string | null>(null)
  // Bumped by the retry button. loadSSH() forgets a failed attempt, so calling
  // it again is a genuine second try rather than a replay of the same rejection.
  const [coreAttempt, setCoreAttempt] = React.useState(0)
  const passphraseRef = React.useRef<HTMLInputElement>(null)

  // Left null until someone picks, so the default tracks the vault as it is
  // now rather than as it was when this component last reset itself.
  const [chosenMode, setChosenMode] = React.useState<KeyMode | null>(null)
  const mode: KeyMode = chosenMode ?? (vaultUnlocked ? "portable" : "device-bound")

  React.useEffect(() => {
    if (!open) return
    // Start the 6 MB core downloading the moment the dialog opens rather than
    // on the first click, and watch it so the wait is visible instead of the
    // button appearing to do nothing.
    // The previous attempt's error is cleared by whatever starts a new attempt
    // — closing the dialog, or the retry button — not from here. Clearing it
    // in the effect body would be a state write on every open that renders a
    // second time for no new information.
    let cancelled = false
    void loadSSH((p) => {
      if (!cancelled) setCore(p)
    }).catch((failure: unknown) => {
      if (cancelled) return
      // Dropping the progress matters as much as showing the error. Nothing is
      // downloading any more, and a byte count left sitting on screen says the
      // opposite — the usual cause is being offline, which is precisely when a
      // stalled-looking bar is read as "still trying".
      setCore(null)
      setCoreError(String((failure as Error).message ?? failure))
    })
    return () => {
      cancelled = true
    }
  }, [open, coreAttempt])

  /**
   * Everything typed here is dropped when the dialog closes, not when it next
   * opens: a pasted private key should not outlive the dialog that asked for
   * it, however long the tab stays open afterwards.
   */
  function handleOpenChange(next: boolean) {
    if (!next) {
      setPem("")
      setPassphrase("")
      setFileName("")
      setAskPassphrase(false)
      setPreview(null)
      setLabel("")
      setChosenMode(null)
      setError(null)
      setCoreError(null)
    }
    onOpenChange(next)
  }

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // Reset the input so choosing the same file twice still fires a change.
    event.target.value = ""
    if (!file) return

    if (file.size > 64_000) {
      setError(
        `${file.name} is ${megabytes(file.size)}. No SSH private key is that large — ` +
          "this is probably not the file you meant.",
      )
      return
    }
    setError(null)
    setPreview(null)
    setFileName(file.name)
    setPem(await file.text())
  }

  async function handleRead(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const found = await inspectImportedKey(pem, passphrase)
      setPreview(found)
      setLabel(found.comment ?? (fileName ? labelFromFileName(fileName) : "imported"))
    } catch (failure) {
      if (failure instanceof KeyPassphraseError) {
        // An encrypted key is a question, not a failure: show the field and put
        // the cursor in it rather than printing the parser's error.
        setAskPassphrase(true)
        setError(failure.message)
        requestAnimationFrame(() => passphraseRef.current?.focus())
      } else {
        setError(String((failure as Error).message ?? failure))
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    const vaultKey = getVaultKey()
    if (mode === "portable" && !vaultKey) {
      setError("The vault is locked, so a portable key cannot be wrapped.")
      return
    }

    setBusy(true)
    setError(null)
    try {
      const stored = await importKey(pem, {
        label: label.trim() || "imported",
        mode,
        passphrase,
        vaultKey: vaultKey ?? undefined,
      })
      handleOpenChange(false)
      await onImported({ label: stored.label, mode })
    } catch (failure) {
      setError(String((failure as Error).message ?? failure))
    } finally {
      setBusy(false)
    }
  }

  const loadingCore = core !== null && !core.done
  const percent =
    core && core.total > 0 ? Math.min(100, Math.round((core.loaded / core.total) * 100)) : null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import a key</DialogTitle>
          <DialogDescription>
            Reads an existing OpenSSH private key and takes custody of it: from here on it is a
            non-extractable handle, exactly like a key generated in this page.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={preview ? handleSave : handleRead} className="grid gap-4">
          {!preview ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="import-pem">Private key</Label>
                <textarea
                  id="import-pem"
                  value={pem}
                  onChange={(e) => setPem(e.target.value)}
                  rows={6}
                  spellCheck={false}
                  autoCapitalize="none"
                  autoComplete="off"
                  placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----"}
                  className="w-full resize-y rounded-none border border-input bg-transparent px-2.5 py-2 font-mono text-[11px] leading-relaxed break-all transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  The file without the .pub extension — ~/.ssh/id_ed25519 rather than
                  ~/.ssh/id_ed25519.pub.
                </p>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="import-file">Or choose the file</Label>
                {/* No accept filter: key files usually have no extension at all,
                    and every filter that catches id_ed25519 also greys it out
                    somewhere. The content is validated instead. */}
                <Input id="import-file" type="file" onChange={handleFile} />
                {fileName && <p className="text-xs text-muted-foreground">Read from {fileName}.</p>}
              </div>

              {askPassphrase && (
                <div className="grid gap-1.5">
                  <Label htmlFor="import-passphrase">Passphrase</Label>
                  {/* The private key file's passphrase, not the account's.
                      autoComplete="off" is ignored on password fields; only
                      "new-password" suppresses the fill. See lib/no-autofill.ts. */}
                  <Input
                    id="import-passphrase"
                    name="key-file-secret"
                    ref={passphraseRef}
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    {...noAutofillSecret}
                  />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Used once, here, to decrypt the file. It is not stored, and the key does not
                    keep it — webxterm has nowhere to type a passphrase at connect time.
                  </p>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="rounded-sm border border-border">
                <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
                  <FingerprintIcon className="size-3.5 text-success" />
                  <span className="text-muted-foreground">Read from the key you supplied</span>
                </div>
                <dl className="grid gap-1.5 px-2.5 py-2 text-xs">
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">Type</dt>
                    <dd className="text-foreground">
                      {SSH_NAME[preview.keyType]} · {preview.bits} bits
                    </dd>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <dt className="text-muted-foreground">Fingerprint</dt>
                    <dd className="break-all text-foreground">{preview.fingerprint}</dd>
                  </div>
                </dl>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Check that fingerprint against{" "}
                <code className="text-foreground">ssh-keygen -lf ~/.ssh/id_ed25519</code> on the
                machine the key came from. It is derived from the private half, not copied out of
                the file, so it is what your servers will actually see.
              </p>

              <div className="grid gap-1.5">
                <Label htmlFor="import-label">Label</Label>
                <Input
                  id="import-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="imported"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </div>

              <fieldset className="grid gap-2">
                <legend className="mb-2 text-xs font-medium">Custody</legend>

                <ModeOption
                  id="import-mode-portable"
                  name="import-key-mode"
                  checked={mode === "portable"}
                  disabled={!vaultUnlocked}
                  onSelect={() => setChosenMode("portable")}
                  icon={<CloudArrowUpIcon />}
                  title="Portable"
                  body="Wrapped with your vault key as it is imported, then re-imported non-extractable. The wrapped copy syncs as ciphertext, so this key works on every device you sign in on."
                />

                <ModeOption
                  id="import-mode-device-bound"
                  name="import-key-mode"
                  checked={mode === "device-bound"}
                  onSelect={() => setChosenMode("device-bound")}
                  icon={<DesktopTowerIcon />}
                  title="Device-bound"
                  body="Held only as a handle in this browser, never wrapped and never synced. You still have the original file, so this one is replaceable — import it again elsewhere."
                />
              </fieldset>

              <Alert>
                <LockKeyIcon />
                <AlertTitle>What happens to the key text</AlertTitle>
                <AlertDescription>
                  <p>
                    It is parsed, imported into WebCrypto as a non-extractable handle, and the
                    plaintext copy is zeroed immediately after. What survives is that handle
                    {/* biome-ignore lint/suspicious/noSuspiciousSemicolonInJsx: prose punctuation — the
                        semicolon ends the clause the conditional above completes, and is meant to render */}
                    {mode === "portable" ? ", plus a copy encrypted with your vault key" : ""};
                    neither can be read back out.
                  </p>
                  <p>
                    Worth being straight about the limit. A key generated here has never existed as
                    a file. This one has, on another machine, and probably still does — in backups,
                    in a dotfiles repo, wherever it has been. Non-extractable custody starts now; it
                    does not reach backwards.
                  </p>
                </AlertDescription>
              </Alert>

              {!vaultUnlocked && (
                <Alert>
                  <LockKeyIcon />
                  <AlertTitle>Portable needs the vault unlocked</AlertTitle>
                  <AlertDescription>
                    <p>
                      This tab does not hold the vault key, so there is nothing to wrap the key
                      with. Importing it device-bound works now, and the original file is still
                      yours to import again later.
                    </p>
                    <p>
                      <Link href="/sign-in">Sign in to unlock the vault</Link>
                    </p>
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}

          {loadingCore && (
            <div className="grid gap-1.5">
              {/* No bar without a Content-Length: a progress bar pinned at zero
                  claims less than the byte count does. */}
              {percent !== null && <Progress value={percent} />}
              <p className="text-xs text-muted-foreground">
                {percent === null
                  ? `Loading the SSH core — ${megabytes(core.loaded)} so far`
                  : `Loading the SSH core — ${megabytes(core.loaded)} of about ${megabytes(core.total)}`}
                . Parsing runs in the same WebAssembly module that speaks SSH, so it has to be here
                first.
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
                  Key parsing happens inside that module, so there is nothing here to read a key
                  with until it arrives. It is a static file and a retry is usually all it takes.
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
              <AlertTitle>
                {askPassphrase && !preview ? "Passphrase" : "Could not read that key"}
              </AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            {preview ? (
              // Back means "read a different key", so it resets the whole read
              // step and not only the preview. Leaving the passphrase behind
              // made the next key fail: a non-empty passphrase sends the parser
              // down its decrypt branch, and an unencrypted id_ed25519 is then
              // rejected as not being encrypted — a self-inflicted failure that
              // reads as the app refusing a perfectly good key.
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setPreview(null)
                  setPassphrase("")
                  setAskPassphrase(false)
                  setError(null)
                }}
              >
                Back
              </Button>
            ) : (
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
            )}
            <Button type="submit" disabled={busy || (!preview && pem.trim() === "")}>
              {busy ? (preview ? "Importing" : "Reading") : preview ? "Import key" : "Read key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ----------------------------------------------------------------- key card */

function KeyCard({
  storedKey,
  vaultUnlocked,
  unwrappable,
  onDelete,
}: {
  storedKey: StoredKey
  vaultUnlocked: boolean
  /** The vault is unlocked and this key's wrapping still does not open. */
  unwrappable: boolean
  onDelete: () => void
}) {
  const line = React.useMemo(() => lineFor(storedKey), [storedKey])
  const deviceBound = storedKey.mode === "device-bound"

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-heading truncate text-sm font-medium text-foreground">
                {storedKey.label}
              </h2>
              <Badge variant={deviceBound ? "outline" : "secondary"} className="font-normal">
                {deviceBound ? <DesktopTowerIcon /> : <CloudArrowUpIcon />}
                {storedKey.mode}
              </Badge>
            </div>
            <p className="mt-1 text-muted-foreground">
              ssh-ed25519 · created {formatDate(storedKey.createdAt)}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onDelete}
            aria-label={`Delete ${storedKey.label}`}
          >
            <TrashIcon />
          </Button>
        </div>

        <div className="rounded-sm border border-border">
          <div className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-1.5">
            <span className="truncate text-muted-foreground">~/.ssh/authorized_keys line</span>
            <CopyButton value={installCommand(line)} />
          </div>
          {/* break-all rather than a scroller: the line must never push the
              page sideways on a phone. */}
          <pre className="bg-terminal px-2.5 py-2 text-[11px] leading-relaxed break-all whitespace-pre-wrap">
            <code>{line}</code>
          </pre>
        </div>

        <p className="text-muted-foreground">
          The copy button gives you{" "}
          <code className="text-foreground">
            echo &apos;…&apos; &gt;&gt; ~/.ssh/authorized_keys
          </code>
          , ready to paste into a shell on the server. Stock sshd, no agent, no daemon.
        </p>

        {deviceBound && (
          <Alert className="border-warning/40">
            <WarningIcon className="text-warning" />
            <AlertTitle>Bound to this browser</AlertTitle>
            <AlertDescription>
              Clearing site data for this origin destroys this key irrecoverably; there is no
              wrapped copy anywhere to restore from. It also does not sync, so any other device
              needs its own key and its own line on this server.
            </AlertDescription>
          </Alert>
        )}

        {!deviceBound && !vaultUnlocked && (
          <p className="text-muted-foreground">
            <LockKeyIcon className="mr-1.5 inline size-3.5 align-[-2px]" />
            Wrapped with the vault key, which this tab does not currently hold. Sign in again before
            connecting with it.
          </p>
        )}

        {unwrappable && (
          <Alert className="border-destructive/40">
            <WarningIcon className="text-destructive" />
            <AlertTitle>This key cannot be opened and will not sign</AlertTitle>
            <AlertDescription>
              <p>
                Its wrapping was made with a vault key your current password no longer derives —
                almost always a password change that happened while this browser was offline, so the
                re-key never saw this key and could not move it to the new key. Nothing here can
                undo that: the only thing that opens the wrapping is the old vault key, which no
                longer exists.
              </p>
              <p>
                It is not uploaded to your other devices, so the damage stops at this browser.
                Delete it here, remove its line from{" "}
                <code className="text-foreground">~/.ssh/authorized_keys</code> on every server you
                added it to, and generate a replacement.
              </p>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------- copy button */

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("The browser refused clipboard access. Select the line and copy it by hand.")
    }
  }

  return (
    <Button variant="ghost" size="xs" onClick={copy} className="shrink-0">
      {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      {copied ? "Copied" : "Copy command"}
    </Button>
  )
}

/* -------------------------------------------------------------- mode option */

function ModeOption({
  id,
  name,
  checked,
  disabled,
  onSelect,
  icon,
  title,
  body,
}: {
  id: string
  /** Radio group name: the generate and import dialogs must not share one. */
  name: string
  checked: boolean
  disabled?: boolean
  onSelect: () => void
  icon: React.ReactNode
  title: string
  body: string
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer gap-3 rounded-sm border border-border p-3 transition-colors",
        checked ? "border-primary bg-secondary/50" : "hover:border-primary/40",
        disabled && "cursor-not-allowed opacity-50 hover:border-border",
      )}
    >
      <input
        type="radio"
        id={id}
        name={name}
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
      />
      <span
        className={cn(
          "mt-0.5 grid size-7 shrink-0 place-items-center rounded-sm border border-border bg-secondary",
          checked ? "text-primary" : "text-muted-foreground",
        )}
        aria-hidden
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="font-heading block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-1 block leading-relaxed text-muted-foreground">{body}</span>
      </span>
    </label>
  )
}

/* ------------------------------------------------------- empty and loading */

function EmptyState({ onGenerate, onImport }: { onGenerate: () => void; onImport: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-4 py-6 sm:px-8">
        <div className="grid size-9 place-items-center rounded-sm border border-border bg-secondary text-primary">
          <KeyIcon />
        </div>
        <div className="max-w-xl">
          <h2 className="font-heading text-sm font-medium">No keys yet</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            A key is generated here, in the page, and the private half is a WebCrypto handle marked
            non-extractable. It can sign the SSH handshake and nothing else; there is no file to
            leak and no passphrase to forget.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Setting up a server is one line appended to ~/.ssh/authorized_keys on stock sshd. If you
            would rather not paste it, connect once with a password and webxterm installs the line
            for you.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            If your servers already know an Ed25519 key of yours, import it instead and every one of
            them keeps working untouched.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onGenerate}>
            <PlusIcon /> Generate key
          </Button>
          <Button variant="outline" onClick={onImport}>
            <UploadSimpleIcon /> Import a key
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard/terminal">Connect with a password once</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function LoadingCards() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1].map((i) => (
        <Card key={i}>
          <CardContent className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-4 w-16" />
            </div>
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-14 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
