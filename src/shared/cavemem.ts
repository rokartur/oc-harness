import { spawnSync } from 'node:child_process'
import type { Config } from '@opencode-ai/plugin'

export function isCavememAvailable(binary: string): boolean {
	try {
		const result = spawnSync(binary, ['--version'], { stdio: 'ignore' })
		return result.status === 0
	} catch {
		return false
	}
}

export function injectCavememMcp(config: Config, binary: string): boolean {
	if (!config.mcp) config.mcp = {}
	const mcp = config.mcp as Record<string, unknown>
	if (mcp['cavemem']) return false

	mcp['cavemem'] = {
		type: 'stdio',
		command: binary,
		args: ['mcp'],
	}

	return true
}
