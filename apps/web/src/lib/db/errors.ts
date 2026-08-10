/**
 * What is safe to write to a log when a query fails.
 *
 * `console.warn("...", e)` is the obvious thing to write and it is wrong here.
 * drizzle wraps every query failure in a `DrizzleQueryError` whose message is
 * literally `Failed query: <sql>\nparams: <params>` — so logging the error
 * object writes the SQL and every bound parameter into the log aggregator. On
 * the billing and relay paths those parameters are user ids, which is precisely
 * the thing the comments at those call sites promise is not being logged.
 *
 * What this returns instead is the error's class name and, when the driver
 * supplied one, its short code — a Postgres SQLSTATE like `57014`, or a socket
 * error like `ECONNREFUSED`. Those are the two facts that are actually useful at
 * three in the morning, and neither carries a value from a row or a query. The
 * code is not labelled as one or the other because the two arrive by the same
 * field and telling them apart would mean guessing.
 *
 * What is NOT solved: this is a convention, not an enforcement. Nothing stops
 * the next `console.error(e)`, and there is no logger wrapper doing redaction
 * centrally. Two call sites use it today, which is all the ones that log a
 * database failure.
 *
 * It deliberately imports nothing, so a module can describe a failure without
 * pulling a connection pool behind it.
 */
export function dbErrorSummary(e: unknown): string {
  if (!(e instanceof Error)) return "unknown error"
  const code = errorCode(e)
  return code ? `${e.name} (${code})` : e.name
}

/** The driver's error code, if it put one on the error or on its cause. */
function errorCode(e: Error): string | null {
  const direct = (e as { code?: unknown }).code
  if (typeof direct === "string" && direct !== "") return direct

  const cause = (e as { cause?: unknown }).cause
  if (typeof cause === "object" && cause !== null) {
    const nested = (cause as { code?: unknown }).code
    if (typeof nested === "string" && nested !== "") return nested
  }
  return null
}
