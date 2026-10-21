"""python manage.py check_ai  ->  tells you if the AI packages / models work on this PC."""
import time

from django.core.management.base import BaseCommand

from studio import imaging


class Command(BaseCommand):
    help = "Checks the AI models used by the Images tab (first run downloads them)."

    def handle(self, *args, **options):
        if imaging._LIB_ERROR is not None:
            self.stdout.write(self.style.ERROR(f"numpy / opencv / pillow missing: {imaging._LIB_ERROR}"))
            self.stdout.write(imaging.INSTALL_HINT)
            return

        import numpy as np

        def step(label, job):
            self.stdout.write(f"{label} ... ", ending="")
            self.stdout.flush()
            t = time.time()
            try:
                job()
            except Exception as exc:  # show the reason instead of a long traceback
                msg = getattr(exc, "message", str(exc))
                self.stdout.write(self.style.ERROR(f"FAILED: {msg}"))
                return False
            self.stdout.write(self.style.SUCCESS(f"OK ({time.time() - t:.1f}s)"))
            return True

        img = np.full((256, 256, 3), 120, np.uint8)
        img[:, :, 1] += (np.arange(256) // 4).astype(np.uint8)[None, :]
        mask = np.zeros((256, 256), np.uint8)
        mask[80:200, 100:150] = 255

        step("1/3 YOLO  (finds people)", lambda: imaging._detect_people(np.ascontiguousarray(img[:, :, ::-1])))
        def sam_job():
            try:
                imaging._sam_mask(np.ascontiguousarray(img[:, :, ::-1]), None, (125, 140))
            except imaging.ImagingError as exc:
                if exc.status != 422:  # 422 = "no object here": the model itself ran fine
                    raise

        step("2/3 SAM   (exact outline)", sam_job)
        step("3/3 LaMa  (fills the background)", lambda: imaging._lama_fill(img, mask))
        self.stdout.write("If a step failed, read the reason above. Step 3 failing is not fatal: "
                          "the site then uses a basic OpenCV fill.")
