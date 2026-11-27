"""Replays a record.py recording through the caption rules.

  python3 replay.py OUT_DIR [sensitivity]

Rows with 'people' (person-detector boxes + score, recorded about 2x a
second) gate the pose body as watch.py does; recordings without them replay
ungated. Prints when each caption starts and stops (seconds from the recording's
start), so rule changes can be compared on the same footage.
"""
import json
import os
import sys

from logic import Settings, Watcher, observe_body, observe_hands


def main():
    folder = sys.argv[1]
    settings = Settings.for_sensitivity(sys.argv[2] if len(sys.argv) > 2 else 'normal')
    rows = [json.loads(line) for line in open(os.path.join(folder, 'observations.jsonl'))]
    start = rows[0]['t']
    watcher = Watcher(settings)
    gated = any('people' in row for row in rows)
    score = float(os.environ.get('PERSON_SCORE', '0.4'))
    seen = []  # (t, boxes), as watch.PersonDetector keeps them
    shown = {}
    spans = []
    for row in rows:
        t = row['t']
        body = observe_body(row['bodies'], settings)
        hands = observe_hands(row['hands'], settings)
        if 'people' in row:
            seen.append((t, [p[:4] for p in row['people'] if p[4] >= score]))
        seen = [s for s in seen if t - s[0] <= 1.5]
        people = [b for _, boxes in seen for b in boxes] if gated else None
        now = {o['id']: o['caption'].split(' (')[0] for o in watcher.update(t, body, hands, people)}
        for key in set(shown) | set(now):
            old, new = shown.get(key), now.get(key)
            if old and old[0] != new:
                spans.append((old[1] - start, t - start, old[0]))
                del shown[key]
            if new and key not in shown:
                shown[key] = (new, t)
    for key, (caption, since) in shown.items():
        spans.append((since - start, rows[-1]['t'] - start, caption))
    for a, b, caption in sorted(spans):
        if caption not in ('Patient still', 'Patient moving') or b - a >= 2:
            print(f'{a:6.1f}-{b:6.1f}s  {caption}')


if __name__ == '__main__':
    main()
