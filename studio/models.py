import os
import uuid

from django.conf import settings
from django.db import models


def export_path(instance, filename):
    """Saves every exported file under a random name inside media/exports/."""
    ext = os.path.splitext(filename)[1].lower()
    return f"exports/{uuid.uuid4().hex}{ext}"


class Project(models.Model):
    """One saved result (an edited image, a merged audio or an exported video).

    The big file lives on disk (MEDIA_ROOT); PostgreSQL stores only its path
    plus small information such as the clip order.
    """

    TYPES = [("image", "Image"), ("audio", "Audio"), ("video", "Video")]

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="projects")
    name = models.CharField(max_length=120)
    type = models.CharField(max_length=10, choices=TYPES)
    details = models.JSONField(default=dict, blank=True)  # e.g. clip order, segment times
    export_file = models.FileField(upload_to=export_path, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.name} ({self.type})"
