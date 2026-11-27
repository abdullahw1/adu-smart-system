"""Runs face recognition over a video file and reports identity quality.

  python evaluate.py VIDEO [--fps 3] [--data DIR] [--camera NAME] [--out annotated.mp4]

With a fresh --data folder (the default is a temporary one) it shows how many
identities the footage creates; on footage of one person the right answer is
1. Run it twice on the same --data to check that a known face is recognised
straight away the second time. Prints a timeline and a summary.
"""
import argparse
import collections
import tempfile

import cv2

from identity import Gallery, Identifier, Settings
from models import FaceModels
from store import Store


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video')
    ap.add_argument('--fps', type=float, default=3)
    ap.add_argument('--data')
    ap.add_argument('--camera', default='cam_03')
    ap.add_argument('--out')
    args = ap.parse_args()
    store = Store(args.data or tempfile.mkdtemp())
    gallery = Gallery()
    store.load_into(gallery)
    before = set(gallery.samples)
    identifier, models = Identifier(gallery, Settings()), FaceModels()
    cap = cv2.VideoCapture(args.video)
    rate = cap.get(cv2.CAP_PROP_FPS) or 10
    step = max(1, round(rate / args.fps))
    writer, n, frames_with_faces, labels, first_label, timeline = None, -1, 0, collections.Counter(), None, []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        n += 1
        if n % step:
            continue
        t = n / rate
        objects = identifier.update(args.camera, t, models.faces(frame, f'{int(t * 1000)}-{args.camera}-'))
        for kind, identity, *rest in identifier.events:
            if kind == 'new':
                store.add_identity(identity, t)
                for f in rest[0]:
                    store.add_sample(identity, f.key, t, args.camera, f.score, f.embedding, f.crop)
            elif kind == 'add':
                store.add_sample(identity, rest[0].key, t, args.camera, rest[0].score, rest[0].embedding, rest[0].crop)
            elif kind == 'drop':
                store.drop_sample(identity, rest[0])
        identifier.events.clear()
        if objects:
            frames_with_faces += 1
            for o in objects:
                labels[o['caption']] += 1
                if first_label is None and o['identity']:
                    first_label = t
        caption = ', '.join(sorted(o['caption'] for o in objects)) or '-'
        if not timeline or timeline[-1][1] != caption:
            timeline.append((t, caption))
        if args.out:
            if writer is None:
                writer = cv2.VideoWriter(args.out, cv2.VideoWriter_fourcc(*'mp4v'), args.fps, (frame.shape[1], frame.shape[0]))
            h, w = frame.shape[:2]
            for o in objects:
                x, y, bw, bh = o['box']
                colour = (80, 220, 80) if o['identity'] else (200, 200, 200)
                cv2.rectangle(frame, (int(x * w), int(y * h)), (int((x + bw) * w), int((y + bh) * h)), colour, 2)
                cv2.putText(frame, o['caption'], (int(x * w), max(14, int(y * h) - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, colour, 2)
            writer.write(frame)
    if writer:
        writer.release()
    print('timeline (caption changes):')
    for t, caption in timeline:
        print(f'  {t:6.1f}s  {caption}')
    new = sorted(set(gallery.samples) - before)
    total = sum(labels.values())
    print(f'\nframes checked: {n // step + 1}, with a face: {frames_with_faces}')
    print(f'identities created: {len(new)} {new}   (known before: {len(before)})')
    print('face labels: ' + ', '.join(f'{k} {100 * v / total:.0f}%' for k, v in labels.most_common()))
    print(f'first identity label at: {first_label:.1f}s' if first_label is not None else 'never labelled')


if __name__ == '__main__':
    main()
