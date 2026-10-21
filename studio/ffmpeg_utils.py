"""Starts the free ffmpeg program to join audio and video."""
import os
import subprocess
import tempfile


class FFmpegError(Exception):
    pass


def _ffmpeg(args):
    cmd = [os.environ.get("FFMPEG_PATH", "ffmpeg"), "-hide_banner", "-loglevel", "error", "-y"] + args
    try:
        # A list of arguments (no shell) -> file names can never inject commands.
        result = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    except FileNotFoundError:
        raise FFmpegError('Could not start "ffmpeg". Install it and reopen PowerShell (see README).')
    if result.returncode != 0:
        raise FFmpegError("ffmpeg failed: " + result.stderr[-400:])


def merge_audio(inputs, output):
    """Join audio files, in the given order, into one MP3."""
    args = []
    for f in inputs:
        args += ["-i", f]
    prep = [
        f"[{i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}]"
        for i in range(len(inputs))
    ]
    join = "".join(f"[a{i}]" for i in range(len(inputs))) + f"concat=n={len(inputs)}:v=0:a=1[out]"
    args += ["-filter_complex", ";".join(prep + [join]), "-map", "[out]",
             "-c:a", "libmp3lame", "-b:a", "192k", output]
    _ffmpeg(args)


def export_video(source, segments, output):
    """Cut each segment from the video, then join the pieces in the given order.

    segments = [{"start": seconds, "end": seconds}, ...]
    """
    with tempfile.TemporaryDirectory() as work:
        parts = []
        for i, s in enumerate(segments):
            part = os.path.join(work, f"part{i}.mp4")
            _ffmpeg([
                "-ss", f"{s['start']:.3f}", "-i", source, "-t", f"{s['end'] - s['start']:.3f}",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", part,
            ])
            parts.append(part)
        list_file = os.path.join(work, "list.txt")
        with open(list_file, "w", encoding="utf-8") as fh:
            for p in parts:
                safe = p.replace("\\", "/").replace("'", "'\\''")
                fh.write(f"file '{safe}'\n")
        _ffmpeg(["-f", "concat", "-safe", "0", "-i", list_file, "-c", "copy",
                 "-movflags", "+faststart", output])
