/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { Show } from "solid-js"
import { Database } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { xdgData } from "xdg-basedir"

const GLOBAL_PROJECT = "global"
const LOG_FILE = "/tmp/opencode-session-migrate.log"

let debug = false

function debugLog(...args: unknown[]) {
  if (!debug) return
  const line = args.map((a) => (typeof a === "string" ? a : formatError(a))).join(" ")
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    // best-effort logging, never crash the plugin
  }
}

function formatError(e: unknown): string {
  if (e instanceof Error) return e.stack ?? e.message
  return JSON.stringify(e)
}

type SessionInfo = {
  id: string
  title: string
  directory: string
  projectID: string
  parentID?: string
  time: { updated: number }
}

type ProjectInfo = {
  id: string
  name?: string
  worktree: string
}

type Destination = {
  projectID: string
  directory: string
}

function dataDir(): string {
  return path.join(xdgData ?? path.join(os.homedir(), ".local", "share"), "opencode")
}

function dbPath(): string {
  const env = process.env.OPENCODE_DB
  if (env && env !== ":memory:") {
    return path.isAbsolute(env) ? env : path.join(dataDir(), env)
  }
  return path.join(dataDir(), "opencode.db")
}

function isOrphan(session: SessionInfo, projects: ProjectInfo[]): boolean {
  if (!session.directory || !fs.existsSync(session.directory)) return true
  if (session.projectID === GLOBAL_PROJECT) {
    return projects.some(
      (p) =>
        p.id !== GLOBAL_PROJECT &&
        p.worktree !== "/" &&
        (session.directory === p.worktree || session.directory.startsWith(p.worktree + path.sep)),
    )
  }
  return false
}

// Converts a filesystem path to OpenCode's on-disk storage form. OpenCode's
// path type stores forward slashes even on Windows (e.g. "C:/foo/bar"), but
// raw filesystem paths on win32 use backslashes ("C:\foo\bar"). Direct SQLite
// writes bypass OpenCode's path type, so we must normalize here to match what
// /sessions compares against. No-op on non-win32 platforms.
export function toStoragePath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return p
  return p.replace(/\\/g, "/")
}

function migrate(sessionID: string, projectID: string, directory: string): void {
  const storageDirectory = toStoragePath(directory)
  const db = new Database(dbPath(), { readwrite: true })
  try {
    const set = "project_id = ?, directory = ?, path = NULL, workspace_id = NULL"
    const update = db.prepare(`UPDATE session SET ${set} WHERE id = ?`)
    const updateChildren = db.prepare(`UPDATE session SET ${set} WHERE parent_id = ?`)
    db.transaction(() => {
      update.run(projectID, storageDirectory, sessionID)
      updateChildren.run(projectID, storageDirectory, sessionID)
    })()
  } finally {
    db.close()
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function loadingBox(message: string) {
  return (
    <box paddingLeft={2} paddingTop={1}>
      <text>{message}</text>
    </box>
  )
}

async function openMigrateDialog(api: TuiPluginApi) {
  debugLog("openMigrateDialog: start")
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => loadingBox("Loading sessions..."))

  try {
    debugLog("openMigrateDialog: fetching sessions + projects")
    const [sessionsRes, projectsRes] = await Promise.all([
      // Empty directory stops the SDK from injecting the cwd and filtering
      // to the current project's sessions.
      api.client.experimental.session.list({ roots: true, limit: 200, directory: "" }),
      api.client.project.list(),
    ])
    const sessions = (sessionsRes.data ?? []) as SessionInfo[]
    const projects = (projectsRes.data ?? []) as ProjectInfo[]
    debugLog(`openMigrateDialog: sessions=${sessions.length} projects=${projects.length}`)

    const orphans = new Set(sessions.filter((s) => isOrphan(s, projects)).map((s) => s.id))
    const projectNames = new Map(projects.map((p) => [p.id, p.name ?? p.worktree]))
    debugLog(`openMigrateDialog: orphans=${orphans.size} dbPath=${dbPath()}`)

    api.ui.dialog.replace(() => (
      <DialogSessionMigrate api={api} sessions={sessions} orphans={orphans} projectNames={projectNames} />
    ))
  } catch (error) {
    debugLog("openMigrateDialog: error", error)
    api.ui.dialog.replace(() => loadingBox("Failed to load sessions"))
  }
}

function DialogSessionMigrate(props: {
  api: TuiPluginApi
  sessions: SessionInfo[]
  orphans: Set<string>
  projectNames: Map<string, string>
}) {
  const api = props.api
  const DialogSelect = api.ui.DialogSelect
  const theme = api.theme.current

  const options = props.sessions.map((s) => ({
    title: s.title,
    value: s.id,
    description: s.directory,
    footer: formatTime(s.time.updated),
    category: props.projectNames.get(s.projectID) ?? s.projectID,
    gutter: props.orphans.has(s.id) ? () => <text fg={theme.warning}>!</text> : undefined,
  }))

  return (
    <box>
      <DialogSelect
        title="Migrate Session"
        placeholder="Search sessions"
        options={options}
        onSelect={(option) => {
          debugLog("DialogSessionMigrate.onSelect:", option.value)
          const session = props.sessions.find((s) => s.id === option.value)
          if (!session) return
          void openRescueDialog(api, session)
        }}
      />
      <Show when={props.orphans.size > 0}>
        <box paddingLeft={4} paddingRight={4} paddingBottom={1}>
          <text fg={theme.textMuted}>
            NOTE: <span style={{ fg: theme.warning }}>!</span> means the session is orphan
          </text>
        </box>
      </Show>
    </box>
  )
}

async function openRescueDialog(api: TuiPluginApi, session: SessionInfo) {
  debugLog("openRescueDialog: start", session.id)
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => loadingBox("Loading projects..."))

  try {
    debugLog("openRescueDialog: fetching current + list")
    const [cur, all] = await Promise.all([api.client.project.current(), api.client.project.list()])
    const current = cur.data as ProjectInfo | undefined
    const projects = (all.data ?? []) as ProjectInfo[]
    debugLog(`openRescueDialog: current=${current?.id} projects=${projects.length}`)

    api.ui.dialog.replace(() => (
      <DialogSessionRescue api={api} session={session} current={current} projects={projects} />
    ))
  } catch (error) {
    debugLog("openRescueDialog: error", error)
    api.ui.dialog.replace(() => loadingBox("Failed to load projects"))
  }
}

function DialogSessionRescue(props: {
  api: TuiPluginApi
  session: SessionInfo
  current: ProjectInfo | undefined
  projects: ProjectInfo[]
}) {
  const api = props.api
  const DialogSelect = api.ui.DialogSelect

  const options: Array<{
    title: string
    value: Destination
    description: string
    category: string
  }> = []

  if (props.current) {
    const dir = api.state.path.directory || props.current.worktree
    options.push({
      title: props.current.name ?? props.current.worktree,
      value: { projectID: props.current.id, directory: dir },
      description: dir,
      category: "Current",
    })
  }

  options.push({
    title: "Home (~)",
    value: { projectID: GLOBAL_PROJECT, directory: os.homedir() },
    description: os.homedir(),
    category: "Special",
  })

  for (const p of props.projects) {
    if (p.id === props.current?.id) continue
    if (p.id === GLOBAL_PROJECT) continue
    options.push({
      title: p.name ?? p.worktree,
      value: { projectID: p.id, directory: p.worktree },
      description: p.worktree,
      category: "Projects",
    })
  }

  return (
    <DialogSelect
      title={`Migrate: ${props.session.title}`}
      placeholder="Choose destination"
      options={options}
      onSelect={(option) => {
        debugLog("DialogSessionRescue.onSelect:", option.value.projectID, option.value.directory)
        try {
          migrate(props.session.id, option.value.projectID, option.value.directory)
          debugLog("migrate: success")
        } catch (error) {
          debugLog("migrate: error", error)
          api.ui.toast({ variant: "error", title: "Migration failed", message: formatError(error) })
          return
        }
        void openMigrateDialog(api)
      }}
    />
  )
}

const tui: TuiPlugin = async (api, options, meta) => {
  if (options?.enabled === false) return

  debug = options?.debug === true
  const key = typeof options?.keybind === "string" ? options.keybind : "ctrl+o"
  debugLog("plugin: init", `keybind=${key}`)

  api.keymap.registerLayer({
    commands: [
      {
        name: "session_migrate",
        title: "Migrate sessions",
        category: "Plugin",
        namespace: "palette",
        slashName: "migrate",
        run() {
          debugLog("command: session_migrate triggered")
          void openMigrateDialog(api)
        },
      },
    ],
    bindings: [{ key, cmd: "session_migrate", desc: "Migrate sessions" }],
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "session-migrate",
  tui,
}

export default plugin
