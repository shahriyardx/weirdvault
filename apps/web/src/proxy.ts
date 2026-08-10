import { NextResponse, type NextRequest } from "next/server"

/**
 * Security headers, chiefly the Content-Security-Policy.
 *
 * docs/THREAT-MODEL.md §3 names our own JavaScript as the largest residual
 * risk: we serve it, so a compromised build could exfiltrate the vault key or
 * abuse the signing oracle no matter how non-extractable the keys are. A strict
 * CSP is the stated mitigation, and a threat model that prescribes a control
 * nobody implemented is worse than one that never mentioned it.
 *
 * Next.js 16 renamed `middleware` to `proxy`; the named export must match.
 */

const RELAY_ORIGIN = (() => {
  const url = process.env.NEXT_PUBLIC_RELAY_URL
  if (!url) return ""
  try {
    // connect-src needs an origin, not the full ws:// path.
    return new URL(url).origin
  } catch {
    return ""
  }
})()

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64")
  const isDev = process.env.NODE_ENV === "development"

  const csp = [
    `default-src 'self'`,

    // 'wasm-unsafe-eval' is required: the SSH core is WebAssembly, and without
    // it instantiateStreaming is blocked outright. It permits compiling wasm,
    // not eval() of JavaScript, so script injection is still barred.
    // 'unsafe-eval' in development only — React uses eval for error stacks.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,

    // Deliberate, documented weakening: xterm.js and Monaco both inject <style>
    // elements at runtime and offer no way to nonce them. Inline *styles*
    // cannot execute code; the control that actually protects the vault key is
    // script-src, which stays strict.
    `style-src 'self' 'unsafe-inline'`,

    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,

    // The relay is a separate deployment, so it must be named explicitly —
    // 'self' does not cover it. Everything sent there is SSH ciphertext.
    `connect-src 'self'${RELAY_ORIGIN ? ` ${RELAY_ORIGIN}` : ""}${isDev ? " ws: wss:" : ""}`,

    `worker-src 'self'`,
    // Streaming downloads answer a hidden same-origin iframe from the service
    // worker; nothing third-party is ever framed.
    `frame-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join("; ")

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-nonce", nonce)
  requestHeaders.set("Content-Security-Policy", csp)

  const response = NextResponse.next({ request: { headers: requestHeaders } })

  response.headers.set("Content-Security-Policy", csp)
  response.headers.set("X-Content-Type-Options", "nosniff")
  response.headers.set("Referrer-Policy", "no-referrer")
  // No plausible use for any of these, and each is a way to reach the user.
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  )
  response.headers.set("X-Frame-Options", "DENY")
  if (!isDev) {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload",
    )
  }

  return response
}

export const config = {
  matcher: [
    // Skip static assets and the prefetch path: they need no nonce, and
    // running this on every chunk request is wasted work.
    {
      source: "/((?!_next/static|_next/image|favicon.ico|ssh.wasm|wasm_exec.js|sw.js).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
}
