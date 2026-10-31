import { authorize } from '@/server/security.mjs';
import { createReadStream } from "node:fs";
import { lstat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { FILE_RE, RECORDINGS_DIR, recordingBusy } from "@/lib/recorder";

type Ctx = { params: Promise<{ file: string }> };

// Serves a recording with Range support so the browser's player can seek.
export async function GET(request: Request, { params }: Ctx) {
  const denied = await authorize(request, "viewer"); if (denied) return denied;
  const { file } = await params;
  if (!FILE_RE.test(file)) return new Response("Not found", { status: 404 });
  const full = path.join(RECORDINGS_DIR, file);

  let size: number;
  try {
    const info = await lstat(full);
    if (!info.isFile()) return new Response('Not found', { status: 404 });
    size = info.size;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  if (new URL(request.url).searchParams.has("download")) {
    headers["Content-Disposition"] = `attachment; filename="${file}"`;
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (range && size > 0 && (range[1] || range[2])) {
    // "bytes=-N" means the last N bytes.
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    headers["Content-Length"] = String(end - start + 1);
    return new Response(toWeb(createReadStream(full, { start, end })), { status: 206, headers });
  }

  headers["Content-Length"] = String(size);
  return new Response(toWeb(createReadStream(full)), { headers });
}

export async function DELETE(request: Request, { params }: Ctx) {
  const denied = await authorize(request, "admin"); if (denied) return denied;
  const { file } = await params;
  if (!FILE_RE.test(file)) return Response.json({ error: "Not found" }, { status: 404 });
  if (recordingBusy(file)) {
    return Response.json({ error: "Stop the recording first" }, { status: 409 });
  }
  try {
    await unlink(path.join(RECORDINGS_DIR, file));
  } catch {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}

function toWeb(stream: Readable): ReadableStream {
  return Readable.toWeb(stream) as ReadableStream;
}
