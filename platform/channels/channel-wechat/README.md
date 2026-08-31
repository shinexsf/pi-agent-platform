# channel-wechat

WeChat iLink ClawBot channel package. Implements `ChannelPackage` (backend) + `ChannelAdminPage` (frontend).

## ⚠️ iOS-only 约束

`@wechatbot/wechatbot` 是 iLink ClawBot SDK,**仅支持 iOS 客户端登录**。Android / iPad / Windows / macOS 微信无法登录。
**必须在 admin 页脚 / 安装文档明确告知用户**。

## 开发状态

- ✅ Backend 注册逻辑 + routes + mock adapter
- ✅ Admin UI (channels list + create + start/stop)
- ⏸️ 真实 SDK 集成:`adapter.ts` 当前是 mock,等 `@wechatbot/wechatbot` SDK spike 完成后替换

## Channel ID 命名规则

`ch_<8位随机>` — 避免与 IDE / web UI 的 agent id 冲突。

## 路由

- `GET    /api/im/wechat/channels`              列表
- `POST   /api/im/wechat/channels`              创建
- `GET    /api/im/wechat/channels/:id`          详情
- `PATCH  /api/im/wechat/channels/:id`          修改
- `DELETE /api/im/wechat/channels/:id`          删除
- `POST   /api/im/wechat/channels/:id/start`    启动(触发扫码登录)
- `POST   /api/im/wechat/channels/:id/stop`     停止(退出登录)

## License

`@wechatbot/wechatbot` license 见 npm 页面。WeChat 商标 / 接口版权归腾讯所有。