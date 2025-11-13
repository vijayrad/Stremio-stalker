# --- Build a lightweight Node runtime for the app ---
FROM node:20-alpine AS app

# Set working directory
WORKDIR /app

# Install only production dependencies
# Copy package manifests first to leverage Docker layer caching
COPY newstalker/package*.json ./

# Prefer npm ci if a lockfile exists; otherwise fallback to npm install
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Copy the rest of the source code
COPY newstalker/ .

# Environment
ENV NODE_ENV=production \    PORT=7100

# Expose the app port
EXPOSE 7100

# Healthcheck (optional): hits the root path; adjust if your app has a health endpoint
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://localhost:7100/ || exit 1

# Default command
CMD ["node", "index.mjs"]
