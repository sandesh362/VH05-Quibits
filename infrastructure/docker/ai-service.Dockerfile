# FastAPI RAG service image.
#
# Build context is the REPO ROOT for consistency with the other images:
#   docker build -f infrastructure/docker/ai-service.Dockerfile .

# --------------------------------------------------------------------------
# Stage 1: build wheels into a virtualenv
# --------------------------------------------------------------------------
FROM python:3.11-slim AS build

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Some wheels need a compiler; kept in the build stage only.
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential \
  && rm -rf /var/lib/apt/lists/*

# A venv is the cleanest thing to copy into the runtime stage.
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY ai-service/requirements.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt

# --------------------------------------------------------------------------
# Stage 2: runtime
# --------------------------------------------------------------------------
FROM python:3.11-slim AS production

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHON_ENV=production \
    RAG_SERVICE_HOST=0.0.0.0 \
    RAG_SERVICE_PORT=8000

# tini gives PID 1 proper signal handling for graceful shutdown.
# Tesseract is required for the OCR fallback in Phase 3 (scanned PDFs). The
# language pack for `ocr` is installed so OCR_LANGUAGE=eng works out of the box.
# Ghostscript is pulled by PyMuPDF's rendering path for some PDF types.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini tesseract-ocr tesseract-ocr-eng \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 1001 appuser

WORKDIR /app

COPY --from=build /opt/venv /opt/venv
COPY --chown=appuser:appuser ai-service/app ./app
COPY --chown=appuser:appuser ai-service/pyproject.toml ./

RUN mkdir -p /app/storage && chown -R appuser:appuser /app/storage

USER appuser

EXPOSE 8000

ENTRYPOINT ["/usr/bin/tini", "--"]
# Single worker: Phase 1 is I/O bound and state must stay simple. Revisit when
# the RAG pipeline lands.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
