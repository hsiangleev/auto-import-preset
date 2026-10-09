import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const PKG = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'))

const tempDirs = []
after(() => {
    for(const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

const FIXTURE = {
    'tsconfig.json': JSON.stringify({
        compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            skipLibCheck: true
        }
    }, null, 4),
    'src/mod.ts': [
        '/** @noAutoImport */',
        'export const hidden = 1',
        'export const shown = 2',
        '',
        '/** @internal */',
        'export const internalOnly = 3'
    ].join('\n'),
    'src/entry.ts': 'export * from \'./mod\'\n'
}

function createProject() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-import-preset-cli-'))
    tempDirs.push(root)
    for(const [name, content] of Object.entries(FIXTURE)) {
        const file = path.join(root, name)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, content)
    }
    return root
}

function run(args, cwd) {
    return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' })
}

const OUTPUT = 'public/importPreset.json'

test('--help / --version', () => {
    const root = createProject()
    const help = run(['--help'], root)
    assert.equal(help.status, 0)
    assert.match(help.stdout, /--check/)
    assert.match(help.stdout, /noAutoImport/)

    const version = run(['--version'], root)
    assert.equal(version.status, 0)
    assert.equal(version.stdout.trim(), PKG.version)
})

test('生成 + --check + 漂移检测', () => {
    const root = createProject()
    const output = path.join(root, OUTPUT)

    const gen = run(['-e', 'src/entry.ts'], root)
    assert.equal(gen.status, 0, gen.stderr)
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf-8')), ['internalOnly', 'shown'])

    const check = run(['-e', 'src/entry.ts', '--check'], root)
    assert.equal(check.status, 0, check.stderr)
    assert.match(check.stdout, /校验通过/)

    fs.writeFileSync(output, JSON.stringify(['shown', 'ghost'], null, 4))
    const drift = run(['-e', 'src/entry.ts', '-c'], root)
    assert.equal(drift.status, 1)
    assert.match(drift.stderr, /不一致/)
    assert.match(drift.stderr, /缺少: internalOnly/)
    assert.match(drift.stderr, /多余: ghost/)
})

test('--ignore-tag 追加标记，--exclude / --exclude-file 排除名字', () => {
    const root = createProject()
    const output = path.join(root, OUTPUT)

    const withInternal = run(['-e', 'src/entry.ts', '--ignore-tag', 'internal'], root)
    assert.equal(withInternal.status, 0, withInternal.stderr)
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf-8')), ['shown'])

    const excluded = run(['-e', 'src/entry.ts', '--exclude', 'shown', 'internalOnly'], root)
    assert.equal(excluded.status, 0, excluded.stderr)
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf-8')), [])

    fs.writeFileSync(path.join(root, 'exclude.json'), JSON.stringify(['shown']))
    const fromFile = run(['-e', 'src/entry.ts', '--exclude-file', 'exclude.json'], root)
    assert.equal(fromFile.status, 0, fromFile.stderr)
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf-8')), ['internalOnly'])
})

test('--quiet 成功时不输出，未知参数报错', () => {
    const root = createProject()
    const quiet = run(['-e', 'src/entry.ts', '--quiet'], root)
    assert.equal(quiet.status, 0, quiet.stderr)
    assert.equal(quiet.stdout.trim(), '')

    const unknown = run(['--nope'], root)
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /未知参数/)
})

test('缺少值的参数报错，--exclude-file 不存在报错', () => {
    const root = createProject()
    const missingValue = run(['-e'], root)
    assert.equal(missingValue.status, 1)
    assert.match(missingValue.stderr, /需要一个值/)

    const noFile = run(['--exclude-file', 'nope.json'], root)
    assert.equal(noFile.status, 1)
    assert.match(noFile.stderr, /找不到排除名单文件/)
})
