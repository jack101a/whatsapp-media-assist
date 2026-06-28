from __future__ import annotations

from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import text

from .config import get_settings
from .db import engine
from .routes import account, admin, auth, billing, admin_dashboard
from .backups import start_backup_scheduler, stop_backup_scheduler

settings = get_settings()
app = FastAPI(title='WhatsApp Media Assist Licensing API', version='1.0.0', docs_url='/docs' if settings.environment != 'production' else None, redoc_url=None)

# Mount static files and templates
app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")
templates = Jinja2Templates(directory=Path(__file__).parent / "templates")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origin_list,
    allow_origin_regex=r'^(chrome-extension|moz-extension)://[a-z0-9-]+$',
    allow_credentials=False,
    allow_methods=['GET', 'POST', 'DELETE', 'OPTIONS'],
    allow_headers=['Authorization', 'Content-Type', 'X-Admin-Key'],
)

app.include_router(auth.router)
app.include_router(account.router)
app.include_router(billing.router)
app.include_router(admin.router)
app.include_router(admin_dashboard.router)


@app.on_event("startup")
def on_startup():
    start_backup_scheduler()
    from .db import SessionLocal
    from .services import seed_default_templates
    db = SessionLocal()
    try:
        seed_default_templates(db)
    finally:
        db.close()


@app.on_event("shutdown")
def on_shutdown():
    stop_backup_scheduler()


@app.get('/admin-dashboard', response_class=HTMLResponse)
def serve_admin_dashboard(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("admin_dashboard.html", {"request": request})


@app.get('/privacy-policy', response_class=HTMLResponse)
def serve_privacy_policy(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("privacy_policy.html", {"request": request})


@app.get('/healthz')
def health() -> dict[str, str]:
    return {'status': 'ok'}


@app.get('/readyz')
def ready() -> dict[str, str]:
    with engine.connect() as connection:
        connection.execute(text('SELECT 1'))
    return {'status': 'ready'}


@app.exception_handler(Exception)
async def unhandled_exception(_, exc: Exception):
    if settings.environment != 'production':
        return JSONResponse(status_code=500, content={'detail': str(exc)})
    return JSONResponse(status_code=500, content={'detail': 'Internal server error'})
