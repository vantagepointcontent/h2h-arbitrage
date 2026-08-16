/** @type {import('next').NextConfig} */
const nextConfig = {
  // OPS-158: direct builds use a process-scoped path, never production.
  // The release manager overrides this inside an isolated detached worktree;
  // production points it at the atomically switched active release.
  distDir: process.env.H2H_NEXT_DIST_DIR ?? `.builds/next-${process.pid}`,
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  allowedDevOrigins: ['100.86.7.30', 'localhost', '127.0.0.1'],
  // The app shell references content-hashed JS/CSS chunks. Never let a browser
  // keep its HTML shell across a deployment, or it will request chunks removed
  // by the next build and render without CSS (stale-chunk 404s).
  async headers() {
    return [
      {
        source: '/',
        headers: [
          { key: 'Cache-Control', value: 'no-store, max-age=0, must-revalidate' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;