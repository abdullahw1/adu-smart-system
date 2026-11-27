import { FaceLibrary } from "@/components/FaceLibrary";
import { Nav } from "@/components/Nav";

export default function FacesPage() {
  return (
    <main>
      <header className="page-header">
        <Nav current="/faces" />
      </header>
      <FaceLibrary />
    </main>
  );
}
