"use client";
import { useEffect, useState } from 'react';
export type User = { name: string; role: 'admin' | 'viewer' };
export function useSession() {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => { fetch('/api/auth/session', { cache: 'no-store' }).then(r => r.json()).then(r => setUser(r.user)).catch(() => {}); }, []);
  return user;
}
