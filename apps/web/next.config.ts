import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    /**
     * Subresource Integrity.
     *
     * docs/THREAT-MODEL.md §9.1 names "we serve the JavaScript" as the largest
     * residual risk, and the security page tells users we run integrity checks
     * on what we load. This is what makes that true: Next hashes each script at
     * build time and emits an `integrity` attribute, so a bundle altered in
     * transit — by a compromised CDN or an intercepting proxy — is refused by
     * the browser rather than executed.
     *
     * It does not defend against a compromised build, because we would sign
     * that too. Only self-hosting removes that, which is what the page says.
     */
    sri: { algorithm: "sha384" },
  },
};

export default nextConfig;
