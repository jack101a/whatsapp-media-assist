FROM python:3.13-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
RUN addgroup --system mediaassist && adduser --system --ingroup mediaassist mediaassist
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app
RUN chown -R mediaassist:mediaassist /app
USER mediaassist
EXPOSE 8787
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8787 --workers 1 --proxy-headers --forwarded-allow-ips=*"]
