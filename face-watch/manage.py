"""Face library tool: see, name, merge and delete face identities.

Run inside the service container (it shares the library with the service,
which picks up changes within 2 seconds):

  docker exec face-watch python manage.py list
  docker exec face-watch python manage.py sheet            # DATA/sheet.jpg: faces of every id, to see who is who
  docker exec face-watch python manage.py name face_0003 "Alice"
  docker exec face-watch python manage.py name face_0003 ""   # remove the name
  docker exec face-watch python manage.py merge face_0007 face_0003   # same person: 0007 joins 0003
  docker exec face-watch python manage.py forget face_0007  # delete the id, its samples and photos

To enrol someone by name without waiting for the cameras, put clear photos of
them in DATA/known/<Name>/ (one face per photo).
"""
import os
import sys
import time

from store import Store

DATA = os.environ.get('DATA', '/data')


def ago(t):
    s = time.time() - t
    return f'{s / 86400:.0f}d ago' if s >= 86400 else f'{s / 3600:.0f}h ago' if s >= 3600 else f'{s / 60:.0f}m ago'


def sheet(store, path, per_row=8):
    import cv2
    import numpy as np
    rows = []
    for r in store.identities():
        folder = os.path.join(store.folder, 'thumbs', r['id'])
        files = sorted(os.listdir(folder))[-per_row:] if os.path.isdir(folder) else []
        tiles = [cv2.resize(cv2.imread(os.path.join(folder, f)), (112, 112)) for f in files]
        tiles += [np.zeros((112, 112, 3), np.uint8)] * (per_row - len(tiles))
        label = np.full((112, 220, 3), 255, np.uint8)
        for n, text in enumerate((r['id'], r['name'] or '(no name)', f"seen {r['sightings']}x", ago(r['last_seen']))):
            cv2.putText(label, text, (8, 26 + 26 * n), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2 if n < 2 else 1)
        rows.append(np.hstack([label] + tiles))
    if not rows:
        print('no identities yet')
        return
    cv2.imwrite(path, np.vstack(rows))
    print(f'wrote {path} ({len(rows)} identities)')


def main(argv):
    store = Store(DATA)
    cmd, args = (argv[0] if argv else 'list'), argv[1:]
    if cmd == 'list':
        rows = store.identities()
        print(f"{'id':10} {'name':20} {'seen':>6} {'samples':>7}  last seen")
        for r in rows:
            print(f"{r['id']:10} {(r['name'] or '-'):20} {r['sightings']:>6} {r['samples']:>7}  {ago(r['last_seen'])} on {r['last_camera'] or '-'}")
        print(f'{len(rows)} identities')
    elif cmd == 'name' and len(args) == 2:
        print('ok' if store.name(args[0], args[1].strip()) else f'no such id: {args[0]}')
    elif cmd == 'merge' and len(args) == 2:
        print('ok' if store.merge(args[0], args[1]) else 'nothing merged (check both ids)')
    elif cmd == 'forget' and len(args) == 1:
        print('ok' if store.forget(args[0]) else f'no such id: {args[0]}')
    elif cmd == 'sheet':
        sheet(store, args[0] if args else os.path.join(DATA, 'sheet.jpg'))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
