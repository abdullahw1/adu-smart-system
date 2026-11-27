# Face watch (prototype): face detection + recognition on every camera.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
# OpenCV Zoo models: YuNet face detector (MIT) and SFace recogniser (Apache-2.0).
RUN mkdir /models \
 && curl -fsSL -o /models/face_detection_yunet_2023mar.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx \
 && curl -fsSL -o /models/face_recognition_sface_2021dec.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx \
 && echo "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4  /models/face_detection_yunet_2023mar.onnx" | sha256sum -c - \
 && echo "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79  /models/face_recognition_sface_2021dec.onnx" | sha256sum -c -
WORKDIR /app
COPY identity.py store.py models.py watch.py manage.py evaluate.py test_identity.py /app/
RUN python -m unittest -q test_identity
# The face library (DATA) is a volume owned by the host user that runs the stack.
USER 1000:1000
CMD ["python", "-u", "watch.py"]
