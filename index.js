// set up UI

const shellPanelStart = document.getElementById("shell-panel-start");
const panelStart = document.getElementById("panel-start");
const actionsStart = shellPanelStart?.querySelectorAll("calcite-action");

actionsStart?.forEach(el => {
  el.addEventListener("click", function(event) {
    if (el.active) {
      el.active = false;
      shellPanelStart.collapsed = true;
      return;
    }
    actionsStart?.forEach(action => (action.active = false));
    el.active = true;
    shellPanelStart.collapsed = false;
    panelStart.heading = el.text;
  });
});

// JSAPI imports & set up

const sceneEl = document.querySelector("arcgis-scene");
const [ImageryTileLayer] = await $arcgis.import(["@arcgis/core/layers/ImageryTileLayer.js"]);
await sceneEl.viewOnReady();
const scene = sceneEl.view;

// search and render logic

const API_URL = "https://planetarycomputer.microsoft.com/api/stac/v1";
const COLLECTIONS_URL = `${API_URL}/collections`;
const COLLECTION_URL = `${COLLECTIONS_URL}/landsat-c2-l2`;
const ITEMS_URL = `${COLLECTION_URL}/items`;

// First, load collection
// Get API url from collection -> use to search
// Get items url from collection
// 

// get all collections
async function getAllCollections() {
  try {
    const response = await fetch(COLLECTIONS_URL);
    console.log(response);
    const data = await response.json();
    console.log(data);
  } catch (error) {
    console.warn("Error fetching collections");
    console.error(error);
  }
}

function renderCollections() {

}

async function getCollection() {

}

async function getitems() {

}

function renderCollection() {

}

getAllCollections();

async function performSearch() {

}

function renderSearchResults() {

}

function addCogToMap() {

}
