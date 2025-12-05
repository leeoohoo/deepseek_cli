# Deepseek CLI – Sub-Agent Architecture

This repository extends `model-cli-js` with a Claude Agents–style sub-agent system inspired by [wshobson/agents](https://github.com/wshobson/agents). It lets the primary assistant install domain plugins, activate specialized agents (architecture, delivery, infra…), and run them automatically through MCP tools such as `invoke_sub_agent`.

## Repository Layout

```
.
├── src/
│   ├── index.js                 # Chat loop, slash commands, MCP tool printers
│   ├── subagents/               # Sub-agent manager runtime + helpers
│   │   ├── index.js             # marketplace loader, install state, prompt builder
│   │   └── runtime.js           # exposes manager/client to MCP tools
│   ├── tools/builtin.js         # Built-in tools incl. invoke_sub_agent
│   └── …                        # Existing CLI modules (config, session, MCP, etc.)
├── subagents/
│   ├── marketplace.json         # List of available plugins (Claude marketplace equivalent)
│   └── plugins/
│       └── python-development/  # Example plugin (agents + skills + manifest)
└── …
```

## Getting Started

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Run the CLI**
   ```bash
   node src/index.js chat
   ```

3. **Add plugins** through slash commands (see below). Plugins define their own agents/skills and are only loaded when installed, keeping token usage minimal.

## Sub-Agent Workflow

The sub-agent framework mirrors the Claude marketplace:

1. **Marketplace (`subagents/marketplace.json`)** advertises plugins. Each entry specifies `id`, `name`, `category`, `description`.
2. **Plugins (`subagents/plugins/<plugin-id>/plugin.json`)** describe:
   - `agents`: list of domain experts with metadata (id, name, description, model, system prompt path, default skills, allowed skills).
   - `skills`: knowledge packs with instructions (follow progressive disclosure—metadata + instructions file).
3. **Agent/Skill Files** live under `agents/*.md` and `skills/*.md`, keeping instructions modular and human-editable.

### Installing & Managing Plugins

Within the chat session:

```
/sub marketplace                 # List available plugins
/sub install python-development  # Install a plugin
/sub uninstall python-development
/sub agents                      # List installed agents + skills
/sub run python-architect 设计新的API --skills async-patterns
```

Installed plugin IDs are stored in `~/.deepseek_cli/subagents.json`. You can check the structure or add more plugins by editing `subagents/plugins/…`.

### Automatic Invocation (MCP Tool)

Besides manual `/sub run`, the assistant can call the `invoke_sub_agent` tool:

```json
{
  "tool": "invoke_sub_agent",
  "arguments": {
    "task": "为现有 FastAPI 服务设计异步任务调度方案",
    "skills": ["async-patterns"],
    "category": "python"
  }
}
```

This tool will:

1. Access the shared `SubAgentManager` context (injected by `chatLoop`).
2. Select the best agent (explicit `agent_id` > category match > highest skill overlap).
3. Build a scoped system prompt by concatenating the agent prompt + skill instructions.
4. Spawn a dedicated `ChatSession`, invoke the target model (agent-specific or current), and return the result along with the skills that were activated.

### Extending the Marketplace

To add a new plugin:

1. Create `subagents/plugins/<plugin-id>/plugin.json` referencing `agents/*.md` and `skills/*.md`.
2. Add a marketplace entry in `subagents/marketplace.json`.
3. Each agent should list `defaultSkills`, `skills`, and (optional) `model`. If `model` is omitted, the current chat model is used.
4. Skills follow progressive disclosure: metadata in `plugin.json` and the full instruction text in `skills/<skill>.md`.

Refer to `python-development` for a working example with:

- `python-architect` (model `deepseek_reasoner`, skills `async-patterns`, `python-testing`).
- `python-delivery` (model `deepseek_chat`, default skill `python-testing`).

## MCP Tools Overview

| Tool                  | Description                                          |
|-----------------------|------------------------------------------------------|
| `get_current_time`    | Returns ISO timestamp.                               |
| `echo_text`           | Echo utility.                                        |
| `invoke_sub_agent`    | Auto-selects and runs a sub-agent (new).             |

Use `/tool` to review past outputs (`/tool`, `/tool T3` etc.).

## Configuration Notes

- **Default prompt** (`src/index.js`) reminds the primary assistant to invoke `invoke_sub_agent` when specialized expertise is needed.
- **Persistence**: sub-agent installations stored at `~/.deepseek_cli/subagents.json`; marketplace/plugins ship with repo and can be customized per project.
- **MCP Tools**: sub-agents inherit current tool config; to limit tools per agent, extend `SubAgentManager` to interpret optional `tools` definitions per plugin.

## Future Enhancements

- Support plugin-specific tool lists or custom client configs.
- Allow skill metadata to expose activation criteria (auto-trigger when certain keywords appear).
- Add tests around `SubAgentManager` and `invoke_sub_agent`.

## License

MIT (same as the base project). Refer to `LICENSE` for details.
