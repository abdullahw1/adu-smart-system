# Patient watch (prototype): MediaPipe pose + hand gestures on one camera.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 curl \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
# Google's published MediaPipe models (pose: lite variant, fast on CPU).
RUN mkdir /models \
 && curl -fsSL -o /models/pose_landmarker_lite.task https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task \
 && curl -fsSL -o /models/gesture_recognizer.task https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task \
 && curl -fsSL -o /models/efficientdet_lite2.tflite https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float32/latest/efficientdet_lite2.tflite
WORKDIR /app
COPY logic.py watch.py record.py replay.py evaluate.py test_logic.py /app/
RUN python -m unittest -q test_logic
ENV MPLCONFIGDIR=/tmp/matplotlib
USER nobody
CMD ["python", "-u", "watch.py"]
