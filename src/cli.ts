#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import {
  isReleaseToken,
  isUnsuccessfulDeploymentStatus,
  ScaleMuleHostingClient,
  ScaleMuleHostingError,
  type Deployment,
} from './hosting'

interface Profile {
  apiUrl: string
  applicationId: string
  applicationName: string
  email: string
}

interface DiscoveredApplication {
  id: string
  name: string
  environment: string
  scope: string
}

type Options = Record<string, string | boolean>

const TERMINAL_RELEASE_STATES = new Set(['succeeded', 'failed', 'cancelled', 'rolled_back'])

function help(): string {
  return `ScaleMule customer hosting CLI

Usage:
  scalemule login --email EMAIL [--application APP_ID_OR_NAME]
  scalemule logout
  scalemule projects
  scalemule release-token create --project PROJECT --name NAME [--environment prod] [--branch main] [--expires-days 30]
  scalemule release-token list --project PROJECT
  scalemule release-token revoke --project PROJECT --token-id TOKEN_ID
  scalemule whoami
  scalemule deploy --environment prod [--branch main] [--wait] [--remote origin] [--no-push]
  scalemule status --deployment DEPLOYMENT_ID

Authentication:
  Owners/admins use "login" to manage project-scoped release tokens.
  Customer developers and AI agents set SCALEMULE_DEPLOY_TOKEN in their environment.
  The deploy token is never accepted as a command-line flag.

Configuration:
  SCALEMULE_API_URL defaults to https://api.scalemule.com.
  SCALEMULE_MEMBER_TOKEN can replace the saved member login for automation.`
}

export function parseArguments(args: string[]): { positionals: string[]; options: Options } {
  const positionals: string[] = []
  const options: Options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument.startsWith('--')) {
      positionals.push(argument)
      continue
    }
    const rawName = argument.slice(2)
    if (rawName.startsWith('no-')) {
      if (rawName.includes('=')) {
        throw new Error(`--${rawName.slice(0, rawName.indexOf('='))} does not accept a value`)
      }
      options[rawName] = true
      continue
    }
    const separator = rawName.indexOf('=')
    if (separator !== -1) {
      options[rawName.slice(0, separator)] = rawName.slice(separator + 1)
      continue
    }
    const next = args[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      options[rawName] = next
      index += 1
    } else {
      options[rawName] = true
    }
  }
  return { positionals, options }
}

function stringOption(options: Options, name: string, required = false): string | undefined {
  const value = options[name]
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (required) throw new Error(`--${name} is required`)
  return undefined
}

function booleanOption(options: Options, name: string): boolean {
  const value = options[name]
  if (value === undefined) return false
  if (value === true) return true
  throw new Error(`--${name} does not accept a value`)
}

function numberOption(options: Options, name: string): number | undefined {
  const value = stringOption(options, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return parsed
}

export function normalizeEnvironment(value: string): string {
  switch (value.trim().toLowerCase()) {
    case 'dev':
    case 'development':
      return 'dev'
    case 'stage':
    case 'staging':
      return 'staging'
    case 'prod':
    case 'production':
      return 'prod'
    default:
      throw new Error('Environment must be dev, staging, or prod')
  }
}

export function validateGitBranch(value: string): string {
  const valid = value.length > 0
    && value.length <= 100
    && !value.startsWith('-')
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.endsWith('.')
    && !value.includes('..')
    && !value.includes('//')
    && !value.includes('@{')
    && /^[A-Za-z0-9/._-]+$/.test(value)
  if (!valid) throw new Error(`Git branch is not safe for deployment: ${value}`)
  return value
}

export function validateGitRemote(value: string): string {
  const valid = value.length > 0
    && value.length <= 100
    && !value.startsWith('-')
    && !value.endsWith('/')
    && !value.includes('..')
    && !value.includes('//')
    && !value.includes('@{')
    && /^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(value)
  if (!valid) throw new Error(`Git remote name is not safe for deployment: ${value}`)
  return value
}

function configDirectory(): string {
  const override = process.env.SCALEMULE_CONFIG_HOME
  if (override) return override
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'scalemule')
}

function profilePath(): string {
  return join(configDirectory(), 'profile.json')
}

function fallbackCredentialsPath(): string {
  return join(configDirectory(), 'credentials.json')
}

function ensureConfigDirectory(): void {
  mkdirSync(configDirectory(), { recursive: true, mode: 0o700 })
  chmodSync(configDirectory(), 0o700)
}

function saveProfile(profile: Profile): void {
  ensureConfigDirectory()
  writeFileSync(profilePath(), `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 })
  chmodSync(profilePath(), 0o600)
}

function readProfile(): Profile {
  try {
    return JSON.parse(readFileSync(profilePath(), 'utf8')) as Profile
  } catch {
    throw new Error('No ScaleMule member login found. Run "scalemule login" first.')
  }
}

function credentialService(profile: Profile): string {
  return `scalemule-cli:${profile.apiUrl}:${profile.applicationId}`
}

function saveMemberToken(profile: Profile, token: string): void {
  if (process.platform === 'darwin') {
    execFileSync('security', [
      'add-generic-password', '-U',
      '-a', profile.email,
      '-s', credentialService(profile),
      '-w', token,
    ], { stdio: 'ignore' })
    return
  }
  ensureConfigDirectory()
  writeFileSync(fallbackCredentialsPath(), `${JSON.stringify({ token })}\n`, { mode: 0o600 })
  chmodSync(fallbackCredentialsPath(), 0o600)
  process.stderr.write('Warning: member credential saved in a mode-0600 file because no OS keychain adapter is available.\n')
}

function readMemberToken(): string {
  const environmentToken = process.env.SCALEMULE_MEMBER_TOKEN?.trim()
  if (environmentToken) return environmentToken
  const profile = readProfile()
  if (process.platform === 'darwin') {
    try {
      return execFileSync('security', [
        'find-generic-password',
        '-a', profile.email,
        '-s', credentialService(profile),
        '-w',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      throw new Error('ScaleMule member credential is missing from Keychain. Run "scalemule login" again.')
    }
  }
  try {
    const saved = JSON.parse(readFileSync(fallbackCredentialsPath(), 'utf8')) as { token?: string }
    if (!saved.token) throw new Error('missing token')
    return saved.token
  } catch {
    throw new Error('Saved ScaleMule member credential is missing. Run "scalemule login" again.')
  }
}

function deleteMemberToken(): void {
  try {
    const profile = readProfile()
    if (process.platform === 'darwin') {
      execFileSync('security', [
        'delete-generic-password',
        '-a', profile.email,
        '-s', credentialService(profile),
      ], { stdio: 'ignore' })
    }
  } catch {
    // Logout is idempotent.
  }
  rmSync(profilePath(), { force: true })
  rmSync(fallbackCredentialsPath(), { force: true })
}

async function promptPassword(): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Login needs an interactive terminal so the password can be entered securely.')
  }
  stdout.write('Password: ')
  stdin.setRawMode(true)
  stdin.resume()
  let password = ''
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      stdout.write('\n')
      if (error) reject(error)
      else resolve(password)
    }
    const onData = (data: Buffer) => {
      const value = data.toString('utf8')
      if (value.includes('\u0003')) return finish(new Error('Login cancelled'))
      if (value.includes('\r') || value.includes('\n')) return finish()
      if (value === '\u007f' || value === '\b') {
        password = Array.from(password).slice(0, -1).join('')
        return
      }
      password += value.replace(/[\u0000-\u001f\u007f]/g, '')
    }
    stdin.on('data', onData)
  })
}

async function publicRequest<T>(apiUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await response.json().catch(() => null) as { data?: T; error?: unknown; message?: string } | null
  if (!response.ok) {
    const error = json?.error
    const message = typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : json?.message ?? `${response.status} ${response.statusText}`
    throw new ScaleMuleHostingError(response.status, message, json)
  }
  if (!json || json.data === undefined) throw new Error('ScaleMule returned an invalid response')
  return json.data
}

function apiUrl(): string {
  const configured = (process.env.SCALEMULE_API_URL ?? 'https://api.scalemule.com').trim()
  let parsed: URL
  try {
    parsed = new URL(configured)
  } catch {
    throw new Error('SCALEMULE_API_URL must be a valid URL')
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
  const scalemuleHost = parsed.hostname === 'scalemule.com' || parsed.hostname.endsWith('.scalemule.com')
  if ((!local && (!scalemuleHost || parsed.protocol !== 'https:'))
    || parsed.username
    || parsed.password
    || (parsed.pathname !== '/' && parsed.pathname !== '')
    || parsed.search
    || parsed.hash) {
    throw new Error('SCALEMULE_API_URL must be an HTTPS scalemule.com origin (or localhost for development)')
  }
  return parsed.origin
}

function readDeployToken(): string {
  const token = process.env.SCALEMULE_DEPLOY_TOKEN?.trim()
  if (!token) {
    throw new Error('SCALEMULE_DEPLOY_TOKEN is required. Ask the project owner for a scoped release token.')
  }
  if (!isReleaseToken(token)) throw new Error('SCALEMULE_DEPLOY_TOKEN is malformed')
  return token
}

async function login(options: Options): Promise<void> {
  const email = stringOption(options, 'email', true)!
  const selectedApplication = stringOption(options, 'application')
  const discovered = await publicRequest<{
    applications: DiscoveredApplication[]
    default_application_id?: string | null
  }>(apiUrl(), '/v1/accounts/member/discover', { email })
  if (discovered.applications.length === 0) {
    throw new Error('No active ScaleMule customer memberships were found for that email.')
  }

  let application: DiscoveredApplication | undefined
  if (selectedApplication) {
    const match = selectedApplication.toLowerCase()
    application = discovered.applications.find(app => app.id === selectedApplication || app.name.toLowerCase() === match)
    if (!application) throw new Error(`No membership matched --application ${selectedApplication}`)
  } else if (discovered.applications.length === 1) {
    application = discovered.applications[0]
  } else if (discovered.default_application_id) {
    application = discovered.applications.find(app => app.id === discovered.default_application_id)
  }

  if (!application) {
    process.stdout.write('Available applications:\n')
    discovered.applications.forEach((app, index) => {
      process.stdout.write(`  ${index + 1}. ${app.name} (${app.environment}) — ${app.id}\n`)
    })
    const reader = createInterface({ input: stdin, output: stdout })
    const answer = await reader.question('Application number: ')
    reader.close()
    const index = Number(answer) - 1
    application = discovered.applications[index]
    if (!application) throw new Error('Invalid application selection')
  }

  const password = await promptPassword()
  const result = await publicRequest<{
    access_token: string
    member: { role: string; role_level: number }
  }>(apiUrl(), '/v1/accounts/member/login', {
    email,
    password,
    app_id: application.id,
    remember_me: true,
  })
  const profile: Profile = {
    apiUrl: apiUrl(),
    applicationId: application.id,
    applicationName: application.name,
    email,
  }
  saveProfile(profile)
  saveMemberToken(profile, result.access_token)
  process.stdout.write(`Logged in to ${application.name} as ${email} (${result.member.role}).\n`)
}

function git(args: string[]): string {
  // Git may invoke local hooks or an SSH helper. Neither needs ScaleMule
  // credentials, so do not propagate release/member secrets to child processes.
  const childEnvironment = { ...process.env }
  delete childEnvironment.SCALEMULE_DEPLOY_TOKEN
  delete childEnvironment.SCALEMULE_MEMBER_TOKEN
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr: unknown }).stderr).trim()
      : ''
    throw new Error(stderr || `Git command failed: git ${args.join(' ')}`)
  }
}

function prepareSource(options: Options): { commitSha: string; branch: string } {
  git(['rev-parse', '--is-inside-work-tree'])
  const dirty = git(['status', '--porcelain'])
  if (dirty) {
    throw new Error('The working tree has uncommitted changes. Commit the intended release before deploying.')
  }
  const commitSha = git(['rev-parse', '--verify', 'HEAD^{commit}']).toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('Git did not return a full commit SHA')
  const requestedBranch = stringOption(options, 'branch')
  const branch = validateGitBranch(requestedBranch ?? git(['symbolic-ref', '--quiet', '--short', 'HEAD']))

  if (!booleanOption(options, 'no-push')) {
    const remote = validateGitRemote(stringOption(options, 'remote') ?? 'origin')
    git(['remote', 'get-url', remote])
    process.stdout.write(`Pushing immutable commit ${commitSha.slice(0, 12)} to ${remote}/${branch}...\n`)
    git(['push', '--quiet', remote, `${commitSha}:refs/heads/${branch}`])
    const remoteLine = git(['ls-remote', '--heads', remote, `refs/heads/${branch}`])
    const remoteSha = remoteLine.split(/\s+/)[0]?.toLowerCase()
    if (remoteSha !== commitSha) {
      throw new Error(`Remote branch ${remote}/${branch} does not resolve to the intended commit`)
    }
  }
  return { commitSha, branch }
}

function printDeployment(deployment: Deployment): void {
  process.stdout.write(`Deployment: ${deployment.id}\n`)
  process.stdout.write(`Status: ${deployment.status}\n`)
  process.stdout.write(`Environment: ${deployment.environment}\n`)
  if (deployment.commit_sha) process.stdout.write(`Commit: ${deployment.commit_sha}\n`)
  if (deployment.url) process.stdout.write(`URL: ${deployment.url}\n`)
  if (deployment.error_message) {
    process.stdout.write(`Error${deployment.error_phase ? ` (${deployment.error_phase})` : ''}: ${deployment.error_message}\n`)
  }
}

async function waitForRelease(client: ScaleMuleHostingClient, initial: Deployment): Promise<Deployment> {
  let deployment = initial
  const deadline = Date.now() + 30 * 60 * 1000
  let previousStatus = ''
  while (!TERMINAL_RELEASE_STATES.has(deployment.status)) {
    if (deployment.status !== previousStatus) {
      process.stdout.write(`Release status: ${deployment.status}\n`)
      previousStatus = deployment.status
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for release ${deployment.id}; use "scalemule status --deployment ${deployment.id}".`)
    }
    await new Promise(resolve => setTimeout(resolve, 5000))
    deployment = await client.getRelease(deployment.id)
  }
  return deployment
}

async function deploy(options: Options): Promise<void> {
  const deployToken = readDeployToken()
  const environment = normalizeEnvironment(stringOption(options, 'environment', true)!)
  const source = prepareSource(options)
  const client = new ScaleMuleHostingClient({ apiUrl: apiUrl(), deployToken })
  const releaseRequest = {
    environment,
    commitSha: source.commitSha,
    branch: source.branch,
    idempotencyKey: randomUUID(),
  }
  let deployment: Deployment | undefined
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      deployment = await client.triggerRelease(releaseRequest)
      break
    } catch (error) {
      const retryable = error instanceof ScaleMuleHostingError
        && (error.status === 0 || error.status === 429 || error.status >= 500)
      if (!retryable || attempt === 3) throw error
      await new Promise(resolve => setTimeout(resolve, attempt * 1000))
    }
  }
  if (!deployment) throw new Error('ScaleMule did not return a deployment')
  process.stdout.write(`ScaleMule accepted release ${deployment.id}.\n`)
  if (booleanOption(options, 'wait')) deployment = await waitForRelease(client, deployment)
  printDeployment(deployment)
  if (isUnsuccessfulDeploymentStatus(deployment.status)) process.exitCode = 1
}

async function status(options: Options): Promise<void> {
  const deployToken = readDeployToken()
  const deploymentId = stringOption(options, 'deployment', true)!
  const client = new ScaleMuleHostingClient({ apiUrl: apiUrl(), deployToken })
  printDeployment(await client.getRelease(deploymentId))
}

async function memberCommand(positionals: string[], options: Options): Promise<void> {
  const client = new ScaleMuleHostingClient({ apiUrl: apiUrl(), memberToken: readMemberToken() })
  if (positionals[0] === 'projects') {
    const projects = await client.listProjects()
    for (const project of projects) {
      process.stdout.write(`${project.slug}\t${project.status}\t${project.name}\t${project.id}\n`)
    }
    return
  }
  if (positionals[0] !== 'release-token') throw new Error(`Unknown command: ${positionals.join(' ')}`)

  const action = positionals[1]
  const project = stringOption(options, 'project', true)!
  if (action === 'create') {
    const token = await client.createReleaseToken(project, {
      name: stringOption(options, 'name', true)!,
      environment: stringOption(options, 'environment')
        ? normalizeEnvironment(stringOption(options, 'environment')!)
        : undefined,
      branch: stringOption(options, 'branch')
        ? validateGitBranch(stringOption(options, 'branch')!)
        : undefined,
      expiresInDays: numberOption(options, 'expires-days'),
    })
    if (!token.token) throw new Error('ScaleMule did not return the one-time release token')
    if (!isReleaseToken(token.token)) throw new Error('ScaleMule returned a malformed release token')
    process.stdout.write('Release token created. It will only be shown once.\n\n')
    process.stdout.write(`export SCALEMULE_DEPLOY_TOKEN='${token.token}'\n`)
    process.stdout.write(`\nToken ID: ${token.id}\n`)
    process.stdout.write(`Allowed branch: ${token.allowed_branch}\n`)
    if (token.expires_at) process.stdout.write(`Expires: ${token.expires_at}\n`)
    return
  }
  if (action === 'list') {
    const tokens = await client.listReleaseTokens(project)
    for (const token of tokens) {
      const expired = token.expires_at !== null
        && token.expires_at !== undefined
        && Date.parse(token.expires_at) <= Date.now()
      const state = token.revoked_at ? 'revoked' : expired ? 'expired' : 'active'
      process.stdout.write(`${token.id}\t${state}\t${token.name}\t${token.environment ?? 'all'}\t${token.allowed_branch}\t${token.token_prefix}\n`)
    }
    return
  }
  if (action === 'revoke') {
    const tokenId = stringOption(options, 'token-id', true)!
    await client.revokeReleaseToken(project, tokenId)
    process.stdout.write(`Revoked release token ${tokenId}.\n`)
    return
  }
  throw new Error('release-token action must be create, list, or revoke')
}

async function main(): Promise<void> {
  const { positionals, options } = parseArguments(process.argv.slice(2))
  if (Object.prototype.hasOwnProperty.call(options, 'deploy-token')) {
    throw new Error('--deploy-token is not accepted; set SCALEMULE_DEPLOY_TOKEN in the environment')
  }
  const wantsHelp = booleanOption(options, 'help')
  booleanOption(options, 'wait')
  booleanOption(options, 'no-push')
  const command = positionals[0]
  if (!command || command === 'help' || wantsHelp) {
    process.stdout.write(`${help()}\n`)
    return
  }
  if (command === 'login') return login(options)
  if (command === 'logout') {
    deleteMemberToken()
    process.stdout.write('Logged out.\n')
    return
  }
  if (command === 'whoami') {
    const token = readDeployToken()
    const project = await new ScaleMuleHostingClient({ apiUrl: apiUrl(), deployToken: token }).getReleaseProject()
    process.stdout.write(`${project.slug}\t${project.status}\t${project.name}\t${project.id}\n`)
    return
  }
  if (command === 'deploy') return deploy(options)
  if (command === 'status') return status(options)
  return memberCommand(positionals, options)
}

main().catch(error => {
  if (error instanceof ScaleMuleHostingError) {
    process.stderr.write(`ScaleMule request failed (${error.status || 'network'}): ${error.message}\n`)
  } else {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  process.exitCode = 1
})
