# Standalone Node.js 24 build for Nhân Hòa Vibe Hosting (Git source).
# Provider reverse proxy terminates public HTTPS; container listens on HTTP.
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node . /app
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
