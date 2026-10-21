import json
import math
import os
import tempfile
from functools import wraps

from django.contrib.auth import login, logout
from django.contrib.auth.decorators import login_required
from django.contrib.auth.forms import AuthenticationForm, UserCreationForm
from django.core.files import File
from django.http import JsonResponse
from django.shortcuts import redirect, render
from django.views.decorators.http import require_http_methods, require_POST

from . import ffmpeg_utils, imaging
from .models import Project

ALLOWED = {
    "image": {".png", ".jpg", ".jpeg", ".webp"},
    "audio": {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus"},
    "video": {".mp4", ".mov", ".mkv", ".webm", ".3gp", ".avi"},
}
MAX_MB = {"image": 15, "audio": 100, "video": 500}


# ============================================================ pages (HTML)
@login_required
def index(request):
    return render(request, "studio/app.html", {"username": request.user.username})


def login_view(request):
    if request.user.is_authenticated:
        return redirect("index")
    form = AuthenticationForm(request, data=request.POST or None)
    if request.method == "POST" and form.is_valid():
        login(request, form.get_user())
        return redirect("index")
    return render(request, "studio/login.html", {"form": form})


def register_view(request):
    if request.user.is_authenticated:
        return redirect("index")
    form = UserCreationForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        user = form.save()
        login(request, user)
        return redirect("index")
    return render(request, "studio/register.html", {"form": form})


@require_POST
def logout_view(request):
    logout(request)
    return redirect("login")


# ============================================================ helpers for the JSON API
class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def api_view(*methods):
    """Login check + JSON error messages for every API function."""

    def decorator(fn):
        @require_http_methods(list(methods))
        @wraps(fn)
        def wrapper(request, *args, **kwargs):
            if not request.user.is_authenticated:
                return JsonResponse({"error": "Please log in first."}, status=401)
            try:
                return fn(request, *args, **kwargs)
            except ApiError as e:
                return JsonResponse({"error": e.message}, status=e.status)
            except ffmpeg_utils.FFmpegError as e:
                return JsonResponse({"error": str(e)}, status=500)
            except imaging.ImagingError as e:
                return JsonResponse({"error": e.message}, status=e.status)

        return wrapper

    return decorator


def project_json(p):
    return {
        "id": p.id,
        "name": p.name,
        "type": p.type,
        "details": p.details,
        "url": p.export_file.url if p.export_file else "",
        "created_at": p.created_at.isoformat(),
    }


def check_upload(f, kind):
    """File type whitelist + size limit. Returns the lower-case extension."""
    ext = os.path.splitext(f.name or "")[1].lower()
    if ext not in ALLOWED[kind]:
        raise ApiError(400, f'File type "{ext or "unknown"}" is not allowed for {kind} uploads.')
    if f.size > MAX_MB[kind] * 1024 * 1024:
        raise ApiError(400, "File is too large.")
    return ext


def save_to(folder, f, kind, number):
    """Writes an upload into a temporary folder under a safe name (never the user's name)."""
    ext = check_upload(f, kind)
    path = os.path.join(folder, f"{number}{ext}")
    with open(path, "wb") as out:
        for chunk in f.chunks():
            out.write(chunk)
    return path


def make_project(user, name, kind, details, file_path=None, uploaded=None):
    project = Project(user=user, name=(name or "Untitled")[:120], type=kind, details=details)
    if uploaded is not None:
        project.export_file.save(uploaded.name, uploaded, save=False)
    elif file_path:
        with open(file_path, "rb") as fh:
            project.export_file.save(os.path.basename(file_path), File(fh), save=False)
    project.save()
    return project


def read_details(request):
    try:
        details = json.loads(request.POST.get("details", "{}"))
    except ValueError:
        return {}
    return details if isinstance(details, dict) else {}


# ============================================================ JSON API
@api_view("GET")
def project_list(request):
    projects = Project.objects.filter(user=request.user)[:100]
    return JsonResponse({"projects": [project_json(p) for p in projects]})


@api_view("DELETE")
def project_detail(request, pk):
    try:
        project = Project.objects.get(pk=pk, user=request.user)
    except Project.DoesNotExist:
        raise ApiError(404, "Project not found.")
    if project.export_file:
        project.export_file.delete(save=False)  # remove the file from disk too
    project.delete()
    return JsonResponse({"message": "Deleted"})


@api_view("POST")
def image_save(request):
    uploaded = request.FILES.get("file")
    if not uploaded:
        raise ApiError(400, "Upload an image file.")
    check_upload(uploaded, "image")
    name = request.POST.get("name") or "Edited image"
    project = make_project(request.user, name, "image", read_details(request), uploaded=uploaded)
    return JsonResponse(project_json(project), status=201)


def read_click(request):
    try:
        return int(round(float(request.POST["x"]))), int(round(float(request.POST["y"])))
    except (KeyError, ValueError):
        raise ApiError(400, "Send the click position as x and y.")


@api_view("POST")
def image_segment(request):
    """Click on a person -> the person's exact shape (transparent PNG) + the mask."""
    f = request.FILES.get("file")
    if not f:
        raise ApiError(400, "Upload an image file.")
    check_upload(f, "image")
    x, y = read_click(request)
    rgb = imaging.read_rgb(f)
    mask = imaging.segment_person(rgb, x, y)
    rgba, bbox = imaging.person_cutout(rgb, mask)
    return JsonResponse({
        "person": imaging.data_url(imaging.png_bytes(rgba)),  # only the person, cropped
        "mask": imaging.data_url(imaging.png_bytes(mask)),    # full-size, white = person
        "bbox": bbox,                                         # where the crop was: x0, y0, x1, y1
    })


@api_view("POST")
def image_inpaint(request):
    """Image + mask -> the same image without the person, background filled in."""
    f, m = request.FILES.get("file"), request.FILES.get("mask")
    if not f or not m:
        raise ApiError(400, "Upload the image and the mask.")
    check_upload(f, "image")
    check_upload(m, "image")
    rgb = imaging.read_rgb(f)
    mask = imaging.read_mask(m, rgb.shape)
    out, engine = imaging.inpaint_background(rgb, mask)
    return JsonResponse({"image": imaging.data_url(imaging.png_bytes(out)), "engine": engine})


@api_view("POST")
def audio_merge(request):
    files = request.FILES.getlist("clips")  # same order as the page sent them
    if not files:
        raise ApiError(400, "Upload at least one audio clip.")
    if len(files) > 20:
        raise ApiError(400, "Maximum 20 clips.")
    with tempfile.TemporaryDirectory() as work:
        paths = [save_to(work, f, "audio", i) for i, f in enumerate(files)]
        output = os.path.join(work, "merged.mp3")
        ffmpeg_utils.merge_audio(paths, output)
        name = request.POST.get("name") or f"Audio mix ({len(files)} clips)"
        details = {"order": [f.name for f in files]}
        project = make_project(request.user, name, "audio", details, file_path=output)
    return JsonResponse(project_json(project), status=201)


@api_view("POST")
def video_export(request):
    video = request.FILES.get("video")
    if not video:
        raise ApiError(400, "Upload a video file.")
    try:
        segments = json.loads(request.POST.get("segments", ""))
    except ValueError:
        raise ApiError(400, "segments must be valid JSON.")

    def valid(s):
        try:
            a, b = s["start"], s["end"]
        except (TypeError, KeyError):
            return False
        numbers = all(isinstance(v, (int, float)) and math.isfinite(v) for v in (a, b))
        return numbers and a >= 0 and b - a >= 0.2 and b <= 3 * 3600

    if not (isinstance(segments, list) and 1 <= len(segments) <= 30 and all(valid(s) for s in segments)):
        raise ApiError(400, "Each segment needs numeric start/end (end must be after start).")

    with tempfile.TemporaryDirectory() as work:
        source = save_to(work, video, "video", "source")
        output = os.path.join(work, "result.mp4")
        ffmpeg_utils.export_video(source, segments, output)
        name = request.POST.get("name") or f"Video edit ({len(segments)} clips)"
        project = make_project(request.user, name, "video", {"segments": segments}, file_path=output)
    return JsonResponse(project_json(project), status=201)
