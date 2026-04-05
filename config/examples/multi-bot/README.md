# Multi-bot deployment example

This directory is a reference layout for running several HexBot instances — typically one per (network, role) pair — from a single checkout. Each bot has its own config, plugin overrides, env file, and database.

```
config/examples/multi-bot/
├── libera/
│   ├── hub.json              # channel enforcer on Libera, botlink hub role
│   ├── hub-plugins.json      # plugin overrides for the hub
│   └── hub.env.example       # env template for the hub
└── rizon/
    ├── leaf.json             # helper bot on Rizon, botlink leaf (links to hub)
    ├── leaf-plugins.json
    └── leaf.env.example
```

The nested `config/<network>/<bot-name>.{json,env}` layout is a **convention, not a requirement**. `--config=` and `--env-file=` both accept any path, so you can organize however suits you. This layout scales better than flat `bot.libera.json` / `bot.rizon.json` once you have 3+ bots — everything for one bot sits in a single directory.

## Running the example

Copy the example files into your real config area first (files in `config/examples/**` are shared with the repo; `config/libera/` and `config/rizon/` below are gitignored for your real configs):

```bash
mkdir -p config/libera config/rizon
cp config/examples/multi-bot/libera/hub.json         config/libera/hub.json
cp config/examples/multi-bot/libera/hub-plugins.json config/libera/hub-plugins.json
cp config/examples/multi-bot/libera/hub.env.example  config/libera/hub.env
cp config/examples/multi-bot/rizon/leaf.json         config/rizon/leaf.json
cp config/examples/multi-bot/rizon/leaf-plugins.json config/rizon/leaf-plugins.json
cp config/examples/multi-bot/rizon/leaf.env.example  config/rizon/leaf.env
chmod 600 config/libera/hub.env config/rizon/leaf.env
```

Fill in the env files, update nick / channels / owner hostmask in each `*.json`, then launch each bot with its own env + config:

```bash
tsx --env-file=config/libera/hub.env  src/index.ts --config=config/libera/hub.json
tsx --env-file=config/rizon/leaf.env  src/index.ts --config=config/rizon/leaf.json
```

Each bot writes to its own database (`data/libera-hub.db`, `data/rizon-leaf.db`).

## How the two bots link

The hub bot listens on TCP :5051 for botlink connections. The leaf bot initiates an outbound link to the hub's address. After handshake, they share bans, operator commands, and party-line chat across both networks. See [docs/BOTLINK.md](../../../docs/BOTLINK.md) for the protocol details.

For production, see [docs/multi-instance/docker-compose.yml](../../../docs/multi-instance/docker-compose.yml) for a multi-bot compose setup.
