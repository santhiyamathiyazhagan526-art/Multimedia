"""Image helpers that need AI models. They run on the SERVER (Python).

1. segment_person()      click on a person -> exact body-shape mask
                         (YOLO finds the people, SAM draws the exact outline)
2. person_cutout()       mask -> transparent PNG of only that person (clean edges)
3. inpaint_background()  fill the empty place after the person is removed
                         (LaMa model; falls back to OpenCV if LaMa is not installed)

The AI packages are optional: if they are missing the website still starts and the
manual "draw outline" tool keeps working. Install them with
    pip install -r requirements-ai.txt
and check them with
    python manage.py check_ai
"""
import base64
import os
import threading

try:  # these come with the AI packages (see requirements-ai.txt)
    import cv2
    import numpy as np
    from PIL import Image

    _LIB_ERROR = None
except ImportError as exc:  # pragma: no cover - depends on the machine
    cv2 = np = Image = None
    _LIB_ERROR = exc

INSTALL_HINT = (
    "The AI packages are not installed. In the project folder run "
    "'pip install -r requirements-ai.txt' and restart the server. "
    "(You can still use 'Draw outline instead'.)"
)
MAX_SIDE = 3000


class ImagingError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def _cfg(name, default):
    """Reads a setting from Django settings (or the environment when Django is not loaded)."""
    try:
        from django.conf import settings

        return getattr(settings, name, default)
    except Exception:
        return os.environ.get(name, default)


def _need_libs():
    if _LIB_ERROR is not None:
        raise ImagingError(INSTALL_HINT, 503)


# ------------------------------------------------------------------ models (loaded once)
_models = {}
_load_lock = threading.Lock()
_run_lock = threading.Lock()  # one AI job at a time (the models are not thread-safe)


def _get_model(name, factory):
    try:
        with _load_lock:
            if name not in _models:
                _models[name] = factory()
            return _models[name]
    except ImagingError:
        raise
    except ImportError:
        raise ImagingError(INSTALL_HINT, 503)
    except Exception as exc:
        raise ImagingError(
            f"Could not load the {name} model ({exc}). The first run downloads it, "
            "so check your internet connection.", 503)


def _make_yolo():
    from ultralytics import YOLO

    return YOLO(_cfg("YOLO_MODEL", "yolov8s.pt"))


def _make_sam():
    from ultralytics import SAM

    return SAM(_cfg("SAM_MODEL", "mobile_sam.pt"))


def _make_lama():
    from simple_lama_inpainting import SimpleLama

    return SimpleLama()


# ------------------------------------------------------------------ reading / writing images
def read_rgb(file_obj):
    """Uploaded file -> numpy array (height, width, 3) RGB."""
    _need_libs()
    try:
        img = Image.open(file_obj).convert("RGB")
    except Exception:
        raise ImagingError("Could not read this image.")
    if max(img.size) > MAX_SIDE:
        raise ImagingError(f"Image is too big (maximum {MAX_SIDE}px on the longest side).")
    return np.array(img)


def read_mask(file_obj, shape):
    """Uploaded mask (white = person) -> uint8 array of 0 / 255 with the same size as the image."""
    _need_libs()
    try:
        m = np.array(Image.open(file_obj).convert("L"))
    except Exception:
        raise ImagingError("Could not read the mask.")
    if m.shape[:2] != tuple(shape[:2]):
        raise ImagingError("The mask and the image must have the same size.")
    return np.where(m > 127, 255, 0).astype(np.uint8)


def png_bytes(arr):
    """RGB / RGBA / gray uint8 array -> PNG bytes."""
    if arr.ndim == 3 and arr.shape[2] == 4:
        arr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGRA)
    elif arr.ndim == 3:
        arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    ok, buf = cv2.imencode(".png", arr)
    if not ok:
        raise ImagingError("Could not create the PNG.", 500)
    return buf.tobytes()


def data_url(png):
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


# ------------------------------------------------------------------ 1) click -> person mask
def _detect_people(bgr):
    """List of person boxes (x0, y0, x1, y1) found by YOLO."""
    model = _get_model("people detector (YOLO)", _make_yolo)
    with _run_lock:
        res = model.predict(bgr, classes=[0], conf=0.25, verbose=False)
    if not res or res[0].boxes is None or len(res[0].boxes) == 0:
        return []
    return [tuple(float(v) for v in b) for b in res[0].boxes.xyxy.cpu().numpy()]


def pick_box(boxes, x, y):
    """The person box that contains the click. If several overlap, take the one whose
    centre is nearest to the click (compared with its width)."""
    best, best_score = None, None
    for x0, y0, x1, y1 in boxes:
        bw, bh = max(x1 - x0, 1.0), max(y1 - y0, 1.0)
        if not (x0 - 0.02 * bw <= x <= x1 + 0.02 * bw and y0 - 0.02 * bh <= y <= y1 + 0.02 * bh):
            continue
        score = abs((x0 + x1) / 2 - x) / bw
        if best_score is None or score < best_score:
            best, best_score = (x0, y0, x1, y1), score
    return best


def _sam_mask(bgr, box, point):
    """SAM draws the exact outline. A box around the person gives the WHOLE body
    (a single click alone often selects only the clothes)."""
    sam = _get_model("segmentation (SAM)", _make_sam)
    with _run_lock:
        if box is not None:
            res = sam.predict(bgr, bboxes=[list(box)], verbose=False)
        else:
            res = sam.predict(bgr, points=[[point[0], point[1]]], labels=[1], verbose=False)
    if not res or res[0].masks is None or len(res[0].masks.data) == 0:
        raise ImagingError("No person found there. Click directly on the person.", 422)
    m = res[0].masks.data[0].cpu().numpy()
    return (m > 0.5).astype(np.uint8)


def clean_mask(raw, point):
    """Smooth the jagged edge, fill holes, keep the blob that was clicked (+ big pieces
    of the same body such as a hand holding a phone). Returns uint8 0 / 255."""
    h, w = raw.shape[:2]
    m = (raw > 0).astype(np.uint8) * 255
    m = cv2.GaussianBlur(m, (0, 0), 1.5)
    m = (m > 127).astype(np.uint8) * 255

    # fill holes: flood the outside, whatever is not reached is a hole
    pad = cv2.copyMakeBorder(255 - m, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=255)
    flood = pad.copy()
    cv2.floodFill(flood, np.zeros((pad.shape[0] + 2, pad.shape[1] + 2), np.uint8), (0, 0), 0)
    holes = flood[1:-1, 1:-1]
    m = np.maximum(m, holes)

    n, labels, stats, _ = cv2.connectedComponentsWithStats((m > 0).astype(np.uint8), connectivity=8)
    if n <= 1:
        return np.zeros((h, w), np.uint8)
    px, py = int(point[0]), int(point[1])
    main = labels[py, px] if 0 <= px < w and 0 <= py < h else 0
    if main == 0:
        main = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    main_area = stats[main, cv2.CC_STAT_AREA]
    keep = np.zeros(n, bool)
    keep[main] = True
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= 0.03 * main_area:
            keep[i] = True
    return np.where(keep[labels], 255, 0).astype(np.uint8)


def segment_person(rgb, x, y):
    """Click (x, y) in image pixels -> mask (uint8 0 / 255) of the person that was clicked."""
    _need_libs()
    h, w = rgb.shape[:2]
    if not (0 <= x < w and 0 <= y < h):
        raise ImagingError("The click is outside the image.")
    bgr = np.ascontiguousarray(rgb[:, :, ::-1])
    box = pick_box(_detect_people(bgr), x, y)
    raw = _sam_mask(bgr, box, (x, y))
    if raw.shape != (h, w):
        raw = cv2.resize(raw, (w, h), interpolation=cv2.INTER_NEAREST)
    mask = clean_mask(raw, (x, y))
    if mask.sum() / 255 < 0.002 * w * h:
        raise ImagingError("No person found there. Click directly on the person.", 422)
    return mask


# ------------------------------------------------------------------ 2) mask -> person PNG
def _extend_colors(rgb, known, iters):
    """Pushes the colours of the 'known' pixels outwards, a few pixels. Used so that the
    soft edge of the person shows the PERSON's colour, not the old background."""
    col = rgb.astype(np.float32)
    k = known.astype(np.float32)
    for _ in range(iters):
        num = cv2.blur(col * k[..., None], (3, 3))
        den = cv2.blur(k, (3, 3))
        grow = (k == 0) & (den > 0)
        if not grow.any():
            break
        col[grow] = num[grow] / den[grow][:, None]
        k[grow] = 1.0
    return col


def person_cutout(rgb, mask):
    """Returns (rgba, [x0, y0, x1, y1]): the person only, soft clean edge, cropped."""
    _need_libs()
    m = (mask > 0).astype(np.uint8)
    ys, xs = np.nonzero(m)
    if len(xs) == 0:
        raise ImagingError("Empty selection.", 422)
    solid = cv2.erode(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    if solid.sum() < 50:
        solid = m
    col = _extend_colors(rgb, solid, 6)
    core = cv2.erode(m, np.ones((3, 3), np.uint8))
    alpha = cv2.GaussianBlur(core.astype(np.float32) * 255.0, (0, 0), 1.2)
    alpha[m == 0] = 0

    h, w = m.shape
    x0, x1 = max(0, xs.min() - 2), min(w, xs.max() + 3)
    y0, y1 = max(0, ys.min() - 2), min(h, ys.max() + 3)
    rgba = np.dstack([np.clip(col, 0, 255).astype(np.uint8), np.clip(alpha, 0, 255).astype(np.uint8)])
    return rgba[y0:y1, x0:x1], [int(x0), int(y0), int(x1), int(y1)]


# ------------------------------------------------------------------ 3) fill the empty place
def _lama_fill(crop, hole):
    from PIL import Image as PILImage

    lama = _get_model("background fill (LaMa)", _make_lama)
    with _run_lock:
        out = lama(PILImage.fromarray(crop), PILImage.fromarray(hole))
    res = np.array(out.convert("RGB"))
    ch, cw = crop.shape[:2]
    if res.shape[0] < ch or res.shape[1] < cw:
        res = cv2.resize(res, (cw, ch))
    return res[:ch, :cw]


def _opencv_fill(crop, hole):
    """Basic fallback. Smooth, so we add a little film grain like the rest of the photo,
    otherwise the patch looks blurry."""
    bgr = cv2.cvtColor(crop, cv2.COLOR_RGB2BGR)
    filled = cv2.inpaint(bgr, hole, 5, cv2.INPAINT_TELEA)
    out = cv2.cvtColor(filled, cv2.COLOR_BGR2RGB).astype(np.float32)
    known = hole == 0
    if known.sum() > 100:
        detail = crop.astype(np.float32) - cv2.GaussianBlur(crop.astype(np.float32), (0, 0), 2.0)
        sigma = detail[known].std(axis=0)  # per colour channel
        rng = np.random.default_rng(1)
        noise = rng.normal(0.0, 1.0, out.shape).astype(np.float32) * sigma * 0.9
        out = np.where((hole > 0)[..., None], out + noise, out)
    return np.clip(out, 0, 255).astype(np.uint8)


def inpaint_background(rgb, mask):
    """Remove the person (mask = white) and invent the background behind them.
    Returns (rgb, engine) where engine is 'lama' or 'opencv'."""
    _need_libs()
    h, w = mask.shape
    grow = max(6, int(round(0.012 * max(h, w))))  # also remove the old halo / shadow edge
    hole = cv2.dilate((mask > 0).astype(np.uint8) * 255,
                      cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * grow + 1, 2 * grow + 1)))
    ys, xs = np.nonzero(hole)
    if len(xs) == 0:
        return rgb, "none"

    # work on a crop around the hole (faster and better: LaMa sees the nearby surroundings)
    ctx = max(48, int(0.6 * max(xs.max() - xs.min(), ys.max() - ys.min())))
    x0, x1 = max(0, xs.min() - ctx), min(w, xs.max() + ctx + 1)
    y0, y1 = max(0, ys.min() - ctx), min(h, ys.max() + ctx + 1)
    crop = np.ascontiguousarray(rgb[y0:y1, x0:x1])
    chole = np.ascontiguousarray(hole[y0:y1, x0:x1])

    engine = "lama"
    try:
        filled = _lama_fill(crop, chole)
    except ImagingError as exc:
        if exc.status != 503:
            raise
        engine = "opencv"
        filled = _opencv_fill(crop, chole)
    except Exception:
        engine = "opencv"
        filled = _opencv_fill(crop, chole)

    # paste only the hole (soft edge) back, everything else stays pixel-perfect
    f = cv2.GaussianBlur((chole > 0).astype(np.float32), (0, 0), 2.0)[..., None]
    region = crop.astype(np.float32) * (1 - f) + filled.astype(np.float32) * f
    region = np.where(f > 0.004, np.rint(region), crop).clip(0, 255).astype(np.uint8)
    out = rgb.copy()
    out[y0:y1, x0:x1] = region
    return out, engine
