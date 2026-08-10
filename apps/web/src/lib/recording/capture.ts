"use client"

/**
 * Capturing a session.
 *
 * A recorder taps the live output stream of one SSH session, timestamps every
 * chunk against a monotonic clock, and keeps the result in this tab until it is
 * encrypted and stored. Nothing about a recording is server-side: no signal
 * starts one, nothing on the server knows one is running, and if this tab goes
 * away mid-recording the recording goes with it. That is a real limitation and
 * the page says so; it is also the only arrangement consistent with a server
 * that cannot read the session.
 *
 * ── Memory
 *
 * The obvious implementation is an array that grows until the tab dies, and a
 * shell tailing a chatty log fills memory in an afternoon. Three ways out were
 * on the table:
 *
 *  - A ring buffer, dropping the oldest events. Rejected. A transcript that
 *    silently loses its beginning is not a shortened recording, it is a
 *    different recording, and the terminal makes it worse than that: the escape
 *    sequences that set up the screen are at the start, so dropping them makes
 *    everything after them render wrong.
 *  - Flushing chunks to the server as they accumulate. Rejected for now, and
 *    for a structural reason rather than a lazy one: `recording` holds one blob
 *    per row, so chunked upload means either many rows to reassemble or an
 *    append endpoint, and both are a schema decision this task does not own.
 *  - A hard cap. Chosen. Capture stops at MAX_CAPTURE_BYTES — kept in ./limits
 *    so that /pricing can state the same number this file enforces — the
 *    recording is finalised and saved with everything up to that point, and the
 *    UI says why it stopped. A cap that ends the recording honestly is better
 *    than one that quietly keeps a "recording" badge lit over a dead capture.
 *
 * The last point is the rule this module is built around: `capturing` goes false
 * the instant bytes stop being kept, whatever the reason, and every surface that
 * shows a recording reads that flag rather than assuming.
 *
 * ── Telling somebody
 *
 * A save can end a recording in two very different states and they used to look
 * identical from every route but /dashboard/recordings: the indicator stopped,
 * and whether the transcript had been stored or lost was not on screen anywhere.
 * The two auto-stops are exactly the cases where nobody pressed a button — the
 * size cap, and a session hanging up — so the outcome is announced from here,
 * by this module, rather than by whichever page happened to be mounted. The
 * sidebar carries the durable half: a recorder that ended and is still in memory
 * is counted on the Recordings entry, because a toast is gone in seconds and an
 * unsaved transcript is gone on the next reload.
 *
 * ── Keys
 *
 * Starting requires an unlocked vault, because a recording that cannot be
 * encrypted has nowhere to go. The vault key is deliberately NOT held for the
 * duration: it is read again at save time from lib/vault/session, so locking the
 * vault mid-session really does drop the key rather than leaving a copy in here.
 * The cost is a recording that finishes against a locked vault, and that case is
 * kept in memory with an explanation and a retry rather than being thrown away.
 *
 * ── The plan
 *
 * Saving a recording is a Pro feature. That is enforced by POST /api/recordings,
 * which reads the subscription table and refuses; this module's check is not a
 * second enforcement and could not be one, since everything here runs on the
 * user's own machine. It exists for a timing reason: without it the refusal
 * arrives at the *end*, after somebody has captured an hour of work into a
 * buffer that a reload destroys. Refusing at the start costs nothing and is the
 * difference between an explanation and a loss.
 *
 * It reads `canRecordNow` from lib/billing/client.ts, which returns true when
 * the plan has not been fetched yet. That is deliberate: a browser that has not
 * been told what the account pays must not take a paid feature away on its own
 * initiative, and the server would have allowed the save. The recordings page
 * loads the plan before it renders a Record button, so in practice this branch
 * is a guard on programmatic callers rather than the path a person takes.
 */

import { useSyncExternalStore } from "react"
import { toast } from "sonner"

import { canRecordNow } from "@/lib/billing/client"
import type { SessionTapEvent } from "@/lib/ssh/session-provider"
import { formatBytes } from "@/lib/usage"
import { getVaultKey } from "@/lib/vault/session"
import type { Cast, CastEvent } from "./format"
import { MAX_CAPTURE_BYTES } from "./limits"
import { RecordingRequestError, saveRecording, type RecordingSummary } from "./store"

/* -------------------------------------------------------------- the buffer */

/**
 * The accumulating cast. Pure — no timers, no network, no DOM — so the cap and
 * the ordering rules can be tested directly.
 */
export class CastBuffer {
  /** Milliseconds since the epoch, for "when was this recorded". */
  readonly startedAt: number

  /** The geometry the recording began at. The header carries exactly this. */
  private readonly initialCols: number
  private readonly initialRows: number

  private readonly events: CastEvent[] = []
  private cols: number
  private rows: number
  private captured = 0
  private full = false
  private lastAt = 0

  constructor(cols: number, rows: number, startedAt: number = Date.now()) {
    this.initialCols = cols
    this.initialRows = rows
    this.cols = cols
    this.rows = rows
    this.startedAt = startedAt
  }

  /** Raw output bytes kept so far. Not the stored size, which is larger. */
  get bytes(): number {
    return this.captured
  }

  get eventCount(): number {
    return this.events.length
  }

  /** True once the cap refused a chunk. Nothing is recorded after that. */
  get isFull(): boolean {
    return this.full
  }

  /**
   * Records a chunk, or refuses it because the cap is reached.
   *
   * A chunk that would cross the cap is dropped whole rather than truncated. A
   * truncated chunk can end halfway through an escape sequence, and half an
   * escape sequence does not render as slightly less output — it renders as the
   * rest of the transcript in the wrong colour, or in the wrong screen mode.
   * Losing a few hundred bytes at the very end is the cheaper failure.
   */
  output(at: number, bytes: Uint8Array): boolean {
    if (this.full || bytes.length === 0) return false
    if (this.captured + bytes.length > MAX_CAPTURE_BYTES) {
      this.full = true
      return false
    }
    this.captured += bytes.length
    this.events.push({ at: this.stamp(at), kind: "output", bytes })
    return true
  }

  /**
   * Records a resize. Repeats are dropped: dragging a pane divider fires a
   * resize per frame and the geometry only matters when it changes.
   */
  resize(at: number, cols: number, rows: number): void {
    if (this.full) return
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.events.push({ at: this.stamp(at), kind: "resize", cols, rows })
  }

  /**
   * Timestamps must not go backwards — the decoder and the player both walk the
   * events in order and a backwards step would replay part of the session
   * twice. performance.now() is monotonic, so this only ever fires if a caller
   * passes its own clock, and clamping is the quiet correct answer.
   */
  private stamp(at: number): number {
    const stamped = Math.max(0, Math.round(at), this.lastAt)
    this.lastAt = stamped
    return stamped
  }

  toCast(meta: { durationMs: number; label?: string; host?: string }): Cast {
    return {
      header: {
        v: 1,
        // The size the terminal started at, not the size it ended at: the
        // player sets the emulator up with this and then replays the resizes.
        cols: this.initialCols,
        rows: this.initialRows,
        startedAt: this.startedAt,
        durationMs: Math.max(0, Math.round(meta.durationMs), this.lastAt),
        ...(meta.label ? { label: meta.label } : {}),
        ...(meta.host ? { host: meta.host } : {}),
      },
      events: [...this.events],
    }
  }
}

/* ------------------------------------------------------------- the registry */

/** Why capture stopped. Every one of these is shown to the user verbatim. */
export type EndReason = "user" | "cap" | "session-closed"

export interface RecorderState {
  sessionId: string
  /** The session's label at the moment recording started. */
  label: string
  /** Milliseconds since the epoch. */
  startedAt: number
  /** Raw output bytes captured. Compare against MAX_CAPTURE_BYTES. */
  bytes: number
  /** False the moment bytes stop being kept, for any reason. */
  capturing: boolean
  /** Null while capturing. */
  ended: EndReason | null
  /** An encrypt-and-upload is in flight. */
  saving: boolean
  /** Why the last save attempt failed. The recording is still in memory. */
  error: string | null
  /**
   * Whether trying the save again could plausibly work.
   *
   * False for a plan refusal, which is the one failure that is not going to
   * resolve itself: a locked vault unlocks and a dead network comes back, but a
   * Free account stays Free until somebody subscribes. A Retry button offered
   * there would be a control that cannot succeed, and the honest alternative is
   * to say so and offer the download instead.
   */
  retryable: boolean
}

interface ActiveRecorder {
  sessionId: string
  label: string
  host: string
  targetRef: string | null
  deviceId: string | null
  buffer: CastBuffer
  /** performance.now() when recording began; event timestamps are offsets. */
  clockBase: number
  /**
   * performance.now() when capture ended. Held rather than recomputed at save
   * time: a save that fails and is retried ten minutes later must not report a
   * recording ten minutes longer than the one it is storing.
   */
  endedAt: number | null
  untap: () => void
  ended: EndReason | null
  saving: boolean
  error: string | null
  retryable: boolean
}

const recorders = new Map<string, ActiveRecorder>()
const stateListeners = new Set<() => void>()
const savedListeners = new Set<(summary: RecordingSummary) => void>()

/**
 * useSyncExternalStore compares snapshots by identity, so the array is rebuilt
 * only when something actually changed and handed out unchanged otherwise.
 */
let snapshot: RecorderState[] = []

function rebuild() {
  snapshot = [...recorders.values()].map((r) => ({
    sessionId: r.sessionId,
    label: r.label,
    startedAt: r.buffer.startedAt,
    bytes: r.buffer.bytes,
    capturing: r.ended === null,
    ended: r.ended,
    saving: r.saving,
    error: r.error,
    retryable: r.retryable,
  }))
  for (const fn of stateListeners) fn()
}

/**
 * Byte counts move on every keystroke's echo, and re-rendering the sidebar and
 * the recordings page at that rate to animate a progress bar is not a trade
 * worth making. State transitions publish immediately; a growing byte count
 * publishes at most a few times a second.
 */
const PROGRESS_PUBLISH_MS = 400
let lastProgressPublish = 0

function publishProgress() {
  const now = Date.now()
  if (now - lastProgressPublish < PROGRESS_PUBLISH_MS) return
  lastProgressPublish = now
  rebuild()
}

function subscribeState(fn: () => void) {
  stateListeners.add(fn)
  return () => {
    stateListeners.delete(fn)
  }
}

/** Live recorder state, for anything that shows a recording indicator. */
export function useRecorders(): RecorderState[] {
  return useSyncExternalStore(
    subscribeState,
    () => snapshot,
    // Server render: recording happens in a tab, so there is never one here.
    () => EMPTY,
  )
}

const EMPTY: RecorderState[] = []

/**
 * Fires when a recording has been stored. The recordings page uses it to add the
 * row without re-fetching. Saying so out loud is not its job: `persist` toasts
 * the outcome itself, so that a recording which ended on its own while the user
 * was on another route is still reported.
 */
export function subscribeSaved(fn: (summary: RecordingSummary) => void): () => void {
  savedListeners.add(fn)
  return () => {
    savedListeners.delete(fn)
  }
}

export function isRecording(sessionId: string): boolean {
  const r = recorders.get(sessionId)
  return r !== undefined && r.ended === null
}

export interface StartRecordingRequest {
  sessionId: string
  /** Shown in the UI and written into the header, inside the ciphertext. */
  label: string
  /** "user@host:port". Also inside the ciphertext, never in a column. */
  host: string
  /** HMAC(auditKey, host|port), or null when this tab has no audit key. */
  targetRef: string | null
  deviceId: string | null
  /** The session's current geometry, from the provider's last resize. */
  cols: number
  rows: number
  /** The provider's tapSession, already bound to this session id. */
  tap: (fn: (e: SessionTapEvent) => void) => () => void
}

/**
 * Starts recording. Throws rather than returning a failure, because every
 * reason it can fail is a programming error or a locked vault, and the caller
 * must say which out loud rather than leaving a button that does nothing.
 */
export function startRecording(req: StartRecordingRequest): void {
  if (recorders.has(req.sessionId)) {
    throw new Error("That session is already being recorded.")
  }
  if (!getVaultKey()) {
    // Checked here as well as in the UI: a recording that cannot be encrypted
    // has nowhere to go, and finding that out at the end would mean discovering
    // it after capturing an hour of someone's work.
    throw new Error("The vault is locked, so a recording could not be encrypted.")
  }
  if (!canRecordNow()) {
    // The same argument one step further along: the server would refuse the save
    // with a 402, and refusing at the start is the difference between an
    // explanation and an hour of captured work with nowhere to go.
    throw new Error(
      "Saving a session recording is a Pro feature, and this account is on Free. Recordings " +
        "already saved can still be played and downloaded.",
    )
  }

  const buffer = new CastBuffer(req.cols, req.rows)
  const recorder: ActiveRecorder = {
    sessionId: req.sessionId,
    label: req.label,
    host: req.host,
    targetRef: req.targetRef,
    deviceId: req.deviceId,
    buffer,
    // performance.now() rather than Date.now(): the timeline has to survive an
    // NTP correction or a laptop waking up with a different idea of the time.
    clockBase: performance.now(),
    endedAt: null,
    untap: () => {},
    ended: null,
    saving: false,
    error: null,
    retryable: true,
  }

  recorder.untap = req.tap((event) => {
    if (recorder.ended !== null) return
    const at = performance.now() - recorder.clockBase

    if (event.kind === "output") {
      const kept = recorder.buffer.output(at, event.bytes)
      if (!kept && recorder.buffer.isFull) {
        end(recorder, "cap")
        return
      }
      publishProgress()
      return
    }

    if (event.kind === "resize") {
      recorder.buffer.resize(at, event.cols, event.rows)
      return
    }

    end(recorder, "session-closed")
  })

  recorders.set(req.sessionId, recorder)
  rebuild()
}

/** Stops capture and stores what was captured. */
export async function stopRecording(sessionId: string): Promise<void> {
  const recorder = recorders.get(sessionId)
  if (!recorder) return
  if (recorder.ended === null) end(recorder, "user")
  await persist(recorder)
}

/** Retries a save that failed — a vault that locked, a network that dropped. */
export async function retrySave(sessionId: string): Promise<void> {
  const recorder = recorders.get(sessionId)
  if (!recorder || recorder.ended === null || recorder.saving) return
  await persist(recorder)
}

/**
 * The transcript a recorder is holding, so an unsaved one can leave this tab as
 * a file.
 *
 * Added because of the plan gate. A save refused for a locked vault or a dead
 * network is worth retrying, and the UI offers that; a save refused because the
 * account is on Free is not going to succeed however many times it is pressed,
 * and the only honest offer left is "take the file". Without this, the choice
 * presented to somebody who had just recorded an hour of work would be a button
 * that cannot work and a button that destroys it.
 *
 * It returns the cast for any recorder that has stopped capturing, not only a
 * failed one — the same offer is useful for a save that is merely slow, and a
 * capability that exists only on the unhappy path is one nobody finds.
 *
 * Null while capture is still running: a duration is only correct once the
 * recording has ended, and a file claiming to be a complete transcript of a
 * session that is still going would be wrong about the one thing it asserts.
 */
export function castFor(sessionId: string): Cast | null {
  const recorder = recorders.get(sessionId)
  if (!recorder || recorder.ended === null || recorder.endedAt === null) return null
  return recorder.buffer.toCast({
    durationMs: recorder.endedAt - recorder.clockBase,
    label: recorder.label,
    host: recorder.host,
  })
}

/** Throws away an unsaved recording. Nothing was on the server to remove. */
export function discardRecording(sessionId: string): void {
  const recorder = recorders.get(sessionId)
  if (!recorder) return
  recorder.untap()
  recorders.delete(sessionId)
  rebuild()
}

/**
 * Ends capture and kicks off the save.
 *
 * Auto-stops save themselves rather than waiting to be asked. The two of them —
 * the cap and a closed session — are exactly the cases where nobody is looking
 * at this tab, and a recording that sat unsaved until someone noticed would be
 * lost to the next reload.
 */
function end(recorder: ActiveRecorder, reason: EndReason) {
  if (recorder.ended !== null) return
  recorder.ended = reason
  recorder.endedAt = performance.now()
  recorder.untap()
  rebuild()
  if (reason !== "user") void persist(recorder)
}

/**
 * Says what happened to a recording, from wherever the user happens to be.
 *
 * Announced here rather than on the recordings page because most of these
 * outcomes arrive without anybody asking for them, and the page that knows how
 * to explain them is usually not the page on screen. The failure toast offers no
 * button: the recording is in this tab's memory, so anything that reloads the
 * document — including a link followed as a full navigation — destroys the thing
 * it is offering to rescue. It says where to go and leaves the going to the user.
 */
function announceFailure(recorder: ActiveRecorder) {
  toast.error(`Recording of ${recorder.label} was not saved`, {
    description:
      `${recorder.error ?? "The save failed."} ` +
      (recorder.retryable
        ? "Open Recordings to retry or discard it — do not reload this tab first."
        : // Retrying a plan refusal cannot work, so the advice is different: the
          // transcript is still here and can be downloaded as a file, which is
          // the only thing that survives this tab.
          "Retrying will not help until the plan changes. Open Recordings to download it as a " +
          "file or discard it — do not reload this tab first, or it is gone."),
    duration: 15000,
  })
}

async function persist(recorder: ActiveRecorder) {
  if (recorder.saving) return

  const vaultKey = getVaultKey()
  if (!vaultKey) {
    recorder.error =
      "The vault locked before this recording could be encrypted. It is still here, in this tab only — unlock and save it, or a reload will lose it."
    recorder.retryable = true
    rebuild()
    announceFailure(recorder)
    return
  }

  recorder.saving = true
  recorder.error = null
  recorder.retryable = true
  rebuild()

  const cast = recorder.buffer.toCast({
    durationMs: (recorder.endedAt ?? performance.now()) - recorder.clockBase,
    label: recorder.label,
    host: recorder.host,
  })

  try {
    const summary = await saveRecording(vaultKey, {
      cast,
      targetRef: recorder.targetRef,
      deviceId: recorder.deviceId,
    })
    recorders.delete(recorder.sessionId)
    rebuild()
    for (const fn of savedListeners) fn(summary)
    toast.success(`Recording of ${recorder.label} saved`, {
      description: `${formatBytes(summary.sizeBytes)} of ciphertext stored. It is on the Recordings page.`,
    })
  } catch (error) {
    recorder.saving = false
    recorder.error = error instanceof Error ? error.message : String(error)
    // A plan refusal is the one failure a retry cannot get past. Everything else
    // — a locked vault, a dropped connection, a full account — is a state that
    // can change while the transcript sits here.
    recorder.retryable = !(error instanceof RecordingRequestError && error.kind === "plan")
    rebuild()
    announceFailure(recorder)
  }
}
