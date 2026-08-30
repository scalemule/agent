import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('CLI exposes the customer hosting flow', () => {
  const result = spawnSync(process.execPath, ['dist/cli.js', 'help'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /scalemule deploy --environment prod/)
  assert.match(result.stdout, /SCALEMULE_DEPLOY_TOKEN/)
})

test('CLI refuses a deployment credential passed as a process argument', () => {
  const result = spawnSync(
    process.execPath,
    ['dist/cli.js', 'deploy', '--environment', 'prod', '--deploy-token', 'sm_rel_should_not_be_read'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        SCALEMULE_DEPLOY_TOKEN: `sm_rel_${'a'.repeat(32)}_${'b'.repeat(64)}`,
      },
    },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--deploy-token is not accepted/)
})

test('CLI rejects malformed deployment credentials before any network request', () => {
  const result = spawnSync(
    process.execPath,
    ['dist/cli.js', 'whoami'],
    {
      encoding: 'utf8',
      env: { ...process.env, SCALEMULE_DEPLOY_TOKEN: 'member-or-unrelated-secret' },
    },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /SCALEMULE_DEPLOY_TOKEN is malformed/)
})

test('CLI rejects a Git remote that could be parsed as an option', () => {
  const repository = mkdtempSync(join(tmpdir(), 'scalemule-agent-cli-'))
  try {
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: repository, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'ScaleMule Test'], { cwd: repository })
    writeFileSync(join(repository, 'README.md'), 'test\n')
    execFileSync('git', ['add', 'README.md'], { cwd: repository })
    execFileSync('git', ['commit', '-m', 'test'], { cwd: repository, stdio: 'ignore' })

    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), 'dist/cli.js'), 'deploy', '--environment', 'prod', '--remote', '-c'],
      {
        cwd: repository,
        encoding: 'utf8',
        env: {
          ...process.env,
          SCALEMULE_DEPLOY_TOKEN: `sm_rel_${'a'.repeat(32)}_${'b'.repeat(64)}`,
        },
      },
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Git remote name is not safe for deployment/)
  } finally {
    rmSync(repository, { recursive: true, force: true })
  }
})

test('CLI rejects values assigned to the no-push safety flag', () => {
  const result = spawnSync(
    process.execPath,
    ['dist/cli.js', 'deploy', '--environment', 'prod', '--no-push=false'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        SCALEMULE_DEPLOY_TOKEN: `sm_rel_${'a'.repeat(32)}_${'b'.repeat(64)}`,
      },
    },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--no-push does not accept a value/)
})

test('CLI rejects values assigned to boolean flags', () => {
  for (const flag of ['--wait=false', '--help=false']) {
    const result = spawnSync(
      process.execPath,
      ['dist/cli.js', 'deploy', '--environment', 'prod', flag],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /does not accept a value/)
  }
})
