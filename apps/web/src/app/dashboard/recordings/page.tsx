"use client";

/**
 * Session recordings.
 *
 * A client component from top to bottom, and not by preference: a recording is
 * captured in this tab, encrypted in this tab, and can only be read in a tab
 * holding the vault key. The server's copy is a blob and a handful of numbers,
 * so there is nothing here it could render — including the host column, which is
 * resolved the same way the activity log resolves it, by hashing this device's
 * saved hosts with the audit key and matching the results.
 *
 * The page is deliberately blunt about three things, because each of them is a
 * way a person could be surprised by their own data:
 *
 *  - What is in a recording. It is the output stream, which includes the echo of
 *    everything typed at the shell. Anything that appeared on screen is in the
 *    file.
 *  - Where recording happens. Here, in this tab, while it is open. Closing it
 *    ends the capture; a crash loses whatever had not been saved.
 *  - What stopped. Capture ends on its own at a size cap or when the session
 *    hangs up, and when it does the badge goes out and the reason is on screen.
 *    A recording indicator that keeps glowing over a dead capture is the one
 *    failure this feature must not have.
 *
 * Sharing is the fourth, and it is the one with the sharpest edge, so the
 * dialog is written to be read rather than clicked through: the link carries the
 * decryption key in its fragment, which is what lets somebody with no account
 * watch the recording, and which is also what makes a forwarded link a
 * forwarded transcript. The key is generated for that one share, shown once as
 * part of the link, and never stored — so the dialog cannot show it again and
 * says so before it is dismissed rather than after.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowClockwiseIcon,
  CopyIcon,
  DownloadSimpleIcon,
  EyeIcon,
  EyeSlashIcon,
  FilmStripIcon,
  HardDrivesIcon,
  LinkIcon,
  LockKeyIcon,
  PlayIcon,
  PlugsConnectedIcon,
  ProhibitIcon,
  RecordIcon,
  ShareNetworkIcon,
  SignInIcon,
  SpinnerGapIcon,
  StopIcon,
  TrashIcon,
  WarningCircleIcon,
  WarningOctagonIcon,
} from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { RecordingPlayer } from "@/components/recording-player";
import { PageHeader } from "@/components/shell/page-shell";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { buildHostLabels, shortRef } from "@/lib/audit/query";
import { useBilling } from "@/lib/billing/client";
import {
  MAX_ACCOUNT_RECORDING_BYTES,
  MAX_BLOB_BYTES,
  MAX_CAPTURE_BYTES,
  WARN_CAPTURE_BYTES,
} from "@/lib/recording/limits";
import {
  castFor,
  discardRecording,
  retrySave,
  subscribeSaved,
  useRecorders,
  type EndReason,
  type RecorderState,
} from "@/lib/recording/capture";
import { useSessionRecorder } from "@/lib/recording/use-session-recorder";
import { toAsciicast, type Cast } from "@/lib/recording/format";
import {
  MAX_SHARE_VIEWS,
  SHARE_EXPIRIES,
  createShare,
  listShares,
  revokeShare,
  type ShareSummary,
} from "@/lib/recording/share";
import {
  RecordingRequestError,
  deleteRecording,
  listRecordings,
  loadCast,
  type RecordingSummary,
} from "@/lib/recording/store";
import { useSshSession, type SessionEntry } from "@/lib/ssh/session-provider";
import { getAuditKey, getVaultKey, requestUnlock, useVaultUnlocked } from "@/lib/vault/session";

type ListState =
  | { phase: "loading" }
  | { phase: "ready" }
  | { phase: "unauthorized" }
  | { phase: "error"; message: string };

/** Same three states the activity log distinguishes, for the same column. */
type HostIndexState = "resolving" | "ready" | "locked" | "no-audit-key" | "failed";

const END_REASONS: Record<EndReason, string> = {
  user: "stopped by you",
  cap: `stopped at the ${formatBytes(MAX_CAPTURE_BYTES)} capture limit`,
  "session-closed": "stopped because the session closed",
};

export default function RecordingsPage() {
  const unlocked = useVaultUnlocked();
  const { sessions } = useSshSession();
  const recorders = useRecorders();
  /**
   * The plan, as the server states it. Never resolved here: a tab knows which
   * account it is signed into and nothing about what that account pays.
   *
   * `canRecord` is true while the plan is still loading, which is the same
   * fail-toward-access direction the server takes. The alternative is a Record
   * button that is disabled for a second on every page load, for everybody,
   * including the people who have paid.
   */
  const { billing } = useBilling();
  const canRecord = billing?.limits.sessionRecording ?? true;

  const [rows, setRows] = useState<RecordingSummary[]>([]);
  /** What the account holds, which is not always what this page loaded. */
  const [total, setTotal] = useState(0);
  /**
   * Ciphertext this account is holding, and the ceiling a save is refused at.
   * Server-side numbers: the page only ever has a page, and the sum of what is
   * on screen would read low for anyone with more than a page of recordings —
   * exactly the people close to the ceiling.
   */
  const [storedBytes, setStoredBytes] = useState<number | null>(null);
  const [storageLimit, setStorageLimit] = useState<number | null>(null);
  const [state, setState] = useState<ListState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [readAt, setReadAt] = useState(() => Date.now());

  const [hostLabels, setHostLabels] = useState<Map<string, string>>(() => new Map());
  const [hostIndex, setHostIndex] = useState<HostIndexState>("resolving");

  const [opening, setOpening] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ summary: RecordingSummary; cast: Cast } | null>(null);
  /**
   * The share dialog carries the decrypted cast, not the recording id, because
   * a share is a re-encryption rather than a pointer: the transcript has to be
   * open in this tab before a link can exist at all.
   */
  const [sharing, setSharing] = useState<{ summary: RecordingSummary; cast: Cast } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<RecordingSummary | null>(null);

  /* ------------------------------------------------------------- the list */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setState({ phase: "loading" });
      try {
        const page = await listRecordings();
        if (cancelled) return;
        setRows(page.recordings);
        setTotal(page.total);
        setStoredBytes(page.storedBytes);
        setStorageLimit(page.storageLimitBytes);
        setReadAt(Date.now());
        setState({ phase: "ready" });
      } catch (error) {
        if (cancelled) return;
        const kind = error instanceof RecordingRequestError ? error.kind : "server";
        setState(
          kind === "unauthorized"
            ? { phase: "unauthorized" }
            : { phase: "error", message: message(error) },
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // A recording can finish without anybody pressing stop — the cap, or the
  // session hanging up — so the list is told by the recorder rather than by the
  // button that did not get pressed. No toast here: capture.ts announces the
  // outcome of every save itself, so that the same news reaches somebody who is
  // on the terminal instead of this page, and toasting again here would only
  // say it twice to whoever is looking.
  useEffect(
    () =>
      subscribeSaved((summary) => {
        setRows((prev) => [summary, ...prev.filter((r) => r.id !== summary.id)]);
        setTotal((n) => n + 1);
        setStoredBytes((n) => (n === null ? null : n + summary.sizeBytes));
      }),
    [],
  );

  // Host resolution, re-run when the vault unlocks. Identical in shape to the
  // activity log's, because it is the same problem: the server holds a blinded
  // reference and only this device can say what it points at.
  useEffect(() => {
    let cancelled = false;
    const auditKey = getAuditKey();

    void (async () => {
      if (!auditKey) {
        setHostLabels(new Map());
        setHostIndex(unlocked ? "no-audit-key" : "locked");
        return;
      }
      setHostIndex("resolving");
      try {
        const index = await buildHostLabels(auditKey);
        if (cancelled) return;
        setHostLabels(index);
        setHostIndex("ready");
      } catch {
        if (cancelled) return;
        setHostLabels(new Map());
        setHostIndex("failed");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [unlocked]);

  const recorderFor = useCallback(
    (sessionId: string) => recorders.find((r) => r.sessionId === sessionId) ?? null,
    [recorders],
  );

  /** Recorders whose session has already gone from the list, still unsaved. */
  const orphans = useMemo(
    () => recorders.filter((r) => !sessions.some((s) => s.id === r.sessionId)),
    [recorders, sessions],
  );

  /* ----------------------------------------------------------- recording */

  // Shared with the terminal toolbar, which can start and stop a recording
  // without coming here. See lib/recording/use-session-recorder.ts.
  const { start, stop } = useSessionRecorder();

  /* ------------------------------------------------------------ playback */

  async function open(summary: RecordingSummary, then: (cast: Cast) => void) {
    const vaultKey = getVaultKey();
    if (!vaultKey) {
      requestUnlock();
      toast.error("The vault is locked", {
        description:
          "The recording is on the server as ciphertext; opening it needs the key that is only in memory.",
      });
      return;
    }
    setOpening(summary.id);
    try {
      then(await loadCast(summary.id, vaultKey));
    } catch (error) {
      toast.error("Could not open that recording", { description: message(error) });
    } finally {
      setOpening(null);
    }
  }

  function play(summary: RecordingSummary) {
    void open(summary, (cast) => setPlaying({ summary, cast }));
  }

  function share(summary: RecordingSummary) {
    void open(summary, (cast) => setSharing({ summary, cast }));
  }

  function download(summary: RecordingSummary) {
    void open(summary, (cast) => {
      const name = `webxterm-${stamp(summary.startedAt)}.cast`;
      downloadText(name, toAsciicast(cast), "application/x-asciicast");
      toast.success(`Saved ${name}`, {
        description:
          "asciinema v2 format, decrypted here. Output is text in that format, so any byte the session printed that was not valid UTF-8 is a replacement character in the file.",
      });
    });
  }

  /**
   * Saves an unsaved, in-memory transcript straight to a file.
   *
   * The escape hatch for a recorder that cannot reach the server: a save refused
   * because the account is on Free will not succeed on a retry, and this tab is
   * the only place the transcript exists. Nothing is encrypted on the way out —
   * it is a plaintext cast on the user's own disk, which is what a download is,
   * and the toast says so rather than letting the encryption elsewhere in this
   * feature imply otherwise.
   */
  function downloadUnsaved(sessionId: string) {
    const cast = castFor(sessionId);
    if (!cast) {
      toast.error("There is nothing to download yet", {
        description: "The recording is still capturing. Stop it first.",
      });
      return;
    }
    const name = `webxterm-${stamp(cast.header.startedAt)}.cast`;
    downloadText(name, toAsciicast(cast), "application/x-asciicast");
    toast.success(`Saved ${name}`, {
      description:
        "asciinema v2 format, written straight from this tab. It is not encrypted — it is a " +
        "plain file on your disk now. The recording is still here until you discard it.",
    });
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    try {
      await deleteRecording(target.id);
      setRows((prev) => prev.filter((r) => r.id !== target.id));
      setTotal((n) => Math.max(0, n - 1));
      setStoredBytes((n) => (n === null ? null : Math.max(0, n - target.sizeBytes)));
      if (playing?.summary.id === target.id) setPlaying(null);
      toast.success("Recording deleted", {
        description:
          "The row and every share link made from it are deleted rather than flagged. Any copy " +
          "already downloaded is not.",
      });
    } catch (error) {
      toast.error("Could not delete that recording", { description: message(error) });
    }
  }

  /* ---------------------------------------------------------------- view */

  return (
    <div className="min-w-0">
      <PageHeader
        eyebrow="Dashboard"
        title="Recordings"
        description="A timed transcript of what a session printed, captured in this tab and encrypted before it is stored. The server holds a blob it cannot read, its size, how long it ran, and a blinded reference to the host."
      />

      <Alert variant="destructive" className="mt-6">
        <WarningOctagonIcon />
        <AlertTitle>A recording is as sensitive as the session it captures</AlertTitle>
        <AlertDescription>
          <p>
            It is the terminal&rsquo;s output stream, which includes the shell echoing back
            everything you type. If it appeared on the screen it is in the file: tokens pasted into
            a command line, keys a command printed, the contents of every file you opened, the
            environment you dumped while debugging. A password typed at a prompt that hides it is
            not echoed and so is not captured — a password typed anywhere that shows it is.
          </p>
          <p>
            Read one before you keep it, and delete the ones you do not need. Encryption stops us
            reading it; it does not stop you sharing it with someone by accident later.
          </p>
        </AlertDescription>
      </Alert>

      {!unlocked && (
        <Alert className="mt-4">
          <LockKeyIcon />
          <AlertTitle>The vault is locked in this tab</AlertTitle>
          <AlertDescription>
            <p>
              Recording cannot start, and existing recordings cannot be opened, because both need
              the vault key — which is held in memory only and does not survive a page load. The
              list below is real; it is only the contents that are out of reach.
            </p>
            <Button variant="outline" size="sm" className="mt-1" onClick={requestUnlock}>
              Unlock the vault
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/*
        The plan gate, said before anybody records rather than at the end of an
        hour-long session. The rule this card has to make unmistakable is that
        the gate is on *saving new* recordings and on nothing else: what is
        already stored stays listable, playable, downloadable and revocable
        forever, because it is the user's own data encrypted with their own key.
        A person reading "Pro feature" on this page will otherwise reasonably
        assume their transcripts are about to be locked away.
      */}
      {billing && !billing.limits.sessionRecording && (
        <Alert className="mt-4">
          <RecordIcon className="text-warning" />
          <AlertTitle>Recording new sessions is a Pro feature</AlertTitle>
          <AlertDescription>
            <p>
              This account is on {billing.label}, so a new recording cannot be saved and the Record
              buttons below are disabled. Everything already on this page is unaffected and always
              will be: play it, download it as a cast file, revoke a share link you have out, delete
              it. We have never been able to read any of it and nothing here is held back pending a
              payment.
            </p>
            <p>
              {billing.billingConfigured ? (
                <>
                  Pro is {billing.price.label} {billing.price.unit} — see{" "}
                  <Link
                    href="/dashboard/settings?tab=account"
                    className="underline underline-offset-2"
                  >
                    Settings
                  </Link>{" "}
                  to subscribe, or{" "}
                  <Link href="/pricing" className="underline underline-offset-2">
                    pricing
                  </Link>{" "}
                  for what else changes.
                </>
              ) : (
                <>
                  No payment provider is configured on this deployment, so there is no way to change
                  this from here. That is a property of this install rather than of your account.
                </>
              )}
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/*
        Said before a recording is started rather than at the end of one. The
        server refuses a save that would cross the ceiling, and finding that out
        after an hour of capture — with the transcript held in a tab that a
        reload would empty — is the failure this warning exists to prevent.
      */}
      {storedBytes !== null &&
        storageLimit !== null &&
        storedBytes + MAX_BLOB_BYTES > storageLimit && (
          <Alert className="mt-4">
            <WarningCircleIcon className="text-warning" />
            <AlertTitle>
              Your recordings are close to the {formatBytes(storageLimit)} this account can store
            </AlertTitle>
            <AlertDescription>
              <span>
                {formatBytes(storedBytes)} is stored, and a full-length recording needs up to{" "}
                {formatBytes(MAX_BLOB_BYTES)} once encrypted. A save that does not fit is refused —
                nothing older is deleted to make room — and the transcript stays in this tab until
                you delete something and retry, or discard it. Deleting recordings below frees the
                space immediately.
              </span>
            </AlertDescription>
          </Alert>
        )}

      {/* ------------------------------------------------------ live sessions */}
      <h2 className="mt-8 font-heading text-sm font-medium">Open sessions</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Recording runs in this tab. Navigating around the dashboard is fine — this page does not
        have to stay open — but closing the tab, or reloading it, ends the capture and loses
        anything not yet saved.
      </p>

      <Card className="mt-3">
        <CardContent className="flex flex-col gap-3">
          {sessions.length === 0 && orphans.length === 0 ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-muted-foreground">
                No sessions are open, so there is nothing to record.
              </p>
              <Button asChild variant="outline" size="sm">
                <Link href="/dashboard/connect">
                  <PlugsConnectedIcon data-icon="inline-start" />
                  Connect to a host
                </Link>
              </Button>
            </div>
          ) : (
            <>
              {sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  recorder={recorderFor(session.id)}
                  canRecord={canRecord}
                  onStart={() => void start(session)}
                  onStop={() => void stop(session.id)}
                  onRetry={() => void retrySave(session.id)}
                  onDownload={() => downloadUnsaved(session.id)}
                  onDiscard={() => discardRecording(session.id)}
                />
              ))}
              {orphans.map((recorder) => (
                <UnsavedRow
                  key={recorder.sessionId}
                  recorder={recorder}
                  onRetry={() => void retrySave(recorder.sessionId)}
                  onDownload={() => downloadUnsaved(recorder.sessionId)}
                  onDiscard={() => discardRecording(recorder.sessionId)}
                />
              ))}
            </>
          )}
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------- list */}
      <h2 className="mt-8 font-heading text-sm font-medium">Stored recordings</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Hosts are resolved here, on this device, from the blinded reference each row was stored with
        — the same mechanism the activity log uses. The name you gave a recording lives inside the
        ciphertext, so it appears when you open one and not before.
      </p>

      {state.phase === "loading" ? (
        <LoadingRows />
      ) : state.phase === "unauthorized" ? (
        <SignedOutState />
      ) : state.phase === "error" ? (
        <ErrorState message={state.message} onRetry={() => setAttempt((n) => n + 1)} />
      ) : rows.length === 0 ? (
        <EmptyState />
      ) : (
        <Card className="mt-3">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-(--card-spacing)">Recorded</TableHead>
                  <TableHead>Host</TableHead>
                  <TableHead>Length</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead className="pr-(--card-spacing) text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="pl-(--card-spacing) align-top">
                      <div className="tabular-nums text-foreground">{absolute(row.startedAt)}</div>
                      <div className="text-muted-foreground">{relative(row.startedAt, readAt)}</div>
                    </TableCell>

                    <TableCell className="align-top">
                      <HostCell
                        targetRef={row.targetRef}
                        label={row.targetRef ? (hostLabels.get(row.targetRef) ?? null) : null}
                        index={hostIndex}
                      />
                    </TableCell>

                    <TableCell className="align-top tabular-nums text-foreground">
                      {formatDuration(row.durationMs)}
                    </TableCell>

                    <TableCell className="align-top tabular-nums text-foreground">
                      {formatBytes(row.sizeBytes)}
                    </TableCell>

                    <TableCell className="pr-(--card-spacing) align-top">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={opening !== null}
                          onClick={() => play(row)}
                        >
                          {opening === row.id ? (
                            <SpinnerGapIcon className="animate-spin" />
                          ) : (
                            <PlayIcon weight="fill" />
                          )}
                          Play
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Share this recording by link"
                          disabled={opening !== null}
                          onClick={() => share(row)}
                        >
                          <ShareNetworkIcon />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Download the cast"
                          disabled={opening !== null}
                          onClick={() => download(row)}
                        >
                          <DownloadSimpleIcon />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Delete this recording"
                          onClick={() => setPendingDelete(row)}
                        >
                          <TrashIcon />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>

          <CardContent className="border-t border-border pt-(--card-spacing) text-muted-foreground">
            {total > rows.length
              ? `The ${rows.length} most recent of ${total} recordings. `
              : `${rows.length} ${rows.length === 1 ? "recording" : "recordings"}. `}
            {storedBytes !== null && storageLimit !== null ? (
              <>
                They hold {formatBytes(storedBytes)} of ciphertext of the{" "}
                {formatBytes(storageLimit)} this account can store; at the ceiling a save is refused
                and nothing older is deleted to make room.{" "}
              </>
            ) : (
              <>
                This server did not report how much storage the account is using, so the figure
                against the {formatBytes(MAX_ACCOUNT_RECORDING_BYTES)} ceiling is not shown rather
                than guessed from this page.{" "}
              </>
            )}
            Nothing deletes these on a schedule: a recording stays until you remove it. Saving one
            uploads it to this server and not through the relay, so it does not count against the
            monthly relay transfer allowance on Settings.
          </CardContent>
        </Card>
      )}

      {/* ----------------------------------------------------------- player */}
      <Dialog open={playing !== null} onOpenChange={(o) => !o && setPlaying(null)}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{playing?.cast.header.label ?? "Recording"}</DialogTitle>
            <DialogDescription>
              {playing
                ? `${playing.cast.header.host ?? "host not recorded"} · ${formatDuration(playing.summary.durationMs)} · recorded ${absolute(playing.summary.startedAt)}`
                : null}
            </DialogDescription>
          </DialogHeader>
          {/* Keyed so opening a second recording builds a new emulator rather
              than reusing one still holding the last transcript's screen. */}
          {playing && <RecordingPlayer key={playing.summary.id} cast={playing.cast} />}
        </DialogContent>
      </Dialog>

      {/* ------------------------------------------------------------ share */}
      <Dialog open={sharing !== null} onOpenChange={(o) => !o && setSharing(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Share this recording by link</DialogTitle>
            <DialogDescription>
              {sharing
                ? `${sharing.cast.header.label ?? "Recording"} · ${formatDuration(sharing.summary.durationMs)} · recorded ${absolute(sharing.summary.startedAt)}`
                : null}
            </DialogDescription>
          </DialogHeader>
          {/* Keyed so switching recordings does not carry the previous one's
              link, form state or share list into a different transcript. */}
          {sharing && (
            <SharePanel key={sharing.summary.id} summary={sharing.summary} cast={sharing.cast} />
          )}
        </DialogContent>
      </Dialog>

      {/* ----------------------------------------------------------- delete */}
      <AlertDialog open={pendingDelete !== null} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this recording?</AlertDialogTitle>
            <AlertDialogDescription>
              Every share link made from this recording goes with it, live ones included, so any
              link already sent stops opening anything — and the revoked rows that were the only
              record a link existed go too. The row itself is deleted rather than flagged, and we
              have never been able to read it. What we cannot promise is that no copy of the
              ciphertext exists anywhere: a database backup or replica taken before now may still
              hold it until it rotates, unreadable, the same caveat the activity log&rsquo;s pruner
              states. Any file you have already downloaded is unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>
              Delete recording
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ------------------------------------------------------------------ share */

/**
 * Making a link, and living with the ones already made.
 *
 * Everything in here follows from one fact stated at the top of the panel: the
 * link is the key. The recording is decrypted in this tab, re-encrypted under a
 * key generated for this share alone, and that key is put in the fragment of the
 * link — so the server stores a blob it cannot read and anyone holding the link
 * can watch the recording with no account at all.
 *
 * Two consequences shape the UI. The link is shown once, because the key is
 * never stored and neither we nor this page can rebuild it; dismissing without
 * copying means making a new one. And an expiry is a required field rather than
 * an option, because once a link is forwarded, expiry and the view limit are
 * the only controls left — revoking depends on remembering to.
 *
 * The defaults are the tight ones on purpose: a day, and five views. Five
 * rather than one because reloading the viewer counts as a view, and a limit of
 * one turns an accidental refresh into a link the recipient cannot reopen.
 */
function SharePanel({ summary, cast }: { summary: RecordingSummary; cast: Cast }) {
  /**
   * Creating a share is creating a second encrypted copy on our disk, so it is
   * gated the same way saving a recording is. Listing and revoking are not, and
   * the panel keeps working for both — an owner must always be able to cut off a
   * live link, whatever they pay.
   */
  const { billing } = useBilling();
  const canShare = billing?.limits.sessionRecording ?? true;

  const [expiryId, setExpiryId] = useState("24h");
  const [limited, setLimited] = useState(true);
  const [viewsText, setViewsText] = useState("5");
  const [creating, setCreating] = useState(false);

  /** The one moment this string exists. Never persisted, never re-derivable. */
  const [link, setLink] = useState<string | null>(null);

  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "failed">("loading");
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listShares(summary.id);
        if (!cancelled) {
          setShares(rows);
          setListState("ready");
        }
      } catch {
        // No message: the list of existing links is not what the dialog is for,
        // and a failure to load it must not read as a failure to share.
        if (!cancelled) setListState("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [summary.id]);

  async function create() {
    const expiry = SHARE_EXPIRIES.find((e) => e.id === expiryId);
    if (!expiry) return;

    let maxViews: number | null = null;
    if (limited) {
      const parsed = Number(viewsText);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SHARE_VIEWS) {
        toast.error("That view limit is not a number of views", {
          description: `It has to be a whole number between 1 and ${MAX_SHARE_VIEWS}, or the limit switched off.`,
        });
        return;
      }
      maxViews = parsed;
    }

    setCreating(true);
    try {
      const created = await createShare(
        summary.id,
        cast,
        { ttlMs: expiry.ms, maxViews },
        window.location.origin,
      );
      setLink(created.link);
      setShares((prev) => [created.share, ...prev]);
      setListState("ready");
    } catch (error) {
      toast.error("The share link was not created", { description: message(error) });
    } finally {
      setCreating(false);
    }
  }

  async function revoke(share: ShareSummary) {
    setRevoking(share.id);
    try {
      await revokeShare(summary.id, share.id);
      setShares((prev) =>
        prev.map((s) => (s.id === share.id ? { ...s, revokedAt: Date.now(), sizeBytes: 0 } : s)),
      );
      toast.success("That link no longer opens anything", {
        description:
          "The encrypted copy is deleted and the storage is back. Anyone who already watched the recording still has what they saw, and the link they hold still contains a working key — there is simply nothing left for it to open.",
      });
    } catch (error) {
      toast.error("The link was not revoked", { description: message(error) });
    } finally {
      setRevoking(null);
    }
  }

  // Read once when the dialog opens, the way the list reads `readAt`. A link
  // that expires while this panel is on screen keeps saying "live" until it is
  // reopened, which is the same staleness the row timestamps already carry and
  // is not worth a ticking clock — the server is the one that refuses.
  const [now] = useState(() => Date.now());

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Alert variant="destructive">
        <LinkIcon />
        <AlertTitle>The link is the key</AlertTitle>
        <AlertDescription>
          <p>
            A share is a second copy of this transcript, encrypted here under a key generated for
            that link alone — never your vault key, which opens everything else you have. That key
            travels in the part of the link after the <code className="text-foreground">#</code>,
            which browsers never send to a server, so we store a blob we cannot read.
          </p>
          <p>
            Which means anyone holding the link can watch this recording. No account, no sign-in, no
            way for us to tell who did. Forwarding the link forwards the access. And the recording
            is everything the terminal printed, including the echo of what was typed at the prompt —
            read it before you send it.
          </p>
          <p>
            An expiry and a view limit are the only controls that keep working once a link has left
            your hands, which is why they are set here rather than offered as extras.
          </p>
        </AlertDescription>
      </Alert>

      {!canShare && (
        <Alert>
          <RecordIcon className="text-warning" />
          <AlertTitle>New share links need Pro</AlertTitle>
          <AlertDescription>
            <span>
              A share is a second encrypted copy of this transcript stored on our server, so it is
              part of session recording rather than a separate thing. Links you already have are
              listed below and can still be revoked — that must never depend on a subscription. The
              recording itself still plays and still downloads, and a downloaded cast file can be
              sent to anyone.
            </span>
          </AlertDescription>
        </Alert>
      )}

      {link !== null ? (
        <NewLink link={link} onDone={() => setLink(null)} />
      ) : (
        <div className="flex flex-col gap-3 border border-border bg-card p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="share-expiry">The link stops working after</Label>
              <Select value={expiryId} onValueChange={setExpiryId}>
                <SelectTrigger id="share-expiry" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SHARE_EXPIRIES.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Switch id="share-limited" checked={limited} onCheckedChange={setLimited} />
                <Label htmlFor="share-limited">Limit how many times it opens</Label>
              </div>
              <Input
                type="number"
                min={1}
                max={MAX_SHARE_VIEWS}
                inputMode="numeric"
                aria-label="Number of views the link allows"
                value={viewsText}
                disabled={!limited}
                onChange={(e) => setViewsText(e.target.value)}
              />
            </div>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Every load of the viewer counts as a view, a reload included. A share is a second
            encrypted copy of the recording, so it takes the same storage again — the figure on this
            page counts recordings only, so share copies are not in it. Revoking a link deletes its
            copy and gives that storage back.
          </p>

          <div>
            <Button onClick={() => void create()} disabled={creating || !canShare}>
              {creating ? <SpinnerGapIcon className="animate-spin" /> : <LinkIcon />}
              {creating ? "Encrypting a second copy" : "Create the link"}
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="font-heading text-sm font-medium">Links for this recording</h3>
        {listState === "loading" ? (
          <Skeleton className="h-8 w-full" />
        ) : listState === "failed" ? (
          <p className="text-xs text-muted-foreground">
            The existing links could not be listed. Creating a new one still works; this is only the
            list.
          </p>
        ) : shares.length === 0 ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            No links exist for this recording, which means none has ever been made — from this
            browser or any other. Revoking a link leaves its row here, so an empty list is the whole
            answer rather than half of one.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border border border-border">
            {shares.map((s) => (
              <ShareRow
                key={s.id}
                share={s}
                now={now}
                busy={revoking === s.id}
                onRevoke={() => void revoke(s)}
              />
            ))}
          </ul>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          The links themselves are not listed, and cannot be: each one&rsquo;s key existed only in
          the tab that made it, so what is kept here is the row, not the address. Revoking stops the
          next fetch and nothing more — it does not reach a copy already watched or downloaded, and
          whoever has the link still has a key.
        </p>
      </div>
    </div>
  );
}

/**
 * The one-time display, in the shape the recovery codes use, because it is the
 * same situation: this is the only moment the value exists and dismissing is
 * deliberately an explicit act.
 */
function NewLink({ link, onDone }: { link: string; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-3 border border-warning/40 bg-card p-3">
      <p className="flex items-center gap-2 font-medium text-warning">
        <WarningCircleIcon className="size-4" />
        Shown once. Copy it before you close this.
      </p>

      <div className="bg-terminal border border-border px-3 py-2 font-mono text-[11px] leading-relaxed break-all select-all text-foreground">
        {link}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        We cannot show this again — the key after the <code className="text-foreground">#</code> was
        generated in this tab, put into this link, and dropped. The server has the encrypted copy
        and no way to open it, so if this link is lost the only way forward is to revoke it and make
        a new one.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            void navigator.clipboard
              .writeText(link)
              .then(() => toast.success("Link copied to the clipboard"))
              .catch(() =>
                toast.error("The clipboard was refused", {
                  description: "Select the link above and copy it by hand.",
                }),
              );
          }}
        >
          <CopyIcon data-icon="inline-start" />
          Copy the link
        </Button>
        <Button variant="outline" onClick={onDone}>
          I have copied it
        </Button>
      </div>
    </div>
  );
}

function ShareRow({
  share,
  now,
  busy,
  onRevoke,
}: {
  share: ShareSummary;
  now: number;
  busy: boolean;
  onRevoke: () => void;
}) {
  const status = shareStatus(share, now);

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <span className={`text-xs font-medium ${status.tone}`}>{status.label}</span>

      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <EyeIcon className="size-3.5 shrink-0" />
        {share.maxViews === null
          ? `${share.views} ${share.views === 1 ? "view" : "views"}, no limit`
          : `${share.views} of ${share.maxViews} views used`}
      </span>

      <span className="text-xs text-muted-foreground">
        {share.revokedAt !== null
          ? `revoked ${absolute(share.revokedAt)}`
          : share.expiresAt <= now
            ? `expired ${absolute(share.expiresAt)}`
            : `expires ${absolute(share.expiresAt)}`}
      </span>

      <span className="text-xs text-muted-foreground">
        made {absolute(share.createdAt)}
        {share.sizeBytes > 0 ? ` · ${formatBytes(share.sizeBytes)}` : ""}
      </span>

      {share.revokedAt === null && (
        <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={onRevoke}>
          {busy ? <SpinnerGapIcon className="animate-spin" /> : <ProhibitIcon />}
          Revoke
        </Button>
      )}
    </li>
  );
}

/**
 * What a share is doing right now. Revoked outranks expired outranks spent,
 * because that is the order in which each one stopped mattering — a revoked
 * link that would also have expired is described by the act, not the clock.
 */
function shareStatus(share: ShareSummary, now: number): { label: string; tone: string } {
  if (share.revokedAt !== null) return { label: "revoked", tone: "text-muted-foreground" };
  if (share.expiresAt <= now) return { label: "expired", tone: "text-muted-foreground" };
  if (share.maxViews !== null && share.views >= share.maxViews) {
    return { label: "used up", tone: "text-muted-foreground" };
  }
  return { label: "live", tone: "text-success" };
}

/* -------------------------------------------------------------- live rows */

function SessionRow({
  session,
  recorder,
  canRecord,
  onStart,
  onStop,
  onRetry,
  onDownload,
  onDiscard,
}: {
  session: SessionEntry;
  recorder: RecorderState | null;
  /**
   * Whether this account may save a new recording. Disabled rather than hidden,
   * with the reason on the button: a Record control that quietly vanishes on
   * Free reads as a bug, and one that starts a capture the server will refuse to
   * store is worse than either.
   */
  canRecord: boolean;
  onStart: () => void;
  onStop: () => void;
  onRetry: () => void;
  onDownload: () => void;
  onDiscard: () => void;
}) {
  const capturing = recorder?.capturing ?? false;
  const percent = recorder ? Math.min(100, (recorder.bytes / MAX_CAPTURE_BYTES) * 100) : 0;
  const nearingCap = recorder !== null && recorder.bytes >= WARN_CAPTURE_BYTES;

  return (
    <div className="flex flex-col gap-2 border-b border-border pb-3 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {session.label}:{session.target.port}
        </span>

        {capturing ? (
          <>
            <Badge variant="outline" className="gap-1.5 text-destructive">
              <RecordIcon weight="fill" className="animate-pulse" />
              recording
            </Badge>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {formatBytes(recorder?.bytes ?? 0)}
            </span>
            <Button size="sm" variant="secondary" onClick={onStop}>
              <StopIcon weight="fill" /> Stop and save
            </Button>
          </>
        ) : recorder ? (
          <SaveState
            recorder={recorder}
            onRetry={onRetry}
            onDownload={onDownload}
            onDiscard={onDiscard}
          />
        ) : canRecord ? (
          <Button size="sm" variant="outline" onClick={onStart}>
            <RecordIcon weight="fill" className="text-destructive" /> Record
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* A span, because a disabled button does not fire the pointer
                  events a tooltip needs, and the explanation is the point. */}
              <span>
                <Button size="sm" variant="outline" disabled>
                  <RecordIcon weight="fill" /> Record
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Recording new sessions needs Pro. Recordings already saved still play and download.
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {capturing && (
        <div className="flex flex-col gap-1">
          <Progress value={percent} />
          <p className={`text-xs ${nearingCap ? "text-warning" : "text-muted-foreground"}`}>
            {nearingCap
              ? `${formatBytes(recorder?.bytes ?? 0)} of ${formatBytes(MAX_CAPTURE_BYTES)}. Capture stops at the limit and saves what it has — there is no way to keep going into an unbounded buffer in a browser tab.`
              : `${formatBytes(recorder?.bytes ?? 0)} of ${formatBytes(MAX_CAPTURE_BYTES)} captured. Held in this tab until you stop.`}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * A recorder whose session is gone from the list but which still holds bytes —
 * a save that failed against a locked vault or a dead network. It stays on
 * screen because the alternative is throwing away a transcript on the user's
 * behalf without telling them.
 */
function UnsavedRow({
  recorder,
  onRetry,
  onDownload,
  onDiscard,
}: {
  recorder: RecorderState;
  onRetry: () => void;
  onDownload: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-border pb-3 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{recorder.label}</span>
        <SaveState
          recorder={recorder}
          onRetry={onRetry}
          onDownload={onDownload}
          onDiscard={onDiscard}
        />
      </div>
    </div>
  );
}

/**
 * A recorder that has stopped and is holding bytes.
 *
 * Three ways out rather than two, and which of them is offered depends on
 * whether the save could work at a second attempt. A locked vault, a dropped
 * network or a full account are all states that change, so Save is the primary
 * action. A plan refusal is not: the account is on Free and pressing Save again
 * produces the same 402. Offering it there would be a control that cannot
 * succeed, so it is dropped and the download is promoted in its place — the
 * transcript exists only in this tab, and a file on disk is the one thing that
 * outlives a reload.
 *
 * Download is available in every state, not only the hopeless one. A capability
 * that appears only on the unhappy path is one nobody discovers.
 */
function SaveState({
  recorder,
  onRetry,
  onDownload,
  onDiscard,
}: {
  recorder: RecorderState;
  onRetry: () => void;
  onDownload: () => void;
  onDiscard: () => void;
}) {
  if (recorder.saving) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <SpinnerGapIcon className="animate-spin" />
        Encrypting and storing {formatBytes(recorder.bytes)}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-warning">
        {recorder.ended ? END_REASONS[recorder.ended] : "capture ended"}
        {recorder.error ? ` — ${recorder.error}` : ""}
      </span>
      {recorder.retryable && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          <ArrowClockwiseIcon /> Save
        </Button>
      )}
      <Button size="sm" variant={recorder.retryable ? "ghost" : "secondary"} onClick={onDownload}>
        <DownloadSimpleIcon /> Download
      </Button>
      <Button size="sm" variant="ghost" onClick={onDiscard}>
        <TrashIcon /> Discard
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------- host cell */

const OPAQUE_COPY: Record<HostIndexState, string> = {
  ready:
    "No host saved in this vault produces this reference — a one-off connection, or one saved on a device that has not synced here. The server cannot resolve it either: it has never held the name.",
  resolving:
    "This device is still hashing your saved hosts to see which reference each one produces.",
  locked:
    "This is HMAC(audit key, host and port). Unlock the vault and this device can match it against your saved hosts. The server can never match it.",
  "no-audit-key":
    "This tab holds the vault key but not the audit branch it is derived alongside, so references cannot be matched.",
  failed:
    "The saved host list could not be read in this browser, so there was nothing to match this reference against.",
};

function HostCell({
  targetRef,
  label,
  index,
}: {
  targetRef: string | null;
  label: string | null;
  index: HostIndexState;
}) {
  if (!targetRef) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help text-muted-foreground">no reference</span>
        </TooltipTrigger>
        <TooltipContent className="block max-w-sm">
          This recording was stored without a host reference, which happens when the tab had no
          audit key at the time. Which host it was is still inside the ciphertext — open it and the
          header says.
        </TooltipContent>
      </Tooltip>
    );
  }

  if (label) {
    return (
      <>
        <div className="flex items-center gap-1.5">
          <HardDrivesIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-foreground">{label}</span>
        </div>
        <div className="text-muted-foreground">{shortRef(targetRef)}</div>
      </>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-block cursor-help text-left">
          <span className="flex items-center gap-1.5">
            <EyeSlashIcon className="size-3.5 shrink-0 text-warning" />
            <span className="text-foreground">{shortRef(targetRef)}</span>
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="block max-w-sm">{OPAQUE_COPY[index]}</TooltipContent>
    </Tooltip>
  );
}

/* ----------------------------------------------------------------- states */

function EmptyState() {
  return (
    <Card className="mt-3">
      <CardContent className="flex flex-col items-start gap-4 py-10 sm:px-8">
        <div className="grid size-9 place-items-center rounded-sm border border-border bg-secondary text-primary">
          <FilmStripIcon />
        </div>
        <div className="max-w-xl">
          <h3 className="font-heading text-sm font-medium">Nothing recorded yet</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Start a recording from an open session above and everything the shell prints from that
            moment is captured with its timing, so it can be replayed at the size it ran at. It is a
            transcript for a runbook, an incident write-up, or showing someone what actually
            happened.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Nothing is captured until you ask for it, and the capture is encrypted in this browser
            before it is stored. What we hold is a blob, its size, its length and a blinded
            reference to the host — we cannot play your recordings back, search them, or tell you
            what is in one.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function LoadingRows() {
  return (
    <Card className="mt-3" aria-busy="true" aria-label="Loading recordings">
      <CardContent className="space-y-3 py-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-4">
            <Skeleton className="h-3 w-32 shrink-0" />
            <Skeleton className="h-3 w-40" />
            <Skeleton className="ml-auto h-3 w-20 shrink-0" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function SignedOutState() {
  return (
    <Card className="mt-3">
      <CardContent className="flex flex-col items-start gap-2 py-4">
        <span
          aria-hidden
          className="grid size-8 place-items-center rounded-sm border border-border bg-secondary text-warning"
        >
          <SignInIcon className="size-4" />
        </span>
        <p className="font-heading text-sm font-medium">This browser is signed out</p>
        <p className="max-w-lg text-muted-foreground">
          Recordings are per account, so the list cannot be read without a session. Signing in again
          also lets you unlock the vault, which is what makes a recording playable.
        </p>
        <Button asChild variant="outline" size="sm" className="mt-1">
          <Link href="/sign-in">Sign in</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function ErrorState({ message: text, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="mt-3">
      <CardContent className="flex flex-col items-start gap-2 py-4">
        <span
          aria-hidden
          className="grid size-8 place-items-center rounded-sm border border-border bg-secondary text-destructive"
        >
          <WarningCircleIcon className="size-4" />
        </span>
        <p className="font-heading text-sm font-medium">The recordings could not be listed</p>
        <p className="max-w-lg text-muted-foreground">
          {text} Recording itself does not depend on this list — a session can still be captured
          while the list is unavailable, and it will be stored when you stop.
        </p>
        <Button variant="outline" size="sm" className="mt-1" onClick={onRetry}>
          <ArrowClockwiseIcon data-icon="inline-start" />
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------- formatting */

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Decimal units, matching the transfer counters elsewhere in the product. */
function formatBytes(n: number): string {
  const units = ["B", "kB", "MB", "GB"];
  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const rounded = unit === 0 || value >= 100 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${units[unit]}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function absolute(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stamp(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

const RTF = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function relative(at: number, now: number): string {
  const delta = at - now;
  const abs = Math.abs(delta);
  if (abs < 60_000) return "just now";
  for (const [unit, ms] of UNITS) {
    if (abs >= ms) return RTF.format(Math.round(delta / ms), unit);
  }
  return "just now";
}

function downloadText(name: string, body: string, mime: string) {
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
