// One stored face photo (112x112 JPEG) of an identity.
import { authorize } from '@/server/security.mjs';
import { thumbnail } from '@/server/faces.mjs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string; key: string }> }) {
  const denied = await authorize(request); if (denied) return denied;
  const { id, key } = await params;
  const image = thumbnail(id, key.replace(/\.jpg$/, ''));
  if (!image) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(image), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
}
