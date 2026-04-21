import "dotenv/config";
import chokidar from "chokidar";
import { readFile, mkdir, rename } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import { processArticle } from "./processor.js";
import { publishToAnytype } from "./anytype.js";

const CLIPPINGS_DIR = process.env.CLIPPINGS_DIR!;
const PROCESSED_DIR = process.env.PROCESSED_DIR!;

// Vérification des variables d'environnement requises
function checkEnv() {
  const required = ["GEMINI_API_KEY", "CLIPPINGS_DIR", "ANYTYPE_API_KEY", "ANYTYPE_SPACE_NAME"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`✗ Variables .env manquantes : ${missing.join(", ")}`);
    process.exit(1);
  }
  if (!existsSync(CLIPPINGS_DIR)) {
    console.error(`✗ Dossier Clippings introuvable : ${CLIPPINGS_DIR}`);
    process.exit(1);
  }
}

// File en cours de traitement (évite les doublons si plusieurs fichiers arrivent vite)
const processing = new Set<string>();

async function handleNewFile(filePath: string) {
  const fileName = basename(filePath);

  // Ignorer les fichiers non-.md, les fichiers cachés, et le dossier _processed
  if (!fileName.endsWith(".md") || fileName.startsWith(".") || filePath.includes("_processed")) {
    return;
  }

  if (processing.has(filePath)) return;
  processing.add(filePath);

  console.log(`\n📄 Nouveau fichier détecté : ${fileName}`);

  try {
    // Attendre un court instant pour que iCloud finisse la synchro du fichier
    await sleep(1500);

    const rawContent = await readFile(filePath, "utf-8");
    if (rawContent.trim().length < 50) {
      console.log("  ⚠ Fichier trop court, ignoré.");
      processing.delete(filePath);
      return;
    }

    // 1. Traitement Claude
    console.log("  🤖 Traitement via Claude API...");
    const article = await processArticle(rawContent, fileName);
    console.log(`  ✓ Article traité : "${article.title}" (S${article.weekNumber})`);

    // 2. Publication Anytype
    console.log("  📤 Publication dans Anytype...");
    await publishToAnytype(article);

    // 3. Déplacer le fichier dans _processed
    await mkdir(PROCESSED_DIR, { recursive: true });
    const dest = join(PROCESSED_DIR, fileName);
    await rename(filePath, dest);
    console.log(`  ✓ Fichier archivé → _processed/${fileName}`);
    console.log(`  ✅ Terminé : "${article.title}"\n`);

  } catch (err) {
    console.error(`  ✗ Erreur pour ${fileName} :`, err);
  } finally {
    processing.delete(filePath);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  checkEnv();

  console.log("🔍 Veille Sync — démarrage");
  console.log(`   Dossier surveillé : ${CLIPPINGS_DIR}`);
  console.log(`   Espace Anytype    : ${process.env.ANYTYPE_SPACE_NAME}`);
  console.log(`   MCP URL           : ${process.env.ANYTYPE_MCP_URL}`);
  console.log("");

  const watcher = chokidar.watch(CLIPPINGS_DIR, {
    ignored: /(^|[/\\])\..|_processed/,  // ignorer fichiers cachés et _processed
    persistent: true,
    ignoreInitial: false,   // traiter les fichiers déjà présents au démarrage
    awaitWriteFinish: {
      stabilityThreshold: 2000,  // attendre 2s que le fichier soit stable
      pollInterval: 500,
    },
  });

  watcher
    .on("add", (filePath) => handleNewFile(filePath))
    .on("error", (error) => console.error("Watcher error:", error))
    .on("ready", () => {
      console.log("👀 Watcher prêt — en attente de nouveaux articles...\n");
    });

  // Gestion propre de l'arrêt
  process.on("SIGINT", async () => {
    console.log("\n⏹ Arrêt du watcher...");
    await watcher.close();
    process.exit(0);
  });
}

main().catch(console.error);
