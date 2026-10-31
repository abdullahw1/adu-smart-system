"use client";
import { useEffect, useState } from 'react';
import { fetchCameras, type Camera } from '@/lib/go2rtc';
import { fetchCameraNames } from '@/lib/cameraNames';
type Segment = { start: number; end: number };
export function RecordingHistory() {
  const [cameras, setCameras] = useState<Camera[]>([]), [camera, setCamera] = useState('');
  const [date, setDate] = useState(() => new Date().toLocaleDateString('en-CA'));
  const [segments, setSegments] = useState<Segment[]>([]), [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [clip, setClip] = useState('');
  const [time, setTime] = useState('12:00'), [minutes, setMinutes] = useState(5);
  const [storage, setStorage] = useState(''), [recordingError, setRecordingError] = useState('');
  useEffect(() => {
    Promise.all([fetchCameras(), fetchCameraNames()]).then(([cams, names]) => { setCameras(cams.map(cam => ({ ...cam, label: names[cam.id] || cam.label }))); setCamera(cams[0]?.id || ''); }).catch(() => setError('Camera service unavailable'));
    const refresh = () => fetch('/api/storage').then(r => r.json()).then(s => {
      if (s.error) return setStorage(s.error);
      const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
      setStorage(`${gib(s.availableBytes)} GiB free · ${gib(s.recordingBytes)} GiB of manual clips`);
      setRecordingError(Object.values(s.errors || {}).join(' · '));
    }).catch(() => setStorage('Storage status unavailable'));
    refresh(); const timer = setInterval(refresh, 15000); return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!camera || !date) return;
    const controller = new AbortController(); setLoading(true); setError(''); setClip('');
    const start = new Date(date + 'T00:00:00'), end = new Date(start); end.setDate(end.getDate() + 1);
    // Respect 23- and 25-hour days when daylight saving changes.
    const query = new URLSearchParams({ camera, start: String(start.getTime()/1000), end: String(end.getTime()/1000) });
    fetch('/api/history?' + query, { signal: controller.signal }).then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error); setConfigured(data.configured); setSegments(data.segments); }).catch(e => { if (e.name !== 'AbortError') setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [camera, date]);
  const start = new Date(date + 'T00:00:00').getTime()/1000;
  const tomorrow = new Date(date + 'T00:00:00'); tomorrow.setDate(tomorrow.getDate() + 1);
  const daySeconds = tomorrow.getTime()/1000 - start;
  const rangeUrl = (from: number, to: number) => '/api/history/clip?' + new URLSearchParams({ camera, start: String(from), end: String(to) });
  const choose = (from: number) => setClip(rangeUrl(Math.floor(from), Math.floor(Math.min(from + minutes*60, start + daySeconds))));
  return <section>
    <p className="storage-status" role="status">{storage}</p>
    {recordingError && <p role="alert" className="error-text">{recordingError}</p>}
    <h2>Recording history</h2>
    <div className="history-filter">
      <label>Camera<select value={camera} onChange={e => setCamera(e.target.value)}>{cameras.map(cam => <option key={cam.id} value={cam.id}>{cam.label}</option>)}</select></label>
      <label>Date<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
      <label>Time<input type="time" value={time} onChange={e => setTime(e.target.value)} /></label>
      <label>Clip length<select value={minutes} onChange={e => setMinutes(Number(e.target.value))}>{[1,5,15,30,60].map(value => <option key={value} value={value}>{value} min</option>)}</select></label>
      <button disabled={!configured || loading || !segments.length} onClick={() => choose(new Date(date + 'T' + time).getTime()/1000)}>Play selected time</button>
    </div>
    {configured === false && <p className="hint">Continuous history becomes available when the recording drive and Frigate are connected. Manual clips are listed below.</p>}
    {error && <p role="alert" className="error-text">{error}</p>}
    {loading && <p>Loading history…</p>}
    {configured && !loading && <>
      <p>{segments.length ? 'Recorded periods are green. Empty areas are gaps. Select a period to play.' : 'No footage recorded on this date.'}</p>
      <div className="timeline" aria-label="Recording coverage for the selected day">{segments.map((segment, index) => <button key={index} title={new Date(segment.start*1000).toLocaleTimeString()} aria-label={'Play recording at ' + new Date(segment.start*1000).toLocaleTimeString()} style={{ left: `${Math.max(0,(segment.start-start)/daySeconds*100)}%`, width: `${Math.max(.15,(Math.min(segment.end,start+daySeconds)-Math.max(segment.start,start))/daySeconds*100)}%` }} onClick={() => choose(Math.max(start,segment.start))} />)}</div>
      <p className="timeline-labels"><span>00:00</span><span>12:00</span><span>24:00</span></p>
    </>}
    {clip && <><video className="recording-video" key={clip} src={clip} controls autoPlay /><p><a className="button" href={clip + '&download=1'}>Download clip to keep</a></p></>}
  </section>;
}
