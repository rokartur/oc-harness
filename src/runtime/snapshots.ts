import { join, relative, resolve } from 'node:path'
import { readFileSync, rmSync } from 'node:fs'
import { ensureDir, listDirEntries, writeFileAtomic } from '../shared/fs.js'

export interface SnapshotPayload {
	absPath: string
	relPath: string
	exists: boolean
	content: string
	timestamp: number
	sessionID: string
}

export class SnapshotManager {
	constructor(private readonly rootDir: string) {}

	capture(cwd: string, sessionID: string, absPath: string): string {
		ensureDir(join(this.rootDir, sessionID))
		const relPath = relative(cwd, absPath)
		let exists = false
		let content = ''
		try {
			content = readFileSync(absPath, 'utf-8')
			exists = true
		} catch {
			exists = false
			content = ''
		}
		const payload: SnapshotPayload = {
			absPath,
			relPath,
			exists,
			content,
			timestamp: Date.now(),
			sessionID,
		}
		const target = join(this.rootDir, sessionID, `${payload.timestamp}-${sanitizePath(relPath)}.json`)
		writeFileAtomic(target, JSON.stringify(payload, null, 2))
		return target
	}

	restoreLatest(cwd: string, filePath: string): SnapshotPayload | null {
		const absPath = resolve(cwd, filePath)
		const relPath = relative(cwd, absPath)
		const tag = sanitizePath(relPath)
		let latest: { file: string; payload: SnapshotPayload } | null = null
		for (const sessionID of listDirEntries(this.rootDir)) {
			const sessionDir = join(this.rootDir, sessionID)
			for (const entry of listDirEntries(sessionDir)) {
				if (!entry.endsWith(`-${tag}.json`)) continue
				try {
					const payload = JSON.parse(readFileSync(join(sessionDir, entry), 'utf-8')) as SnapshotPayload
					if (!latest || payload.timestamp > latest.payload.timestamp)
						latest = { file: join(sessionDir, entry), payload }
				} catch {
					continue
				}
			}
		}
		if (!latest) return null
		if (latest.payload.exists) {
			writeFileAtomic(absPath, latest.payload.content)
		} else {
			rmSync(absPath, { force: true, recursive: true })
		}
		return latest.payload
	}
}

function sanitizePath(value: string): string {
	return value.replace(/[^a-zA-Z0-9_.-]/g, '_')
}
