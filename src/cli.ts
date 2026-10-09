#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { genImportPreset, NO_AUTO_IMPORT_TAG } from './generate.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

const HELP = `auto-import-preset v${version}

从 TypeScript 入口文件生成 unplugin-auto-import 的 preset 名单。
带 @${NO_AUTO_IMPORT_TAG} 标记的导出会被排除，不需要维护排除名单。

用法:
  auto-import-preset [选项]

选项:
  -e, --entry <path>          入口文件（相对 root），默认 src/index.ts
  -o, --output <path>         输出文件（相对 root），默认 public/importPreset.json
  -t, --tsconfig <path>       tsconfig（相对 root），默认 tsconfig.json
  -r, --root <path>           项目根目录，默认当前工作目录
  -c, --check                 只校验不写入，不一致时退出码为 1
      --indent <n>            输出缩进，默认沿用已有文件的缩进
      --ignore-tag <name...>  额外忽略的 JSDoc 标记（默认已忽略 ${NO_AUTO_IMPORT_TAG}）
      --exclude <name...>     额外排除的导出名
      --exclude-file <path>   从 JSON 文件（数组）读取要排除的导出名
  -q, --quiet                 只输出错误
  -h, --help                  显示帮助
  -v, --version               显示版本
`

interface ICliOption {
    entry?: string
    output?: string
    tsconfig?: string
    root?: string
    check?: boolean
    quiet?: boolean
    indent?: string
    ignoreTag?: string[]
    exclude?: string[]
    excludeFile?: string
    help?: boolean
    version?: boolean
}

const VALUE_OPTIONS: Record<string, keyof ICliOption> = {
    '-e': 'entry',
    '--entry': 'entry',
    '-o': 'output',
    '--output': 'output',
    '-t': 'tsconfig',
    '--tsconfig': 'tsconfig',
    '-r': 'root',
    '--root': 'root',
    '--indent': 'indent',
    '--exclude-file': 'excludeFile'
}

const ARRAY_OPTIONS: Record<string, 'ignoreTag' | 'exclude'> = {
    '--ignore-tag': 'ignoreTag',
    '--exclude': 'exclude'
}

const FLAG_OPTIONS: Record<string, keyof ICliOption> = {
    '-c': 'check',
    '--check': 'check',
    '-q': 'quiet',
    '--quiet': 'quiet',
    '-h': 'help',
    '--help': 'help',
    '-v': 'version',
    '--version': 'version'
}

/**
 * 解析命令行参数（零依赖手写，支持 --key=value 与 --key value）
 * @param argv 参数列表（不含 node 与脚本路径）
 * @returns 解析结果
 */
export function parseArgs(argv: string[]): ICliOption {
    const option: ICliOption = {}
    for(let i = 0; i < argv.length; i++) {
        const raw = argv[i]
        const eq = raw.indexOf('=')
        const key = eq > 0 ? raw.slice(0, eq) : raw
        const inlineValue = eq > 0 ? raw.slice(eq + 1) : undefined
        const flag = FLAG_OPTIONS[key]
        if(flag) {
            ;(option as Record<string, unknown>)[flag] = true
            continue
        }
        const arrayKey = ARRAY_OPTIONS[key]
        if(arrayKey) {
            const values: string[] = []
            if(inlineValue !== undefined) values.push(inlineValue)
            while(i + 1 < argv.length && !argv[i + 1].startsWith('-')) values.push(argv[++i])
            if(!values.length) throw new Error(`${key} 需要一个值`)
            option[arrayKey] = [...(option[arrayKey] ?? []), ...values]
            continue
        }
        const valueKey = VALUE_OPTIONS[key]
        if(valueKey) {
            const value = inlineValue ?? argv[++i]
            if(value === undefined || value.startsWith('-')) throw new Error(`${key} 需要一个值`)
            ;(option as Record<string, unknown>)[valueKey] = value
            continue
        }
        throw new Error(`未知参数: ${raw}`)
    }
    return option
}

function main() {
    const option = parseArgs(process.argv.slice(2))
    if(option.help) {
        process.stdout.write(HELP)
        return
    }
    if(option.version) {
        process.stdout.write(`${version}\n`)
        return
    }
    const log = (message: string) => { if(!option.quiet) console.log(message) }
    const fail = (message: string) => {
        console.error(`✖ ${message}`)
        process.exitCode = 1
    }
    const { check, entry, output, tsconfig, root, ignoreTag, exclude, excludeFile } = option
    const excludeNames = [...(exclude ?? [])]
    if(excludeFile) {
        const file = path.resolve(process.cwd(), excludeFile)
        if(!fs.existsSync(file)) return fail(`找不到排除名单文件: ${file}`)
        const list = JSON.parse(fs.readFileSync(file, 'utf-8'))
        if(Array.isArray(list)) excludeNames.push(...list.map(String))
    }
    const indent = option.indent === undefined ? undefined : Number(option.indent)
    if(indent !== undefined && (!Number.isInteger(indent) || indent < 0 || indent > 10)) {
        return fail(`--indent 需要 0-10 的整数，收到: ${option.indent}`)
    }
    const target = path.resolve(root ?? process.cwd(), output ?? 'public/importPreset.json')
    return genImportPreset({
        root,
        entry,
        output,
        tsconfig,
        check,
        indent,
        ignoreTags: [NO_AUTO_IMPORT_TAG, ...(ignoreTag ?? [])],
        exclude: excludeNames
    }).then(result => {
        const { names, added, removed, changed, ignored } = result
        if(ignored.length) {
            const detail = ignored.length > 10 ? `${ignored.slice(0, 10).join('、')} 等 ${ignored.length} 个` : ignored.join('、')
            log(`  已忽略: ${detail}`)
        }
        if(check) {
            if(changed) {
                console.error(`✖ ${target} 与入口文件的导出不一致，请重新生成`)
                if(added.length) console.error(`  缺少: ${added.join('、')}`)
                if(removed.length) console.error(`  多余: ${removed.join('、')}`)
                process.exitCode = 1
                return
            }
            log(`✔ ${target} 校验通过（${names.length} 个导出）`)
            return
        }
        const detail = `${added.length ? `，新增: ${added.join('、')}` : ''}${removed.length ? `，移除: ${removed.join('、')}` : ''}`
        log(`✔ 已生成 ${target}（${names.length} 个导出${detail}）`)
    }).catch((error: unknown) => {
        fail(`执行失败: ${error instanceof Error ? error.message : String(error)}`)
    })
}

main()
