/**
 * What is being dragged between two file panes.
 *
 * Both panes live in the same tab, so the payload is held here in a module
 * rather than serialised into the DataTransfer. That is not laziness — a drag
 * carries entries by reference to a live session, and a JSON round trip would
 * turn them into strings that have to be resolved back to sessions on the other
 * side, with a window in which the session has closed and the ids mean nothing.
 *
 * The DataTransfer still gets a marker, because `dataTransfer.types` is the only
 * thing readable during `dragover`, and dragover is where a pane has to decide
 * whether to show "copy from web-01" or "upload from this computer". Reading
 * `getData` there is deliberately blocked by the browser — the protection is
 * against a page snooping the contents of a drag it is not the target of — so a
 * type name is all there is to go on. Its presence means "this drag started in
 * one of our panes"; the module below says which one and what it holds.
 */

import type { SftpEntry } from "@/lib/ssh/types";

/**
 * Marker type on the DataTransfer. Vendor-prefixed and lowercase: the drag and
 * drop spec lowercases type strings, so a mixed-case name silently never
 * matches on the receiving end.
 */
export const REMOTE_DRAG_TYPE = "application/x-webxterm-remote-files";

export interface RemoteDrag {
  /** Which pane started it, so a pane can refuse a drop onto itself. */
  paneId: string;
  /** The session the entries live on. */
  sessionId: string;
  /** Directory the entries were listed from. */
  cwd: string;
  entries: SftpEntry[];
}

let active: RemoteDrag | null = null;

export function beginRemoteDrag(drag: RemoteDrag): void {
  active = drag;
}

/**
 * What is currently being dragged, if anything.
 *
 * Readable during dragover as well as drop, which is the whole point: the drop
 * indicator names the source host and the number of items, and neither is
 * available from the DataTransfer until it is too late to render them.
 */
export function currentRemoteDrag(): RemoteDrag | null {
  return active;
}

/**
 * Cleared on dragend, which fires on the source element for every outcome —
 * dropped, cancelled with Escape, or released over nothing. Relying on drop
 * alone would leave a stale payload behind after every abandoned drag, and the
 * next dragover would offer to copy files the user is no longer holding.
 */
export function endRemoteDrag(): void {
  active = null;
}
