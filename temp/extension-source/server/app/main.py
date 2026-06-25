import json
import logging
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from .config import get_settings
from .db import engine
from .routes import account, admin, auth, billing

class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        log_record = {
            'timestamp': self.formatTime(record, self.datefmt),
            'level': record.levelname,
            'message': record.getMessage(),
            'module': record.module,
            'lineno': record.lineno,
        }
        for key, value in record.__dict__.items():
            if key not in {
                'args', 'asctime', 'created', 'exc_info', 'exc_text', 'filename',
                'funcName', 'levelname', 'levelno', 'lineno', 'module', 'msecs',
                'msg', 'name', 'pathname', 'process', 'processName',
                'relativeCreated', 'stack_info', 'thread', 'threadName'
            }:
                log_record[key] = value
        if record.exc_info:
            log_record['exc_info'] = self.formatException(record.exc_info)
        return json.dumps(log_record)

logger = logging.getLogger("media_assist")
handler = logging.StreamHandler()
handler.setFormatter(JsonFormatter())
logger.addHandler(handler)
logger.setLevel(logging.INFO)
logger.propagate = False

settings = get_settings()
app = FastAPI(title='Media Assist Licensing API', version='1.0.0', docs_url='/docs' if settings.environment != 'production' else None, redoc_url=None)

@app.middleware('http')
async def log_requests(request: Request, call_next):
    request_id = request.headers.get('x-request-id', str(uuid.uuid4()))
    start_time = time.monotonic()
    extra = {'request_id': request_id, 'method': request.method, 'path': request.url.path}
    logger.info(f"Incoming request: {request.method} {request.url.path}", extra=extra)
    try:
        response = await call_next(request)
        process_time = time.monotonic() - start_time
        logger.info(
            f"Completed request: {request.method} {request.url.path} with status {response.status_code} in {process_time:.4f}s",
            extra={**extra, 'status_code': response.status_code, 'duration': process_time}
        )
        response.headers['x-request-id'] = request_id
        return response
    except Exception as exc:
        process_time = time.monotonic() - start_time
        logger.error(
            f"Request failed: {request.method} {request.url.path} - {str(exc)}",
            exc_info=exc,
            extra={**extra, 'duration': process_time}
        )
        raise

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
