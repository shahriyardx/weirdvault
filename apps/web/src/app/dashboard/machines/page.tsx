"use client";

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

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  CopyIcon,
  DesktopTowerIcon,
  PlugsConnectedIcon,
  PlusIcon,
  ProhibitIcon,
  TerminalWindowIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { CredentialPrompt, useCredentialPrompt } from "@/components/ssh/credential-prompt";
import { PageHeader } from "@/components/shell/page-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { listHosts, type Host } from "@/lib/hosts";
import { useSshSession } from "@/lib/ssh/session-provider";
import { useConnectHost } from "@/lib/ssh/use-connect-host";

interface Agent {
  id: string;
  label: string;
  fingerprint: string;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  agentVersion: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/**
 * How stale a heartbeat may be before the machine is called offline.
 *
 * `last_seen_at` is stamped when the agent authenticates, which happens on
 * connect and on every reconnect — not on a timer. So a machine that has been
 * up and idle for a week has a week-old timestamp and is perfectly reachable.
 * This threshold is therefore generous on purpose: it distinguishes "enrolled
 * and never came back" from "connected", and nothing finer than that. The
 * honest answer to "is it online right now" comes from trying to connect.
 */
const SEEN_RECENTLY_MS = 7 * 24 * 60 * 60 * 1000;

const POLL_MS = 2000;

export default function MachinesPage() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  /**
   * When the list was fetched.
   *
   * "Seen lately" is judged against this rather than against the clock at
   * render time. Reading the clock while rendering makes a row's output depend
   * on when React happened to re-run it, which is both impure and, on a page
   * that re-renders whenever a dialog opens, capable of changing a badge for no
   * reason the user did anything to cause.
   */
  const [loadedAt, setLoadedAt] = useState(0);
  const [enrolling, setEnrolling] = useState(false);

  /**
   * Saved hosts, so a machine that has been connected to before does not send
   * you back through the form.
   *
   * SSH needs a username and a key, and neither is stored server-side — the
   * agent deliberately holds no SSH credentials, so the first connection has to
   * ask. Once it has been asked, the answer lives in the vault as an ordinary
   * host record, and there is nothing left to ask for.
   */
  const [hosts, setHosts] = useState<Host[]>([]);
  const router = useRouter();
  const prompt = useCredentialPrompt();
  const { keys: usableKeys } = useSshSession();
  const { connectToHost, connecting } = useConnectHost({
    askFor: prompt.askFor,
    onConnected: () => router.push("/dashboard/terminal"),
  });

  const load = useCallback(async () => {
    const res = await fetch("/api/agents");
    if (!res.ok) {
      toast.error("Could not load your machines");
      setAgents([]);
      return;
    }
    const body = (await res.json()) as { agents: Agent[] };
    setAgents(body.agents);
    setLoadedAt(Date.now());
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
      setHosts(await listHosts());
    })();
  }, [load]);

  const live = agents?.filter((a) => !a.revokedAt) ?? [];
  const revoked = agents?.filter((a) => a.revokedAt) ?? [];

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
          {live.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              now={loadedAt}
              host={hosts.find((h) => h.agentId === a.id) ?? null}
              busy={connecting !== null}
              onConnect={connectToHost}
              onChanged={load}
            />
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
                  now={loadedAt}
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
            setEnrolling(false);
            void load();
          }}
        />
      )}
    </div>
  );
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
  );
}

function AgentRow({
  agent,
  now,
  host,
  busy,
  onConnect,
  onChanged,
}: {
  agent: Agent;
  now: number;
  /** A saved host pointing at this machine, if one exists. */
  host: Host | null;
  busy: boolean;
  onConnect: (host: Host) => Promise<string | null>;
  onChanged: () => Promise<void>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(agent.label);
  const revoked = Boolean(agent.revokedAt);

  const seen = agent.lastSeenAt ? new Date(agent.lastSeenAt) : null;
  const recent = seen !== null && now - seen.getTime() < SEEN_RECENTLY_MS;

  async function rename() {
    const res = await fetch(`/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    if (!res.ok) {
      toast.error("Could not rename that machine");
      return;
    }
    setRenaming(false);
    await onChanged();
  }

  async function revoke() {
    const res = await fetch(`/api/agents/${agent.id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Could not revoke that machine");
      return;
    }
    toast.success("Revoked. It cannot reconnect.");
    await onChanged();
  }

  async function forget() {
    const res = await fetch(`/api/agents/${agent.id}?forget=1`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Could not remove that machine");
      return;
    }
    toast.success("Removed. That key can enrol again.");
    await onChanged();
  }

  return (
    <div className="border-border flex flex-wrap items-center gap-3 rounded-lg border p-4">
      <DesktopTowerIcon
        className={revoked ? "text-muted-foreground size-5" : "text-primary size-5"}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{agent.label}</span>
          {revoked ? (
            <Badge variant="outline" className="text-muted-foreground">
              Revoked
            </Badge>
          ) : seen === null ? (
            <Badge variant="outline" className="text-warning">
              Never connected
            </Badge>
          ) : recent ? (
            <Badge variant="outline" className="text-success">
              Enrolled
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              Not seen lately
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">
          {agent.fingerprint}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {[agent.hostname, agent.os && agent.arch ? `${agent.os}/${agent.arch}` : null]
            .filter(Boolean)
            .join(" · ")}
          {seen ? ` · last connected ${seen.toLocaleString()}` : ""}
        </p>
      </div>

      {!revoked && (
        <div className="flex gap-1">
          {/* One click once we know who to log in as, a form the first time.
              SSH needs a username and a key; the agent holds neither, so there
              is genuinely nothing to connect with until you have said once. */}
          {host ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void onConnect(host)}
            >
              <PlugsConnectedIcon />
              Connect as {host.username}
            </Button>
          ) : (
            <Button asChild variant="secondary" size="sm">
              <Link href={`/dashboard/connect?agent=${encodeURIComponent(agent.id)}`}>
                <PlugsConnectedIcon />
                Set up
              </Link>
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setRenaming(true)}>
            Rename
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm">
                <ProhibitIcon />
                Revoke
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Revoke {agent.label}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The agent on that machine stops being able to connect, and no new session can be
                  opened through it. Sessions already open keep running. To use the machine again
                  you would install the agent afresh with a new token.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction onClick={() => void revoke()}>Revoke</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      {revoked && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm">
              <TrashIcon />
              Forget
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {agent.label} from the list?</AlertDialogTitle>
              <AlertDialogDescription>
                Revoking retired this machine&rsquo;s key permanently. Removing the record frees
                that key, so a machine still holding its agent.json could enrol it again — with a
                fresh token, which only you can create. If you revoked it because it was lost or
                stolen, leave it here.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep the record</AlertDialogCancel>
              <AlertDialogAction onClick={() => void forget()}>Remove</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename machine</DialogTitle>
          </DialogHeader>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void rename();
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
  );
}

type EnrollState =
  | { phase: "minting" }
  | { phase: "waiting"; id: string; command: string; expiresAt: string }
  | { phase: "claimed"; agent: Agent }
  | { phase: "expired" }
  | { phase: "error"; message: string };

function EnrollDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<EnrollState>({ phase: "minting" });

  // Held in a ref so the polling effect can stop without being restarted by
  // every state change it causes.
  const stopped = useRef(false);
  useEffect(
    () => () => {
      stopped.current = true;
    },
    [],
  );

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/agents", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        token?: string;
        enrollmentId?: string;
        expiresAt?: string;
        error?: string;
      };

      if (!res.ok || !body.token || !body.enrollmentId) {
        setState({
          phase: "error",
          message: body.error ?? "Could not create an enrollment token.",
        });
        return;
      }

      setState({
        phase: "waiting",
        id: body.enrollmentId,
        expiresAt: body.expiresAt ?? "",
        command: `curl -fsSL ${location.origin}/install.sh | sudo sh -s -- --token=${body.token}`,
      });
    })();
  }, []);

  useEffect(() => {
    if (state.phase !== "waiting") return;
    const id = state.id;

    const timer = setInterval(() => {
      void (async () => {
        if (stopped.current) return;
        const res = await fetch(`/api/agents/enrollments/${id}`);
        if (!res.ok) return;
        const body = (await res.json()) as { status: string; agent?: Agent };
        if (body.status === "claimed" && body.agent) {
          setState({ phase: "claimed", agent: body.agent });
        } else if (body.status === "expired") {
          setState({ phase: "expired" });
        }
      })();
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [state]);

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
              <code className="font-mono">webxterm-agent enroll</code> with the same
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
                On the machine: <code className="font-mono">webxterm-agent status</code>
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
  );
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
          void navigator.clipboard.writeText(command);
          toast.success("Copied");
        }}
      >
        <CopyIcon />
      </Button>
    </div>
  );
}
