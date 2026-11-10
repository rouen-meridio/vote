# Vote secret en direct — Simulation parlementaire Merídio Rouen

Ce dépôt contient la page de vote, publiée avec GitHub Pages. Les comptes, les votes et les scrutins restent sur le serveur Google Apps Script : la page GitHub ne stocke aucun vote.

```
index.html            la page de vote (le même fichier sert aussi dans Apps Script)
apps-script/Code.gs   copie du serveur, sans le mot de passe de la Présidence
.nojekyll             indique à GitHub Pages de servir les fichiers tels quels
```

## 1. Le serveur (Google Apps Script)

1. Dans votre projet Apps Script, remplacez **Code.gs** par la dernière version. Utilisez votre copie personnelle, celle qui contient `SEL` et l'empreinte du compte Présidence, et non le fichier `apps-script/Code.gs` de ce dépôt.
2. Allez dans **Déployer → Gérer les déploiements → ✏️ → Nouvelle version**, avec les réglages suivants :
   - Exécuter en tant que : **Moi**
   - Qui a accès : **Tout le monde**
3. Copiez l'**URL de l'application Web**. Elle se termine par `/exec`.

## 2. La page (GitHub Pages)

1. Ouvrez `index.html` dans GitHub (crayon ✏️) et cherchez la ligne suivante :
   ```js
   const API_URL = '';
   ```
   Collez votre URL `/exec` entre les apostrophes, puis faites **Commit changes**.
2. Allez dans **Settings → Pages → Build and deployment**, choisissez **Deploy from a branch**, puis la branche `main` et le dossier `/ (root)`. Cliquez sur **Save**.
3. Au bout d'une minute environ, le site est en ligne à l'adresse `https://<votre-compte>.github.io/<nom-du-dépôt>/`.

Pour afficher le site dans Google Sites : **Insérer → Intégrer → Par URL**, puis collez l'adresse GitHub Pages. Le problème « plusieurs comptes Google ouverts » ne se pose plus, car la page GitHub ne demande aucune connexion Google.

## Mettre à jour plus tard

- **Changement de la page :** remplacez `index.html` sur GitHub en gardant votre ligne `API_URL`. Si vous utilisez encore la version Apps Script, remplacez-le aussi dans Apps Script.
- **Changement du serveur :** remplacez Code.gs dans Apps Script, puis **Nouvelle version** du même déploiement. L'URL `/exec` ne change pas.

## Sécurité

- Le dépôt GitHub Pages est public : n'y mettez jamais la valeur de `SEL` ni l'empreinte d'un mot de passe. Elles restent uniquement dans Apps Script.
- Seules les fonctions de vote et de gestion sont accessibles depuis la page, et toutes exigent une connexion. `diagnostic` et `toutEffacer` ne peuvent être lancées que depuis l'éditeur Apps Script.
- Les mots de passe sont stockés sous forme d'empreinte SHA-256 salée. Les délais d'affichage des résultats (5 s pour la Présidence, 11 s pour les autres) sont appliqués par le serveur.
