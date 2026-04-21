/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@slackhive/shared'],
  serverExternalPackages: ['better-sqlite3'],
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
        child_process: false,
        net: false,
        tls: false,
        dns: false,
      };
      config.resolve.alias = {
        ...config.resolve.alias,
        'better-sqlite3': false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;
