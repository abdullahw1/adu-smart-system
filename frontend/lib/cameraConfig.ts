// Server-only. Where each camera lives and how to log in to it, for the
// settings page. Same variables go2rtc uses (repo-root .env), so a camera's
// IP is only ever written down once: cam_01 -> CAM01_HOST, plus the shared
// CAM_USER / CAM_PASSWORD.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Credentials } from "@/lib/onvif";

const ROOT_ENV = path.join(process.cwd(), "..", ".env");

export function cameraCredentials(id: string): Credentials | null {
  const n = /^cam_(\d{1,3})$/.exec(id)?.[1];
  if (!n) return null;
  const env = { ...readRootEnv(), ...process.env };
  const host = env[`CAM${n.padStart(2, "0")}_HOST`];
  const user = env.CAM_USER;
  const password = env.CAM_PASSWORD;
  return host && user && password ? { host, user, password } : null;
}

// Re-read on every call so editing .env (e.g. a camera's new IP) needs no restart.
function readRootEnv(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(ROOT_ENV, "utf8")
        .split("\n")
        .map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => [m[1], m[2].replace(/^(['"])(.*)\1$/, "$2")]),
    );
  } catch {
    return {};
  }
}
