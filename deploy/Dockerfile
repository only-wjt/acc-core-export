FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates wget gnupg \
    libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 \
    libasound2 libxshmfence1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    fonts-liberation \
  && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-linux.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install chromium
COPY . .

ENV HOST=0.0.0.0
ENV PORT=3780
ENV CHROME_PATH=/usr/bin/google-chrome-stable
ENV PERSIST_DIR=/data
EXPOSE 3780
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3780/health || exit 1

CMD ["node", "server/index.js"]
