"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from '@/lib/session';
import { fetchCameraNames, type CameraNames } from '@/lib/cameraNames';
import { ago, changeFaces, fetchDuplicates, fetchFaces, keeper, label, photoUrl, type Duplicate, type FaceAction, type Identity } from '@/lib/faces';

type Filter = 'all' | 'unnamed' | 'named';

export function FaceLibrary() {
  const user = useSession();
  const admin = user?.role === 'admin';
  const [faces, setFaces] = useState<Identity[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [pairs, setPairs] = useState<Duplicate[]>([]);
  const [cameras, setCameras] = useState<CameraNames>({});
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchFaces();
      setFaces(data.identities);
      setConfigured(data.configured);
      setPairs(await fetchDuplicates());
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }, []);

  useEffect(() => {
    fetchCameraNames().then(setCameras);
    refresh();
    const timer = setInterval(refresh, 15_000); // new faces keep arriving from the cameras
    return () => clearInterval(timer);
  }, [refresh]);

  const run = async (body: FaceAction) => {
    setBusy(true);
    try {
      setFaces(await changeFaces(body));
      setPairs(await fetchDuplicates());
      setSelected(new Set());
      setError(null);
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  };

  const byId = useMemo(() => new Map((faces ?? []).map(f => [f.id, f])), [faces]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (faces ?? []).filter(f => (filter === 'all' || (filter === 'named') === !!f.name)
      && (!q || f.id.includes(q) || (f.name ?? '').toLowerCase().includes(q)));
  }, [faces, filter, query]);
  const liveSelection = [...selected].filter(id => byId.has(id));

  if (error && !faces) return <div className="notice"><p>{error}</p><button onClick={refresh}>Retry</button></div>;
  if (!faces) return <p className="notice">Loading faces…</p>;
  if (!configured) return <p className="notice">Face recognition hasn&apos;t started yet. Faces appear here once the face-watch service has seen someone.</p>;

  const camera = (id: string | null) => (id ? cameras[id] || id.replace('cam_', 'Camera ') : '—');
  const toggle = (id: string) => setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const named = faces.filter(f => f.name).length;

  const mergeSelection = () => {
    const chosen = liveSelection.map(id => byId.get(id)!);
    const into = chosen.reduce((a, b) => keeper(a, b));
    if (confirm(`Merge ${chosen.length} faces into ${label(into)}? Their photos and sightings move to ${label(into)}.`)) {
      run({ action: 'merge', ids: chosen.map(f => f.id).filter(id => id !== into.id), into: into.id });
    }
  };
  const forgetSelection = () => {
    if (confirm(`Delete ${liveSelection.length} face${liveSelection.length > 1 ? 's' : ''} and all their photos? If they're seen again they get a new id.`)) {
      run({ action: 'forget', ids: liveSelection });
    }
  };
  const forgetAll = () => {
    if (confirm(`Delete all ${faces.length} faces and every stored photo? This can't be undone.`)) run({ action: 'forget-all', confirm: 'all' });
  };

  return (
    <section className="faces">
      <p className="faces-summary">
        {faces.length} {faces.length === 1 ? 'person' : 'people'} recognised · {named} named
        {admin && faces.length > 0 && <button className="danger-link" onClick={forgetAll} disabled={busy}>Delete all faces…</button>}
      </p>
      {error && <p className="error-text" role="alert">{error}</p>}

      {pairs.length > 0 && (
        <section className="face-dupes" aria-labelledby="dupes-title">
          <h2 id="dupes-title">Possible duplicates <span className="muted">({pairs.length})</span></h2>
          <p className="hint">These ids look like the same person. Merge them, or mark them as different people.</p>
          <ul>
            {pairs.map(p => {
              const a = byId.get(p.a), b = byId.get(p.b);
              if (!a || !b) return null;
              const into = keeper(a, b), from = into === a ? b : a;
              return (
                <li key={p.a + p.b} className="face-dupe">
                  <FaceChip face={a} />
                  <span className="face-dupe-score">{Math.round(p.score * 100)}% alike</span>
                  <FaceChip face={b} />
                  {admin && (
                    <span className="face-dupe-actions">
                      <button onClick={() => run({ action: 'merge', ids: [from.id], into: into.id })} disabled={busy}>Same person: merge into {label(into)}</button>
                      <button onClick={() => run({ action: 'distinct', a: a.id, b: b.id })} disabled={busy}>Different people</button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="faces-toolbar">
        <input type="search" placeholder="Search name or id" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search faces" />
        <div className="segmented" role="group" aria-label="Show">
          {(['all', 'unnamed', 'named'] as Filter[]).map(f => (
            <button key={f} className={filter === f ? 'active' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        {admin && liveSelection.length > 0 && (
          <div className="faces-selection" role="group" aria-label="Selected faces">
            <span>{liveSelection.length} selected</span>
            <button onClick={mergeSelection} disabled={busy || liveSelection.length < 2}>Merge</button>
            <button className="danger" onClick={forgetSelection} disabled={busy}>Delete</button>
            <button onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}
        {admin && shown.length > 0 && liveSelection.length === 0 && (
          <button onClick={() => setSelected(new Set(shown.map(f => f.id)))}>Select all shown</button>
        )}
      </div>

      {faces.length === 0 ? <p className="notice">No faces yet. People get an id here after the cameras see them clearly a few times.</p>
        : shown.length === 0 ? <p className="notice">No faces match.</p>
        : (
          <ul className="face-grid">
            {shown.map(f => (
              <FaceCard key={f.id} face={f} admin={admin} busy={busy} selected={selected.has(f.id)} onToggle={() => toggle(f.id)}
                open={open === f.id} onOpen={() => setOpen(open === f.id ? null : f.id)} cameraName={camera(f.lastCamera)} run={run} />
            ))}
          </ul>
        )}
    </section>
  );
}

function FaceChip({ face }: { face: Identity }) {
  return (
    <span className="face-chip">
      {face.keys[0] ? <img src={photoUrl(face.id, face.keys[0])} alt="" width={56} height={56} /> : <span className="face-blank" />}
      <span><strong>{label(face)}</strong>{face.name && <small>{face.id}</small>}<small>{face.sightings} sightings</small></span>
    </span>
  );
}

function FaceCard({ face, admin, busy, selected, onToggle, open, onOpen, cameraName, run }: {
  face: Identity; admin: boolean; busy: boolean; selected: boolean; onToggle: () => void;
  open: boolean; onOpen: () => void; cameraName: string; run: (body: FaceAction) => Promise<void>;
}) {
  const [name, setName] = useState(face.name ?? '');
  const [editing, setEditing] = useState(false);
  const [photos, setPhotos] = useState<Set<string>>(new Set());
  useEffect(() => { if (!editing) setName(face.name ?? ''); }, [face.name, editing]);

  const save = async () => {
    setEditing(false);
    if (name.trim() !== (face.name ?? '')) await run({ action: 'name', id: face.id, name: name.trim() });
  };
  const togglePhoto = (key: string) => setPhotos(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  return (
    <li className={`face-card${selected ? ' selected' : ''}`}>
      <div className="face-cover">
        {face.keys[0] ? <img src={photoUrl(face.id, face.keys[0])} alt={`Latest photo of ${label(face)}`} width={112} height={112} /> : <span className="face-blank" />}
        {admin && <input type="checkbox" className="face-select" checked={selected} onChange={onToggle} aria-label={`Select ${label(face)}`} />}
      </div>
      <div className="face-info">
        {admin ? (
          <form onSubmit={e => { e.preventDefault(); save(); }}>
            <input className="face-name" value={name} maxLength={40} placeholder="Add a name" aria-label={`Name for ${face.id}`}
              onFocus={() => setEditing(true)} onChange={e => setName(e.target.value)} onBlur={save} disabled={busy} />
          </form>
        ) : <strong className="face-name-text">{face.name || 'Unnamed'}</strong>}
        <span className="muted">{face.id}</span>
        <span className="muted">Seen {face.sightings}× · {ago(face.lastSeen)} · {cameraName}</span>
        <button className="link" onClick={onOpen} aria-expanded={open}>{open ? 'Hide photos' : `${face.samples} photo${face.samples === 1 ? '' : 's'}`}</button>
      </div>
      {open && (
        <div className="face-photos">
          <div className="face-photo-grid">
            {face.keys.map(key => (
              <label key={key} className={`face-photo${photos.has(key) ? ' selected' : ''}`}>
                <img src={photoUrl(face.id, key)} alt="" width={72} height={72} loading="lazy" />
                {admin && <input type="checkbox" checked={photos.has(key)} onChange={() => togglePhoto(key)} aria-label="Select photo" />}
              </label>
            ))}
          </div>
          {admin && photos.size > 0 && (
            <button className="danger" disabled={busy} onClick={async () => { await run({ action: 'forget-samples', id: face.id, keys: [...photos] }); setPhotos(new Set()); }}>
              Remove {photos.size} photo{photos.size > 1 ? 's' : ''} (not {label(face)})
            </button>
          )}
        </div>
      )}
    </li>
  );
}
