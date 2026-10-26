import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Display names for cameras, keyed by go2rtc stream id. Stored server-side so a
// rename shows up on every device. Stream ids themselves never change.
const FILE = path.join(process.cwd(), "data", "camera-names.json");
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME = 40;

type Names = Record<string, string>;

async function readNames(): Promise<Names> {
  try {
    return JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    return {};
  }
}

export async function GET() {
  return Response.json(await readNames());
}

// Body: { id: "cam_01", name: "Front door" }. An empty name resets to the default.
export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { id, name } = (body ?? {}) as { id?: unknown; name?: unknown };
  if (typeof id !== "string" || !ID_RE.test(id) || typeof name !== "string") {
    return Response.json({ error: "Expected { id, name }" }, { status: 400 });
  }
  const trimmed = name.trim().slice(0, MAX_NAME);

  const names = await readNames();
  if (trimmed) names[id] = trimmed;
  else delete names[id];

  // Write-then-rename so a crash mid-write can't leave a half-written file.
  await mkdir(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(names, null, 2) + "\n");
  await rename(tmp, FILE);

  return Response.json(names);
}
