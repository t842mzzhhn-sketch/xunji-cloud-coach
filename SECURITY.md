# Security Policy

## 支持范围

安全修复以 `main` 分支最新版本为准。个人部署者应在更新前运行测试并保留可回滚版本。

当前源码审查、已知风险和上线前检查见 [`docs/security-review.md`](docs/security-review.md)。本项目是单用户参考实现，尚未经过独立第三方安全审计。

## 报告漏洞

请使用 GitHub 仓库的 **Security → Report a vulnerability** 私密报告功能。不要在公开 Issue 中包含：

- 训记 API Key；
- Cloudflare Secret、KV ID 或 OAuth token；
- 真实 Worker 授权地址；
- 睡眠、心率、HRV、血压、体重、饮食或训练记录；
- 可以识别个人身份的截图或日志。

报告应包含受影响版本、复现步骤、预期与实际行为，以及去除个人数据后的最小证据。

## 部署者责任

- 使用独立的至少 32 字符随机 `CONNECTOR_PASSWORD`，并确认 Secret 已实际设置；
- 只通过 Cloudflare Secrets 保存正式凭据；
- 限制 GitHub、Cloudflare 与训记账号访问权限；
- 不公开带真实数据的演示实例；
- 定期撤销不再使用的 OAuth 客户端和访问令牌；
- 在写入训练前检查摘要并明确确认；
- 发现疑似重复写入时先停止自动任务并核对训记记录。
- 发布源码时只发布 Git 跟踪文件，不要把含忽略文件的整个工作目录打包上传；
- 公开截图前移除身份、健康指标、时间地点、Worker URL、账号 ID 与全部凭据。

## 已知边界

- 这是单用户参考实现，不是经过第三方审计的多租户服务；
- Cloudflare KV 是最终一致存储，不提供传统数据库事务；
- 上游训记接口和 ChatGPT 连接器界面可能发生变化；
- Worker 不读取 Apple Health，Health 权限与数据处理由调用端负责；
- 本项目不能替代医疗判断。
