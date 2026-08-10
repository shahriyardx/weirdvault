import { ImageResponse } from "next/og"

import { SITE_NAME } from "@/lib/seo"

/**
 * The card a link to this site produces in Slack, iMessage, Discord and on
 * social.
 *
 * There was no image at all, which means every share of this URL rendered as a
 * bare title and a grey box. That is a real cost for a product whose growth is
 * people sending each other a link.
 *
 * Generated rather than committed as a PNG. It is drawn from the same palette
 * and the same words as the site, so it cannot drift the way a hand-exported
 * image does — and there is no binary in the repo to rebuild when the wording
 * changes.
 *
 * Deliberately plain: no gradients that band at this size, no photograph, and
 * type large enough to survive the thumbnail Slack renders it at. The mark is
 * inlined as SVG rather than imported from components/shell/mark.tsx, because
 * this renders through Satori — which understands a subset of CSS and no React
 * component tree that relies on anything beyond it.
 */
export const alt = `${SITE_NAME} — SSH in your browser`
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default async function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        // The site's own background and foreground, so the card and the page a
        // click leads to are recognisably the same product.
        backgroundColor: "#111318",
        color: "#f5f6f7",
        padding: "80px",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
        {/* No <title>: Satori draws a title element as visible text rather
            than treating it as an accessible name, so it appeared above the
            mark in the rendered card. `alt` above is the accessible name, and
            a PNG is all that ever leaves here. */}
        {/* biome-ignore lint/a11y/noSvgWithoutTitle: rasterised to PNG; `alt` above is its accessible name */}
        <svg width="64" height="64" viewBox="0 0 32 32" fill="none">
          <rect
            x="3"
            y="4"
            width="26"
            height="24"
            rx="3"
            stroke="#7dd3a0"
            strokeWidth="2"
            fill="none"
          />
          <circle cx="16" cy="16" r="5.5" stroke="#7dd3a0" strokeWidth="2" fill="none" />
          <path d="M16 10.5v11M10.5 16h11" stroke="#7dd3a0" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em" }}>{SITE_NAME}</div>
      </div>

      <div
        style={{
          marginTop: "48px",
          fontSize: 84,
          fontWeight: 700,
          lineHeight: 1.05,
          letterSpacing: "-0.03em",
          maxWidth: "900px",
        }}
      >
        SSH from any browser.
      </div>

      <div style={{ marginTop: "24px", fontSize: 40, color: "#9aa3ad", maxWidth: "900px" }}>
        Nothing to install. Keys we cannot read.
      </div>
    </div>,
    size,
  )
}
