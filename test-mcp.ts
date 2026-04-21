import "dotenv/config";
import { spawn } from "child_process";

const SPACE_NAME = process.env.ANYTYPE_SPACE_NAME ?? "";
const API_KEY = process.env.ANYTYPE_API_KEY ?? "";
const ANYTYPE_VERSION = "2025-11-08";

async function main() {
  console.log(`\n🔌 Test connexion Anytype MCP (stdio)`);
  console.log(`   Space : ${SPACE_NAME}`);
  console.log(`   Key   : ${API_KEY.slice(0, 8)}...\n`);

  const headers = JSON.stringify({
    Authorization: `Bearer ${API_KEY}`,
    "Anytype-Version": ANYTYPE_VERSION,
  });

  const proc = spawn("npx", ["-y", "@anyproto/anytype-mcp"], {
    env: { ...process.env, OPENAPI_MCP_HEADERS: headers },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as { id: number; result?: unknown; error?: { message: string } };
        const handler = pending.get(msg.id);
        if (!handler) continue;
        pending.delete(msg.id);
        if (msg.error) handler.reject(new Error(msg.error.message));
        else handler.resolve(msg.result);
      } catch { /* ignore */ }
    }
  });

  proc.stderr!.on("data", () => {});

  function rpc(method: string, params: unknown): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async function call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = (await rpc("tools/call", { name: tool, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
    };
    const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
    return JSON.parse(text) as T;
  }

  try {
    // 1. Init
    console.log("1️⃣  initialize...");
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0.1" },
    });
    console.log("   ✓ MCP prêt\n");

    // 2. Liste des espaces
    console.log("2️⃣  API-list-spaces...");
    const spaces = await call<{ data: Array<{ id: string; name: string }> }>("API-list-spaces");
    console.log(`   ✓ ${spaces.data.length} espace(s) :`);
    for (const s of spaces.data) console.log(`     - "${s.name}" (${s.id})`);

    // 3. Résolution de l'espace cible
    console.log(`\n3️⃣  Résolution de l'espace "${SPACE_NAME}"...`);
    const space = spaces.data.find((s) => s.name === SPACE_NAME) ?? spaces.data[0];
    if (!space) throw new Error("Aucun espace disponible.");
    if (space.name !== SPACE_NAME)
      console.log(`   ⚠  Fallback sur "${space.name}"`);
    else
      console.log(`   ✓ Espace trouvé : "${space.name}" (${space.id})`);

    console.log("\n✅ Connexion MCP Anytype OK\n");
  } finally {
    proc.stdin!.end();
    proc.kill();
  }
}

main().catch((err) => {
  console.error("\n✗ Échec :", err.message);
  process.exit(1);
});
