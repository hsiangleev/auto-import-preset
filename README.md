# auto-import-preset

从 TypeScript 入口文件生成 **unplugin-auto-import** 用的 preset 名单；在导出定义处写一行 JSDoc 标记就能把内部导出排除，不需要维护排除名单。

> Generate an `unplugin-auto-import` preset from a TypeScript entry file. Opt out per declaration with a JSDoc tag (default `@noAutoImport`).

- 零运行期依赖（`typescript` 是 peerDependency，用你项目里已有的那份）
- 纯静态解析：用 TypeScript 编译器读源码，**不会执行你的代码**
- 结果与 `Object.keys(import * as m from '入口')` 一致（同样的名字、同样的字典序）

## 安装

```bash
npm i -D auto-import-preset
```

## 用法一：CLI（推荐挂到构建前）

```bash
# 生成（默认入口 src/index.ts，输出 public/importPreset.json）
npx auto-import-preset

# 只校验，不一致时退出码 1（可用于 CI）
npx auto-import-preset --check

# 额外忽略 @internal，并排除两个名字
npx auto-import-preset --ignore-tag internal --exclude epsThrow epsWebSocket
```

| 选项 | 说明 |
| --- | --- |
| `-e, --entry <path>` | 入口文件（相对 root），默认 `src/index.ts` |
| `-o, --output <path>` | 输出文件（相对 root），默认 `public/importPreset.json` |
| `-t, --tsconfig <path>` | tsconfig（相对 root），默认 `tsconfig.json` |
| `-r, --root <path>` | 项目根目录，默认当前工作目录 |
| `-c, --check` | 只校验不写入，不一致时退出码 1 |
| `--indent <n>` | 输出缩进，默认沿用已有文件的缩进 |
| `--ignore-tag <name...>` | 追加要忽略的 JSDoc 标记（默认已忽略 `noAutoImport`） |
| `--exclude <name...>` | 追加要排除的导出名 |
| `--exclude-file <path>` | 从 JSON 文件（数组）读取要排除的导出名 |
| `-q, --quiet` | 只输出错误 |
| `-h, --help` / `-v, --version` | 帮助 / 版本 |

挂到构建里：

```json
{
  "scripts": {
    "build": "auto-import-preset && vite build",
    "check:importPreset": "auto-import-preset --check"
  }
}
```

## 用法二：Node API

```ts
import { genImportPreset, getExportNames, NO_AUTO_IMPORT_TAG } from 'auto-import-preset'

const result = await genImportPreset({
    root: process.cwd(),          // 默认 process.cwd()
    entry: 'src/index.ts',        // 默认 src/index.ts
    output: 'public/importPreset.json',
    check: false,                 // true 时只校验
    ignoreTags: [NO_AUTO_IMPORT_TAG, 'internal'],  // 默认 [NO_AUTO_IMPORT_TAG]
    exclude: ['epsThrow'],        // 兜底手段
    indent: 4                     // 默认沿用已有文件缩进
})
// result = { names, added, removed, changed, ignored }

// 只要名字
const names = await getExportNames('/abs/src/index.ts', '/abs/tsconfig.json', '/abs', { ignoreTags: [] })
```

## 怎么标 `@noAutoImport`

写在导出的**定义处**（记法：整条声明语句的上方），函数、类、枚举、常量都支持：

```ts
/** @noAutoImport */
export const epsPageStaticList = ['view', 'dialog']

/** 分页布局 @noAutoImport */          // 合并进已有注释也行
export const epsPaginationLayout = 'total, sizes, prev, pager, next, jumper'

/**
 * 获取用户货币符号
 * @noAutoImport
 */
export function epsUserCurrencySymbol() {}
```

组件/第三方再导出的（编译器看不到 `.vue` 内部），标在 barrel 那一行：

```ts
/** @noAutoImport */
export { default as EpsNumber } from './EpsNumber.vue'
```

同一条 `export {}` 里只想排除其中一个，用内联标记：

```ts
export { /** @noAutoImport */ gamma, delta } from './more'
```

⚠️ 注意：注释必须写在**整条声明语句的上方**，下面这种写读不到：

```ts
export /** @noAutoImport */ function foo() {}   // ✗ 不生效
```

## 结果怎么用

生成出来的 JSON 直接喂给 `unplugin-auto-import`：

```ts
import AutoImport from 'unplugin-auto-import/vite'
import importPreset from './public/importPreset.json'

export default {
    plugins: [
        AutoImport({
            imports: [{ 'my-lib': importPreset }],
            dirs: ['src/hooks/**', 'src/utils/**'],
            dts: 'types/auto-import.d.ts'
        })
    ]
}
```

## 实现说明

- 用 `ts.createProgram()` 解析源码并沿 `export * from` / `export { x } from` 解析到真实声明，只保留**运行时存在**的值导出（`interface` / `type` 会被编译擦除，不计入）。
- 标记读取同时看“真实声明”和“别名声明（barrel 那行）”，所以定义处和再导出处的标记都生效。
- 输出按字典序排序，与 ESM 模块命名空间对象的 key 顺序一致。
- 写入时沿用已有文件的换行符与缩进，不会因为格式化产生无意义的 diff；输出目录不存在时自动创建。

## 发布

推 `v*` tag 即自动发布到 npm（[.github/workflows/publish.yml](.github/workflows/publish.yml)）：

```bash
npm version patch        # 或 minor / major，先改 package.json 版本号
git push && git push --tags
```

认证走 npm **Trusted Publishing（OIDC）**，不需要任何 secret：首次发布前在 npmjs 上配置 Trusted Publisher（Owner = GitHub 账号，Repository = `auto-import-preset`，Workflow = `publish.yml`）。工作流会校验 tag 与 `package.json` 版本一致，`prepublishOnly` 会先跑一遍测试；也可以在 Actions 里手动触发（默认只预演：测试 + `npm pack --dry-run`）。

## License

MIT
