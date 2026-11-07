# Codex 账号工具（DSH 配套插件）

为 `dsh-codex-subscription` 3.x 提供独立的账号 JSON 导入、预览和导出，不修改订阅插件源码，也不修改模型或代理设置。

## 安装发布包

当前实测：**DSH 0.2.1-rc.2 + dsh-codex-subscription 3.2.6**。其他版本尚未进行实机验收。本插件依赖订阅插件 3.2.6～3.x 的内部账号库格式；订阅插件升级后需重新核验。

1. 先在目标 DSH 中安装并启用上游 [Codex 订阅](https://github.com/WSL043/dsh-codex-subscription) 插件。
2. 从 [GitHub Release](https://github.com/lijieyu233/dsh-codex-account-tools/releases/tag/v1.1.0) 下载 `dsh-codex-account-tools-1.1.0.tgz` 到运行 DSH 的那台电脑。
3. 打开 **插件 → 添加插件**，输入这个 `.tgz` 文件在宿主上的**绝对路径**，例如：

   ```text
   C:/Downloads/dsh-codex-account-tools-1.1.0.tgz
   ```

4. 确认安装，按 DSH 提示刷新或重新加载。然后进入 **设置 → Codex 账号工具**。

已具备 `dsh` 命令的环境也可使用（按实际 profile 修改）：

```sh
dsh plugin --profile desktop add "C:/Downloads/dsh-codex-account-tools-1.1.0.tgz"
```

该路径必须属于 **DSH 宿主电脑**，不是连接它的另一台浏览器电脑。不需要解压，不需要手工修改凭据。也可以在支持 HTTPS tarball 的 DSH 插件添加页面输入下列固定版本地址：

```text
https://github.com/lijieyu233/dsh-codex-account-tools/releases/download/v1.1.0/dsh-codex-account-tools-1.1.0.tgz
```

公开 npm 包尚未上传，不要直接搜索未发布的包名安装。本项目为独立配套插件，不由 OpenAI、DeepSeek 或上游订阅插件作者维护或背书。

## 使用

- 设置 → **Codex 账号工具**，或插件 → **dsh-codex-account-tools** 配置页。
- 粘贴 JSON 或选择 JSON 文件，点击「校验并预览」，确认新增/更新/保持不变的数量，再点击「确认导入」。
- 勾选要导出的账号，下载脱敏清单或完整备份。完整备份必须再次确认，包含明文登录令牌，请保存到可信位置。
- 不会自动复制令牌到剪贴板，不记录原始 JSON，不发起 OpenAI 在线验证。

支持：单账号对象、数组、`{accounts:[...]}`、本工具备份、Codex CLI `{tokens:{...}}`、DSH `{credential:{...}}`。

```json
{
  "email": "you@example.com",
  "access_token": "YOUR_ACCESS_TOKEN",
  "refresh_token": "YOUR_REFRESH_TOKEN",
  "id_token": "OPTIONAL_ID_TOKEN",
  "account_id": "OPTIONAL_ACCOUNT_ID"
}
```

`id_token`、`account_id` 可省略；未知过期时间记为 0，让订阅插件决定是否刷新，绝不捏造一个未来有效期。JWT 解码仅提取本地元数据，不代表令牌验签或认证/订阅有效。

## 安全边界

- 所有账户操作经宿主已认证的 `/api` 桥及 `ctx.credentials.modifyRecord` 文件锁事务；没有自己实现 YAML 写入。
- 校验整个批次后合并；保留现有账号、内部 ID、标签、扩展元数据、当前选中账号及 legacy 标记。
- 去重匹配 access token，或 account ID + JWT 用户 ID/sub；不会仅因同一组织 account ID 相同而合并不同用户。
- 预览后账号库发生变化（包括令牌刷新）会拒绝写入，要求重新预览，防止覆盖并发更新。
- 已有账号库损坏或版本未知时停止操作，不将异常默认为空库。
- 更新 legacy 账号时同步旧版兼容引用；同步失败会明确告知，不假称整个导入回滚。
- 脱敏清单不含 token，不能恢复账号；完整备份为明文，持有者可能使用账号。
- 每次最多 100 个账号、2 MB JSON。切换、移除、刷新认证状态仍由 Codex 订阅负责。

## 开发者：从源码本地安装/更新

以下命令仅适用于完整开发源码；发布的 `.tgz` 不包含开发脚本和测试。普通用户请使用上面的 DSH 安装方式。

源码长期保存于此目录，不依赖在另一个插件内打补丁：

```sh
node scripts/install.mjs
```

安装前把旧插件代码和 profile 配置备份到 `backups/<timestamp>/`，仅更新自己的插件文件和 dependency/bundle。dependency 指向此源码目录的 `file:` 本地依赖，避免包管理器试图下载不存在的公开版本。不会读取或备份账号令牌。

运行中的 DSH 可用宿主插件管理 API 的同态启用操作触发 HMR，再刷新当前 GUI；以宿主返回 `application: applied` 为生效证据。若返回 restart-required，不得声称热更已生效。不启动替代 DSH 服务。

紧急停用（只删除本插件的 bundle/dependency，不影响其他插件和账号）：

```sh
node scripts/disable.mjs
```

随后重新加载 DSH。备份目录保存旧代码供调查，不建议恢复有已知连接问题的 1.0.0。

## 验证

```sh
node --test test/vault.test.mjs
```

单元测试在真实临时文件上检查事务、格式、去重、并发预览冲突、导出安全与严格 RPC Request/Response。它们不替代真实宿主验证。

首次发布前，还在 Windows 的真实 Electron 窗口中验证了账号列表、非法 JSON 拒绝、实际文件选择、脱敏下载、完整备份确认及重复导入往返。重复导入结果为新增 0、更新 0、保持不变 3，宿主账号库 revision 和当前选中账号均未改变。此记录不代表 OpenAI 认证或订阅有效性检查。

本机带认证的验证辅助脚本、截图和账号数据不进入公开仓库或发布包。公开的回归测试仅使用生成的测试令牌和隔离临时文件。

## 许可证

[MIT](LICENSE) © 2026 lijieyu233。上游 Codex 订阅插件单独分发，本项目不捆绑或重新发布其代码。
