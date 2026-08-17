/**
 * wakatime-cli discovery and installation. A globally installed `wakatime-cli`
 * (brew, scoop, or manual) is used as-is; otherwise the plugin downloads the
 * latest release zip from GitHub into the WakaTime resources directory and
 * checks for updates every four hours. Ported from opencode-wakatime (MIT).
 * @module dsh-wakatime/cli
 */

import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import { createWriteStream } from 'node:fs'
import * as https from 'node:https'
import * as os from 'node:os'
import * as path from 'node:path'
import { logger } from './logger.ts'
import { getWakatimeResourcesDir } from './paths.ts'

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/wakatime/wakatime-cli/releases/latest'
const GITHUB_DOWNLOAD_URL = 'https://github.com/wakatime/wakatime-cli/releases/latest/download'

/** Interval between update checks for the managed CLI (4 hours). */
const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000

interface CliState {
  lastChecked?: number
  version?: string
}

function whichSync(cmd: string): string | null {
  try {
    const isWindows = os.platform() === 'win32'
    const result = execSync(isWindows ? `where ${cmd}` : `which ${cmd}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const firstLine = result.trim().split('\n')[0]
    return firstLine || null
  } catch {
    return null
  }
}

class CliDependencies {
  private readonly resourcesLocation: string
  private readonly stateFile: string
  private cliLocation: string | undefined

  constructor() {
    this.resourcesLocation = getWakatimeResourcesDir()
    this.stateFile = path.join(this.resourcesLocation, 'dsh-cli-state.json')
  }

  private isWindows(): boolean {
    return os.platform() === 'win32'
  }

  private getOsName(): string {
    const platform = os.platform()
    return platform === 'win32' ? 'windows' : platform
  }

  private getArchitecture(): string {
    const arch = os.arch()
    if (arch === 'x64') return 'amd64'
    if (arch === 'ia32' || arch.includes('32')) return '386'
    if (arch === 'arm64') return 'arm64'
    if (arch === 'arm') return 'arm'
    return arch
  }

  private getCliBinaryName(): string {
    const ext = this.isWindows() ? '.exe' : ''
    return `wakatime-cli-${this.getOsName()}-${this.getArchitecture()}${ext}`
  }

  private getCliDownloadUrl(): string {
    return `${GITHUB_DOWNLOAD_URL}/wakatime-cli-${this.getOsName()}-${this.getArchitecture()}.zip`
  }

  private readState(): CliState {
    try {
      if (fs.existsSync(this.stateFile)) {
        return JSON.parse(fs.readFileSync(this.stateFile, 'utf-8')) as CliState
      }
    } catch {
      // Corrupt state is treated as absent.
    }
    return {}
  }

  private writeState(state: CliState): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2))
    } catch {
      // State is a cache hint only.
    }
  }

  /** A `wakatime-cli` on PATH, if any. */
  getCliLocationGlobal(): string | undefined {
    const binaryName = `wakatime-cli${this.isWindows() ? '.exe' : ''}`
    const globalPath = whichSync(binaryName)
    if (globalPath) {
      logger.debug(`Found global wakatime-cli: ${globalPath}`)
      return globalPath
    }
    return undefined
  }

  /** The CLI to invoke: the global one when present, else the managed download. */
  getCliLocation(): string {
    if (this.cliLocation) return this.cliLocation
    const globalCli = this.getCliLocationGlobal()
    this.cliLocation = globalCli ?? path.join(this.resourcesLocation, this.getCliBinaryName())
    return this.cliLocation
  }

  /** Whether the resolved CLI binary exists on disk. */
  isCliInstalled(): boolean {
    const location = this.getCliLocation()
    return fs.existsSync(location)
  }

  private shouldCheckForUpdates(): boolean {
    if (this.getCliLocationGlobal()) return false
    const state = this.readState()
    if (state.lastChecked === undefined) return true
    return Date.now() - state.lastChecked > UPDATE_CHECK_INTERVAL
  }

  /** Install the CLI when missing and refresh it on the update interval. */
  async checkAndInstallCli(): Promise<void> {
    if (this.getCliLocationGlobal()) {
      logger.debug('Using global wakatime-cli, skipping installation check')
      return
    }
    if (!this.isCliInstalled()) {
      logger.info('wakatime-cli not found, downloading…')
      await this.installCli()
      return
    }
    if (this.shouldCheckForUpdates()) {
      logger.debug('Checking for wakatime-cli updates…')
      const latestVersion = await this.getLatestVersion()
      const state = this.readState()
      if (latestVersion !== undefined && latestVersion !== state.version) {
        logger.info(`Updating wakatime-cli to ${latestVersion}…`)
        await this.installCli()
        this.writeState({ lastChecked: Date.now(), version: latestVersion })
      } else {
        this.writeState({ ...state, lastChecked: Date.now() })
      }
    }
  }

  private async getLatestVersion(): Promise<string | undefined> {
    return new Promise((resolve) => {
      https.get(GITHUB_RELEASES_URL, { headers: { 'User-Agent': 'dsh-wakatime' } }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            resolve((JSON.parse(data) as { tag_name?: string }).tag_name)
          } catch {
            resolve(undefined)
          }
        })
      }).on('error', () => resolve(undefined))
    })
  }

  private async installCli(): Promise<void> {
    const zipUrl = this.getCliDownloadUrl()
    const zipFile = path.join(this.resourcesLocation, `wakatime-cli-${Date.now()}.zip`)
    try {
      fs.mkdirSync(this.resourcesLocation, { recursive: true })
      logger.debug(`Downloading wakatime-cli from ${zipUrl}`)
      await this.downloadFile(zipUrl, zipFile)
      logger.debug(`Extracting wakatime-cli to ${this.resourcesLocation}`)
      await this.extractZip(zipFile, this.resourcesLocation)
      if (!this.isWindows()) {
        const cliPath = this.getCliLocation()
        if (fs.existsSync(cliPath)) {
          fs.chmodSync(cliPath, 0o755)
          logger.debug(`Set executable permission on ${cliPath}`)
        }
      }
      logger.info('wakatime-cli installed successfully')
    } catch (err) {
      logger.errorException(err)
      throw err
    } finally {
      try {
        if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile)
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const followRedirect = (target: string, redirectCount = 0): void => {
        if (redirectCount > 5) {
          reject(new Error('Too many redirects'))
          return
        }
        https.get(target, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            const location = res.headers.location
            if (location) {
              followRedirect(location, redirectCount + 1)
              return
            }
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`))
            return
          }
          const file = createWriteStream(dest)
          res.pipe(file)
          file.on('finish', () => {
            file.close()
            resolve()
          })
          file.on('error', (err) => {
            fs.unlinkSync(dest)
            reject(err)
          })
        }).on('error', reject)
      }
      followRedirect(url)
    })
  }

  private async extractZip(zipFile: string, destDir: string): Promise<void> {
    try {
      if (this.isWindows()) {
        execSync(`powershell -command "Expand-Archive -Force '${zipFile}' '${destDir}'"`, { windowsHide: true })
      } else {
        execSync(`unzip -o "${zipFile}" -d "${destDir}"`, { stdio: 'ignore' })
      }
    } catch {
      logger.warn('Native unzip failed, attempting manual extraction')
      await this.extractZipManual(zipFile, destDir)
    }
  }

  /** Minimal single-file ZIP extraction fallback (stored or deflate entries). */
  private async extractZipManual(zipFile: string, destDir: string): Promise<void> {
    const data = fs.readFileSync(zipFile)
    let offset = 0
    while (offset < data.length - 4) {
      const sig = data.readUInt32LE(offset)
      if (sig === 0x04034b50) {
        const compressionMethod = data.readUInt16LE(offset + 8)
        const compressedSize = data.readUInt32LE(offset + 18)
        const uncompressedSize = data.readUInt32LE(offset + 22)
        const fileNameLength = data.readUInt16LE(offset + 26)
        const extraFieldLength = data.readUInt16LE(offset + 28)
        const fileName = data.subarray(offset + 30, offset + 30 + fileNameLength).toString()
        const dataStart = offset + 30 + fileNameLength + extraFieldLength
        if (fileName.includes('wakatime-cli')) {
          const destPath = path.join(destDir, path.basename(fileName))
          if (compressionMethod === 0) {
            fs.writeFileSync(destPath, data.subarray(dataStart, dataStart + uncompressedSize))
          } else if (compressionMethod === 8) {
            const { inflateRawSync } = await import('node:zlib')
            fs.writeFileSync(destPath, inflateRawSync(data.subarray(dataStart, dataStart + compressedSize)))
          }
          logger.debug(`Extracted ${fileName} to ${destPath}`)
          return
        }
        offset = dataStart + compressedSize
      } else {
        offset += 1
      }
    }
    throw new Error('Could not find wakatime-cli in zip file')
  }
}

/** Singleton CLI dependency manager. */
export const dependencies = new CliDependencies()

/** Ensure the CLI is present (installing or updating it when needed). */
export async function ensureCliInstalled(): Promise<boolean> {
  try {
    await dependencies.checkAndInstallCli()
    return dependencies.isCliInstalled()
  } catch (err) {
    logger.errorException(err)
    return false
  }
}
