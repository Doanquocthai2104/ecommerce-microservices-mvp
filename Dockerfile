FROM node:24-bookworm-slim

ARG APP_PATH

ENV NODE_ENV=production

WORKDIR /app

# Giu nguyen cau truc de cac duong dan require/proto hoat dong.
COPY proto/ /app/proto/
COPY shared/ /app/shared/

WORKDIR /app/${APP_PATH}

# Copy ca scripts truoc khi npm ci de postinstall cua KafkaJS chay duoc.
COPY ${APP_PATH}/ ./

RUN npm ci --omit=dev --foreground-scripts \
    && npm cache clean --force

USER node

CMD ["node", "src/server.js"]