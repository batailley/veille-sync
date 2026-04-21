import { GoogleGenerativeAI } from "@google/generative-ai";

const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");

export interface ProcessedArticle {
  title: string;
  sourceUrl: string;
  summary: string;       // résumé en français
  cleanedContent: string; // texte nettoyé sans pubs
  originalContent: string; // contenu brut du .md
  processedAt: string;
  weekNumber: number;
  year: number;
}

export function getWeekNumber(date: Date): { week: number; year: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { week, year: d.getUTCFullYear() };
}

export async function processArticle(
  rawContent: string,
  fileName: string
): Promise<ProcessedArticle> {
  const now = new Date();
  const { week, year } = getWeekNumber(now);

  // Extraire le titre et l'URL depuis le front-matter markdown (format Obsidian Clipper)
  const titleMatch = rawContent.match(/^#\s+(.+)$/m) || rawContent.match(/title:\s*(.+)/);
  const urlMatch = rawContent.match(/url:\s*(https?:\/\/[^\s\n]+)/) ||
                   rawContent.match(/source:\s*(https?:\/\/[^\s\n]+)/) ||
                   rawContent.match(/(https?:\/\/[^\s\n)]+)/);

  const title = titleMatch?.[1]?.trim() ?? fileName.replace(".md", "");
  const sourceUrl = urlMatch?.[1]?.trim() ?? "";

  console.log(`  → Appel Gemini pour : "${title}"`);

  const prompt = `Tu es un assistant de veille technologique et intellectuelle. Voici le contenu brut d'un article web capturé (format Markdown).

Effectue ces 3 tâches et réponds UNIQUEMENT avec un objet JSON valide, sans markdown, sans commentaires.

1. **Nettoyage** : Supprime tout ce qui n'est pas le contenu éditorial (publicités, menus de navigation, popups, mentions légales, boutons, fils d'Ariane, recommandations d'articles, etc.). Conserve uniquement le texte de l'article.

2. **Résumé en français** : Rédige un résumé en français de 3 à 6 phrases capturant l'essentiel de l'article. Si l'article est déjà en français, résume-le quand même.

3. **Titre** : Si le titre extrait automatiquement est incomplet ou absent, propose un titre propre en français.

Format de réponse (JSON strict) :
{
  "cleanedContent": "le texte de l'article nettoyé, en langue originale",
  "summary": "le résumé en français",
  "title": "titre propre de l'article"
}

Contenu brut de l'article :
---
${rawContent.slice(0, 12000)}
---`;

  const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
  const result = await model.generateContent(prompt);
  const responseText = result.response.text();

  let parsed: { cleanedContent: string; summary: string; title: string };
  try {
    const clean = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    parsed = JSON.parse(clean);
  } catch (e) {
    console.error("  ✗ Erreur parsing JSON Gemini :", e);
    console.error("  Réponse brute :", responseText.slice(0, 500));
    parsed = {
      cleanedContent: rawContent,
      summary: "Résumé non disponible (erreur de traitement).",
      title,
    };
  }

  return {
    title: parsed.title || title,
    sourceUrl,
    summary: parsed.summary,
    cleanedContent: parsed.cleanedContent,
    originalContent: rawContent,
    processedAt: now.toISOString(),
    weekNumber: week,
    year,
  };
}
