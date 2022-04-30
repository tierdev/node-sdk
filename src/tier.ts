#!/usr/bin/env node

// vim: ft=typescript

import { TierClient } from './index.js'
import type {
  TierError,
  ErrorResponse,
  DeviceAuthorizationSuccessResponse,
} from './index.js'
import { readFileSync, existsSync } from 'fs'
import { dirname, resolve } from 'path'

const cleanErr = (er: any): any => {
  if (!er || typeof er !== 'object') {
    return er
  }
  if (Array.isArray(er)) {
    return er.map(v => cleanErr(v))
  }
  if (er && typeof er === 'object') {
    for (const [k, v] of Object.entries(er)) {
      if (k === 'authorization') {
        er[k] = '{redacted}'
      } else {
        er[k] = cleanErr(v)
      }
    }
  }
  return er
}

const usage = (msg: string, er?: any) => {
  if (er) {
    console.error(msg)
    if (typeof er === 'object') {
      console.error('')
      const body = er?.response?.body
      const h = er?.response?.headers
      const ct = (h || {})['content-type'] || ''
      if (typeof body === 'string' && ct.startsWith('application/json')) {
        console.error(JSON.parse(body))
      } else {
        console.error(cleanErr(er))
      }
    } else if (er !== true) {
      console.error('ERROR:', er)
    }
    process.exit(1)
  } else {
    console.log(msg)
    process.exit(0)
  }
}

const topUsage = (er?: any) =>
  usage(`tier: usage: tier [push|pull|help|login|logout]`, er)

const projectRootFiles = [
  '.git',
  '.hg',
  'package.json',
  'node_modules',
  'go.mod',
  'go.sum',
  'tsconfig.json',
]
const projectDir = (
  top: string = process.env.HOME || process.cwd(),
  dir: string = process.cwd(),
  start?: string
): string | null => {
  const dn = dirname(dir)

  if (dir === top && !start) {
    return dir
  }

  // if we hit the end, then just use whatever cwd we started with
  if (dn === dir || dir === top) {
    return null
  }

  // evidence of a project root of some kind
  if (projectRootFiles.find(f => existsSync(resolve(dir, f)))) {
    return dir
  }

  return projectDir(top, dn, start || dir) || start || dir
}

const main = async (argv: string[]) => {
  if (!argv[2]) {
    return topUsage()
  }

  if (argv[2] === 'login') {
    return doLogin()
  }

  if (argv[2] === 'logout') {
    return doLogout()
  }

  if (argv[2] === 'projectDir') {
    console.log(projectDir())
    process.exit(0)
  }

  // if it's not a login request, we need to log in
  let tc
  try {
    tc = TierClient.fromEnv()
  } catch (er) {
    try {
      // TODO: walk up until we find indications of a project, but no higher
      // than process.env.HOME
      tc = TierClient.fromCwd(projectDir() || process.cwd())
    } catch (er) {
      console.error(er)
      process.exit(1)
    }
  }

  switch (argv[2]) {
    case 'push':
      return doPush(tc, argv[3])
    case 'pull':
      return doPull(tc)
    case 'whoami':
      return whoami(tc)
    default:
      return topUsage()
  }
}

const doLogin = async (): Promise<void> => {
  const { default: opener } = await import('opener')
  const cwd = projectDir() || process.cwd()
  const tc = TierClient.fromEnv({ tierKey: TierClient.NO_AUTH })
  const authResponse = await tc.initLogin(cwd)
  const eres = authResponse as ErrorResponse
  if (eres.error) {
    throw new Error(eres.error)
  }
  const res = authResponse as DeviceAuthorizationSuccessResponse

  if (res.verification_uri_complete) {
    console.error(`
Attempting to open your browser to complete the authorization.

If that fails, please navigate to: ${res.verification_uri}
and enter the code: ${res.user_code}

Waiting...`)
    const proc = opener(res.verification_uri_complete, { stdio: 'ignore' })
    proc.unref()
  } else {
    console.error(`
To complete the verification, copy this code: ${res.user_code}
and enter it at: ${res.verification_uri}

Waiting...`)
  }
  await tc.awaitLogin(cwd, res)
  console.log(`Logged into tier!\nproject: ${cwd}`)
}

const doLogout = (): void => {
  const cwd = projectDir() || process.cwd()
  TierClient.fromEnv({ tierKey: TierClient.NO_AUTH }).logout(cwd)
}

const pushUsage = (er?: any) => usage(`usage: tier push <pricing.json>`, er)

const whoami = async (tc: TierClient): Promise<void> => {
  console.log(await tc.ping())
}

const pullUsage = (er?: any) => usage(`usage: tier pull`, er)
const doPull = async (tc: TierClient): Promise<void> => {
  try {
    console.log(JSON.stringify(await tc.pullModel(), null, 2))
  } catch (er) {
    pullUsage(er)
  }
}

const doPush = async (
  tc: TierClient,
  fname: string | undefined
): Promise<void> => {
  if (!fname) {
    return pushUsage(new Error('must supply filename'))
  }
  try {
    console.log(await tc.pushModel(JSON.parse(readFileSync(fname, 'utf8'))))
  } catch (er) {
    pushUsage(er)
  }
}

main(process.argv)
