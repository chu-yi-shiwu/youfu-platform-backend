# 优服家后端容器镜像（CloudRun 容器型服务）
# 后端为 ESM + tsx 直接运行 TS，无需先编译；镜像内 npm install 全量依赖后 npm start。
FROM node:22-slim
WORKDIR /app

# 先装依赖（利用层缓存）；无 lockfile 时用 npm install 解析 package.json
COPY package.json ./
RUN npm install

# 再拷源码（含 001_*.sql 迁移、scripts、src）
COPY . .

ENV NODE_ENV=production
EXPOSE 4001
CMD ["npm", "start"]
