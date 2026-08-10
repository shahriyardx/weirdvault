"use client"

// Client component, for the same reason the hosts list is one: snippets are
// stored encrypted and only exist as plaintext after this tab has decrypted
// them. There is nothing here the server could render, because there is nothing
// here the server can read.

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  ArrowElbowDownLeftIcon,
  CodeIcon,
  CopyIcon,
  CursorTextIcon,
  DotsThreeIcon,
  MagnifyingGlassIcon,
  PaperPlaneTiltIcon,
  PencilSimpleIcon,
  PlugsConnectedIcon,
  PlusIcon,
  TrashIcon,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { deleteSnippet, listSnippets, saveSnippet, type Snippet } from "@/lib/snippets"
import { useSshSession, type SessionEntry } from "@/lib/ssh/session-provider"
import { getVaultKey } from "@/lib/vault/session"
import { syncVault } from "@/lib/vault/sync"

/* -------------------------------------------------------------------- form */

interface SnippetForm {
  id?: string
  createdAt?: number
  name: string
  body: string
  description: string
  tags: string
}

const blankForm = (): SnippetForm => ({
  name: "",
  body: "",
  description: "",
  tags: "",
})

const formFor = (s: Snippet): SnippetForm => ({
  id: s.id,
  createdAt: s.createdAt,
  name: s.name,
  body: s.body,
  description: s.description ?? "",
  tags: (s.tags ?? []).join(", "),
})

/**
 * Stored bodies never end in a newline.
 *
 * A trailing newline is invisible in a text box but it decides whether the last
 * line of a snippet runs or just sits at the prompt — which is precisely the
 * distinction Insert and Run exist to make explicit. Letting it hide in the
 * stored text would mean the same button did different things depending on
 * whether someone happened to press Enter before saving. Normalising it away
 * here makes the button the only thing that decides.
 *
 * CRLF is folded to LF so that stored text has exactly one representation of a
 * line break regardless of which platform pasted it. What goes on the wire is
 * toWire's decision, not the storage format's.
 */
function normaliseBody(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").trimEnd()
}

/**
 * Turns a stored body into the bytes a keyboard would have produced.
 *
 * Pressing Enter in the terminal does not send a line feed. xterm reports a
 * carriage return, and src/components/terminal.tsx forwards onData to the
 * session untouched, so `\r` is literally what every command the user has ever
 * typed in this app arrived as. Sending `\n` instead usually works — readline
 * binds Ctrl-J to accept-line as well, and the default line discipline maps CR
 * to NL anyway — but "usually" is the wrong standard when the alternative is
 * sending exactly what the keyboard sends. Interior newlines are converted too,
 * for the same reason: a two-line snippet is two Enter presses.
 *
 * What this does not do is protect a snippet from a shell that is not at a
 * prompt. If the session is running vim, or a program reading raw keystrokes,
 * these bytes go to that program and mean whatever it decides they mean. There
 * is no way to detect that from here — the client sees an opaque byte stream —
 * so the dialog shows the target session and lets the user judge.
 */
function toWire(body: string, execute: boolean): string {
  const typed = body.replace(/\n/g, "\r")
  return execute ? `${typed}\r` : typed
}

/* -------------------------------------------------------------------- page */

export default function SnippetsPage() {
  const router = useRouter()
  const { sessions, activeId, setActive, write } = useSshSession()

  const [snippets, setSnippets] = React.useState<Snippet[]>([])
  const [loading, setLoading] = React.useState(true)
  const [query, setQuery] = React.useState("")

  const [form, setForm] = React.useState<SnippetForm | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [pendingDelete, setPendingDelete] = React.useState<Snippet | null>(null)
  const [sendTarget, setSendTarget] = React.useState<Snippet | null>(null)

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const all = await listSnippets()
        if (!cancelled) setSnippets(all)
      } catch {
        if (!cancelled) toast.error("Could not read the local snippet store.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Pushes the encrypted vault and reports what actually happened.
   *
   * The local write has already succeeded by the time this runs, so none of
   * these outcomes is a failure — but they are three different states and the
   * toast says which one it is. "Saved" on its own would imply the other devices
   * have it, and a locked vault or a dead network means they do not. One toast
   * per mutation, carrying the real outcome, rather than a cheerful one followed
   * by a correction.
   */
  const persist = React.useCallback(async (done: string) => {
    const vaultKey = getVaultKey()
    if (!vaultKey) {
      toast.success(
        `${done} The vault is locked in this tab, so it stays on this device until you unlock.`,
      )
      return
    }
    try {
      // syncVault reports being offline by returning, not by throwing — the
      // catch below never sees it — so the result has to be read. Saying
      // "Synced" after a failed pull would be the cheerful lie this comment
      // block promises not to tell.
      const result = await syncVault(vaultKey)
      if (result.status === "offline") {
        toast.message(
          `${done} The server could not be reached, so it is on this device only for now.`,
        )
      } else {
        toast.success(`${done} Synced.`)
      }
    } catch {
      toast.message(`${done} On this device only — the vault will sync on the next attempt.`)
    }
  }, [])

  // Local search, because the vault is a blob the server cannot index. Bodies
  // are searched as well as names: half the time what you remember about a
  // snippet is a flag in the middle of it.
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return snippets
    return snippets.filter((s) =>
      [s.name, s.description ?? "", (s.tags ?? []).join(" "), s.body]
        .join(" ")
        .toLowerCase()
        .includes(q),
    )
  }, [snippets, query])

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!form) return

    const name = form.name.trim()
    const body = normaliseBody(form.body)

    if (!name) {
      toast.error("Give the snippet a name so you can find it later.")
      return
    }
    if (!body) {
      toast.error("A snippet with an empty body has nothing to send.")
      return
    }

    setSaving(true)
    try {
      const tags = form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)

      await saveSnippet({
        id: form.id,
        createdAt: form.createdAt,
        name,
        body,
        description: form.description.trim() || undefined,
        tags: tags.length ? tags : undefined,
      })

      setSnippets(await listSnippets())
      setForm(null)
      await persist(form.id ? `Updated ${name}.` : `Saved ${name}.`)
    } catch {
      toast.error("Could not write to the local snippet store.")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return
    const { id, name } = pendingDelete
    setPendingDelete(null)
    try {
      await deleteSnippet(id)
      setSnippets(await listSnippets())
      await persist(`Deleted ${name}.`)
    } catch {
      toast.error("Could not delete the snippet.")
    }
  }

  async function handleCopy(snippet: Snippet) {
    try {
      await navigator.clipboard.writeText(snippet.body)
      toast.success(`Copied ${snippet.name} to the clipboard.`)
    } catch {
      // Clipboard access is refused outside secure contexts and whenever the
      // user has denied the permission. Claiming a copy that did not happen
      // would be worse than saying so.
      toast.error("The browser refused clipboard access. Select the text and copy it.")
    }
  }

  /**
   * Sends a snippet to a live session.
   *
   * `execute` is the whole safety design in one boolean. Writing a body to a PTY
   * types it; the shell only acts on a line once it receives the return that
   * ends it. Insert therefore stops one keystroke short — the stored body never
   * carries a trailing newline, so the text lands at the prompt with the cursor
   * after it and can be read, edited, or abandoned. Run adds the return and the
   * shell executes.
   *
   * Note what Insert does *not* promise: a snippet with several lines contains
   * real line breaks between them, and those are sent as returns too, so every
   * line but the last runs immediately either way. The dialog says so rather
   * than implying Insert is a preview mode.
   *
   * There is no "are you sure" on Run. These are the user's own commands, saved
   * deliberately, and a confirmation on every run would be ignored within a day
   * and would train the reflex that dismisses the confirmations that matter.
   * What there is instead is the send dialog: picking a session and reading the
   * body is a deliberate act, so nothing executes from a single stray click on
   * a list row.
   */
  function send(snippet: Snippet, sessionId: string, execute: boolean) {
    // The session could have closed while this dialog was open — from the
    // sidebar, or because the server hung up. Writing into a dead session is a
    // silent no-op, so check first rather than report a success that isn't one.
    if (!sessions.some((s) => s.id === sessionId)) {
      toast.error("That session is no longer open.")
      return
    }

    write(sessionId, toWire(snippet.body, execute))
    setSendTarget(null)

    // Send then look elsewhere and you have no idea what happened. Switch to
    // the session that just received it.
    setActive(sessionId)
    router.push("/dashboard/terminal")
  }

  return (
    <>
      <PageHeader
        eyebrow="Dashboard"
        title="Snippets"
        description="Commands you would otherwise retype from memory, stored encrypted on this device and synced to your other devices as ciphertext. Send one to any open session."
        actions={
          <Button onClick={() => setForm(blankForm())}>
            <PlusIcon /> New snippet
          </Button>
        }
      />

      <div className="flex flex-col gap-4 py-6">
        {!loading && snippets.length > 0 && sessions.length === 0 && (
          <Alert>
            <PlugsConnectedIcon />
            <AlertTitle>No sessions are open</AlertTitle>
            <AlertDescription>
              <p>
                Snippets are sent to a running shell, so there has to be one. Everything else here —
                editing, copying, searching — works without a connection.
              </p>
              <p>
                <Link href="/dashboard/connect">Connect to a host</Link>
              </p>
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative w-full sm:max-w-xs">
            <MagnifyingGlassIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search snippets"
              aria-label="Search snippets"
              className="pl-8"
              type="search"
            />
          </div>
          <p className="text-xs text-muted-foreground sm:ml-auto">
            {loading
              ? "Reading the local store"
              : `${filtered.length} of ${snippets.length} ${
                  snippets.length === 1 ? "snippet" : "snippets"
                }`}
          </p>
        </div>

        {loading ? (
          <LoadingCards />
        ) : snippets.length === 0 ? (
          <EmptyState onCreate={() => setForm(blankForm())} />
        ) : filtered.length === 0 ? (
          <NoMatches query={query} onClear={() => setQuery("")} />
        ) : (
          <div className="flex flex-col gap-3">
            {filtered.map((snippet) => (
              <SnippetCard
                key={snippet.id}
                snippet={snippet}
                onSend={() => setSendTarget(snippet)}
                onCopy={() => void handleCopy(snippet)}
                onEdit={() => setForm(formFor(snippet))}
                onDelete={() => setPendingDelete(snippet)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ------------------------------------------------- create / edit form */}
      <Dialog open={form !== null} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{form?.id ? "Edit snippet" : "New snippet"}</DialogTitle>
            <DialogDescription>
              Saved to this browser and to the encrypted vault. The body is sent to the shell
              exactly as written — nothing here is interpreted, substituted or escaped on the way.
            </DialogDescription>
          </DialogHeader>

          {form && (
            <form onSubmit={handleSave} className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="snippet-name">Name</Label>
                <Input
                  id="snippet-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Tail the API log"
                  autoComplete="off"
                  required
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="snippet-body">Body</Label>
                <textarea
                  id="snippet-body"
                  value={form.body}
                  onChange={(e) => setForm({ ...form, body: e.target.value })}
                  placeholder="journalctl -fu api --since '10 min ago'"
                  rows={8}
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                  required
                  className="w-full resize-y rounded-none border border-input bg-transparent px-2.5 py-2 font-mono text-xs leading-relaxed transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Several lines are fine. Each line break is sent as an Enter press, so a multi-line
                  snippet runs line by line in the shell it goes to. Trailing blank lines are
                  dropped when saving: whether the last line runs is decided by Insert or Run, not
                  by whitespace you cannot see.
                </p>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="snippet-description">
                  Description
                  <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
                    optional
                  </span>
                </Label>
                <Input
                  id="snippet-description"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="What it is for, or what it assumes"
                  autoComplete="off"
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="snippet-tags">
                  Tags
                  <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
                    optional
                  </span>
                </Label>
                <Input
                  id="snippet-tags"
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  placeholder="deploy, postgres"
                  autoComplete="off"
                />
              </div>

              <DialogFooter className="mt-1">
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    Cancel
                  </Button>
                </DialogClose>
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving" : form.id ? "Save changes" : "Save snippet"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <SendDialog
        snippet={sendTarget}
        sessions={sessions}
        preferredId={activeId}
        onClose={() => setSendTarget(null)}
        onSend={send}
      />

      {/* ---------------------------------------------------- delete confirm */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The deletion is recorded and travels with the next vault sync, so the snippet goes
              from your other devices too rather than coming back from one of them. Anything it has
              already run stays run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDelete}>
              Delete snippet
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/* --------------------------------------------------------------- send flow */

function SendDialog({
  snippet,
  sessions,
  preferredId,
  onClose,
  onSend,
}: {
  snippet: Snippet | null
  sessions: SessionEntry[]
  preferredId: string | null
  onClose: () => void
  onSend: (snippet: Snippet, sessionId: string, execute: boolean) => void
}) {
  const [chosen, setChosen] = React.useState<string | null>(null)

  // Derived rather than synchronised in an effect: the default is "the session
  // you were last looking at", and an explicit choice only holds for as long as
  // that session is still open. A session can close while this dialog is up, and
  // a select left pointing at a dead one is how you end up sending nowhere.
  const target =
    chosen && sessions.some((s) => s.id === chosen)
      ? chosen
      : (sessions.find((s) => s.id === preferredId)?.id ?? sessions[0]?.id ?? "")

  const multiline = snippet?.body.includes("\n") ?? false

  return (
    <Dialog open={snippet !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send {snippet?.name}</DialogTitle>
          <DialogDescription>
            The text below goes to the session exactly as it is, as if you had typed it.
          </DialogDescription>
        </DialogHeader>

        {snippet && (
          <div className="grid gap-3">
            <pre className="max-h-56 overflow-auto rounded-none border border-border bg-secondary/40 p-2.5 font-mono text-xs leading-relaxed whitespace-pre">
              {snippet.body}
            </pre>

            {sessions.length === 0 ? (
              <Alert>
                <PlugsConnectedIcon />
                <AlertTitle>Nothing to send it to</AlertTitle>
                <AlertDescription>
                  <p>
                    A snippet is typed into a running shell, and there is no shell open in this tab
                    right now.
                  </p>
                  <p>
                    <Link href="/dashboard/connect">Connect to a host</Link>, then come back and
                    send it.
                  </p>
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="snippet-session">Session</Label>
                  <Select value={target} onValueChange={setChosen}>
                    <SelectTrigger id="snippet-session" className="w-full">
                      <SelectValue placeholder="Choose a session" />
                    </SelectTrigger>
                    <SelectContent>
                      {sessions.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.label}:{s.target.port}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <p className="text-xs leading-relaxed text-muted-foreground">
                  <span className="text-foreground">Insert</span> types the snippet and stops,
                  leaving the cursor at the end of the last line so you can read it, change it, or
                  press Enter yourself. <span className="text-foreground">Run</span> presses Enter
                  for you and the shell executes it immediately.
                  {multiline && (
                    <>
                      {" "}
                      This snippet has more than one line, and the line breaks inside it are Enter
                      presses too: every line except the last runs either way.
                    </>
                  )}
                </p>
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          {snippet && sessions.length > 0 && (
            <>
              <Button
                type="button"
                variant="secondary"
                disabled={!target}
                onClick={() => onSend(snippet, target, false)}
              >
                <CursorTextIcon /> Insert
              </Button>
              <Button
                type="button"
                disabled={!target}
                onClick={() => onSend(snippet, target, true)}
              >
                <ArrowElbowDownLeftIcon /> Run
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* --------------------------------------------------------------- list card */

function SnippetCard({
  snippet,
  onSend,
  onCopy,
  onEdit,
  onDelete,
}: {
  snippet: Snippet
  onSend: () => void
  onCopy: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const lines = snippet.body.split("\n")

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-medium text-foreground">{snippet.name}</h2>
            {snippet.description && (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {snippet.description}
              </p>
            )}
          </div>

          {/* Sending is the reason a snippet exists, so it is a button. Editing
              and deleting are rare, so they are behind the menu — the same
              arrangement the hosts list uses. */}
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="secondary" onClick={onSend}>
              <PaperPlaneTiltIcon /> Send
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`More actions for ${snippet.name}`}
                >
                  <DotsThreeIcon weight="bold" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem onSelect={onCopy}>
                  <CopyIcon /> Copy
                </DropdownMenuItem>
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
        </div>

        <pre className="max-h-32 overflow-auto rounded-none border border-border bg-secondary/40 p-2.5 font-mono text-xs leading-relaxed whitespace-pre">
          {snippet.body}
        </pre>

        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{lines.length === 1 ? "1 line" : `${lines.length} lines`}</span>
          {snippet.tags?.map((tag) => (
            <Badge key={tag} variant="outline" className="font-normal">
              {tag}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------ empty states */

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-4 py-10 sm:px-8">
        <div className="grid size-9 place-items-center rounded-sm border border-border bg-secondary text-primary">
          <CodeIcon />
        </div>
        <div className="max-w-xl">
          <h2 className="font-heading text-sm font-medium">No snippets yet</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            A snippet is a name and some shell text — the log tail with the flags you can never
            remember, the health check, the one-line rollback. Save it once and send it to any open
            session instead of typing it again.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Snippets are encrypted in this browser before they are stored, and the ciphertext is
            what syncs. That means the server cannot read them, cannot search them, and cannot tell
            you that one of them looks dangerous. Sending one types it into the shell as though it
            came from your keyboard, with the same consequences.
          </p>
        </div>
        <Button onClick={onCreate}>
          <PlusIcon /> New snippet
        </Button>
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
          The filter looks at names, descriptions, tags and the bodies of the snippets this tab has
          decrypted.
        </p>
        <Button variant="outline" onClick={onClear}>
          Clear search
        </Button>
      </CardContent>
    </Card>
  )
}

function LoadingCards() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1].map((i) => (
        <Card key={i}>
          <CardContent className="flex flex-col gap-3 py-4">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-3 w-20" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
