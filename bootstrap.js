/* global Zotero, Services */

function log(msg) {
  Zotero.debug(`[AutoTag] ${msg}`);
}

async function startup({ id, version, resourceURI, rootURI }) {
  log(`Starting v${version}`);

  await Zotero.initializationPromise;

  Services.scriptloader.loadSubScript(rootURI + "chrome/content/auto-tag.js");

  Zotero.AutoTag.init({ id, version, rootURI });
}

function shutdown({ id, version, resourceURI, rootURI }) {
  log("Shutting down");

  if (Zotero.AutoTag) {
    Zotero.AutoTag.destroy();
  }

  Zotero.AutoTag = undefined;
}

function install() {
  log("Installed");
}

function uninstall() {
  log("Uninstalled");
}
