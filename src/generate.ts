import fs from 'node:fs'
import path from 'node:path'
import type * as TypeScript from 'typescript'

/**
 * 默认的忽略标记：写在导出的定义处（或 barrel 再导出处）的 JSDoc 里，
 * 带该标记的导出不会进入 preset。用法见 README。
 */
export const NO_AUTO_IMPORT_TAG = 'noAutoImport'

/** 过滤配置 */
export interface IFilterOption {
    /** 需要忽略的 JSDoc 标记名（不含 @） */
    ignoreTags?: string[]
    /** 额外排除的导出名 */
    exclude?: string[]
}

/** 生成配置 */
export interface IGenerateOption extends IFilterOption {
    /** 项目根目录，默认 process.cwd() */
    root?: string
    /** 入口文件（相对 root），默认 src/index.ts */
    entry?: string
    /** tsconfig（相对 root），默认 tsconfig.json */
    tsconfig?: string
    /** 输出文件（相对 root），默认 public/importPreset.json */
    output?: string
    /** 只校验不写入文件 */
    check?: boolean
    /** 输出缩进（数字或字符串），默认沿用已有文件的缩进，取不到时用 4 空格 */
    indent?: number | string
}

/** 生成结果 */
export interface IGenerateResult {
    /** 入口文件的运行时导出名（已按字典序排序） */
    names: string[]
    /** 相比原文件新增的导出名 */
    added: string[]
    /** 相比原文件移除的导出名 */
    removed: string[]
    /** 输出文件是否需要更新 */
    changed: boolean
    /** 被忽略（JSDoc 标记或 exclude 命中）的导出名 */
    ignored: string[]
}

/**
 * 动态引入 typescript，让包本身没有运行期依赖
 * @returns typescript 模块
 */
async function importTypeScript(): Promise<typeof TypeScript> {
    try {
        const module = await import('typescript')
        // CJS 互操作：Node 会同时给出具名导出和 default，优先用 default
        return (module as unknown as { default?: typeof TypeScript }).default ?? (module as unknown as typeof TypeScript)
    } catch {
        throw new Error('缺少 typescript 依赖，请先安装：npm i -D typescript')
    }
}

/** 读取已生成的名单，文件不存在或格式不对时返回空数组 */
function readNames(file: string): string[] {
    if(!fs.existsSync(file)) return []
    try {
        const list = JSON.parse(fs.readFileSync(file, 'utf-8'))
        return Array.isArray(list) ? list.map(String) : []
    } catch {
        return []
    }
}

/** 沿用已有文件的缩进，避免生成时整文件重排 */
function detectIndent(content: string, fallback: number | string = 4): number | string {
    const match = content.match(/\r?\n([ \t]+)"/)
    return match ? match[1] : fallback
}

/**
 * 取导出符号上的 JSDoc 标记名
 * 定义处（变量/函数/类/枚举）和 barrel 再导出语句（export { x } from './x'）上的标记都会读
 * @param ts typescript 模块
 * @param symbol 导出符号（可能是别名）
 * @param target 别名解析后的真实符号
 * @returns 标记名集合（不含 @）
 */
function getSymbolTags(ts: typeof TypeScript, symbol: TypeScript.Symbol, target: TypeScript.Symbol): Set<string> {
    const tags = new Set<string>()
    const read = (node?: TypeScript.Node) => {
        if(!node) return
        for(const tag of ts.getJSDocTags(node)) tags.add(tag.tagName.text.replace(/^@/, ''))
    }
    for(const declaration of [...(symbol.getDeclarations() ?? []), ...(target.getDeclarations() ?? [])]) {
        read(declaration)
        // JSDoc 也可能挂在 export 声明/语句上，往上取两层
        read(declaration.parent)
        read(declaration.parent?.parent)
    }
    return tags
}

/**
 * 收集入口文件的运行时导出名，并按 JSDoc 标记 / 排除名单过滤
 * @param entry 入口文件绝对路径
 * @param tsconfig tsconfig 绝对路径
 * @param root 项目根目录
 * @param option 过滤配置
 * @returns 保留的导出名与被忽略的导出名
 */
async function collectExportNames(entry: string, tsconfig: string, root: string, option: IFilterOption = {}): Promise<{ names: string[], ignored: string[] }> {
    const ts = await importTypeScript()
    const configFile = ts.readConfigFile(tsconfig, ts.sys.readFile)
    if(configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root, { noEmit: true }, tsconfig)
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
    const checker = program.getTypeChecker()
    const sourceFile = program.getSourceFile(entry)
    if(!sourceFile) throw new Error(`找不到入口文件: ${entry}`)
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
    if(!moduleSymbol) throw new Error(`无法解析入口文件的模块符号: ${entry}`)
    const ignoreTags = new Set((option.ignoreTags ?? []).map(tag => tag.replace(/^@/, '')))
    const exclude = new Set(option.exclude ?? [])
    const names = new Set<string>()
    const ignored = new Set<string>()
    for(const symbol of checker.getExportsOfModule(moduleSymbol)) {
        // export * / export {} from 拿到的是别名，先解析到真正的声明
        const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
        // interface / type 等纯类型导出在运行时不存在，和 Object.keys 的行为保持一致
        if(!(target.flags & ts.SymbolFlags.Value)) continue
        const name = symbol.getName()
        const tags = getSymbolTags(ts, symbol, target)
        if(exclude.has(name) || [...ignoreTags].some(tag => tags.has(tag))) {
            ignored.add(name)
            continue
        }
        names.add(name)
    }
    // 模块命名空间对象的 key 按字典序排列，与浏览器控制台里的输出一致
    return { names: [...names].sort(), ignored: [...ignored].sort() }
}

/**
 * 取入口文件的运行时导出名，等价于浏览器控制台执行：
 * console.log(JSON.stringify(Object.keys(import * as allModules from '@/index')))
 *
 * 用 TypeScript 编译器做静态解析（不执行代码），沿 export * / export {} from 解析到真实声明，
 * 只保留运行时存在的值导出（interface / type 会被编译擦除，不计入）。
 *
 * @param entry 入口文件绝对路径
 * @param tsconfig tsconfig 绝对路径
 * @param root 项目根目录
 * @param option 过滤配置（默认不过滤）
 * @returns 导出名（已按字典序排序）
 */
export async function getExportNames(entry: string, tsconfig: string, root: string, option: IFilterOption = {}): Promise<string[]> {
    return (await collectExportNames(entry, tsconfig, root, option)).names
}

/**
 * 生成入口文件对外导出的运行时名单（preset JSON），供 unplugin-auto-import 等使用
 * @param option 生成配置
 * @returns 生成结果
 */
export async function genImportPreset(option: IGenerateOption = {}): Promise<IGenerateResult> {
    const {
        root = process.cwd(),
        entry = 'src/index.ts',
        tsconfig = 'tsconfig.json',
        output = 'public/importPreset.json',
        check = false,
        ignoreTags = [NO_AUTO_IMPORT_TAG],
        exclude = [],
        indent
    } = option
    const outputPath = path.resolve(root, output)
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : ''
    const { names, ignored } = await collectExportNames(
        path.resolve(root, entry),
        path.resolve(root, tsconfig),
        root,
        { ignoreTags, exclude }
    )
    const old = readNames(outputPath)
    const content = JSON.stringify(names, null, indent ?? detectIndent(current))
    // 忽略换行符差异，比对结果作为是否需要更新的依据
    const changed = current.replace(/\r\n/g, '\n') !== content
    if(!check && changed) {
        const eol = current.includes('\r\n') ? '\r\n' : '\n'
        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })
        await fs.promises.writeFile(outputPath, content.replace(/\n/g, eol))
    }
    return {
        names,
        added: names.filter(name => !old.includes(name)),
        removed: old.filter(name => !names.includes(name)),
        changed,
        ignored
    }
}
