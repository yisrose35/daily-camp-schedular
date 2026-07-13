# Self-hosted face-recognition models (optional, recommended for camp WiFi)

The face engines try **this folder first**, then fall back to public CDNs
(jsdelivr / HuggingFace). Camp networks with content filters sometimes block
CDNs, which silently degrades recognition — dropping the files here removes
that failure mode entirely. No code changes needed; the loaders pick them up
automatically. (Override the base path by setting
`window.CAMPISTRY_MODEL_BASE = '<path>'` before the face scripts load.)

Expected layout (~42 MB total):

```
models/
├── face-api/
│   ├── face-api.min.js          # https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/dist/face-api.min.js
│   └── weights/                 # all files from https://github.com/justadudewhohacks/face-api.js/tree/0.22.2/weights
│       ├── tiny_face_detector_model-*
│       ├── face_landmark_68_tiny_model-*
│       └── face_recognition_model-*
├── ort/
│   ├── ort.min.js               # https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.min.js
│   └── *.wasm                   # the ort-wasm*.wasm files from the same dist/ folder
└── insightface/
    ├── det_500m.onnx            # https://huggingface.co/immich-app/buffalo_s/resolve/main/detection/model.onnx
    └── w600k_mbf.onnx           # https://huggingface.co/immich-app/buffalo_s/resolve/main/recognition/model.onnx
```

Only the models a page actually uses are fetched (parents don't download the
ONNX files unless they enroll photos), and browsers cache everything after
first load. Missing files are harmless — each loader falls back to its CDN.
