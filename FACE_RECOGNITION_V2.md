# Link Facial Recognition v2 — Architecture & Tuning

Upgrades the v1 prototype (single headshot → TinyFaceDetector at 416px on a
1200px-downscaled photo → greedy nearest-neighbor at one threshold) into a
crowd-capable, quality-gated, human-in-the-loop pipeline. All ML compute still
runs **entirely in the browser**; only descriptor arrays are persisted.

Based on a verified deep-research pass (Jul 2026). Key prior art:
SAHI sliced inference ([arXiv:2202.06934](https://arxiv.org/abs/2202.06934)),
AWS Rekognition user vectors, mean-aggregated multi-image templates
([Hofer et al., ICISSP 2023](https://arxiv.org/pdf/2212.10108)),
SCRFD ([arXiv:2105.04714](https://arxiv.org/abs/2105.04714)),
AdaFace/ArcFace low-res gains.

## Components

| File | Role |
|------|------|
| `face_match_core.js` | Pure matching math: IoU/NMS, tile planning, mean templates, quality tiers, 1:1 assignment. Unit-tested (`tests/face_match_core.test.js`). |
| `campistry_face_shared.js` | Browser engine: face-api models, **tiled (SAHI-style) detection** at working resolution, per-face high-res re-crop + descriptor, blur/size quality metrics, engine registry. |
| `campistry_face_engine_v2.js` | Optional modern engine: SCRFD landmarks + 512-D ArcFace (`arc-512`) via onnxruntime-web (WebGPU→WASM). InsightFace buffalo_s ONNX, hosted by Immich on HF. Fails soft → system runs on `faceapi-128`. |
| `campistry_link_photos.js` | Matcher + review queue + distribution. Multi-model templates, two-threshold auto/review routing, per-photo one-to-one assignment. |
| `migrations/029_face_recognition_v2.sql` | Multi-descriptor enrollment table, pending tags, `promote_confirmed_face`, `resolve_photo_tag`, consent purge extended to v2 rows. |
| `campistry_link_parent.html` | 3-angle enrollment UI (front/left/right per child). |
| `campistry_link_admin.html` | "Needs Review" queue: approve/reject gray-zone matches. |

## Pipeline (per uploaded camp photo)

1. **Detect** — whole-image pass at `inputSize 640` (was 416) **plus** overlapping
   768px tiles when the working image exceeds 1100px (working canvas caps at
   2560px; the old code pre-shrunk everything to 1200px, erasing small faces).
2. **Merge** — IoU NMS across passes.
3. **Re-crop & describe** — each detection re-cropped with margin at the best
   available resolution (upscaled to ≥160px), re-detected + landmarks +
   128-D descriptor. Doubles as false-positive filter for tile artifacts.
   If the arc-512 engine is ready, SCRFD finds 5 keypoints on the crop, the
   face is similarity-aligned to 112×112 and embedded to 512-D as well.
4. **Quality gate** — `good` / `weak` / `reject` from face size (<48px reject,
   <80px weak), detector score, and variance-of-Laplacian blur. Rejected faces
   are never matched; weak faces can at most reach the review queue.
5. **Match** — distance = min(distance-to-mean-template, best individual
   descriptor) per model; best model wins (normalized by its review threshold).
6. **Assign** — greedy one-to-one on ascending distance: a camper is tagged at
   most once per photo, a face gets at most one name.
7. **Route** — `dist ≤ autoDist` and quality `good` → auto-tag (parent-visible).
   `dist ≤ reviewDist` → pending tag: stored with `pending=true`, invisible to
   parents (`get_my_camper_photos` filters), surfaced in the admin review queue.
8. **Learn** — approving a review suggestion promotes that face's descriptors
   into the camper's gallery (`promote_confirmed_face`, capped at 10 per model,
   consent re-checked) and hot-updates the local templates, so accuracy
   compounds over the summer.

## Enrollment

Parents upload up to 3 pose-diverse photos per child (front + both sides —
pose diversity beats photo count, per Hofer et al.). Each photo produces a
descriptor per available model (`faceapi-128` always; `arc-512` when the ONNX
engine loads). Stored in `link_camper_face_descriptors`; the legacy
`link_camper_faces.descriptor` column keeps the front/128-D copy for back-compat.
Consent revocation purges *all* descriptor rows and tags.

## Thresholds (in `FaceMatchCore.MODEL_PROFILES`)

| Model | Metric | autoDist | reviewDist | Notes |
|-------|--------|----------|------------|-------|
| `faceapi-128` | euclidean | 0.45 | 0.55 | face-api's classic same/diff boundary is 0.6; auto is deliberately stricter because an auto-tag ships a photo to a parent. |
| `arc-512` | cosine distance | 0.58 (sim ≥ .42) | 0.70 (sim ≥ .30) | InsightFace w600k verification-threshold ballpark. |

Mean templates are re-L2-normalized (a raw mean of unit vectors has norm < 1,
which would shift every distance). **These defaults should be validated against
a small labeled set of real camp photos** — children's faces are
underrepresented in the training sets of every available model, so expect to
tune (likely tighten) after the first real batch.

## Known limits / next steps

- SCRFD fixed 640×640 letterbox is used per-face-crop (landmark stage), not as
  the primary detector — primary detection stays TinyFaceDetector+tiles. A full
  SCRFD-tiled primary pass is the natural next upgrade once WebGPU coverage is
  broad enough to make it fast everywhere.
- Schedule-aware candidate narrowing (photo timestamp × Campistry's own
  who-was-where data → prior over bunks) is designed but not yet wired — it
  needs a photo-time ↔ schedule join. Biggest remaining accuracy lever and
  unique to Campistry.
- Model files load from CDNs (jsdelivr / huggingface). If a camp's network
  blocks them, arc-512 silently stays off; consider self-hosting the ONNX
  files next to the app for reliability.
