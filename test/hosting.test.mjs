import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isReleaseToken,
  isUnsuccessfulDeploymentStatus,
  ScaleMuleHostingClient,
  ScaleMuleHostingError,
} from '../dist/hosting.mjs'

test('release credentials and terminal failure states are fail closed', () => {
  assert.equal(isReleaseToken(`sm_rel_${'a'.repeat(32)}_${'b'.repeat(64)}`), true)
  assert.equal(isReleaseToken("sm_rel_bad'value"), false)
  assert.equal(isUnsuccessfulDeploymentStatus('failed'), true)
  assert.equal(isUnsuccessfulDeploymentStatus('cancelled'), true)
  assert.equal(isUnsuccessfulDeploymentStatus('rolled_back'), true)
  assert.equal(isUnsuccessfulDeploymentStatus('succeeded'), false)
})

test('release requests use only the scoped deploy credential and immutable source fields', async () => {
  const originalFetch = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url, init }
    return new Response(JSON.stringify({
      data: {
        id: '019471a0-0000-7000-8000-000000000101',
        project_id: '019471a0-0000-7000-8000-000000000102',
        environment_id: '019471a0-0000-7000-8000-000000000103',
        environment: 'prod',
        status: 'pending',
        triggered_by: 'manual',
        created_at: '2026-08-29T00:00:00Z',
      },
    }), { status: 202, headers: { 'content-type': 'application/json' } })
  }

  try {
    const client = new ScaleMuleHostingClient({
      apiUrl: 'https://api.example.test/',
      deployToken: 'sm_rel_test',
    })
    const result = await client.triggerRelease({
      environment: 'prod',
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      branch: 'main',
      idempotencyKey: 'release-test-1',
    })

    assert.equal(result.status, 'pending')
    assert.equal(captured.url, 'https://api.example.test/v1/hosting/releases')
    assert.equal(captured.init.headers['x-scalemule-deploy-token'], 'sm_rel_test')
    assert.equal(captured.init.headers['Idempotency-Key'], 'release-test-1')
    assert.equal(captured.init.headers.Authorization, undefined)
    assert.deepEqual(JSON.parse(captured.init.body), {
      environment: 'prod',
      commit_sha: '0123456789abcdef0123456789abcdef01234567',
      branch: 'main',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('API errors retain safe status and platform error code', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: 'DEPLOYMENT_IN_PROGRESS', message: 'Another deployment is already in progress' },
  }), { status: 409, headers: { 'content-type': 'application/json' } })

  try {
    const client = new ScaleMuleHostingClient({ deployToken: 'sm_rel_test' })
    await assert.rejects(
      client.getRelease('019471a0-0000-7000-8000-000000000101'),
      error => error instanceof ScaleMuleHostingError
        && error.status === 409
        && error.code === 'DEPLOYMENT_IN_PROGRESS',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('successful hosting responses must contain JSON unless they are 204', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('', { status: 200 })
    const client = new ScaleMuleHostingClient({ deployToken: 'sm_rel_test' })
    await assert.rejects(
      client.getReleaseProject(),
      error => error instanceof ScaleMuleHostingError
        && error.status === 200
        && error.code === 'INVALID_RESPONSE',
    )

    globalThis.fetch = async () => new Response(null, { status: 204 })
    const memberClient = new ScaleMuleHostingClient({ memberToken: 'member-test' })
    assert.equal(
      await memberClient.revokeReleaseToken('kaleflow', '019471a0-0000-7000-8000-000000000201'),
      undefined,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('release-token creation carries the allowed branch under member authentication', async () => {
  const originalFetch = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url, init }
    return new Response(JSON.stringify({
      data: {
        id: '019471a0-0000-7000-8000-000000000201',
        project_id: '019471a0-0000-7000-8000-000000000202',
        environment: 'prod',
        allowed_branch: 'main',
        name: 'contractor',
        token_prefix: 'sm_rel_019471a00000',
        created_by_member_id: '019471a0-0000-7000-8000-000000000203',
        created_at: '2026-08-29T00:00:00Z',
        token: 'sm_rel_test',
      },
    }), { status: 201, headers: { 'content-type': 'application/json' } })
  }

  try {
    const client = new ScaleMuleHostingClient({
      apiUrl: 'https://api.example.test/',
      memberToken: 'member-test',
    })
    const result = await client.createReleaseToken('kaleflow', {
      name: 'contractor',
      environment: 'prod',
      branch: 'main',
      expiresInDays: 30,
    })

    assert.equal(result.allowed_branch, 'main')
    assert.equal(captured.url, 'https://api.example.test/v1/hosting/projects/kaleflow/release-tokens')
    assert.equal(captured.init.headers.Authorization, 'Bearer member-test')
    assert.equal(captured.init.headers['x-scalemule-deploy-token'], undefined)
    assert.deepEqual(JSON.parse(captured.init.body), {
      name: 'contractor',
      environment: 'prod',
      branch: 'main',
      expires_in_days: 30,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})
