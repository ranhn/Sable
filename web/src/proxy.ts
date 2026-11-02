import { NextResponse } from "next/server";

import type { NextRequest } from "next/server";

// 应用部署在子路径下（见 next.config.mjs 的 basePath）。
// middleware 里的 `new URL("/x", request.url)` 不会自动带这个前缀，
// 必须显式拼；否则未登录跳转会落到 /login（子路径之外）→ 404。
const BASE_PATH = "/ning";

const AUTH_PAGES = ["/login", "/setup"];

/** nextUrl.pathname 含 basePath，判断路由前先剥掉前缀。 */
function stripBase(pathname: string): string {
  if (pathname === BASE_PATH) return "/";
  if (pathname.startsWith(`${BASE_PATH}/`)) return pathname.slice(BASE_PATH.length);
  return pathname;
}

/** 构造带前缀的跳转地址。 */
function toBase(path: string): string {
  return `${BASE_PATH}${path}`;
}

export function proxy(request: NextRequest) {
  // Mock mode bypasses real login and permits every page; client auth guards also allow entry.
  if (process.env.NEXT_PUBLIC_MOCK === "1") return NextResponse.next();

  const pathname = stripBase(request.nextUrl.pathname);
  const token = request.cookies.get("artex_token")?.value;
  const isAuthPage = AUTH_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  // Unauthenticated users redirect to login.
  if (!token && !isAuthPage) {
    return NextResponse.redirect(new URL(toBase("/login"), request.url));
  }

  // Authenticated users visiting login/setup redirect to the app.
  if (token && isAuthPage) {
    return NextResponse.redirect(new URL(toBase("/function/tasks"), request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Skip Next internals, API routes, favicon, and public static files such as images and fonts.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|api/|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf)$).*)"],
};
