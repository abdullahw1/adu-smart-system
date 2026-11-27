"use client";
import { useSession } from "@/lib/session";
import { useLiveFeed } from "@/lib/detections";

// Reloads open pages after the app is updated (see lib/detections.ts).
// Only for signed-in users: the live feed requires a session.
export function UpdateWatcher() {
  const user = useSession();
  useLiveFeed(Boolean(user));
  return null;
}
