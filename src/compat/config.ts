import type { Config } from '@opencode-ai/plugin'
import type { LoadedCompatPlugin, PluginDiagnostic } from '../shared/types.js'

const BUILTIN_COMMANDS: Record<string, { template: string; description: string }> = {
	caveman: {
		description: 'Switch Caveman mode: full, lite, or ultra',
		template: [
			'Activate caveman mode for this session.',
			'If `$ARGUMENTS` is `lite`, use lite mode. If `$ARGUMENTS` is `ultra`, use ultra mode. Otherwise use full mode.',
			'Keep this mode active every response until the user says `stop caveman` or `normal mode`.',
		].join(' '),
	},
	'caveman-help': {
		description: 'Show Caveman modes and commands',
		template: [
			'Display a quick Caveman help card.',
			'Include modes: lite, full, ultra.',
			'Include commands: `/caveman`, `/caveman-help`, `/caveman-commit`, `/caveman-review`.',
			'Explain that `full` is default, `/caveman ultra` switches intensity, and `stop caveman` or `normal mode` disables it for the session.',
			'One-shot help only. Do not change the current mode unless the user explicitly asked to switch mode.',
			'Write the help card in terse Caveman style.',
		].join(' '),
	},
	'caveman-commit': {
		description: 'Generate terse Conventional Commit message',
		template: [
			'Write a terse Conventional Commit message for the current changes.',
			'Use format `<type>(<scope>): <imperative summary>` with optional scope.',
			'Subject should be <=50 chars when possible, never over 72, no trailing period.',
			'Prefer why over what. Add body only when the why is not obvious, for breaking changes, migrations, or security context.',
			'Do not run git commands. Only output the commit message in a fenced code block ready to paste.',
		].join(' '),
	},
	'caveman-review': {
		description: 'Generate terse code review comments',
		template: [
			'Review the current diff or code under discussion with terse, actionable comments.',
			'Write one line per finding in format `L<line>: <problem>. <fix>.` or `<file>:L<line>: ...` for multi-file context.',
			'Use severity prefixes when helpful: `🔴 bug:`, `🟡 risk:`, `🔵 nit:`, `❓ q:`.',
			'No throat-clearing, no praise padding, no hedging. Keep exact symbol names and concrete fixes.',
			'Output comments only, ready to paste into a PR review.',
		].join(' '),
	},
}

export function injectIntoConfig(
	config: Config,
	plugins: LoadedCompatPlugin[],
	enabledOnly: boolean = true,
): PluginDiagnostic[] {
	const diagnostics: PluginDiagnostic[] = []
	injectBuiltInCommands(config)

	const active = enabledOnly ? plugins.filter(p => p.enabled) : plugins

	for (const plugin of active) {
		for (const cmd of plugin.commands) {
			const key = sanitizeCommandName(cmd.name)
			if (!config.command) config.command = {}
			if (config.command![key]) {
				diagnostics.push({
					level: 'warn',
					pluginName: plugin.manifest.name,
					message: `Command '${key}' already exists, skipping`,
				})
				continue
			}
			config.command![key] = {
				template: cmd.template,
				description: cmd.description,
				...(cmd.model ? { model: cmd.model } : {}),
				...(cmd.agent ? { agent: cmd.agent } : {}),
			}
		}

		for (const agent of plugin.agents) {
			const key = sanitizeAgentName(agent.name)
			if (!config.agent) config.agent = {}
			if (config.agent![key]) {
				diagnostics.push({
					level: 'warn',
					pluginName: plugin.manifest.name,
					message: `Agent '${key}' already exists, skipping`,
				})
				continue
			}
			config.agent![key] = {
				description: agent.description,
				prompt: agent.prompt,
				mode: agent.mode,
				...(agent.model ? { model: agent.model } : {}),
				...(agent.color ? { color: agent.color } : {}),
				...(agent.temperature != null ? { temperature: agent.temperature } : {}),
				...(agent.steps ? { steps: agent.steps } : {}),
			}
		}

		if (Object.keys(plugin.mcpServers).length > 0) {
			if (!config.mcp) config.mcp = {}
			for (const [name, server] of Object.entries(plugin.mcpServers)) {
				const key = `${plugin.manifest.name}__${name}`
				if ((config.mcp as Record<string, unknown>)![key]) {
					diagnostics.push({
						level: 'warn',
						pluginName: plugin.manifest.name,
						message: `MCP server '${key}' already exists, skipping`,
					})
					continue
				}
				;(config.mcp as Record<string, unknown>)![key] = server
			}
		}
	}

	return diagnostics
}

function injectBuiltInCommands(config: Config): void {
	if (!config.command) config.command = {}

	for (const [name, command] of Object.entries(BUILTIN_COMMANDS)) {
		if (config.command[name]) continue
		config.command[name] = command
	}
}

function sanitizeCommandName(name: string): string {
	return name.replace(/:/g, '-').toLowerCase()
}

function sanitizeAgentName(name: string): string {
	return name.replace(/:/g, '-').toLowerCase()
}
