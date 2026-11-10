/**
 * Vote secret en direct — Merídio Rouen (Google Apps Script)
 *
 * Deux espaces de connexion :
 *  - Présidence : ouvre / clôt les scrutins, prépare les scrutins à l'avance, voit le détail des votes,
 *                 gère les comptes (Présidence et Députés).
 *  - Député     : vote (un vote par compte et par scrutin), peut changer son mot de passe.
 * Les votes individuels restent sur le serveur ; seuls la Présidence et le député lui-même y ont accès.
 * À la clôture, seul le décompte est conservé ; la Présidence le voit après DELAI_PRESIDENCE_MS,
 * les députés après DELAI_RESULTAT_MS.
 * Les mots de passe ne sont jamais stockés en clair (empreinte SHA-256 salée).
 */

// Compte Présidence permanent (non modifiable depuis la page).
const SEL = 'REMPLACEZ-PAR-UNE-CHAINE-ALEATOIRE';  // ne publiez jamais la vraie valeur
const COMPTES_PERMANENTS = {
  // 'prenom.nom': 'empreinte SHA-256'  ← à remplir uniquement dans votre copie Apps Script, jamais sur GitHub
};
const SIEGES_PAR_DEFAUT = 55;
const DELAI_PRESIDENCE_MS = 5000;  // attente avant que la Présidence voie le résultat
const DELAI_RESULTAT_MS = 11000;   // attente avant que les députés (et visiteurs) voient le résultat
const TITRE = 'Vote Merídio Rouen';

const CHOIX = { pour: true, contre: true, abst: true };
// Groupes politiques (ordre d'affichage). « NI » = non-inscrit.
const PARTIS = ['FCP', 'ROSE', 'VERTS', 'ADL', 'PSR', 'ANF', 'NI'];
function parti_(p) { return PARTIS.indexOf(p) >= 0 ? p : 'NI'; }
const HISTORIQUE_MAX = 40;
const SESSION_H = 12;             // durée d'une connexion, en heures

function doGet() {
  // Accepte le fichier HTML nommé « index » ou « Index ».
  let page;
  try { page = HtmlService.createHtmlOutputFromFile('index'); }
  catch (e) { page = HtmlService.createHtmlOutputFromFile('Index'); }
  return page
    .setTitle(TITRE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ================= API pour la version GitHub Pages =================
 * La page hébergée sur GitHub appelle le serveur par POST : {"fn": "etat", "args": [...]}.
 * Seules les fonctions ci-dessous sont accessibles (diagnostic et toutEffacer restent réservés à l'éditeur).
 */
function api_() {
  return { connexion, deconnexion, etat, voter, ouvrir, clore, annuler, supprimerScrutin, definirSeance,
    changerAffichage, preparer, supprimerPrepare, listerComptes, ajouterCompte, changerMotDePasse,
    importerDeputes, changerPartiDepute, renommerDepute, supprimerCompte, changerMonMotDePasse };
}
function doPost(e) {
  let out;
  try {
    const q = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const f = api_()[q.fn];
    if (typeof f !== 'function') throw new Error('Le serveur ne connaît pas « ' + q.fn + ' » : remplacez Code.gs par la dernière version, puis Déployer → Gérer les déploiements → ✏️ → Nouvelle version.');
    out = { ok: f.apply(null, Array.isArray(q.args) ? q.args : []) };
  } catch (x) { out = { err: String((x && x.message) || x) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ================= Stockage ================= */
function props_() { return PropertiesService.getScriptProperties(); }
function json_(k, def) { try { const v = props_().getProperty(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
function lire_() {
  return {
    courant: json_('courant', null),
    historique: json_('historique', []),
    prepares: json_('prepares', []),
    sieges: Number(props_().getProperty('sieges')) || SIEGES_PAR_DEFAUT,
    affichage: props_().getProperty('affichage') === 'vide' ? 'vide' : 'resultat'
  };
}
function verrou_(fn) {
  const l = LockService.getScriptLock();
  l.waitLock(15000);
  try { return fn(); } finally { l.releaseLock(); }
}
function uid_(p) { return p + Date.now().toString(36) + Math.floor(Math.random() * 1e8).toString(36); }

/* ================= Comptes et sessions ================= */
function normId_(id) { return String(id || '').trim().toLowerCase(); }
function empreinte_(role, id, mdp) {
  // Le compte permanent garde son empreinte d'origine (sans rôle).
  const base = role === 'p' ? SEL + '\n' + normId_(id) + '\n' + String(mdp || '') : SEL + '\nD\n' + normId_(id) + '\n' + String(mdp || '');
  const b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, base, Utilities.Charset.UTF_8);
  return b.map(x => ((x + 256) % 256).toString(16).padStart(2, '0')).join('');
}
function presidentsAjoutes_() { return json_('comptes', {}); }
function presidents_() { return Object.assign({}, presidentsAjoutes_(), COMPTES_PERMANENTS); }
function depute_(id) { return json_('d|' + normId_(id), null); }
function deputes_() {
  const all = props_().getProperties(), out = {};
  for (const k in all) if (k.indexOf('d|') === 0) { try { out[k.slice(2)] = JSON.parse(all[k]); } catch (e) {} }
  return out;
}
function nomDepute_(id, d) { return (d && d.nom) || id; }
function verifMdp_(m) { if (String(m || '').length < 8) throw new Error('Mot de passe : 8 caractères minimum.'); }
function verifId_(k) { if (!/^[a-z0-9._-]{3,40}$/.test(k)) throw new Error('Identifiant : 3 à 40 caractères (lettres, chiffres, point, tiret).'); }

/* Sessions stockées dans les Propriétés du script (plus fiables que le cache). */
function cleSession_(jeton) { return 'sess|' + String(jeton || '').replace(/[^a-f0-9]/gi, '').slice(0, 80); }
/** Retrouve la session ; role attendu : 'p' (Présidence), 'd' (Député) ou null (n'importe). */
function session_(jeton, role) {
  const key = cleSession_(jeton);
  const x = jeton && key.length > 10 ? json_(key, null) : null;
  const fin = () => { if (role) throw new Error('SESSION: Session expirée, reconnectez-vous.'); return null; };
  if (!x || !(x.exp > Date.now())) { if (x) props_().deleteProperty(key); return fin(); }
  // Compte supprimé entre-temps ?
  if ((x.r === 'p' && !presidents_()[x.id]) || (x.r === 'd' && !depute_(x.id))) { props_().deleteProperty(key); return fin(); }
  if (role && x.r !== role) throw new Error('Action réservée à ' + (role === 'p' ? 'la Présidence.' : 'un député.'));
  return x;
}
function nettoyerSessions_() {
  const all = props_().getProperties(), now = Date.now();
  for (const k in all) if (k.indexOf('sess|') === 0) { try { if (!(JSON.parse(all[k]).exp > now)) props_().deleteProperty(k); } catch (e) { props_().deleteProperty(k); } }
}

/** Connexion à l'espace 'p' (Présidence) ou 'd' (Député). */
function connexion(role, id, mdp) {
  role = role === 'p' ? 'p' : 'd';
  const k = normId_(id);
  let ok = false, nom = k;
  if (role === 'p') { const c = presidents_(); ok = !!c[k] && c[k] === empreinte_('p', k, mdp); }
  else { const d = depute_(k); ok = !!d && d.h === empreinte_('d', k, mdp); if (d) nom = nomDepute_(k, d); }
  if (!ok) { Utilities.sleep(800); throw new Error('Identifiant ou mot de passe incorrect.'); }
  const jeton = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  nettoyerSessions_();
  props_().setProperty(cleSession_(jeton), JSON.stringify({ r: role, id: k, exp: Date.now() + SESSION_H * 3600 * 1000 }));
  return { jeton, role, id: k, nom };
}
function deconnexion(jeton) { if (jeton) props_().deleteProperty(cleSession_(jeton)); return true; }

/* ================= Décompte ================= */
function prefixe_(sid) { return 'v|' + sid + '|'; }
function votes_(sid) {
  const all = props_().getProperties(), pre = prefixe_(sid), out = [];
  for (const k in all) if (k.indexOf(pre) === 0) { try { const v = JSON.parse(all[k]); out.push({ id: k.slice(pre.length), c: v.c, t: v.t }); } catch (e) {} }
  return out;
}
function effacerVotes_(sid) {
  const p = props_(), all = p.getProperties(), pre = prefixe_(sid);
  for (const k in all) if (k.indexOf(pre) === 0) p.deleteProperty(k);
}
function decompte_(votes, sieges) {
  const t = { pour: 0, contre: 0, abst: 0 };
  votes.forEach(v => { if (t[v.c] != null) t[v.c]++; });
  const votants = t.pour + t.contre + t.abst, exprimes = t.pour + t.contre;
  const majorite = exprimes ? Math.floor(exprimes / 2) + 1 : 0;
  return { pour: t.pour, contre: t.contre, abst: t.abst, votants, exprimes, majorite,
    sieges: Math.max(Number(sieges) || 0, votants), adopte: exprimes > 0 && t.pour >= majorite };
}

/** Répartition des votes par groupe (réservée à la Présidence). */
function parPartis_(votes, dep) {
  const t = {};
  PARTIS.forEach(p => { t[p] = { p, membres: 0, pour: 0, contre: 0, abst: 0 }; });
  for (const id in dep) t[parti_(dep[id].parti)].membres++;
  votes.forEach(v => { const p = parti_(dep[v.id] && dep[v.id].parti); if (t[p][v.c] != null) t[p][v.c]++; });
  return PARTIS.map(p => t[p]).filter(x => x.membres || x.pour || x.contre || x.abst);
}

/** Adresse /exec de l'application (pour l'ouvrir seule, en plein écran). */
function urlApp_() { try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; } }

/* ================= État ================= */
/** Masque le résultat des scrutins clos depuis moins de `delai` ms. */
function masquer_(historique, delai, now) {
  return historique.map(h => {
    const fin = Date.parse(h.closAt) + delai;
    return fin > now ? { id: h.id, num: h.num, objet: h.objet, closAt: h.closAt, res: null, dans: fin - now } : h;
  });
}
/** État selon la personne connectée (ou un visiteur non connecté). */
function etat(jeton) {
  const s = session_(jeton, null);
  const e = lire_(), now = Date.now();
  const out = { courant: e.courant, sieges: e.sieges, affichage: e.affichage, moi: null, url: urlApp_(), seance: json_('seance', null) };
  if (s) {
    const d = s.r === 'd' ? depute_(s.id) : null;
    out.moi = { role: s.r, id: s.id, nom: d ? nomDepute_(s.id, d) : s.id };
    if (d) out.moi.parti = parti_(d.parti);
  }
  if (s && s.r === 'p') {
    out.historique = masquer_(e.historique, DELAI_PRESIDENCE_MS, now);
    out.prepares = e.prepares;
    out.votes = []; out.res = null;
    if (e.courant) {
      const dep = deputes_();
      const v = votes_(e.courant.id);
      out.votes = v.map(x => ({ nom: nomDepute_(x.id, dep[x.id]), parti: parti_(dep[x.id] && dep[x.id].parti), c: x.c }));
      out.res = decompte_(v, e.courant.sieges);
      out.partis = parPartis_(v, dep);
    }
    out.prochainNum = numerosUtilises_(e).reduce((m, n) => Math.max(m, n), 0) + 1;
    return out;
  }
  // Députés et visiteurs : le résultat n'apparaît qu'après DELAI_RESULTAT_MS.
  out.historique = masquer_(e.historique, DELAI_RESULTAT_MS, now).map(h => { const c = Object.assign({}, h); delete c.partis; return c; });
  if (s && s.r === 'd' && e.courant) {
    const v = props_().getProperty(prefixe_(e.courant.id) + s.id);
    out.monVote = v ? JSON.parse(v).c : null;
  }
  return out;
}

/* ================= Député : voter ================= */
function voter(jeton, choix, sid) {
  const s = session_(jeton, 'd');
  if (!CHOIX[choix]) throw new Error('Choix invalide.');
  return verrou_(() => {
    const e = lire_();
    if (!e.courant || e.courant.id !== sid) throw new Error('Ce scrutin est clos.');
    props_().setProperty(prefixe_(sid) + s.id, JSON.stringify({ c: choix, t: Date.now() }));
    return { monVote: choix };
  });
}

/* ================= Présidence : scrutins ================= */
function numerosUtilises_(e, saufId) {
  const n = [];
  e.historique.forEach(h => n.push(h.num));
  e.prepares.forEach(p => { if (p.id !== saufId) n.push(p.num); });
  if (e.courant && e.courant.id !== saufId) n.push(e.courant.num);
  return n.map(Number).filter(x => x > 0);
}
function lireScrutin_(d, e, saufId) {
  const num = parseInt(d && d.num, 10);
  const objet = String((d && d.objet) || '').trim().slice(0, 160);
  const sieges = Math.max(1, Math.min(999, parseInt(d && d.sieges, 10) || e.sieges || SIEGES_PAR_DEFAUT));
  if (!(num > 0 && num < 100000)) throw new Error('Indiquez le numéro du scrutin.');
  if (!objet) throw new Error('Indiquez l’objet du scrutin.');
  if (numerosUtilises_(e, saufId).indexOf(num) >= 0) throw new Error('Le scrutin n° ' + num + ' existe déjà.');
  return { num, objet, sieges };
}

/** Ouvre un scrutin : soit directement (d = {num, objet, sieges}), soit un scrutin préparé (d = {pid}). */
function ouvrir(jeton, d) {
  session_(jeton, 'p');
  return verrou_(() => {
    const e = lire_();
    if (e.courant) throw new Error('Un scrutin est déjà ouvert : clôturez-le d’abord.');
    let s, prepares = e.prepares;
    if (d && d.pid) {
      const p = e.prepares.find(x => x.id === d.pid);
      if (!p) throw new Error('Scrutin préparé introuvable.');
      s = lireScrutin_(p, e, p.id);
      prepares = e.prepares.filter(x => x.id !== d.pid);
    } else s = lireScrutin_(d, e, null);
    const courant = Object.assign({ id: uid_('s'), ouvertAt: new Date().toISOString() }, s);
    props_().setProperties({ courant: JSON.stringify(courant), prepares: JSON.stringify(prepares), sieges: String(s.sieges) });
    return etat(jeton);
  });
}
function clore(jeton) {
  session_(jeton, 'p');
  return verrou_(() => {
    const e = lire_();
    if (!e.courant) throw new Error('Aucun scrutin ouvert.');
    const v = votes_(e.courant.id);
    const res = decompte_(v, e.courant.sieges);
    const partis = parPartis_(v, deputes_());
    const h = [{ id: e.courant.id, num: e.courant.num, objet: e.courant.objet, closAt: new Date().toISOString(), res, partis }].concat(e.historique).slice(0, HISTORIQUE_MAX);
    props_().setProperties({ historique: JSON.stringify(h), affichage: 'resultat' });
    props_().deleteProperty('courant');
    effacerVotes_(e.courant.id);
    return etat(jeton);
  });
}
/** Annule le scrutin ouvert ; il retourne dans les scrutins préparés. */
function annuler(jeton) {
  session_(jeton, 'p');
  return verrou_(() => {
    const e = lire_();
    if (e.courant) {
      effacerVotes_(e.courant.id);
      const p = [{ id: uid_('p'), num: e.courant.num, objet: e.courant.objet, sieges: e.courant.sieges }].concat(e.prepares);
      props_().setProperty('prepares', JSON.stringify(p));
      props_().deleteProperty('courant');
    }
    return etat(jeton);
  });
}
function supprimerScrutin(jeton, sid) {
  session_(jeton, 'p');
  return verrou_(() => {
    props_().setProperty('historique', JSON.stringify(lire_().historique.filter(s => s.id !== sid)));
    return etat(jeton);
  });
}
/**
 * Prochaine séance annoncée à tous (d = { date: 'AAAA-MM-JJ', heure: 'HH:MM', lieu, titre, odj }), ou null pour l'effacer.
 * odj = ordre du jour : un point par ligne (texte) ou une liste. La date et l'heure sont gardées telles que saisies (heure de Paris).
 */
function definirSeance(jeton, d) {
  session_(jeton, 'p');
  if (!d) { props_().deleteProperty('seance'); return etat(jeton); }
  const date = String(d.date || ''), heure = String(d.heure || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Indiquez la date de la séance.');
  if (heure && !/^\d{2}:\d{2}$/.test(heure)) throw new Error('Heure invalide.');
  const odj = (Array.isArray(d.odj) ? d.odj : String(d.odj || '').split(/\r?\n/))
    .map(x => String(x).trim().replace(/^(\d+[.)]|[-–•*])\s*/, '')).filter(Boolean);
  if (odj.length > 25) throw new Error('Ordre du jour : 25 points maximum.');
  const long = odj.findIndex(x => x.length > 500);
  if (long >= 0) throw new Error('Ordre du jour : le point ' + (long + 1) + ' dépasse 500 caractères.');
  const val = JSON.stringify({
    date, heure,
    lieu: String(d.lieu || '').trim().slice(0, 120),
    titre: String(d.titre || '').trim().slice(0, 160),
    odj
  });
  // Une Propriété du script est limitée à 9 Ko.
  if (Utilities.newBlob(val).getBytes().length > 8800) throw new Error('Ordre du jour trop long : raccourcissez quelques points.');
  props_().setProperty('seance', val);
  return etat(jeton);
}
function changerAffichage(jeton, mode) {
  session_(jeton, 'p');
  props_().setProperty('affichage', mode === 'vide' ? 'vide' : 'resultat');
  return etat(jeton);
}

/** Ajoute (d.pid vide) ou modifie (d.pid) un scrutin préparé. */
function preparer(jeton, d) {
  session_(jeton, 'p');
  return verrou_(() => {
    const e = lire_();
    const s = lireScrutin_(d, e, d && d.pid ? d.pid : null);
    let p = e.prepares.slice();
    if (d && d.pid) {
      const i = p.findIndex(x => x.id === d.pid);
      if (i < 0) throw new Error('Scrutin préparé introuvable.');
      p[i] = Object.assign({ id: d.pid }, s);
    } else p.push(Object.assign({ id: uid_('p') }, s));
    p.sort((a, b) => a.num - b.num);
    props_().setProperty('prepares', JSON.stringify(p.slice(0, 80)));
    return etat(jeton);
  });
}
function supprimerPrepare(jeton, pid) {
  session_(jeton, 'p');
  return verrou_(() => {
    props_().setProperty('prepares', JSON.stringify(lire_().prepares.filter(x => x.id !== pid)));
    return etat(jeton);
  });
}

/* ================= Comptes ================= */
function listerComptes(jeton) {
  const s = session_(jeton, 'p');
  const dep = deputes_();
  return {
    presidence: Object.keys(presidents_()).sort().map(k => ({ id: k, permanent: k in COMPTES_PERMANENTS, moi: k === s.id })),
    deputes: Object.keys(dep).sort((a, b) => PARTIS.indexOf(parti_(dep[a].parti)) - PARTIS.indexOf(parti_(dep[b].parti)) || nomDepute_(a, dep[a]).localeCompare(nomDepute_(b, dep[b]), 'fr')).map(k => ({ id: k, nom: dep[k].nom || '', parti: parti_(dep[k].parti) })),
    partis: PARTIS
  };
}
/** role : 'p' ou 'd'. nom : nom affiché et parti (députés). */
function ajouterCompte(jeton, role, id, nom, mdp, parti) {
  session_(jeton, 'p');
  const k = normId_(id); verifId_(k); verifMdp_(mdp);
  return verrou_(() => {
    if (role === 'p') {
      if (k in COMPTES_PERMANENTS) throw new Error('Ce compte existe déjà.');
      const c = presidentsAjoutes_();
      if (c[k]) throw new Error('Ce compte existe déjà : utilisez « Mot de passe ».');
      c[k] = empreinte_('p', k, mdp);
      props_().setProperty('comptes', JSON.stringify(c));
    } else {
      if (depute_(k)) throw new Error('Ce député existe déjà : utilisez « Mot de passe ».');
      if (PARTIS.indexOf(parti) < 0) throw new Error('Choisissez le parti du député.');
      props_().setProperty('d|' + k, JSON.stringify({ h: empreinte_('d', k, mdp), nom: String(nom || '').trim().slice(0, 60), parti }));
    }
    return listerComptes(jeton);
  });
}
function changerMotDePasse(jeton, role, cible, mdp) {
  session_(jeton, 'p');
  const k = normId_(cible); verifMdp_(mdp);
  return verrou_(() => {
    if (role === 'p') {
      if (k in COMPTES_PERMANENTS) throw new Error('Compte permanent : son mot de passe se modifie dans Code.gs.');
      const c = presidentsAjoutes_();
      if (!c[k]) throw new Error('Compte introuvable.');
      c[k] = empreinte_('p', k, mdp);
      props_().setProperty('comptes', JSON.stringify(c));
    } else {
      const d = depute_(k); if (!d) throw new Error('Député introuvable.');
      d.h = empreinte_('d', k, mdp);
      props_().setProperty('d|' + k, JSON.stringify(d));
    }
    return listerComptes(jeton);
  });
}
/**
 * Import en masse (fichier Excel lu dans le navigateur).
 * rows : [{ id, nom, parti, mdp }] — les comptes existants sont ignorés, jamais écrasés.
 */
function importerDeputes(jeton, rows) {
  session_(jeton, 'p');
  if (!Array.isArray(rows) || !rows.length) throw new Error('Aucune ligne à importer.');
  if (rows.length > 400) throw new Error('400 comptes maximum par import.');
  return verrou_(() => {
    const existants = deputes_(), aEcrire = {}, ignores = [];
    rows.forEach(r => {
      const k = normId_(r && r.id), parti = r && r.parti, mdp = String((r && r.mdp) || '');
      if (!/^[a-z0-9._-]{3,40}$/.test(k)) { ignores.push({ id: k || '?', raison: 'identifiant invalide' }); return; }
      if (existants[k] || aEcrire['d|' + k]) { ignores.push({ id: k, raison: 'existe déjà' }); return; }
      if (mdp.length < 8) { ignores.push({ id: k, raison: 'date de naissance manquante' }); return; }
      aEcrire['d|' + k] = JSON.stringify({ h: empreinte_('d', k, mdp), nom: String((r && r.nom) || '').trim().slice(0, 60), parti: parti_(parti) });
    });
    if (Object.keys(aEcrire).length) props_().setProperties(aEcrire);
    return { crees: Object.keys(aEcrire).length, ignores, comptes: listerComptes(jeton) };
  });
}
function changerPartiDepute(jeton, cible, parti) {
  session_(jeton, 'p');
  if (PARTIS.indexOf(parti) < 0) throw new Error('Parti inconnu.');
  const k = normId_(cible), d = depute_(k);
  if (!d) throw new Error('Député introuvable.');
  d.parti = parti;
  props_().setProperty('d|' + k, JSON.stringify(d));
  return listerComptes(jeton);
}
function renommerDepute(jeton, cible, nom) {
  session_(jeton, 'p');
  const k = normId_(cible), d = depute_(k);
  if (!d) throw new Error('Député introuvable.');
  d.nom = String(nom || '').trim().slice(0, 60);
  props_().setProperty('d|' + k, JSON.stringify(d));
  return listerComptes(jeton);
}
function supprimerCompte(jeton, role, cible) {
  const s = session_(jeton, 'p');
  const k = normId_(cible);
  return verrou_(() => {
    if (role === 'p') {
      if (k in COMPTES_PERMANENTS) throw new Error('Ce compte est permanent.');
      if (k === s.id) throw new Error('Vous ne pouvez pas supprimer votre propre compte.');
      const c = presidentsAjoutes_(); delete c[k];
      props_().setProperty('comptes', JSON.stringify(c));
    } else props_().deleteProperty('d|' + k);
    return listerComptes(jeton);
  });
}
/** Chacun (Présidence ajoutée ou Député) change son propre mot de passe, ancien mot de passe exigé. */
function changerMonMotDePasse(jeton, ancien, nouveau) {
  const s = session_(jeton, null);
  if (!s) throw new Error('SESSION: Session expirée, reconnectez-vous.');
  verifMdp_(nouveau);
  return verrou_(() => {
    if (s.r === 'p') {
      if (s.id in COMPTES_PERMANENTS) throw new Error('Compte permanent : son mot de passe se modifie dans Code.gs.');
      const c = presidentsAjoutes_();
      if (c[s.id] !== empreinte_('p', s.id, ancien)) { Utilities.sleep(800); throw new Error('Mot de passe actuel incorrect.'); }
      c[s.id] = empreinte_('p', s.id, nouveau);
      props_().setProperty('comptes', JSON.stringify(c));
    } else {
      const d = depute_(s.id);
      if (!d || d.h !== empreinte_('d', s.id, ancien)) { Utilities.sleep(800); throw new Error('Mot de passe actuel incorrect.'); }
      d.h = empreinte_('d', s.id, nouveau);
      props_().setProperty('d|' + s.id, JSON.stringify(d));
    }
    return true;
  });
}

/**
 * DIAGNOSTIC — à lancer depuis l'éditeur (menu déroulant des fonctions → diagnostic → Exécuter),
 * puis lire le « Journal d'exécution » en bas. N'affiche aucun mot de passe.
 */
function diagnostic() {
  const all = props_().getProperties(), keys = Object.keys(all);
  const n = p => keys.filter(k => k.indexOf(p) === 0).length;
  let taille = 0; keys.forEach(k => { taille += k.length + String(all[k]).length; });
  console.log('Propriétés : ' + keys.length + ' (≈ ' + Math.round(taille / 1024) + ' Ko sur 500 Ko)');
  console.log('Députés : ' + n('d|') + ' · Sessions : ' + n('sess|') + ' · Votes en cours : ' + n('v|'));
  console.log('Comptes Présidence ajoutés : ' + Object.keys(presidentsAjoutes_()).length);
  try { const e = etat(''); console.log('etat() OK — scrutin ouvert : ' + (e.courant ? 'oui' : 'non') + ' · historique : ' + e.historique.length); }
  catch (x) { console.log('ERREUR etat() : ' + x.message); }
  try { const d = deputes_(); const parPartis = {}; Object.keys(d).forEach(k => { const p = parti_(d[k].parti); parPartis[p] = (parPartis[p] || 0) + 1; }); console.log('Députés par parti : ' + JSON.stringify(parPartis)); }
  catch (x) { console.log('ERREUR lecture des députés : ' + x.message); }
  keys.filter(k => k.indexOf('d|') === 0).forEach(k => { try { JSON.parse(all[k]); } catch (x) { console.log('Compte illisible : ' + k); } });
}

/** À lancer à la main depuis l'éditeur pour repartir de zéro (efface scrutins ET comptes ajoutés). */
function toutEffacer() { props_().deleteAllProperties(); }
