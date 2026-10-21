from django.urls import path

from . import views

urlpatterns = [
    # pages
    path("", views.index, name="index"),
    path("login/", views.login_view, name="login"),
    path("register/", views.register_view, name="register"),
    path("logout/", views.logout_view, name="logout"),
    # JSON API used by the JavaScript
    path("api/projects/", views.project_list),
    path("api/projects/<int:pk>/", views.project_detail),
    path("api/image/save/", views.image_save),
    path("api/image/segment/", views.image_segment),
    path("api/image/inpaint/", views.image_inpaint),
    path("api/audio/merge/", views.audio_merge),
    path("api/video/export/", views.video_export),
]
