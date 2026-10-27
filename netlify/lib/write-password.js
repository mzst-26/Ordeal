// Checks the admin password that guards the prune and clear actions. Visitors never type it. The password lives in the WRITE_PASSWORD
// environment variable, set in the Netlify dashboard, and is never written into the code. A request must send it
// as "Authorization: Bearer <password>". The comparison is made in constant time, so a caller cannot learn the
// password one character at a time from how long the check takes.

import { createHash, timingSafeEqual } from "node:crypto";

const BEARER_SCHEME = "bearer";

/**
 * Return the password from an Authorization header, or null when the header is not a Bearer header with a value.
 * The scheme word is not case sensitive, as the HTTP standard says.
 */
export function readBearerToken(headerValue) {
  if (typeof headerValue !== "string") return null;
  const parts = headerValue.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== BEARER_SCHEME) return null;
  return parts[1];
}

/**
 * Return true only when the header carries the expected password. When no password is configured (expected is
 * missing or empty), this always returns false, so an unconfigured site refuses every write.
 */
export function passwordMatches(headerValue, expected) {
  if (typeof expected !== "string" || expected === "") return false;
  const sent = readBearerToken(headerValue);
  if (sent === null) return false;
  return sameSecret(sent, expected);
}

/**
 * Compare two secrets in constant time. Each is hashed first, so both digests have the same length and the
 * comparison never stops early at a length difference.
 */
function sameSecret(sent, expected) {
  const sentDigest = createHash("sha256").update(sent).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(sentDigest, expectedDigest);
}
