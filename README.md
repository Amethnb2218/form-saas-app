# Form SaaS App

Plateforme SaaS B2B de creation et gestion de formulaires multi-entreprise.

Cette version inclut une refonte premium du frontend et un backend plus robuste:

- lifecycle de formulaire (draft/published/archived)
- slug public et liens partageables
- dashboard professionnel (KPI, filtres, actions)
- catalogue des formulaires crees (/formulaires)
- annuaire des entreprises inscrites (/entreprises)
- export CSV des soumissions
- duplication de formulaire
- settings entreprise (profil + mot de passe)
- support HTTPS avec certificat auto-signe

## Fonctionnalites

- Inscription / connexion entreprise
- Dashboard avec:
  - recherche et filtre par statut
  - edition, suppression, duplication
  - changement rapide de statut
  - suivi des soumissions par formulaire
- Catalogue formulaires:
  - liste des formulaires crees avec filtres (recherche, categorie, statut)
  - perimetre plateforme ou mes formulaires
- Annuaire entreprises:
  - liste des entreprises inscrites
  - metriques par entreprise (formulaires, soumissions)
- Formulaires publics:
  - route slug: /f/:slug
  - compatibilite route historique: /form/:id
- Collecte de soumissions:
  - validation des champs
  - upload optionnel (JPG, PNG, PDF)
  - metadonnees source (IP, user-agent)
- Export CSV des soumissions
- Parametres entreprise:
  - nom entreprise
  - logo
  - changement mot de passe

## Securite et robustesse

- Helmet + CSP
- Rate limiting global, auth et soumission
- Session securisee (httpOnly, sameSite)
- Validation stricte des payloads et ObjectId
- Nettoyage des fichiers orphelins
- Fallback MongoDB en memoire en dev si Mongo local indisponible

## Prerequis

- Node.js 18+
- npm

## Installation

1. Installer les dependances:

npm install

2. Copier .env.example vers .env puis adapter:

PORT=3000
NODE_ENV=development
MONGODB_URI=mongodb://127.0.0.1:27017/formsaas
MONGO_MEMORY_LAUNCH_TIMEOUT_MS=120000
SESSION_SECRET=replace_with_a_long_random_secret
MAX_UPLOAD_SIZE_MB=5
HTTPS_ENABLED=false
HTTPS_PORT=3443
HTTPS_REDIRECT_HTTP=false
HTTPS_CERT_PATH=certs/localhost-cert.pem
HTTPS_KEY_PATH=certs/localhost-key.pem

3. Lancer l'application:

npm run dev

## HTTPS auto-signe (certificat local)

Pour activer HTTPS localement:

1. Mettre dans .env:

- HTTPS_ENABLED=true
- HTTPS_PORT=3443

2. Lancer:

npm run dev:https

Au premier demarrage, un certificat auto-signe est genere automatiquement dans le dossier certs/.

URL HTTPS locale:
https://localhost:3443

Optionnel:

- HTTPS_REDIRECT_HTTP=true pour rediriger HTTP vers HTTPS

## Scripts

- npm start: demarre en mode normal
- npm run dev: demarre avec nodemon
- npm run dev:https: demarre avec HTTPS active
- npm test: execute les tests

## Exemple de fieldsJson

[
{
"name": "full_name",
"label": "Nom complet",
"type": "text",
"required": true,
"placeholder": "Ex: Marie Diallo",
"helpText": "Nom et prenom"
},
{
"name": "email",
"label": "Email",
"type": "email",
"required": true
},
{
"name": "message",
"label": "Message",
"type": "textarea",
"required": false
}
]

Types supportes:

- text
- email
- number
- date
- textarea
- tel
- url
- checkbox

## Endpoints principaux

- GET /health
- GET /
- GET /formulaires
- GET /entreprises
- GET /dashboard
- GET /settings
- GET /f/:slug
- POST /f/:slug
- GET /form/submissions/:id/export.csv

## Notes dev

- Si MONGODB_URI est absent (ou pointe vers localhost) en developpement, l'application tente Mongo local puis bascule automatiquement en in-memory MongoDB.
- En mode in-memory, les donnees ne sont pas persistantes.
- Si le fallback in-memory est lent a demarrer (Windows/first run), augmentez MONGO_MEMORY_LAUNCH_TIMEOUT_MS.
