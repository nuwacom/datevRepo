/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone", // container build, not Vercel
};

module.exports = nextConfig;
