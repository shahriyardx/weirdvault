"use client";

/**
 * Changing the password, which means re-keying everything.
 *
 * The password is not a credential here, it is the root of a key tree. Argon2id
 * stretches it once and HKDF splits the result three ways — an auth token the
 * server checks, a vault key that encrypts the document, and an audit key that
 * blinds hostnames. Changing the password changes all three at once. There is no
 * version of this that only changes the login.
 *
 * ---------------------------------------------------------------------------
 * Two ways in, one implementation
 *
 * changePasswordAndRekey takes the current password and derives the old branches
 * from it. rekeyAfterRecovery takes the branches themselves, because the user
 * arrived here from a redeemed recovery code and by definition has no password
 * to type — the envelope carried the old vault key and the old auth token, which
 * is everything the run below needs. Both funnel into the same private rekey(),
 * so the recovery path cannot become a second, weaker password change: it does
 * the same resume detection, the same re-wrapping, the same ordering, and the
 * same deletion of the remaining recovery envelopes at the end. That last step
 * is the reason the recovery flow has to reach this file at all — until the
 * password changes, every unspent code still opens the account.
 *
 * ---------------------------------------------------------------------------
 * The failure mode that makes this dangerous
 *
 * Re-encrypting the vault document is not enough, and getting this wrong is the
 * difference between a password change and a key-destroying event. Portable SSH
 * keys are *not* protected by the document's encryption alone: each one carries
 * its own AES-GCM wrapping of the private PKCS#8, produced with the vault key at
 * generation or import time (lib/keys.ts, StoredKey.wrapped) and stored that way
 * both inside the synced document and in this browser's IndexedDB. Decrypt the
 * document under the old key, re-encrypt it under the new one, and every one of
 * those inner wrappings is still sealed to the old key. The user would sign in
 * with the new password, see their whole host list, and be unable to connect to
 * any of it — with no error, because listKeys() treats an unwrappable key as one
 * it simply cannot hydrate.
 *
 * So every portable key is unwrapped with the old key and re-wrapped with the
 * new one, individually, before anything is committed. A key that refuses to
 * unwrap is kept as-is and counted rather than dropped: it was already broken
 * before this ran, and deleting the ciphertext would destroy the only copy.
 *
 * Device-bound keys need nothing and get nothing. They are non-extractable
 * CryptoKey handles sitting in this browser's IndexedDB, never wrapped with the
 * vault key and never synced, so the vault key changing is not an event they can
 * observe. The same is true in the other direction: they do not travel to the
 * user's other devices after a password change any more than they did before.
 *
 * ---------------------------------------------------------------------------
 * What is destroyed on purpose, and cannot be avoided
 *
 * The audit key changes too. Every audit row already written carries a targetRef
 * that is an HMAC of a hostname under the *old* audit key, and the activity page
 * resolves those by re-blinding the user's known hosts and matching. After the
 * change, none of them match: the old rows become permanently opaque hosts. This
 * is inherent to deriving the blinding key from the password, and it is not
 * fixable in this file — the alternative would be storing the audit key
 * somewhere the server could reach, which is the whole thing we refuse to do.
 * The UI says so before the user commits.
 *
 * Recovery codes die too, and less subtly: each envelope wraps the *old* branch
 * bytes, so after the change every code decrypts to material that opens nothing
 * and signs in as nobody. Codes that silently stopped working would be worse
 * than none, so the enrolled set is deleted at the end of a successful change
 * and the user is told to enrol again.
 *
 * ---------------------------------------------------------------------------
 * Ordering, and the fact that there is no transaction
 *
 * The vault blob lives in our database behind /api/vault; the credential lives
 * in Better Auth behind /change-password. Two writes, no shared transaction, and
 * a network in between. Something can land between them, so the order is chosen
 * by asking which half-done state is survivable:
 *
 *   blob first, then credential — the vault ends up under a key the old password
 *     no longer derives, while the old password still signs in. Bad, but the
 *     user can still authenticate, and this file can *detect* the state and
 *     finish the job (see below).
 *
 *   credential first, then blob — the new password signs in and derives a key
 *     that does not open the vault, and the old password no longer signs in at
 *     all. There is no session from which to repair it. That is an unrecoverable
 *     lockout produced by a dropped connection.
 *
 * So: derive both key sets, pull, decrypt, re-wrap, re-encrypt — all in memory,
 * nothing committed — then push the blob with baseVersion (a concurrent write
 * from another device is a 409 and aborts before anything irreversible), then
 * change the auth token, then install the new keys locally.
 *
 * The mid-flight recovery path is the reason the first ordering is survivable.
 * On entry this function tries the old key against the pulled blob and, if that
 * fails, tries the *new* one. A blob that opens under the new key is the
 * signature of a previous attempt that pushed and then failed to change the
 * credential: the re-encryption is already done, so it is skipped and the run
 * goes straight to the credential change. Running the same change again with the
 * same two passwords is therefore the documented repair, and it is what the
 * error thrown at that point tells the user to do.
 *
 * revokeOtherSessions is set on the credential change because every other signed
 * -in tab is holding the *old* vault key in memory and would keep writing
 * documents encrypted under it. Ending those sessions forces each device to
 * re-derive from the new password.
 */

import { authClient } from "@/lib/auth-client";
import { putStoredKey, type StoredKey } from "@/lib/keys";

import { decryptVault, encryptVault, fromB64, toB64, type VaultEnvelope } from "./crypto";
import { deriveSecrets, type DerivedSecrets } from "./kdf";
import { clearRecoveredSecrets, setVaultKey } from "./session";
import { syncVault, type SyncedKey, type VaultDocument } from "./sync";

/* ------------------------------------------------------------------ errors */

/**
 * The old key does not open the vault.
 *
 * Thrown before any write. AES-GCM authenticates, so this is a proof rather than
 * a guess — with one gap named in the message: an account whose vault has never
 * been pushed has no ciphertext to test against, and the check falls through to
 * the server's own verification of the auth token.
 *
 * The two entry points reach this for different reasons and a single message
 * would be wrong for one of them: on the password path the user mistyped, and on
 * the recovery path the code they redeemed seals key material this vault was not
 * encrypted with — nothing was mistyped and telling them otherwise would send
 * them looking for a typo that does not exist.
 */
export class WrongCurrentPasswordError extends Error {
  constructor(via: "password" | "recovery-code" = "password") {
    super(
      via === "password"
        ? "That current password does not open this vault. Nothing was changed."
        : "The keys sealed in that recovery code do not open this vault, so it cannot be re-keyed from them. Nothing was changed. This happens when the password was changed after those codes were generated.",
    );
    this.name = "WrongCurrentPasswordError";
  }
}

/** Another device wrote to the vault while this was being prepared. */
export class VaultConflictError extends Error {
  constructor() {
    super(
      "Another device saved to your vault while this was being prepared, so nothing was changed. Try again — the second attempt starts from the newer vault.",
    );
    this.name = "VaultConflictError";
  }
}

/**
 * The one genuinely bad outcome: the blob was re-encrypted and the credential
 * change then failed.
 *
 * Not swallowed, not softened. The account is in a state the user has to act on,
 * and the message is the instruction, not an apology.
 */
export class RekeyStrandedError extends Error {
  constructor(readonly cause: unknown) {
    super(
      "Your vault was re-encrypted under the new password, but the password itself could not be changed. " +
        "Your account still uses the OLD password to sign in, and the vault will not open until this is finished. " +
        "Do not change anything else: sign in with the old password and run this same change again, with the same new password. " +
        "It will detect the half-finished state and complete it.",
    );
    this.name = "RekeyStrandedError";
  }
}

/* ---------------------------------------------------------------- progress */

export type RekeyStage =
  | "syncing"
  | "deriving"
  | "reading"
  | "rewrapping"
  | "pushing"
  | "changing"
  | "installing"
  | "done";

export interface RekeyProgress {
  stage: RekeyStage;
  /** Written for a person: this runs for several seconds and needs narrating. */
  label: string;
}

const LABELS: Record<RekeyStage, string> = {
  syncing: "Syncing the vault so nothing is left behind",
  deriving: "Stretching both passwords with Argon2id",
  reading: "Reading and decrypting the vault",
  rewrapping: "Re-wrapping portable SSH keys under the new key",
  pushing: "Uploading the re-encrypted vault",
  changing: "Changing the password on the server",
  installing: "Installing the new keys on this device",
  done: "Done",
};

export interface RekeyResult {
  /** Vault version the re-encrypted document was written as, or null if resumed. */
  version: number | null;
  /** Portable keys successfully unwrapped and re-wrapped. */
  keysRewrapped: number;
  /**
   * Portable keys that would not unwrap under the old key and were left exactly
   * as they were. Non-zero means those keys were already unusable; the change
   * did not break them and did not fix them.
   */
  keysUnreadable: number;
  /** True when a previous half-finished attempt was detected and completed. */
  resumed: boolean;
  /** Whether the now-dead recovery envelopes were removed. */
  recoveryCleared: boolean;
  /** Why removal failed, when it did. The codes are dead either way. */
  recoveryError?: string;
}

/* -------------------------------------------------------------- re-wrapping */

/**
 * One portable key, moved from the old vault key to the new one.
 *
 * Returns null when the ciphertext will not open — a key wrapped under some
 * older password, or corrupted. The caller keeps the original in that case; see
 * the file header on why deleting it would be worse.
 */
async function rewrapKey(
  key: SyncedKey,
  oldKey: CryptoKey,
  newKey: CryptoKey,
): Promise<SyncedKey | null> {
  let pkcs8: Uint8Array;
  try {
    pkcs8 = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64(key.wrapped.iv) as BufferSource },
        oldKey,
        fromB64(key.wrapped.ciphertext) as BufferSource,
      ),
    );
  } catch {
    return null;
  }

  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      newKey,
      pkcs8 as BufferSource,
    );
    return {
      ...key,
      wrapped: { iv: toB64(iv), ciphertext: toB64(new Uint8Array(ciphertext)) },
    };
  } finally {
    // The private key exists as readable bytes for exactly this long, which is
    // the same window lib/keys.ts allows itself at generation time.
    pkcs8.fill(0);
  }
}

/** The IndexedDB record shape, rebuilt from a re-wrapped synced key. */
function toStoredKey(key: SyncedKey): StoredKey {
  const buffer = (s: string): ArrayBuffer => fromB64(s).buffer as ArrayBuffer;
  return {
    id: key.id,
    label: key.label,
    mode: "portable",
    publicKeyRaw: buffer(key.publicKeyRaw),
    wrapped: { iv: buffer(key.wrapped.iv), ciphertext: buffer(key.wrapped.ciphertext) },
    createdAt: key.createdAt,
  };
}

/* ------------------------------------------------------------------ the run */

export interface RekeyOptions {
  email: string;
  currentPassword: string;
  newPassword: string;
  onProgress?: (p: RekeyProgress) => void;
}

export async function changePasswordAndRekey({
  email,
  currentPassword,
  newPassword,
  onProgress,
}: RekeyOptions): Promise<RekeyResult> {
  if (currentPassword === newPassword) {
    throw new Error("The new password is the same as the current one.");
  }

  onProgress?.({ stage: "deriving", label: LABELS.deriving });
  // Both stretches run together. Argon2id is memory-hard rather than
  // parallelism-hard here (parallelism: 1), so this is two sequential seconds
  // dressed as one await; it is still the single longest step and the caller is
  // showing progress for it.
  const [oldSecrets, newSecrets] = await Promise.all([
    deriveSecrets(email, currentPassword),
    deriveSecrets(email, newPassword),
  ]);

  return rekey(oldSecrets, newSecrets, "password", onProgress);
}

export interface RecoveredRekeyOptions {
  email: string;
  /** Straight out of redeemRecoveryCode, by way of the in-memory vault session. */
  oldSecrets: DerivedSecrets;
  newPassword: string;
  onProgress?: (p: RekeyProgress) => void;
}

/**
 * The same re-key, driven by a redeemed recovery code instead of a typed
 * password.
 *
 * This is not a convenience. Without it the recovery flow has no ending: the
 * only re-key entry point took `currentPassword`, derived the old branches from
 * it, and the whole premise of a recovery code is that there is no password to
 * type. Redemption already produced exactly what the re-key needs — the old
 * vault key that decrypts the document and unwraps every portable key, and the
 * old auth token that Better Auth checks as `currentPassword` — so the old side
 * is taken as a parameter here rather than re-derived.
 *
 * Nothing else differs, deliberately. The ordering, the resume detection, the
 * re-wrapping and the recovery-envelope deletion at the end are the same code
 * below, so the recovery path cannot drift into a second, subtly weaker version
 * of a password change. The envelope deletion matters more here than usual: the
 * remaining codes are what a stranger who has one of them can still get in with,
 * and this is the step that retires them.
 */
export async function rekeyAfterRecovery({
  email,
  oldSecrets,
  newPassword,
  onProgress,
}: RecoveredRekeyOptions): Promise<RekeyResult> {
  onProgress?.({ stage: "deriving", label: LABELS.deriving });
  const newSecrets = await deriveSecrets(email, newPassword);

  // A new password that happens to derive the same token as the recovered one is
  // the old password typed back in. The change would be a no-op on the server
  // and would leave the recovery codes valid, so it is refused rather than
  // reported as a success.
  if (newSecrets.authToken === oldSecrets.authToken) {
    throw new Error(
      "That is the password this account already uses, so nothing would change. Choose a different one.",
    );
  }

  return rekey(oldSecrets, newSecrets, "recovery-code", onProgress);
}

async function rekey(
  oldSecrets: DerivedSecrets,
  newSecrets: DerivedSecrets,
  via: "password" | "recovery-code",
  onProgress?: (p: RekeyProgress) => void,
): Promise<RekeyResult> {
  const report = (stage: RekeyStage) => onProgress?.({ stage, label: LABELS[stage] });

  // Which key opens the stored blob answers two questions at once: whether the
  // old key is really this vault's key, and whether a previous attempt already
  // did the re-encryption and died before changing the credential.
  report("reading");
  let pulled = await pullVault();
  let document: VaultDocument | null = null;
  let resumed = false;

  if (pulled.envelope) {
    document = await tryDecrypt(oldSecrets.vaultKey, pulled.envelope);
    if (!document) {
      document = await tryDecrypt(newSecrets.vaultKey, pulled.envelope);
      if (!document) throw new WrongCurrentPasswordError(via);
      resumed = true;
    }
  }

  let keysRewrapped = 0;
  let keysUnreadable = 0;
  let version: number | null = null;

  if (!resumed) {
    // Push whatever this device is holding before re-keying anything. Without
    // it a host added or a portable key imported here but never synced would be
    // absent from the document that gets re-encrypted, and would later be
    // pushed up still wrapped under the dead key.
    //
    // This only reaches *this* device, and that limit is real rather than
    // theoretical. A portable key generated on another browser whose push has
    // not landed yet is in nobody's document, so nothing here can re-wrap it,
    // and when that browser eventually syncs it would introduce a key sealed to
    // a vault key that no longer exists. The defence is at the other end:
    // syncVault refuses to publish a key it cannot open with the current vault
    // key and reports it, so the damage stays on the one device that has it and
    // the keys page can say the key is unusable instead of listing it as
    // healthy. See SyncResult.keysWithheld.
    //
    // Deliberately skipped on the resume path: the stored blob is already under
    // the new key there, and syncVault would decrypt it with the old one and
    // fail. Local changes made in that window are not lost, they are pushed by
    // the first ordinary sync after the new key is installed.
    report("syncing");
    const preSync = await syncVault(oldSecrets.vaultKey);
    if (preSync.status === "offline") {
      throw new Error(
        "The server could not be reached, so the vault could not be synced first. A password change needs the network; nothing was changed.",
      );
    }

    // The sync moved the version and may have merged in another device's
    // records, so the document that gets re-encrypted has to be the one that
    // sync just wrote, not the one read before it. No progress report for this
    // second read: it is a single fast request, and moving the bar backwards to
    // announce it would read as a fault.
    pulled = await pullVault();
    document = pulled.envelope
      ? await tryDecrypt(oldSecrets.vaultKey, pulled.envelope)
      : null;
    if (pulled.envelope && !document) throw new WrongCurrentPasswordError(via);
  }

  if (document && !resumed) {
    report("rewrapping");
    const rewrapped: SyncedKey[] = [];
    for (const key of document.keys) {
      const next = await rewrapKey(key, oldSecrets.vaultKey, newSecrets.vaultKey);
      if (next) {
        rewrapped.push(next);
        keysRewrapped++;
      } else {
        rewrapped.push(key);
        keysUnreadable++;
      }
    }
    document = { ...document, keys: rewrapped };

    report("pushing");
    version = await pushVault(
      await encryptVault(newSecrets.vaultKey, document),
      pulled.version,
    );
  }

  // Everything above this line is reversible: the account still opens with the
  // old password and, if the push happened, a re-run detects and finishes it.
  report("changing");
  try {
    const res = await authClient.changePassword({
      currentPassword: oldSecrets.authToken,
      newPassword: newSecrets.authToken,
      // Other tabs hold the old vault key in memory and would keep writing
      // documents encrypted under it. They have to re-derive.
      revokeOtherSessions: true,
    });
    if (res.error) throw new Error(res.error.message ?? "the server rejected the change");
  } catch (cause) {
    // Only stranded if the blob actually moved. On a resume the blob was already
    // new before this run started, which is the same state, so both count.
    if (version !== null || resumed) throw new RekeyStrandedError(cause);
    throw cause instanceof Error ? cause : new Error(String(cause));
  }

  report("installing");
  setVaultKey(newSecrets.vaultKey, newSecrets.auditKey);
  // The recovered auth token, if this run came from a redeemed code, is now a
  // credential the server no longer accepts. Holding it any longer would be
  // keeping a dead password-equivalent secret in memory for nothing.
  clearRecoveredSecrets();

  // IndexedDB holds its own copy of every wrapping, and connecting reads from
  // there rather than from the document. Skipping this would leave the vault
  // correct on the server and every portable key unusable on this machine until
  // the next full pull happened to overwrite it.
  if (document) {
    for (const key of document.keys) await putStoredKey(toStoredKey(key));
  }

  // The enrolled recovery codes wrap the old branches and are now inert. Delete
  // rather than leave: a code that appears to exist and silently fails is a
  // worse promise than no code at all.
  let recoveryCleared = true;
  let recoveryError: string | undefined;
  try {
    const res = await fetch("/api/recovery", { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      recoveryCleared = false;
      recoveryError = `the server returned ${res.status}`;
    }
  } catch (e) {
    recoveryCleared = false;
    recoveryError = e instanceof Error ? e.message : String(e);
  }

  report("done");
  return { version, keysRewrapped, keysUnreadable, resumed, recoveryCleared, recoveryError };
}

/* ----------------------------------------------------------------- plumbing */

async function pullVault(): Promise<{ version: number; envelope: VaultEnvelope | null }> {
  const res = await fetch("/api/vault", { cache: "no-store" });
  if (res.status === 401) throw new Error("Session expired. Sign in again.");
  if (!res.ok) throw new Error(`The vault could not be read (${res.status}).`);

  const body = (await res.json()) as { version: number; blob: string | null };
  return {
    version: body.version,
    envelope: body.blob ? (JSON.parse(body.blob) as VaultEnvelope) : null,
  };
}

async function pushVault(envelope: VaultEnvelope, baseVersion: number): Promise<number> {
  const res = await fetch("/api/vault", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blob: JSON.stringify(envelope), baseVersion }),
  });
  // A 409 here is the good outcome of a race: nothing was overwritten and
  // nothing has been committed yet, so aborting costs the user one retry.
  if (res.status === 409) throw new VaultConflictError();
  if (!res.ok) throw new Error(`The re-encrypted vault was rejected (${res.status}).`);
  return ((await res.json()) as { version: number }).version;
}

/**
 * null rather than throw: which key opened it is the question being asked.
 *
 * The result is filled out to a whole document before it is returned. Vaults
 * written before snippets existed decrypt to an object with no `snippets` key,
 * and this function's callers go on to spread, iterate and re-encrypt what they
 * get back — so an absent field here would be re-encrypted as absent, and one
 * absent field this file does not think about yet would be an iteration over
 * undefined in the middle of a password change. sync.ts's pull path and
 * restore.ts both do the same thing at the same boundary; this was the third
 * reader of a stored blob and the only one that trusted it.
 */
async function tryDecrypt(
  key: CryptoKey,
  envelope: VaultEnvelope,
): Promise<VaultDocument | null> {
  try {
    const doc = await decryptVault<Partial<VaultDocument>>(key, envelope);
    return {
      hosts: doc.hosts ?? [],
      keys: doc.keys ?? [],
      hostKeys: doc.hostKeys ?? [],
      snippets: doc.snippets ?? [],
      tombstones: doc.tombstones ?? {},
      updatedAt: doc.updatedAt ?? 0,
    };
  } catch {
    return null;
  }
}
