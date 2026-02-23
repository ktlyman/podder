/**
 * Podscribe authentication helper.
 *
 * Extracts and manages JWT tokens for the Podscribe API.
 * The token can be sourced from:
 *   1. PODSCRIBE_AUTH_TOKEN environment variable (takes priority)
 *   2. Chromium-based browser localStorage (Chrome, Brave, Arc on macOS)
 *
 * To get a token manually:
 *   1. Login to app.podscribe.com in Chrome
 *   2. Open DevTools → Application → Local Storage → app.podscribe.com
 *   3. Find the key containing "accessToken" under CognitoIdentityServiceProvider
 *   4. Copy the JWT value (starts with "eyJ...")
 *   5. Set: export PODSCRIBE_AUTH_TOKEN="eyJ..."
 *
 * Note: Tokens stored in browser LevelDB may become stale if the browser
 * has rotated them in memory without flushing to disk. In that case,
 * use PODSCRIBE_AUTH_TOKEN or refresh by visiting app.podscribe.com.
 *
 * Cognito config:
 *   User Pool: us-east-1_8D2CmA9sp
 *   Client ID: 7s34e93948mgl4keilef13qqqu
 */

import { execSync } from "node:child_process";

const COGNITO_USER_POOL = "us-east-1_8D2CmA9sp";

/** Result of attempting to get a JWT */
export interface AuthResult {
  token: string;
  source: "env" | "chrome";
  expiresAt: Date;
  email?: string;
  /** Cognito user ID (sub claim) — needed for the /api/episode/reset endpoint */
  userId?: string;
}

/**
 * Get a valid Podscribe JWT access token.
 * Tries environment variable first, then browser localStorage.
 * Returns null if no valid token is found.
 */
export function getPodscribeAuthToken(): AuthResult | null {
  // 1. Try environment variable
  const envToken = process.env.PODSCRIBE_AUTH_TOKEN;
  if (envToken) {
    const info = parseJwtExpiry(envToken);
    if (info && info.expiresAt.getTime() > Date.now()) {
      return { token: envToken, source: "env", ...info };
    }
    if (info && info.expiresAt.getTime() <= Date.now()) {
      console.warn(
        "[auth] PODSCRIBE_AUTH_TOKEN is expired. Trying browser extraction..."
      );
    }
  }

  // 2. Try extracting from browser localStorage (macOS only)
  if (process.platform === "darwin") {
    try {
      return extractFromBrowsers();
    } catch {
      // Browser data not accessible
    }
  }

  return null;
}

function parseJwtExpiry(
  token: string
): { expiresAt: Date; email?: string; userId?: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length < 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    const expiresAt = new Date((payload.exp ?? 0) * 1000);
    return { expiresAt, email: payload.email, userId: payload.sub };
  } catch {
    return null;
  }
}

/**
 * Search Chromium-based browsers' LevelDB for Podscribe tokens.
 * Checks Chrome (all profiles), Brave, and Arc.
 */
function extractFromBrowsers(): AuthResult | null {
  const home = process.env.HOME;
  if (!home) return null;

  // Paths to check for Chromium-based browsers on macOS
  const ldbPaths: string[] = [];

  // Chrome profiles
  for (const profile of ["Default", "Profile 1", "Profile 2", "Profile 3"]) {
    ldbPaths.push(
      `${home}/Library/Application Support/Google/Chrome/${profile}/Local Storage/leveldb/`
    );
  }

  // Brave profiles
  for (const profile of ["Default", "Profile 1"]) {
    ldbPaths.push(
      `${home}/Library/Application Support/BraveSoftware/Brave-Browser/${profile}/Local Storage/leveldb/`
    );
  }

  let bestToken: string | null = null;
  let bestExp = 0;
  let bestEmail: string | undefined;
  let bestUserId: string | undefined;

  for (const ldbPath of ldbPaths) {
    try {
      const output = execSync(
        `find "${ldbPath}" \\( -name "*.ldb" -o -name "*.log" \\) -exec strings {} \\; 2>/dev/null`,
        { maxBuffer: 50 * 1024 * 1024, timeout: 15_000 }
      ).toString();

      for (const line of output.split("\n")) {
        if (
          !line.startsWith("eyJ") ||
          line.length < 100 ||
          !line.includes(".")
        )
          continue;

        try {
          const parts = line.split(".");
          if (parts.length < 3) continue;
          const payload = JSON.parse(
            Buffer.from(parts[1], "base64url").toString()
          );

          // Must be a Podscribe Cognito access token
          if (
            payload.iss?.includes(COGNITO_USER_POOL) &&
            payload.token_use === "access"
          ) {
            const exp = payload.exp ?? 0;
            if (exp > bestExp && exp * 1000 > Date.now()) {
              bestToken = line;
              bestExp = exp;
              bestEmail = payload.email;
              bestUserId = payload.sub;
            }
          }
        } catch {
          // Not a valid JWT, skip
        }
      }
    } catch {
      // This path doesn't exist or isn't accessible
    }
  }

  if (bestToken) {
    return {
      token: bestToken,
      source: "chrome",
      expiresAt: new Date(bestExp * 1000),
      email: bestEmail,
      userId: bestUserId,
    };
  }

  return null;
}
