import { cp, mkdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspaceDir = path.join(repoRoot, 'apps', 'web', 'source')
const sourceDir = path.join(workspaceDir, 'default')
const sourceDist = path.join(sourceDir, 'dist')
const targetDist = path.join(repoRoot, 'apps', 'web', 'dist')

function runBun(args, cwd = sourceDir) {
  const result = spawnSync('bun', args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

runBun(['install', '--frozen-lockfile'], workspaceDir)
runBun(['run', 'typecheck'])
runBun(['run', 'build'])

await rm(targetDist, { recursive: true, force: true })
await mkdir(targetDist, { recursive: true })
await cp(sourceDist, targetDist, { recursive: true })

console.log(`Frontend bundle copied to ${path.relative(repoRoot, targetDist)}`)
