# R2 生产桶与私有配置

现有 `.env.local` 的两只 `-test` 桶用于 M7 测试。生产部署使用另建的两只私有桶及分别限定到单桶的凭据；本机开发配置保持原用途。

## 1. 创建两个桶

登录原来的 Cloudflare 账号，选择原来测试桶所在的账户，进入 **Storage & databases → R2 → Overview**。点击 **Create bucket（创建存储桶）**，先创建 journal 桶，再用相同步骤创建 backup 桶：

| 用途 | 建议桶名 | 默认存储类别 | 位置 |
|---|---|---|---|
| 删除 journal | `chatapp-journal-prod` | Standard | Automatic |
| 加密 backup | `chatapp-backup-prod` | Standard | Automatic |

每次在 Bucket name 填入对应桶名；Default storage class 选择 **Standard**，Location 保留 **Automatic**，然后确认创建。其他创建选项保留默认，不选司法辖区专用配置；脚本复用当前账号的普通 S3 endpoint。

进入每只桶的 **Settings（设置）**，确认 **Public Development URL（公开开发 URL）** 为 Disabled，**Custom Domains（自定义域名）** 没有连接的域名。当前不新增 CORS、自动删除生命周期或桶锁规则，保留由应用负责的 journal/checkpoint 和 restic 保留策略。两只新桶保持空桶即可，不需要复制测试对象或手动上传文件。

桶默认不公开；公开开发 URL 和自定义域名是两个独立的公开入口，都应保持关闭。来源：[创建桶](https://developers.cloudflare.com/r2/buckets/create-buckets/)、[公开访问](https://developers.cloudflare.com/r2/buckets/public-buckets/)、[数据位置与司法辖区](https://developers.cloudflare.com/r2/reference/data-location/)。

## 2. 创建两个独立凭据

回到 R2 Overview，在 Account Details 的 API Tokens 旁选择 Manage。优先创建账户级 API token；若账号角色只能创建用户级 token，可用当前账户用户创建的 R2 token，保持同样的单桶权限。

| 凭据用途 | 建议名称 | 权限 | 只授权的桶 |
|---|---|---|---|
| journal | `chatapp-journal-prod-rw` | Object Read & Write | `chatapp-journal-prod` |
| backup | `chatapp-backup-prod-rw` | Object Read & Write | `chatapp-backup-prod` |

先填写 journal 凭据的名称，在 Permissions 选择 **Object Read & Write（对象读写）**。在桶范围选择只应用到指定桶，再只勾选 `chatapp-journal-prod`，确认创建。回到管理页，用相同步骤创建 backup 凭据，只勾选 `chatapp-backup-prod`。每个凭据都只有一只桶的权限，且两个 Access Key ID 应不同。

有效期不设到期，后续按运维计划单独轮换；可选客户端 IP 过滤先保留默认，恢复设备需要使用它自己的恢复凭据。应用不需要桶创建/配置管理权限。

每次创建后，把页面的 **Access Key ID** 和 **Secret Access Key** 保存到自己的密码管理器，分别标明 journal/backup；Secret 不会再次显示。脚本要求这两项 S3 凭据，请按字段名对应输入；页面若另有 API Token 值，不要把它填到这两个字段。来源：[R2 凭据及单桶权限](https://developers.cloudflare.com/r2/api/tokens/)。

## 3. 在自己的 WSL 终端填写

不加本地 `sudo`：

```bash
/home/mars/.local/bin/bun --env-file=/home/mars/projects/ChatApp/.env.local /home/mars/projects/ChatApp/.test-runs/launch-2026-10-15/attempt1/configure-production.js
```

依次隐藏输入：

1. 生产 journal 桶名。
2. journal Access Key ID。
3. journal Secret Access Key。
4. 生产 backup 桶名。
5. backup Access Key ID。
6. backup Secret Access Key。
7. Resend 发送权限 API Key。

已有 AI Key 和同账户 R2 endpoint 自动复用。新输入先原子保存到 Git 忽略的 `.test-runs/launch-2026-10-15/production-external.env`，文件权限 600；随后通过严格主机校验的 SSH 交给服务器 root 配置写入器。它使用配置锁并保留原生产身份、前缀和内部对象存储凭据。后续传输重试会复用已保存的生产输入，不重复询问。

输入时终端不回显字符属于正常现象，每项粘贴后按 Enter。成功时显示 `Production configuration saved privately`。把完成状态告诉执行部署的助手即可；不向聊天发送凭据值或含凭据的截图。配置写入成功仍须另行验证真实 R2、跨桶隔离、生产 journal/备份及应用业务路径，不代表 M7 已通过。
