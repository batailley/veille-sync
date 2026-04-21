import type { ProcessedArticle } from "./processor.js";

const MCP_URL = process.env.ANYTYPE_MCP_URL ?? "http://localhost:31009";
const SPACE_NAME = process.env.ANYTYPE_SPACE_NAME ?? "Mon espace";

// --- Helpers bas niveau ---

async function mcpCall(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

  const res = await fetch(`${MCP_URL}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`MCP error: ${json.error.message}`);
  return json.result;
}

// --- Résolution de l'espace ---

async function getSpaceId(): Promise<string> {
  const result = (await mcpCall("space_list")) as { spaces: Array<{ id: string; name: string }> };
  const space = result.spaces.find((s) => s.name === SPACE_NAME) ?? result.spaces[0];
  if (!space) throw new Error("Aucun espace Anytype trouvé. Anytype Desktop est-il ouvert ?");
  return space.id;
}

// --- Trouver ou créer la page "Veille - Semaine XX" ---

async function getOrCreateWeekPage(
  spaceId: string,
  week: number,
  year: number
): Promise<string> {
  const pageTitle = `Veille - Semaine ${String(week).padStart(2, "0")} · ${year}`;

  // Chercher si la page existe déjà
  const searchResult = (await mcpCall("object_search", {
    spaceId,
    query: pageTitle,
    types: ["page"],
    limit: 5,
  })) as { objects: Array<{ id: string; name: string }> };

  const existing = searchResult.objects.find((o) => o.name === pageTitle);
  if (existing) {
    console.log(`  ✓ Page semaine existante trouvée : "${pageTitle}"`);
    return existing.id;
  }

  // Créer la page parent
  const created = (await mcpCall("object_create", {
    spaceId,
    name: pageTitle,
    type: "page",
    body: `# ${pageTitle}\n\nArticles de veille de la semaine ${week}.`,
  })) as { object: { id: string } };

  console.log(`  ✓ Page semaine créée : "${pageTitle}"`);
  return created.object.id;
}

// --- Créer la sous-page article ---

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
    `<details>`,
    `<summary>Contenu brut original</summary>`,
    ``,
    article.originalContent,
    ``,
    `</details>`,
  ].join("\n");
}

// --- Point d'entrée principal ---

export async function publishToAnytype(article: ProcessedArticle): Promise<void> {
  console.log(`  → Connexion à Anytype MCP (${MCP_URL})...`);

  const spaceId = await getSpaceId();
  const weekPageId = await getOrCreateWeekPage(spaceId, article.weekNumber, article.year);

  const subPageTitle = article.title;
  const body = buildArticleBody(article);

  const result = (await mcpCall("object_create", {
    spaceId,
    parentId: weekPageId,
    name: subPageTitle,
    type: "page",
    body,
  })) as { object: { id: string } };

  console.log(`  ✓ Sous-page créée : "${subPageTitle}" (id: ${result.object.id})`);
}
