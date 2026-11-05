FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV NODE_ENV=production TRUST_PROXY=1 DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
