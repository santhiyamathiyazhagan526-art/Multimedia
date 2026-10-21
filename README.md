# Multimedia Drag and Drop - Web version

**Frontend:** HTML + CSS + JavaScript  |  **Backend:** Python (Django)  |  **Database:** PostgreSQL

```
multimedia_django_project/
├── manage.py                    Django command tool (runserver, migrate ...)
├── requirements.txt  .env.example  README.md
├── config/                      Django project settings
│   ├── settings.py              database (PostgreSQL), media folder, ffmpeg path
│   └── urls.py  wsgi.py  asgi.py
└── studio/                      our app
    ├── models.py                Project table (PostgreSQL)
    ├── views.py                 pages (login/register) + JSON API
    ├── urls.py                  web addresses
    ├── ffmpeg_utils.py          joins audio / cuts + joins video with ffmpeg
    ├── imaging.py               AI for the Images tab: click a person (YOLO + SAM), fill background (LaMa)
    ├── management/commands/check_ai.py   `python manage.py check_ai` tests the AI packages
    ├── admin.py
    ├── templates/studio/        login.html  register.html  app.html   <- HTML
    └── static/studio/
        ├── css/style.css                                              <- CSS
        └── js/  api.js sortable.js cutout.js harmonize.js images.js audio.js
                 video.js projects.js main.js                          <- JavaScript
```

## 1. How it works (simple words)
- **Frontend (browser):** `app.html` + CSS + JavaScript. It shows 3 tabs (Images, Audio, Videos) plus "My projects". JavaScript does the image editing itself using an HTML canvas, and sends audio/video files to the server with `fetch/XMLHttpRequest`.
- **Backend (Django):** handles register/login (Django's built-in users and sessions), receives uploads, runs **ffmpeg** to join audio/video, and saves a record for every export.
- **Database (PostgreSQL):** stores users (Django's `auth_user` table) and the `studio_project` table: name, type, clip order / segment times, and the PATH of the exported file. The big files themselves are saved in the `media/exports` folder, not in the database.

| Feature | Where it runs | Status |
|---|---|---|
| Register / login / logout | Django + PostgreSQL | Implemented |
| Images: pick several, preview, **click a person**, drag them, resize, undo / redo / reset, download PNG, save project | browser (canvas) + server AI | **New AI version.** Browser part tested with a fake browser; the AI models themselves NOT run yet - see section 1b |
| Select person | **click on the person**: YOLO finds the people, SAM draws the exact body shape. Only the person's own pixels can be grabbed and dragged. The old "draw outline" tool is still there as a fallback | AI (server) |
| Fill the empty place | **LaMa** AI model invents the background behind the person (server). A quick browser fill is shown for a moment until it arrives. Without LaMa the server uses a basic OpenCV fill (blurrier) | AI (server) |
| Person fits the new place | colours / brightness follow the light at the new spot ("Match colours" slider), clean soft edge without the old background colour, optional "Soft shadow" | browser |
| Audio: pick, play, drag to reorder, combine, play + download MP3 | merge on server (ffmpeg) | Implemented and tested |
| Video: pick, preview, split (equal parts or at the current time), drag to reorder, combine, play + download MP4 | cut + join on server (ffmpeg) | Implemented and tested |
| My projects list + delete | Django + PostgreSQL | Implemented |

**Honest testing note (AI part):** the AI models (YOLO, SAM, LaMa) could NOT be downloaded or run where this feature was written (no internet there). What WAS tested: the server code around them (mask cleaning, clean edges, background paste, OpenCV fallback) with simulated model output, and the whole browser flow (click -> select -> only-the-person drag -> colour match -> apply -> undo) in a simulated browser with the real server data format. So run `python manage.py check_ai` first; if a step fails, paste the message and it can be fixed quickly.

**Honest testing note (older features):** I tested the whole web page in a real headless Chrome (cut/move/undo, drag and drop reorder, audio merge, video export order, projects list/delete) against a stand-in server that uses the same ffmpeg code. Django and PostgreSQL were not installable in my test machine, so the Django code itself has NOT been run. Expect to fix a small thing or two on first run - paste any error to me.

## 1b. NEW: click a person, drag them, clean background (AI)
How it works when you click a person:
1. The browser sends the picture + your click to `/api/image/segment/`. **YOLO** finds all people, the one under your click is chosen, and **SAM** draws its exact outline. You get back the person as a transparent PNG (clean edge, no old background colour at the border).
2. You can drag at once. Only the person's own pixels grab (pressing on the background does nothing), and the person has a yellow outline that follows the body.
3. In the background the browser sends the picture + mask to `/api/image/inpaint/`. **LaMa** fills the empty place (it continues grass / leaves / walls instead of smearing). When it is ready it replaces the quick fill. Apply waits for it.
4. When you drop the person, the colours are matched to the new place: the average colour/brightness around the OLD place is compared with the one around the NEW place and the person is shifted by the difference (brightness fully, colour half, so a pink saree stays pink). Slider **Match colours**: 0 = off. **Soft shadow** adds a flat shadow at the feet (switch it off if the feet are outside the photo).

Install the AI packages once (Python **3.10 - 3.12** recommended; they bring PyTorch, about 1-2 GB):
```powershell
pip install -r requirements-ai.txt
python manage.py check_ai
```
`check_ai` loads the 3 models and prints OK / FAILED for each. The FIRST run downloads them from the internet (YOLO ~20 MB, SAM ~40 MB, LaMa ~200 MB), so the first click takes a while. Without these packages the website still works, the click shows a message, and "Draw outline instead" keeps working.

CPU only is fine: a click takes a few seconds, the background fill roughly 5 - 20 seconds depending on the PC.

## 2. Install (Windows, one time)
1. **Python 3.10 - 3.13**: https://www.python.org/downloads  (tick **"Add python.exe to PATH"**). Check: `python --version`
2. **PostgreSQL**: https://www.postgresql.org/download/windows/ (the EDB installer). Remember the password you set for user `postgres`. Keep port 5432. This also installs **pgAdmin 4** and **SQL Shell (psql)**.
3. **FFmpeg**: you already installed it (`ffmpeg -version` works).

## 3. Create the PostgreSQL database
Start Menu -> **SQL Shell (psql)** -> press Enter for Server / Database / Port / Username (defaults), type your postgres password, then run:
```sql
CREATE DATABASE multimedia_db;
```
(You should see `CREATE DATABASE`. Type `\q` to leave.)
Or in pgAdmin: right-click Databases -> Create -> Database -> name `multimedia_db`.

## 4. Run the project
Open PowerShell in the folder that contains `manage.py`:
```powershell
cd "D:\path\to\multimedia_django_project"
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
notepad .env
```
In `.env` set `DJANGO_SECRET_KEY` (any long text) and `DB_PASSWORD` (your postgres password), then save. Continue:
```powershell
python manage.py makemigrations studio
python manage.py migrate
python manage.py runserver
```
Open **http://127.0.0.1:8000** in Chrome. Click "Create an account", register, and you are in.

If `Activate.ps1` is blocked: `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`

Optional (admin panel to show your examiner the database rows): `python manage.py createsuperuser`, then open http://127.0.0.1:8000/admin

## 5. How to test each feature
1. **Register / login** - works, wrong password shows an error.
2. **Images** - "Pick images" -> **click on ONE person** -> wait for "Finding the person..." -> drag that person (only their body grabs) -> try Size, Match colours, Soft shadow -> wait until the hint stops saying "Filling the empty place..." -> "Apply" -> look at the old spot: it should look like real background -> Undo / Redo / Reset -> "Download PNG" and "Save project". Fallback without AI: "Draw outline instead" -> draw around the person -> "Cut out".
3. **Audio** - "Add audio files" (2-3 files) -> drag the ☰ handle (or use ↑ ↓) -> "Combine in this order" -> play the result and check the order -> Download MP3.
4. **Video** - "Pick a video" (MP4, short is faster) -> "Split equally into 3" -> drag clip 2 to the top -> "Combine & export video" -> watch the result.
5. **My projects** - all exports are listed; Open / Delete work. Check PostgreSQL: pgAdmin -> multimedia_db -> Tables -> `studio_project`.

## 6. Common errors
| Problem | Fix |
|---|---|
| `python` not recognized | Reinstall Python with "Add to PATH", reopen PowerShell |
| `ModuleNotFoundError: No module named 'django'` | The venv is not active: run `.\venv\Scripts\Activate.ps1`, then `pip install -r requirements.txt` |
| `password authentication failed for user "postgres"` | Wrong `DB_PASSWORD` in `.env` |
| `database "multimedia_db" does not exist` | Do step 3 |
| `connection refused` / `could not connect` | PostgreSQL service is not running: Win+R -> `services.msc` -> start "postgresql-x64-..." |
| `no such table: studio_project` / `relation "studio_project" does not exist` | Run `python manage.py makemigrations studio` then `python manage.py migrate` |
| `Could not start "ffmpeg"` | Reopen PowerShell, or set `FFMPEG_PATH` in `.env` to the full path of ffmpeg.exe |
| Video does not show / "cannot play" | Use an MP4 (H.264). Other formats may not play in the browser preview |
| Click on a person says "AI packages are not installed" | `pip install -r requirements-ai.txt` (venv active, Python 3.10-3.12), restart the server |
| Click says "Could not load the ... model" | First run needs internet to download the model; run `python manage.py check_ai` to see which one |
| Toast "LaMa is not available, basic fill used" | The LaMa model could not load; the fill still works but is blurrier. Run `check_ai` and read the error of step 3 |
| Click selects only part of a person / a neighbour | Click on the middle of the body (torso), not on the edge. Overlapping people are the hardest case |
| Red message "File type ... not allowed" | Allowed: jpg/png/webp, mp3/wav/m4a/aac/ogg/flac, mp4/mov/mkv/webm |
| Want to quickly test without PostgreSQL | In `.env` add `USE_SQLITE=1` (use PostgreSQL for the final submission) |
| Open from a phone | Run `python manage.py runserver 0.0.0.0:8000` and open `http://<PC-IP>:8000` (same Wi-Fi; allow port 8000 in Windows Firewall). Drag-and-drop with the finger may not work - use the ↑ ↓ buttons |

## 7. For your report / viva
- **Security:** hashed passwords and sessions (Django auth), CSRF token on every request, login required for every API, file-type whitelist, size limits, uploaded files saved under random names, ffmpeg started with an argument list (no shell), users can only see and delete their own projects.
- **Limits:** the AI is not perfect: overlapping people (hugging, holding hands) can give a rough edge or include a bit of the neighbour; the area that was hidden BEHIND the person is invented by LaMa (it looks natural but it is not the real scene; where it had to invent another person's body it can look odd); hair strands and see-through cloth edges are approximate; colour matching is an average shift, not real relighting; audio/video processing needs ffmpeg on the server; exported files are served by Django only in development (DEBUG=1) - use a real web server for deployment.
- **Future work:** click refinement (extra + / - points to fix a bad edge), real relighting and shadow direction, GPU support, user-selectable output formats, background job queue (Celery) for long videos.

## 8. Final checklist
- [ ] `python manage.py runserver` starts without errors and the page opens
- [ ] Register, logout, login; wrong password shows an error
- [ ] `python manage.py check_ai` shows OK for YOLO, SAM and LaMa
- [ ] Images: click a person / drag / resize / Match colours / apply; undo, redo, reset; PNG download; Save project
- [ ] Audio: reordered by drag and drop; merged file plays in the right order
- [ ] Video: split into 3; middle clip moved first; exported video plays in the new order
- [ ] My projects shows the exports; delete works
- [ ] PostgreSQL table `studio_project` has rows (screenshot from pgAdmin)
- [ ] Screenshots of every tab; limits written in the report
- [ ] Remove `venv`, `.env`, `media` and `__pycache__` folders before zipping for submission
