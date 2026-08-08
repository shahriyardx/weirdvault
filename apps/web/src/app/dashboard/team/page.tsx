"use client";

/**
 * Team management.
 *
 * A Client Component: the roster comes from Better Auth's organization plugin
 * through a client hook, and every mutation on this page is an authenticated
 * call made from the browser. Nothing here is renderable on the server without
 * duplicating the session read for no benefit.
 *
 * What is real and what is not, stated plainly rather than mocked:
 *  - The organization plugin is wired (server plugin, client plugin, route
 *    handler), so members, invitations, role changes and removals below are
 *    genuine calls against it.
 *  - If this account has no active organization, there is nothing to read. The
 *    page then renders a clearly labelled example roster so the layout can be
 *    reviewed, and disables every control rather than pretending it worked.
 *  - Team-vault key distribution — the part described in "How the team vault
 *    works" — is specified but not implemented. It is marked as such.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowsClockwiseIcon,
  CrownSimpleIcon,
  DotsThreeIcon,
  EnvelopeSimpleIcon,
  InfoIcon,
  KeyIcon,
  LockKeyIcon,
  ProhibitIcon,
  ShieldCheckIcon,
  SpinnerGapIcon,
  UserMinusIcon,
  UserPlusIcon,
  UsersThreeIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { PageHeader } from "@/components/shell/page-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { authClient, organization } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------- types */

type Role = "owner" | "admin" | "member";

const ROLES: { value: Role; label: string; blurb: string }[] = [
  {
    value: "owner",
    label: "Owner",
    blurb: "Billing, deletion, and every permission an admin has.",
  },
  {
    value: "admin",
    label: "Admin",
    blurb: "Invites and removes people, grants hosts, reads the audit log.",
  },
  {
    value: "member",
    label: "Member",
    blurb: "Connects to the hosts they were granted. Cannot change the roster.",
  },
];

interface MemberRow {
  /** Better Auth membership id — what removals and role changes are keyed by. */
  id: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: number;
}

interface InviteRow {
  id: string;
  email: string;
  role: Role;
  status: string;
  expiresAt: number;
}

/** Shown only when no organization is active, and labelled as such everywhere. */
const PLACEHOLDER_MEMBERS: MemberRow[] = [
  {
    id: "placeholder-1",
    name: "Ana Ferreira",
    email: "ana@example.com",
    role: "owner",
    joinedAt: Date.parse("2026-01-12T09:20:00Z"),
  },
  {
    id: "placeholder-2",
    name: "Dmitri Volkov",
    email: "dmitri@example.com",
    role: "admin",
    joinedAt: Date.parse("2026-02-03T14:05:00Z"),
  },
  {
    id: "placeholder-3",
    name: "Priya Raghunathan",
    email: "priya@example.com",
    role: "member",
    joinedAt: Date.parse("2026-04-27T11:41:00Z"),
  },
];

const PLACEHOLDER_INVITES: InviteRow[] = [
  {
    id: "placeholder-invite-1",
    email: "sam@example.com",
    role: "member",
    status: "pending",
    expiresAt: Date.parse("2026-08-15T00:00:00Z"),
  },
];

/* --------------------------------------------------------------------- page */

export default function TeamPage() {
  const { data: org, isPending, error, refetch } = authClient.useActiveOrganization();
  const [busyId, setBusyId] = useState<string | null>(null);

  /** No active organization means no roster exists to read — not an error. */
  const live = org != null;

  const members: MemberRow[] = useMemo(() => {
    // Placeholders appear only when there is genuinely nothing to read, never
    // mixed in with live rows — a fake id in an enabled menu would be a real
    // request against a member that does not exist.
    if (!live) return PLACEHOLDER_MEMBERS;
    return (org?.members ?? [])
      .map((m) => ({
        id: m.id,
        name: m.user?.name?.trim() || m.user?.email || "Unnamed member",
        email: m.user?.email ?? "unknown",
        role: normalizeRole(m.role),
        joinedAt: new Date(m.createdAt).getTime(),
      }))
      .sort((a, b) => rank(a.role) - rank(b.role) || a.joinedAt - b.joinedAt);
  }, [org, live]);

  const invites: InviteRow[] = useMemo(() => {
    if (!live) return PLACEHOLDER_INVITES;
    return (org?.invitations ?? [])
      .filter((i) => i.status === "pending")
      .map((i) => ({
        id: i.id,
        email: i.email,
        role: normalizeRole(i.role),
        status: i.status,
        expiresAt: new Date(i.expiresAt).getTime(),
      }));
  }, [org, live]);

  async function changeRole(member: MemberRow, role: Role) {
    if (!live) return;
    setBusyId(member.id);
    try {
      const res = await organization.updateMemberRole({ memberId: member.id, role });
      if (res.error) throw new Error(res.error.message ?? "role change failed");
      toast.success(`${member.name} is now ${roleLabel(role).toLowerCase()}`, {
        description:
          "The team key is unchanged: a role change alters what they may do, not what they can already decrypt.",
      });
      await refetch();
    } catch (e) {
      toast.error("Role change failed", { description: message(e) });
    } finally {
      setBusyId(null);
    }
  }

  async function removeMember(member: MemberRow) {
    if (!live) return;
    setBusyId(member.id);
    try {
      const res = await organization.removeMember({ memberIdOrEmail: member.id });
      if (res.error) throw new Error(res.error.message ?? "removal failed");
      toast.success(`${member.name} removed`, {
        description:
          "Access is revoked now. Rotating the team key is a separate step and is not implemented yet.",
      });
      await refetch();
    } catch (e) {
      toast.error("Could not remove member", { description: message(e) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="min-w-0">
      <PageHeader
        eyebrow="Team"
        title={org?.name ?? "Team"}
        description="Who can reach which hosts, and under whose name the audit log records it. Membership is the only part of webxterm the server understands — the vault it hands them stays ciphertext to us."
        actions={<InviteDialog live={live} onInvited={refetch} />}
      />

      <div className="mt-6 space-y-6">
        <PlanNotice />

        {error && (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>Could not load the organization</AlertTitle>
            <AlertDescription>
              {message(error)} The roster below is not live. Reload the page, or
              sign in again if the session has expired.
            </AlertDescription>
          </Alert>
        )}

        {!live && !isPending && !error && <NoOrganizationNotice />}

        {/* ------------------------------------------------------------ roster */}
        <Card>
          <CardHeader className="border-b border-border">
            <CardTitle className="flex flex-wrap items-center gap-2">
              <UsersThreeIcon className="size-4 text-primary" />
              Members
              {!live && (
                <Badge variant="outline" className="text-warning">
                  Placeholder
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              {live
                ? "Read from the organization record. Roles decide who may change the roster; host grants decide who may connect."
                : "Example rows, shown so the layout is reviewable. No organization is active on this account, so there is nothing real to list."}
            </CardDescription>
            {live && (
              <CardAction>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => void refetch()}
                  disabled={isPending}
                >
                  <ArrowsClockwiseIcon
                    data-icon="inline-start"
                    className={cn(isPending && "animate-spin")}
                  />
                  Refresh
                </Button>
              </CardAction>
            )}
          </CardHeader>

          <CardContent className="px-0">
            {isPending ? (
              <RosterSkeleton />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-(--card-spacing)">Member</TableHead>
                    <TableHead className="hidden sm:table-cell">Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead className="hidden md:table-cell">Joined</TableHead>
                    <TableHead className="w-8 pr-(--card-spacing)">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((m) => (
                    <TableRow key={m.id} className={cn(!live && "opacity-70")}>
                      <TableCell className="pl-(--card-spacing)">
                        <div className="flex items-center gap-2.5">
                          <Avatar className="size-6 rounded-sm">
                            <AvatarFallback className="rounded-sm bg-secondary text-[10px]">
                              {initials(m.name)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-foreground">
                              {m.name}
                            </p>
                            <p className="truncate text-muted-foreground sm:hidden">
                              {m.email}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden max-w-[16rem] truncate text-muted-foreground sm:table-cell">
                        {m.email}
                      </TableCell>
                      <TableCell>
                        <RoleBadge role={m.role} />
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground tabular-nums md:table-cell">
                        {formatDate(m.joinedAt)}
                      </TableCell>
                      <TableCell className="pr-(--card-spacing) text-right">
                        <MemberMenu
                          member={m}
                          live={live}
                          busy={busyId === m.id}
                          onRole={(role) => void changeRole(m, role)}
                          onRemove={() => void removeMember(m)}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* ------------------------------------------------------- invitations */}
        <Card>
          <CardHeader className="border-b border-border">
            <CardTitle className="flex flex-wrap items-center gap-2">
              <EnvelopeSimpleIcon className="size-4 text-primary" />
              Pending invitations
              {!live && (
                <Badge variant="outline" className="text-warning">
                  Placeholder
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              An invitation grants membership, not decryption. The team key is
              wrapped to the invitee only once they accept and publish a public
              key from their own browser.
            </CardDescription>
          </CardHeader>

          <CardContent className="px-0">
            {invites.length === 0 ? (
              <p className="px-(--card-spacing) py-5 text-muted-foreground">
                No invitations are outstanding.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {invites.map((i) => (
                  <li
                    key={i.id}
                    className={cn(
                      "flex flex-wrap items-center gap-x-3 gap-y-1.5 px-(--card-spacing) py-2.5",
                      !live && "opacity-70",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">{i.email}</p>
                      <p className="truncate text-muted-foreground">
                        Invited as {roleLabel(i.role).toLowerCase()} · expires{" "}
                        {formatDate(i.expiresAt)}
                      </p>
                    </div>
                    <Badge variant="outline" className="shrink-0 text-muted-foreground">
                      {i.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <TeamVaultExplainer />
        <RolesReference />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ notices */

function PlanNotice() {
  return (
    <Alert>
      <UsersThreeIcon className="text-primary" />
      <AlertTitle>Team features require the Team plan</AlertTitle>
      <AlertDescription>
        <span>
          Shared vaults, role-based access control, the audit log, SSO and
          credential inheritance are on Team, at $12 per user per month. Personal
          hosts, keys, sync, SFTP and port forwarding stay free and are unaffected
          by anything on this page.{" "}
          <Link href="/pricing" className="text-primary hover:underline">
            Compare the plans
          </Link>
          .
        </span>
      </AlertDescription>
    </Alert>
  );
}

function NoOrganizationNotice() {
  return (
    <Alert>
      <InfoIcon className="text-warning" />
      <AlertTitle>No organization is active on this account</AlertTitle>
      <AlertDescription>
        <span>
          Nothing below is your data. The rows are placeholders with the controls
          disabled, kept visible so the layout and the wording can be reviewed
          before a real team exists. Create an organization to make this page
          live.
        </span>
      </AlertDescription>
    </Alert>
  );
}

/* ------------------------------------------------------------------- roster */

function RosterSkeleton() {
  return (
    <div className="space-y-3 px-(--card-spacing) py-4" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-6 shrink-0 rounded-sm" />
          <Skeleton className="h-3 w-32" />
          <Skeleton className="ml-auto h-3 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

function RoleBadge({ role }: { role: Role }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1",
        role === "owner" && "text-primary",
        role === "admin" && "text-foreground",
        role === "member" && "text-muted-foreground",
      )}
    >
      {role === "owner" && <CrownSimpleIcon weight="fill" />}
      {roleLabel(role)}
    </Badge>
  );
}

function MemberMenu({
  member,
  live,
  busy,
  onRole,
  onRemove,
}: {
  member: MemberRow;
  live: boolean;
  busy: boolean;
  onRole: (role: Role) => void;
  onRemove: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!live || busy}
          aria-label={`Manage ${member.name}`}
        >
          {busy ? <SpinnerGapIcon className="animate-spin" /> : <DotsThreeIcon />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Role</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={member.role}
          onValueChange={(v) => onRole(normalizeRole(v))}
        >
          {ROLES.map((r) => (
            <DropdownMenuRadioItem key={r.value} value={r.value}>
              {r.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onRemove}>
          <UserMinusIcon />
          Remove from team
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ------------------------------------------------------------------- invite */

function InviteDialog({ live, onInvited }: { live: boolean; onInvited: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await organization.inviteMember({ email: email.trim(), role });
      if (res.error) throw new Error(res.error.message ?? "invitation failed");
      toast.success(`Invitation sent to ${email.trim()}`, {
        description:
          "They join the roster on acceptance. The team key is wrapped to them after their browser publishes a public key.",
      });
      setEmail("");
      setRole("member");
      setOpen(false);
      onInvited();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={!live}>
          <UserPlusIcon data-icon="inline-start" />
          Invite member
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite someone to the team</DialogTitle>
          <DialogDescription>
            They receive an invitation by email. Nothing is decryptable for them
            until they accept and their browser publishes a public key for the
            team key to be wrapped to.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">Email address</Label>
            <Input
              id="invite-email"
              type="email"
              required
              autoComplete="off"
              placeholder="engineer@yourcompany.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(normalizeRole(v))}>
              <SelectTrigger id="invite-role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground">
              {ROLES.find((r) => r.value === role)?.blurb}
            </p>
          </div>

          {error && (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>Invitation not sent</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy || email.trim().length === 0}>
              {busy && <SpinnerGapIcon data-icon="inline-start" className="animate-spin" />}
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------- explanations */

function TeamVaultExplainer() {
  return (
    <Card>
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <LockKeyIcon className="size-4 text-primary" />
          How the team vault works
        </CardTitle>
        <CardDescription>
          A shared vault cannot be a shared password. Here is the construction we
          use instead, and what it does not protect against.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-6 lg:grid-cols-[1fr_auto]">
        <div className="min-w-0 space-y-4">
          <Point
            icon={<KeyIcon />}
            title="One key per team, wrapped per member"
            body="The team vault is encrypted under a single symmetric team key. That key is never stored anywhere in the clear. It is wrapped separately to each member's public key, so the server holds one ciphertext per member and can open none of them."
          />
          <Point
            icon={<ShieldCheckIcon />}
            title="The server distributes, it does not decrypt"
            body="Joining fetches your wrapped copy and unwraps it in your browser with your private key, which is non-extractable and never leaves the device. From the server's side the whole operation is handing out bytes it cannot read — the same position it is in for a personal vault."
          />
          <Point
            icon={<UserMinusIcon />}
            title="Removing a member rotates the key"
            body="Revoking access by deleting a row would be theatre: the removed member may have kept the old team key. So removal generates a new team key, re-encrypts the team vault under it, and re-wraps it to everyone who remains. Anything they copied before removal stays copied — rotation limits the future, not the past."
          />
          <Point
            icon={<ProhibitIcon />}
            title="What this does not do"
            body="It does not stop a member from reading a host they were granted, and it does not stop them from writing down what they read. It also cannot help if we serve malicious JavaScript — that remains the largest residual risk in the threat model, for team vaults exactly as for personal ones."
          />

          <Alert>
            <InfoIcon className="text-warning" />
            <AlertTitle>Key distribution is not implemented yet</AlertTitle>
            <AlertDescription>
              <span>
                Membership, invitations and roles on this page are real. The
                wrapping, unwrapping and rotation described above are specified
                but not shipped, so no team vault contents exist to share. We
                would rather say so here than imply a protection that is not
                running.{" "}
                <Link href="/security" className="text-primary hover:underline">
                  Read the threat model
                </Link>
                .
              </span>
            </AlertDescription>
          </Alert>
        </div>

        <pre className="bg-terminal min-w-0 overflow-x-auto border border-border p-4 text-[11px] leading-relaxed text-muted-foreground">
{`  team vault (hosts, keys, snippets)
         │  AES-GCM
         ▼
   ┌───────────┐
   │ team key  │  never stored in the clear
   └─────┬─────┘
         │ wrapped to each member
    ┌────┼─────────────┬─────────────┐
    ▼    ▼             ▼             ▼
  ana  dmitri        priya       (removed)
   pk    pk            pk            ✗
    │     │             │
    └─────┴──── server holds ciphertext only
              remove a member → new team key
              → re-wrap to everyone remaining`}
        </pre>
      </CardContent>
    </Card>
  );
}

function Point({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex gap-3">
      <span
        aria-hidden
        className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-sm border border-border bg-secondary text-primary [&_svg]:size-3.5"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <h3 className="font-heading text-sm font-medium">{title}</h3>
        <p className="mt-1 leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

function RolesReference() {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>What each role can do</CardTitle>
        <CardDescription>
          Roles govern the roster and the grants. They never govern decryption —
          that is settled by which public keys the team key was wrapped to.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <ul className="divide-y divide-border border-t border-border">
          {ROLES.map((r) => (
            <li key={r.value} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-(--card-spacing) py-2.5">
              <span className="w-16 shrink-0 font-medium text-foreground">{r.label}</span>
              <span className="min-w-0 flex-1 text-muted-foreground">{r.blurb}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ----------------------------------------------------------------- helpers */

function normalizeRole(role: string | null | undefined): Role {
  // Better Auth stores roles as a comma-separated string; the most privileged
  // one is what the roster should show.
  const parts = (role ?? "").split(",").map((r) => r.trim().toLowerCase());
  if (parts.includes("owner")) return "owner";
  if (parts.includes("admin")) return "admin";
  return "member";
}

function rank(role: Role): number {
  return role === "owner" ? 0 : role === "admin" ? 1 : 2;
}

function roleLabel(role: Role): string {
  return ROLES.find((r) => r.value === role)?.label ?? "Member";
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((p) => p[0] ?? "").join("");
  return (letters || name.slice(0, 2) || "??").toUpperCase();
}

const DATE_FMT = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

function formatDate(at: number): string {
  return Number.isFinite(at) ? DATE_FMT.format(at) : "unknown";
}

function message(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message?: unknown }).message ?? "Unknown error");
  }
  return String(e ?? "Unknown error");
}
