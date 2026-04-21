import { spawn } from "child_process";
import type { ProcessedArticle } from "./processor.js";

const SPACE_NAME = process.env.ANYTYPE_SPACE_NAME ?? "";
const API_KEY = process.env.ANYTYPE_API_KEY ?? "";
const ANYTYPE_VERSION = "2025-11-08";

// --- Client MCP stdio ---

interface McpResult {
  content: Array<{ type: string; text: string }>;
}

class AnytypeMcpClient {
  private proc: ReturnType<typeof spawn>;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private buffer = "";

  constructor() {
    const headers = JSON.stringify({
      Authorization: `Bearer ${API_KEY}`,
      "Anytype-Version": ANYTYPE_VERSION,
    });

    this.proc = spawn("npx", ["-y", "@anyproto/anytype-mcp"], {
      env: { ...process.env, OPENAPI_MCP_HEADERS: headers },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { id: number; result?: unknown; error?: { message: string } };
          const handler = this.pending.get(msg.id);
          if (!handler) continue;
          this.pending.delete(msg.id);
          if (msg.error) handler.reject(new Error(msg.error.message));
          else handler.resolve(msg.result);
        } catch { /* ligne non-JSON, ignorée */ }
      }
    });

    this.proc.stderr!.on("data", () => {});
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async initialize(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "veille-sync", version: "1.0.0" },
    });
  }

  async call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = (await this.rpc("tools/call", { name: tool, arguments: args })) as McpResult;
    const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
    return JSON.parse(text) as T;
  }

  close(): void {
    this.proc.stdin!.end();
    this.proc.kill();
  }
}

// --- Types réponses Anytype ---

interface AnySpace  { id: string; name: string }
interface AnyObject { id: string; name: string }
interface AnyList<T> { data: T[]; pagination: { total: number } }

// --- Helpers métier ---

async function getSpaceId(client: AnytypeMcpClient): Promise<string> {
  const res = await client.call<AnyList<AnySpace>>("API-list-spaces");
  const space = res.data.find((s) => s.name === SPACE_NAME) ?? res.data[0];
  if (!space) throw new Error("Aucun espace Anytype trouvé.");
  if (space.name !== SPACE_NAME)
    console.log(`  ⚠  Espace "${SPACE_NAME}" introuvable, fallback sur "${space.name}"`);
  return space.id;
}

async function getOrCreateWeekPage(
  client: AnytypeMcpClient,
  spaceId: string,
  week: number,
  year: number
): Promise<string> {
  const pageTitle = `Veille - Semaine ${String(week).padStart(2, "0")} · ${year}`;

  const searchRes = await client.call<AnyList<AnyObject>>("API-search-space", {
    space_id: spaceId,
    query: pageTitle,
    types: ["page"],
    limit: 5,
  });

  const existing = searchRes.data.find((o) => o.name === pageTitle);
  if (existing) {
    console.log(`  ✓ Page semaine existante : "${pageTitle}"`);
    return existing.id;
  }

  const created = await client.call<{ object: AnyObject }>("API-create-object", {
    space_id: spaceId,
    type_key: "page",
    name: pageTitle,
    body: `# ${pageTitle}\n\nArticles de veille de la semaine ${week}.`,
  });

  console.log(`  ✓ Page semaine créée : "${pageTitle}"`);
  return created.object.id;
}

function buildArticleBody(article: ProcessedArticle): string {
  const date = new Date(article.processedAt).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return [
    `# ${article.title}`,
    ``,
    `> **Source :** ${article.sourceUrl || "_non disponible_"}`,
    `> **Ajouté le :** ${date}`,
    ``,
    `---`,
    ``,
    `## Résumé`,
    ``,
    article.summary,
    ``,
    `---`,
    ``,
    `## Contenu de l'article`,
    ``,
    article.cleanedContent,
    ``,
    `---`,
    ``,
    `## Contenu brut original`,
    ``,
    article.originalContent,
  ].join("\n");
}

// --- Point d'entrée principal ---

export async function publishToAnytype(article: ProcessedArticle): Promise<void> {
  console.log(`  → Connexion à Anytype MCP (stdio)...`);
  const client = new AnytypeMcpClient();

  try {
    await client.initialize();

    const spaceId = await getSpaceId(client);
    const weekPageId = await getOrCreateWeekPage(client, spaceId, article.weekNumber, article.year);

    const created = await client.call<{ object: AnyObject }>("API-create-object", {
      space_id: spaceId,
      type_key: "page",
      name: article.title,
      body: buildArticleBody(article),
      properties: [
        ...(article.sourceUrl ? [{ key: "source", url: article.sourceUrl }] : []),
      ],
    });

    console.log(`  ✓ Article publié : "${article.title}" (id: ${created.object.id})`);
    console.log(`  ✓ Page semaine : ${weekPageId}`);
  } finally {
    client.close();
  }
}
