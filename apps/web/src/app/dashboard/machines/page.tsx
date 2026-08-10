"use client"

/**
 * Machines with no public address.
 *
 * A server behind a home router cannot be dialled, so it dials out instead: a
 * small daemon holds a connection open and the relay pairs a browser to it on
 * demand. This page is where that daemon is enrolled and where the machines it
 * represents are listed, renamed and revoked.
 *
 * The enrollment flow is deliberately a wait-and-confirm rather than a
 * fire-and-forget. Pasting a command and being told "probably done" leaves the
 * user with no way to tell a working install from a typo, and — more to the
 * point — no way to tell *their* machine from somebody else's. So the page
 * holds until a machine claims the token, then shows the fingerprint that
 * machine printed and asks the person to confirm it matches. That comparison is
 * the only thing standing between an account and a machine it did not mean to
 * adopt.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  CopyIcon,
  CaretRightIcon,
  DesktopTowerIcon,
  DotsThreeIcon,
  PlugsConnectedIcon,
  PlusIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { CredentialPrompt, useCredentialPrompt } from "@/components/ssh/credential-prompt"
import { PageHeader } from "@/components/shell/page-shell"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { agentNeedsUpdate } from "@/lib/agents/version"
import { listHosts, type Host } from "@/lib/hosts"
import { useSshSession } from "@/lib/ssh/session-provider"
import { useConnectHost } from "@/lib/ssh/use-connect-host"

interface Agent {
  id: string
  label: string
  fingerprint: string
  hostname: string | null
  os: string | null
  arch: string | null
  agentVersion: string | null
  /**
   * Opaque, stable reference to the physical machine, or null on an agent
   * enrolled before that was reported. Only ever used to group rows.
   */
  machineRef: string | null
  /**
   * Whether the relay has a live control connection to this machine.
   *
   * null means the relay could not be asked — not that the machine is down.
   * Reporting a fleet as offline because one internal call timed out would send
   * somebody to look at machines that are fine.
   */
  online: boolean | null
  lastSeenAt: string | null
  revokedAt: string | null
  createdAt: string
}

/** Whether the relay answered the reachability question at all. */
type PresenceStatus = "ok" | "unknown"

/**
 * What this machine calls the identity, on the machine.
 *
 * The agent names each identity after the first eight characters of its agent
 * id — that is the file in /etc/weirdvault, the row `weirdvault
 * list` prints, and the argument `stop <id>` takes. Without it on the card,
 * somebody with two identities on one box has no way to tell which row the
 * thing in front of them corresponds to.
 *
 * Derived rather than sent, because it is a pure function of the id and a
 * second copy on the wire could disagree with the one the agent computed. It
 * must stay in step with shortAgentID in apps/agent/enroll.go.
 */
function identityName(agentId: string): string {
  return agentId.replace(/-/g, "").slice(0, 8)
}

const POLL_MS = 2000

/**
 * How often the list refreshes itself while the tab is being looked at.
 *
 * Reachability changes without anybody doing anything here — a machine sleeps,
 * a relay restarts — so a page that only loaded once starts lying quietly. Ten
 * seconds is frequent enough that "it went offline" is noticed while somebody
 * is looking, and cheap enough to leave running: one indexed query plus one
 * call to the relay on a private network.
 *
 * Paused when the tab is hidden. A background tab left open overnight polling a
 * relay is nothing but load, and the state it collects is thrown away unread.
 */
const REFRESH_MS = 10_000

/**
 * When to look again after telling a machine to do something.
 *
 * The reply arrives before the effect does: the agent answers, then closes its
 * connection a moment later so the answer can escape, and the relay only then
 * stops listing it. One refetch on the reply is therefore always too early and
 * shows the state that was true a second ago — which reads as the command
 * having done nothing.
 */
const AFTER_COMMAND_MS = [0, 1_500, 4_000]

export default function MachinesPage() {
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [enrolling, setEnrolling] = useState(false)

  /**
   * Saved hosts, so a machine that has been connected to before does not send
   * you back through the form.
   *
   * SSH needs a username and a key, and neither is stored server-side — the
   * agent deliberately holds no SSH credentials, so the first connection has to
   * ask. Once it has been asked, the answer lives in the vault as an ordinary
   * host record, and there is nothing left to ask for.
   */
  const [hosts, setHosts] = useState<Host[]>([])
  const router = useRouter()
  const prompt = useCredentialPrompt()
  const { keys: usableKeys } = useSshSession()
  const { connectToHost, connecting } = useConnectHost({
    askFor: prompt.askFor,
    onConnected: () => router.push("/dashboard/terminal"),
  })

  /**
   * The build this deployment publishes, or null when it publishes none.
   *
   * A machine's own version is refreshed every time it reconnects, so this
   * comparison catches up by itself: an agent that replaces itself reports the
   * new build on the reconnect that follows, and the next load of this page
   * shows it. Nothing here has to poll the machine.
   */
  const [published, setPublished] = useState<string | null>(null)
  /**
   * Whether the last load could ask the relay who is connected.
   *
   * Kept beside the rows rather than derived per row, because "the relay did
   * not answer" is one fact about the page and not a property of each machine.
   */
  const [presence, setPresence] = useState<PresenceStatus>("unknown")

  const load = useCallback(async () => {
    const res = await fetch("/api/agents")
    if (!res.ok) {
      toast.error("Could not load your machines")
      setAgents([])
      return
    }
    const body = (await res.json()) as {
      agents: Agent[]
      publishedVersion?: string | null
      presence?: PresenceStatus
    }
    setAgents(body.agents)
    setPublished(body.publishedVersion ?? null)
    setPresence(body.presence === "ok" ? "ok" : "unknown")
  }, [])

  useEffect(() => {
    void (async () => {
      await load()
      setHosts(await listHosts())
    })()
  }, [load])

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void load()
    }
    const timer = setInterval(tick, REFRESH_MS)
    // Also on the way back: a tab returned to after an hour should not show an
    // hour-old answer for the ten seconds until the next tick.
    document.addEventListener("visibilitychange", tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", tick)
    }
  }, [load])

  const live = agents?.filter((a) => !a.revokedAt) ?? []
  const revoked = agents?.filter((a) => a.revokedAt) ?? []

  return (
    <div className="mx-auto w-full max-w-4xl px-6 pb-16">
      <PageHeader
        eyebrow="Machines"
        title="Machines without a public address"
        description="A server behind a router, on hotel wifi, or on a network with no inbound rule. Install the agent and it connects outward — no port forwarding, no firewall change."
        actions={
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              <ArrowsClockwiseIcon />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setEnrolling(true)}>
              <PlusIcon />
              Add a machine
            </Button>
          </div>
        }
      />

      {agents === null ? (
        <div className="mt-6 space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : live.length === 0 && revoked.length === 0 ? (
        <EmptyState onAdd={() => setEnrolling(true)} />
      ) : (
        <div className="mt-6 space-y-3">
          {groupByMachine(live).map((group) => (
            <MachineGroup key={group[0].id} agents={group}>
              {group.map((a) => {
                // Found once and used twice: the row needs the host to know
                // what to connect as, and `busy` is about *this* host being
                // connected rather than any host being connected — which is
                // what made one click disable every card on the page.
                const host = hosts.find((h) => h.agentId === a.id) ?? null
                return (
                  <AgentRow
                    key={a.id}
                    agent={a}
                    published={published}
                    presence={presence}
                    host={host}
                    busy={host !== null && connecting === host.id}
                    onConnect={connectToHost}
                    onChanged={load}
                  />
                )
              })}
            </MachineGroup>
          ))}
          {revoked.length > 0 && (
            <>
              <p className="text-muted-foreground pt-4 text-xs font-medium tracking-wider uppercase">
                Revoked
              </p>
              {revoked.map((a) => (
                <AgentRow
                  key={a.id}
                  agent={a}
                  published={published}
                  presence={presence}
                  host={null}
                  busy={false}
                  onConnect={connectToHost}
                  onChanged={load}
                />
              ))}
            </>
          )}
        </div>
      )}

      <CredentialPrompt pending={prompt.pending} keys={usableKeys} onSettle={prompt.settle} />

      {enrolling && (
        <EnrollDialog
          onClose={() => {
            setEnrolling(false)
            void load()
          }}
        />
      )}
    </div>
  )
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="border-border mt-6 rounded-lg border border-dashed p-10 text-center">
      <DesktopTowerIcon className="text-muted-foreground mx-auto size-8" />
      <h2 className="font-heading mt-3 text-sm font-medium">No machines yet</h2>
      <p className="text-muted-foreground mx-auto mt-1.5 max-w-md text-sm leading-relaxed">
        Machines you reach by address do not need this — add those from{" "}
        <Link href="/dashboard/connect" className="underline underline-offset-2">
          Connect
        </Link>
        . This is for the ones that have no address to reach.
      </p>
      <Button className="mt-4" size="sm" onClick={onAdd}>
        <PlusIcon />
        Add a machine
      </Button>
    </div>
  )
}

/**
 * What a machine's row says about itself, in one value.
 *
 * Reachability and enrolment health are separate questions and this is where
 * they are resolved into the single thing the rail shows. The order matters:
 * revoked outranks everything, because a revoked machine's connection state is
 * not a fact anyone should act on, and "unknown" outranks "offline" so that one
 * unreachable relay never reports a working fleet as down.
 */
type MachineState = "revoked" | "online" | "offline" | "unknown" | "never"

/**
 * Which agents are on the same physical machine.
 *
 * Two identities on one box is an ordinary arrangement now — several accounts
 * sharing a machine, or one account that enrolled it twice — and two cards with
 * nothing linking them read as two machines.
 *
 * `machineRef` is the real answer: a hash of the platform's own machine id, so
 * it does not collide. Hostname is the fallback for agents enrolled before that
 * was reported, and it is only a fallback because names like `raspberrypi` and
 * `localhost` are shared by machines that have nothing to do with each other.
 * Grouping by it on its own would eventually be wrong in a way that matters, so
 * it is qualified by os and arch and the header says what it grouped on.
 */
function machineKey(agent: Agent): string {
  if (agent.machineRef) return `ref:${agent.machineRef}`
  if (agent.hostname) return `host:${agent.hostname}/${agent.os ?? "?"}/${agent.arch ?? "?"}`
  // Nothing to group on: its own group of one, which renders as a plain card.
  return `agent:${agent.id}`
}

/**
 * Groups in the order the rows arrived, so the list does not reorder itself.
 *
 * Two passes, because of the state every existing deployment is in the day this
 * ships: an agent enrolled before machine ids were reported has none, and the
 * next one enrolled on that same machine does. Grouping on the key alone would
 * split them, which is precisely the confusion this exists to remove.
 *
 * So ref-less agents are attached to a ref group that reports the same hostname,
 * os and arch — and only when exactly one group matches. Two candidates means
 * there is no way to tell which, and a guess there would put somebody's machine
 * under the wrong heading.
 */
function groupByMachine(agents: Agent[]): Agent[][] {
  const groups = new Map<string, Agent[]>()
  const orphans: Agent[] = []

  for (const agent of agents) {
    if (!agent.machineRef) {
      orphans.push(agent)
      continue
    }
    const key = machineKey(agent)
    const existing = groups.get(key)
    if (existing) existing.push(agent)
    else groups.set(key, [agent])
  }

  const describes = (agent: Agent) =>
    `${agent.hostname ?? ""}/${agent.os ?? "?"}/${agent.arch ?? "?"}`

  for (const orphan of orphans) {
    const candidates = orphan.hostname
      ? [...groups.entries()].filter(([, members]) => describes(members[0]) === describes(orphan))
      : []

    if (candidates.length === 1) {
      candidates[0][1].push(orphan)
      continue
    }
    // Its own group, joined by any other ref-less agent describing itself the
    // same way — the pre-machine-id behaviour, unchanged.
    const key = machineKey(orphan)
    const existing = groups.get(key)
    if (existing) existing.push(orphan)
    else groups.set(key, [orphan])
  }

  return [...groups.values()]
}

function machineState(agent: Agent, presence: PresenceStatus, seen: Date | null): MachineState {
  if (agent.revokedAt) return "revoked"
  // Before reachability: a machine that has never connected is not "offline",
  // it is unfinished, and the two send a person to completely different places.
  if (seen === null) return "never"
  if (presence !== "ok" || agent.online === null) return "unknown"
  return agent.online ? "online" : "offline"
}

function stateLabel(state: MachineState): string {
  switch (state) {
    case "revoked":
      return "Revoked · cannot connect"
    case "online":
      return "Online · connected to the relay"
    case "offline":
      return "Offline · the agent is not connected"
    case "never":
      return "Never connected · the agent has not checked in"
    // Said plainly rather than dressed up as offline. The machine may be
    // perfectly fine; what failed is the question.
    case "unknown":
      return "Unknown · the relay could not be reached"
  }
}

function railColour(state: MachineState): string {
  switch (state) {
    case "online":
      return "bg-success"
    case "offline":
    case "revoked":
      return "bg-muted-foreground/40"
    case "never":
    case "unknown":
      return "bg-warning"
  }
}

function stateColour(state: MachineState): string {
  switch (state) {
    case "online":
      return "text-success"
    case "never":
    case "unknown":
      return "text-warning"
    default:
      return "text-muted-foreground"
  }
}

/**
 * Says that these cards are one machine, and only when they are more than one.
 *
 * A single agent gets no wrapper at all: a heading over every card would add a
 * line of chrome to the common case to serve the uncommon one, and "this
 * machine contains this one machine" reads as a mistake.
 *
 * The header says what it grouped on, because the two signals are not equally
 * trustworthy — a machine id does not collide, a hostname does — and somebody
 * looking at a grouping they did not expect should be able to tell which they
 * are looking at.
 */
function MachineGroup({ agents, children }: { agents: Agent[]; children: React.ReactNode }) {
  /*
   * Open by default, and remembered per machine.
   *
   * Collapsing is for a machine you have finished with, so the state belongs to
   * that machine rather than to the page — closing one on a list of six should
   * not reopen when a poll re-renders, and should not close the others. Kept in
   * component state rather than storage: it is cheap to redo and nobody expects
   * a list to remember how they left it a week ago.
   */
  const [open, setOpen] = useState(true)

  if (agents.length < 2) return <>{children}</>

  // True when hostname carried any of this grouping, not only all of it: one
  // unverified member is enough to make the whole grouping a guess.
  const byHostname = agents.some((a) => !a.machineRef)
  const name = agents[0].hostname ?? "One machine"
  const online = agents.filter((a) => a.online === true).length

  return (
    <div className="border-border/60 bg-muted/20 space-y-2 rounded-xl border border-dashed p-2">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="hover:bg-muted/40 flex w-full flex-wrap items-baseline gap-x-2 rounded-lg px-2 py-1 text-left transition-colors"
      >
        <CaretRightIcon
          className={`size-3 shrink-0 self-center transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="text-sm font-medium">{name}</span>
        <span className="text-muted-foreground text-xs">
          {agents.length} agents on this machine
          {/* Only when closed: with the cards visible it is a count of what is
              already on screen, and while they are hidden it is the reason
              somebody might open it again. */}
          {!open && online > 0 ? ` · ${online} online` : ""}
          {byHostname ? " · matched by hostname, which machines can share" : ""}
        </span>
      </button>
      {open && children}
    </div>
  )
}

function AgentRow({
  agent,
  published,
  presence,
  host,
  busy,
  onConnect,
  onChanged,
}: {
  agent: Agent
  /** The build this deployment publishes, or null when it publishes none. */
  published: string | null
  /** Whether the relay could be asked at all. */
  presence: PresenceStatus
  /** A saved host pointing at this machine, if one exists. */
  host: Host | null
  busy: boolean
  onConnect: (host: Host) => Promise<string | null>
  onChanged: () => Promise<void>
}) {
  const [renaming, setRenaming] = useState(false)
  const [label, setLabel] = useState(agent.label)
  // Opened by a successful revoke, and re-openable from the revoked row after.
  const [removalOpen, setRemovalOpen] = useState(false)
  const [upgradeOpen, setUpgradeOpen] = useState(false)
  // Controlled rather than trigger-bearing, because both live in the overflow
  // menu now: a Radix menu closes on select and would take an unmounted trigger
  // — and its dialog — with it.
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [forgetOpen, setForgetOpen] = useState(false)
  const [stopOpen, setStopOpen] = useState(false)
  // Which command is in flight, so the menu can say so rather than looking
  // inert for the several seconds a round trip to somebody's home connection
  // takes.
  const [busyCommand, setBusyCommand] = useState<string | null>(null)
  // Whether the revoke reached the machine. Starts true for a row that was
  // already revoked when the page loaded, because nothing here knows what
  // happened then and the safe assumption is that there is still work to do.
  const [keyStillOnMachine, setKeyStillOnMachine] = useState(true)
  const revoked = Boolean(agent.revokedAt)

  const seen = agent.lastSeenAt ? new Date(agent.lastSeenAt) : null

  // Not shown for a revoked machine: it cannot connect, so it cannot update,
  // and an update prompt beside "Revoked" is an instruction into a wall.
  const outdated = !revoked && agentNeedsUpdate(agent.agentVersion, published)

  const state = machineState(agent, presence, seen)

  async function rename() {
    const res = await fetch(`/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    })
    if (!res.ok) {
      toast.error("Could not rename that machine")
      return
    }
    setRenaming(false)
    await onChanged()
  }

  async function revoke() {
    const res = await fetch(`/api/agents/${agent.id}`, { method: "DELETE" })
    if (!res.ok) {
      toast.error("Could not revoke that machine")
      return
    }
    const body = (await res.json().catch(() => ({}))) as { removedFromMachine?: boolean }
    // Two different outcomes worth telling apart. Reaching the machine means the
    // key is gone from it; not reaching it means the key is still sitting there,
    // and the dialog below is the only place that says how to finish the job.
    setKeyStillOnMachine(body.removedFromMachine !== true)
    toast.success(
      body.removedFromMachine
        ? "Revoked, and the key is off that machine."
        : "Revoked. It cannot reconnect.",
    )
    // Before the refresh, not after: onChanged re-fetches and re-renders the
    // list, and opening the dialog first means it is already on screen when the
    // row turns into its revoked form rather than appearing a beat later.
    setRemovalOpen(true)
    await onChanged()
  }

  /*
   * Sending one instruction, and saying what came back.
   *
   * The answer is the point. "aaaa1111 has 3 sessions open" and "already
   * running the published build" are the agent's own words, and a dashboard
   * that replaced them with "sent" would make a refusal indistinguishable from
   * a machine that had stopped listening.
   */
  async function command(kind: "restart" | "upgrade" | "stop", pending: string) {
    setBusyCommand(pending)
    try {
      const res = await fetch(`/api/agents/${agent.id}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: kind }),
      })
      const body = (await res.json()) as { ok?: boolean; detail?: string; error?: string }

      if (!res.ok) {
        toast.error(body.error ?? "That machine could not be reached")
        return
      }
      if (body.ok) {
        toast.success(body.detail ?? "Done")
      } else {
        // Not an error toast for a refusal with a reason: the machine answered,
        // and the answer is information rather than a failure.
        toast.warning(body.detail ?? "The machine refused that")
      }
    } finally {
      setBusyCommand(null)
      // Outside the reply's own success or failure: a command that timed out
      // may still have landed, and that is exactly when seeing the real state
      // matters most.
      void refreshAfterCommand()
    }
  }

  /**
   * Refetches a few times, because the effect trails the answer.
   *
   * Not a loop that waits for the state to change: a refused restart changes
   * nothing, and a poller waiting for a difference that is never coming would
   * spin for as long as somebody left the page open.
   */
  async function refreshAfterCommand() {
    for (const delay of AFTER_COMMAND_MS) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      await onChanged()
    }
  }

  async function forget() {
    const res = await fetch(`/api/agents/${agent.id}?forget=1`, { method: "DELETE" })
    if (!res.ok) {
      toast.error("Could not remove that machine")
      return
    }
    toast.success("Removed. That key can enrol again.")
    await onChanged()
  }

  return (
    <div className="border-border overflow-hidden rounded-lg border">
      <div className="flex">
        {/* The rail carries reachability, so the state is legible before a word
            is read. Never the only carrier of it — the word is next to it, for
            colour blindness and for the case where a screenshot loses the hue. */}
        <div className={`w-1 shrink-0 ${railColour(state)}`} aria-hidden />

        <div className="min-w-0 flex-1 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <DesktopTowerIcon
              className={revoked ? "text-muted-foreground size-4" : "text-primary size-4"}
            />
            <span className="truncate text-sm font-medium">{agent.label}</span>
            {/* Alongside reachability rather than instead of it: whether a
                machine is reachable and whether it is current are two facts, and
                collapsing them hides whichever one is not being asked about. */}
            {outdated && (
              <Badge variant="outline" className="text-warning ml-auto">
                Update available
              </Badge>
            )}
          </div>

          <p className={`mt-1 text-xs ${stateColour(state)}`}>{stateLabel(state)}</p>

          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            {agent.hostname && (
              <>
                <dt className="text-muted-foreground tracking-wider uppercase">Host</dt>
                <dd className="truncate">{agent.hostname}</dd>
              </>
            )}
            {(agent.os || agent.agentVersion) && (
              <>
                <dt className="text-muted-foreground tracking-wider uppercase">System</dt>
                <dd className="truncate">
                  {[
                    agent.os && agent.arch ? `${agent.os}/${agent.arch}` : agent.os,
                    // Reported on every reconnect, so this is what the machine
                    // is running now rather than what it was installed with.
                    agent.agentVersion,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground tracking-wider uppercase">On the machine</dt>
            <dd className="truncate font-mono">{identityName(agent.id)}</dd>
            <dt className="text-muted-foreground tracking-wider uppercase">Key</dt>
            <dd className="truncate font-mono">{agent.fingerprint}</dd>
            <dt className="text-muted-foreground tracking-wider uppercase">Seen</dt>
            <dd className="truncate">{seen ? seen.toLocaleString() : "never"}</dd>
          </dl>

          <div className="border-border mt-3 flex flex-wrap items-center gap-1 border-t pt-3">
            {!revoked &&
              /* One click once we know who to log in as, a form the first time.
                 SSH needs a username and a key; the agent holds neither, so
                 there is genuinely nothing to connect with until you have said
                 once. */
              (host ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void onConnect(host)}
                >
                  <PlugsConnectedIcon />
                  {/* Says which state it is in rather than only going grey.
                      Opening a session takes a WebSocket, a relay hop and an
                      SSH handshake, which is long enough for a disabled button
                      with unchanged text to read as a click that missed. */}
                  {busy ? "Connecting…" : `Connect as ${host.username}`}
                </Button>
              ) : (
                <Button asChild variant="secondary" size="sm">
                  <Link href={`/dashboard/connect?agent=${encodeURIComponent(agent.id)}`}>
                    <PlugsConnectedIcon />
                    Set up
                  </Link>
                </Button>
              ))}

            {outdated && (
              <Button variant="ghost" size="sm" onClick={() => setUpgradeOpen(true)}>
                <ArrowsClockwiseIcon />
                Update
              </Button>
            )}

            {/* Everything rare or destructive. Connect and Update are what
                anyone does often; the rest behind one control is also what
                keeps this from being six buttons on a phone. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="ml-auto" aria-label="More actions">
                  <DotsThreeIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem>
                {/* Absent rather than disabled when they cannot work: a greyed
                    out control implies a state in which it would. */}
                {!revoked && state === "online" && (
                  <>
                    <DropdownMenuItem
                      disabled={busyCommand !== null}
                      onSelect={() => void command("restart", "restart")}
                    >
                      {busyCommand === "restart" ? "Restarting…" : "Restart the agent"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={busyCommand !== null}
                      onSelect={() => setStopOpen(true)}
                    >
                      Stop the agent
                    </DropdownMenuItem>
                  </>
                )}
                {revoked ? (
                  <>
                    <DropdownMenuItem onSelect={() => setRemovalOpen(true)}>
                      How to remove it
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={() => setForgetOpen(true)}>
                      Forget
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem variant="destructive" onSelect={() => setRevokeOpen(true)}>
                    Revoke
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <AlertDialog open={stopOpen} onOpenChange={setStopOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop the agent on {agent.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops now and stays stopped across reboots.{" "}
              <strong>There is no start button</strong> — the connection a start command would
              arrive on is the thing being stopped, so turning it back on needs a shell on that
              machine: <span className="font-mono">weirdvault start</span>. Sessions already open
              keep running until they end.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Leave it running</AlertDialogCancel>
            <AlertDialogAction onClick={() => void command("stop", "stop")}>
              Stop it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {agent.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              The agent on that machine stops being able to connect, and no new session can be
              opened through it. Sessions already open keep running. To use the machine again you
              would install the agent afresh with a new token.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => void revoke()}>Revoke</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={forgetOpen} onOpenChange={setForgetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {agent.label} from the list?</AlertDialogTitle>
            <AlertDialogDescription>
              Revoking retired this machine&rsquo;s key permanently. Removing the record frees that
              key, so a machine still holding its agent.json could enrol it again — with a fresh
              token, which only you can create. If you revoked it because it was lost or stolen,
              leave it here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the record</AlertDialogCancel>
            <AlertDialogAction onClick={() => void forget()}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RemovalDialog
        agent={agent}
        open={removalOpen}
        onOpenChange={setRemovalOpen}
        keyStillOnMachine={keyStillOnMachine}
      />

      <UpgradeDialog
        agent={agent}
        published={published}
        open={upgradeOpen}
        onOpenChange={setUpgradeOpen}
        onChanged={onChanged}
        onUpgrade={
          state === "online"
            ? () => command("upgrade", "upgrade").then(() => setUpgradeOpen(false))
            : undefined
        }
        upgrading={busyCommand === "upgrade"}
      />

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename machine</DialogTitle>
          </DialogHeader>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void rename()
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
            <Button onClick={() => void rename()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

type EnrollState =
  | { phase: "minting" }
  | { phase: "waiting"; id: string; command: string; expiresAt: string }
  | { phase: "claimed"; agent: Agent }
  | { phase: "expired" }
  | { phase: "error"; message: string }

function EnrollDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<EnrollState>({ phase: "minting" })

  // Held in a ref so the polling effect can stop without being restarted by
  // every state change it causes.
  const stopped = useRef(false)
  useEffect(
    () => () => {
      stopped.current = true
    },
    [],
  )

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/agents", { method: "POST" })
      const body = (await res.json().catch(() => ({}))) as {
        token?: string
        enrollmentId?: string
        expiresAt?: string
        error?: string
      }

      if (!res.ok || !body.token || !body.enrollmentId) {
        setState({
          phase: "error",
          message: body.error ?? "Could not create an enrollment token.",
        })
        return
      }

      setState({
        phase: "waiting",
        id: body.enrollmentId,
        expiresAt: body.expiresAt ?? "",
        command: `curl -fsSL ${location.origin}/install.sh | sudo sh -s -- --token=${body.token}`,
      })
    })()
  }, [])

  useEffect(() => {
    if (state.phase !== "waiting") return
    const id = state.id

    const timer = setInterval(() => {
      void (async () => {
        if (stopped.current) return
        const res = await fetch(`/api/agents/enrollments/${id}`)
        if (!res.ok) return
        const body = (await res.json()) as { status: string; agent?: Agent }
        if (body.status === "claimed" && body.agent) {
          setState({ phase: "claimed", agent: body.agent })
        } else if (body.status === "expired") {
          setState({ phase: "expired" })
        }
      })()
    }, POLL_MS)

    return () => clearInterval(timer)
  }, [state])

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a machine</DialogTitle>
          <DialogDescription>
            Run this on the machine you want to reach. It needs no inbound port.
          </DialogDescription>
        </DialogHeader>

        {state.phase === "minting" && <Skeleton className="h-24 w-full" />}

        {state.phase === "error" && (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>Could not start</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}

        {state.phase === "expired" && (
          <Alert>
            <WarningCircleIcon />
            <AlertTitle>That token expired</AlertTitle>
            <AlertDescription>
              Tokens last ten minutes. Close this and start again for a fresh one.
            </AlertDescription>
          </Alert>
        )}

        {state.phase === "waiting" && (
          <div className="space-y-3">
            <CommandBlock command={state.command} />
            <p className="text-muted-foreground text-sm">
              Waiting for the machine to connect… This token is single-use and expires in ten
              minutes.
            </p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              Prefer not to pipe to a shell? Download the agent, then run{" "}
              <code className="font-mono">weirdvault enroll</code> with the same
              <code className="font-mono"> --token</code> and{" "}
              <code className="font-mono">--url</code>.
            </p>
          </div>
        )}

        {state.phase === "claimed" && (
          <div className="space-y-3">
            <Alert>
              <CheckCircleIcon />
              <AlertTitle>{state.agent.hostname ?? "A machine"} connected</AlertTitle>
              <AlertDescription>
                Check that this fingerprint matches the one printed on that machine before you rely
                on it. They are the same key, shown twice on purpose.
              </AlertDescription>
            </Alert>

            <div className="border-border rounded-lg border p-3">
              <Label className="text-muted-foreground text-xs">Fingerprint</Label>
              <p className="mt-1 font-mono text-sm break-all">{state.agent.fingerprint}</p>
              <p className="text-muted-foreground mt-2 text-xs">
                On the machine: <code className="font-mono">weirdvault status</code>
              </p>
            </div>

            <Alert>
              <TerminalWindowIcon />
              <AlertTitle>Next: add it as a host</AlertTitle>
              <AlertDescription>
                The machine can now carry connections. Add a host from Connect, choose this machine,
                and give it the username and key you would use over SSH — the agent holds neither.
              </AlertDescription>
            </Alert>
          </div>
        )}

        <DialogFooter>
          <Button variant={state.phase === "claimed" ? "default" : "ghost"} onClick={onClose}>
            {state.phase === "claimed" ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/*
How to move a machine onto the build this deployment publishes.

The agent replaces itself at startup and only when the manifest names a version
different from its own, so this is a restart rather than a download — and both
halves of that are why the dialog exists rather than a button that silently does
it. Nothing here can reach into somebody's living room, and a spinner that
resolved to a lie would be worse than a command.

Short on purpose. The thing people want is the button when the machine is
reachable and the command when it is not; what happens next is one line each,
and the reasoning belongs in the docs rather than in a box that opens over the
page somebody was reading.
*/
function UpgradeDialog({
  agent,
  published,
  open,
  onOpenChange,
  onChanged,
  onUpgrade,
  upgrading,
}: {
  agent: Agent
  published: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => Promise<void>
  /** Absent when the machine is not reachable, or cannot verify commands. */
  onUpgrade?: () => Promise<void>
  upgrading: boolean
}) {
  const origin = typeof window === "undefined" ? "" : window.location.origin

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update {agent.label}</DialogTitle>
          <DialogDescription>
            Running <span className="font-mono">{agent.agentVersion}</span>, published{" "}
            <span className="font-mono">{published}</span>. It restarts to pick the new build up, so
            it refuses while a session is open and tells you which.
          </DialogDescription>
        </DialogHeader>

        {onUpgrade ? (
          <div className="space-y-2">
            <Button disabled={upgrading} onClick={() => void onUpgrade()}>
              <ArrowsClockwiseIcon />
              {upgrading ? "Updating…" : "Update now"}
            </Button>
            <p className="text-muted-foreground text-xs">
              Or on the machine: <span className="font-mono">sudo weirdvault upgrade</span>
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm">
              That machine is not connected, so it cannot be told from here. On the machine:
            </p>
            <CommandBlock command="sudo weirdvault upgrade" />
          </div>
        )}

        {/* Folded: the failure is rare, and its answer is long enough to bury
            the two lines above that are the point. */}
        <details className="text-muted-foreground text-xs leading-relaxed">
          <summary className="cursor-pointer select-none">Nothing changed?</summary>
          <p className="mt-2">
            <span className="font-mono">weirdvault logs</span> on the machine says why. A{" "}
            <span className="font-mono">permission denied</span> means it was installed before the
            binary moved somewhere it can replace itself — one command fixes it and keeps the
            machine&rsquo;s identity:
          </p>
          <div className="mt-2">
            <CommandBlock command={`curl -fsSL ${origin}/install.sh | sudo sh -s -- --repair`} />
          </div>
          <p className="mt-2">
            If <span className="font-mono">weirdvault status</span> says{" "}
            <span className="font-mono">Updates: off</span> instead, that agent predates self-update
            and has no release URL — revoke it and install it again.
          </p>
        </details>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              void onChanged()
              onOpenChange(false)
            }}
          >
            Refresh
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/*
What is left on the machine once its key is dead.

Deliberately short. It opens by itself the moment a revoke succeeds, so it
interrupts somebody who has just finished a task — and the honest content is one
command. What used to be here, explaining what uninstall removes and what it
leaves alone, was all true and belongs in the docs: a dialog that fills a phone
screen gets closed, not read.

The nuance that survives is the one that changes what you type — whether the
machine was reachable when you revoked it, and so whether its copy of the key is
already gone.
*/
function RemovalDialog({
  agent,
  open,
  onOpenChange,
  keyStillOnMachine,
}: {
  agent: Agent
  open: boolean
  onOpenChange: (open: boolean) => void
  /** False when the revoke reached the machine and the key is already gone. */
  keyStillOnMachine: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{agent.label} is revoked</DialogTitle>
          <DialogDescription>
            {keyStillOnMachine
              ? "It cannot connect any more. That machine was offline, so its copy of the key is still on disk — dead, but there."
              : "It cannot connect any more, and it was online, so it deleted its own key. Nothing left to do."}
          </DialogDescription>
        </DialogHeader>

        {keyStillOnMachine && (
          <div className="space-y-2">
            <CommandBlock command={`sudo weirdvault remove ${identityName(agent.id)}`} />
            <p className="text-muted-foreground text-xs">
              Lost or stolen? Nothing to run — revoking already retired the key.
            </p>
          </div>
        )}

        {/* Folded, because wanting the whole agent gone is the rarer intent and
            it is one command when you do. */}
        <details className="text-muted-foreground text-xs">
          <summary className="cursor-pointer select-none">Remove weirdvault entirely</summary>
          <div className="mt-2">
            <CommandBlock command="sudo weirdvault uninstall" />
          </div>
        </details>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CommandBlock({ command }: { command: string }) {
  return (
    <div className="border-border bg-muted/40 flex items-start gap-2 rounded-lg border p-3">
      <code className="min-w-0 flex-1 font-mono text-xs leading-relaxed break-all">{command}</code>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(command)
          toast.success("Copied")
        }}
      >
        <CopyIcon />
      </Button>
    </div>
  )
}
