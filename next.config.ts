/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  allowedDevOrigins: ['100.86.7.30', 'localhost', '127.0.0.1'],
};

module.exports = nextConfig;
