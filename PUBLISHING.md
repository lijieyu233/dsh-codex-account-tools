# 打包与公开发布

## 交付物

`dsh-codex-account-tools-1.1.0.tgz` 是标准 npm tarball，供 DSH 插件管理器按本地绝对路径安装。它不是账号备份，里面不应包含任何账号或登录凭据。

发布内容采用白名单：

- 包元数据
- 三个运行时 JavaScript 文件（服务端、客户端、账号库）
- Cordis bundle patch
- 兼容版本声明
- 使用与发布说明

禁止包含：`backups/`、`artifacts/`、`test/`、开发安装脚本、`node_modules/`、profile 配置、账号 JSON、登录令牌、个人截图、机器绝对路径。

## 从开发源码重新打包

```sh
node --test test/vault.test.mjs
npm pack --dry-run --json --ignore-scripts
```

确认白名单后：

```sh
mkdir release
npm pack --json --ignore-scripts --pack-destination release
node scripts/verify-package.mjs
```

校验脚本读取真实压缩包，检查文件路径白名单、文件完整性、SHA-256、客户端与服务端入口及敏感信息模式，并在临时目录解包后运行模块加载和 RPC 冒烟检查。它不联网、不读取 DSH 凭据，不修改运行中的插件。

## 发布渠道与归属

- 仓库：<https://github.com/lijieyu233/dsh-codex-account-tools>。
- 许可证：MIT，版权所有者 `lijieyu233`，完整文本见 `LICENSE`。
- 安装资产：GitHub Release `v1.1.0` 下的版本化 `.tgz` 和 SHA-256 校验文件。
- npm 尚未发布；将来如需 npm 发布，应先确认目标账号和包名权限，不要把 GitHub 发布当作已发布 npm。
- 目前只实测 DSH `0.2.1-rc.2` 与订阅插件 `3.2.6`。只对已经验收的组合扩大兼容声明。

## 申请市场收录

按 [awesome-dsh-plugin 投稿指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)，在其 `data/plugins/` 增加本插件的一条 YAML，通过 PR 申请；不要手动编辑其生成的 README。插件仓库需创建满 1 天，带 `dsh-plugin` topic，且有真实可安装代码。预构建包使用钉住版本标签的 GitHub Release 地址。

收录提交、CI 通过、维护者合并和市场索引刷新是不同阶段，不应混为已经上架。
