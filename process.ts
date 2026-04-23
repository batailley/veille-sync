import "dotenv/config";
import { readdir, readFile, stat } from "fs/promises";
import { spawn } from "child_process";
import { join, basename } from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { AnytypeMcpClient } from "./anytype.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const CLIPPINGS_DIR = process.env.CLIPPINGS_DIR!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const ANYTYPE_API_KEY = process.env.ANYTYPE_API_KEY!;
const ANYTYPE_SPACE_NAME = process.env.ANYTYPE_SPACE_NAME!;
const ANYTYPE_VEILLE_PAGE_ID = process.env.ANYTYPE_VEILLE_PAGE_ID!;
const ANYTYPE_VERSION = "2025-11-08";

type ProviderName = "gemini" | "claude";

function parseArgs(): { provider: ProviderName; fileName: string | null } {
  const provIdx = process.argv.indexOf("--provider");
  const fileIdx = process.argv.indexOf("--file");

  const val = provIdx !== -1 ? process.argv[provIdx + 1] : "gemini";
  if (val !== "gemini" && val !== "claude") {
    console.error(`✗ --provider doit être "gemini" ou "claude" (reçu : "${val}")`);
    process.exit(1);
  }

  const fileName = fileIdx !== -1 ? process.argv[fileIdx + 1] ?? null : null;
  return { provider: val as ProviderName, fileName };
}

function checkEnv(provider: ProviderName) {
  const required: Record<string, string> = {
    CLIPPINGS_DIR,
    ANYTYPE_API_KEY,
    ANYTYPE_SPACE_NAME,
    ANYTYPE_VEILLE_PAGE_ID,
  };
  if (provider === "gemini") required["GEMINI_API_KEY"] = GEMINI_API_KEY;
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`✗ Variables .env manquantes : ${missing.join(", ")}`);
    process.exit(1);
  }
}

// ─── AI providers ─────────────────────────────────────────────────────────────

interface AiProvider {
  label: string;
  generate(prompt: string): Promise<string>;
}

function makeGeminiProvider(): AiProvider {
  const gemini = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = gemini.getGenerativeModel({ model: "gemini-2.5-flash" });
  return {
    label: "Gemini 2.5 Flash",
    async generate(prompt: string): Promise<string> {
      const result = await model.generateContent(prompt);
      return result.response.text();
    },
  };
}

function makeClaudeProvider(): AiProvider {
  return {
    label: "Claude Code (local)",
    generate(prompt: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const proc = spawn("claude", ["--print"], { stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        let err = "";
        proc.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
        proc.stderr!.on("data", (d: Buffer) => { err += d.toString(); });
        proc.on("close", (code) => {
          if (code !== 0) reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
          else resolve(out.trim());
        });
        proc.stdin!.write(prompt);
        proc.stdin!.end();
      });
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function step(n: number, label: string) {
  const bar = "─".repeat(50);
  console.log(`\n${bar}\n ÉTAPE ${n} · ${label}\n${bar}`);
}
function ok(label: string, detail: string) { console.log(`  ✓ ${label.padEnd(10)} ${detail}`); }
function info(msg: string) { console.log(`  → ${msg}`); }

function parseJson<T>(raw: string): T {
  const clean = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(clean) as T;
}

// ─── Types pipeline ───────────────────────────────────────────────────────────

interface ParsedFile {
  filePath: string;
  fileName: string;
  rawContent: string;
  title: string;
  description: string;
  sourceUrl: string;
  body: string;
}

interface AiResult {
  isSourceFrench: boolean;
  cleanedContent: string;
  contentFr: string;
  summaryFr: string;
  title: string;
}

interface AnytypePage {
  name: string;
  body: string;
  sourceUrl: string;
  summaryFr: string;
}

// ─── Étape 1 ─────────────────────────────────────────────────────────────────

async function stepFetch(fileName: string | null): Promise<{ filePath: string; fileName: string; rawContent: string }> {
  if (fileName) {
    step(1, `Récupération du fichier : ${fileName}`);
    const filePath = join(CLIPPINGS_DIR, fileName);
    await stat(filePath);
    const rawContent = await readFile(filePath, "utf-8");
    if (rawContent.trim().length < 50) throw new Error("Fichier trop court (< 50 caractères).");
    ok("Contenu", `${rawContent.length.toLocaleString("fr-FR")} caractères lus`);
    return { filePath, fileName, rawContent };
  }

  step(1, "Récupération du fichier .md le plus récent");
  info(`Dossier : ${CLIPPINGS_DIR}`);

  const entries = await readdir(CLIPPINGS_DIR, { withFileTypes: true });
  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
    .map((e) => join(CLIPPINGS_DIR, e.name));

  if (!mdFiles.length) throw new Error("Aucun fichier .md trouvé dans le dossier Clippings.");

  const withMtime = await Promise.all(
    mdFiles.map(async (fp) => ({ fp, mtimeMs: (await stat(fp)).mtimeMs })),
  );
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const filePath = withMtime[0].fp;
  const resolvedName = basename(filePath);
  const ageMinutes = Math.round((Date.now() - withMtime[0].mtimeMs) / 60000);
  ok("Fichier", `"${resolvedName}" (modifié il y a ${ageMinutes} min)`);

  const rawContent = await readFile(filePath, "utf-8");
  if (rawContent.trim().length < 50) throw new Error("Fichier trop court (< 50 caractères).");
  ok("Contenu", `${rawContent.length.toLocaleString("fr-FR")} caractères lus`);

  return { filePath, fileName: resolvedName, rawContent };
}

// ─── Étape 2 ─────────────────────────────────────────────────────────────────

async function stepParse(filePath: string, fileName: string, rawContent: string): Promise<ParsedFile> {
  step(2, "Parsing du fichier Markdown");

  const titleMatch =
    rawContent.match(/^title:\s*["']?(.+?)["']?\s*$/m) ||
    rawContent.match(/^#\s+(.+)$/m);
  const urlMatch =
    rawContent.match(/^url:\s*(https?:\/\/[^\s\n]+)/m) ||
    rawContent.match(/^source:\s*(https?:\/\/[^\s\n]+)/m) ||
    rawContent.match(/(https?:\/\/[^\s\n)]+)/);
  const descriptionMatch = rawContent.match(/^description:\s*["']?(.+?)["']?\s*$/m);

  const title = titleMatch?.[1]?.trim() ?? fileName.replace(".md", "");
  const description = descriptionMatch?.[1]?.trim() ?? "";
  const sourceUrl = urlMatch?.[1]?.trim() ?? "";

  const frontMatterEnd = rawContent.match(/^---[\s\S]*?^---\s*/m);
  const body = frontMatterEnd ? rawContent.slice(frontMatterEnd[0].length).trim() : rawContent;

  if (!title) throw new Error("Impossible d'extraire un titre.");

  ok("Titre", `"${title}"`);
  if (description) ok("Desc.", `"${description.slice(0, 80)}"`);
  ok("Source", sourceUrl || "(non trouvée)");
  ok("Corps", `${body.length.toLocaleString("fr-FR")} caractères`);

  return { filePath, fileName, rawContent, title, description, sourceUrl, body };
}

// ─── Étape 3 ─────────────────────────────────────────────────────────────────

async function stepAi(parsed: ParsedFile, provider: AiProvider): Promise<AiResult> {
  step(3, `Traitement AI — ${provider.label}`);
  info("Détection langue, nettoyage, résumé et traduction...");

  const prompt = `Tu es un assistant de veille technologique. Voici le contenu brut d'un article web (format Markdown).

Effectue ces tâches et réponds UNIQUEMENT avec un objet JSON valide, sans markdown ni commentaires.

Nom du fichier : ${parsed.fileName}
Titre extrait : ${parsed.title}
Description extraite : ${parsed.description || "(aucune)"}

Effectue ces tâches et réponds UNIQUEMENT avec un objet JSON valide, sans markdown ni commentaires.

1. **Langue** : L'article est-il rédigé en français ? (isSourceFrench: true/false)
2. **Nettoyage** : Supprime publicités, menus, popups, mentions légales, boutons, fil d'Ariane, recommandations, liens vers d'autres articles. Conserve uniquement le texte éditorial. Préserve scrupuleusement le formatage Markdown original : titres (#), blocs de code (triple backticks), code inline, listes, tableaux, gras, italique, citations (>). Ne reformate pas, ne simplifie pas.
3. **Résumé en français** : 3 à 6 phrases capturant l'essentiel.
4. **Si l'article N'EST PAS en français** : traduis le contenu nettoyé intégralement en français.
5. **Titre** : Forge un titre concis et informatif en combinant intelligemment le nom du fichier, le titre et la description fournis. Conserve la langue originale de l'article. Si la description est vide, utilise le titre et le nom de fichier.

JSON strict :
{
  "isSourceFrench": true ou false,
  "cleanedContent": "texte nettoyé en langue originale",
  "contentFr": "traduction française complète du contenu (chaîne vide si déjà en français)",
  "summaryFr": "résumé en français",
  "title": "titre forgé en langue originale"
}

Contenu :
---
${parsed.body.slice(0, 12000)}
---`;

  const raw = await provider.generate(prompt);
  const result = parseJson<AiResult>(raw);

  if (!result.summaryFr) throw new Error("Le provider n'a pas retourné de résumé.");

  ok("Langue", result.isSourceFrench ? "Français (pas de traduction)" : "Anglais → traduction FR");
  ok("Résumé FR", `${result.summaryFr.length} car. — "${result.summaryFr.slice(0, 80)}..."`);
  ok("cleanedContent", `${(result.cleanedContent ?? "").length} car.`);
  ok("contentFr", `${(result.contentFr ?? "").length} car.`);

  ok("Titre", `"${result.title || parsed.title}"`);

  return {
    isSourceFrench: Boolean(result.isSourceFrench),
    cleanedContent: result.cleanedContent || parsed.body,
    contentFr: result.contentFr || "",
    summaryFr: result.summaryFr,
    title: result.title || parsed.title,
  };
}

// ─── Étape 4 ─────────────────────────────────────────────────────────────────

async function stepBuild(parsed: ParsedFile, ai: AiResult): Promise<AnytypePage> {
  step(4, "Construction de l'objet Anytype");

  const date = new Date().toLocaleDateString("fr-FR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  const articleContentFr = ai.isSourceFrench ? ai.cleanedContent : ai.contentFr;

  const sections: string[] = [
    `# ${ai.title}`, ``,
    `> **Source :** ${parsed.sourceUrl || "_non disponible_"}`,
    `> **Ajouté le :** ${date}`, ``,
    `---`, ``,
    `## Résumé`, ``,
    ai.summaryFr, ``,
    `---`, ``,
    `## Article`, ``,
    articleContentFr,
  ];

  if (!ai.isSourceFrench) {
    sections.push(``, `---`, ``, `## Article original (EN)`, ``, ai.cleanedContent);
  }

  const body = sections.join("\n");
  const page: AnytypePage = { name: ai.title, body, sourceUrl: parsed.sourceUrl, summaryFr: ai.summaryFr };

  ok("Nom", `"${page.name}"`);
  ok("Corps", `${page.body.length.toLocaleString("fr-FR")} caractères`);
  ok("Structure", ai.isSourceFrench ? "FR uniquement" : "FR + EN");

  return page;
}

// ─── Étape 5 ─────────────────────────────────────────────────────────────────

const VEILLE_AUTO_TITLE = "[VEILLE-AUTO]";

async function stepPublish(page: AnytypePage): Promise<void> {
  step(5, "Publication dans Anytype");

  const headers = JSON.stringify({
    Authorization: `Bearer ${ANYTYPE_API_KEY}`,
    "Anytype-Version": ANYTYPE_VERSION,
  });

  const client = new AnytypeMcpClient(headers);
  try {
    info("Connexion MCP (stdio)...");
    await client.initialize();
    ok("MCP", "connecté");

    info("Résolution de l'espace...");
    const spaces = await client.call<{ data: Array<{ id: string; name: string }> }>("API-list-spaces");
    const space = spaces.data.find((s) => s.name === ANYTYPE_SPACE_NAME) ?? spaces.data[0];
    if (!space) throw new Error("Aucun espace Anytype trouvé.");
    ok("Espace", `"${space.name}" (${space.id.slice(0, 20)}...)`);

    info(`Récupération de la page "${VEILLE_AUTO_TITLE}"...`);
    const fetched = await client.call<{ object: { body?: string; markdown?: string } }>("API-get-object", {
      space_id: space.id,
      object_id: ANYTYPE_VEILLE_PAGE_ID,
    });
    const parentBody = fetched.object?.body ?? fetched.object?.markdown ?? `# ${VEILLE_AUTO_TITLE}\n\n`;
    ok("Page mère", `"${VEILLE_AUTO_TITLE}" récupérée (${parentBody.length} car.)`);

    info("Création de la page article...");
    const article = await client.call<{ object: { id: string } }>("API-create-object", {
      space_id: space.id,
      type_key: "page",
      name: page.name,
      body: page.body,
      ...(page.sourceUrl && { properties: [{ key: "source", url: page.sourceUrl }] }),
    });
    ok("Article", `créé (${article.object.id})`);

    const dateFr = new Date().toLocaleDateString("fr-FR", {
      day: "numeric", month: "long", year: "numeric",
    });
    const anytypeUrl = `anytype://object?objectId=${article.object.id}&spaceId=${space.id}`;
    const linkLine = `- **${dateFr}** — [${page.name}](${anytypeUrl})`;
    await client.call("API-update-object", {
      space_id: space.id,
      object_id: ANYTYPE_VEILLE_PAGE_ID,
      markdown: parentBody.trimEnd() + "\n" + linkLine + "\n",
    });
    ok("Lien", `article référencé dans "${VEILLE_AUTO_TITLE}"`);
  } finally {
    client.close();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { provider: providerName, fileName } = parseArgs();
  checkEnv(providerName);

  const provider = providerName === "claude" ? makeClaudeProvider() : makeGeminiProvider();
  const mode = fileName ? `Fichier : ${fileName}` : `Mode : dernier fichier`;
  const bar = "═".repeat(52);
  console.log(`\n${bar}\n veille-sync · process\n ${mode}  |  Provider : ${provider.label}\n${bar}`);

  const t0 = Date.now();
  const { filePath, fileName: resolvedName, rawContent } = await stepFetch(fileName);
  const parsed = await stepParse(filePath, resolvedName, rawContent);
  const ai = await stepAi(parsed, provider);
  const page = await stepBuild(parsed, ai);
  await stepPublish(page);

  console.log(`\n${"═".repeat(52)}\n ✅  Pipeline terminé en ${((Date.now() - t0) / 1000).toFixed(1)}s\n${"═".repeat(52)}\n`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n✗ Échec du pipeline : ${msg}`);
  process.exit(1);
});
