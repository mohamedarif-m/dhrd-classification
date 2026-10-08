# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — Build the React UI
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS ui-build

WORKDIR /build

# Copy workspace manifests first for better layer caching
COPY package.json package-lock.json ./
COPY packages/ui/package.json ./packages/ui/
COPY apps/hawaii-shell/package.json ./apps/hawaii-shell/

# Install all workspace dependencies
RUN npm ci --ignore-scripts

# Copy source
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY tsconfig.base.json ./

# Build the app — output lands in apps/hawaii-shell/dist/
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — Python server + built UI
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim

WORKDIR /app

# Install Python dependencies
COPY server/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy the FastAPI application
COPY server/app ./app
COPY server/app/registry.json ./app/registry.json

# Copy the built UI from stage 1
COPY --from=ui-build /build/apps/hawaii-shell/dist ./static

# Code Engine exposes port 8080 by default
ENV PORT=8080
ENV STATIC_DIR=/app/static
# ALLOWED_ORIGIN is not needed in production (same-origin — server serves UI)

EXPOSE 8080

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --log-level info"]
