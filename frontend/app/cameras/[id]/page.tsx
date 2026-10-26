import { CameraSettingsPanel } from "@/components/CameraSettingsPanel";
import { Nav } from "@/components/Nav";

export default async function CameraSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main>
      <header className="page-header">
        <Nav current="" />
      </header>
      <CameraSettingsPanel id={id} />
    </main>
  );
}
