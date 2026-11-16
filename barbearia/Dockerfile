FROM node:22-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production TRUST_PROXY=1 DATA_DIR=/data PORT=3100
VOLUME /data
EXPOSE 3100
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
