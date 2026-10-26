import { Nav } from "@/components/Nav";
import { RecordingList } from "@/components/RecordingList";

export default function RecordingsPage() {
  return (
    <main>
      <header className="page-header">
        <Nav current="/recordings" />
      </header>
      <RecordingList />
    </main>
  );
}
