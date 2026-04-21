import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { compressForCaveman, type CavemanMode } from '../context/caveman.js'
import type { MemoryHeader } from './scan.js'

interface SqliteStatement {
	run(...params: unknown[]): unknown
	get(...params: unknown[]): Record<string, unknown> | undefined
	all(...params: unknown[]): Record<string, unknown>[]
}

interface SqliteDatabase {
	exec(sql: string): void
	prepare(sql: string): SqliteStatement
	close(): void
}

interface SqliteAdapter {
	open(path: string): SqliteDatabase
}

const SQLITE = await loadSqliteAdapter()

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  ide TEXT NOT NULL,
  cwd TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  compressed INTEGER NOT NULL DEFAULT 1,
  intensity TEXT,
  ts INTEGER NOT NULL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_observations_ts ON observations(ts);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  content,
  content='observations',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO observations_fts(rowid, content) VALUES (new.id, new.content);
END;

INSERT OR IGNORE INTO schema_version(version) VALUES (2);
`

export interface CaveMemOptions {
	dataDir?: string
	mode?: CavemanMode
}

interface CaveMemSearchRow {
	id: number
	session_id: string
	kind: string
	content: string
	intensity: string | null
	ts: number
	metadata: string | null
	snippet: string
	score: number
}

export function startCaveMemSession(sessionID: string, cwd: string, options: CaveMemOptions = {}): void {
	if (!sessionID) return
	withCaveMemDb(options, db => {
		const resolvedCwd = resolve(cwd)
		db.prepare('INSERT OR IGNORE INTO sessions(id, ide, cwd, started_at, metadata) VALUES (?, ?, ?, ?, ?)').run(
			sessionID,
			'opencode',
			resolvedCwd,
			Date.now(),
			null,
		)
	})
}

export function endCaveMemSession(sessionID: string, options: CaveMemOptions = {}): void {
	if (!sessionID) return
	withCaveMemDb(options, db => {
		db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(Date.now(), sessionID)
	})
}

export function recordCaveMemUserPrompt(
	sessionID: string,
	cwd: string,
	prompt: string,
	options: CaveMemOptions = {},
): void {
	if (!prompt.trim()) return
	insertObservation(sessionID, cwd, 'user_prompt', prompt, undefined, options)
}

export function recordCaveMemToolUse(
	sessionID: string,
	cwd: string,
	toolName: string,
	toolInput: unknown,
	toolOutput: unknown,
	options: CaveMemOptions = {},
): void {
	const body = `${toolName} input=${stringifyShort(toolInput)} output=${stringifyShort(toolOutput)}`.slice(0, 4000)
	if (!body.trim()) return
	insertObservation(sessionID, cwd, 'tool_use', body, { tool: toolName }, options)
}

export function recordCaveMemSessionSummary(
	sessionID: string,
	cwd: string,
	summary: string,
	options: CaveMemOptions = {},
): void {
	if (!summary.trim()) return
	insertObservation(sessionID, cwd, 'session_summary', summary.slice(0, 4000), undefined, options)
}

export function mirrorMemoryNoteToCaveMem(
	cwd: string,
	title: string,
	content: string,
	options: CaveMemOptions = {},
): void {
	const resolvedCwd = resolve(cwd)
	const slug = slugify(title)
	const sessionID = getCaveMemProjectSessionID(resolvedCwd)
	insertObservation(
		sessionID,
		resolvedCwd,
		'memory_note',
		`${title.trim()}\n\n${content.trim()}`,
		{ title: title.trim(), slug, source: 'opencode-harness-memory' },
		options,
	)
}

export function searchCaveMemProject(
	query: string,
	cwd: string,
	maxResults: number = 5,
	options: CaveMemOptions = {},
): Array<MemoryHeader & { score: number }> {
	if (!query.trim()) return []

	return withCaveMemDb(options, db => {
		const resolvedCwd = resolve(cwd)
		const rows = db
			.prepare(
				`SELECT o.id, o.session_id, o.kind, o.content, o.intensity, o.ts, o.metadata,
				        snippet(observations_fts, 0, '[', ']', '...', 16) AS snippet,
				        bm25(observations_fts) AS score
				 FROM observations_fts
				 JOIN observations o ON o.id = observations_fts.rowid
				 JOIN sessions s ON s.id = o.session_id
				 WHERE observations_fts MATCH ? AND s.cwd = ?
				 ORDER BY score ASC, o.ts DESC
				 LIMIT ?`,
			)
			.all(sanitizeMatch(query), resolvedCwd, maxResults * 3) as unknown as CaveMemSearchRow[]

		const deduped = new Map<string, MemoryHeader & { score: number }>()
		for (const row of rows) {
			const metadata = parseJsonObject(row.metadata)
			const title =
				typeof metadata['title'] === 'string' && metadata['title'].trim()
					? metadata['title'].trim()
					: formatKindTitle(row.kind, row.id)
			const uri = `cavemem://${row.session_id}/${row.id}`
			if (deduped.has(uri)) continue
			deduped.set(uri, {
				path: uri,
				title,
				description: row.snippet.replace(/\s+/g, ' ').trim().slice(0, 200),
				memoryType: `cavemem:${row.kind}`,
				bodyPreview: row.content.replace(/\s+/g, ' ').trim().slice(0, 300),
				modifiedAt: row.ts,
				score: -row.score,
			})
		}

		return Array.from(deduped.values())
			.sort((a, b) => b.score - a.score || b.modifiedAt - a.modifiedAt)
			.slice(0, maxResults)
	})
}

export function countCaveMemProjectObservations(cwd: string, options: CaveMemOptions = {}): number {
	return withCaveMemDb(options, db => {
		const row = db
			.prepare(
				'SELECT COUNT(*) AS count FROM observations o JOIN sessions s ON s.id = o.session_id WHERE s.cwd = ?',
			)
			.get(resolve(cwd)) as { count: number }
		return row.count
	})
}

function insertObservation(
	sessionID: string,
	cwd: string,
	kind: string,
	content: string,
	metadata: Record<string, unknown> | undefined,
	options: CaveMemOptions,
): void {
	if (!sessionID || !content.trim()) return
	withCaveMemDb(options, db => {
		const resolvedCwd = resolve(cwd)
		db.prepare('INSERT OR IGNORE INTO sessions(id, ide, cwd, started_at, metadata) VALUES (?, ?, ?, ?, ?)').run(
			sessionID,
			'opencode',
			resolvedCwd,
			Date.now(),
			null,
		)
		const mode = options.mode ?? 'full'
		const compressed = compressForCaveman(content, mode)
		db.prepare(
			'INSERT INTO observations(session_id, kind, content, compressed, intensity, ts, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
		).run(sessionID, kind, compressed, 1, mode, Date.now(), metadata ? JSON.stringify(metadata) : null)
	})
}

function withCaveMemDb<T>(options: CaveMemOptions, fn: (db: SqliteDatabase) => T): T {
	const dbPath = getCaveMemDbPath(options.dataDir)
	mkdirSync(dirname(dbPath), { recursive: true })
	const db = SQLITE.open(dbPath)
	try {
		db.exec(SCHEMA_SQL)
		return fn(db)
	} finally {
		db.close()
	}
}

async function loadSqliteAdapter(): Promise<SqliteAdapter> {
	try {
		const mod = await import('node:sqlite')
		const DatabaseSync = mod.DatabaseSync
		return {
			open(path: string): SqliteDatabase {
				const db = new DatabaseSync(path)
				return {
					exec(sql) {
						db.exec(sql)
					},
					prepare(sql) {
						const statement = db.prepare(sql)
						return {
							run(...params) {
								return statement.run(...(params as any[]))
							},
							get(...params) {
								return (
									(statement.get(...(params as any[])) as Record<string, unknown> | undefined) ??
									undefined
								)
							},
							all(...params) {
								return statement.all(...(params as any[])) as Record<string, unknown>[]
							},
						}
					},
					close() {
						db.close()
					},
				}
			},
		}
	} catch {
		const mod = await import('bun:sqlite')
		const Database = mod.Database
		return {
			open(path: string): SqliteDatabase {
				const db = new Database(path)
				return {
					exec(sql) {
						db.run(sql)
					},
					prepare(sql) {
						const query = db.query(sql)
						return {
							run(...params) {
								return query.run(...(params as any[]))
							},
							get(...params) {
								return (
									(query.get(...(params as any[])) as Record<string, unknown> | undefined) ??
									undefined
								)
							},
							all(...params) {
								return query.all(...(params as any[])) as Record<string, unknown>[]
							},
						}
					},
					close() {
						db.close()
					},
				}
			},
		}
	}
}

function getCaveMemDbPath(explicitDataDir?: string): string {
	return join(resolveCaveMemDataDir(explicitDataDir), 'data.db')
}

function resolveCaveMemDataDir(explicitDataDir?: string): string {
	if (explicitDataDir?.trim()) return resolvePath(explicitDataDir)

	const settingsPath = join(homedir(), '.cavemem', 'settings.json')
	if (existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
			if (typeof parsed['dataDir'] === 'string' && parsed['dataDir'].trim()) {
				return resolvePath(parsed['dataDir'])
			}
		} catch {
			// ignore malformed settings and fall back to default data dir
		}
	}

	return join(homedir(), '.cavemem')
}

function resolvePath(path: string): string {
	if (path === '~') return homedir()
	if (path.startsWith('~/')) return join(homedir(), path.slice(2))
	return resolve(path)
}

function sanitizeMatch(q: string): string {
	return q
		.split(/\s+/)
		.filter(Boolean)
		.map(token => `"${token.replace(/"/g, '""')}"`)
		.join(' ')
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
	if (!raw) return {}
	try {
		const parsed = JSON.parse(raw)
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
	} catch {
		return {}
	}
}

function formatKindTitle(kind: string, id: number): string {
	if (kind === 'memory_note') return `CaveMem Note ${id}`
	if (kind === 'user_prompt') return `User Prompt ${id}`
	if (kind === 'tool_use') return `Tool Use ${id}`
	if (kind === 'session_summary') return `Session Summary ${id}`
	return `${kind} ${id}`
}

function getCaveMemProjectSessionID(cwd: string): string {
	return `opencode-harness-memory-${sha1(resolve(cwd)).slice(0, 16)}`
}

function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
}

function sha1(input: string): string {
	return createHash('sha1').update(input).digest('hex')
}

function stringifyShort(value: unknown): string {
	if (value == null) return ''
	if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}...` : value
	if (
		typeof value === 'object' &&
		value &&
		'output' in value &&
		typeof (value as Record<string, unknown>)['output'] === 'string'
	) {
		const text = String((value as Record<string, unknown>)['output'])
		return text.length > 500 ? `${text.slice(0, 500)}...` : text
	}
	try {
		const serialized = JSON.stringify(value)
		return serialized.length > 500 ? `${serialized.slice(0, 500)}...` : serialized
	} catch {
		return String(value)
	}
}
