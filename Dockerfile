# Works on any container host (Fly.io, Railway, Koyeb, Cloud Run...).
# Mount a volume at /data to keep documents across deploys.
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/docs-lite.db
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["npm", "start"]
