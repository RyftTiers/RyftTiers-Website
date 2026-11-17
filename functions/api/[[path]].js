// Cloudflare Pages Function: serves every /api/* request with the RyftTiers
// Public API. All the logic lives in server/api.mjs (see API.md for docs).
import { handleRequest } from "../../server/api.mjs";

export async function onRequest(context) {
  return handleRequest(context.request, context.env, {
    cache: caches.default,
    waitUntil: (p) => context.waitUntil(p),
  });
}
