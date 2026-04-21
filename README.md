# veille-sync

Watcher automatique : iCloud Clippings → Claude API → Anytype

## Prérequis

- Node.js 18+ (`node --version`)
- Anytype Desktop ouvert sur le Mac
- Une clé API Anthropic → https://console.anthropic.com/

---

## Installation

### 1. Cloner et installer les dépendances

```bash
cd /Users/laurent/www/veille-sync
npm install
```

### 2. Configurer le .env

```bash
cp .env .env.local
# Éditer .env avec ta clé API et le nom exact de ton espace Anytype
nano .env
```

Vérifier le nom de ton espace : ouvrir Anytype → Settings → nom en haut à gauche.

### 3. Installer le MCP Anytype

```bash
npm install -g @anytype/mcp-server
```

Lancer le serveur MCP (à faire une première fois pour tester) :
```bash
anytype-mcp
# Doit afficher : MCP server listening on port 31009
```

### 4. Tester le pipeline manuellement

```bash
npm run dev
```

Puis déposer un fichier `.md` dans le dossier Clippings depuis Safari.
Tu dois voir apparaître les logs de traitement dans le terminal.

---

## Lancement automatique (launchd)

### Vérifier le chemin de node

```bash
which node
# Ex : /usr/local/bin/node  ou  /opt/homebrew/bin/node (Apple Silicon)
```

Adapter le chemin dans `com.laurent.veille-sync.plist` si nécessaire.

### Créer le dossier de logs

```bash
mkdir -p /Users/laurent/www/veille-sync/logs
```

### Installer le service

```bash
# Copier le plist dans LaunchAgents
cp com.laurent.veille-sync.plist ~/Library/LaunchAgents/

# Charger le service
launchctl load ~/Library/LaunchAgents/com.laurent.veille-sync.plist

# Vérifier qu'il tourne
launchctl list | grep veille
```

### Commandes utiles

```bash
# Arrêter
launchctl unload ~/Library/LaunchAgents/com.laurent.veille-sync.plist

# Redémarrer
launchctl unload ~/Library/LaunchAgents/com.laurent.veille-sync.plist
launchctl load ~/Library/LaunchAgents/com.laurent.veille-sync.plist

# Voir les logs en temps réel
tail -f /Users/laurent/www/veille-sync/logs/veille-sync.log
```

---

## Structure des pages Anytype

```
Veille - Semaine 42 · 2025
├── Titre de l'article 1
│   ├── Résumé (FR)
│   ├── Contenu nettoyé
│   └── Contenu brut original (repliable)
├── Titre de l'article 2
│   └── ...
```

---

## Dépannage

**MCP Anytype ne répond pas**
→ Vérifier qu'Anytype Desktop est ouvert
→ Tester : `curl http://localhost:31009/rpc`

**Fichiers non traités**
→ Vérifier `CLIPPINGS_DIR` dans .env
→ Voir les logs : `tail -f logs/veille-sync-error.log`

**Erreur Claude API**
→ Vérifier la clé dans .env : `ANTHROPIC_API_KEY=sk-ant-...`
