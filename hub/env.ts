// Imported first: drop Claude/Anthropic vars inherited from whatever launched the hub (e.g. a Claude Code session),
// otherwise child agents think they are nested sessions (no transcripts, wrong endpoint, hooks off).
for (const k of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC_|MCP_|OTEL_)/i.test(k) && k !== 'CLAUDE_CONFIG_DIR') delete process.env[k];
