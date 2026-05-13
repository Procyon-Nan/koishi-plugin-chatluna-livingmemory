# Koishi Console WebUI 实现指南

本文档记录了在 Koishi 控制台中实现可用、双向交互 WebUI 的完整技术路径，基于 livingmemory 插件的实际调试经验总结。

## 核心架构

```
客户端 (浏览器)                          服务端 (Node.js)
─────────────────                       ─────────────────
client/index.ts                         src/plugins/webui.ts
  └─ ctx.page() 注册侧边栏入口             └─ ctx.console.addEntry() 注册客户端 bundle
                                            └─ ctx.console.addListener() 注册 RPC 端点
client/api.ts
  └─ send(event, params) ──WebSocket──→     listener handler
                          ←──WebSocket──    return result
```

通信模式为纯 RPC：客户端 `send()` 发起请求，服务端 `addListener()` 处理并返回结果，全程通过 Koishi console 管理的 WebSocket 完成。**不需要 DataService**。

## 必需文件清单

```
client/
├── index.ts          # 入口：export default (ctx) => ctx.page({...})
├── dashboard.vue     # 主页面 Vue 组件
├── api.ts            # send() 封装层
└── types.ts          # 客户端本地类型声明 + @koishijs/client Events 接口增强

src/
├── index.ts          # ctx.inject(['console'], ...) + registerEntry + addListener
└── plugins/webui.ts  # addEntry 路径注册 + 全部 listener 定义

package.json          # koishi.browser: true
tsconfig.json         # include: ["src"]，不包含 client
```

**不需要**：`client/tsconfig.json`、`client/env.d.ts`、`client/package.json`、vite 配置。

## 关键实现细节

### 1. package.json 必需配置

```json
{
  "koishi": {
    "browser": true,
    "service": {
      "optional": ["console"]
    }
  },
  "files": ["lib", "dist", "client"],
  "scripts": {
    "build:client": "koishi-console build"
  },
  "devDependencies": {
    "@koishijs/client": "^5.30.11"
  },
  "peerDependencies": {
    "@koishijs/plugin-console": "^5.30.11"
  }
}
```

`koishi.browser: true` 告知 Koishi 此插件有客户端 bundle。`files` 必须包含 `dist`（prod 构建产物）和 `client`（dev 源码）。

### 2. 服务端入口注册（addEntry 路径问题）

**这是最容易踩坑的环节。**

Koishi console 的 `serveAssets` 方法在提供客户端 bundle 时有安全检查：

```js
// @koishijs/plugin-console 内部逻辑
filename = resolve(this.root, filename);
if (!filename.startsWith(this.root) && !filename.includes('node_modules')) {
    return ctx.status = 403;  // 静默拒绝，无任何日志
}
```

这意味着：
- 安装在 `node_modules/` 下的插件：路径包含 `node_modules`，**通过**
- 通过 symlink 从 `external/` 等目录加载的插件：`resolve()` 解析出真实路径，不含 `node_modules`，**被 403 拦截**

**正确做法**：始终通过 `node_modules` symlink 路径注册 entry，而非 `__dirname` 解析出的真实路径：

```ts
const packageName = 'koishi-plugin-chatluna-livingmemory'

function resolveEntryViaNodeModules(ctx: Context) {
    const baseDir = ctx.loader?.baseDir ?? process.cwd()
    return {
        dev: resolve(baseDir, 'node_modules', packageName, 'client', 'index.ts'),
        prod: resolve(baseDir, 'node_modules', packageName, 'dist')
    }
}

export function registerEntry(ctx: Context) {
    ctx.console.addEntry(resolveEntryViaNodeModules(ctx))
}
```

如果插件确定只通过 npm 安装（不会出现在 external/ 下），可以直接用 `resolve(__dirname, '../dist')`，但上述方式更安全通用。

### 3. console 是可选服务，必须用 ctx.inject 等待

`optional: ['console']` 不保证 `apply()` 执行时 `ctx.console` 已存在。必须用 `ctx.inject` 而非 `if` 检查：

```ts
// ✗ 错误：console 可能还没加载
if (ctx.console) {
    registerEntry(ctx)
}

// ✓ 正确：等待 console 就绪后执行
ctx.inject(['console'], (ctx) => {
    registerEntry(ctx)
    ctx.inject(['my_service'], (ctx) => {
        registerListeners(ctx)
    })
})
```

### 4. 客户端入口（client/index.ts）

```ts
import { Context } from '@koishijs/client'
import type {} from './types'  // 副作用导入，拉入 Events 声明
import Dashboard from './dashboard.vue'

export default (ctx: Context) => {
    ctx.page({
        name: '页面名称',
        path: '/route-path',
        icon: 'mdi:brain',       // Material Design Icons
        component: Dashboard,
        order: 500,
        authority: 3
    })
}
```

### 5. 客户端类型必须自包含

客户端代码由 `koishi-console build`（Vite）构建，**无法解析服务端依赖**（如 `koishi-plugin-chatluna`、`@langchain/core` 等）。因此 `client/types.ts` 必须自行声明所有类型，不能从 `../src/types` 导入：

```ts
// ✗ 错误：src/types.ts 含有 import {} from 'koishi-plugin-chatluna/services/chat'
//   Vite 无法解析该服务端包，构建会失败
export type { MemoryEntryRecord } from '../src/types'

// ✓ 正确：客户端本地声明
export interface MemoryEntryRecord {
    id: string
    type: string
    content: string
    sentiment: string | null
    importance: number | null
    // ...
}
```

同时在此文件中声明 `@koishijs/client` 的 Events 接口，为 `send()` 提供类型安全：

```ts
declare module '@koishijs/client' {
    interface Events {
        'my-plugin/list': (query: ListQuery) => PageResult<Item>
        'my-plugin/create': (input: CreateInput) => Item
    }
}
```

### 6. 双向通信模式

服务端：

```ts
ctx.console.addListener('my-plugin/list', async (query) => {
    return await myService.list(query)  // 返回值自动通过 WebSocket 发回客户端
})
```

客户端：

```ts
import { send } from '@koishijs/client'

const result = await send('my-plugin/list', { page: 1, pageSize: 20 })
// result 就是服务端 listener 的返回值
```

### 7. 构建

```bash
yarn build:server   # yakumo/esbuild/tsc → lib/
yarn build:client   # koishi-console build → dist/index.js + dist/style.css
```

客户端构建无需自定义 vite 配置，`koishi-console build` 自动以 `client/index.ts` 为入口。

## ESM 插件的额外注意事项

当 `package.json` 含有 `"type": "module"` 时：

- `lib/index.mjs`（ESM bundle）中 **`__dirname` 不存在**
- 如需在 ESM 中获取当前目录，使用：
  ```ts
  import { dirname } from 'path'
  import { fileURLToPath } from 'url'
  const currentDir = typeof __dirname !== 'undefined'
      ? __dirname
      : dirname(fileURLToPath(import.meta.url))
  ```
- 但对于 `addEntry` 路径，推荐直接用 `node_modules` 路径（见上文第 2 节），可以绕过 `__dirname` 问题

## 调试排查清单

当侧边栏不出现时，按以下顺序排查：

| 步骤 | 检查项 | 工具 |
|------|--------|------|
| 1 | `apply()` 是否执行 | 服务端日志 `ctx.logger.info()` |
| 2 | `ctx.console` 是否存在 | 日志打印 `ctx.console ? 'YES' : 'NO'` |
| 3 | `addEntry` 是否被调用 | 日志打印路径 |
| 4 | 浏览器是否请求了 bundle | DevTools → Network 搜索插件名 |
| 5 | bundle 请求状态码 | 200 正常 / 403 路径安全检查拦截 / 404 文件不存在 |
| 6 | Vue Router 是否注册路由 | DevTools → Console 搜索 `Vue Router warn` |
| 7 | dist/index.js 内容是否正确 | 检查 `export{...as default}` 和 `ctx.page` 关键词 |
