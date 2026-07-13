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
| `face_match_core.js` | Pure matching math: IoU/NMS, tile planning, mean templates, quality tiers, 1:1 assignment, confidence scale, dial routing, self-tuning calibration, burst clustering/propagation. Unit-tested (`tests/face_match_core.test.js`). |
| `campistry_face_shared.js` | Browser engine: face-api models, **tiled (SAHI-style) detection** at working resolution, per-face high-res re-crop + descriptor, blur/size quality metrics, engine registry. Environment-agnostic (main thread or Web Worker), self-host-first model loading. |
| `campistry_face_engine_v2.js` | Optional modern engine: **tiled SCRFD primary detection** + 512-D ArcFace (`arc-512`) via onnxruntime-web (WebGPU→WASM). InsightFace buffalo_s ONNX, self-hosted or Immich's HF mirror. Fails soft → system runs on `faceapi-128`. |
| `campistry_face_worker.js` | Web Worker wrapper: batch scanning runs off the main thread (OffscreenCanvas + createImageBitmap); inline fallback on old browsers. |
| `campistry_link_photos.js` | Matcher + auto-triage + review queue + distribution. Multi-model templates, per-photo one-to-one assignment, owner dials, self-learning, burst propagation. |
| `migrations/029_face_recognition_v2.sql` | Multi-descriptor enrollment table, pending tags, `promote_confirmed_face`, `resolve_photo_tag`, consent purge extended to v2 rows. |
| `campistry_link_parent.html` | 3-angle enrollment UI (front/left/right per child). |
| `campistry_link_admin.html` | "Needs Review" queue + **Auto-Triage** card (accept/reject dials, self-tune toggle, bulk apply). |
| `models/README.md` | Self-hosting layout for all model files (CDN-block insurance). |

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
7. **Route** — everything runs on one confidence scale (1.0 perfect, 0.5 =
   edge of the engine auto zone, 0 = edge of consideration):
   - engine-strong + quality `good` → auto-tag (parent-visible)
   - review band → **owner dials**: `conf ≥ acceptPct` auto-accept,
     `conf < rejectPct` auto-reject, middle → human queue. Dials are set in
     the admin Auto-Triage card; "Apply to current queue" re-routes a backlog.
   - pending tags stay `pending=true` in the cloud — invisible to parents
     until accepted.
8. **Burst propagation** — photos captured within ~15s of each other
   (file modification time) form a burst; a confirmed identity in one frame
   propagates to a near-identical unassigned face in the neighbors
   (face-to-face distance ≤ 0.8×autoDist). In-memory only; respects
   one-camper-per-photo.
9. **Learn (two loops)** —
   - *Gallery growth:* approving a review suggestion promotes that face's
     descriptors into the camper's gallery (`promote_confirmed_face`, capped
     at 10 per model, consent re-checked) and hot-updates local templates.
   - *Dial self-tuning:* every human approve/reject is a ~50-byte calibration
     sample (capped at 500, local only). At 30+ samples, and every ~10
     decisions after, `calibrateFromDecisions` recomputes where auto-accept
     can sit at ≥95% precision and where auto-reject loses ≤10% of real
     matches, and moves the dials (bounded, always keeping a review band).
     Bulk/auto decisions never feed the log — only humans teach.

## Performance & storage guardrails

- Batch scanning runs in a **Web Worker** (`campistry_face_worker.js`) — the
  admin UI never freezes; worker init or scan failure falls back to inline.
- Face descriptors live in memory during a batch and are discarded after
  routing; only pending-review tags keep theirs (needed for
  promote-on-approve), and those are deleted at resolution.
- Review thumbs are 96px JPEGs; the learn log is numbers only (~25 KB max);
  nothing new is persisted to the cloud beyond the tags that already existed.
- Model files load self-hosted-first (`models/`, see its README), CDN
  fallback — camp WiFi content filters can't silently degrade recognition.

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
