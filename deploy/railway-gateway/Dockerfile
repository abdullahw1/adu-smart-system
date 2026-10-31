FROM jpillora/chisel:1.13.0 AS tunnel
FROM node:22.22.0-alpine
COPY --from=tunnel /ko-app/chisel /usr/local/bin/chisel
WORKDIR /app
COPY start.mjs ./
USER node
CMD ["node", "start.mjs"]
