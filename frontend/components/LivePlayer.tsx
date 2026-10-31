"use client";
import { useEffect, useRef } from 'react';
import { streamUrl } from '@/lib/go2rtc';
export type PlayerStatus = 'connecting' | 'live' | 'no-signal' | 'reconnecting' | 'unsupported';
type Props = { base: string; src: string; controls?: boolean; muted?: boolean; onStatus?: (status: PlayerStatus) => void };
const CODECS = ['avc1.640029', 'avc1.64002A', 'avc1.640033', 'hvc1.1.6.L153.B0', 'mp4a.40.2', 'mp4a.40.5', 'flac', 'opus'];

export function LivePlayer({ base, src, controls = false, muted = true, onStatus }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const callback = useRef(onStatus); callback.current = onStatus;
  useEffect(() => {
    const video = videoRef.current!;
    const Managed = (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
    const Source = Managed || window.MediaSource;
    if (!Source) { callback.current?.('unsupported'); return; }
    let disposed = false, visible = true, generation = 0;
    let disconnect = () => {};
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lastTime = 0, lastFrame = Date.now();
    const report = (status: PlayerStatus) => { if (!disposed) callback.current?.(status); };
    const stop = () => { generation++; clearTimeout(retry); disconnect(); disconnect = () => {}; };
    const connect = (reconnecting = false) => {
      stop(); if (disposed || !visible || document.hidden) return;
      const epoch = generation;
      report(reconnecting ? 'reconnecting' : 'connecting'); lastFrame = Date.now(); lastTime = 0;
      const media = new Source(), ws = new WebSocket(streamUrl(base, src)); ws.binaryType = 'arraybuffer';
      let buffer: SourceBuffer | undefined, queue: ArrayBuffer[] = [], queued = 0, objectUrl = '', failed = false;
      const current = () => !disposed && epoch === generation;
      const fail = (status: PlayerStatus = 'no-signal') => {
        if (!current() || failed) return;
        failed = true; stop(); report(status);
        if (status !== 'unsupported') retry = setTimeout(() => connect(true), 3000);
      };
      const negotiate = () => {
        if (current() && ws.readyState === WebSocket.OPEN && media.readyState === 'open') {
          const supported = CODECS.filter(codec => Source.isTypeSupported(`video/mp4; codecs="${codec}"`));
          if (!supported.some(codec => /^(avc1|hvc1)/.test(codec))) return fail('unsupported');
          ws.send(JSON.stringify({ type: 'mse', value: supported.join(',') }));
        }
      };
      // The generation and membership checks prevent callbacks on detached buffers.
      const drain = () => {
        if (!current() || !buffer || media.readyState !== 'open' || !Array.from(media.sourceBuffers).includes(buffer)) return;
        try {
          if (buffer.updating) return;
          if (buffer.buffered.length) {
            const end = buffer.buffered.end(buffer.buffered.length - 1);
            if (buffer.buffered.start(0) < end - 15) { buffer.remove(buffer.buffered.start(0), end - 10); return; }
            if (video.currentTime < end - 3) video.currentTime = Math.max(0, end - 0.5);
          }
          const next = queue.shift(); if (next) { queued -= next.byteLength; buffer.appendBuffer(next); }
        } catch { fail(); }
      };
      ws.onopen = negotiate;
      ws.onmessage = event => {
        if (!current()) return;
        try {
          if (typeof event.data === 'string') {
            const message = JSON.parse(event.data);
            if (message.type === 'error') return fail();
            if (message.type === 'mse' && !buffer) {
              if (!Source.isTypeSupported(message.value)) return fail('unsupported');
              buffer = media.addSourceBuffer(message.value); buffer.mode = 'segments';
              buffer.addEventListener('updateend', drain); drain();
              video.play().catch(() => { if (current()) report('connecting'); });
            }
          } else {
            queued += event.data.byteLength;
            if (queued > 4 * 1024 * 1024) return fail();
            queue.push(event.data); drain();
          }
        } catch { fail(); }
      };
      ws.onclose = () => fail(); ws.onerror = () => fail();
      media.addEventListener('sourceopen', negotiate);
      const videoError = () => fail(video.error?.code === 4 ? 'unsupported' : 'no-signal');
      const playing = () => { lastFrame = Date.now(); report('live'); };
      video.addEventListener('error', videoError); video.addEventListener('playing', playing);
      disconnect = () => {
        ws.onmessage = ws.onclose = ws.onerror = ws.onopen = null; ws.close();
        media.removeEventListener('sourceopen', negotiate); buffer?.removeEventListener('updateend', drain);
        video.removeEventListener('error', videoError); video.removeEventListener('playing', playing);
        queue = []; queued = 0; video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
      if (Managed) { video.disableRemotePlayback = true; video.srcObject = media as unknown as MediaStream; }
      else { objectUrl = URL.createObjectURL(media); video.src = objectUrl; }
    };
    const activity = () => { if (!document.hidden && visible) connect(); else stop(); };
    document.addEventListener('visibilitychange', activity);
    const observer = new IntersectionObserver(entries => { const next = entries[0].isIntersecting; if (next !== visible) { visible = next; activity(); } }, { threshold: 0.05 });
    observer.observe(video);
    const watchdog = setInterval(() => {
      if (!visible || document.hidden) return;
      if (video.currentTime !== lastTime) { lastTime = video.currentTime; lastFrame = Date.now(); }
      else if (Date.now() - lastFrame > 12_000) { report('no-signal'); connect(true); }
    }, 1000);
    connect();
    return () => { disposed = true; stop(); observer.disconnect(); clearInterval(watchdog); document.removeEventListener('visibilitychange', activity); };
  }, [base, src, controls, muted]);
  return <div className="player"><video ref={videoRef} controls={controls} muted={muted} playsInline autoPlay /></div>;
}
