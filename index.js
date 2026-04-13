// set up UI

const shellcollectionsPanel = document.getElementById("shell-panel-start");
const collectionsPanel = document.getElementById("collections-panel");
const itemPanel = document.getElementById("item-panel");
const itemPanelContent = document.getElementById("item-panel-content");
const searchPanel = document.getElementById("search-panel");
const actionsStart = shellcollectionsPanel?.querySelectorAll("calcite-action");

const backPanelMap = new Map();
const collectionItemStateMap = new WeakMap();
const itemLayerSourceMap = new WeakMap();

function showStartPanel(panelToShow, sourcePanel) {
  [collectionsPanel, itemPanel, searchPanel].forEach(panel => {
    panel.toggleAttribute("closed", panel !== panelToShow);
  });

  if (sourcePanel) {
    const controller = new AbortController()
    panelToShow.addEventListener("calcitePanelClose", () => {
      showStartPanel(sourcePanel);
      controller.abort();
      backPanelMap.delete(panelToShow);
    }, { signal: controller.signal });
    backPanelMap.set(panelToShow, controller);
  }
  else {
    backPanelMap.forEach((controller, panel) => {
      controller.abort();
    });
    backPanelMap.clear();
  }

  syncVisibleBboxGraphics();
}

actionsStart?.forEach(el => {
  el.addEventListener("click", function(event) {
    const { text } = el;

    if (el.active) {
      if (text === "Collections" && itemPanel && !itemPanel.hasAttribute("closed")) {
        showStartPanel(collectionsPanel);
        return;
      }

      el.active = false;
      shellcollectionsPanel.collapsed = true;
      syncVisibleBboxGraphics();
      return;
    }

    actionsStart?.forEach(action => (action.active = false));
    el.active = true;
    shellcollectionsPanel.collapsed = false;

    if (text === "Collections") {
      showStartPanel(collectionsPanel);
    }
    else if (text === "Search") {
      showStartPanel(searchPanel);
    }
  });
});

function setPanelLoading(panel, isLoading) {
  if (isLoading) {
    panel.setAttribute("loading", "");
  } else {
    panel.removeAttribute("loading");
  }
}

function setLoading(isLoading) {
  setPanelLoading(collectionsPanel, isLoading);
}

// JSAPI imports & set up

const sceneEl = document.querySelector("arcgis-scene");
const [ImageryTileLayer, Graphic] = await $arcgis.import([
  "@arcgis/core/layers/ImageryTileLayer.js",
  "@arcgis/core/Graphic.js"
]);
await sceneEl.viewOnReady();
const scene = sceneEl.view;
let currentItemPageFeatures = [];
let currentItemPageGraphics = [];
let currentItemPageCollectionItem = null;
let currentSelectedItemFeature = null;
let currentSelectedItemGraphic = null;

// search and render logic

// CAPELLA OPEN DATA API AND HELPS
const CAPELLA_API_URL = "https://capella-open-data.s3.us-west-2.amazonaws.com/stac";


// MICROSOFT PLANETARY COMPUTER STAC API ENDPOINTS AND HELPERS
const API_URL = "https://planetarycomputer.microsoft.com/api/stac/v1";
const TOKEN_URL = "https://planetarycomputer.microsoft.com/api/sas/v1";
const COLLECTIONS_URL = `${API_URL}/collections`;
const COLLECTION_URL = `${COLLECTIONS_URL}/landsat-c2-l2`;
const ITEMS_URL = `${COLLECTION_URL}/items`;
const COLLECTIONS_PAGE_SIZE = 25;
const ITEMS_PAGE_SIZE = 10;
const ITEMS_FETCH_LIMIT = ITEMS_PAGE_SIZE;

function truncateText(text, maxLength) {
  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength).trimEnd()}...`;
}

function getCollectionKey(collection) {
  return collection.id || collection.title || "unknown-collection";
}

function getCollectionLabel(collection) {
  return collection.title || collection.id || "Untitled collection";
}

function getCollectionDescription(collection) {
  return collection["msft:short_description"] ||
    truncateText(collection.description, 80) ||
    "No description";
}

function getStacItemDescription(item) {
  return truncateText(
    item.properties?.description ||
      item.properties?.datetime ||
      item.collection ||
      "",
    80
  ) || "No description";
}

function getLinkHref(links, rel) {
  const rels = Array.isArray(rel) ? rel : [rel];
  return links?.find(link => rels.includes(link.rel))?.href || null;
}

function formatDisplayValue(value) {
  if (value == null || value === "") {
    return "Unavailable";
  }

  if (Array.isArray(value)) {
    return value.join(", ");
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function normalizeHref(href) {
  if (!href) {
    return null;
  }

  try {
    return new URL(href, window.location.href).href;
  } catch {
    return href;
  }
}

function getAssetHref(asset) {
  return normalizeHref(asset?.href);
}

function isTiffAsset(asset) {
  return Boolean(getAssetHref(asset)) && asset?.type?.toLowerCase().includes("image/tiff");
}

function getAssetDescription(asset) {
  return formatDisplayValue(asset?.description || asset?.type || asset?.href);
}

function getAssetLayerSource(asset) {
  const href = getAssetHref(asset);

  if (!href) {
    return null;
  }

  return {
    key: href
  };
}

function findAddedItemLayer(source) {
  if (!source?.key || !scene.map?.layers) {
    return null;
  }

  return scene.map.layers.find(layer => {
    const trackedKey = itemLayerSourceMap.get(layer);

    if (trackedKey === source.key) {
      return true;
    }

    const layerUrl = normalizeHref(layer.url);
    return layerUrl === source.key || layerUrl?.startsWith(`${source.key}?`);
  }) || null;
}

function updateAssetAction(action) {
  const sourceKey = action.dataset.assetHref;

  if (!sourceKey) {
    return;
  }

  const existingLayer = findAddedItemLayer({ key: sourceKey });
  action.icon = existingLayer ? "minus" : "plus";
  action.label = existingLayer ? "Remove imagery layer" : "Add imagery layer";
}

function removeAddedItemLayer(source) {
  const existingLayer = findAddedItemLayer(source);

  if (!existingLayer || !scene.map) {
    return false;
  }

  itemLayerSourceMap.delete(existingLayer);
  scene.map.remove(existingLayer);
  return true;
}

function syncAssetListActions() {
  itemPanelContent
    ?.querySelectorAll("calcite-action[data-asset-href]")
    .forEach(updateAssetAction);
}

scene.map?.layers?.on("change", () => {
  syncAssetListActions();
});

function isCollectionsPanelVisible() {
  return !collectionsPanel.hasAttribute("closed") && !shellcollectionsPanel.collapsed;
}

function isItemPanelVisible() {
  return !itemPanel.hasAttribute("closed") && !shellcollectionsPanel.collapsed;
}

function getBboxBounds(bbox) {
  if (!Array.isArray(bbox)) {
    return null;
  }

  if (bbox.length >= 6) {
    return {
      xmin: bbox[0],
      ymin: bbox[1],
      xmax: bbox[3],
      ymax: bbox[4]
    };
  }

  if (bbox.length >= 4) {
    return {
      xmin: bbox[0],
      ymin: bbox[1],
      xmax: bbox[2],
      ymax: bbox[3]
    };
  }

  return null;
}

function createBboxGraphic(feature) {
  const bbox = getBboxBounds(feature.bbox);

  if (!bbox) {
    return null;
  }

  return new Graphic({
    attributes: {
      id: feature.id || ""
    },
    geometry: {
      type: "polyline",
      paths: [[
        [bbox.xmin, bbox.ymin],
        [bbox.xmax, bbox.ymin],
        [bbox.xmax, bbox.ymax],
        [bbox.xmin, bbox.ymax],
        [bbox.xmin, bbox.ymin]
      ]],
      spatialReference: {
        wkid: 4326
      }
    },
    symbol: {
      type: "simple-line",
      color: [255, 165, 0, 1],
      width: 2
    }
  });
}

function clearCurrentItemPageGraphics() {
  if (!currentItemPageGraphics.length) {
    return;
  }

  scene.graphics.removeMany(currentItemPageGraphics);
  currentItemPageGraphics = [];
}

function clearCurrentSelectedItemGraphic() {
  if (!currentSelectedItemGraphic) {
    return;
  }

  scene.graphics.remove(currentSelectedItemGraphic);
  currentSelectedItemGraphic = null;
}

function goToGraphics(target) {
  void scene.goTo(target).catch(error => {
    if (error?.name !== "AbortError") {
      console.error(error);
    }
  });
}

function syncVisibleBboxGraphics() {
  clearCurrentItemPageGraphics();
  clearCurrentSelectedItemGraphic();

  if (isItemPanelVisible() && currentSelectedItemFeature) {
    currentSelectedItemGraphic = createBboxGraphic(currentSelectedItemFeature);

    if (!currentSelectedItemGraphic) {
      return;
    }

    scene.graphics.add(currentSelectedItemGraphic);
    goToGraphics(currentSelectedItemGraphic);
    return;
  }

  if (!isCollectionsPanelVisible() || !currentItemPageFeatures.length) {
    return;
  }

  currentItemPageGraphics = currentItemPageFeatures
    .map(createBboxGraphic)
    .filter(Boolean);

  if (!currentItemPageGraphics.length) {
    return;
  }

  scene.graphics.addMany(currentItemPageGraphics);
  goToGraphics(currentItemPageGraphics);
}

function syncCurrentItemPageGraphics() {
  syncVisibleBboxGraphics();
}

function setCurrentItemPageFeatures(features, collectionItem = null) {
  currentItemPageCollectionItem = collectionItem;
  currentItemPageFeatures = features.filter(feature => Boolean(getBboxBounds(feature.bbox)));
  syncVisibleBboxGraphics();
}

function clearCurrentItemPageFeatures(collectionItem = null) {
  if (collectionItem && currentItemPageCollectionItem !== collectionItem) {
    return;
  }

  currentItemPageCollectionItem = null;
  currentItemPageFeatures = [];
  syncVisibleBboxGraphics();
}

function setCurrentSelectedItemFeature(feature) {
  currentSelectedItemFeature = feature && getBboxBounds(feature.bbox) ? feature : null;
  syncVisibleBboxGraphics();
}

function getItemsPaginationState(itemsGroupState) {
  const startItem = ((itemsGroupState.currentPage - 1) * ITEMS_PAGE_SIZE) + 1;
  const currentPageItemCount = itemsGroupState.nextHref
    ? ITEMS_PAGE_SIZE
    : Math.max(itemsGroupState.items.length, 1);

  return {
    startItem,
    totalItems: startItem + currentPageItemCount - 1 + (itemsGroupState.nextHref ? 1 : 0)
  };
}

function createMessageListItem(label, description) {
  const item = document.createElement("calcite-list-item");
  item.label = label;
  item.description = description;
  item.disabled = true;
  return item;
}

function createReadOnlyListItem(label, description) {
  const item = document.createElement("calcite-list-item");
  item.label = label;
  item.description = description;
  return item;
}

function createAssetListItem(assetKey, asset, item) {
  const itemElement = createReadOnlyListItem(asset.title || assetKey, getAssetDescription(asset));

  if (!isTiffAsset(asset)) {
    return itemElement;
  }

  const action = document.createElement("calcite-action");
  const layerSource = getAssetLayerSource(asset);

  if (!layerSource) {
    return itemElement;
  }

  action.slot = "actions-end";
  action.dataset.assetHref = layerSource.key;
  action.scale = "s";
  updateAssetAction(action);

  action.addEventListener("click", async event => {
    event.stopPropagation();

    if (action.disabled || !scene.map) {
      return;
    }

    action.disabled = true;

    try {
      if (!removeAddedItemLayer(layerSource)) {
        await addAssetToMap(item, asset, assetKey);
      }
    } catch (error) {
      console.error(error);
    } finally {
      action.disabled = false;
      updateAssetAction(action);
    }
  });

  itemElement.append(action);
  return itemElement;
}

function createAssetList(item) {
  const assetEntries = Object.entries(item.assets ?? {});
  const assetList = document.createElement("calcite-list");
  const assetsGroup = document.createElement("calcite-list-item-group");

  assetList.className = "item-assets-list";
  assetList.label = `${item.id || "Item"} assets`;
  assetList.interactionMode = "static";

  assetsGroup.heading = `Assets (${assetEntries.length})`;
  assetsGroup.replaceChildren(
    ...(assetEntries.length
      ? assetEntries.map(([assetKey, asset]) => createAssetListItem(assetKey, asset, item))
      : [createMessageListItem("No assets found", "This item does not include assets.")])
  );

  assetList.replaceChildren(assetsGroup);
  return assetList;
}

function renderItem(item) {
  const thumbnailLink = item.assets?.rendered_preview?.href || getLinkHref(item.links, "preview");
  const img = document.createElement("img");
  img.alt = `${item.id} thumbnail`;
  img.className = "item-preview-image";
  img.decoding = "async";
  img.loading = "lazy";
  img.src = thumbnailLink || "";

  const itemDetailsList = document.createElement("calcite-list");
  const detailsGroup = document.createElement("calcite-list-item-group");
  const assetEntries = Object.entries(item.assets ?? {});
  const assetList = createAssetList(item);

  itemPanel.heading = item.id || "Item";
  itemPanel.description = item.collection || "";

  itemDetailsList.label = `${item.id || "Item"} details`;
  itemDetailsList.interactionMode = "static";

  detailsGroup.heading = "Details";
  detailsGroup.replaceChildren(
    createReadOnlyListItem("Collection", formatDisplayValue(item.collection)),
    createReadOnlyListItem("Datetime", formatDisplayValue(item.properties?.datetime)),
    createReadOnlyListItem("Description", formatDisplayValue(item.properties?.description || item.description)),
    createReadOnlyListItem("EPSG", formatDisplayValue(item.properties?.["proj:epsg"])),
    createReadOnlyListItem("Cloud cover", formatDisplayValue(item.properties?.["eo:cloud_cover"])),
    createReadOnlyListItem("Assets", String(assetEntries.length))
  );

  itemDetailsList.replaceChildren(detailsGroup);
  itemPanelContent.replaceChildren(...(thumbnailLink ? [img] : []), itemDetailsList, assetList);
  syncAssetListActions();
  itemPanel.scrollContentTo({ top: 0 });
}

function createStacItemListItem(stacItem, collection) {
  const item = document.createElement("calcite-list-item");
  item.label = stacItem.id || "Untitled item";
  item.description = getStacItemDescription(stacItem);
  item.value = stacItem.id || "";

  item.addEventListener("click", async event => {
    event.stopPropagation();

    setCurrentSelectedItemFeature(null);
    showStartPanel(itemPanel, collectionsPanel);
    itemPanel.heading = stacItem.id || "Item";
    itemPanel.description = collection.id || "";
    itemPanelContent.replaceChildren();
    setPanelLoading(itemPanel, true);

    try {
      const itemData = await getItem(collection, stacItem);
      setCurrentSelectedItemFeature(itemData);
      renderItem(itemData);
    } finally {
      setPanelLoading(itemPanel, false);
    }
  });

  return item;
}

function renderItemsGroupPage(itemsGroupState) {
  const itemElements = itemsGroupState.items.length
    ? itemsGroupState.items.map(stacItem => createStacItemListItem(stacItem, itemsGroupState.collection))
    : [createMessageListItem("No items found", "This collection returned no items.")];
  const paginationState = getItemsPaginationState(itemsGroupState);

  itemsGroupState.currentStartItem = paginationState.startItem;
  itemsGroupState.pagination.startItem = paginationState.startItem;
  itemsGroupState.pagination.totalItems = paginationState.totalItems;
  itemsGroupState.itemGroup.replaceChildren(...itemElements, itemsGroupState.pagination);
}

function updateItemsGroupState(itemsGroupState, pageData) {
  itemsGroupState.currentPage = Math.max(itemsGroupState.currentPage, 1);
  itemsGroupState.items = pageData.items;
  itemsGroupState.nextHref = pageData.nextHref;
  itemsGroupState.prevHref = pageData.prevHref;
  setCurrentItemPageFeatures(pageData.items, itemsGroupState.collectionItem);
  renderItemsGroupPage(itemsGroupState);
}

function renderCollectionItems(collectionItem, collection, pageData) {
  const nestedList = document.createElement("calcite-list");
  const itemGroup = document.createElement("calcite-list-item-group");
  const pagination = document.createElement("calcite-pagination");
  const itemsGroupState = {
    collection,
    collectionItem,
    currentPage: 1,
    currentStartItem: 1,
    itemGroup,
    items: [],
    nextHref: null,
    pagination,
    prevHref: null,
    isLoading: false
  };

  nestedList.label = `${getCollectionLabel(collection)} items`;
  itemGroup.heading = `Items`;

  pagination.pageSize = ITEMS_PAGE_SIZE;

  pagination.addEventListener("calcitePaginationChange", async event => {
    const requestedStartItem = event.target.startItem;
    const pageDirection = requestedStartItem < itemsGroupState.currentStartItem ? -1 : 1;

    if (requestedStartItem === itemsGroupState.currentStartItem || itemsGroupState.isLoading) {
      renderItemsGroupPage(itemsGroupState);
      return;
    }

    const pageHref = pageDirection < 0 ? itemsGroupState.prevHref : itemsGroupState.nextHref;

    if (!pageHref) {
      renderItemsGroupPage(itemsGroupState);
      return;
    }

    itemsGroupState.isLoading = true;
    clearCurrentItemPageFeatures(itemsGroupState.collectionItem);

    try {
      const nextPageData = await getItems(collection, pageHref);
      itemsGroupState.currentPage = Math.max(itemsGroupState.currentPage + pageDirection, 1);
      updateItemsGroupState(itemsGroupState, nextPageData);
    } finally {
      itemsGroupState.isLoading = false;
    }
  });

  updateItemsGroupState(itemsGroupState, pageData);
  collectionItemStateMap.set(collectionItem, itemsGroupState);
  nestedList.replaceChildren(itemGroup);
  collectionItem.replaceChildren(nestedList);
  collectionItem.dataset.itemsRendered = "true";
}

function createCollectionListItem(collection, list) {
  const item = document.createElement("calcite-list-item");
  const collectionKey = getCollectionKey(collection);

  item.label = getCollectionLabel(collection);
  item.description = getCollectionDescription(collection);
  item.value = collectionKey;

  item.addEventListener("click", async event => {
    if (event.target !== item || item.dataset.itemsLoading === "true") {
      return;
    }

    if (item.expanded) {
      item.expanded = false;
      clearCurrentItemPageFeatures(item);
      return;
    }

    list.displayMode = "nested";
    item.expanded = true;

    if (item.dataset.itemsRendered === "true") {
      const itemsGroupState = collectionItemStateMap.get(item);

      if (itemsGroupState) {
        setCurrentItemPageFeatures(itemsGroupState.items, item);
      }

      return;
    }

    item.dataset.itemsLoading = "true";
    clearCurrentItemPageFeatures(item);

    try {
      const itemsPage = await getItems(collection);
      renderCollectionItems(item, collection, itemsPage);
    } finally {
      delete item.dataset.itemsLoading;
    }
  });

  return item;
}

async function getCapellaCollections(catalogFragment = "/catalog.json") {
  try {
    setLoading(true);
    const response = await fetch(`${CAPELLA_API_URL}${catalogFragment}`);
    if (!response.ok) {
      throw new Error(`Capella API request failed with status ${response.status}`);
    }
    const data = await response.json();
    console.log(data);
  } catch (error) {
    console.warn("Error fetching Capella collections");
    console.error(error);
  } finally {
    setLoading(false);
  }
}

async function getCapellaCollectionItems(collection) {
}

// get all collections
async function getAllCollections() {
  try {
    setLoading(true);
    const response = await fetch(COLLECTIONS_URL);
    if (!response.ok) {
      throw new Error(`Collections request failed with status ${response.status}`);
    }
    const data = await response.json();
    console.log(data);
    collectionsPanel.heading = `${collectionsPanel.heading} (${data.collections?.length ?? 0})`;
    renderCollections(data.collections?.sort((a, b) => a.title.localeCompare(b.title)) ?? []);
  } catch (error) {
    console.warn("Error fetching collections");
    console.error(error);
  } finally {
    setLoading(false);
  }
}

function renderCollections(collections) {
  const list = document.createElement("calcite-list");
  const pagination = document.createElement("calcite-pagination");
  const totalItems = collections.length;

  list.label = "STAC collections";

  pagination.slot = "footer";
  pagination.pageSize = COLLECTIONS_PAGE_SIZE;
  pagination.startItem = 1;
  pagination.totalItems = totalItems;

  function renderCollectionPage(startItem) {
    const startIndex = Math.max(startItem - 1, 0);
    const endIndex = startIndex + COLLECTIONS_PAGE_SIZE;
    const pageCollections = collections.slice(startIndex, endIndex);

    clearCurrentItemPageFeatures();

    list.replaceChildren(
      ...pageCollections.map(collection => createCollectionListItem(collection, list))
    );
  }

  pagination.addEventListener("calcitePaginationChange", event => {
    renderCollectionPage(event.target.startItem);
    collectionsPanel.scrollContentTo({ top: 0 });
  });

  renderCollectionPage(pagination.startItem);
  collectionsPanel.replaceChildren(list, pagination);
}

async function getCollection() {

}

async function getItem(collection, stacItem) {
  const itemHref = getLinkHref(stacItem.links, "self") ||
    `${COLLECTIONS_URL}/${collection.id}/items/${encodeURIComponent(stacItem.id)}`;

  if (!itemHref) {
    console.warn("No item link found", stacItem);
    return stacItem;
  }

  try {
    const response = await fetch(itemHref);
    if (!response.ok) {
      throw new Error(`Item request failed with status ${response.status}`);
    }

    const data = await response.json();
    console.log(data);
    return data;
  } catch (error) {
    console.warn("Error fetching item");
    console.error(error);
    return stacItem;
  }
}

async function getItems(collection, pageHref = null) {
  setLoading(true);
  const itemsHref = pageHref || getLinkHref(collection.links, "items") ||
    `${COLLECTIONS_URL}/${collection.id}/items`;

  if (!itemsHref) {
    console.warn("No items link found for collection", collection);
    setLoading(false);
    return {
      items: [],
      nextHref: null,
      prevHref: null
    };
  }

  try {
    const itemsUrl = new URL(itemsHref, window.location.href);
    if (!itemsUrl.searchParams.has("limit")) {
      itemsUrl.searchParams.set("limit", String(ITEMS_FETCH_LIMIT));
    }

    const response = await fetch(itemsUrl);
    if (!response.ok) {
      throw new Error(`Items request failed with status ${response.status}`);
    }
    const data = await response.json();
    console.log(data);
    return {
      items: data.features ?? [],
      nextHref: getLinkHref(data.links, "next"),
      prevHref: getLinkHref(data.links, ["prev", "previous"])
    };
  } catch (error) {
    console.warn("Error fetching items");
    console.error(error);
    return {
      items: [],
      nextHref: null,
      prevHref: null
    };
  } finally {
    setLoading(false);
  }
}

function renderCollection() {

}

getAllCollections();

async function performSearch() {

}

function renderSearchResults() {

}

const tokenCache = new Map();

async function getToken(collectionTitle) {
  const cachedToken = tokenCache.get(collectionTitle);
  if (cachedToken && cachedToken.expires > new Date()) {
    return cachedToken;
  }
  return requestToken(collectionTitle);
}

async function requestToken(collectionTitle) {
  const url = `${TOKEN_URL}/token/${collectionTitle}`;
  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Token request failed with status ${response.status}: ${data.detail || response.statusText}`);
  }

  if (!data.token || !data["msft:expiry"]) {
    throw new Error("Token response is missing required fields");
  }

  const tokenData = {
    params: Object.fromEntries(new URLSearchParams(data.token)),
    expires: new Date(data["msft:expiry"])
  };

  tokenCache.set(collectionTitle, tokenData);
  return tokenData;
}

async function addAssetToMap(item, asset, assetKey) {
  const imageryUrl = getAssetHref(asset);

  if (!imageryUrl || !scene.map) {
    return null;
  }

  const token = await getToken(item.collection);
  const layer = new ImageryTileLayer({
    url: imageryUrl,
    customParameters: token.params,
    title: asset.title || assetKey || item.id || "STAC imagery"
  });

  console.log(layer);

  itemLayerSourceMap.set(layer, imageryUrl);
  scene.map.add(layer);
  return layer;
}