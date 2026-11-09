# 部署与维护

GitHub 私有仓库 `xiangxiang222/oneword`，使用参考项目同一台腾讯云：`ubuntu@140.143.171.77`。应用独立目录 `/var/www/oneword`、PM2 名称 `oneword`、回环端口 `3795`，外部 HTTPS `https://togetherbetter.cn/oneword/`。

## 自动流程

1. `npm run pr` 推送已提交功能分支，自动创建 PR，等待 GitHub 全部检查成功后 squash 合并；不会自动 stage 本地文件。
2. Checks：三组依赖锁定安装、共享模块生成、网页构建、核心/原生/接口/词库测试、依赖审计、Chromium 浏览器端到端检查。微信官方离线编译在本机工具存在时运行；Linux CI 明确跳过该一项。
3. main 的 Checks 成功触发 Deploy，仅部署通过检查的准确 commit SHA。PR 不部署。
4. 生成独立时间戳发布目录，安装服务端依赖，原子切换 `current` 符号链接，重载独立 PM2 进程。内部健康检查、Nginx 校验失败时回滚旧符号链接及进程；首次失败则停止新进程。
5. Nginx 补丁只添加 `/oneword/` location，原配置备份为 `.before-oneword`，校验失败恢复。保留 marathon 与 beiyexing 的 location 和进程。

Secrets：`DEPLOY_SSH_KEY`（能登录该主机的私钥）、`DEPLOY_KNOWN_HOSTS`（现有已信任服务器的主机密钥）。GitHub Secret 经 stdin 写入，不打印、不提交。不要把上游项目的微信 AppID、Secret 或个人凭据复制进新项目。

初次运行发现本机原有私钥尚未获服务器授权，已通过参考仓库现有部署 Secret 在临时分支运行一次只添加公钥的流程；任务成功后删除临时分支。参考仓库 main 与本地未提交改动保持原样。

## 本地部署与排查

```sh
npm run build
npm run deploy
ssh -i ~/.ssh/id_ed25519 ubuntu@140.143.171.77
pm2 logs oneword --lines 60
curl -fsS http://127.0.0.1:3795/oneword/api/health
```

回滚：把 `/var/www/oneword/current` 原子指向需要的 `releases/<id>`，再执行 `pm2 startOrReload /var/www/oneword/current/ecosystem.config.cjs --update-env`，检查健康。账号和云端进度存放于独立的 `/var/www/oneword/data/oneword.sqlite`（SQLite WAL），由 `ONEWORD_DB_PATH` 指定。该目录不参与 rsync、发布目录切换或代码回滚，每次部署通过 SQLite 在线备份到 `/var/www/oneword/backups/<release>.sqlite`。数据目录权限 700、数据库与备份 600。代码回滚不会回滚学习数据。

数据库需要独立的异机备份和保留策略；当前部署前备份仍在同一台服务器，不能抵御整台机器或磁盘丢失。人工恢复前先停止 `pm2 stop oneword`，保留当前数据库与 WAL，使用一致的 `.sqlite` 备份替换数据库并移走旧 `-wal`/`-shm` 文件，再启动和检查。不要复制运行中主数据库单文件作为备份。

完整词书不含个人数据，由只读 API 按需发送。服务器只托管 `web/dist`，源码、环境文件和其他文件不能通过任意路径访问。账号接口使用带有效期的 HttpOnly 会话 Cookie（微信原生使用 Bearer 会话），提供注册、登录、退出、改密和删除；云端同步使用版本比较和请求去重。跨站写入会拒绝，API 不允许跨域读取。账号和同步 API 始终 no-store，Service Worker 不缓存它们。

## 微信发布边界

网页自动部署与微信代码正式发布是两条流程。本仓库自动验证原生小程序源码和共享模块，未配置 `miniprogram-ci` 上传密钥。独立 AppID、上传私钥、运营主体、类目、隐私指引、备案及审核由小程序管理员在公众平台确认后才能发布。不能将网页部署成功描述为小程序已通过微信审核。
