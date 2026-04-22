import "dotenv/config";
import { readFile, stat } from "fs/promises";
import { spawn } from "child_process";
import { join } from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { AnytypeMcpClient } from "./anytype.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const CLIPPINGS_DIR = process.env.CLIPPINGS_DIR!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const ANYTYPE_API_KEY = process.env.ANYTYPE_API_KEY!;
const ANYTYPE_SPACE_NAME = process.env.ANYTYPE_SPACE_NAME!;
const ANYTYPE_VERSION = "2025-11-08";

type ProviderName = "gemini" | "claude";

function parseArgs(): { provider: ProviderName; fileName: string } {
  const fileIdx = process.argv.indexOf("--file");
  const provIdx = process.argv.indexOf("--provider");

  if (fileIdx === -1 || !process.argv[fileIdx + 1]) {
    console.error("✗ --file <nom_du_fichier.md> est requis");
    process.exit(1);
  }

  const fileName = process.argv[fileIdx + 1];
  const val = provIdx !== -1 ? process.argv[provIdx + 1] : "gemini";
  if (val !== "gemini" && val !== "claude") {
    console.error(`✗ --provider doit être "gemini" ou "claude" (reçu : "${val}")`);
    process.exit(1);
  }

  return { provider: val as ProviderName, fileName };
}

function checkEnv(provider: ProviderName) {
  const required: Record<string, string> = { CLIPPINGS_DIR, ANYTYPE_API_KEY, ANYTYPE_SPACE_NAME };
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
  sourceUrl: string;
  body: string;
}

interface AiResult {
  cleanedContent: string;
  summaryFr: string;
  summaryEn: string;
  title: string;
}

interface AnytypePage {
  name: string;
  body: string;
  sourceUrl: string;
  summaryFr: string;
  summaryEn: string;
}

// ─── Étape 1 ─────────────────────────────────────────────────────────────────

async function stepFetch(fileName: string): Promise<{ filePath: string; fileName: string; rawContent: string }> {
  step(1, `Récupération du fichier : ${fileName}`);

  const filePath = join(CLIPPINGS_DIR, fileName);
  await stat(filePath); // throws if file doesn't exist

  const rawContent = await readFile(filePath, "utf-8");
  if (rawContent.trim().length < 50) throw new Error("Fichier trop court (< 50 caractères).");
  ok("Contenu", `${rawContent.length.toLocaleString("fr-FR")} caractères lus`);

  return { filePath, fileName, rawContent };
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

  const title = titleMatch?.[1]?.trim() ?? fileName.replace(".md", "");
  const sourceUrl = urlMatch?.[1]?.trim() ?? "";

  const frontMatterEnd = rawContent.match(/^---[\s\S]*?^---\s*/m);
  const body = frontMatterEnd ? rawContent.slice(frontMatterEnd[0].length).trim() : rawContent;

  if (!title) throw new Error("Impossible d'extraire un titre.");

  ok("Titre", `"${title}"`);
  ok("Source", sourceUrl || "(non trouvée)");
  ok("Corps", `${body.length.toLocaleString("fr-FR")} caractères`);

  return { filePath, fileName, rawContent, title, sourceUrl, body };
}

// ─── Étape 3 ─────────────────────────────────────────────────────────────────

async function stepAi(parsed: ParsedFile, provider: AiProvider): Promise<AiResult> {
  step(3, `Traitement AI — ${provider.label}`);

  info("Résumé en français + nettoyage du contenu...");
  const promptSummary = `Tu es un assistant de veille technologique. Voici le contenu brut d'un article web (format Markdown).

Effectue ces tâches et réponds UNIQUEMENT avec un objet JSON valide, sans markdown ni commentaires.

1. **Nettoyage** : Supprime publicités, menus, popups, mentions légales, boutons, fil d'Ariane, recommandations. Conserve uniquement le texte éditorial.
2. **Résumé en français** : 3 à 6 phrases capturant l'essentiel.
3. **Titre** : Propose un titre propre en français si celui extrait est incomplet.

JSON strict :
{
  "cleanedContent": "texte nettoyé en langue originale",
  "summary": "résumé en français",
  "title": "titre propre"
}

Contenu :
---
${parsed.body.slice(0, 12000)}
---`;

  const raw1 = await provider.generate(promptSummary);
  const step3a = parseJson<{ cleanedContent: string; summary: string; title: string }>(raw1);
  if (!step3a.summary) throw new Error("Le provider n'a pas retourné de résumé.");
  ok("Résumé FR", `${step3a.summary.length} car. — "${step3a.summary.slice(0, 80)}..."`);

  info("Traduction du résumé (FR → EN)...");
  const promptTranslate = `Translate the following French text to English. Reply with the translation only, no explanation.\n\nText:\n${step3a.summary}`;
  const summaryEn = (await provider.generate(promptTranslate)).trim();
  if (!summaryEn) throw new Error("Le provider n'a pas retourné de traduction.");
  ok("Résumé EN", `${summaryEn.length} car. — "${summaryEn.slice(0, 80)}..."`);

  return {
    cleanedContent: step3a.cleanedContent || parsed.body,
    summaryFr: step3a.summary,
    summaryEn,
    title: step3a.title || parsed.title,
  };
}

// ─── Étape 4 ─────────────────────────────────────────────────────────────────

async function stepBuild(parsed: ParsedFile, ai: AiResult): Promise<AnytypePage> {
  step(4, "Construction de l'objet Anytype");

  const date = new Date().toLocaleDateString("fr-FR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  const body = [
    `# ${ai.title}`, ``,
    `> **Source :** ${parsed.sourceUrl || "_non disponible_"}`,
    `> **Ajouté le :** ${date}`, ``, `---`, ``,
    `## Résumé`, ``, ai.summaryFr, ``,
    `*Summary (EN): ${ai.summaryEn}*`, ``, `---`, ``,
    `## Contenu de l'article`, ``, ai.cleanedContent, ``, `---`, ``,
    `## Contenu brut original`, ``, parsed.rawContent,
  ].join("\n");

  const page: AnytypePage = { name: ai.title, body, sourceUrl: parsed.sourceUrl, summaryFr: ai.summaryFr, summaryEn: ai.summaryEn };
  ok("Nom", `"${page.name}"`);
  ok("Corps", `${page.body.length.toLocaleString("fr-FR")} caractères`);
  return page;
}

// ─── Étape 5 ─────────────────────────────────────────────────────────────────

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

    info("Création de la page...");
    const created = await client.call<{ object: { id: string } }>("API-create-object", {
      space_id: space.id,
      type_key: "page",
      name: page.name,
      body: page.body,
      ...(page.sourceUrl && { properties: [{ key: "source", url: page.sourceUrl }] }),
    });
    ok("Publié", `id = ${created.object.id}`);
  } finally {
    client.close();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { provider: providerName, fileName } = parseArgs();
  checkEnv(providerName);

  const provider = providerName === "claude" ? makeClaudeProvider() : makeGeminiProvider();
  const bar = "═".repeat(52);
  console.log(`\n${bar}\n veille-sync · process-file\n Fichier : ${fileName}  |  Provider : ${provider.label}\n${bar}`);

  const t0 = Date.now();
  const { filePath, rawContent } = await stepFetch(fileName);
  const parsed = await stepParse(filePath, fileName, rawContent);
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
