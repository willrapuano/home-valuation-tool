/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    domains: [],
    // Allow local static images
  },
  // Allow embedding as an iframe on agent websites.
  //
  // Note: no X-Frame-Options header is set here on purpose. There is no
  // "allow any origin" value for XFO — the header only supports DENY and
  // SAMEORIGIN, and browsers treat unrecognised values such as "ALLOWALL"
  // inconsistently (some fall back to DENY, blocking the embed entirely).
  // `frame-ancestors` is the modern replacement and takes precedence.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors *",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
