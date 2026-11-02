import { fileURLToPath } from "node:url";

// NEXT_EXPORT=1 next build writes a static web/out directory deployable directly to
// an nginx web root. Development omits it to retain API proxying and hot reload.
const isExport = process.env.NEXT_EXPORT === "1";
// Vercel demo uses mocks throughout, with no backend or API proxy.
const isMock = process.env.NEXT_PUBLIC_MOCK === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 部署在 /ning 子路径下：必须让 Next 自己给所有资源和路由加前缀，
  // 否则 /_next/* 会 404（根路径被别的站点占用）。
  basePath: "/sable",
  // Pin the repository root so the shared locale declaration is resolvable
  // without letting unrelated parent lockfiles affect root inference.
  turbopack: { root: fileURLToPath(new URL("..", import.meta.url)) },
  reactCompiler: true,
  // 后端 LLM 连接测试等接口可能跑到 20 秒以上（端点不可达时打满超时）。
  // Next 的 rewrite 代理默认 timeout 是 30 秒，到点会直接掐断并返回 500
  // "socket hang up"，把后端返回的真实原因（超时/403/鉴权失败）全部吃掉。
  // 放宽到 120 秒，保证后端的错误 JSON 能透传到页面。
  experimental: {
    proxyTimeout: 120_000,
  },
  // Allow development HMR resources from LAN IPs; adjust as needed.
  // Permit IPv4 origins for /_next/* and HMR in development, even as LAN addresses change.
  // Next prohibits a bare wildcard; segmented *.*.*.* matches IPv4 origins.
  allowedDevOrigins: ["*.*.*.*"],
  compiler: {
    removeConsole: process.env.NODE_ENV === "production",
  },
  ...(isExport
    ? {
        // Static export has no Node runtime or image optimization; each route emits route/index.html.
        output: "export",
        images: { unoptimized: true },
        trailingSlash: true,
      }
    : isMock
      ? {
          // Vercel mock demo needs no backend or API proxy.
          images: { unoptimized: true },
        }
      : {
          // Development proxies /api/* to Go, default :8787, overridable with AUTOPENTEST_API.
          async rewrites() {
            const backend = process.env.AUTOPENTEST_API ?? "http://localhost:8787";
            return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
          },
        }),
};

export default nextConfig;
