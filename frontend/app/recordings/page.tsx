import { RecordingHistory } from "@/components/RecordingHistory";
import { Nav } from "@/components/Nav";
import { RecordingList } from "@/components/RecordingList";

export default function RecordingsPage() {
  return (
    <main>
      <header className="page-header">
        <Nav current="/recordings" />
      </header>
      <RecordingHistory />
      <h2>Manual clips</h2>
      <RecordingList />
    </main>
  );
}
