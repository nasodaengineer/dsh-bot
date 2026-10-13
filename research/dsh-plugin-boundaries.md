# DSH 插件能力边界

> 调研时间：2026-10-13
> 目标：回答「对标 Grok Bot 的 dsh-bot 插件，哪些功能 DSH 插件 API 能支撑、哪些受限、哪些根本做不到」
> 方法：以 `lib/types/*.d.ts` 契约为主证，README 为辅证，`.refs/DeepSeek-Bot/ds-bot` 参考实现为实证。
> 扫描基线：`E:\data\my-work\dsh\DSH-X\data\versions\0.2.1-alpha.2\node_modules\@deepseek-ai\`（版本 0.2.1-alpha.2）。
> 证据格式：`包名 / 文件路径:行号 / 类型名`。**查不到的条目一律写「未找到」，不猜。**

---

## 0. 一句话结论

**DSH 插件 API 足以支撑 dsh-bot 的「Bot 团队 + 群聊 + 例程 + 审批 + 连接器 + 客户端界面」六件套，甚至本体已经内置了 `dsh-experimental-agent-team`（roster / 点对点消息 / 共享任务 DAG / Web UI / profile bundle）可以直接站在上面；但「每个 Bot 拥有一台自己的云计算机（远程桌面 + 独立浏览器会话 + 独立屏幕）」在插件边界内做不了 —— DSH 插件是进程内的 Cordis 服务扩展，`ctx.computerUse` 是操作本机共享桌面的独占单例，`ctx.sandbox` 明确只做 same-world 约束，整个 129 个服务里没有任何多租户远程桌面 / 容器 / microVM 编排原语。**

---

## 0.1 本报告的读法

- **能做** = 插件通过 `inject` 拿到服务、调用已声明的公开方法即可完成，不需要改动 DSH 本体。
- **受限** = 有对应的 API 存在，但缺关键能力（如：能读会话但不能改模型可见历史；能发 HTTP 但没有持久连接托管；能注册 UI 但只能注册进已声明的 slot）。
- **做不了** = 在 `@deepseek-ai/*` 的类型契约里**不存在**对应扩展点，或存在但语义完全不同（例如把「云计算机」理解为「进程内 subprocess」）。

三条判定纪律：

1. **以类型契约为准，不以 README 的营销措辞为准。** 一个能力「能做」的充分条件是在某个 `lib/types/*.d.ts` 里找到公开方法签名。
2. **区分「服务定义包」与「服务实现包」。** DSH 的惯例是 `dsh-<capability>`（抽象 seam）+ `dsh-<capability>-local`（具体实现）成对出现，例如 `dsh-fs` / `dsh-fs-local`、`dsh-sandbox` / `dsh-sandbox-local`、`dsh-credentials` / `dsh-credentials-local`、`dsh-session-persistence` / `dsh-session-persistence-jsonl`。`inject` 写的是服务名，装哪个实现由 profile 决定。
3. **区分宿主半边与浏览器半边。** `dsh-client-ui-*` 的服务只在浏览器侧存在，宿主插件拿不到；反之 `ctx.webServer`、`ctx.connection` 只在宿主侧。

---

## 0.2 扫描基线（实测数字）

```powershell
PS> (Get-ChildItem "...\node_modules\@deepseek-ai\" -Directory).Count
299
```

服务名总表由下面这条机械扫描得出（本报告最重要的一次扫描，它把「`inject` 里能写什么」从猜测变成枚举）：扫所有 `@deepseek-ai/*/lib/types/*.d.ts` 里 `declare module '@deepseek-ai/cordis' { interface Context { ... } }` 的 augmentation，抽出属性名与类型。

```
PS> # 见 research/_services-raw.txt（137 行原始结果）
```

| 指标 | 实测值 |
| --- | --- |
| `@deepseek-ai` 下包总数 | **299** |
| Context augmentation 条目数 | **137** |
| 去重后的服务名数 | **129**（有同名不同物，见 §2 末尾） |
| 携带 Context augmentation 的包数 | **111** |

---

## 1. 插件系统的机制

### 1.1 插件不是一个 `install(rt)`，而是 Cordis 的三种形态之一

DSH 的插件系统**不是自研的**，而是 `@deepseek-ai/cordis`（一个 IoC/依赖注入框架）的插件模型。契约在：

- `cordis/lib/types/registry.d.ts:48` —— `export type Plugin<T = any> = Plugin.Function<T> | Plugin.Constructor<T> | Plugin.Object<T>;`

三种形态：

| 形态 | 签名 | 出处 |
|---|---|---|
| 函数插件 | `(ctx: Context, config: T) => any` | `cordis/lib/types/registry.d.ts:71-73` |
| 类插件 | `new (ctx: Context, config: T) => any` | `cordis/lib/types/registry.d.ts:75-77` |
| 对象插件 | `{ apply(ctx, config): any }` | `cordis/lib/types/registry.d.ts:79-81` |

**没有 `install(rt)` / `createRuntime(ctx, config)` 这类约定。** 真实的对应物是：

| 常见误解 | DSH 里真实的对应物 | 出处 |
|---|---|---|
| `name` | 静态属性 `Plugin.Base.name?: string`（仅用于 fiber 诊断与 logger 名），或 `package.json` 的包名 | `cordis/lib/types/registry.d.ts:53-54` |
| `inject` | 静态属性 `Plugin.Base.inject?: Inject`，服务依赖声明 | `cordis/lib/types/registry.d.ts:57-58` |
| `install(rt)` | **不存在**。安装 = `ctx.plugin(plugin, config)`，返回 `Fiber` | `cordis/lib/types/registry.d.ts:120` |
| 插件体 | 就是 `(ctx, config)` 本身 | `cordis/lib/types/registry.d.ts:72` |
| 插件怎么拿到 `ctx` | 作为第一个参数直接注入；`ctx` 是 Proxy，读属性即解析服务 | `cordis/lib/types/context.d.ts:33-40` |

**实证**：`ds-bot/index.js` 用的是函数插件 + 具名导出：

```js
export const name = 'ds-bot'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController',
                      'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']
export function apply(ctx, config = {}) { createRuntime(ctx, config) }
```

（来源：`.refs/DeepSeek-Bot/ds-bot/index.js`）

### 1.2 `inject` 的两种写法

`cordis/lib/types/registry.d.ts:13-15`：

```ts
export type Inject<M = Dict> = (keyof M)[] | { [K in keyof M]?: M[K] };
```

- 数组形式：只声明依赖，不传 intercept config。`export const inject = ['sessions', 'llm', 'tools']`
- 对象形式：给某个服务传该插件专属的配置覆盖（intercept config）。`static inject = { llm: { model: 'x' } }`

**语义**：`inject` 声明的服务全部可用之前，插件 fiber 停在 `FiberState.PENDING`；任一依赖消失，fiber 会被卸载并在服务回来时重载。见 `cordis/lib/types/fiber.d.ts:59-74`（`FiberState` 枚举：`PENDING/LOADING/ACTIVE/FAILED/UNLOADING/DISPOSED`）。

还有一个**运行期**写法，比静态 `inject` 更适合可选依赖：

```js
ctx.inject(['schedule'], attach)          // 服务到齐后执行，掉了会重跑
ctx.inject(['shellEnv'], sub => attachShellEnv(sub))
```

出处：`cordis/lib/types/registry.d.ts:111`（`Context.inject` 的 module augmentation）。实证：`.refs/DeepSeek-Bot/ds-bot/src/host/schedules.js` 用 `ctx.inject(['schedule'], ...)` 处理「DSH 0.2.0 只在 Automation tasks bundle 打开时才挂载 schedule 服务」的可选性。

### 1.3 `ctx` 是什么

`cordis/lib/types/context.d.ts:40` 起：`Context` 是一个 **Proxy**。普通属性读取走服务解析器；`extend()` / `isolate()` / `intercept()` 创建作用域化的子上下文，**不修改父上下文**。

四个内建成员（`context.d.ts:15-32`）：

| 成员 | 类型 | 用途 |
|---|---|---|
| `ctx.events` | `EventsService` | 事件总线；方法也被混入 `ctx`（`ctx.on` / `ctx.emit`） |
| `ctx.logger` | `LoggerService` | `ctx.logger(name)` 拿具名 logger |
| `ctx.reflect` | `ReflectService` | 支撑 proxy 的反射层（`ctx.get` / `ctx.provide`） |
| `ctx.registry` | `RegistryService` | 插件注册表；`ctx.plugin` / `ctx.inject` 混入 `ctx` |
| `ctx.root` | `this` | 应用根上下文（`@experimental`） |
| `ctx.fiber` | `Fiber` | 拥有该上下文的 fiber（`fiber.d.ts:7-12`） |

**`ctx.get(name)` 与 `ctx.name` 的区别**：前者在服务缺失时返回 `undefined`，后者会挂起 fiber。ds-bot 对可选服务统一用 `ctx.get`：实测其宿主侧 22 处 `ctx.get(...)`，目标分别是 `agentPresets`、`compaction`、`schedule`、`shellEnv`、`tokenMeter`（来源：`.refs/DeepSeek-Bot/ds-bot/src/host/*.js` 全文 grep）。

### 1.4 生命周期与清理：`ctx.effect`

`Fiber.effect(execute, label?)`（`cordis/lib/types/fiber.d.ts:157-159`）是插件注册清理逻辑的唯一正确姿势：

```js
ctx.effect(() => {
  const dispose = someService.on('x', handler);
  return () => dispose();   // 反注册顺序执行，fiber 卸载时自动跑
}, 'my-plugin: subscribe');
```

**不用它而用裸的 `setInterval` / `addEventListener`，插件卸载后会泄漏。** 这是 DSH 插件最常见的坑。

ds-bot 的 20 处 `ctx.effect` 全部带标签，例如：

```js
ctx.effect(() => ctx.connection.fetch.register({ path: ROUTE, methods: ['POST'], ... }),
           'ds-bot: api route')
```

（来源：`.refs/DeepSeek-Bot/ds-bot/src/host/channel.js:329-338`）

### 1.5 配置校验：`Config` + Standard Schema

`Plugin.Base.Config?: StandardSchemaV1<any, T>`（`registry.d.ts:55-56`）。DSH 生态用 `@deepseek-ai/schemastery` 写 schema。校验失败抛 `ValidationError`（`fiber.d.ts:14-22`），fiber 进 `FAILED`。

### 1.6 热更新

`Fiber.restart()` / `Fiber.update(config)`（`fiber.d.ts:187-199`）。DSH 另有 `dsh-hmr` 包（`ctx.hmr`），Web 端有 `dsh-client-hmr`。

---

### 1.7 一个插件包长什么样（`package.json` 的 `dsh` 字段）

这是**权威定义**，来自 `dsh-package-manifest/lib/types/types.d.ts`：

```ts
export interface DshManifest {
  manifestVersion?: 1;
  bundle?: DshBundleManifest;    // { patch: string | string[] }  —— bundle 元数据
  profile?: DshProfileManifest;  // { bundles?: string[] }        —— profile 有序层列表
  client?: DshClientManifest;    // 客户端模块加载与构建元数据
}

export interface DshClientManifest {
  platform: string;        // Web 消费者选 'web'
  inject?: string[];       // 信息性的包名依赖，不是 Cordis 服务注入
  immediately?: boolean;   // 启动第一阶段注册屏障；缺省 = 共享应用批次
  external?: string[];     // 超出隐式客户端基线的精确模块表请求，可含子路径如 '<pkg>/client'
}
```

（来源：`dsh-package-manifest/lib/types/types.d.ts`，`DshManifest` / `DshClientManifest` / `DshBundleManifest` / `DshProfileManifest`）

`DshPackageManifest` 还规定：`icon?: string`（相对 manifest 目录的 SVG/PNG/JPEG/WebP，**≤256 KiB**，realpath 解析后必须仍在目录内）、`engines?: { dsh, node, npm, [engine] }`（DSH 兼容性目前是**声明式**的，由 reader 决定是否强制）。

**实证 —— ds-bot 的 `package.json`：**

```json
{
  "name": "ds-bot",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./web-search": "./web-search.js",
    "./package.json": "./package.json"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-llm": "*",
    "@deepseek-ai/dsh-tools": "*",
    "@deepseek-ai/dsh-web": "*"
  },
  "dsh": {
    "client": { "platform": "web" },
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "devDependencies": { "esbuild": "0.28.2" }
}
```

（来源：`.refs/DeepSeek-Bot/ds-bot/package.json`）

要点：
- `dsh.bundle.patch` 指向本包的 `cordis.patch.yml`；
- `dsh.client.platform: "web"` 让 Web 宿主扫描到这个客户端模块；
- `exports["./client"]` 是浏览器半边的入口，**必须是相对路径字符串**；
- `peerDependencies` 只声明 DSH 自带的包，第三方依赖走 `dependencies`；
- 客户端 bundle 用 esbuild 打成 CJS 并**提交进仓库**（`client.js` 首行注释：「Generated from src/client by `npm run build` … Do not edit by hand.」），这样 `link:` 与 git 安装不需要构建步骤。

### 1.8 插件怎么被加载：profile 与分层 patch

**加载链条**：

1. 启动器 `dsh <name>` / `dsh --profile <name>` 读 profile 目录的 `package.json`；
2. profile 的 `dsh.profile.bundles` 是一个**有序**的 bundle 列表；
3. 每个 bundle 的 `dsh.bundle.patch` 声明自己的 `cordis.patch.yml`；
4. 配置树从**空根**开始，按顺序叠加：各 bundle 的 patch → profile 自己的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层；
5. 结果交给 Cordis Loader 装配成插件树。

**实证 —— 本机 Web profile 的真实 bundle 列表**（来源：`C:\Users\12896\.dsh\profiles\web\package.json`）：

```json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dshmarket",
  "@deepseek-ai/dsh-experimental-agent-team-profile",
  "billion-context",
  "@linxin666/dsh-client-ui-git-graph",
  "dsh-mcp-connector",
  "@linxin666/dsh-client-ui-skill-explorer",
  "dsh-web-fetch-enhanced",
  "dsh-plugin-session-drag",
  "dsh-model-fusion",
  "dsh-auto-decide",
  "dsh-our-free-model",
  "dsh-mmaping",
  "dsh-generative-ui",
  "@deepseek-ai/dsh-experimental-tool-worktree",
  "@deepseek-ai/dsh-experimental-inspector-profile",
  "@deepseek-ai/dsh-experimental-ralph-bundle",
  "@deepseek-ai/dsh-experimental-session-search",
  "@deepseek-ai/dsh-experimental-session-titles-bundle",
  "ds-bot",
  "@deepseek-ai/dsh-experimental-terminal-bundle",
  "dsh-mnemon",
  "clearai-dsh"
] } }
```

**这张表证明了 dsh-bot 的可行性**：第三方插件包（`ds-bot`、`clearai-dsh`、`dshmarket`、`dsh-mnemon`）与官方 bundle 用**完全相同的机制**接入，没有任何特权通道。

**`cordis.patch.yml` 的语法**（顶层 YAML 数组，条目四种形态）：

```yaml
- id: web-fetch-http          # ① 按 id 寻址
  disabled: true              #    禁用该行
- id: web                     # ② 按 id 定向改 config
  config: { fetchProvider: http-enhanced }   # 整行替换 config，不是深合并
- insert:                     # ③ 插入新行
    - id: bot
      name: ds-bot
- id: permission              # ④ 支持 !!js 表达式
  config: { defaultPreset: !!js "process.platform === 'win32' ? 'danger-full-access' : 'workspace-read'" }
```

**关键陷阱**：`config` 是**整行替换**而非合并。ds-bot 的 `cordis.patch.yml` 里为此专门加了注释：

```yaml
# A config override replaces the whole entry config, so fetchProvider is
# restated. A profile patch that names another searchProvider wins over this one.
- id: web
  config:
    searchProvider: auto
    fetchProvider: http
```

（来源：`.refs/DeepSeek-Bot/ds-bot/cordis.patch.yml`）

**内置 bundle 名**（由 dsh 安装目录解析）：`@deepseek-ai/dsh-base`、`dsh-web-app`、`dsh-headless`、`dsh-sdk-app`、`dsh-sdk-minimal`、`dsh-acp-app`。

**装配检查命令**：`--dump-default-config`、`--dump-config`、`--dump-config-schema`。

**插件管理 API**（`dsh-plugin-manager`，宿主可用）：

| 方法 | 签名 | 出处 |
|---|---|---|
| `listPlugins()` | `Promise<PluginInfo[]>` | `lib/types/index.d.ts:77` |
| `listBundles()` | `Promise<BundleInfo[]>` | `lib/types/index.d.ts:83` |
| `setPluginEnabled(id, enabled)` | `Promise<ChangeResult>` | `lib/types/index.d.ts:100` |
| `installBundle(spec, options?)` | `Promise<ChangeResult>` | `lib/types/index.d.ts:118` |
| `removeBundle(name)` | `Promise<ChangeResult>` | `lib/types/index.d.ts:136` |

### 1.9 客户端扩展点怎么注册

**宿主侧发现机制**（`dsh-client-modules`）：

- 宿主半边扫描 Loader entries 里声明了 `dsh.client` 的包，组装 `window.__DSH_BOOT__` 入口图（`WebBootEntry` / `WebBootGraph` / `BootManifest` / `WebBootBatch` / `BootModuleRow` / `BootPluginRow`）；
- 提供 `ctx.clientModules: ClientModuleRegistry`，方法 `graph()`、`clientPath(id)`、`fetchBundle(request)`、`artifactBaseline(id)`、`rebuilt(id)`、`onRebuilt`、`onGraphChanged`；
- 扫描是**增量**的，没有全量重扫路径；每个 cordis `internal/plugin` 发射把该 fiber 的 entry name 标脏，microtask flush 对账；
- 客户端模块图用 `orderByModuleGraph(entries)` 保证被请求的动态包排在其消费者之前，自请求或成环会 throw。

（来源：`dsh-client-modules/lib/types/index.d.ts`）

**浏览器侧的加载形态**：不是普通 npm import，而是 `window.__ModuleLoader__.load({ id, factory })`。ds-bot 的构建脚本把它写清楚了：

```js
const PLATFORM_MODULES = ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']
// ...esbuild bundle, format: 'cjs', platform: 'browser', external: PLATFORM_MODULES
return [
  '// Generated from src/client by `npm run build` (scripts/build-client.mjs). Do not edit by hand.',
  "window.__ModuleLoader__.load({",
  "  id: 'ds-bot',",
  ...
]
```

（来源：`.refs/DeepSeek-Bot/ds-bot/scripts/build-client.mjs`）

`require` 解析的是**外壳预置的平台模块**（react、react-dom、ui-primitives…），所以它们保持 external。这是 DSH 客户端插件的既定打包形状。

**UI 挂载：slot 注册表**（`dsh-client-ui-renderer` 的 `ctx.slots`）：

| 方法 | 签名 | 出处 |
|---|---|---|
| `register` | `SlotCore['register']`（按 slot 契约注册一个组件） | `lib/types/client/registry.d.ts:85` |
| `registerFactory` | 注册可复用 Component Factory | `lib/types/client/registry.d.ts:95` |
| `inject(key, callback)` | 为某个已声明 slot 的声明生命周期安装 effect | `lib/types/client/registry.d.ts:111` |
| `install(renderer)` | 安装外壳渲染器（boot-once，第二次 throw） | `lib/types/client/registry.d.ts:150` |
| `installLocale(face)` | 安装 locale face | `lib/types/client/registry.d.ts:157` |

slot 契约表 `SlotMap` 是**空接口**，由消费方 `declare module` 合并声明。注册语义（`dsh-client-ui-slots/lib/types/index.d.ts`）：

- `SlotKind = 'single' | 'list' | 'keyed' | 'chain'`，`SlotScope = 'root' | 'session-maybe' | 'session'`；
- **注册进未声明的 slot 会 throw**；
- **一个 slot 只能有一个声明者**，重复声明子 key 会 throw；
- `shell.overlay` 是 list slot（可叠加），而 `app` 是 single slot（**第二个会 shadow 掉框架，不是并排**）。

**右侧栏**（`dsh-client-ui-sidebar-right`）：客户端插件可调

```ts
openTab<K extends string>(kind: K, options?: SidebarRightOpenTabOptions<K>): void
openTabIn(sessionId: SessionId, kind: string, options?): void
```

（来源：`lib/types/client/service.d.ts:168`、`lib/types/client/tab-domain.d.ts:34`）

**实证**：`dsh-client-ui-sidebar-browser` README 给出真实调用 `ctx.sidebarRight.openTab('browser', { params: { url } })`。

**客户端插件的 inject 实证**（ds-bot）：`export const inject = ['sessions', 'uiWorkspace', 'uiConversation', 'slots', 'theme', 'layout', 'configForms']`（来源：`.refs/DeepSeek-Bot/ds-bot/src/client/index.js`）。

### 1.10 宿主 ↔ 客户端通信的三条通道

| 通道 | 用途 | 证据 |
|---|---|---|
| **Typert Remote** | 类型化 RPC。宿主侧继承 `TypertRemoteService`（`dsh-typert-protocol/lib/types/index.d.ts:66`），用 `@Remote` 装饰器标方法（`:82`）；客户端通过 `dsh-api-gateway` 拿到。 | `dsh-schedule`、`dsh-api-session-controller` 都是 `TypertRemoteService` 子类 |
| **HTTP 路由** | `ctx.webServer.register(route)`（`dsh-host-webserver/lib/types/index.d.ts:157`）、`registerUpgrade`（`:164`）、`registerFallback`（`:173`）。路由匹配：**精确 → 最长前缀 → fallback**。 | `dsh-host-webserver/README.md` |
| **Connection fetch** | `ctx.connection.fetch.register({ path, methods, requestBody, fetch })` —— 挂到共享 `/api` 通道，浏览器用**会话 cookie** 认证。 | ds-bot 实证：`.refs/DeepSeek-Bot/ds-bot/src/host/channel.js:329-338` |

ds-bot 选的是第三条：一个 `POST /api/bot` 端点，body 是 `{ endpoint, payload }`，客户端 `fetch` 同源调用。这是**最省事的自建前后端通道**，不需要碰 Typert 的代码生成。

### 1.11 最小可运行插件

```js
// index.js —— DSH 插件的最小形态（ESM 函数插件）
export const name = 'my-plugin';
export const inject = ['sessions', 'tools'];

export function apply(ctx, config) {
  ctx.logger('my-plugin').info('loaded, config =', config);

  ctx.effect(() => {
    const off = ctx.on('session/created', (session) => {
      ctx.logger('my-plugin').info('session created:', session.id);
    });
    return () => off();
  }, 'my-plugin: session/created');

  ctx.tools.register({
    name: 'my_tool',
    description: '示例工具',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  });
}
```

> `ctx.tools.register` 的**确切签名**见 §2.3；上面的参数形状是示意，真实 schema 以 `dsh-tools/lib/types/index.d.ts` 为准。

---

## 2. 可用服务清单

这一节回答：**`inject` 数组里能写什么名字**。全部条目由机械扫描得出，原始结果落盘在 `research/_services-raw.txt`（137 行）。本节是它的可读化版本。

**共 137 条 augmentation，129 个不同服务名，横跨 111 个包。**

### 2.1 内核与装配

| 服务名 | 来自哪个包 | 能做什么 | 关键类型/方法 |
| --- | --- | --- | --- |
| `loader` | `cordis-plugin-loader` `index.d.ts:39` | 插件加载器，动态 load/unload 插件 | `Loader` |
| `timer` | `cordis-plugin-timer` `index.d.ts:4` | 定时器（随 fiber 卸载的 setTimeout/setInterval 封装） | `TimerService` |
| `hmr` | `dsh-hmr` `index.d.ts:8` | 插件热重载，`config.root` 声明要监视的模块根 | `Hmr` |
| `profileContext` | `dsh-app-boot` `profile-context.d.ts:29` | 当前 profile 的身份/上下文 | `ProfileContext` |
| `pluginPackages` | `dsh-app-boot` `service.d.ts:8` | 已安装插件包清单 | `PluginPackages` |
| `dshHomePath` | `dsh-app-boot` `index.d.ts:27` | `$DSH_HOME` 路径函数 | `typeof dshHomePath` |
| `launchEnvironment` | `dsh-launch-environment` `index.d.ts:78` | 启动时环境快照（argv、cwd、env） | `LaunchEnvironmentSnapshot` |
| `cmdlineArgs` | `dsh-cmdline` `index.d.ts:53` | 命令行参数 | `CmdlineArgs` |
| `appReady` / `appExit` | `dsh-cmdline` `index.d.ts:55,57` | 启动完成 / 退出钩子 | `AppReady` / `AppExit` |
| `pluginManager` | `dsh-plugin-manager` `index.d.ts:34` | **插件自管理**：列出/启用/禁用/安装/卸载插件与 bundle | 见 §1.8 表 |
| `configEditor` | `dsh-config-editor` `index.d.ts:6` | 编辑某个 entry 的配置（读继承值 + 合并改写） | `entries()` `:19`、`edit(entry, change)` `:34` |
| `settings` | `dsh-settings` `index.d.ts:27` | 读写用户 settings 命名空间（带乐观锁 revision） | `update(ns, patch, expectedRevision)` `:102`、`mutate(ns, ops, rev)` `:114` |
| `dynamicCordisRunner` | `dsh-cordis-host-runner` `index.d.ts:53` | **运行期动态加载/卸载 Cordis 插件**（宿主侧） | `DynamicCordisRunnerService` |
| `cordisInspect` | `dsh-cordis-host-runner` `inspect-registry.d.ts:24` | 反射运行中的 Cordis 服务/插件树 | `CordisInspectRegistryService` |
| `worktrees` | `dsh-experimental-worktree` `index.d.ts:26` | git worktree 管理 | `WorktreeService` |

### 2.2 会话与 Agent（dsh-bot 的核心依赖）

| 服务名 | 来自哪个包 | 能做什么 | 关键类型/方法 |
| --- | --- | --- | --- |
| `sessions` | `dsh-session` `index.d.ts:28` | **内核会话存储**：append-only 事件日志 + 内存 store + 派生 LLM 消息历史 | `SessionStore`；`session.append(event)`、`session.events` |
| `sessions`（同名不同物） | `dsh-api-session-controller` `index.d.ts:29` | **API 控制面契约** `ISessions`（给客户端/网关用的远程面） | `ISessions` —— 与上一行是**两个不同的服务** |
| `sessionController` | `dsh-api-session-controller` `index.d.ts:18` | 会话的 HTTP/RPC 控制面：列出、创建、恢复 root Session | `SessionController`；`create(request)` `:99`、`selectModel(request)` `:105` |
| `agents` | `dsh-agent` `index.d.ts:20` | **活着的 Agent 注册表**，按 SessionId 找 Agent 实例 | `AgentRegistry`：`create`、`resume`、`register`、`get`、`list`、`roots` |
| `agentLoop` | `dsh-agent-loop` `index.d.ts:29` | **创建 / 恢复 Agent**（root Session 的循环） | `create(id, options, meta)` `:135`、`createAgent(ownerCtx, options)` `:164`、`resume(ownerCtx, options)` `:174` |
| `configuredAgentIdentities` | `dsh-agent-loop` `index.d.ts:38` | 已配置的 Agent 身份（人格） | `ConfiguredAgentIdentities` |
| `agentPresets` | `dsh-agent-preset-registry` `index.d.ts:18` | **Agent 预设（人格/工具集装配）注册表** | `register(definition)` `:44`、`list()` `:68`、`mount(ctx, id)` `:91`、`select(agent, id)` `:122` |
| `agentDefaultModel` | `dsh-agent-default-model` `index.d.ts:8` | 默认模型配置 | `AgentDefaultModelConfig` |
| `subagents` | `dsh-subagent` `index.d.ts:62` | **子代理运行时**：派生、发消息、中断、列出、等待 | `startActivation(spec)` `:145`、`sendMessage(...)` `:167`、`interrupt(...)` `:196`、`listChildren` `:228`、`listDescendants` `:245`、`registerProvider` `:288` |
| `agentTeams` | `dsh-experimental-agent-team` `index.d.ts:14` | **Agent Teams 本体**（详见 §3.1） | `TeamService`：`membership()` `:34`、`listMembers()` `:40`、`spawnTeammate()` `:47`、`sendMessage()` `:54`、`createTask()` `:61`、`updateTask()` `:81`、`waitForChange()` `:89`、`interrupt()` `:96` |
| `sessionTitle` | `dsh-session-title` `index.d.ts:33` | 会话标题：读、改名、重新生成（可注册自定义 provider） | `get(session)` `:129`、`rename(session, title)` `:141`、`refresh` `:149`、`register(provider)` `:157` |
| `sessionProjections` | `dsh-session-projection` `index.d.ts:25` | **会话投影注册表**：把事件流折叠成派生状态，可自定义投影键 | `SessionProjectionRegistry`；`snapshot(session, keys)` `:185`、`onChanged(listener)` `:166`、`checkpoint(session)` `:209` |
| `sessionProjectionCache` | `dsh-session-projection-cache` `index.d.ts:27` | 投影缓存 | `SessionProjectionCache` |
| `sessionQuery` | `dsh-session-query` `index.d.ts:25` | **跨会话检索**：列出、搜索、读事件、读表面、追踪血缘 | `searchSessions(request)` `:54`、`listSessions()` `:67`、`readSession(id)` `:74`、`traceSession(id)` `:135`、`readEvent(request)` `:150` |
| `sessionReferenceResolver` | `dsh-session-reference` `index.d.ts:20` | 会话引用解析 | `SessionReferenceResolver` |
| `sessionPersistence` | `dsh-session-persistence` `index.d.ts:78` | **会话持久化**（DSH 内核不做落盘，这是它做的） | `SessionPersistence` |
| `sessionFeedback` | `dsh-command-feedback` `index.d.ts:24` | 会话级反馈 | `SessionFeedbackService` |
| `sessionFileReferences` | `dsh-api-session-controller` `file-references.d.ts:9` | 会话内文件引用 | `SessionFileReferences` |
| `sessionSkillCatalog` | `dsh-api-session-controller` `skill-catalog.d.ts:8` | 会话可见技能目录 | `SessionSkillCatalog` |
| `sessionTelemetry` | `dsh-session-telemetry` `index.d.ts:20` | 会话遥测后端 | `SessionTelemetryBackend` |
| `sessionLogDownload` | `dsh-session-log-export` `index.d.ts:7` | 会话日志导出下载 | `SessionLogDownloadController` |
| `goals` | `dsh-goal` `index.d.ts:19` | **长期目标**：创建/编辑/暂停/恢复/完成/阻塞 | `create(agent, request)` `:83`、`complete(...)` `:113`、`block(...)` `:121` |
| `compaction` | `dsh-compaction` `index.d.ts:69` | 上下文压缩引擎 | `compactIfNeeded(agent, trigger, signal)` `:116`、`compactNow(...)` `:137` |
| `toolResultPruner` | `dsh-compaction-tool-result-pruner` `index.d.ts:15` | 工具结果剪枝 | `ToolResultPruner` |
| `tokenMeter` | `dsh-token-meter` `index.d.ts:16` | token 计量 | `TokenMeter` |
| `planMode` | `dsh-plan-mode` `index.d.ts:50` | 计划模式控制器 | `PlanModeController` |
| `workflowEngine` | `dsh-workflow` `index.d.ts:15` | **工作流引擎**（可编程多 agent 编排，抽象类） | `start(request)` `:119` |
| `spillStore` | `dsh-spill` `index.d.ts:22` | 溢出存储（大输出落盘） | `SpillStore` |
| `attachments` | `dsh-attachment` `index.d.ts:14` | **附件**：存图片/文件、读回流、给模型请求 | `saveImages()` `:43`、`saveFile(input)` `:97`、`readImage(ref)` `:81`、`imageHostPath(ref)` `:88` |
| `fileReferences` | `dsh-file-reference` `index.d.ts:16` | 文件引用服务 | `FileReferenceService` |

### 2.3 LLM、提示与工具

| 服务名 | 来自哪个包 | 能做什么 | 关键类型/方法 |
| --- | --- | --- | --- |
| `llm` | `dsh-llm` `index.d.ts:30` | **模型调用运行时**：流式生成、注册 adapter、列模型 | `stream(options)` `:416`、`registerAdapter(providers, adapter)` `:253`、`listProviders()` `:272`、`listModels(provider)` `:350`、`resolveModelInfo(provider, model)` `:360`、`prepareCall(config, signal)` `:390` |
| `systemPrompt` | `dsh-system-prompt` `index.d.ts:12` | **系统提示服务**：可注册/替换 system prompt 段 | `SystemPrompt` |
| `tools` | `dsh-tools` `index.d.ts:34` | **工具注册表**：注册工具、限制、守卫、自定义呈现 | `register(definition)` `:636`、`restrict(filter)` `:644`、`guard(guard)` `:655`、`get(name, scope)` `:690`、`schemas(scope)` `:711`、`execute(exec)` `:765`、`presentAs(mode)` `:609` |
| `commands` | `dsh-commands` `index.d.ts:65` | **斜杠命令运行时**：注册自定义命令 | `CommandRuntime` |
| `skills` | `dsh-skill` `index.d.ts:201` | **技能注册表**（skill 是带指令的可复用能力） | `SkillRegistry` |
| `ptcRuntime` | `dsh-ptc-runtime` `index.d.ts:59` | PTC（programmatic tool calling）运行时 | `PtcRuntime` |
| `deepseekLlmApiExtensions` | `dsh-deepseek-llm-api-extensions` `index.d.ts:11` | DeepSeek 官方 API 的扩展注册 | `DeepSeekLlmApiExtensionRegistry` |
| `deepseekAccount` | `dsh-deepseek-account` `index.d.ts:14` | DeepSeek 账号信息 | `DeepSeekAccount` |
| `mcpResources` | `dsh-mcp-resources` `index.d.ts:11` | **MCP 资源注册**：把 MCP server 的资源暴露进来 | `register(server, provider)` `:46`、`request(request, exec)` `:30` |

### 2.4 执行与沙箱

| 服务名 | 来自哪个包 | 能做什么 | 关键类型/方法 |
| --- | --- | --- | --- |
| `fs` | `dsh-fs` `index.d.ts:17` | **文件系统**（受沙箱策略约束） | `FileSystem` |
| `shell` | `dsh-shell` `index.d.ts:16` | **shell 执行**（抽象类，由平台 provider 实现） | `resolve(request)` `:61`、`execute(spec)` `:69` |
| `subprocess` | `dsh-subprocess` `index.d.ts:43` | **子进程运行时**（长期进程、读写流） | `SubprocessRuntime` |
| `terminals` | `dsh-terminal` `index.d.ts:15` | **持久终端会话**：spawn/发送/读取/信号/杀死/列出 | `spawn(owner, request)` `:60`、`startSend(...)` `:74`、`read(...)` `:82`、`signal(...)` `:90`、`kill(...)` `:98`、`list(owner)` `:104` |
| `jobs` | `dsh-jobs` `index.d.ts:18` | **后台作业注册表**：启动/列出/读/杀/等待/订阅 | `start(spec)` `:71`、`readAt(id, from)` `:105`、`kill(id)` `:116`、`wait(id, timeoutMs)` `:128`、`attachController(name)` `:145` |
| `sandbox` | `dsh-sandbox` `index.d.ts:118` | **沙箱提供者**：把 argv 约束进沙箱 | `confine(argv, policy, signal)` `:141` |
| `sandboxPolicy` | `dsh-sandbox-policy` `index.d.ts:30` | 沙箱策略（read-only / workspace-write / danger-full-access） | `SandboxPolicyService` |
| `shellEnv` | `dsh-shell-env` `index.d.ts:16` | shell 环境变量注册表 | `ShellEnvRegistry` |
| `workingDirectory` | `dsh-working-directory` `index.d.ts:11` | 会话工作目录 | `WorkingDirectoryService` |
| `workspaceRegistry` | `dsh-workspace` `index.d.ts:82` | **工作区注册表**：`create(path, title?)` `:145`、`get(id)` `:164`、`resolveByPath(path)` `:264` | `WorkspaceRegistry` |
| `workspaceChanges` | `dsh-workspace-changes` `types.d.ts:118` | 工作区文件变更跟踪 | `WorkspaceChanges` |
| `workspaceFiles` | `dsh-api-workspace-files` `index.d.ts:30` | **工作区文件 API**（给客户端/远程用） | `WorkspaceFiles` |
| `workspaces` | `dsh-api-workspace-controller` `index.d.ts:19` | 工作区控制面契约 | `IWorkspaces` |
| `workspaceController` | `dsh-api-workspace-controller` `index.d.ts:22` | 工作区 HTTP 控制面 | `WorkspaceController` |
| `directoryPicker` | `dsh-host-directory-picker` `index.d.ts:82` | **原生目录选择器** | `DirectoryPicker` |
| `directoryPickerController` | `dsh-api-workspace-controller` `directory-picker.d.ts:11` | 目录选择控制面 | `DirectoryPickerController` |
| `officeToPdf` | `dsh-office-to-pdf` `index.d.ts:13` | Office 文档转 PDF | `OfficeToPdf` |

### 2.5 安全、权限、凭据

| 服务名 | 来自哪个包 | 能做什么 | 关键类型/方法 |
| --- | --- | --- | --- |
| `approval` | `dsh-user-approval` `index.d.ts:21` | **请求用户批准一个动作** | `ApprovalService`：`request(req)`、`setPolicy(agent, policy)`、`overrideOf(session)` |
| `userQuestions` | `dsh-user-questions` `index.d.ts:16` | **向用户提问并等回答**（结构化选项） | `UserQuestionService` |
| `authorization` | `dsh-authorization` `index.d.ts:35` | **授权流**：OAuth 之类，注册 flow、发起授权、拿凭据 | `registerFlow(flow)` `:174`、`begin(request)` `:212`、`list()` `:179`、`cancel(key)` `:194` |
| `credentials` | `dsh-credentials` `index.d.ts:100` | **凭据提供者**：读 API key / token | `CredentialProvider` |
| `credentialsController` | `dsh-api-settings-controller` `credentials.d.ts:13` | 凭据的控制面（客户端写入） | `CredentialsController` |
| `settingsController` | `dsh-api-settings-controller` `index.d.ts:24` | settings 控制面 | `SettingsController` |
| `permissionPresets` | `dsh-permission-presets` `index.d.ts:12` | **权限预设**：catalog/current/set | `catalog()` `:138`、`current(session)` `:162`、`set(session, name)` `:186`、`registerAuto(admit)` `:145` |
| `planMode` | `dsh-plan-mode` `index.d.ts:50` | 计划模式（限制工具） | `PlanModeController` |

### 2.6 网络、Web 服务与连接

| 服务名 | 来自哪个包 | 能做什么 | 关键类型/方法 |
| --- | --- | --- | --- |
| `web` | `dsh-web` `index.d.ts:15` | **联网能力**：搜索 + 抓取网页 | `WebRuntime`；`search()` / `fetch()` |
| `webServer` | `dsh-host-webserver` `index.d.ts:18` | **HTTP 服务器**：注册路由、注册 upgrade（WebSocket）、注入 index.html | `register(route)` `:157`、`registerUpgrade(route)` `:164`、`registerFallback(handler)` `:173` |
| `connection` | `dsh-client-connection` `rpc-host.d.ts:9` | **客户端连接宿主句柄**：把宿主逻辑暴露给浏览器 | `HostConnectionHandle`；`fetch.register(...)` |
| `remote` | `dsh-api-gateway` `index.d.ts:42` / `dsh-api-remotes` `index.d.ts:67` | 客户端远程面 | `ClientRemote` |
| `typertGateway` | `dsh-api-gateway` `types.d.ts:134` | 类型化 RPC 网关 | `TypertGateway` |
| `typert` | `dsh-typert-protocol` `types.d.ts:574` | 类型化协议注册表 | `TypertRegistryContract` |
| `mcpResources` | `dsh-mcp-resources` `index.d.ts:11` | MCP 资源 | 见 §2.3 |
| `productAnalytics` | `dsh-client-product-analytics` `index.d.ts:15` | 产品分析 | `ProductAnalytics` |
| `productTelemetry` | `dsh-host-product-telemetry-otel` `index.d.ts:7` | OTel 产品遥测 | `ProductTelemetry` |
| `otel` | `dsh-otel` `index.d.ts:7` | OpenTelemetry | `OTel` |

### 2.7 Web 客户端界面（`dsh-client-ui-*`）

这些服务**只在浏览器侧存在**，宿主插件拿不到；它们出现在客户端插件的 `inject` 里。

| 服务名 | 来自哪个包 | 能做什么 | 关键类型/方法 |
| --- | --- | --- | --- |
| `slots` | `dsh-client-ui-renderer` `index.d.ts:27` | **UI 插槽注册表** —— 客户端插件挂载 UI 的唯一入口 | `SlotRegistry` |
| `uiRenderer` | `dsh-client-ui-renderer` `index.d.ts:29` | UI 渲染服务 | `UiRendererService` |
| `clientModules` | `dsh-client-modules` `index.d.ts:34` | **客户端模块注册表**（宿主侧，管客户端插件包的发现与下发） | `ClientModuleRegistry` |
| `modules` | `dsh-client-modules` `manifest.d.ts:37` | 客户端模块加载器 | `ClientModuleLoader` |
| `layout` | `dsh-client-ui-layout` `index.d.ts:21` | 整体布局 | `ILayout` |
| `conversation` / `uiConversation` | `dsh-client-ui-conversation` `index.d.ts:34,36` | 对话视图装配 | `IConversation` / `UiConversation` |
| `uiSession` | `dsh-client-ui-session` `index.d.ts:102` | 会话状态（客户端） | `UiSession` |
| `uiWorkspace` | `dsh-client-ui-workspace` `navigation.d.ts:99` | 工作区导航 | `UiWorkspace` |
| `theme` | `dsh-client-ui-theme` `index.d.ts:89` | 主题运行时 | `ThemeRuntime` |
| `locale` | `dsh-client-locale` `index.d.ts:59` | 多语言 | `LocaleRuntime` |
| `shortcuts` | `dsh-client-shortcuts` `index.d.ts:12` | 快捷键 | `Shortcuts` |
| `sidebarRight` / `sidebarRightTabs` | `dsh-client-ui-sidebar-right` `index.d.ts:23,25` | **右侧栏** | `SidebarRightController` / `SidebarRightTabRegistry` |
| `documentPreviews` | `dsh-client-ui-sidebar-documentpreview` `index.d.ts:26` | 文档预览面板 | `DocumentPreviewRegistry` |
| `configForms` | `dsh-client-ui-settings` `config-form.d.ts:96` | **配置表单渲染**（插件可贡献设置页） | `ConfigForms` |
| `settingsSchema` | `dsh-client-ui-settings` `schema.d.ts:69` | 设置 schema | `SettingsSchemaService` |
| `commandUi` | `dsh-client-ui-commands` `index.d.ts:21` | 命令面板 UI | `CommandUiRuntime` |
| `inputTriggers` | `dsh-client-ui-input-trigger` `index.d.ts:15` | 输入框触发（`/`、`@`） | `InputTriggerServiceContract` |
| `userQuestionPanels` | `dsh-client-ui-tool` `slots.d.ts:132` | **用户提问面板**（`ask_user` 的 UI） | `UserQuestionPanels` |
| `chatFileMentions` | `dsh-client-ui-chat` `slots.d.ts:112` | 聊天里的文件提及 | `ChatFileMentions` |
| `feedbackUi` | `dsh-client-ui-message-feedback` `index.d.ts:26` | 消息反馈 UI | `FeedbackUi` |
| `modelDirectories` | `dsh-client-ui-model-selection` `service.d.ts:7` | 模型选择目录 | `ModelDirectoryResolver` |
| `pluginNavigation` / `pluginRegistryProbe` | `dsh-client-ui-plugin-manager` `index.d.ts:7` | 插件管理器 UI | `PluginRegistryProbe` |
| `resources` | `dsh-client-resources` `contract.d.ts:29` | 客户端资源 | `Resources` |
| `fileUpload` / `fileUploads` | `dsh-client-file-upload` `index.d.ts:9,12` | 文件上传 | `FileUploadService` / `FileUploads` |
| `webTerminals` / `terminalController` | `dsh-api-terminal-controller` `index.d.ts:11,12` | Web 终端 UI | `ClientTerminals` / `TerminalController` |
| `cotTranslation` | `dsh-experimental-client-ui-cot-translation` `index.d.ts:16` | 思维链翻译 | `CotTranslationController` |

### 2.8 其它实验性服务

| 服务名 | 来自哪个包 | 能做什么 | 关键类型/方法 |
| --- | --- | --- | --- |
| `inspector` | `dsh-experimental-inspector` `index.d.ts:30` | 运行时检查器 | `InspectorService` |
| `speechToText` | `dsh-experimental-speech-to-text` `index.d.ts:9` | 语音转文字（**命名 provider 注册表**） | `SpeechToText` |
| `speechController` | `dsh-experimental-api-speech-to-text` `index.d.ts:11` | 语音转文字（客户端认证面） | `SpeechController` |
| `translator` | `dsh-experimental-translator` `index.d.ts:10` | 翻译 | `Translator` |
| `messageFeedback` | `dsh-message-feedback` `index.d.ts:18` | 消息反馈 | `MessageFeedbackService` |
| `storage` / `storageDomain` | `dsh-storage` `index.d.ts:25` / `dsh-storage-domain` `index.d.ts:27` | **KV 存储**：注册 backend、开 KV unit | `Storage`；`registry.register(name, backend)` `:21` |
| `jobController` / `jobs`（API 面） | `dsh-api-job-controller` `index.d.ts:18` / `service.d.ts:76` | 作业控制面 | `JobController` / `IJobs` |
| `schedule` | `dsh-schedule` `index.d.ts:14` | **例程/定时调度** | `ScheduleService`（详见 §3.1） |
| `computerUse` | `dsh-computer-use`（profile 副本） | **独占具名计算机操作注册表** | `ComputerUseRegistry`；`register(name)`、`providerName` |

> **读表注意**：`sessions`（`dsh-session`）与 `sessions`（`dsh-api-session-controller` 的 `ISessions`）、`jobs`（`dsh-jobs`）与 `jobs`（`dsh-api-job-controller` 的 `IJobs`）都是**同名不同物**。`inject` 写 `sessions` 拿到哪个取决于哪一层激活；ds-bot 的 `index.js` 同时 inject 了 `sessions` 与 `sessionController`，说明两者在实际装配里并存。
>
> **`ctx.computerUse` 不在主安装目录的 299 个包里** —— 它装在 profile 目录（`C:\Users\12896\.dsh\profiles\web\node_modules\@deepseek-ai\dsh-computer-use`），因为它是 web profile 的 `dependencies` 而非 dsh 版本自带。这本身就是一条边界事实：**计算机操作能力是可选安装项，不是 DSH 内核能力。**

---

## 3. 能力边界表（核心）

### 3.1 能做（23 条）

| # | 能力 | DSH 用什么 | 证据 | 备注 |
|---|---|---|---|---|
| A1 | **Bot 团队 roster** | `ctx.agentTeams`：`membership(agent)`、`listMembers(agent)`、`tryMembership(agent)` | `dsh-experimental-agent-team/lib/types/index.d.ts:34,40` | `TeamId === SessionId`，每个 root Session 天然是隐式 Team 的 Lead，无创建事件 |
| A2 | **创建 teammate / 角色** | `ctx.agentTeams.spawnTeammate(caller, request)` | 同上 `:47` | **只有 Lead 可以 spawn**；teammate 可 fresh 或 fork；名字永久、永不复用 |
| A3 | **中断 teammate** | `ctx.agentTeams.interrupt(caller, targetName)` | 同上 `:96` | 仅限 Lead；返回 `{ previousStatus }` |
| A4 | **Bot 之间互发消息** | `ctx.agentTeams.sendMessage(caller, request)` | 同上 `:54` | 任何成员可发给任何成员，返回 inbox `MessageId` |
| A5 | **共享任务看板（DAG）** | `ctx.agentTeams.createTask` / `getTask` / `listTasks` / `updateTask` / `waitForChange` | 同上 `:61,:67,:74,:81,:89` | 依赖全完成才可 claim；owner 由成员 claim/释放/重开；`writeScopes` 文件提示 |
| A6 | **模型可见的团队工具** | `dsh-experimental-tool-agent-team`：`spawn_teammate`、`send_message`、`list_agents`、`wait_agent`、`interrupt_agent`、`team_task_create/list/get/update` | 该包 `README.zh.md`「九个工具，四类」 | 按作用域注册在成员 Agent 自己的 ctx 上 |
| A7 | **团队 Web UI** | `dsh-experimental-client-ui-agent-team`：向 Web 会话页头加 Agent Teams action，渲染 roster 与只读任务板 | 该包 `README.zh.md` | 读 `projectionsBySession[lead].values.agentTeam` |
| A8 | **例程 / 定时任务** | `ctx.schedule`：`create` / `list` / `catalog` / `history` / `update` / `delete` | `dsh-schedule/lib/types/index.d.ts:14` 起 | 支持 **after / at / every / daily / weekly / cron** 六种形态 |
| A9 | **例程的模型可见工具** | `dsh-tool-schedule`：`schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete` | 该包 `README.md` | 按 preset 或 Agent 作用域注册 |
| A10 | **MCP 连接器** | `@deepseek-ai/dsh-mcp-client`：`apply(ctx, config)`，`Config = StdioConfig \| StreamableHttpConfig` | 该包 `lib/types/index.d.ts` | 一个实例连一个 server；工具公开名为 `mcp__<serverName>__<rawName>`；生命周期 effect-scoped |
| A11 | **密钥 / 凭据管理** | `ctx.credentials`：`resolve(ref)` / `describe(ref)` / `set` / `unset` / `listRecords()` / `modifyRecord(key, mutate)` / `deleteRecord` | `dsh-credentials/lib/types/index.d.ts` | **两个键空间**：`CredentialRef`（POSIX shell 标识符）与 `CredentialKey`（`<scope>/<id>`） |
| A12 | **授权流（OAuth 式）** | `ctx.authorization`：`registerFlow(flow)`、`begin(request)`、`list()`、`cancel(key)` | `dsh-authorization/lib/types/index.d.ts:174,212,179,194` | 只能拿「配置给不了的凭据」；无自带 flow |
| A13 | **文件系统访问** | `ctx.fs`（抽象）+ `dsh-fs-local` / `dsh-fs-sandbox`（实现） | `dsh-fs/lib/types/index.d.ts:17` | 受沙箱策略约束；`dsh-fs-observation-policy` 提供「先读后写、版本守卫」 |
| A14 | **命令执行** | `ctx.shell`（抽象）+ `ctx.subprocess` + `ctx.terminals` + `ctx.jobs` | `dsh-shell/index.d.ts:16`、`dsh-subprocess:43`、`dsh-terminal:15`、`dsh-jobs:18` | 一次性命令走 `ctx.shell`；持久终端走 `ctx.terminals`；后台作业走 `ctx.jobs` |
| A15 | **沙箱策略** | `ctx.sandbox.confine(argv, policy, signal)` + `ctx.sandboxPolicy` + `ctx.permissionPresets` | `dsh-sandbox/index.d.ts:118,141`、`dsh-permission-presets:12` | 三档 preset：read-only / workspace-write / danger-full-access |
| A16 | **权限审批** | `ctx.approval`：`request(req)`、`setPolicy(agent, policy)`；工具管线 `tools/pre-execute` 返回 `{kind:'ask'}`；`approval/request` 事件 | `dsh-user-approval/index.d.ts:21`；`dsh-tools/index.d.ts` 的 `PreToolDecision` | 唯一授权值是 `'allowed-once'`；策略 `'ask' \| 'never'` |
| A17 | **Web UI 自定义面板** | 客户端 `ctx.slots.register(...)` + `ctx.sidebarRight.openTab(kind, options)` | `dsh-client-ui-renderer/lib/types/client/registry.d.ts:85`；`dsh-client-ui-sidebar-right/lib/types/client/service.d.ts:168` | 只能注册进**已声明**的 slot |
| A18 | **自建 HTTP 端点** | `ctx.connection.fetch.register({ path, methods, requestBody, fetch })` 或 `ctx.webServer.register(route)` | ds-bot 实证 `src/host/channel.js:329`；`dsh-host-webserver/index.d.ts:157` | 前者挂在共享 `/api` 通道、用会话 cookie 认证 |
| A19 | **用量统计（会话级）** | `ctx.tokenMeter` + `dsh-session-stats`（注册 `sessionStats` 投影）+ `ctx.sessionProjections` | `dsh-token-meter/index.d.ts:16`；`dsh-session-stats/index.d.ts`（`name = "session-stats"`） | 投影给的是**整段日志**的 turn/step 计数与墙钟时间 |
| A20 | **模型选择 / 切换** | `ctx.agentDefaultModel`、`ctx.llm.listModels/listProviders/resolveModelInfo`、`ctx.sessionController.selectModel(request)`、`ModelSelection` 投影 | `dsh-agent-default-model/index.d.ts:8`、`dsh-llm/index.d.ts:350,272,360`、`dsh-api-session-controller/index.d.ts:105` | `ModelSelection = { provider, model, reasoningEffort? }`，选择随 Session 持久 |
| A21 | **语音输入** | `ctx.speechToText`（命名 provider 注册表）+ `dsh-experimental-voice-input-bundle` | `dsh-experimental-speech-to-text/index.d.ts:9`；bundle README | 默认**关闭**；自带 `sensevoice-local` 本地 provider |
| A22 | **群聊 / 多 Bot 会话** | `ctx.sessionController.create({ workspaceId })` 造多个 root Session + 自建投递路由 + 自建 HTTP 端点 | ds-bot 实证：`src/host/roster.js` 的 `createSession()`、`src/host/groups.js`、`src/host/channel.js` | **DSH 原生没有「多 Bot 同一会话」**；ds-bot 的实现是「每个群聊一个 root Session + 宿主侧投递」 |
| A23 | **持久化自有状态** | `ctx.storage`（KV hub）+ `ctx.storageDomain`（schema 校验、发事件的 KV domain）+ `ctx.sessionPersistence` | `dsh-storage/index.d.ts:25`、`dsh-storage-domain:27`、`dsh-session-persistence:78` | ds-bot 选了更简单的路：`$DSH_HOME/bot/state.json` 一个 JSON 文件 |

> 计数：**23 条**（任务列的 17 个候选全部覆盖，另补 6 条：A6/A9 工具层、A12 授权流、A19 用量、A23 持久化）。

### 3.2 受限（12 条）

| # | 能力 | 有哪个 API | 硬限制是什么 | 证据 |
|---|---|---|---|---|
| B1 | **浏览器操作（打开网页、读页面、截图）** | 三条路都不完整 | ① `dsh-client-ui-sidebar-browser` 是**用户侧 iframe**，README 的 Model Experience 原文：「**无**。Browser tab 是用户侧呈现状态，不注册工具、prompt section 或 Session event。」② `ctx.web.search/fetch` 只拿 HTTP 响应体：无 JS 渲染、无 cookie 会话、无截图。③ `ctx.computerUse` 操作本机桌面（见 §3.3 C1）。ds-bot 的做法是 Electron `<webview>` + 客户端长轮询通道 + `read_browser` 工具，**仅 Desktop** | `dsh-client-ui-sidebar-browser/README.md`（Model Experience 段）；`.refs/DeepSeek-Bot/ds-bot/src/host/browser.js`（头注释） |
| B2 | **记忆系统** | 没有原生服务 | 机械扫描 129 个服务名里**没有 `ctx.memory` / `ctx.memories`**。DSH 只提供构件：`ctx.systemPrompt.section(...)` 注入记忆段 + `ctx.tools.register(...)` 提供读写工具 + 自己选存储。ds-bot 自建了一套 Agent Memory Repo 格式（`MEMORY.md` + 主题文件 + `journal.jsonl` + snapshots） | `research/_services-raw.txt` 全文无 memory 服务；`.refs/DeepSeek-Bot/ds-bot/src/host/memory.js` 头注释 |
| B3 | **Bot 创建 / 角色 / 命名** | `ctx.agentTeams.spawnTeammate` + `ctx.agents.create` | roster 是**扁平不可变**的：只 Lead 可建**直接** teammate，**无嵌套 Team、无重命名、无删除**；名字永久且永不复用；`maxMembers` 默认 16。要做「可增删改的 Bot 名册」必须自管状态（ds-bot 用 `state.json`） | `dsh-experimental-agent-team/README.zh.md`「已知限制」段 |
| B4 | **例程的投递目标** | `ctx.schedule.create(sessionId, request)` | **绑定到「被委派子代理拥有的 Session」会被拒绝**，错误码 `subagent_session`，因为 delivery 永远到不了；`create` 与 `update` 都拒，只有 `delete` 允许。所以「Bot 的定时任务」必须挂在 **root Session** 上 | `dsh-schedule/lib/types/index.d.ts` 的 doc 注释 |
| B5 | **审批 UI 的可见性** | `ctx.approval` + `approval/request` 事件 | 审批是 **fail-closed**：策略 `'ask'` 且无 answerer 时结果为 `'unavailable'`。更实际的问题是**隐藏 Session 的审批卡不显示**——ds-bot 的群聊 Session 是隐藏的，DSH 的审批卡在那里永远不出现，turn 会一直等，必须自己接管 `approval/request` 并在群聊里渲染 | `dsh-user-approval/lib/types/index.d.ts`；`.refs/DeepSeek-Bot/ds-bot/src/host/approvals.js` 头注释 |
| B6 | **Web UI 自定义面板** | `ctx.slots.register(options, component)` | 只能注册进**已声明的 slot**（注册进未声明的 slot 会 throw）；**一个 slot 只能有一个声明者**（重复声明子 key 会 throw）；`app` 是 single slot，第二个注册会 **shadow 掉框架而不是并排**，可叠加的只有 `shell.overlay` 这类 list slot | `dsh-client-ui-slots/lib/types/index.d.ts`；`dsh-client-ui-renderer/lib/types/client/registry.d.ts:24-29` 注释 |
| B7 | **跨 Bot 用量统计** | `ctx.tokenMeter`、`sessionStats` 投影 | 计量是**会话级**的；没有账户级 / Bot 级配额或计费 API。要「每个 Bot 花了多少 token」必须自己扫会话日志（ds-bot 用 `usage.sqlite` 扫日志，并把「不在任何日志里的调用」靠流式拦截补齐） | `dsh-token-meter/lib/types/index.d.ts`；`.refs/DeepSeek-Bot/ds-bot/src/host/usage.js` 头注释 |
| B8 | **跨机器 / 跨进程 Team** | `ctx.agentTeams` | README 原文：「单进程共享 checkout（**无 worktree、无远端成员、无 merge、无文件锁**）」；`writeScopes` 只是**提示**，Bash/formatter 可以绕过 | `dsh-experimental-agent-team/README.zh.md`「已知限制」段 |
| B9 | **消息投递可靠性** | `ctx.agentTeams.sendMessage` | README 原文：「**不保留未接收的发送意图、重启不重试、不去重**」。要可靠投递得自己加一层 | 同上 |
| B10 | **语音输入** | `ctx.speechToText` | **默认关闭**，要装 `dsh-experimental-voice-input-bundle`；provider 是命名注册表，`defaultProvider` **必填**且必须精确匹配已注册 id，缺失或重复会显式失败；bundle 详情里要手动「Download and prepare」下载识别模型 | `dsh-experimental-speech-to-text/README.md`；`dsh-experimental-voice-input-bundle/README.md` |
| B11 | **MCP 连接器的隔离** | `dsh-mcp-client` | 一个实例**只连一个 server**；`serverName` 全局唯一（`[A-Za-z0-9_-]{1,32}`）且决定工具公开名，冲突即失败；要连 N 个服务就得装 N 个实例。ds-bot 的应对是把 `ctx.plugin(MCP_CLIENT, config)` 挂到**每个 agent 的 ctx** 上做作用域隔离 | `dsh-mcp-client/lib/types/index.d.ts`；`.refs/DeepSeek-Bot/ds-bot/src/host/capabilities.js` |
| B12 | **沙箱的强度** | `ctx.sandbox.confine` | README 原文：「**Same-world confinement only** — 进程仍然共享宿主内核与文件系统；整个环境必须隔离时，用容器、microVM 或远端执行器。」DSH 只提供**同世界**的约束 | `dsh-sandbox/README.md`「Summary」段 |

> 计数：**12 条**。

### 3.3 做不了（8 条）

| # | 能力 | 为什么做不了 | 证据 |
|---|---|---|---|
| C1 | **Bot 拥有自己的云计算机 / 远程桌面** | `ctx.computerUse` 是**独占具名注册表**：`register(name)` 占用唯一 provider 名额直到 contribution 被释放，**第二次注册（即使同名）会失败**。它操作的是**本机共享桌面**，README 原文：「**共享桌面** —— 并发 Session 和独立 DSH 进程可以操作同一桌面；调用方协调完整的计算机操作流程。」另一条原文：「**提供方选择** —— 由配置选择提供方；模型不能在运行时切换已注册的驱动。」没有「给每个 Bot 分配一块屏幕 / 一个会话」的原语 | `dsh-computer-use/lib/types/index.d.ts`（`ComputerUseRegistry`）；`dsh-computer-use/README.zh.md`「已知限制」 |
| C2 | **云端多租户持久远程桌面** | 机械扫描 129 个服务名里**没有任何容器 / microVM / 远端执行器 / VNC / RDP 编排服务**。`dsh-sandbox` README 明确：「containers, microVMs, and remote execution **require replacing capability implementations rather than adding a provider here**」——即必须替换整个 `ctx.shell`/`ctx.fs` 实现，而 DSH 不带这种实现。唯一的容器级隔离是 PTC 的 `dsh-ptc-runtime-node`（沙箱化的 Node 进程），它是**执行器**不是**桌面** | `research/_services-raw.txt` 无相关服务；`dsh-sandbox/README.md`「When to choose it」段 |
| C3 | **每 Bot 一块独立屏幕的浏览器会话（DSH 原生）** | 客户端 Browser tab 是**用户侧呈现**，不注册工具；`ctx.computerUse` 只给**一个** provider 名额，且共享同一桌面。要「N 个 Bot 各有一块互不干扰的屏幕」，插件层拿不到这种分配原语。ds-bot 用 Electron `<webview>` 的**独立 storage partition**（`dshDesktop.browser.acquire('bot:<id>')`）绕，但那是 **Desktop 专属**，且页面活在 app 窗口里不在宿主进程里 | `dsh-client-ui-sidebar-browser/README.md`；`.refs/DeepSeek-Bot/ds-bot/src/client/bot-browsers.js` 头注释 |
| C4 | **模型可见的浏览器工具（DSH 原生）** | `dsh-client-ui-sidebar-browser` 的 Model Experience 明写「**无**」。DSH 里能读网页的模型工具只有 `web_fetch`（HTTP 响应体），没有「打开浏览器 → 等 JS 渲染 → 读 DOM → 截图」这一串 | `dsh-client-ui-sidebar-browser/README.md`（Model Experience 段） |
| C5 | **账户级 / Bot 级用量配额与计费** | 无对应服务。`dsh-deepseek-account` 只**读**账号状态与解析官方凭据；`ctx.tokenMeter` 是会话级；没有「给某 Bot 设额度、超了拒绝调用」的钩子 | `dsh-deepseek-account/index.d.ts:14`；`dsh-token-meter/index.d.ts:16` |
| C6 | **跨进程 / 跨机器的 Team 成员** | Agent Teams 的 README 明确是**单进程共享 checkout**，无远端成员；`TeamId === SessionId` 且 Session 存储是进程内的（持久化只是日志落盘，不是分布式协调） | `dsh-experimental-agent-team/README.zh.md`「已知限制」段 |
| C7 | **给 Bot 独立操作系统用户 / 独立文件系统根** | `ctx.sandbox` 是 same-world 的**进程级**约束（Windows 走 restricted token + capability SID 写白名单，Linux 走 bwrap/landlock），没有「每个 Bot 一个独立 home / 独立 uid」的建模 | `dsh-sandbox/README.md`；`dsh-sandbox-windows-acl`、`dsh-sandbox-local` 包描述 |
| C8 | **原生记忆服务** | 不存在 `ctx.memory`。这不是「受限」而是「做不了（DSH 层面）」—— 要做记忆只能自己造，DSH 不给语义层 | `research/_services-raw.txt` 全文无 memory 服务 |

> 计数：**8 条**。

### 3.4 边界小结

| 类别 | 条数 | 一句话 |
| --- | --- | --- |
| 能做 | **23** | 团队、消息、任务板、例程、连接器、审批、凭据、沙箱、UI 面板、模型选择全部有公开 API |
| 受限 | **12** | 记忆、浏览器、用量、跨进程、消息可靠性、slot 排他性 —— 都能做但有硬限制，需要自建一层 |
| 做不了 | **8** | 全部围绕「独立计算环境」：云计算机、多租户远程桌面、独立屏幕、独立 OS 用户、账户级配额 |

**规律**：DSH 的插件边界是**「进程内的能力扩展」**。凡是「给某个 agent 一份独占的、隔离的、持久的外部资源」，DSH 都没有建模 —— 它把 agent 都放在**同一个世界**里，靠 `sandbox`（同世界约束）、`approval`（人工闸门）、`permissionPresets`（三档策略）来管理风险，而不是靠隔离。

---

## 4. Grok Bot 对标结论

把 §3 的三张表逐条映射到 Grok Bot 的能力域（Grok Bot 功能面见 `research/grok-bot-features.md`，15 个能力域 / 173 条）。

| Grok Bot 能力 | DSH 对应 | dsh-bot 能不能复刻 | 说明 |
|---|---|---|---|
| **Bot 本体与人格**（命名、头像、角色、人格设定） | 能做 A1/A2 + `ctx.agentPresets` + `ctx.systemPrompt` | ✅ **能** | ds-bot 已实证：`state.json` 存名字/颜色/头像 + `ctx.systemPrompt.section` 注入人格。DSH 原生 `agentPresets` 是更强的版本（可声明式装配工具集） |
| **Bot 拥有自己的云计算机** | 做不了 C1/C2/C3 | ❌ **不能** | 见 §4.1 专项结论 |
| **浏览器与网页操作** | 受限 B1 + 做不了 C4 | ⚠️ **部分能（Desktop 专属）** | ds-bot 的做法：Electron `<webview>` + 每 Bot 独立 storage partition + 客户端长轮询通道 + `read_browser` 工具。**Web 端完全做不到**（Web 用 iframe，站点拒嵌、跨域 URL 读不到） |
| **例程与触发**（cron、事件触发、Pause/Resume/Test） | 能做 A8/A9 + 受限 B4 | ✅ **基本能** | `ctx.schedule` 支持六种调度形态（含 cron），有 `update`/`delete`/`history`；**缺**：Grok Bot 的**事件触发器**（Slack thread / GitHub PR）DSH 没有原生对应，要自己监听外部事件后调 `ctx.schedule.create` |
| **记忆** | 受限 B2 / 做不了 C8 | ⚠️ **能做，但要自建** | DSH 无记忆服务。ds-bot 自建 Agent Memory Repo 格式（Markdown + `[key: value]` 元数据 + journal + snapshots），并用「每轮后的 memory review」保证记忆不依赖模型主动调用 |
| **权限与审批**（三态 Ask first / Always allow / Custom Rules、独立 review agent） | 能做 A16 + 受限 B5 | ✅ **基本能** | `ctx.approval` + `permissionPresets` 三档 + `dsh-experimental-auto-review`（每工具调用前由当前 agent 的模型评估，allowed 则以 Full access 执行，denied 则问用户）。**缺**：Grok Bot 的「Always allow 粒度到该 Bot / 所有 Team Bot」需要自己建模 |
| **连接器与凭据**（MCP、Team Secrets、Secure Forms） | 能做 A10/A11/A12 + 受限 B11 | ✅ **能** | ds-bot 实证：GitHub 走 `dsh-mcp-client`，token 存自有 `secrets.json`（mode 600）+ 以 `$DSH_SECRET_<NAME>` 下发 shell + 在每次模型请求前替换为 `[secret:<NAME>]`。DSH 原生 `ctx.credentials` 是更规范的版本 |
| **技能与插件** | 能做 + `ctx.skills` + `ctx.pluginManager` | ✅ **能** | DSH 的 skill 体系与插件体系都比 Grok Bot 更成熟 |
| **模板与团队分发**（Publish to Team、带聊天与记忆 / Start fresh） | 能做（`ctx.pluginManager.installBundle`）+ 自建 | ⚠️ **部分能** | 插件分发 DSH 有（`installBundle`）；但「把某个 Bot 的人格+记忆+技能打包发给队友」需要 dsh-bot 自己定义格式与导入导出 |
| **多 Bot 协作**（Team、互相发消息） | 能做 A1-A7 | ✅ **能，且是 DSH 原生强项** | `dsh-experimental-agent-team` 四件套直接覆盖 roster + 点对点消息 + 共享任务 DAG + Web UI |
| **项目与任务编排** | 能做 A5/A6 + `ctx.workflowEngine` | ✅ **能** | 任务板有依赖图与 claim 语义；`ctx.workflowEngine` 还能跑可编程的多 agent 编排 |
| **多渠道触达与客户端** | 能做 A18 + `ctx.webServer` | ⚠️ **部分能** | HTTP 端点、Web 面板都能做；但 Grok Bot 的 Slack / 邮件等外部渠道要自己接（DSH 无渠道抽象） |
| **交付物形态**（文档、表格、报告） | 能做（`dsh-office-to-pdf`、`dsh-client-ui-sidebar-documentpreview`、`dsh-tool-present`） | ✅ **能** | DSH 的文档链路比 Grok Bot 更完整（含 LibreOfficeKit 预编译引擎） |
| **治理、用量与企业能力** | 受限 B7 / 做不了 C5 | ❌ **基本不能** | 会话级用量能拿；**账户级配额、企业 SSO、审计导出**在 DSH 插件边界内没有对应 API |
| **客户端界面** | 能做 A17 + 受限 B6 | ✅ **能** | slot 注册表 + 右侧栏 + 配置表单；ds-bot 有 55 个客户端模块的实证 |

### 4.1 专项结论：「Bot 拥有自己的云计算机」到底能不能做

**结论：不能。** 三条独立的证据链，任何一条都足以否掉：

**证据链一 —— 能力层面对不上。**
`ctx.computerUse` 是 `ComputerUseRegistry extends Service`，它的**全部公开接口**只有两个成员：

```ts
get providerName(): ComputerUseProviderName | undefined
register(name: ComputerUseProviderName): () => Promise<void>
```

（来源：`dsh-computer-use/lib/types/index.d.ts`）

它是一个**独占名额的注册表**，不是「分配一台机器」的 API。README 原文补充：「本包不添加模型可见工具，也不协调并发 Session。」

**证据链二 —— 语义层面相反。**
`dsh-computer-use/README.zh.md` 的两条已知限制，逐字：

> **共享桌面** —— 并发 Session 和独立 DSH 进程可以操作同一桌面；调用方协调完整的计算机操作流程。
> **提供方选择** —— 由配置选择提供方；模型不能在运行时切换已注册的驱动。

Grok Bot 的云计算机是「**每个 Bot 一块 1920×1200 屏幕，删除 Bot 会释放它的屏幕**」（`x.ai/changelog/bot` v0.62.0 原文），即**多租户 + 按 Bot 分配 + 可回收**。DSH 的 computer-use 是**单例 + 共享 + 不可切换**。两者在语义上正好相反。

**证据链三 —— 服务清单层面不存在。**
机械扫描 137 条 Context augmentation / 129 个服务名，**没有任何** `ctx.vm`、`ctx.container`、`ctx.remoteDesktop`、`ctx.screen`、`ctx.machine` 之类的服务。`dsh-sandbox` 的 README 主动划清了界限：

> **Same-world confinement only** — containers, microVMs, and remote execution require replacing capability implementations rather than adding a provider here.

**那么「共享计算机 + 每 Bot 一块屏幕」能不能部分复刻？**

能，但形态不同，且要付代价：

| 做法 | 可行性 | 代价 |
|---|---|---|
| **Desktop 端每 Bot 一个 Electron `<webview>` + 独立 storage partition** | ✅ ds-bot 已实现 | 仅 Desktop；页面活在 app 窗口里不在宿主进程里，宿主读页面要靠**客户端长轮询通道**（ds-bot 的 `browser-wait` / `browser-result` 协议）；`MAX_LIVE = 6` 个活跃 guest 后 LRU 释放 |
| **宿主进程内起多个浏览器实例** | ❌ | 没有浏览器自动化依赖，`ctx.computerUse` 只给一个 provider 名额 |
| **云端多租户持久远程桌面** | ❌ | 需要 DSH 之外的一整套基础设施（虚拟机编排 + 串流协议 + 多租户隔离），插件层碰不到 |

**给 dsh-bot 的建议**：把「云计算机」重新定义为**「每个 Bot 一个工作空间 + 一个 Desktop 浏览器面板 + 一套自有文件」**，而不是「一台机器」。价值重心（团队 + 共享计算资源 + 例程）可以复刻；「云端多租户持久桌面」这一层要另建基础设施，不属于插件边界。

---

## 5. 可用包清单

`@deepseek-ai` 下 **299 个包**，按用途分类。每包一句话。

### 5.1 核心运行时与装配（约 40 个）

| 包 | 一句话 |
|---|---|
| `dsh` | dsh CLI：profile 启动、插件管理、配置检查 |
| `dsh-base` | 共享核心 bundle，所有 base-backed profile 的第一层 patch |
| `dsh-web-app` | 浏览器面 bundle：web patch 层 + 运行时胶水 |
| `dsh-headless` | 一次性执行 bundle：无 Host / HTTP / 浏览器的核心 runner |
| `dsh-sdk-app` / `dsh-sdk-minimal` / `dsh-acp-app` | SDK 与 ACP 的 profile bundle |
| `cordis` / `cosmokit` / `schemastery` | IoC 框架本体、通用工具、类型驱动 schema 校验 |
| `cordis-plugin-loader` / `-group` / `-include` / `-timer` | Loader、插件分组、配置文件 include、定时器 |
| `dsh-app-boot` | 共享启动胶水：`.env` 加载、fail-loud Loader 守卫、快照感知的配置解析 |
| `dsh-cmdline` / `dsh-launch-environment` | 命令行交接、启动环境快照 |
| `dsh-hmr` / `dsh-client-hmr` | 模块与 profile 配置热重载 |
| `dsh-plugin-manager` | 当前 profile 的插件与 bundle 管理（CLI / Web / agent 工具共用） |
| `dsh-config-editor` / `dsh-settings` | 配置编辑、用户 settings 命名空间 |
| `dsh-brand` / `dsh-home-paths` / `dsh-util-values` / `dsh-util-time` / `dsh-util-crypto` / `dsh-util-code-language` / `dsh-util-workspace-path` | 品牌类型与各类零依赖工具 |
| `dsh-atomic-write` / `dsh-chunked-list` / `dsh-deque` / `dsh-lazy-require` / `dsh-output-retention` / `dsh-timeout` / `dsh-scope` | 原子写、分块追加列表、双端队列、惰性加载、有界保留、超时原语、作用域标签 |
| `dsh-package-manifest` | `package.json.dsh` 字段的共享类型声明 |
| `dsh-anonymous-user-id` / `dsh-http-proxy` / `dsh-win32-process` / `node-addon-system` | 匿名用户标识、出站代理策略、Win32 原语、Node-API 原生模块 |

### 5.2 会话、Agent 与编排（约 45 个）

| 包 | 一句话 |
|---|---|
| `dsh-session` | 事件溯源会话存储：append-only 日志 + 内存 store + 派生消息历史 |
| `dsh-agent` / `dsh-agent-loop` | Agent 接口与注册表；具体 agent 循环插件 |
| `dsh-agent-preset` / `-registry` / `-default-model` / `-instructions` / `-tool-presentation` | 预设声明、注册表、默认模型、AGENTS.md 加载、PTC/native 呈现选择 |
| `dsh-session-persistence` / `-jsonl` | 会话持久化 seam 与 JSONL 后端 |
| `dsh-session-projection` / `-cache` | 会话投影 seam 与持久化投影缓存 |
| `dsh-session-query` / `-sqlite` | 跨会话查询契约与 SQLite FTS5 后端 |
| `dsh-session-title` + `-llm` + `-first-prompt-llm` + `-all-prompts-llm` | 会话标题服务与两个 LLM provider |
| `dsh-session-stats` / `-turn-outline` / `-reference` / `-log-export` / `-log-deepseek` | 统计投影、轮次大纲、跨会话引用、日志导出、官方 API 增量日志扩展 |
| `dsh-session-format` + `-catalog` + `v0-to-v1`/`v1-to-v2`/`v2-to-v3`/`v3-to-v4` | 会话格式迁移机器与各版本冻结 codec |
| `dsh-session-checkpoint-policy` / `-telemetry` / `-telemetry-otel` | 语义检查点、遥测后端、OTel 导出 |
| `dsh-compaction` / `-basic` / `-image-offload` / `-tool-result-pruner` | 压缩 seam、token 驱动的压缩策略、图像卸载、工具结果剪枝 |
| `dsh-goal` / `-round-driver` | 事件溯源的同会话目标状态与轮次驱动 |
| `dsh-plan-mode` / `dsh-workflow` / `-ptc` | 计划模式、工作流 seam、沙箱 Node 运行时里的编排 |
| `dsh-subagent` + `-spawn-in-process` + `-fork-in-process` | 子代理 seam 与两个进程内后端 |
| `dsh-experimental-agent-team` + `-tool-` + `-client-ui-` + `-profile` | **Agent Teams 四件套**（见 §3.1 A1-A7） |
| `dsh-experimental-worktree` / `-tool-worktree` | git worktree 创建与进入 |
| `dsh-experimental-ralph-bundle` / `dsh-tool-ralph` | 新 agent 迭代循环 |
| `dsh-experimental-session-search` / `dsh-tool-session-query` | 会话历史检索工具 |
| `dsh-experimental-inspector` / `-profile` / `-session-inspector` | 跨 realm CDP hub、原始日志检查器 |
| `dsh-attachment` / `-local` | 附件 seam 与内容寻址存储 |
| `dsh-spill` / `-local` / `-policy` | 溢出存储 seam、本地实现、token 预算保留策略 |
| `dsh-file-reference` / `-local` | 文件引用契约与本地 provider |
| `dsh-persona` / `dsh-time-context` / `dsh-tmux-context` | 部署人格段、当前时间上下文、tmux 位置上下文 |

### 5.3 工具（约 40 个）

| 包 | 一句话 |
|---|---|
| `dsh-tools` | **工具注册表与执行管线**（`ctx.tools`，含 pre/execute/post 三段钩子） |
| `dsh-tool-fs` / `-fs-search` / `-str-replace-editor` | read/write/edit、glob/grep、视图与替换编辑 |
| `dsh-tool-bash` / `-pwsh` / `-bash-persistent` / `-pwsh-persistent` / `-terminal` | 一次性与持久 shell 工具 |
| `dsh-tool-jobs` / `-call-timeout-policy` | 后台作业控制、工具调用超时策略 |
| `dsh-tool-web` / `-subagent` / `-subagent-control` / `-workflow` / `-todo` / `-goal` | 联网、子代理、子代理控制、工作流、待办、目标 |
| `dsh-tool-skill` / `-schedule` / `-ask-user` / `-present` / `-cordis` | 技能加载、例程、提问、交付声明、运行时 API 检查 |
| `dsh-tool-working-directory` / `-workspace-dependencies` | 工作目录读写、工作区依赖路径 |
| `dsh-commands` / `-compact` / `-feedback` / `-goal` | 人类命令注册表与三个内置斜杠命令 |
| `dsh-skill` / `-filesystem` / `-office` / `-badge` | 技能注册表与三个 provider |
| `dsh-mcp-client` / `-resources` | **MCP 客户端桥**与 MCP 资源发现 |
| `dsh-ptc-runtime` / `-node` | PTC 执行 seam 与沙箱 Node 实现 |
| `dsh-user-questions` / `-user-approval` / `-authorization` / `-permission-presets` | 提问、审批、授权流、权限预设 |
| `dsh-repeat-tool-reminder` / `-message-feedback` / `-command-feedback` | 重复调用提醒、消息反馈 |
| `dsh-office-to-pdf` / `libreoffice-kit` / `-win32-x64` | Office 转换与预编译引擎 |

### 5.4 LLM（约 10 个）

| 包 | 一句话 |
|---|---|
| `dsh-llm` | **provider 中立的 LLM 服务接口**（`ctx.llm`） |
| `dsh-llm-deepseek` / `-deepseek-api-key` / `-deepseek-account` | DeepSeek Messages adapter 与两种鉴权 |
| `dsh-llm-pi-ai` / `-retry` | pi-ai 后端适配器、provider 路由的重试策略 |
| `dsh-deepseek-account` / `-platform` / `-llm-api-extensions` | 账号状态、浏览器 PKCE 授权、请求字段扩展注册 |
| `dsh-session-log-deepseek` / `-plugin-package-inventory-deepseek` | 官方 API 的增量日志扩展、活跃插件包清单 |

### 5.5 沙箱与执行（约 15 个）

| 包 | 一句话 |
|---|---|
| `dsh-sandbox` / `-local` / `-windows-acl` / `-policy` | 沙箱 seam、bwrap/landlock 后端、Windows restricted-token 后端、逐调用策略解析 |
| `dsh-fs` / `-local` / `-sandbox` / `-observation-policy` | 文件系统 seam、本地实现、沙箱实现、先读后写策略 |
| `dsh-shell` / `-bash-local` / `-pwsh-local` / `-bash-sandbox` / `-pwsh-sandbox` / `-env` | shell seam、各平台执行器与沙箱执行器、环境变量注册表 |
| `dsh-subprocess` / `-local` | 子进程 seam 与本地实现 |
| `dsh-terminal` / `-bash` | 持久 PTY 会话 seam 与 bash 后端 |
| `dsh-jobs` / `-local` | 后台作业注册表与本地实现 |
| `dsh-credentials` / `-local` | 凭据 seam 与 `$DSH_HOME/.env` 后端 |
| `dsh-storage` / `-json` / `-domain` | KV hub、JSON 后端、schema 校验的 domain |

### 5.6 客户端 UI（约 55 个）

| 包 | 一句话 |
|---|---|
| `dsh-client-ui-renderer` / `-slots` / `-primitives` / `-layout` | 渲染器、**slot 注册表纯核心**、纯 React 原子组件、三栏外壳 |
| `dsh-client-ui-conversation` / `-chat` / `-session` / `-trajectory` | 对话装配、聊天节点、会话适配、轨迹事件账本 |
| `dsh-client-ui-sidebar` / `-right` / `-browser` / `-terminal` / `-files` / `-documentpreview` | 左栏会话树、右栏停靠面、浏览器 tab、终端 tab、文件树、文档预览 |
| `dsh-client-ui-settings` + `-general` / `-models` / `-plugins` / `-account` / `-shell` / `-subagent` / `-web-search` / `-agent-loop` / `-plugin-inventory` / `-session-log` | 设置域基座与各分区页面 |
| `dsh-client-ui-tool` / `-approval` / `-user-questions` / `-plan` / `-goal` / `-jobs` / `-workflow-run` | 工具调用树、审批接管、提问面板、计划、目标条、作业列表、工作流节点 |
| `dsh-client-ui-model-selection` / `-agent-preset` / `-permission-presets` | 模型选择、预设界面、权限预设界面 |
| `dsh-client-ui-commands` / `-input-trigger` / `-shortcuts` / `-reference` / `-skill` / `-subagent` | 命令面板、输入触发、快捷键、引用源、技能行、子代理目录 |
| `dsh-client-ui-theme` / `-locale` / `-brand-official` / `-message-feedback` / `-deliverables` | 主题、多语言、品牌占位、反馈、变更文件卡 |
| `dsh-client-modules` / `-connection` / `-store` / `-resources` / `-file-upload` / `-product-analytics` / `-cordis-*` | 客户端模块系统、RPC 传输、observable store、资源模型、文件上传、分析、动态插件定义 |
| `dsh-client-ui-agent-team`（experimental） | Agent Teams 的 Web 面板 |
| `dsh-client-ui-cot-translation`（experimental） / `-voice-input` | 思维链翻译、语音录制 |

### 5.7 宿主与 Web 服务（约 20 个）

| 包 | 一句话 |
|---|---|
| `dsh-host-webserver` | **HTTP/HTTPS 服务器**：命名路由、upgrade、index 变换、fallback |
| `dsh-host-frontend-static` | Web 外壳的 SPA dist 服务 |
| `dsh-web-frontend` | Vite 构建的 Web 应用入口 |
| `dsh-api-gateway` / `-remotes` | Typert Remote 宿主分发器与 BFF 装配 |
| `dsh-api-session-controller` / `-workspace-controller` / `-workspace-files` / `-settings-controller` / `-terminal-controller` / `-job-controller` / `-account-controller` | 各域的控制面 |
| `dsh-api-speech-to-text`（experimental） | 浏览器客户端的认证语音转写 |
| `dsh-typert-protocol` / `-registry` / `-loader` | Remote 元数据协议、反射注册表、Loader 集成 |
| `dsh-host-plugin-inventory` / `-open-in-app` / `-directory-picker` + `-auto`/`-browse`/`-native` / `-product-telemetry-otel` | 插件清单投影、外部应用打开、目录选择 seam 与三后端、产品遥测 |
| `dsh-message-feedback` / `-session-log-export` / `-workspace-changes` | 反馈、日志导出、变更跟踪 |

### 5.8 实验性（约 25 个）

| 包 | 一句话 |
|---|---|
| `dsh-experimental-agent-team` 四件套 | **Bot 团队原生基座**（最重要的一组） |
| `dsh-experimental-auto-review` | 每工具调用前由模型评估的 Auto 权限预设 |
| `dsh-experimental-voice-input-bundle` / `-speech-to-text` / `-speech-to-text-sensevoice` / `-api-speech-to-text` / `-client-ui-voice-input` | 语音输入全套（本地 SenseVoice ONNX） |
| `dsh-experimental-computer-use-cua-driver-native` | **计算机操作 provider**（`@trycua/cua-driver`，工具前缀 `cua_driver_native__`） |
| `dsh-computer-use` | **计算机操作独占注册表**（可选安装，非内核） |
| `dsh-experimental-terminal-bundle` | 跨工具调用保持 shell 进程 |
| `dsh-experimental-worktree` / `-tool-worktree` / `-ralph-bundle` / `-session-search` / `-session-titles-bundle` | 见 §5.2 |
| `dsh-experimental-inspector` / `-profile` / `-session-inspector` | 运行时检查器 |
| `dsh-experimental-translator` / `-cot-translation-bundle` / `-client-ui-cot-translation` | 翻译与思维链翻译 |
| `dsh-experimental-badge-skill-bundle` | powered-by-DSH 徽章技能 |

### 5.9 不完整清单（已知缺口）

- **`dsh-mnemon`、`dshmarket`、`dsh-generative-ui`、`dsh-auto-decide`、`dsh-mmaping`、`clearai-dsh`、`billion-context`、`dsh-model-fusion`、`dsh-web-fetch-enhanced`、`dsh-plugin-session-drag`、`@linxin666/dsh-client-ui-*`** —— 这些出现在 Web profile 的 bundle 列表里，但**不在 `@deepseek-ai` 作用域下**（第三方或本机 link 安装）。它们是第三方插件能力的现成样本，需要时单独调研。

---

## 6. dsh-bot 插件骨架

基于 §1 的机制，最小可运行插件所需的文件清单。

### 6.1 文件清单

```
dsh-bot/
├── package.json          # ① dsh 字段声明（bundle patch + client platform）
├── cordis.patch.yml      # ② 装配层：插入自己的行、覆盖别人的 config
├── index.js              # ③ 宿主半边入口（函数插件：name / inject / apply）
├── client.js             # ④ 浏览器半边（构建产物，window.__ModuleLoader__.load）
├── src/
│   ├── host/             #    宿主侧模块，每个导出 install(rt)
│   └── client/           #    客户端模块源码（构建前）
├── scripts/
│   └── build-client.mjs  # ⑤ esbuild 打包 client.js
├── locale/
│   ├── en.json           # ⑥ 可选：locale 字典（由客户端 apply 注册）
│   └── zh.json
└── README.md
```

### 6.2 每个文件的关键内容

**① `package.json`** —— 关键字段一个都不能少：

```json
{
  "name": "dsh-bot",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "client.js", "src/", "cordis.patch.yml", "README.md"],
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-agent": "*",
    "@deepseek-ai/dsh-llm": "*",
    "@deepseek-ai/dsh-session": "*",
    "@deepseek-ai/dsh-tools": "*"
  },
  "dsh": {
    "client": { "platform": "web" },
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```

- `dsh.bundle.patch` → 让本包成为可装配的 bundle；
- `dsh.client.platform: "web"` → 让宿主扫描到客户端模块；
- `exports["./client"]` → 浏览器半边入口；
- `type: "module"` → ESM（cordis 插件是 ESM）。

**② `cordis.patch.yml`** —— 顶层 YAML 数组：

```yaml
# Mount the Bot team host plugin; the browser half is discovered through the
# package's dsh.client manifest and ./client export.
- insert:
    - id: bot
      name: dsh-bot
```

若要复用 DSH 原生 Agent Teams，可在此层**替换**默认的子代理工具行（这正是 `dsh-experimental-agent-team-profile` 的做法）：

```yaml
- id: tool-subagent
  disabled: true
- id: tool-subagent-fork
  disabled: true
- insert:
    - id: agent-team
      name: '@deepseek-ai/dsh-experimental-agent-team'
      config: { maxMembers: 8, maxTasks: 256 }
```

**③ `index.js`** —— 宿主半边：

```js
// 服务依赖：到齐前 fiber 停 PENDING，掉线自动重载
export const inject = ['tools', 'sessions', 'sessionController', 'agents', 'systemPrompt']

export const name = 'dsh-bot'

export function apply(ctx, config = {}) {
  // 1) 注册工具（唯一入口 ctx.tools.register，返回 disposer）
  ctx.effect(() => ctx.tools.register({
    name: 'bot_list',
    description: '列出团队里的 Bot',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (args, exec) => ({ content: [{ type: 'text', text: '...' }] }),
  }), 'dsh-bot: bot_list tool')

  // 2) 注入系统提示段（人格 / 记忆）
  ctx.effect(() => ctx.systemPrompt.section({ /* ... */ }), 'dsh-bot: persona section')

  // 3) 订阅事件（agent/created、agent/status、llm/stream、approval/request…）
  ctx.effect(() => ctx.on('agent/created', (agent) => { /* ... */ }), 'dsh-bot: agent/created')

  // 4) 可选依赖用 ctx.inject，缺失时不阻塞
  ctx.inject(['schedule'], (sub) => { /* 挂载例程支持 */ })

  // 5) 自建 HTTP 端点（浏览器半边用同源 fetch 调它）
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/bot',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await request.json()
      return new Response(JSON.stringify({ ok: true, value: await handle(body) }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }), 'dsh-bot: api route')
}
```

**④ `client.js`** —— 浏览器半边，由构建脚本生成，形状是：

```js
window.__ModuleLoader__.load({
  id: 'dsh-bot',
  factory: (require) => {
    const { createElement: h } = require('react')
    // ...
    module.exports = { apply, inject }
    return module.exports
  },
})
```

客户端 `apply` 里做的事：

```js
export const inject = ['slots', 'uiConversation', 'uiWorkspace', 'theme', 'layout', 'locale']

export function apply(ctx) {
  // 1) 注册 locale 字典
  ctx.effect(() => installLocale(ctx.get('locale')), 'dsh-bot: interface copy')
  // 2) 注册 slot 组件（只能注册进已声明的 slot）
  ctx.effect(() => ctx.slots.register({ /* slot 契约 */ }, MyComponent), 'dsh-bot: header')
}
```

**⑤ `scripts/build-client.mjs`** —— 关键参数：

```js
const PLATFORM_MODULES = ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']
await build({
  absWorkingDir: PLUGIN,
  entryPoints: ['src/client/index.js'],
  bundle: true, format: 'cjs', platform: 'browser', target: 'es2022',
  external: PLATFORM_MODULES,
  treeShaking: false, charset: 'utf8', write: false,
})
// 手工包上 window.__ModuleLoader__.load({ id: 'dsh-bot', factory }) 的外壳
```

**⑥ `locale/{en,zh}.json`** —— 通过客户端 `ctx.get('locale')` 注册。

### 6.3 起手路线（三条，按成本从低到高）

| 路线 | 做法 | 适用 |
|---|---|---|
| **① 只做宿主插件** | 一个 `index.js` + `cordis.patch.yml`，注册工具与事件，不做客户端 | 验证「Bot 团队」核心机制（§3.1 A1-A5） |
| **② 宿主 + 复用原生 Web UI** | 直接装 `dsh-experimental-agent-team-profile`，自己只补 Grok Bot 独有能力 | 最快拿到可用的 roster + 任务板界面 |
| **③ 宿主 + 自建客户端** | 照 ds-bot 的形状：`src/host/*.js` 多模块 + `src/client/*.js` + esbuild 打包 + `POST /api/bot` 通道 | 需要自己的 Bot 列表、详情页、群聊界面 |

**建议**：从 ② 起手。`dsh-experimental-agent-team-profile` 已经是一个完整的 bundle（`cordis.patch.yml` 只做「禁用四个 subagent 工具行 + 插入三行」），照它的形状改一处就能验证装配链路是否打通，再决定要不要自建客户端。

### 6.4 必知陷阱清单

| 陷阱 | 后果 | 规避 |
|---|---|---|
| 用裸 `setInterval` / `addEventListener` | 插件卸载后泄漏 | 一律 `ctx.effect(() => { ...; return dispose }, 'label')` |
| `ctx.xxx` 读可选服务 | fiber 卡 PENDING 永不激活 | 可选服务用 `ctx.get('xxx')` 或 `ctx.inject(['xxx'], cb)` |
| patch 里写 `config` 只写要改的字段 | **整行替换**，其余字段丢失 | 把该 entry 的完整 config 重述一遍 |
| 客户端注册进未声明的 slot | throw | 先确认目标 slot 有声明者；可叠加的用 list slot |
| 客户端 `dsh.client.inject` 当成 Cordis inject | 服务没注入 | 那个字段是**信息性的包名依赖**；Cordis 服务注入靠客户端 `export const inject` |
| 忘了 `exports["./client"]` | 浏览器半边不加载 | 与 `dsh.client.platform` 成对出现 |
| 用 `window.__ModuleLoader__` 之外的方式 import | 运行时拿不到平台模块 | 照 §1.9 的 esbuild 配置，平台模块保持 external |

---

## 7. 证据索引

| 证据文件 | 内容 |
|---|---|
| `research/_services-raw.txt` | 137 条 Context augmentation 的机械扫描原始结果（包名 \| 文件:行 \| 服务名 : 类型） |
| `research/_methods-raw.txt` | 各服务公开方法的扫描结果 |
| `research/.pkglist.txt` | `@deepseek-ai` 下全部包名与 description（38329 字节） |
| `research/notes-mechanisms.md` | 插件机制调研笔记（26282 字节） |
| `research/notes-client.md` | 客户端插件调研笔记（9386 字节） |
| `research/grok-bot-features.md` | Grok Bot 功能面（15 域 / 173 条，带官方 URL） |
| `research/ds-bot-architecture.md` | DS Bot 参考实现的模块级拆解 |
| `research/dsh-plugin-skeleton.md` | 从同构插件倒推的实操骨架 |
| `.refs/DeepSeek-Bot/ds-bot/` | DS Bot 完整源码（宿主 31 模块 + 客户端 55 模块） |
| `C:\Users\12896\.dsh\profiles\web\package.json` | 真实运行的 Web profile bundle 列表 |
| `C:\Users\12896\.dsh\profiles\web\cordis.patch.yml` | 真实运行的用户层 patch（163 行） |

**扫描命令复现**：

```powershell
$v = 'E:\data\my-work\dsh\DSH-X\data\versions\0.2.1-alpha.2\node_modules\@deepseek-ai'
# 包总数
(Get-ChildItem $v -Directory).Count                                    # → 299
# 服务名
Get-ChildItem $v -Directory | ForEach-Object {
  Get-ChildItem "$($_.FullName)\lib\types" -Recurse -Filter *.d.ts -EA SilentlyContinue | ForEach-Object {
    $lines = Get-Content $_.FullName
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match 'interface Context\s*\{') {
        $j = $i + 1
        while ($j -lt $lines.Count -and $lines[$j] -notmatch '^\s*\}') {
          if ($lines[$j] -match '^\s{4,8}([A-Za-z_$][\w$]*)\s*[?!]?\s*:') {
            "{0}`t{1}" -f $matches[1], $_.Name
          }
          $j++
        }
      }
    }
  }
} | Sort-Object -Unique
```
