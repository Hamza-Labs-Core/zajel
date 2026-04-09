FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src/ src/
COPY migrations/ migrations/
RUN npm run build

FROM node:20-slim

WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/migrations/ migrations/

ENV ZAJEL_HOST=0.0.0.0
ENV ZAJEL_PORT=9000
EXPOSE 9000

CMD ["node", "dist/index.js"]
