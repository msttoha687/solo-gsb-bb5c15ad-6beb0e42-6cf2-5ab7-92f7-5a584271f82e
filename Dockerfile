FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# 先拷贝依赖清单，充分利用镜像层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

EXPOSE 3000

# 单进程即可，无需常驻守护
CMD ["node", "server.js"]
