import "dotenv/config";
import { readdir, readFile } from "fs/promises";
import { join, basename } from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { AnytypeMcpClient } from "./anytype.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const CLIPPINGS_DIR = process.env.CLIPPINGS_DIR!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const ANYTYPE_API_KEY = process.env.ANYTYPE_API_KEY!;
const ANYTYPE_SPACE_NAME = process.env.ANYTYPE_SPACE_NAME!;
const ANYTYPE_VERSION = "2025-11-08";

function checkEnv() {
  const required = {
    CLIPPINGS_DIR,
    GEMINI_API_KEY,
    ANYTYPE_API_KEY,
    ANYTYPE_SPACE_NAME,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`✗ Variables .env manquantes : ${missing.join(", ")}`);
    process.exit(1);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function step(n: number, label: string) {
  const bar = "─".repeat(50);
  console.log(`\n${bar}`);
  console.log(` ÉTAPE ${n} · ${label}`);
  console.log(bar);
}

function ok(label: string, detail: string) {
  console.log(`  ✓ ${label.padEnd(10)} ${detail}`);
}

function info(msg: string) {
  console.log(`  → ${msg}`);
}

function parseJson<T>(raw: string): T {
  const clean = raw
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
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

interface GeminiResult {
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

// ─── Étape 1 : Récupération du fichier ───────────────────────────────────────

async function stepFetch(): Promise<{
  filePath: string;
  fileName: string;
  rawContent: string;
}> {
  step(1, "Récupération du fichier .md le plus récent");

  info(`Dossier : ${CLIPPINGS_DIR}`);

  const entries = await readdir(CLIPPINGS_DIR, { withFileTypes: true });
  const mdFiles = entries
    .filter(
      (e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."),
    )
    .map((e) => join(CLIPPINGS_DIR, e.name));

  if (!mdFiles.length)
    throw new Error("Aucun fichier .md trouvé dans le dossier Clippings.");

  // Trier par date de modification décroissante
  const withMtime = await Promise.all(
    mdFiles.map(async (fp) => {
      const { mtimeMs } = await import("fs/promises").then((m) => m.stat(fp));
      return { fp, mtimeMs };
    }),
  );
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const filePath = withMtime[0].fp;
  const fileName = basename(filePath);
  const ageMinutes = Math.round((Date.now() - withMtime[0].mtimeMs) / 60000);

  ok("Fichier", `"${fileName}" (modifié il y a ${ageMinutes} min)`);

  const rawContent = await readFile(filePath, "utf-8");
  if (rawContent.trim().length < 50)
    throw new Error("Fichier trop court (< 50 caractères).");

  ok("Contenu", `${rawContent.length.toLocaleString("fr-FR")} caractères lus`);

  return { filePath, fileName, rawContent };
}

// ─── Étape 2 : Parsing ────────────────────────────────────────────────────────

async function stepParse(
  filePath: string,
  fileName: string,
  rawContent: string,
): Promise<ParsedFile> {
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

  // Extraire le corps : tout ce qui suit le front-matter YAML (---) ou le premier h1
  const frontMatterEnd = rawContent.match(/^---[\s\S]*?^---\s*/m);
  const body = frontMatterEnd
    ? rawContent.slice(frontMatterEnd[0].length).trim()
    : rawContent;

  if (!title) throw new Error("Impossible d'extraire un titre.");

  ok("Titre", `"${title}"`);
  ok("Source", sourceUrl || "(non trouvée)");
  ok("Corps", `${body.length.toLocaleString("fr-FR")} caractères`);

  return { filePath, fileName, rawContent, title, sourceUrl, body };
}

// ─── Étape 3 : Traitement Gemini ─────────────────────────────────────────────

async function stepGemini(parsed: ParsedFile): Promise<GeminiResult> {
  step(3, "Traitement Gemini");

  const gemini = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = gemini.getGenerativeModel({ model: "gemini-2.5-flash" });

  // 3a : résumé FR + nettoyage + titre
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

  const r1 = await model.generateContent(promptSummary);
  const step3a = parseJson<{
    cleanedContent: string;
    summary: string;
    title: string;
  }>(r1.response.text());

  if (!step3a.summary) throw new Error("Gemini n'a pas retourné de résumé.");
  ok(
    "Résumé FR",
    `${step3a.summary.length} car. — "${step3a.summary.slice(0, 80)}..."`,
  );

  // 3b : traduction du résumé FR → EN
  info("Traduction du résumé (FR → EN)...");

  const promptTranslate = `Translate the following French text to English. Reply with the translation only, no explanation.

Text:
${step3a.summary}`;

  const r2 = await model.generateContent(promptTranslate);
  const summaryEn = r2.response.text().trim();

  if (!summaryEn) throw new Error("Gemini n'a pas retourné de traduction.");
  ok("Résumé EN", `${summaryEn.length} car. — "${summaryEn.slice(0, 80)}..."`);

  return {
    cleanedContent: step3a.cleanedContent || parsed.body,
    summaryFr: step3a.summary,
    summaryEn,
    title: step3a.title || parsed.title,
  };
}

// ─── Étape 4 : Construction de l'objet Anytype ───────────────────────────────

async function stepBuild(
  parsed: ParsedFile,
  gemini: GeminiResult,
): Promise<AnytypePage> {
  step(4, "Construction de l'objet Anytype");

  const date = new Date().toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const body = [
    `# ${gemini.title}`,
    ``,
    `> **Source :** ${parsed.sourceUrl || "_non disponible_"}`,
    `> **Ajouté le :** ${date}`,
    ``,
    `---`,
    ``,
    `## Résumé`,
    ``,
    gemini.summaryFr,
    ``,
    `*Summary (EN): ${gemini.summaryEn}*`,
    ``,
    `---`,
    ``,
    `## Contenu de l'article`,
    ``,
    gemini.cleanedContent,
    ``,
    `---`,
    ``,
    `## Contenu brut original`,
    ``,
    parsed.rawContent,
  ].join("\n");

  const page: AnytypePage = {
    name: gemini.title,
    body,
    sourceUrl: parsed.sourceUrl,
    summaryFr: gemini.summaryFr,
    summaryEn: gemini.summaryEn,
  };

  ok("Nom", `"${page.name}"`);
  ok("Corps", `${page.body.length.toLocaleString("fr-FR")} caractères`);
  ok("Résumé FR", `${page.summaryFr.length} caractères`);
  ok("Résumé EN", `${page.summaryEn.length} caractères`);

  return page;
}

// ─── Étape 5 : Publication Anytype ────────────────────────────────────────────

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
    const spaces = await client.call<{
      data: Array<{ id: string; name: string }>;
    }>("API-list-spaces");
    const space =
      spaces.data.find((s) => s.name === ANYTYPE_SPACE_NAME) ?? spaces.data[0];
    if (!space) throw new Error("Aucun espace Anytype trouvé.");
    ok("Espace", `"${space.name}" (${space.id.slice(0, 20)}...)`);

    info("Création de la page...");
    const created = await client.call<{ object: { id: string } }>(
      "API-create-object",
      {
        space_id: space.id,
        type_key: "page",
        name: page.name,
        body: page.body,
        ...(page.sourceUrl && {
          properties: [{ key: "source", url: page.sourceUrl }],
        }),
      },
    );

    ok("Publié", `id = ${created.object.id}`);
  } finally {
    client.close();
  }
}

// ─── Pipeline principal ───────────────────────────────────────────────────────

async function main() {
  checkEnv();

  const bar = "═".repeat(52);
  console.log(`\n${bar}`);
  console.log(` veille-sync · process-one`);
  console.log(` Espace : ${ANYTYPE_SPACE_NAME}  |  Modèle : gemini-2.0-flash`);
  console.log(bar);

  const t0 = Date.now();

  const { filePath, fileName, rawContent } = await stepFetch();
  const parsed = await stepParse(filePath, fileName, rawContent);
  const gemini = await stepGemini(parsed);
  const page = await stepBuild(parsed, gemini);
  await stepPublish(page);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${"═".repeat(52)}`);
  console.log(` ✅  Pipeline terminé en ${elapsed}s`);
  console.log(`${"═".repeat(52)}\n`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n✗ Échec du pipeline : ${msg}`);
  process.exit(1);
});
