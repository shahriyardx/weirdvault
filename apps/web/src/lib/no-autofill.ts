/**
 * Suppressing autofill on fields that are not this account's credentials.
 *
 * This app has two completely different kinds of secret in its UI and they must
 * never be confused:
 *
 *   1. The weirdvault account password, on sign-in, unlock and password change.
 *      Autofill is CORRECT there. A password manager filling it is the manager
 *      doing its job, and these helpers must not be used on those fields.
 *
 *   2. Credentials belonging to a remote SSH server — a host's username, its
 *      password, a private key's passphrase. Autofill is WRONG there, and not
 *      merely untidy.
 *
 * The failure it prevents is specific and bad. A browser sees `type="password"`
 * on a page it has a saved login for, fills in the weirdvault account password,
 * and the user presses Connect — sending their vault-deriving password, in
 * plaintext inside the SSH channel, to someone else's server. The password that
 * derives the vault key is the one secret in this system that must never leave
 * the device, and an autofill heuristic will hand it to a third party without
 * anyone doing anything wrong.
 *
 * Why the attributes are what they are, because most of them look redundant and
 * are not:
 *
 *   - `autoComplete="off"` DOES NOT WORK on password fields. Chrome and Safari
 *     deliberately ignore it there, because sites used it to break password
 *     managers. The only value they honour is `new-password`, which tells the
 *     browser this is a field to *generate* into rather than fill from. That is
 *     not what these fields are, but it is the one lever that stops the fill,
 *     so it is the lever used.
 *   - `data-1p-ignore`, `data-lpignore`, `data-bwignore`, `data-form-type` are
 *     the opt-outs published by 1Password, LastPass, Bitwarden and Dashlane.
 *     They are extensions, not the browser, and ignore the HTML attribute
 *     entirely — each needs its own.
 *   - `name` matters as much as any of it. Managers match on heuristics, and a
 *     field called `username` or `password` gets filled whatever the attributes
 *     say. Every field using these helpers gets a name that reads as a remote
 *     host's credential, not an account's.
 *
 * None of this is guaranteed. Extensions change their opt-outs, and a user can
 * always fill a field by hand from the wrong entry. It raises the floor; it is
 * not a security boundary, and nothing should be built as though it were.
 */

/** Text fields naming a remote host: username, hostname, and the like. */
export const noAutofillText = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "none",
  spellCheck: false,
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-bwignore": true,
  "data-form-type": "other",
} as const

/**
 * Secret fields belonging to a remote host: an SSH password, a key passphrase.
 *
 * `new-password` rather than `off` — see the header. The lie is deliberate and
 * it is the only thing browsers listen to.
 */
export const noAutofillSecret = {
  autoComplete: "new-password",
  autoCorrect: "off",
  autoCapitalize: "none",
  spellCheck: false,
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-bwignore": true,
  "data-form-type": "other",
} as const
