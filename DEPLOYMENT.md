# Googletrendes Deployment

本项目只走 Kubernetes + ArgoCD 的生产发布链路，不使用 Dokploy，也不使用预发布环境。

## 部署映射

- App repository: `https://github.com/gateszhangc/googletrendes`
- Source branch: `main`
- Release tag: `vX.Y.Z`
- Image: `ghcr.io/gateszhangc/googletrendes:vX.Y.Z@sha256:<digest>`
- GitOps repository: `https://github.com/gateszhangc/k8s-fleet`
- Manifest path: `tenants/googletrendes-production`
- ArgoCD application: `googletrendes-production`
- Production URL: `https://googletrendes.codex55.lol`

`googletrendes-staging` 不作为本项目发布门禁使用。需要验证时，在本地和容器内完成验证后直接发布到生产。

## 发布流程

推荐使用一键脚本执行当天数据导入和生产发布：

```bash
scripts/deploy_trends.sh
```

指定日期：

```bash
scripts/deploy_trends.sh 2026-07-01
```

脚本会执行：TSV 表头校验、SQLite 导入、AI 翻译、缺失翻译校验、本地 dashboard smoke、应用提交/tag/push、SQLite-only GHCR 镜像构建、production manifest dry-run、GitOps 提交、ArgoCD 同步、线上 health/summary/Pod/dashboard smoke 验证。

脚本会先比较 TSV 文件的 `sha256` 和数据库中的 `source_files.sha256`。如果没有新增或变化的文件，并且没有缺失 AI 翻译，会直接退出，不重复导入和发布。需要强制重跑时使用：

```bash
scripts/deploy_trends.sh --force
```

只导入和本地验证、不发布：

```bash
scripts/deploy_trends.sh --import-only
```

手动发布流程如下，主要用于脚本失败后的排障或回滚：

1. 在本仓库确认 `main` 是待发布提交，并确保工作区干净。
2. 运行本地验证：
   - `npm test`
   - `npm run test:dashboard`
   - 必要时运行容器 smoke test。
3. 创建生产 tag：
   - `git tag -a vX.Y.Z -m "Release vX.Y.Z"`
   - `git push origin vX.Y.Z`
4. 构建并推送镜像：
   - `docker build -t ghcr.io/gateszhangc/googletrendes:vX.Y.Z .`
   - `docker push ghcr.io/gateszhangc/googletrendes:vX.Y.Z`
5. 记录镜像 digest。
6. 在 `k8s-fleet` 中更新 `tenants/googletrendes-production/20-deployment.yaml` 的镜像到 `vX.Y.Z@sha256:<digest>`。
7. 渲染并 dry-run 验证 production manifest。
8. 提交并推送 `k8s-fleet/main`。
9. 等待 ArgoCD `googletrendes-production` 同步并确认 rollout 完成。
10. 验证生产：
    - `https://googletrendes.codex55.lol/healthz`
    - `https://googletrendes.codex55.lol/api/facets`
    - 生产首页浏览器 smoke test。

## 回滚

回滚只改 production manifest：

1. 在 `k8s-fleet` 中把 `tenants/googletrendes-production/20-deployment.yaml` 的镜像恢复到上一个稳定 tag 或 digest。
2. 提交并推送 `k8s-fleet/main`。
3. 等待 ArgoCD `googletrendes-production` 同步。
4. 验证 `/healthz`、`/api/facets` 和生产首页。

发布前必须记录上一个稳定镜像和 ArgoCD revision，保证可以执行上述回滚。
