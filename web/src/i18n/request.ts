// Locale-aware API transport. Authentication and other caller headers survive.
import { localeHeaders, localizedUrl } from "./runtime.ts";

export function localizedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  const url = typeof input === "string" ? localizedUrl(input) : input instanceof URL ? new URL(localizedUrl(input.toString())) : input;
  return globalThis.fetch(url, { ...init, headers: localeHeaders(headers) });
}
