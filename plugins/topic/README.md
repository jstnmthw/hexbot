# topic plugin

Sets channel topics using pre-built IRC color theme borders. Ships with 22 built-in themes.

## Commands

| Command                         | Flags | Description                                               |
| ------------------------------- | ----- | --------------------------------------------------------- |
| `!topic <theme> <text>`         | `o`   | Set the channel topic wrapped in the theme's color border |
| `!topic preview <theme> <text>` | `o`   | Preview the themed topic as a channel message             |
| `!topics`                       | `-`   | List all available theme names                            |

## Configuration

`config.json`:

```json
{
  "default_theme": "silverscreen"
}
```

Override in `config/plugins.json`:

```json
{
  "topic": {
    "enabled": true,
    "channels": ["#lobby"],
    "config": {
      "default_theme": "ember"
    }
  }
}
```

## Requirements

The bot must have channel operator status (or the channel must have mode `-t`) to set topics.

## Theme list

amethyst, arctic, arrowhead, baroque, beacon, blaze, charcoal, deepblue, dusk, ember, emerald, filigree, frost, obsidian, orchid, prism, rune, seafoam, silverscreen, sunsetpipeline, tropical, whisper
