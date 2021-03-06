#!/usr/bin/env node

// vim: ft=typescript

import { cliEnvConfig } from '@isaacs/cli-env-config'
import { existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import {
  DeviceAuthorizationSuccessResponse,
  ErrorResponse,
  TierClient,
} from './index'

type Command = (
  argv: string[],
  config: { [key: string]: any }
) => Promise<void> | void

const parseArgv = cliEnvConfig({
  prefix: 'TIER',
  options: [['api-url', 'a'], ['web-url', 'w'], ['key', 'k'], 'auth-type'],
  switches: [
    ['debug', 'v'],
    ['help', 'h'],
  ],
  switchInverts: [['noVerbose', 'debug', 'V']],
  allowUnknown: true,
})

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
  usage(
    `tier: usage: tier [options] <command>

Options:

  --api-url=<url>  Set the tier API server base url.
                   Defaults to TIER_API_URL env, or https://api.tier.run/

  --web-url=<url>  Set the tier web server base url to use for login.
                   Defaults to TIER_WEB_URL env, or https://tier.run/

  --key=<token>    Specify the auth token for Tier to use.
                   Tokens can be generated manually by visiting
                   <https://app.tier.run/app/account/tokens>, minted for a
                   project by running 'tier login', or set in the environment
                   variable TIER_KEY.

  --auth-type=<basic|bearer>
                   Tell Tier to use the specified auth type.  Default: basic

  --debug -v       Turn debug logging on
  --no-debug -V    Turn debug logging off

  --help -h        Show this usage screen.

Commands:

  login            Log in the CLI by authorizing in your web browser.
                   Tokens are stored scoped to each project working directory
                   and API server, and will not be active outside of that
                   environment.

  logout           Remove a login token from your system.

  projectDir       Show the current project directory that login tokens are
                   scoped to.

  push <jsonfile>  Push the pricing model defined in <jsonfile> to Tier.

  pull             Show the current model.

  whoami           Get the organization ID associated with the current login.

  fetch <path>     Make an arbitrary request to a Tier API endpoint.
`,
    er
  )

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

const main = async (argvInput: string[]) => {
  let parsed
  try {
    parsed = parseArgv(argvInput)
  } catch (er) {
    return topUsage((er as { message: string }).message)
  }
  const { config, argv } = parsed

  const commands: { [key: string]: Command } = {
    login: doLogin,
    logout: doLogout,
    projectDir: showProjectDir,
    push: doPush,
    pull: doPull,
    whoami: whoami,
    'pricing-page': doPricingPage,
    fetch: doFetch,
  }

  const cmd = argv.shift()
  if (cmd && commands[cmd]) {
    return commands[cmd](argv, config)
  }

  switch (cmd) {
    case undefined:
      return topUsage()
    case 'dumpconf':
      return dumpConf(config, argv)
    default:
      return topUsage(`Unrecognized command: ${cmd}`)
  }
}

const dumpConf = (config: { [k: string]: any }, argv: string[]): void => {
  if (config.key) {
    config.key = '(redacted)'
  }
  const env: { [k: string]: string } = {}
  for (const [key, val] of Object.entries(process.env)) {
    if (/^TIER_/.test(key) && val !== undefined) {
      env[key] = key === 'TIER_KEY' ? '(redacted)' : val
    }
  }
  console.log({ config, argv, env })
}

const getClient = (): TierClient => {
  // if it's not a login request, we need to log in
  try {
    return TierClient.fromEnv()
  } catch (er) {
    try {
      // TODO: walk up until we find indications of a project, but no higher
      // than process.env.HOME
      return TierClient.fromCwd(projectDir() || process.cwd())
    } catch (er) {
      console.error(er)
      process.exit(1)
    }
  }
}

const showProjectDir: Command = (argv, _): void => {
  // no options
  cliEnvConfig({ prefix: 'TIER' })(argv)
  console.log(projectDir())
}

const loginUsage = (er?: any) =>
  usage(
    `usage: tier login
Run in a project directory`,
    er
  )
const doLogin: Command = async (argv, config): Promise<void> => {
  if (config.help) {
    return loginUsage()
  }
  // no options
  cliEnvConfig({ prefix: 'TIER' })(argv)

  const { default: opener } = await import('opener')
  const cwd = projectDir() || process.cwd()
  const tc = TierClient.fromEnv({ tierKey: TierClient.NO_AUTH })
  const authResponse = await tc.initLogin()
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

const doLogout: Command = (argv: string[]): void => {
  // no options
  cliEnvConfig({ prefix: 'TIER' })(argv)

  const cwd = projectDir() || process.cwd()
  TierClient.fromEnv({ tierKey: TierClient.NO_AUTH }).logout(cwd)
}

const pushUsage = (er?: any) => usage(`usage: tier push <pricing.json>`, er)

const whoami: Command = async (argv: string[]): Promise<void> => {
  // no options
  cliEnvConfig({ prefix: 'TIER' })(argv)

  console.log(JSON.stringify(await getClient().ping(), null, 2))
}

const pullUsage = (er?: any) => usage(`usage: tier pull`, er)
const doPull: Command = async (argv: string[]): Promise<void> => {
  // no options
  cliEnvConfig({ prefix: 'TIER' })(argv)

  try {
    const data = await getClient().pullModel()
    console.log(JSON.stringify(data, null, 2))
  } catch (er) {
    pullUsage(er)
  }
}

const doPush: Command = async (argv: string[]): Promise<void> => {
  // no options
  cliEnvConfig({ prefix: 'TIER' })(argv)

  const fname = argv.shift()
  if (!fname) {
    return pushUsage(new Error('must supply filename'))
  }
  try {
    console.log(await getClient().pushModel(readFileSync(fname)))
  } catch (er) {
    pushUsage(er)
  }
}

const pricingPageUsage = (er?: any) =>
  usage(`usage: tier pricing-page <pull [<name>] | push <jsonfile>>`, er)
const doPricingPage: Command = async (argv, config): Promise<void> => {
  // no options
  cliEnvConfig({ prefix: 'TIER' })(argv)

  const cmd = argv.shift()
  if (!cmd) {
    return pricingPageUsage(new Error('must supply a command'))
  }
  switch (cmd) {
    case 'pull':
      return doPricingPagePull(argv, config)
    case 'push':
      return doPricingPagePush(argv, config)
    case undefined:
      return pricingPageUsage(new Error('must supply a command'))
    default:
      return pricingPageUsage(new Error(`Unrecognized command: ${cmd}`))
  }
}

const doPricingPagePull: Command = async (argv, _): Promise<void> => {
  // no options
  cliEnvConfig({ prefix: 'TIER' })(argv)

  const name = argv.shift() || 'default'
  try {
    const res = await getClient().pullPricingPage(name)
    console.log(JSON.stringify(res, null, 2))
  } catch (er) {
    console.error(er)
    process.exit(1)
  }
}

// TODO
const doPricingPagePush: Command = async (_, __): Promise<void> => {}

const fetchUsage = (er?: any) =>
  usage(
    `usage: tier fetch [options...] <path>
options:
  -X, --method       the HTTP method to use, eg POST or GET
  -H, --header       add an HTTP header to the request
  -d, --data <data>  JSON string to send as the request body`,
    er
  )

const doFetch = async (argvInput: string[]): Promise<void> => {
  const parser = cliEnvConfig({
    prefix: 'TIER',
    options: [
      ['method', 'X'],
      ['data', 'd'],
    ],
    multivars: [['header', 'H']],
  })
  const {
    argv,
    config: { method = 'GET', header = [], data },
  } = parser(argvInput)
  const path = argv.shift()
  if (!path) {
    return fetchUsage('must provide API path')
  }
  try {
    const res = await getClient().fetchOK(path, {
      headers: (header as string[]).map(h => {
        const [key, ...val] = h.split(':')
        return [key, val.join(':')]
      }),
      method: method as string,
      body: data as string | undefined,
    })
    console.log(JSON.stringify(res, null, 2))
  } catch (er) {
    console.error(er)
    process.exit(1)
  }
}

main(process.argv.slice(2))
