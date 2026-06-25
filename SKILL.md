# Skill: google-trends-folder-processor

## 概述

一键导入 Google Trends TSV 数据并发布到生产环境。替代之前 14 步手动流程（校验→导入→WAL checkpoint→提交→推送→打 tag→smoke test→构建镜像→推送镜像→改 k8s manifest→推送→刷新 ArgoCD→等 rollout→验证），现在一条命令完成。

## 何时使用

- 用户说"处理今天的"、"导入新数据"、"发布"、"部署"、"deploy"
- `2026-MM-DD/` 目录下出现了新的 `google_trends_rising_*.tsv` 文件
- 需要将新数据发布到 https://googletrendes.codex55.lol

## 前置条件

- 工作目录: `/Users/a1-6/Desktop/code/googletrendes`
- k8s-fleet 仓库: `../k8s-fleet` (同级目录)
- 已配置: docker (colima), kubectl, argocd CLI, npm, python3
- GHCR 已登录，kubectl context 已指向生产集群

## 用法

```bash
# 全自动：导入今天的所有新文件 + 构建镜像 + 发布到生产
scripts/deploy_trends.sh

# 指定日期
scripts/deploy_trends.sh 2026-06-25

# 仅导入，不发布（快速试跑）
scripts/deploy_trends.sh --import-only

# 跳过 smoke test（极速发布）
scripts/deploy_trends.sh --skip-test
```

## 脚本做了什么（14 步合并为 1 条命令）

| 步骤 | 动作 | 加速点 |
|------|------|--------|
| 1 | 扫描 `2026-MM-DD/` 目录，校验所有 TSV 表头 | 自动发现，批量校验 |
| 2 | `import_trends_to_sqlite.py --date YYYY-MM-DD` 导入 | 动态 glob，不再硬编码日期 |
| 3 | `PRAGMA wal_checkpoint(TRUNCATE)` | 确保 git 能检测到变更 |
| 4 | git diff 检查 | 跳过无变更时的空提交 |
| 5 | git commit + push | 一步完成 |
| 6 | 启动本地 dashboard + smoke test | 自动清理端口冲突 |
| 7 | 从最新 git tag 自动递增 patch 版本 | 无需手动查版本 |
| 8 | git tag + push tag | 一步完成 |
| 9 | docker build + push | 缓存层复用，仅 SQLite 层变化 |
| 10 | sed 更新 k8s-fleet manifest | 自动提取 digest 并替换 |
| 11 | git commit + push k8s-fleet | 一步完成 |
| 12 | kubectl patch 强制 ArgoCD 刷新 | 不等 3 分钟轮询 |
| 13 | 轮询等待新 Pod ready | 最多 150 秒 |
| 14 | curl 验证 /healthz + /api/summary | 自动确认数据上线 |

## 关键文件

- `scripts/deploy_trends.sh` — 主部署脚本
- `scripts/import_trends_to_sqlite.py` — 数据导入（已支持 `--date` 参数）
- `scripts/serve_trends_dashboard.py` — 本地 dashboard 服务（smoke test 用）
- `tests/dashboard-smoke.mjs` — Playwright 冒烟测试
- `data/google_trends.sqlite` — SQLite 数据库（WAL 模式，git 跟踪）
- `../k8s-fleet/tenants/googletrendes-production/20-deployment.yaml` — 生产 manifest

## 回滚

将 k8s-fleet manifest 中的 image 恢复为上一个稳定版本（脚本输出中会打印），提交推送即可：

```bash
cd ../k8s-fleet
sed -i '' 's|image: ghcr.io/.*|image: ghcr.io/gateszhangc/googletrendes:v0.1.43@sha256:ad27907bf20bebd0e3ef496ccbef84db53936b1c5ea16e8a57c1182e46e6894d|' tenants/googletrendes-production/20-deployment.yaml
git commit -am "rollback(googletrendes-production): revert to v0.1.43"
git push origin main
```

## 注意事项

- SQLite 使用 WAL 模式，**必须 checkpoint 后 git 才能看到变更**（脚本已自动处理）
- smoke test 需要 playwright 浏览器，首次需 `npx playwright install chromium`
- `npm test` 脚本不存在，只有 `npm run test:dashboard`
- Docker 镜像将 SQLite 打包进镜像，每次数据更新都需要重新 build + push
- ArgoCD auto-sync 已开启（prune + selfHeal），patch refresh 后通常 10-15 秒内开始同步
