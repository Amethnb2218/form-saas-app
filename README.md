# Form SaaS Application

Cette application Node.js/Express est une plateforme de génération de formulaires multi‑tenant. Elle distingue le rôle **entreprise** (qui peut créer et gérer des formulaires) et le rôle **client** (qui remplit un formulaire sans authentification).

## Fonctionnalités

* Inscription et connexion pour les entreprises avec hachage de mot de passe via `bcryptjs`.
* Tableau de bord pour les entreprises : création, modification et visualisation de formulaires, consultation des soumissions.
* Génération de formulaires dynamiques avec des types de champ variés (texte, e‑mail, nombre, date) et possibilité d’autoriser le téléchargement d’un fichier.
* Page d’accueil publique listant toutes les entreprises et leurs formulaires.
* Interface client pour remplir un formulaire, téléverser un fichier (photo ou PDF) et recevoir un message de confirmation.
* Stockage des données dans MongoDB via Mongoose et sauvegarde des fichiers dans `public/uploads/`.

## Démarrage local

1. Installez les dépendances :

```bash
npm install
```

2. Créez un fichier `.env` à la racine avec les variables suivantes :

```env
MONGODB_URI=mongodb+srv://<utilisateur>:<motdepasse>@cluster-url/nomdb?retryWrites=true&w=majority
SESSION_SECRET=une_chaine_secrete_pour_la_session
```

3. Lancez l’application :

```bash
npm start
```

4. Rendez‑vous sur `http://localhost:3000/` dans votre navigateur.

## Déploiement sur Render

1. **Création du dépôt GitHub** : créez un nouveau dépôt GitHub et poussez ce code. Sur Render, vous aurez besoin d’un dépôt GitHub public ou privé pour connecter le service.

2. **Base de données MongoDB Atlas** : créez un cluster MongoDB Atlas et récupérez la chaîne de connexion (URI). Assurez‑vous d’autoriser les adresses IP de Render dans la section « Network Access ».

3. **Création du service Render** : connectez‑vous à [Render](https://render.com/), cliquez sur « New Web Service » puis sélectionnez le dépôt. Configurez :
   * Runtime : Node
   * Build Command : `npm install`
   * Start Command : `npm start`
   * Root Directory : `form-saas-app/` (si vous conservez ce chemin dans le dépôt)
   * Environment : ajoutez `MONGODB_URI` et `SESSION_SECRET` dans la section des variables d’environnement.

4. Lancez le déploiement. Render installera les dépendances et démarrera l’application. Le site sera accessible sur l’URL fournie par Render.

5. Pour que les clients puissent télécharger des fichiers et que les entreprises puissent téléverser des logos, assurez‑vous que la configuration Render permet l’écriture dans le dossier `public/uploads` ou utilisez un service de stockage (Amazon S3, Cloudinary) et adaptez le code en conséquence.

## Note de sécurité

Pour une utilisation en production, activez HTTPS, configurez correctement les en‑têtes de sécurité, limitez la taille et les types des fichiers téléversés et implémentez une authentification multi‑facteur pour les entreprises.