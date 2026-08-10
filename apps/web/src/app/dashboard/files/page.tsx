"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  ArrowsLeftRightIcon,
  PlugsConnectedIcon,
  TerminalWindowIcon,
  XIcon,
} from "@phosphor-icons/react/dist/ssr"

import { RemoteEditor } from "@/components/editor"
import { FileExplorer } from "@/components/file-explorer"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSshSession } from "@/lib/ssh/session-provider"
import type { SftpHandle, SshSession } from "@/lib/ssh/types"

/** The pair a cross-host copy needs: a shell for tar, a channel for bytes. */
interface Endpoint {
  session: SshSession
  sftp: SftpHandle
}

/**
 * Files, for one host or two.
 *
 * Browsing is not always about the shell you happen to be typing in — you
 * might be running something in one session and pulling a file from another.
 * So each pane picks its own session rather than following the terminal.
 *
 * Split is the reason drag and drop between hosts exists at all. With two panes
 * open on different machines, dragging a selection from one to the other copies
 * it — through this tab, because there is no path between the two hosts that
 * does not pass through here.
 *
 * The editor takes the right pane when a file is opened, and the second explorer
 * comes back when it is closed. Three columns was the alternative and is worse
 * on anything but a very wide screen: two listings and an editor at a laptop
 * width leaves every filename truncated.
 */
export default function FilesPage() {
  const router = useRouter()
  const { sessions, activeId, setActive, sftpFor, sessionFor, write } = useSshSession()

  /**
   * Which session each pane is browsing, as a preference rather than the source
   * of truth. Resolved during render instead of copied into state by an effect:
   * storing it meant a frame where a picker pointed at a session that had just
   * closed, and a second render to correct it. Falling back here means a closed
   * session degrades on the very same paint.
   */
  const [chosen, setChosen] = useState<[string | null, string | null]>([null, null])
  const [split, setSplit] = useState(false)
  const [editing, setEditing] = useState<{ pane: 0 | 1; path: string } | null>(null)

  function resolve(index: 0 | 1): string | null {
    const preferred = chosen[index]
    if (preferred && sessions.some((s) => s.id === preferred)) return preferred
    if (index === 0) return activeId ?? sessions[0]?.id ?? null
    // The right pane defaults to a session the left one is not showing, since
    // two panes on the same host is a thing you might want but never the thing
    // you wanted by default.
    const left = resolve(0)
    return sessions.find((s) => s.id !== left)?.id ?? sessions[0]?.id ?? null
  }

  function choose(index: 0 | 1, id: string) {
    setChosen((prev) => {
      const next: [string | null, string | null] = [...prev]
      next[index] = id
      return next
    })
    // The editor is showing a file on the pane that just changed hosts.
    if (editing?.pane === index) setEditing(null)
  }

  if (sessions.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-sm text-center">
          <h2 className="font-heading text-sm font-medium">No sessions open</h2>
          <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
            Connect to a host to browse, upload and edit files. SFTP rides the same connection as
            the terminal.
          </p>
          <Button asChild className="mt-4" size="sm">
            <Link href="/dashboard/connect">
              <PlugsConnectedIcon />
              Connect to a host
            </Link>
          </Button>
        </div>
      </div>
    )
  }

  const leftId = resolve(0)
  const rightId = split ? resolve(1) : null

  /**
   * Resolves a session id to the pair a copy needs.
   *
   * Handed to both panes so a drop can reach back to whichever session the drag
   * started on. It returns null for a session that has closed mid-drag, which
   * the receiving pane reports rather than throwing.
   */
  const endpointFor = (id: string) => {
    const s = sessionFor(id)
    const f = sftpFor(id)
    return s && f ? { session: s, sftp: f } : null
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <PanePicker
          label="Browsing"
          value={leftId}
          sessions={sessions}
          activeId={activeId}
          onChange={(id) => choose(0, id)}
        />

        {split && (
          <PanePicker
            label="and"
            value={rightId}
            sessions={sessions}
            activeId={activeId}
            onChange={(id) => choose(1, id)}
          />
        )}

        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={split ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={split}
                onClick={() => {
                  setSplit((v) => !v)
                  // Closing the split takes the right pane's editor with it.
                  if (split && editing?.pane === 1) setEditing(null)
                }}
              >
                <ArrowsLeftRightIcon />
                Split
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {split
                ? "Close the second pane"
                : "Open a second host beside this one, and drag files between them"}
            </TooltipContent>
          </Tooltip>

          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/terminal">
              <TerminalWindowIcon />
              Terminal
            </Link>
          </Button>
        </div>
      </div>

      <div
        className={
          split || editing
            ? "grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2"
            : "grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[340px_1fr]"
        }
      >
        <div className="border-border min-h-0 border-r">
          <Pane
            index={0}
            sessionId={leftId}
            endpointFor={endpointFor}
            onEdit={(path) => setEditing({ pane: 0, path })}
            onOpenTerminalAt={(dir) => {
              if (!leftId) return
              write(leftId, `cd ${JSON.stringify(dir)}\n`)
              setActive(leftId)
              router.push("/dashboard/terminal")
            }}
          />
        </div>

        <div className="min-h-0">
          {editing ? (
            <EditorPane
              path={editing.path}
              sessionId={editing.pane === 0 ? leftId : rightId}
              sftpFor={sftpFor}
              onClose={() => setEditing(null)}
            />
          ) : split ? (
            <Pane
              index={1}
              sessionId={rightId}
              endpointFor={endpointFor}
              onEdit={(path) => setEditing({ pane: 1, path })}
              onOpenTerminalAt={(dir) => {
                if (!rightId) return
                write(rightId, `cd ${JSON.stringify(dir)}\n`)
                setActive(rightId)
                router.push("/dashboard/terminal")
              }}
            />
          ) : (
            <div className="text-muted-foreground grid h-full place-items-center p-6 text-sm">
              Double-click a file to edit it here.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PanePicker({
  label,
  value,
  sessions,
  activeId,
  onChange,
}: {
  label: string
  value: string | null
  sessions: { id: string; label: string; target: { port: number } }[]
  activeId: string | null
  onChange: (id: string) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs">{label}</span>
      <Select value={value ?? ""} onValueChange={onChange}>
        <SelectTrigger size="sm" className="w-auto min-w-44">
          <SelectValue placeholder="Choose a session" />
        </SelectTrigger>
        <SelectContent>
          {sessions.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.label}:{s.target.port}
              {s.id === activeId ? " · active" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * One explorer, or the reason it cannot be shown.
 *
 * SFTP opens on its own channel a moment after the shell does, so a pane can be
 * pointed at a live session that has no handle yet. Saying which is better than
 * an empty listing that looks like an empty directory.
 */
function Pane({
  index,
  sessionId,
  endpointFor,
  onEdit,
  onOpenTerminalAt,
}: {
  index: 0 | 1
  sessionId: string | null
  endpointFor: (id: string) => Endpoint | null
  onEdit: (path: string) => void
  onOpenTerminalAt: (dir: string) => void
}) {
  const { sessions, sftpFor, sessionFor } = useSshSession()
  const sftp = sessionId ? sftpFor(sessionId) : null
  const session = sessionId ? sessionFor(sessionId) : null
  const entry = sessions.find((s) => s.id === sessionId) ?? null

  if (!sftp || !session || !sessionId) {
    return (
      <div className="text-muted-foreground grid h-full place-items-center p-6 text-sm">
        {entry ? `Opening SFTP on ${entry.label}…` : "No session selected."}
      </div>
    )
  }

  return (
    <FileExplorer
      // Remounted per session so a switch starts at the new host's home
      // directory rather than trying the old host's path on the new one.
      key={sessionId}
      paneId={`pane-${index}`}
      sessionId={sessionId}
      sftp={sftp}
      session={session}
      endpointFor={endpointFor}
      onEdit={onEdit}
      onOpenTerminalAt={onOpenTerminalAt}
    />
  )
}

function EditorPane({
  path,
  sessionId,
  sftpFor,
  onClose,
}: {
  path: string
  sessionId: string | null
  sftpFor: (id: string) => SftpHandle | null
  onClose: () => void
}) {
  const sftp = sessionId ? sftpFor(sessionId) : null
  if (!sftp) {
    return (
      <div className="text-muted-foreground grid h-full place-items-center gap-2 p-6 text-sm">
        <p>That session closed while the file was open.</p>
        <Button variant="outline" size="sm" onClick={onClose}>
          <XIcon />
          Close
        </Button>
      </div>
    )
  }
  return <RemoteEditor sftp={sftp} path={path} onClose={onClose} />
}
