FROM node:22.22.0-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22.22.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg util-linux ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app /app
ENV NODE_ENV=production HOST=127.0.0.1
USER node
CMD ["npm", "start"]
