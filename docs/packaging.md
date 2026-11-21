# 共享包与持续集成

`packages/` 中的包可在本仓库开发，也可以打成 tarball 安装到独立项目。包保持 `private: true`，避免意外发布；`npm pack` 不受影响。没有执行 npm 发布或上传源码。

| 包                   | 浏览器入口        | Node 入口                                            |
| -------------------- | ----------------- | ---------------------------------------------------- |
| `@qiyi/contracts`    | `@qiyi/contracts` | 同左                                                 |
| `@qiyi/client`       | `@qiyi/client`    | `@qiyi/client/node` 另提供 SSH 与环境配置            |
| `@qiyi/adapters`     | `@qiyi/adapters`  | `@qiyi/adapters/node` 另提供目录采集与 Node 配置工厂 |
| `@qiyi/http-support` | 不支持            | Fastify 错误响应映射                                 |

每个包声明自己的运行时依赖；包之间使用具体版本关联。`http-support` 将 Fastify 声明为 peer dependency，宿主提供兼容的 Fastify 5。使用 Node 入口的 TypeScript 宿主需要 `@types/node >=24`；纯浏览器入口不要求 Node 类型。Node 子路径明确拒绝 `browser` 条件，防止误把 SSH 或文件系统实现放入前端。

## 本仓库开发

`qiyi-source` 是仅用于仓库开发的条件导出。根 TypeScript、tsx 测试/开发命令、Vite 和应用打包器都选择此条件，因此修改源码不需要手工重建包。普通消费者不启用此条件，直接获得编译后的 ESM 和 `.d.ts`。条件解析使用 [Node 的条件导出](https://nodejs.org/api/packages.html#conditional-exports) 和 [TypeScript customConditions](https://www.typescriptlang.org/tsconfig/customConditions.html)。

```bash
npm ci
npm run check
```

`check` 顺序执行类型检查、功能回归测试、完整生产构建和独立包消费验证。构建器根据包 manifest 的依赖关系排序，清理各包 `dist/` 后由 TypeScript 生成 JS、声明和包含源码的 JS source map。应用产物仍在根 `dist/`，库产物位于各自 `packages/<name>/dist/`。

## 安装到另一个宿主

先构建，再打包全部共享包：

```bash
npm run build:packages
mkdir -p .local/packages
npm pack --workspace @qiyi/contracts --pack-destination .local/packages
npm pack --workspace @qiyi/client --pack-destination .local/packages
npm pack --workspace @qiyi/adapters --pack-destination .local/packages
```

在新宿主项目安装这些 tarball，npm 会从各自 manifest 安装 `zod` 等第三方依赖。内部包尚未发布到 registry，因此相关 tarball 必须一起提供：

```bash
npm install /path/to/qiyi-contracts-0.1.0.tgz /path/to/qiyi-client-0.1.0.tgz /path/to/qiyi-adapters-0.1.0.tgz
```

Node 可以直接 `import { AdapterRuntime } from '@qiyi/adapters'`，Node 配置装配使用 `@qiyi/adapters/node` 的 `createAdapterRuntime`，无需 tsx。浏览器宿主只引用不带 `/node` 的入口。需要 HTTP 错误处理时，另外打包并安装 `@qiyi/http-support`，宿主提供 Fastify 5。

## 消费者检查与 CI

`npm run check:packages` 对已构建的包执行真实 `npm pack`，在系统临时目录安装 tarball，然后验证：

- 每个包的编译产物使用的外部运行时依赖均在自身 manifest 声明，不能靠其他包的依赖提升掩盖遗漏。
- 普通 Node ESM 可以加载所有公共入口，并保留跨包的错误类型身份。
- 独立 NodeNext 消费者获得有效的类型声明；错误 RPC 调用仍被 TypeScript 拒绝。
- 浏览器入口在没有 Node 全局类型的消费者中通过类型检查和浏览器打包；Node 入口在浏览器打包时被拒绝。

验证使用临时消费者，Fastify、Node 类型和 Zod 版本取自本仓库 lockfile，其余传递依赖由 npm 按兼容范围解析。不复制 `.env`、用户数据或工作区 `node_modules`，完成后删除临时目录。此检查需要 npm registry 或已有 npm cache 可用。独立运行时先执行 `npm run build:packages`。

`.github/workflows/ci.yml` 在 push、pull request 和手动触发时，以 Node 24 分别在 Linux、macOS 执行 `npm ci` 和完整 `npm run check`。工作流不需要模型、SSH 或业务凭证。工作流采用官方 [checkout](https://github.com/actions/checkout) 与 [setup-node](https://github.com/actions/setup-node) 的当前 v7 入口；真正的云端运行结果需要代码进入配置了 Actions 的仓库后才能观察。
