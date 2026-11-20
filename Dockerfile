# 优服家后端容器镜像（P0-2 2026-11-04：Node22 + 编译产物，多阶段构建）
#
# 背景：原镜像用 `tsx` 直接跑 TS，且 `npm start` 依赖 tsx 在运行时存在。
#   生产 ECS 又走 `node dist/server.js`（Node16）。两条部署链行为不一致：
#   - 容器里跑的是源码解释执行，ECS 跑的是编译产物；
#   - 容器未做构建，类型错误要到运行时才暴露；
#   - 运行时携带全量 devDependencies，攻击面/镜像体积都偏大。
# 现统一为「构建阶段 tsc → 运行阶段只带 dist + 生产依赖」，两条链同构。

# ---------- 构建阶段 ----------
FROM node:22-slim AS builder
WORKDIR /app

# 先装全量依赖（含 devDependencies：typescript 在 devDeps）
COPY package.json package-lock.json ./
RUN npm ci

# 只拷构建所需文件，最大化层缓存
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4001

# 只装生产依赖（tsx 仍在 dependencies：迁移/种子脚本运行时需要）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 编译产物
COPY --from=builder /app/dist ./dist

# 运行时需要的非 TS 资源（缺一不可）：
#   *.sql             迁移通道按仓根扫描（dist/db/migrate.js → /app）
#   seeds/            演示/初始化种子，不进入自动迁移
#   pending-migrations/ 人工审批迁移留档（自动通道不会扫到）
#   data/             aiPreview 规则库（dist/routes → ../../data）
#   public/           管理页 HTML 外壳（dist/server.js → ../../public）
COPY *.sql ./
COPY seeds ./seeds
COPY pending-migrations ./pending-migrations
COPY data ./data
COPY public ./public

EXPOSE 4001
# 用 exec 形式让 node 直接收到 SIGTERM（P0-8 优雅停机依赖它）
CMD ["node", "dist/server.js"]
