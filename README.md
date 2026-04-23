# veille-sync

Automated pipeline: Safari web clippings (Markdown files via iCloud) → AI summarization → Anytype notes.

Drop a `.md` file into your Clippings folder and it gets cleaned, summarized in French (translated if needed), and published as a structured page in Anytype — automatically.

---

## How it works

1. **Watch** — a file watcher (chokidar) monitors a local iCloud Clippings folder for new `.md` files
2. **Parse** — extracts title, source URL, description, and body from the Markdown front matter
3. **AI processing** — sends content to an AI model (Gemini 2.5 Flash or Claude Code) which:
   - detects the article language
   - strips ads, navigation, and boilerplate
   - generates a French summary (3–6 sentences)
   - translates to French if the source is not in French
   - forges a clean title
4. **Build** — assembles a structured Markdown page with summary, French article, and optional original
5. **Publish** — creates the page in Anytype via MCP and adds a dated link to a parent index page

### Result in Anytype

```
[VEILLE-AUTO]
├── 12 janvier 2026 — Article title A
├── 15 janvier 2026 — Article title B
└── ...
```

Each article page contains:
- Source URL and date added
- French summary
- Full article (in French)
- Original content (if source was not in French)

### Two ways to trigger processing

| Mode | How |
|------|-----|
| **Manual / UI** | `pnpm studio` — launches a web UI (port 3003) + API server (port 3004) to select files and choose model |
| **Watcher** | `pnpm dev` — runs continuously, processes any `.md` file dropped into the Clippings folder |

---

## Requirements

- **Node.js 18+**
- **pnpm**
- **Anytype Desktop** open on the Mac (the MCP server connects to it locally)
- **Gemini API key** → [aistudio.google.com](https://aistudio.google.com/) (default model)
- **OR Claude Code CLI** installed and authenticated (`claude --version`) for the `--provider claude` option
- **Anytype API key** → Settings → API in Anytype Desktop

---

## Installation

### 1. Clone and install dependencies

```bash
git clone <repo>
cd veille-sync
pnpm install
pnpm ui:install
```

### 2. Configure environment variables

Create a `.env` file at the project root:

```env
CLIPPINGS_DIR=/Users/yourname/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/Clippings
PROCESSED_DIR=/Users/yourname/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/Clippings/_processed

GEMINI_API_KEY=your-gemini-api-key

ANYTYPE_API_KEY=your-anytype-api-key
ANYTYPE_SPACE_NAME=My Space
ANYTYPE_VEILLE_PAGE_ID=the-id-of-your-index-page
```

To find `ANYTYPE_VEILLE_PAGE_ID`: open the target page in Anytype → copy link → the object ID is in the URL.

### 3. Install the Anytype MCP server

```bash
npm install -g @anytype/mcp-server
```

Test it:
```bash
anytype-mcp
# Should print: MCP server listening on port 31009
```

---

## Usage

### Web UI (recommended)

```bash
pnpm studio
```

Opens the UI at `http://localhost:3003`. Select files, pick the AI model, and click Process.

### Process a specific file from the command line

```bash
pnpm process --file "article-name.md"
# or with Claude Code as the AI provider:
pnpm process:claude --file "article-name.md"
```

### Run the file watcher (processes files automatically on drop)

```bash
pnpm dev
```

---

## Auto-start on login (macOS launchd)

### 1. Check your node path

```bash
which node
# e.g. /opt/homebrew/bin/node  (Apple Silicon)
```

Update the path in `com.laurent.veille-sync.plist` if it differs from `/usr/local/bin/node`.

### 2. Create the logs folder

```bash
mkdir -p /Users/laurent/www/veille-sync/logs
```

### 3. Install the service

```bash
cp com.laurent.veille-sync.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.laurent.veille-sync.plist
launchctl list | grep veille   # should show a PID
```

### Manage the service

```bash
# Stop
launchctl unload ~/Library/LaunchAgents/com.laurent.veille-sync.plist

# Restart
launchctl unload ~/Library/LaunchAgents/com.laurent.veille-sync.plist
launchctl load ~/Library/LaunchAgents/com.laurent.veille-sync.plist

# Live logs
tail -f /Users/laurent/www/veille-sync/logs/veille-sync.log
tail -f /Users/laurent/www/veille-sync/logs/veille-sync-error.log
```

---

## Troubleshooting

**Anytype MCP not responding**
→ Make sure Anytype Desktop is open
→ Test: `curl http://localhost:31009/rpc`

**Files not processed**
→ Check `CLIPPINGS_DIR` in `.env` — must be the exact path
→ Check logs: `tail -f logs/veille-sync-error.log`

**Gemini API error**
→ Verify `GEMINI_API_KEY` in `.env`

**Claude provider fails**
→ Verify Claude Code CLI is installed: `claude --version`
→ Make sure it is authenticated
