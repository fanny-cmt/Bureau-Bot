# BureauBot 🏢

Un bot Slack qui permet à une équipe de coordonner sa présence au bureau chaque semaine, sans friction.

## Fonctionnalités

- Message automatique chaque vendredi matin dans un canal dédié à 9h
- Boutons interactifs par jour (Lundi → Vendredi), sans formulaire à soumettre
- Récap mis à jour en temps réel — tout le monde voit qui vient quel jour
- Modifiable en tout temps
- Message de la semaine en cours (à la fin de la semaine) désactivé le vendredi à 17h et les données sont flushées

## Architecture

- **Slack Bolt SDK** (Socket Mode) — gestion des interactions et des messages
- **SQLite** via `better-sqlite3` — stockage local des présences
- **Docker** — déploiement simple et portable

## Prérequis

- Docker Desktop
- Une app Slack configurée sur [api.slack.com/apps](https://api.slack.com/apps)

## Configuration de l'app Slack

1. Crée une nouvelle app → **From scratch**
2. **OAuth & Permissions** → ajoute les scopes : `chat:write`, `channels:read`
3. **Install to Workspace** → copie le **Bot Token** (`xoxb-...`)
4. **Basic Information** → copie le **Signing Secret**
5. **Socket Mode** → active → génère un **App Token** (`xapp-...`)
6. **Event Subscriptions** → active → abonne-toi à `message.channels`
7. **Interactivity & Shortcuts** → active

## Installation

Clone le repo et crée un fichier `.env` à la racine :

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...
SLACK_CHANNEL_IDS=C0XXXXXXXXX,C0YYYYYYYYY
```

> Pour trouver un `SLACK_CHANNEL_ID` : clic droit sur le canal dans Slack → **Voir les infos du canal** → l'ID est en bas (commence par `C`). Sépare plusieurs IDs par des virgules pour publier dans plusieurs channels.

## Lancement

```bash
docker compose up -d
```

Vérifie que le bot tourne :

```bash
docker logs bureau-bot
# → "Bot démarré"
```

Invite le bot dans ton canal :

```
/invite @BureauBot
```

## Test immédiat

Pour poster un message sans attendre vendredi, ajoute temporairement cette ligne dans `index.js` avant la dernière ligne `})();` :

```javascript
await postOrUpdateMessage(nextWeek());
```

## Structure du projet

```
bureau-bot/
├── index.js          # Code du bot
├── Dockerfile
├── docker-compose.yml
├── package.json
└── .env              # Ne pas committer
```

## Données

Les présences sont stockées dans `./data/presence.db` (SQLite), persisté via un volume Docker.
