import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { genImportPreset, getExportNames, NO_AUTO_IMPORT_TAG } from '../dist/index.js'

/** 每个用例建一个临时项目 */
const tempDirs = []
after(() => {
    for(const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function createProject(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-import-preset-'))
    tempDirs.push(root)
    for(const [name, content] of Object.entries(files)) {
        const file = path.join(root, name)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, content)
    }
    return root
}

const TSCONFIG = JSON.stringify({
    compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        skipLibCheck: true
    }
}, null, 4)

const FIXTURE = {
    'tsconfig.json': TSCONFIG,
    'src/other.ts': [
        'export const alpha = 1',
        'export const beta = 2'
    ].join('\n'),
    'src/more.ts': [
        'export const gamma = 1',
        'export const delta = 2'
    ].join('\n'),
    'src/comp.ts': 'export default { name: \'comp\' }\n',
    'src/comp2.ts': 'export default { name: \'comp2\' }\n',
    'src/mod.ts': [
        '/** 保留 */',
        'export const keepOne = 1',
        '',
        '/** 说明 @noAutoImport */',
        'export const dropMerged = 2',
        '',
        '/** @noAutoImport */',
        'export const dropOwnLine = 3',
        '',
        '/**',
        ' * 多行说明',
        ' * @noAutoImport',
        ' */',
        'export const dropMultiline = 4',
        '',
        '/** @noAutoImport */',
        'export function dropFn() { return 1 }',
        '',
        '/** @noAutoImport */',
        'export class DropClass {}',
        '',
        '/** @noAutoImport */',
        'export enum DropEnum { A }',
        '',
        'export interface OnlyType { a: string }',
        'export type OnlyAlias = number',
        '',
        '/** @internal */',
        'export const dropInternal = 5'
    ].join('\n'),
    'src/barrel.ts': [
        'export * from \'./mod\'',
        '',
        '/** @noAutoImport */',
        'export { alpha } from \'./other\'',
        '',
        'export { beta } from \'./other\'',
        '',
        'export { /** @noAutoImport */ gamma, delta } from \'./more\'',
        '',
        '/** @noAutoImport */',
        'export { default as DropComp } from \'./comp\'',
        '',
        'export { default as KeepComp } from \'./comp2\''
    ].join('\n'),
    'src/entry.ts': 'export * from \'./barrel\'\n'
}

const ALL_EXPORTS = [
    'DropClass', 'DropComp', 'DropEnum', 'KeepComp',
    'alpha', 'beta', 'delta', 'dropFn', 'dropInternal',
    'dropMerged', 'dropMultiline', 'dropOwnLine', 'gamma', 'keepOne'
]

const KEPT_BY_DEFAULT = ['KeepComp', 'beta', 'delta', 'dropInternal', 'keepOne']
const IGNORED_BY_DEFAULT = ['DropClass', 'DropComp', 'DropEnum', 'alpha', 'dropFn', 'dropMerged', 'dropMultiline', 'dropOwnLine', 'gamma']

test('getExportNames: 枚举运行时导出，排除 interface / type', async () => {
    const root = createProject(FIXTURE)
    const names = await getExportNames(path.join(root, 'src/entry.ts'), path.join(root, 'tsconfig.json'), root)
    assert.deepEqual(names, ALL_EXPORTS)
})

test('默认忽略 @noAutoImport（合并注释/独立注释/多行注释/函数/类/枚举/barrel/内联 specifier 都能识别）', async () => {
    const root = createProject(FIXTURE)
    const result = await genImportPreset({ root, entry: 'src/entry.ts' })
    assert.deepEqual(result.names, KEPT_BY_DEFAULT)
    assert.deepEqual(result.ignored, IGNORED_BY_DEFAULT)
    assert.equal(result.changed, true)
    const written = JSON.parse(fs.readFileSync(path.join(root, 'public/importPreset.json'), 'utf-8'))
    assert.deepEqual(written, KEPT_BY_DEFAULT)
})

test('可追加忽略 @internal，也可用 exclude 名单排除', async () => {
    const root = createProject(FIXTURE)
    const withInternal = await genImportPreset({ root, entry: 'src/entry.ts', ignoreTags: [NO_AUTO_IMPORT_TAG, 'internal'] })
    assert.deepEqual(withInternal.names, ['KeepComp', 'beta', 'delta', 'keepOne'])
    assert.ok(withInternal.ignored.includes('dropInternal'))

    const withExclude = await genImportPreset({ root, entry: 'src/entry.ts', exclude: ['keepOne', 'beta'] })
    assert.deepEqual(withExclude.names, ['KeepComp', 'delta', 'dropInternal'])
    assert.ok(withExclude.ignored.includes('keepOne'))
})

test('幂等：第二次生成 changed 为 false', async () => {
    const root = createProject(FIXTURE)
    await genImportPreset({ root, entry: 'src/entry.ts' })
    const again = await genImportPreset({ root, entry: 'src/entry.ts' })
    assert.equal(again.changed, false)
    assert.deepEqual(again.added, [])
    assert.deepEqual(again.removed, [])
})

test('check 模式不写文件，且能报出缺少/多余', async () => {
    const root = createProject(FIXTURE)
    const output = path.join(root, 'public/importPreset.json')
    const first = await genImportPreset({ root, entry: 'src/entry.ts', check: true })
    assert.equal(first.changed, true)
    assert.equal(fs.existsSync(output), false, 'check 模式不应写文件')

    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, JSON.stringify(['keepOne', 'ghostName'], null, 4))
    const drift = await genImportPreset({ root, entry: 'src/entry.ts', check: true })
    assert.deepEqual(drift.added, ['KeepComp', 'beta', 'delta', 'dropInternal'])
    assert.deepEqual(drift.removed, ['ghostName'])
})

test('沿用已有文件的缩进与换行符', async () => {
    const root = createProject(FIXTURE)
    const output = path.join(root, 'public/importPreset.json')
    fs.mkdirSync(path.dirname(output), { recursive: true })
    // 预先写成 2 空格 + CRLF，且内容一致：应当认为无需更新
    fs.writeFileSync(output, JSON.stringify(KEPT_BY_DEFAULT, null, 2).replace(/\n/g, '\r\n'))
    const same = await genImportPreset({ root, entry: 'src/entry.ts' })
    assert.equal(same.changed, false)

    // 内容变化后按 2 空格 + CRLF 重写
    fs.writeFileSync(output, JSON.stringify(['keepOne'], null, 2).replace(/\n/g, '\r\n'))
    const changed = await genImportPreset({ root, entry: 'src/entry.ts' })
    assert.equal(changed.changed, true)
    const content = fs.readFileSync(output, 'utf-8')
    assert.ok(content.includes('\r\n'), '应保留 CRLF')
    assert.ok(content.includes('\n  "KeepComp"'), '应保留 2 空格缩进')
    assert.deepEqual(JSON.parse(content), KEPT_BY_DEFAULT)
})

test('indent 选项可强制缩进，输出目录不存在时自动创建', async () => {
    const root = createProject(FIXTURE)
    const result = await genImportPreset({ root, entry: 'src/entry.ts', output: 'deep/nested/preset.json', indent: 4 })
    assert.equal(result.changed, true)
    const content = fs.readFileSync(path.join(root, 'deep/nested/preset.json'), 'utf-8')
    assert.ok(content.includes('\n    "KeepComp"'))
})

test('入口文件不存在时报错', async () => {
    const root = createProject(FIXTURE)
    await assert.rejects(() => genImportPreset({ root, entry: 'src/nope.ts' }), /找不到入口文件/)
})
