/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    domains: [],
    // Allow local static images
  },
  // Allow embedding as iframe
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-Frame-Options",
            value: "ALLOWALL",
          },
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
