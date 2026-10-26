import Link from "next/link";

const LINKS = [
  { href: "/", label: "Live" },
  { href: "/recordings", label: "Recordings" },
];

export function Nav({ current }: { current: string }) {
  return (
    <nav className="nav">
      {LINKS.map(({ href, label }) => (
        <Link key={href} href={href} aria-current={href === current ? "page" : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
