# ai-chat games

Each `.txt` file in this directory is a game prompt loaded on demand by the `!ai play <name>` command. The file contents become the session's system prompt.

## Adding a game

1. Create `<name>.txt` in this directory.
2. Write the system prompt for the game — include rules, tone, scoring, and an opening line.
3. Reload the plugin: `.reload ai-chat`.

Users can then play via `!ai play <name>`.

## Shipped games

- `20questions.txt` — bot picks a thing; player asks yes/no questions.
- `trivia.txt` — bot asks questions, tracks score and streak.
