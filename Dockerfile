FROM python:3.11-slim

# Optional: Um schneller zu bauen und weniger Fehler mit SSL/DNS zu haben
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies zuerst kopieren (Caching)
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Restliche App kopieren
COPY . /app

# Environment für FastAPI / Uvicorn
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

# Expose Port (für Doku – Koyeb überschreibt, aber schadet nicht)
EXPOSE 8000

# Startbefehl – nutzt PORT, falls Koyeb den setzt
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
