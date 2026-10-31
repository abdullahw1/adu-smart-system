"use client";
import Link from 'next/link';
import { useSession } from '@/lib/session';
export function Nav({ current }: { current: string }) {
  const user = useSession();
  const links = [{ href: '/', label: 'Live' }, { href: '/recordings', label: 'Recordings' }, ...(user?.role === 'admin' ? [{ href: '/access', label: 'Access' }] : [])];
  return <nav className="nav">{links.map(link => <Link key={link.href} href={link.href} aria-current={link.href === current ? 'page' : undefined}>{link.label}</Link>)}
    {user && <button className="sign-out" onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }); window.location.assign('/login'); }}>Sign out {user.name}</button>}
  </nav>;
}
