FROM python:3.13-slim

LABEL org.opencontainers.image.source="https://github.com/gateszhangc/googletrendes" \
      org.opencontainers.image.description="Google Trends dashboard" \
      org.opencontainers.image.licenses="MIT"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8765

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY scripts ./scripts
COPY web ./web
COPY data/google_trends.sqlite ./data/google_trends.sqlite

EXPOSE 8765

CMD ["python", "scripts/serve_trends_dashboard.py", "--web", "web", "--host", "0.0.0.0", "--port", "8765"]
