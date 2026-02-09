FROM node:18-alpine

# Install ffmpeg for video thumbnail generation
RUN apk add --no-cache ffmpeg openssl

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY server.js ./
COPY public/ ./public/

# Create necessary directories
RUN mkdir -p uploads .trash .data certs

# Generate self-signed SSL certificates
RUN openssl req -x509 -newkey rsa:4096 \
    -keyout certs/key.pem \
    -out certs/cert.pem \
    -days 365 -nodes \
    -subj "/CN=localhost"

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-check-certificate -q --spider https://localhost:3000/api/auth/status || exit 1

# Run as non-root user
RUN addgroup -S blackdrop && adduser -S blackdrop -G blackdrop
RUN chown -R blackdrop:blackdrop /app
USER blackdrop

CMD ["node", "server.js"]
