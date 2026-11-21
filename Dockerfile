# StockRadar runs on the Node standard library only: no npm install needed.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5173 \
    TZ=Asia/Shanghai \
    DATA_DIR=/app/data

COPY package.json server.js ./
COPY lib ./lib
COPY scripts ./scripts
COPY public ./public
COPY data ./data
COPY deploy/docker-entrypoint.sh /usr/local/bin/entrypoint.sh

# Accounts, sessions, watchlists and synced snapshots live here; mount a volume.
RUN mkdir -p /app/data/watchlists /app/.cache/history \
 && chmod +x /usr/local/bin/entrypoint.sh /app/scripts/daily-sync.sh
VOLUME ["/app/data"]

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5173)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]
