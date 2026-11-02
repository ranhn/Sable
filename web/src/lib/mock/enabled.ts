// Mock flag is a build-time public variable; NEXT_PUBLIC_ is required for browser access.
// NEXT_PUBLIC_MOCK=1 enables a backend-free demo on Vercel.
export const MOCK = process.env.NEXT_PUBLIC_MOCK === "1";
