import { tool, type ToolDefinition } from '@opencode-ai/plugin'
import { listMemoryFiles, readMemoryFile, writeMemoryFile, deleteMemoryFile } from './manager.js'
import type { MemoryHeader } from './scan.js'
import { findRelevantMemories, findRelevantProjectMemories } from './search.js'
import { getMemoryEntrypoint } from './paths.js'
import { readFileText, fileExists } from '../shared/fs.js'
import { mirrorMemoryNoteToCaveMem, type CaveMemOptions } from './cavemem.js'
import type { CavemanMode } from '../context/caveman.js'

const z = tool.schema

export interface MemoryToolOptions {
	cavemem?: {
		enabled: boolean
		dataDir?: string
		defaultLimit?: number
		searchAlpha?: number
		embeddingProvider?: string
		resolveMode?: (sessionID?: string) => CavemanMode
		resolveOptions?: (sessionID?: string) => CaveMemOptions
	}
	searchProjectMemories?: (input: {
		query: string
		directory: string
		sessionID?: string
		limit: number
	}) => Promise<MemoryHeader[]>
}

export function createMemoryTools(options: MemoryToolOptions = {}): Record<string, ToolDefinition> {
	return {
		openharness_memory_list: tool({
			description: 'List all persistent memory files for the current project (OpenHarness compatible).',
			args: {},
			async execute(_args, ctx) {
				const files = listMemoryFiles(ctx.directory)
				if (!files.length) return 'No memory files found.'
				return files.map(f => f.split('/').pop()).join('\n')
			},
		}),
		openharness_memory_read: tool({
			description: 'Read the content of a specific persistent memory file by name (OpenHarness compatible).',
			args: {
				name: z.string().describe('Name of the memory file (with or without .md extension)'),
			},
			async execute(args, ctx) {
				const files = listMemoryFiles(ctx.directory)
				const match = files.find(f => f.endsWith(`/${args.name}`) || f.endsWith(`/${args.name}.md`))
				if (!match) return `Memory file '${args.name}' not found.`
				const content = readMemoryFile(match)
				return content ?? `Failed to read memory file '${args.name}'.`
			},
		}),
		openharness_memory_search: tool({
			description: 'Search persistent memory files for content relevant to a query (OpenHarness compatible).',
			args: {
				query: z.string().describe('Search query to find relevant memory entries'),
				limit: z.number().optional().describe('Optional result limit'),
			},
			async execute(args, ctx) {
				const cavememOptions = options.cavemem?.resolveOptions?.(ctx.sessionID) ?? {}
				const limit = args.limit ?? options.cavemem?.defaultLimit ?? 5
				const results = options.searchProjectMemories
					? await options.searchProjectMemories({
							query: args.query,
							directory: ctx.directory,
							sessionID: ctx.sessionID,
							limit,
						})
					: options.cavemem?.enabled
						? findRelevantProjectMemories(args.query, ctx.directory, limit, {
								includeCavemem: true,
								cavememDataDir: cavememOptions.dataDir ?? options.cavemem.dataDir,
								searchAlpha: options.cavemem.searchAlpha,
								embeddingProvider:
									cavememOptions.embeddingProvider ?? options.cavemem.embeddingProvider,
								defaultLimit: limit,
							})
						: findRelevantMemories(args.query, ctx.directory, limit)
				if (!results.length) return 'No relevant memories found.'

				const lines = results.map(h => {
					const name = h.path.startsWith('cavemem://') ? h.path : h.path.split('/').pop()
					return `## ${h.title} (${name})\n${h.description}`
				})
				return lines.join('\n\n')
			},
		}),
		openharness_memory_write: tool({
			description: 'Create or update a persistent memory file for the current project (OpenHarness compatible).',
			args: {
				title: z.string().describe('Title for the memory entry'),
				content: z.string().describe('Markdown content to store'),
			},
			async execute(args, ctx) {
				const path = writeMemoryFile(ctx.directory, args.title, args.content)
				if (options.cavemem?.enabled) {
					const resolved = options.cavemem.resolveOptions?.(ctx.sessionID) ?? {}
					const mode = resolved.mode ?? options.cavemem.resolveMode?.(ctx.sessionID) ?? 'full'
					mirrorMemoryNoteToCaveMem(ctx.directory, args.title, args.content, {
						...resolved,
						dataDir: resolved.dataDir ?? options.cavemem.dataDir,
						mode,
					})
					return `Memory written to ${path.split('/').pop()} and mirrored to CaveMem`
				}
				return `Memory written to ${path.split('/').pop()}`
			},
		}),
		openharness_memory_delete: tool({
			description: 'Delete a persistent memory file by name (OpenHarness compatible).',
			args: {
				name: z.string().describe('Name of the memory file to delete'),
			},
			async execute(args, ctx) {
				const ok = deleteMemoryFile(ctx.directory, args.name)
				return ok ? `Memory file '${args.name}' deleted.` : `Memory file '${args.name}' not found.`
			},
		}),
		openharness_memory_index: tool({
			description: 'Read the MEMORY.md index file for the current project (OpenHarness compatible).',
			args: {},
			async execute(_args, ctx) {
				const entrypoint = getMemoryEntrypoint(ctx.directory)
				if (!fileExists(entrypoint)) return 'MEMORY.md does not exist yet.'
				const content = readFileText(entrypoint)
				return content ?? 'Failed to read MEMORY.md.'
			},
		}),
	}
}

const defaultTools = createMemoryTools()

export const memoryListTool: ToolDefinition = defaultTools.openharness_memory_list
export const memoryReadTool: ToolDefinition = defaultTools.openharness_memory_read
export const memorySearchTool: ToolDefinition = defaultTools.openharness_memory_search
export const memoryWriteTool: ToolDefinition = defaultTools.openharness_memory_write
export const memoryDeleteTool: ToolDefinition = defaultTools.openharness_memory_delete
export const memoryIndexTool: ToolDefinition = defaultTools.openharness_memory_index
