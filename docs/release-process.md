# Desktop 与 CLI Tag 发版

> 状态：当前实现。稳定版 GitHub tag 同时发布 Desktop 安装包和 npm CLI。

## 一句话结论

推送 `vX.Y.Z` tag 后，GitHub Actions 会把同一版本写进仓库根目录、Desktop 和 CLI，打出 Windows NSIS 与 Linux AppImage/deb、发布 GitHub Latest Release，并把 `@rzx/ohs` 发到 npm。已安装的 Desktop 会在启动后静默检查这个 Latest Release；发现新版本后弹出应用内确认，用户同意才下载，下载完成后再确认是否立即重启安装。

## 发什么

| 产物 | 用户怎么拿到 |
|------|----------------|
| Windows `OpenHarness-X.Y.Z-setup.exe` | GitHub Release Latest，支持应用内更新 |
| Linux `OpenHarness-X.Y.Z.AppImage` | GitHub Release Latest，支持应用内更新 |
| Linux `OpenHarness-X.Y.Z.deb` | GitHub Release Latest，手动安装，不走应用内更新 |
| `@rzx/ohs@X.Y.Z` | `npm install -g @rzx/ohs` |

macOS 安装包本轮不发布。Windows 当前不签名，首次安装可能被 SmartScreen 拦截。

## 版本规则

- 唯一版本源是稳定 tag：`v1.0.1`、`v1.2.0`。预发布 tag（例如 `v1.0.1-beta.1`）不会触发这条流水线。
- GitHub Release 和 npm 必须是同一个 `X.Y.Z`。
- Desktop 现在是 `1.0.0`。低于 `1.0.0` 的版本不会被已安装客户端识别为更新，所以统一发版的第一枪是 **`v1.0.1`**。
- CI 只在 runner 上改根目录 `package.json`、`apps/desktop/package.json` 和 `apps/cli/package.json`，不回写 Git。仓库里的这三个版本可以暂时落后于即将发布的 tag。本机若要打安装包并对齐版本号，可临时运行 `node scripts/prepare-tag-release.mjs v1.0.1`，不要提交。
- `@rzx/ohs` 由这条 tag 流水线发布。Changesets 继续只管可发布的 `@openharness/*` 包，不再包含 CLI。

## 发版前检查

1. `main` 上的 CI 已经通过。
2. GitHub 仓库 Secrets 里有 `NPM_TOKEN`（npm 发布权限）。
3. 工作流权限能写 `contents`（创建 Release）和 `id-token`（npm provenance）。
4. 本地确认 tag 格式和打包配置：

```bash
pnpm test:scripts
pnpm --filter @openharness/desktop verify:update-packaging
```

## 正式发版

在准备发布的 commit 上打 tag 并推送：

```bash
git tag v1.0.1
git push origin v1.0.1
```

GitHub Actions 工作流 [`.github/workflows/tag-release.yml`](../.github/workflows/tag-release.yml) 会：

1. 校验 tag 是 `vX.Y.Z`。
2. 在 Windows / Ubuntu runner 上同步版本、构建 Desktop，并上传安装包和 `latest.yml` / `latest-linux.yml`。
3. 两个平台的 Desktop 安装包都打成功后，再构建 `@rzx/ohs`；如果 npm 上还没有这个精确版本就发布，已经存在则跳过。
4. 创建或更新 GitHub Release，并标成 Latest。Release 已存在时只覆盖资产，方便失败后重跑。

## 客户端怎样更新

打包后的 Windows 和 Linux AppImage 启动后会延迟几秒后台检查 GitHub Latest Release。

- 没有新版本，或检查失败：不打扰用户，只写日志。
- 发现新版本：弹出“下载更新 / 稍后”。
- 用户确认后才下载。
- 下载完成：弹出“立即重启安装 / 稍后”。
- 立即安装会先走 Desktop 的强制退出逻辑，避免主窗口被藏到托盘后装不上。

开发模式和 macOS 不检查更新。`apps/desktop/dev-app-update.yml` 只给显式开发测试用。

## 失败重跑和回滚

- 同一 tag 可以重新跑 workflow。Desktop 资产会覆盖；npm 上已有的精确版本会被跳过，不会重复发布。
- 不要改已经发布的 npm 版本内容。修 bug 请打下一个 patch tag，例如 `v1.0.2`。
- 如果 GitHub Release 有问题，可以删掉该 Release 后重跑，或再发一个更高版本。已经装上错误版本的用户，需要再收到一个更高版本才会更新。

## 应急手动发布 CLI

正式路径是 tag Action。只有 CI 不可用时才在仓库根目录手动：

```bash
pnpm release:cli:dry -- 1.0.1
pnpm release:cli -- 1.0.1
```

必须写成与 GitHub tag 相同的 `x.y.z`，不能省略版本，也不能用 patch / minor / auto。
