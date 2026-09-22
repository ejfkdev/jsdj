# jsdj - 动态加载 JS 文件提取工具

[English](./README.md) | 中文

[![npm](https://img.shields.io/npm/v/@ejfkdev%2Fjsdj?style=flat-square)](https://www.npmjs.com/package/@ejfkdev/jsdj)
[![License](https://img.shields.io/badge/License-MPL%202.0-blue.svg?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/ejfkdev/jsdj/ci.yml?style=flat-square)](https://github.com/ejfkdev/jsdj/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-20.11+-339933.svg?style=flat-square)](https://nodejs.org/)
[![Stars](https://img.shields.io/github/stars/ejfkdev/jsdj?style=flat-square)](https://github.com/ejfkdev/jsdj/stargazers)
[![Issues](https://img.shields.io/github/issues/ejfkdev/jsdj?style=flat-square)](https://github.com/ejfkdev/jsdj/issues)

`jsdj` 通过静态分析网站的 HTML 与 JS，提取其中动态加载的 JavaScript —— webpack
chunk、`import()` 懒加载、各类框架清单等等，然后找出 source map 并还原出打包前的
原始源码。

它是 Go 工具 [`dj`](https://github.com/ejfkdev/dj) 的 TypeScript 移植版：保留 dj 的
全部命令行用法，同时补上库使用场景需要的能力 —— 可注入的 HTTP 请求层、可插拔的缓存、
以及**返回还原出的源码内容**（而不是只给路径）。

## 特性

- **静态分析动态加载** —— `import()`、`require()`、webpack chunk 映射、Vite
  preload、微前端入口等，共 **26 个插件**
- **还原 source map** —— 在每个 bundle 旁探测 `.map` 并还原原始源码，优先用
  `sourcesContent`，缺失时回退到 `mappings` 重组
- **同一个包既是库也是命令行** —— `import { scan } from '@ejfkdev/jsdj'`，或
  `npx @ejfkdev/jsdj <url>`
- **Node 与浏览器都可用** —— 浏览器入口不依赖文件系统；想要缓存复用就自己传一个
  `Storage` 实现
- **可注入 HTTP 请求层** —— 换成你自己的 TLS 指纹栈、代理或录制回放
- **TLS 指纹** —— 通过可选的原生侧车支持，用于直接拒绝握手的站点
- **结果确定** —— 同一站点每次扫描得到完全相同的 URL 集合
- **缓存复用** —— 第二次扫描同一站点直接回放 `meta.json`，跳过全部网络请求

## 安装

```bash
npm install @ejfkdev/jsdj   # 或：pnpm add / bun add / yarn add @ejfkdev/jsdj
```

运行时零依赖。TLS 指纹由单独的包提供，默认不安装；没装也不影响其它功能。

## 命令行

```bash
npx @ejfkdev/jsdj https://example.com     # 或：bunx @ejfkdev/jsdj https://example.com
```

```bash
jsdj <url> [options]              扫描一个网站
jsdj scan <url> [options]         同上，规范形式
jsdj version                      打印版本
jsdj --list-plugins               列出内置插件
```

| 选项 | 说明 |
|------|------|
| `-f, --format <fmt>` | 输出格式：`md`（默认）、`json`、`text`（纯 URL 列表） |
| `--json` | 输出原始 JSON，覆盖 `-f` 指定的格式 |
| `-d, --debug` | 调试信息输出到 stderr |
| `--useragent <UA>`、`--ua <UA>` | 自定义 User-Agent（支持非 ASCII） |
| `-x, --proxy <URL>` | 代理：`http://`、`https://`、`socks5://` |
| `--cookie <cookies>` | Cookie，例如用 `cf_clearance=...` 绕过人机校验 |
| `-H, --header <K: V>` | 追加请求头，可重复；同名后者覆盖前者 |
| `--no-random-tls` | 固定使用 Chrome TLS 指纹（默认为随机） |
| `--no-tls` | 完全关闭 TLS 指纹 |
| `-o, --output <dir>` | 额外把产物写到此目录（不带站点子目录层级） |
| `-t, --timeout <secs>` | 单请求超时秒数（默认 30） |
| `-c, --concurrency <N>` | 最大并发请求数（默认 8） |
| `--no-cache` | 不读缓存；产物仍会写入磁盘 |
| `--cache[=bool]` | 旧版兼容写法：`--cache=yes`、`--cache=false` |
| `--cache-dir <dir>` | 缓存根目录（默认 `<临时目录>/ejfkdev/dj`） |
| `--only-plugins <names>` | 只运行这些插件（逗号分隔） |
| `--exclude-plugins <names>` | 运行除这些之外的全部插件 |

退出码：成功 `0`，用法或运行错误 `1`。

```bash
jsdj -f json --cookie 'cf_clearance=xxx' https://example.com
jsdj -H 'Referer: https://google.com' -x socks5://127.0.0.1:7890 https://example.com
jsdj --only-plugins WebpackPlugin,NextJSPlugin https://example.com
```

## 作为库使用

```ts
import { scan } from '@ejfkdev/jsdj';

const result = await scan({
  url: 'https://example.com',
  headers: { Referer: 'https://example.com' },
  cookie: 'cf_clearance=xxx',
  tlsFingerprint: 'chrome',
  concurrency: 8,
});

result.jsUrls;    // string[] —— 发现的 JS URL
result.jsDetails; // 每个 URL 的来源：哪个插件发现、来自哪个文档
result.sources;   // 还原出的源码文件，含内容
result.summary;   // { jsCount, sourceMapCount, sourceCount }
```

还原出的源码是**带内容的**，不只是路径：

```ts
for (const file of result.sources) {
  console.log(file.path);    // 'src/App.tsx'
  console.log(file.content); // 原始源码
  console.log(file.mode);    // 'sourcesContent' | 'mappings'
  console.log(file.fromJs);  // 从哪个 bundle 还原而来
}
```

### 注入自己的 HTTP 请求层

`scan` 接受一个 transport，于是你可以自己做 TLS 处理、走自建代理，或者在测试里录制
回放请求。

```ts
const result = await scan({
  url: 'https://example.com',
  transport: {
    async fetch(req) {
      // req: { url, method, headers }
      // headers 传进来时已经组装好了：先是浏览器默认头，再是你的 headers 选项，
      // 最后是你的 cookie。
      const res = await myTlsStack(req.url, {
        method: req.method,
        headers: req.headers,
      });
      return {
        status: res.status,
        headers: res.headers,
        body: res.body,          // Uint8Array 或字符串
        finalUrl: res.finalUrl,  // 可选
      };
    },
  },
});
```

传入的既有 `GET` 也有 `HEAD` 请求，所以必须遵守 `method` —— jsdj 用 `HEAD` 探测
source map。若要整体替换客户端，传 `transport: { client }` 给一个完整的
`HttpClient`。

有两条语义值得留意：

- **传输层失败必须 reject，而不是 resolve。** jsdj 对 reject 会带退避重试，但把
  resolve 的响应当作最终结果 —— 所以吞掉错误会把一次瞬时失败变成永久的「找不到」。
- **非 2xx 状态是正常返回的。** `{ status: 404 }` 是一个结果，不是错误。

### 细粒度 API

`scan` 只是一个便利封装。它下面每一层都导出了，可以只用其中一块：

```ts
import {
  // 发现流程
  Pipeline, PluginRegistry, createDefaultRegistry, WebpackPlugin,
  // 单个 URL、单次请求
  Fetcher,
  // source map
  parseSourceMap, restoreFiles, parseMappings, normalizeSourcePath,
  // URL 与内容处理
  normalizeUrl, resolveRelativePath, expandComboLoader,
  decodeContent, detectContentKind, unwrapJsonp,
  // 请求层与存储
  NodeHttpClient, BrowserHttpClient, MemoryStorage, NullStorage, FsStorage,
  // 输出渲染
  formatMarkdown, formatJson, formatText,
} from '@ejfkdev/jsdj';
```

对你手上已有的内容单独跑一个插件：

```ts
import { WebpackPlugin } from '@ejfkdev/jsdj';

const plugin = new WebpackPlugin();
const input = {
  sourceUrl: 'https://example.com/runtime.js',
  contentType: 'js',
  content: new TextEncoder().encode(runtimeSource),
  text: runtimeSource,
};
const context = { publicPaths: [], prependUrls: [], knownPaths: [] };

if (plugin.precheck(input, context)) {
  const found = plugin.analyze(input, context);
  console.log(found.urls, found.probeTargets);
}
```

解析你自己抓到的 source map：

```ts
import { parseSourceMap, restoreFiles } from '@ejfkdev/jsdj';

const map = parseSourceMap(mapJson);
const files = restoreFiles(map, minifiedJs); // minifiedJs 可选
for (const f of files) {
  console.log(f.path, f.mode, f.content);
}
```

## 平台差异

| | Node | 浏览器 |
|---|---|---|
| 文件缓存 | 默认开启，可配置 | 无 —— 需自己注入 `Storage` |
| TLS 指纹 | 依赖可选侧车，缺失则忽略 | 永远不可用 |
| 请求范围 | 任意主机 | 受 CORS 限制 |

平台不具备某项能力时不会报错。`tlsFingerprint` 在无法生效的环境下被接受并忽略；缓存
则退化为直通。

### TLS 指纹

伪造 TLS ClientHello 无法在 JavaScript 里完成 —— 握手发生在运行时内部。这需要原生
请求层，由单独的包 **`@jsdj/tls-sidecar`** 提供，默认不安装。

没装这个包时命令和库照常工作，TLS 相关选项被接受但静默无效，因此同一份参数配置在任何
环境都能跑。这是有意为之：缺失的可选能力不该是错误，而浏览器本来就永远不具备它。

### 浏览器端

```ts
import { scan, MemoryStorage } from '@ejfkdev/jsdj/browser';

const result = await scan({
  url: 'https://example.com',
  storage: new MemoryStorage(), // 或你自己的 OPFS / IndexedDB 实现
});
```

浏览器无法扫描任意的跨域站点：请求会被 CORS 拦下。需要一个把请求绕经你自己域名的
`transport`，这正是可注入请求层的用途。浏览器入口导出了除文件系统相关部分之外的整个
流水线，并且引入它不会带上任何 Node 内置模块。

## 缓存

Node 下缓存位于系统临时目录：

```
<临时目录>/ejfkdev/dj/<origin>/
├── js/            下载的 JS
├── source_map/    source map 文件
├── sources/       还原出的源码，保留原始目录结构
├── html/          起始页
└── meta.json      站点元数据
```

第二次扫描同一站点会回放 `meta.json`，完全跳过发现流程，连还原出的源码都从磁盘读回，
所以返回内容和冷扫描完全一致。在大型站点上，这把一分钟的扫描变成毫秒级。

用 `--no-cache` 强制完整重扫（产物仍会写入），或用 `--cache-dir` 换缓存位置。

## 工作原理

1. 抓取目标页面。
2. 对页面并行运行所有适用的插件。每个插件针对一种加载方式做模式匹配。
3. 插件产出两类结果：可直接抓取的绝对 URL，或需要与已知 URL 比对的路径片段 ——
   webpack runtime 只写 chunk 名不带主机，所以片段要拿去和已知存在的目录匹配。
4. 在每个 bundle 旁探测 source map（先发 `HEAD`，因为大多数情况下并不存在）。
5. 从 map 还原源码：有 `sourcesContent` 就直接用，否则从 `mappings` 重组并标注为不完整。
6. 输出 JS URL，附带完整来源信息。

并发由单一信号量统一约束，下载、探测与 `HEAD` 请求共享同一个额度，所以
`--concurrency` 是真实上限，而不是每个阶段各算一份。

### 确定性

同一站点每次扫描得到完全相同的 URL 集合。爬取使用可等待的工作队列，并按输入推导出的
顺序而非完成顺序接纳任务。由 `test/determinism.test.ts` 验证。

### 用它验证

下列站点适合做冒烟测试，各自覆盖不同的加载方式。

| 站点 | 加载方式 | URL 数 |
|---|---|---|
| `react.dev` | Vite + SPA 路由 | 约 38 |
| `www.tsinghua.edu.cn` | 大型多页站点，爬取预算成为瓶颈 | 约 36 |
| `developer.mozilla.org` | 以服务端渲染为主，bundle 很少 | 约 5 |
| `vuejs.org` | VitePress，chunk 数量多 | 约 56 |

数量是默认配置下撰写时的结果，站点改版后会变。上报的每个 URL 都验证过可访问，上述站点
均未发现误报。

## 插件

共 26 个插件，覆盖下列加载方式。`jsdj --list-plugins` 可打印名称；
`--only-plugins` / `--exclude-plugins` 用来选取子集。

| 插件 | 处理对象 |
|------|------|
| `HTMLScriptPlugin` | `<script src>`、`modulepreload`、`prefetch`、内联脚本 |
| `DynamicImportPlugin` | `import()` |
| `ESMImportPlugin` | 静态 `import` / `from` |
| `ScriptCreatePlugin` | `createElement('script')`、`src =`、`new URL()` |
| `WebpackPlugin` | chunk 映射、`publicPath`、`webpackChunk`、rspack、runtime 指纹 |
| `NextJSPlugin` | App/Pages Router chunk、`_buildManifest`、Turbopack、RSC flight 数据 |
| `VitePlugin` | `__vitePreload`、`__vite__mapDeps`、构建清单 |
| `NuxtJSPlugin` | `/_nuxt/` 资源 |
| `SvelteKitPlugin` | `/_app/immutable/` 的 nodes 与 chunks |
| `RequireJSPlugin` | `data-main`、`require([...])`、`define([...])` |
| `ModuleFederationPlugin` | `remoteEntry.js`、同目录清单 |
| `ModuleFederationManifestPlugin` | 标准与 Vmok 两种清单格式 |
| `HelMicroPlugin` | 组件 metadata 文档 |
| `EmpPlugin` | `emp.json` 联邦清单 |
| `ModernJSPlugin` | `_MODERNJS_ROUTE_MANIFEST` |
| `URLPatternPlugin` | 协议相对 CDN 域名、引号包裹的 `.js` 字符串 |
| `SourceMapPlugin` | `sourceMappingURL`、`X-SourceMap`、内联 data URI |
| `UmiJSPlugin` | Umi 路由清单 |
| `TrunkPlugin` | Rust/wasm-bindgen 的 `sitemap.json` |
| `QiankunPlugin` | `entry` / `proEntry` 子应用 HTML |
| `GarfishPlugin` | `apps[].entry` |
| `MicroAppPlugin` | `microApp.start` 配置 |
| `WujiePlugin` | `startApp` 配置 |
| `IcestarkPlugin` | `url` 单值或数组形式 |
| `HTMLPivotPlugin` | 同源链接、iframe、引号包裹的 `.html` 字面量 |
| `UniversalURLPlugin` | 兜底：编码还原后的宽匹配 |

插件之间**有意重叠** —— 通用兜底插件与专用插件并行运行 —— 所以排除某个插件并不总能
去掉它的发现结果。

单个插件的产出上限为 50 条，因此某个链接特别多的页面不会在它链接的页面被抓取之前耗尽
全部爬取预算。

自己写插件：实现 `name`、`precheck(input, context)` 和 `analyze(input, context)`，再用
`PluginRegistry` 注册即可。完整示例见
[`examples/04-fine-grained`](./examples/04-fine-grained)。

## 示例

[`examples/`](./examples) 下有 6 个可运行的示例，每个都从父目录安装本包，是真实的安装
而非路径别名：

| 目录 | 内容 |
|---|---|
| [`01-npx-cli`](./examples/01-npx-cli) | 命令行用法：`npx` / `bunx`、全部选项、格式与退出码 |
| [`02-library-basics`](./examples/02-library-basics) | `scan()`、结果结构、还原源码、自行渲染 |
| [`03-custom-transport`](./examples/03-custom-transport) | 注入请求层、cookie、TLS 指纹 |
| [`04-fine-grained`](./examples/04-fine-grained) | 单个插件、单个 source map、URL 工具、自定义插件 |
| [`05-http-service`](./examples/05-http-service) | 扫描服务：任务队列、并发上限、取消、缓存 |
| [`06-browser`](./examples/06-browser) | 真实页面：OPFS 存储、注入请求层、CORS 现实 |

它们共用一个零依赖的 fixture 站点，可以离线运行：

```bash
node examples/fixture-site/serve.mjs     # 扫描目标
cd examples/02-library-basics && npm install && node index.mjs
```

## 不含的部分

- **不含 HTTP 与 MCP 服务端。** 那部分来自 dj 依赖的 `xyz-go` 框架，不在移植范围内；
  `serve` / `mcp` 会明确提示不支持，而不是抛出难以理解的错误。
- **默认不含原生 TLS 指纹。** 它由单独的包 `@jsdj/tls-sidecar` 提供，默认未安装；
  此时 TLS 相关选项被接受并忽略。

命令行选项、别名、输出排版、缓存路径、退出码、插件名称都沿用 dj，因此已有的 dj 使用方式
可以直接迁移。在此基础上另有几点：

- **返回还原出的源码内容**，而不只是写到磁盘。
- **JSONP 被显式分类** —— 正文是 JSONP 回调包装的 `.js` URL 会被标记为 `jsonp`，而不是
  当作 JavaScript 处理。
- **调试输出走可注入的 logger。** 库默认静默，命令行输出到 stderr。

## 开发

```bash
git clone https://github.com/ejfkdev/jsdj.git
cd jsdj

bun install         # 或 npm install
bun test            # 252 个测试
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
```

需要 Node 20.11+ 与 TypeScript 5.7+。测试用
[`bun test`](https://bun.sh/docs/cli/test) 是为了速度，但库和命令行本身是纯 Node ESM，
不依赖 Bun。

开发流程见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 许可证

[MPL-2.0](./LICENSE)。
