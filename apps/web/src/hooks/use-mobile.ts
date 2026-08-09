import * as React from "react"

const MOBILE_BREAKPOINT = 768

const query = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(query)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

/**
 * Whether the viewport is phone-sized.
 *
 * This reads the media query through `useSyncExternalStore` rather than
 * mirroring it into state from an effect. The effect version had a real bug on
 * top of the lint complaint: it rendered once with `undefined` (treated as
 * desktop) before the effect ran, so the sidebar mounted expanded and then
 * collapsed on a phone. Reading the store during render means the first paint
 * is already correct.
 *
 * The server snapshot is `false`. There is no viewport to measure while
 * prerendering, and a desktop-shaped first HTML is the safer of the two wrong
 * answers — hydration corrects it immediately.
 */
export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  )
}
