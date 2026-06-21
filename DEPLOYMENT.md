# 抓马哈网站发布说明

这个项目是 React 前端 + Node/Express + Socket.IO 后端的一体化实时游戏。发布时不要使用纯静态托管，必须使用支持长连接 WebSocket 的 Node Web Service。

## 推荐：Render

1. 将当前项目上传到 GitHub 仓库。
2. 在 Render 选择 New Blueprint，并选择该仓库。
3. Render 会读取 `render.yaml`，服务名已经设置为 `drawmaha`。
4. 部署完成后通常会得到类似 `https://drawmaha.onrender.com` 的公开网址。
5. 如果要使用自定义域名，例如 `drawmaha.com` 或 `play.drawmaha.com`，需要先拥有该域名，然后在 Render 的 Custom Domains 中添加域名，并按提示配置 DNS。

构建命令：

```bash
corepack enable && pnpm install --frozen-lockfile && pnpm build
```

启动命令：

```bash
pnpm start
```

## Docker 发布

支持任何可运行 Docker 的平台：

```bash
docker build -t zhuamaha-web .
docker run -p 3001:3001 zhuamaha-web
```

本地访问：

```text
http://localhost:3001
```

## 注意

- 线上平台必须支持 WebSocket，否则实时下注、聊天、房间状态同步会失效。
- 服务端使用 `PORT` 环境变量，Render/Railway/Fly 等平台会自动注入。
- 第一版仍是熟人娱乐局，没有账号系统和真钱支付。
