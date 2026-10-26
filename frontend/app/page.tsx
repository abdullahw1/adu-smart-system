import { CameraGrid } from "@/components/CameraGrid";
import { Nav } from "@/components/Nav";

export default function LivePage() {
  return (
    <main>
      <header className="page-header">
        <Nav current="/" />
      </header>
      <CameraGrid />
    </main>
  );
}
