import { statSync } from 'node:fs'
import { join } from 'node:path'
import { readFileText, fileExists, dirExists, listDirEntries } from '../shared/fs.js'
import { MAX_CHARS_PER_FILE, MAX_CONTEXT_FILE_BYTES } from '../shared/limits.js'

export interface ExtraContext {
	label: string
	content: string
	source: string
}

export interface ExtraContextOptions {
	issue?: boolean
	prComments?: boolean
	activeRepo?: boolean
}

export interface RootContextOptions {
	claudeMd?: boolean
	agentsMd?: boolean
	spec?: boolean
}

export function discoverExtraContext(cwd: string, options: ExtraContextOptions = {}): ExtraContext[] {
	const contexts: ExtraContext[] = []

	const sources: Array<{ enabled: boolean; path: string; label: string }> = [
		{
			enabled: options.issue !== false,
			path: join(cwd, '.openharness', 'issue.md'),
			label: 'Issue Context',
		},
		{
			enabled: options.prComments !== false,
			path: join(cwd, '.openharness', 'pr_comments.md'),
			label: 'Pull Request Comments',
		},
		{
			enabled: options.activeRepo !== false,
			path: join(cwd, '.openharness', 'autopilot', 'active_repo_context.md'),
			label: 'Active Repo Context',
		},
	]

	for (const { enabled, path, label } of sources) {
		if (!enabled) continue
		const content = loadSafeContextFile(path, label)
		if (content && content.trim()) {
			contexts.push({
				label,
				content,
				source: path,
			})
		}
	}

	return contexts
}

export function discoverClaudeRules(cwd: string): ExtraContext[] {
	const contexts: ExtraContext[] = []
	const rulesDir = join(cwd, '.claude', 'rules')

	if (!dirExists(rulesDir)) return contexts

	for (const entry of listDirEntries(rulesDir)) {
		if (!entry.toLowerCase().endsWith('.md')) continue
		const full = join(rulesDir, entry)
		const content = loadSafeContextFile(full, `Rule: ${entry}`)
		if (content && content.trim()) {
			contexts.push({
				label: `Rule: ${entry}`,
				content,
				source: full,
			})
		}
	}

	return contexts
}

export function discoverRootContext(cwd: string, options: RootContextOptions = {}): ExtraContext[] {
	const contexts: ExtraContext[] = []

	const sources: Array<{ enabled: boolean; path: string; label: string }> = [
		{
			enabled: options.claudeMd !== false,
			path: join(cwd, 'CLAUDE.md'),
			label: 'CLAUDE.md',
		},
		{
			enabled: options.agentsMd !== false,
			path: join(cwd, 'AGENTS.md'),
			label: 'AGENTS.md',
		},
		{
			enabled: options.spec !== false,
			path: join(cwd, 'SPEC.md'),
			label: 'CaveKit Spec',
		},
	]

	for (const { enabled, path, label } of sources) {
		if (!enabled) continue
		const content = loadSafeContextFile(path, label)
		if (content && content.trim()) {
			contexts.push({
				label,
				content,
				source: path,
			})
		}
	}

	return contexts
}

function loadSafeContextFile(path: string, label: string): string | null {
	if (!fileExists(path)) return null
	try {
		const stat = statSync(path)
		if (!stat.isFile()) return null
		if (stat.size > MAX_CONTEXT_FILE_BYTES) {
			return `[context omitted: ${label} too large (${stat.size} bytes, limit ${MAX_CONTEXT_FILE_BYTES})]`
		}
	} catch {
		return null
	}

	const content = readFileText(path)
	if (!content) return null
	const trimmed = content.trim()
	if (!trimmed) return null
	if (trimmed.length <= MAX_CHARS_PER_FILE) return trimmed
	return `${trimmed.slice(0, MAX_CHARS_PER_FILE)}\n[...truncated context]`
}
