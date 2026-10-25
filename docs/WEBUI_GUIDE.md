# Koishi Console WebUI 实现指南

本文说明 livingmemory 插件如何在 Koishi 控制台中注册页面并与服务端通信。

## 核心架构

```
客户端 (浏览器)                          服务端 (Node.js)
─────────────────                       ─────────────────
client/index.ts                         src/plugins/webui.ts
  └─ ctx.page() 注册侧边栏入口             ├─ ctx.console.addEntry() 注册客户端 bundle
                                           └─ ctx.console.addListener() 注册 RPC 端点
client/api.ts
  └─ send(event, ...args) ──WebSocket──→    listener handler
                            ←──WebSocket──  return result
```

通信只使用 RPC：客户端 `send()` 发起请求，服务端 `addListener()` 处理并返回结果，经 Koishi console 管理的 WebSocket 传输，不使用 DataService。

## 文件结构

```
client/
├── index.ts          # 入口：注册图标与 ctx.page()
├── dashboard.vue     # 主页面
├── api.ts            # send() 的类型化封装
├── components/       # 各标签页与弹窗
├── composables/      # 分页、选中状态等共享逻辑
├── utils/            # 显示格式化
├── styles/           # 样式
├── icons/            # 自定义图标组件
├── env.d.ts          # *.vue 模块声明
└── tsconfig.json     # 客户端类型检查配置（不产出文件）

src/
├── index.ts          # ctx.inject(['console'], ...) 中注册入口与 listener
├── plugins/webui.ts  # addEntry 路径解析与全部 listener
└── contracts/rpc.ts  # RPC 事件契约
```

## 关键实现细节

### 1. package.json

```json
{
    "type": "module",
    "files": [
        "lib",
        "dist",
        "client",
        "src/contracts",
        "src/service/memory/entry_fields.ts"
    ],
    "scripts": {
        "build:client": "koishi-console build"
    },
    "koishi": {
        "browser": true,
        "service": {
            "optional": ["console"]
        }
    }
}
```

`koishi.browser: true` 声明插件带有客户端 bundle。`files` 包含 `dist`（生产构建产物）、`client`（开发模式入口）及客户端引用的共享源码。

### 2. 入口路径

Koishi console 提供客户端文件时会检查路径：

```js
// @koishijs/plugin-console 内部逻辑
filename = resolve(this.root, filename)
if (!filename.startsWith(this.root) && !filename.includes('node_modules')) {
    return (ctx.status = 403)
}
```

通过 symlink 从 `external/` 加载的插件，真实路径不含 `node_modules`，生产入口用真实路径会返回 403，且没有日志。因此生产入口固定使用 `node_modules` 下的路径：

```ts
const packageName = 'koishi-plugin-chatluna-livingmemory'

function resolveEntryPaths(ctx: Context) {
    const baseDir = ctx.loader?.baseDir ?? process.cwd()
    const packageRoot = resolve(baseDir, 'node_modules', packageName)
    const devPackageRoot = existsSync(packageRoot)
        ? realpathSync(packageRoot)
        : packageRoot

    return {
        dev: resolve(devPackageRoot, 'client', 'index.ts'),
        prod: resolve(packageRoot, 'dist')
    }
}

export function registerEntry(ctx: Context) {
    ctx.console.addEntry(resolveEntryPaths(ctx))
}
```

开发模式下 console 经 Vite 的 `/vite/@fs/` 加载 `dev` 路径，不经过上述检查。

### 3. 等待 console 服务

`console` 是可选服务，`apply()` 执行时 `ctx.console` 不一定存在，须用 `ctx.inject` 等待：

```ts
ctx.inject(['console'], (ctx) => {
    registerWebUIEntry(ctx)

    ctx.inject(['chatluna_living_memory'], (ctx) => {
        webuiPlugin(ctx, config)
    })
})
```

### 4. 客户端入口

```ts
import { Context, icons } from '@koishijs/client'
import dashboard from './dashboard.vue'
import treeOfLife from './icons/tree-of-life.vue'

icons.register('living-memory-tree', treeOfLife)

export default (ctx: Context) => {
    ctx.page({
        name: 'Living Memory',
        path: '/chatluna-livingmemory',
        icon: 'living-memory-tree',
        component: dashboard,
        order: 500,
        authority: 3
    })
}
```

### 5. 客户端类型

客户端通过 `import type` 直接引用 `src/contracts/` 中的记录、查询参数和 RPC 契约。运行时使用的记忆类型列表来自 `src/contracts/memory.ts`，关键词上限来自纯模块 `src/service/memory/entry_fields.ts`。`client/tsconfig.json` 的源码根目录覆盖客户端与共享模块，发布清单同时包含这些共享模块，供客户端开发入口使用。

两侧共用 `LivingMemoryConsoleEvents`：

- 服务端在 `src/types.ts` 中把 `src/contracts/rpc.ts` 的事件并入 `@koishijs/plugin-console` 的 `Events`，约束 `addListener`。
- 客户端在 `client/api.ts` 中直接导入该契约，为 `send` 标注参数与返回值：

```ts
const sendLivingMemory = send as unknown as <
    Name extends keyof LivingMemoryConsoleEvents
>(
    name: Name,
    ...args: Parameters<LivingMemoryConsoleEvents[Name]>
) => Promise<Awaited<ReturnType<LivingMemoryConsoleEvents[Name]>>>
```

### 6. 双向通信

服务端：

```ts
ctx.console.addListener(
    'living-memory/listPresetIds',
    async () => await service(ctx).listPresetIds()
)
```

客户端：

```ts
export async function listPresetIds(): Promise<string[]> {
    return await sendLivingMemory('living-memory/listPresetIds')
}
```

listener 的返回值经 WebSocket 发回客户端，作为 `send()` 的结果。

### 7. 构建

```bash
yarn build:server   # yakumo build 与 Worker 构建 → lib/
yarn build:client   # koishi-console build → dist/index.js、dist/style.css
```

客户端构建以 `client/index.ts` 为入口，不需要自定义 Vite 配置。

## ESM 注意事项

`package.json` 声明 `"type": "module"` 时，ESM 产物 `lib/index.mjs` 中没有 `__dirname`。需要模块目录时按如下方式获取：

```ts
import { dirname } from 'path'
import { fileURLToPath } from 'url'

const moduleDirectory =
    typeof __dirname !== 'undefined'
        ? __dirname
        : dirname(fileURLToPath(import.meta.url))
```

入口路径按第 2 节从 `node_modules` 解析，不依赖 `__dirname`。

## 排查清单

侧边栏不出现时按以下顺序检查：

| 步骤 | 检查项                     | 方法                                              |
| ---- | -------------------------- | ------------------------------------------------- |
| 1    | `apply()` 是否执行         | 服务端日志 `ctx.logger.info()`                    |
| 2    | `ctx.console` 是否存在     | 日志打印 `ctx.console ? 'YES' : 'NO'`             |
| 3    | `addEntry` 是否被调用      | 日志打印路径                                      |
| 4    | 浏览器是否请求了 bundle    | DevTools → Network 搜索插件名                     |
| 5    | bundle 请求状态码          | 200 正常 / 403 路径检查拦截 / 404 文件不存在      |
| 6    | Vue Router 是否注册路由    | DevTools → Console 搜索 `Vue Router warn`         |
| 7    | dist/index.js 内容是否正确 | 检查 `export{...as default}` 和 `ctx.page` 关键词 |
