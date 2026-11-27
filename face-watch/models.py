"""OpenCV Zoo face models: YuNet (detector) + SFace (128-d face embedding).
Both run on the CPU: about 23 ms per 640x360 frame and 35 ms per face on the
edge box's Intel N95."""
from __future__ import annotations

import os

import cv2
import numpy as np

from identity import Face

MODELS = os.environ.get('MODELS', '/models')
DETECT_SCORE = 0.7  # faces below this are ignored entirely


class FaceModels:
    def __init__(self, folder: str = MODELS):
        self.detector = cv2.FaceDetectorYN.create(os.path.join(folder, 'face_detection_yunet_2023mar.onnx'), '',
                                                  (640, 360), DETECT_SCORE, 0.3, 50)
        self.recognizer = cv2.FaceRecognizerSF.create(os.path.join(folder, 'face_recognition_sface_2021dec.onnx'), '')

    def faces(self, frame, key_prefix: str = '') -> list[Face]:
        h, w = frame.shape[:2]
        self.detector.setInputSize((w, h))
        _, found = self.detector.detect(frame)
        out = []
        for n, row in enumerate(found if found is not None else []):
            crop = self.recognizer.alignCrop(frame, row)
            vector = self.recognizer.feature(crop).flatten().astype(np.float32)
            vector /= np.linalg.norm(vector) or 1.0
            x, y, bw, bh = (float(v) for v in row[:4])
            out.append(Face((x / w, y / h, (x + bw) / w, (y + bh) / h), float(row[-1]), vector, crop, f'{key_prefix}{n}'))
        return out

    def largest(self, frame) -> Face | None:
        found = self.faces(frame)
        return max(found, key=lambda f: (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]), default=None)
