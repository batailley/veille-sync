import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readdir, readFile, writeFile, stat, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const API_PORT = 3004;
const CLIPPINGS_DIR = process.env.CLIPPINGS_DIR ?? "";
const DATA_DIR = join(__dirname, "data");
const STATE_FILE = join(DATA_DIR, "state.json");

// ─── Types ────────────────────────────────────────────────────────────────────

type FileStatus = "pending" | "processing" | "done" | "error";

interface FileState {
  status: FileStatus;
  model: string | null;
  processedAt: string | null;
  error: string | null;
}

interface AppState {
  files: Record<string, FileState>;
}

// ─── State ────────────────────────────────────────────────────────────────────

async function readState(): Promise<AppState> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf-8")) as AppState;
  } catch {
    return { files: {} };
  }
}

async function saveState(state: AppState): Promise<void> {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// Reset files stuck as "processing" from a previous run
async function resetStaleProcessing(): Promise<void> {
  const state = await readState();
  let changed = false;
  for (const [name, file] of Object.entries(state.files)) {
    if (file.status === "processing") {
      state.files[name] = { ...file, status: "error", error: "Interrompu par redémarrage du serveur" };
      changed = true;
    }
  }
  if (changed) await saveState(state);
}

// ─── Files ────────────────────────────────────────────────────────────────────

async function getFiles(): Promise<unknown[]> {
  if (!CLIPPINGS_DIR) throw new Error("CLIPPINGS_DIR non défini dans .env");

  const [entries, state] = await Promise.all([
    readdir(CLIPPINGS_DIR, { withFileTypes: true }),
    readState(),
  ]);

  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
    .map((e) => e.name);

  const withStats = await Promise.all(
    mdFiles.map(async (name) => {
      const s = await stat(join(CLIPPINGS_DIR, name));
      const fileState: FileState = state.files[name] ?? {
        status: "pending",
        model: null,
        processedAt: null,
        error: null,
      };
      return { name, size: s.size, modifiedAt: s.mtime.toISOString(), ...fileState };
    })
  );

  return withStats.sort(
    (a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
  );
}

// ─── Processing queue ─────────────────────────────────────────────────────────

const queue: { file: string; model: string }[] = [];
let running = false;

function drain(): void {
  if (running || queue.length === 0) return;
  running = true;

  const { file, model } = queue.shift()!;
  const stderrChunks: string[] = [];

  const proc = spawn(
    "tsx",
    ["process.ts", "--file", file, "--provider", model],
    { cwd: __dirname, stdio: ["ignore", "inherit", "pipe"] }
  );

  proc.stderr?.on("data", (d: Buffer) => stderrChunks.push(d.toString()));

  proc.on("close", async (code) => {
    const state = await readState();
    if (code === 0) {
      state.files[file] = { status: "done", model, processedAt: new Date().toISOString(), error: null };
    } else {
      const err = stderrChunks.join("").trim().slice(0, 500) || `Processus terminé avec code ${code}`;
      state.files[file] = { status: "error", model, processedAt: null, error: err };
    }
    await saveState(state);
    running = false;
    drain();
  });
}

async function enqueue(files: string[], model: string): Promise<void> {
  const state = await readState();
  for (const file of files) {
    if (queue.some((q) => q.file === file)) continue;
    if (state.files[file]?.status === "processing") continue;
    queue.push({ file, model });
    state.files[file] = { status: "processing", model, processedAt: null, error: null };
  }
  await saveState(state);
  drain();
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.setHeader("Access-Control-Allow-Origin", "http://localhost:3003");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, null, 204);
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${API_PORT}`);

  try {
    if (url.pathname === "/api/files" && req.method === "GET") {
      sendJson(res, await getFiles());
    } else if (url.pathname === "/api/process" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as { files: string[]; model: string };
      await enqueue(body.files, body.model);
      sendJson(res, { queued: body.files.length });
    } else if (url.pathname === "/api/reset" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as { files: string[] };
      const state = await readState();
      for (const file of body.files) {
        state.files[file] = { status: "pending", model: null, processedAt: null, error: null };
      }
      await saveState(state);
      sendJson(res, { reset: body.files.length });
    } else {
      sendJson(res, { error: "Not found" }, 404);
    }
  } catch (err) {
    console.error(err);
    sendJson(res, { error: String(err) }, 500);
  }
});

await resetStaleProcessing();
server.listen(API_PORT, "127.0.0.1", () => {
  console.log(`API server → http://localhost:${API_PORT}`);
  if (!CLIPPINGS_DIR) console.warn("⚠  CLIPPINGS_DIR non défini dans .env");
});
