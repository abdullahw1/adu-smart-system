const state = globalThis as typeof globalThis & { __cameraLocks?: Map<string, Promise<unknown>> };
const locks = state.__cameraLocks ??= new Map();
export function withCameraLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) || Promise.resolve()).catch(() => {}).then(work);
  locks.set(key, next);
  void next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}
