// set up UI

const shellcollectionsPanel = document.getElementById("shell-panel-start");
const collectionsPanel = document.getElementById("collections-panel");
const itemPanel = document.getElementById("item-panel");
const itemPanelContent = document.getElementById("item-panel-content");
const searchPanel = document.getElementById("search-panel");
const searchDrawExtentButton = document.getElementById("search-draw-extent");
const searchClearExtentAction = document.getElementById("search-clear-extent");
const searchExtentSummary = document.getElementById("search-extent-summary");
const searchStartDatePicker = document.getElementById("search-start-date");
const searchEndDatePicker = document.getElementById("search-end-date");
const searchCollectionsCombobox = document.getElementById("search-collections");
const searchMetadataPicker = document.getElementById("search-metadata-picker");
const searchMetadataFilters = document.getElementById("search-metadata-filters");
const searchResultsSummary = document.getElementById("search-results-summary");
const searchResultsList = document.getElementById("search-results-list");
const searchResultsPagination = document.getElementById("search-results-pagination");
const searchSubmitButton = document.getElementById("search-submit");
const searchResetButton = document.getElementById("search-reset");
const actionsStart = shellcollectionsPanel?.querySelectorAll("calcite-action");
const layerListEl = document.querySelector("arcgis-layer-list");

const backPanelMap = new Map();
const collectionItemStateMap = new WeakMap();
const itemLayerSourceMap = new WeakMap();
const imageryLayerPresentationMap = new WeakMap();
const layerListActionMap = new Map();
const baseCollectionsPanelHeading = collectionsPanel.heading;

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

const sceneEl = document.querySelector("arcgis-map");
const [
  ActionButton,
  Collection,
  ImageryTileLayer,
  RasterFunction,
  WebTileLayer,
  classBreaksRendererCreator,
  shadedReliefRendererCreator,
  stretchRendererCreator,
  Extent,
  Graphic,
  GraphicsLayer,
  SketchViewModel,
  webMercatorUtils
] = await $arcgis.import([
  "@arcgis/core/support/actions/ActionButton.js",
  "@arcgis/core/core/Collection.js",
  "@arcgis/core/layers/ImageryTileLayer.js",
  "@arcgis/core/layers/support/RasterFunction.js",
  "@arcgis/core/layers/WebTileLayer.js",
  "@arcgis/core/smartMapping/raster/renderers/classBreaks.js",
  "@arcgis/core/smartMapping/raster/renderers/shadedRelief.js",
  "@arcgis/core/smartMapping/raster/renderers/stretch.js",
  "@arcgis/core/geometry/Extent.js",
  "@arcgis/core/Graphic.js",
  "@arcgis/core/layers/GraphicsLayer.js",
  "@arcgis/core/widgets/Sketch/SketchViewModel.js",
  "@arcgis/core/geometry/support/webMercatorUtils.js"
]);
await sceneEl.viewOnReady();
const scene = sceneEl.view;

if (layerListEl) {
  layerListEl.listItemCreatedFunction = defineLayerListItemActions;
  layerListEl.addEventListener("arcgisTriggerAction", handleLayerListActionTrigger);
}

const searchExtentLayer = new GraphicsLayer({
  listMode: "hide",
  title: "Search extent"
});

scene.map?.add(searchExtentLayer);

const searchSketchViewModel = new SketchViewModel({
  view: scene,
  layer: searchExtentLayer,
  updateOnGraphicClick: false,
  polygonSymbol: {
    type: "simple-fill",
    color: [0, 163, 108, 0.08],
    outline: {
      type: "simple-line",
      color: [0, 163, 108, 1],
      width: 2
    }
  }
});

let currentItemPageFeatures = [];
let currentItemPageGraphics = [];
let currentItemPageCollectionItem = null;
let currentSelectedItemFeature = null;
let currentSelectedItemGraphic = null;
let availableCollections = [];
let searchExtentGraphic = null;
let isSearchExtentDrawing = false;
const queryableDefinitionMap = new Map();

// search and render logic

// MICROSOFT PLANETARY COMPUTER STAC API ENDPOINTS AND HELPERS
const API_URL = "https://planetarycomputer.microsoft.com/api/stac/v1";
const SEARCH_URL = `${API_URL}/search`;
const QUERYABLES_URL = `${API_URL}/queryables`;
const TOKEN_URL = "https://planetarycomputer.microsoft.com/api/sas/v1";
const COLLECTIONS_URL = `${API_URL}/collections`;
const COLLECTION_URL = `${COLLECTIONS_URL}/landsat-c2-l2`;
const ITEMS_URL = `${COLLECTION_URL}/items`;
const COLLECTIONS_PAGE_SIZE = 25;
const ITEMS_PAGE_SIZE = 10;
const ITEMS_FETCH_LIMIT = ITEMS_PAGE_SIZE;
const SEARCH_RESULTS_LIMIT = 25;
const DEFAULT_OPERATOR_OPTIONS = [
  { label: "Is", value: "eq" }
];
const DATE_OPERATOR_OPTIONS = [
  { label: "On or after", value: "gte" },
  { label: "On or before", value: "lte" }
];
const NUMERIC_OPERATOR_OPTIONS = [
  { label: "=", value: "eq" },
  { label: ">", value: "gt" },
  { label: ">=", value: "gte" },
  { label: "<", value: "lt" },
  { label: "<=", value: "lte" }
];
const SEARCH_QUERYABLE_EXCLUSIONS = new Set([
  "bbox",
  "collection",
  "datetime",
  "end_datetime",
  "geometry",
  "id",
  "start_datetime"
]);
const searchResultsState = {
  currentPage: 1,
  currentStartItem: 1,
  isLoading: false,
  pages: []
};
const IMAGERY_LAYER_LIST_ACTIONS = Object.freeze([
  { key: "default", title: "Default", icon: "undo" },
  { key: "classify", title: "Classify", icon: "sliders-horizontal" },
  { key: "shaded-relief", title: "Shaded relief", icon: "sliders-horizontal" },
  { key: "slope", title: "Slope", icon: "sliders-horizontal" },
  { key: "stretch", title: "Stretch", icon: "sliders-horizontal" }
]);
const IMAGERY_LAYER_ACTION_SEPARATOR = "::";

function cloneLayerPresentationValue(value) {
  return value?.clone ? value.clone() : value ?? null;
}

function getImageryLayerPresentationState(layer) {
  let state = imageryLayerPresentationMap.get(layer);

  if (!state) {
    state = {
      baseRasterFunction: cloneLayerPresentationValue(layer.rasterFunction),
      baseRenderer: cloneLayerPresentationValue(layer.renderer)
    };
    imageryLayerPresentationMap.set(layer, state);
  }

  return state;
}

function resetImageryLayerPresentation(layer) {
  const { baseRasterFunction, baseRenderer } = getImageryLayerPresentationState(layer);
  const rasterFunction = cloneLayerPresentationValue(baseRasterFunction);
  const renderer = cloneLayerPresentationValue(baseRenderer);

  layer.rasterFunction = rasterFunction;
  layer.renderer = renderer;

  return {
    rasterFunction,
    renderer
  };
}

function createImageryLayerActionId(layer, actionName) {
  return `${layer.uid}${IMAGERY_LAYER_ACTION_SEPARATOR}${actionName}`;
}

function createImageryLayerActionButton(layer, actionDefinition) {
  const id = createImageryLayerActionId(layer, actionDefinition.key);

  layerListActionMap.set(id, {
    actionName: actionDefinition.key,
    layer
  });

  return new ActionButton({
    id,
    icon: actionDefinition.icon,
    title: actionDefinition.title
  });
}

function defineLayerListItemActions(event) {
  const { item } = event;

  if (!(item?.layer instanceof ImageryTileLayer)) {
    return;
  }

  item.actionsSections = new Collection([
    new Collection(
      IMAGERY_LAYER_LIST_ACTIONS.map(actionDefinition => createImageryLayerActionButton(item.layer, actionDefinition))
    )
  ]);
}

function createSlopeRasterFunction() {
  return new RasterFunction({
    functionName: "Slope",
    functionArguments: {
      DEM: "$$",
      SlopeType: 1,
      ZFactor: 1
    },
    outputPixelType: "f32",
    variableName: "DEM"
  });
}

async function applyClassifyRenderer(layer) {
  const { rasterFunction } = resetImageryLayerPresentation(layer);
  const { renderer } = await classBreaksRendererCreator.createRenderer({
    classificationMethod: "natural-breaks",
    layer,
    numClasses: 5,
    rasterFunction: rasterFunction || undefined
  });

  layer.renderer = renderer;
}

async function applyShadedReliefRenderer(layer) {
  const { rasterFunction } = resetImageryLayerPresentation(layer);
  const { renderer } = await shadedReliefRendererCreator.createRenderer({
    hillshadeType: "traditional",
    layer,
    rasterFunction: rasterFunction || undefined
  });

  layer.renderer = renderer;
}

async function applyStretchRenderer(layer) {
  const { rasterFunction } = resetImageryLayerPresentation(layer);
  const { renderer } = await stretchRendererCreator.createRenderer({
    bandId: 0,
    dynamicRangeAdjustment: true,
    estimateStatistics: true,
    gamma: 1.15,
    layer,
    rasterFunction: rasterFunction || undefined,
    stretchType: "min-max",
    useGamma: true
  });

  layer.renderer = renderer;
}

async function applySlopeRasterFunction(layer) {
  resetImageryLayerPresentation(layer);
  layer.rasterFunction = createSlopeRasterFunction();
}

async function applyDefaultRenderer(layer) {
  resetImageryLayerPresentation(layer);
}

async function applyImageryLayerAction(layer, actionName) {
  switch (actionName) {
    case "default":
      await applyDefaultRenderer(layer);
      return;
    case "classify":
      await applyClassifyRenderer(layer);
      return;
    case "shaded-relief":
      await applyShadedReliefRenderer(layer);
      return;
    case "slope":
      await applySlopeRasterFunction(layer);
      return;
    case "stretch":
      await applyStretchRenderer(layer);
      return;
    default:
      return;
  }
}

async function handleLayerListActionTrigger(event) {
  const action = event.detail?.action;
  const actionContext = layerListActionMap.get(action?.id);

  if (!action || !actionContext?.layer) {
    return;
  }

  action.disabled = true;

  try {
    await actionContext.layer.when();
    await applyImageryLayerAction(actionContext.layer, actionContext.actionName);
  } catch (error) {
    console.error(`Unable to apply ${actionContext.actionName} styling to \"${actionContext.layer.title || "Imagery layer"}\".`, error);
  } finally {
    action.disabled = false;
  }
}

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

function getComboboxValueArray(combobox) {
  const rawValue = combobox?.value;

  if (Array.isArray(rawValue)) {
    return rawValue.filter(Boolean).map(String);
  }

  if (typeof rawValue === "string") {
    return rawValue ? [rawValue] : [];
  }

  return Array.from(combobox?.selectedItems ?? [])
    .map(item => item?.value)
    .filter(Boolean)
    .map(String);
}

function setComboboxValues(combobox, values = []) {
  if (!combobox) {
    return;
  }

  const nextValues = Array.isArray(values) ? values : [values];
  const nextValueSet = new Set(nextValues.filter(Boolean).map(String));

  Array.from(combobox.querySelectorAll("calcite-combobox-item")).forEach(item => {
    item.selected = nextValueSet.has(String(item.value));
  });

  if (combobox.selectionMode === "multiple" || combobox.selectionMode === "ancestors") {
    combobox.value = [...nextValueSet];
    return;
  }

  combobox.value = [...nextValueSet][0] ?? "";
}

function getSelectedComboboxItems(combobox) {
  const selectedValueSet = new Set(getComboboxValueArray(combobox));

  if (!selectedValueSet.size) {
    return [];
  }

  return Array.from(combobox?.querySelectorAll("calcite-combobox-item") ?? [])
    .filter(item => selectedValueSet.has(String(item.value)));
}

function getSelectedComboboxValues(combobox) {
  return getComboboxValueArray(combobox);
}

function clearComboboxSelection(combobox) {
  setComboboxValues(combobox, []);
}

function setSearchPanelLoading(isLoading) {
  setPanelLoading(searchPanel, isLoading);
}

function updateSearchResultsSummary(message) {
  searchResultsSummary.textContent = message;
}

function renderSearchResultsMessage(label, description, summary = description) {
  updateSearchResultsSummary(summary);
  searchResultsList.replaceChildren(createMessageListItem(label, description));
  searchResultsPagination.hidden = true;
}

function renderMetadataFiltersMessage(label, description) {
  searchMetadataFilters.interactionMode = "static";
  searchMetadataFilters.replaceChildren(createMessageListItem(label, description));
}

function formatCoordinate(value) {
  return Number(value).toFixed(4);
}

function getGeographicExtent(extent) {
  if (!extent) {
    return null;
  }

  if (extent.spatialReference?.isWGS84) {
    return extent;
  }

  if (extent.spatialReference?.isWebMercator) {
    return webMercatorUtils.webMercatorToGeographic(extent);
  }

  return extent;
}

function getSearchExtentBbox() {
  const extent = getGeographicExtent(searchExtentGraphic?.geometry?.extent);

  if (!extent) {
    return null;
  }

  return [extent.xmin, extent.ymin, extent.xmax, extent.ymax].map(value => Number(value.toFixed(6)));
}

function updateSearchExtentUi() {
  const bbox = getSearchExtentBbox();

  searchDrawExtentButton.textContent = isSearchExtentDrawing
    ? "Cancel drawing"
    : bbox
      ? "Redraw extent"
      : "Draw extent";
  searchDrawExtentButton.iconStart = isSearchExtentDrawing ? "x" : "selection";
  searchClearExtentAction.disabled = !bbox;
  searchExtentSummary.textContent = bbox
    ? `Extent: ${formatCoordinate(bbox[0])}, ${formatCoordinate(bbox[1])} to ${formatCoordinate(bbox[2])}, ${formatCoordinate(bbox[3])}`
    : "No extent drawn.";
}

function clearSearchExtent() {
  searchSketchViewModel.cancel();
  searchExtentLayer.removeAll();
  searchExtentGraphic = null;
  isSearchExtentDrawing = false;
  updateSearchExtentUi();
}

function toggleSearchExtentDrawing() {
  if (isSearchExtentDrawing) {
    searchSketchViewModel.cancel();
    isSearchExtentDrawing = false;
    updateSearchExtentUi();
    return;
  }

  searchExtentLayer.removeAll();
  searchExtentGraphic = null;
  isSearchExtentDrawing = true;
  updateSearchExtentUi();
  searchSketchViewModel.create("rectangle");
}

function syncSearchDateConstraints() {
  searchStartDatePicker.max = searchEndDatePicker.value || "";
  searchEndDatePicker.min = searchStartDatePicker.value || "";
}

function buildSearchDatetimeRange() {
  const startDate = searchStartDatePicker.value;
  const endDate = searchEndDatePicker.value;

  if (!startDate && !endDate) {
    return null;
  }

  const start = startDate ? `${startDate}T00:00:00Z` : "..";
  const end = endDate ? `${endDate}T23:59:59Z` : "..";

  return `${start}/${end}`;
}

function getSchemaDetails(schema, accumulator = {
  description: "",
  enumValues: null,
  format: "",
  itemTypes: new Set(),
  maximum: null,
  minimum: null,
  pattern: "",
  title: "",
  types: new Set()
}) {
  if (!schema || typeof schema !== "object") {
    return accumulator;
  }

  if (!accumulator.title && schema.title) {
    accumulator.title = schema.title;
  }

  if (!accumulator.description && schema.description) {
    accumulator.description = schema.description;
  }

  if (!accumulator.format && schema.format) {
    accumulator.format = schema.format;
  }

  if (!accumulator.pattern && schema.pattern) {
    accumulator.pattern = schema.pattern;
  }

  const types = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
  types.forEach(type => accumulator.types.add(type));

  if (!accumulator.enumValues && Array.isArray(schema.enum) && schema.enum.length) {
    accumulator.enumValues = [...schema.enum];
  }

  if (!accumulator.enumValues && Array.isArray(schema.items?.enum) && schema.items.enum.length) {
    accumulator.enumValues = [...schema.items.enum];
  }

  if (!accumulator.enumValues && schema.const !== undefined) {
    accumulator.enumValues = [schema.const];
  }

  const itemTypes = Array.isArray(schema.items?.type)
    ? schema.items.type
    : (schema.items?.type ? [schema.items.type] : []);
  itemTypes.forEach(type => accumulator.itemTypes.add(type));

  if (accumulator.minimum == null && typeof schema.minimum === "number") {
    accumulator.minimum = schema.minimum;
  }

  if (accumulator.maximum == null && typeof schema.maximum === "number") {
    accumulator.maximum = schema.maximum;
  }

  ["allOf", "anyOf", "oneOf"].forEach(key => {
    if (Array.isArray(schema[key])) {
      schema[key].forEach(childSchema => {
        getSchemaDetails(childSchema, accumulator);
      });
    }
  });

  return accumulator;
}

function inferValueType(values) {
  if (values.every(value => typeof value === "number" && Number.isInteger(value))) {
    return "integer";
  }

  if (values.every(value => typeof value === "number")) {
    return "number";
  }

  if (values.every(value => typeof value === "boolean")) {
    return "boolean";
  }

  return "string";
}

function getQueryableDefinition(queryableKey, schema) {
  const schemaDetails = getSchemaDetails(schema);
  const scalarTypes = [...schemaDetails.types].filter(type => !["array", "null", "object"].includes(type));
  let inputKind = null;
  let operatorOptions = DEFAULT_OPERATOR_OPTIONS;
  let valueType = null;
  let enumValues = schemaDetails.enumValues;

  if (enumValues?.length) {
    inputKind = "select";
    valueType = inferValueType(enumValues);
  } else if (scalarTypes.includes("boolean")) {
    inputKind = "select";
    valueType = "boolean";
    enumValues = [true, false];
  } else if ((scalarTypes.includes("string") || scalarTypes.length === 0) && ["date", "date-time"].includes(schemaDetails.format)) {
    inputKind = "date";
    operatorOptions = DATE_OPERATOR_OPTIONS;
    valueType = "string";
  } else if (scalarTypes.includes("integer")) {
    inputKind = "number";
    operatorOptions = NUMERIC_OPERATOR_OPTIONS;
    valueType = "integer";
  } else if (scalarTypes.includes("number")) {
    inputKind = "number";
    operatorOptions = NUMERIC_OPERATOR_OPTIONS;
    valueType = "number";
  } else if (scalarTypes.includes("string") || scalarTypes.length === 0) {
    inputKind = "text";
    valueType = "string";
  } else {
    return null;
  }

  return {
    description: schemaDetails.description || queryableKey,
    enumValues,
    format: schemaDetails.format || "",
    inputKind,
    key: queryableKey,
    label: schemaDetails.title || queryableKey,
    maximum: schemaDetails.maximum,
    minimum: schemaDetails.minimum,
    operatorOptions,
    defaultOperator: operatorOptions[0].value,
    pattern: schemaDetails.pattern || "",
    valueType
  };
}

function serializeMetadataOptionValue(value) {
  return JSON.stringify(value);
}

function parseMetadataOptionValue(value) {
  if (value == null || value === "") {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getMetadataFilterControlState() {
  const controlStateMap = new Map();

  Array.from(searchMetadataFilters.querySelectorAll("[data-metadata-key]"))
    .forEach(control => {
      const state = controlStateMap.get(control.dataset.metadataKey) ?? {
        operator: "",
        value: ""
      };

      state[control.dataset.metadataRole || "value"] = control.value ?? "";
      controlStateMap.set(control.dataset.metadataKey, state);
    });

  return controlStateMap;
}

function createMetadataFilterControl(definition, currentValue = "") {
  if (definition.inputKind === "date") {
    const input = document.createElement("calcite-input-date-picker");

    input.dataset.metadataKey = definition.key;
    input.dataset.metadataRole = "value";
    input.max = definition.maximum ?? "";
    input.min = definition.minimum ?? "";
    input.scale = "s";
    input.value = currentValue;
    return input;
  }

  if (definition.inputKind === "number") {
    const input = document.createElement("calcite-input-number");

    input.dataset.metadataKey = definition.key;
    input.dataset.metadataRole = "value";
    input.placeholder = "Enter a value";
    input.step = definition.valueType === "integer" ? 1 : "any";
    if (definition.minimum != null) {
      input.min = definition.minimum;
    }
    if (definition.maximum != null) {
      input.max = definition.maximum;
    }
    input.value = currentValue;
    return input;
  }

  if (definition.inputKind === "select") {
    const select = document.createElement("calcite-select");
    const emptyOption = document.createElement("calcite-option");

    select.dataset.metadataKey = definition.key;
    select.dataset.metadataRole = "value";
    emptyOption.value = "";
    emptyOption.textContent = "Any value";
    select.append(emptyOption);
    definition.enumValues.forEach(optionValue => {
      const option = document.createElement("calcite-option");

      option.value = serializeMetadataOptionValue(optionValue);
      option.textContent = String(optionValue);
      select.append(option);
    });
    select.value = currentValue;
    return select;
  }

  const input = document.createElement("calcite-input");

  input.dataset.metadataKey = definition.key;
  input.dataset.metadataRole = "value";
  input.placeholder = definition.pattern ? "Enter a matching value" : "Enter a value";
  input.value = currentValue;
  return input;
}

function createMetadataOperatorControl(definition, currentOperator = definition.defaultOperator) {
  if (definition.operatorOptions.length <= 1) {
    return null;
  }

  const select = document.createElement("calcite-select");

  select.dataset.metadataKey = definition.key;
  select.dataset.metadataRole = "operator";
  definition.operatorOptions.forEach(optionConfig => {
    const option = document.createElement("calcite-option");

    option.value = optionConfig.value;
    option.textContent = optionConfig.label;
    select.append(option);
  });
  select.value = currentOperator || definition.defaultOperator;
  return select;
}

function deselectMetadataFilter(queryableKey) {
  const nextValues = getSelectedComboboxValues(searchMetadataPicker)
    .filter(value => value !== queryableKey);

  setComboboxValues(searchMetadataPicker, nextValues);
  renderMetadataFiltersList();
}

function createMetadataFilterListItem(definition, currentState = {}) {
  const item = document.createElement("calcite-list-item");
  const fieldContainer = document.createElement("div");
  fieldContainer.slot = "content-end";
  const fieldControl = createMetadataFilterControl(definition, currentState.value ?? "");
  const operatorControl = createMetadataOperatorControl(definition, currentState.operator ?? definition.defaultOperator);
  const removeAction = document.createElement("calcite-action");

  item.label = definition.label;
  item.description = definition.description;

  fieldContainer.className = "search-metadata-field";
  if (operatorControl) {
    const fieldRow = document.createElement("div");

    fieldRow.className = "search-metadata-field-row search-metadata-field-row-with-operator";
    fieldRow.append(operatorControl, fieldControl);
    fieldContainer.append(fieldRow);
  } else {
    fieldContainer.append(fieldControl);
  }

  removeAction.icon = "x";
  removeAction.slot = "actions-end";
  removeAction.text = `Remove ${definition.label}`;
  removeAction.addEventListener("click", event => {
    event.stopPropagation();
    deselectMetadataFilter(definition.key);
  });

  item.append(fieldContainer, removeAction);
  return item;
}

function renderMetadataFiltersList() {
  const selectedQueryables = getSelectedComboboxValues(searchMetadataPicker);
  const currentValues = getMetadataFilterControlState();

  if (!selectedQueryables.length) {
    renderMetadataFiltersMessage(
      "No metadata filters selected",
      "Choose fields from the metadata picker to add filters."
    );
    return;
  }

  const filterItems = selectedQueryables
    .map(queryableKey => {
      const definition = queryableDefinitionMap.get(queryableKey);

      return definition
        ? createMetadataFilterListItem(definition, currentValues.get(queryableKey) ?? {})
        : null;
    })
    .filter(Boolean);

  searchMetadataFilters.interactionMode = "static";
  searchMetadataFilters.replaceChildren(...filterItems);
}

function normalizeMetadataOperator(definition, rawOperator) {
  return definition.operatorOptions.some(optionConfig => optionConfig.value === rawOperator)
    ? rawOperator
    : definition.defaultOperator;
}

function coerceMetadataFilterValue(definition, operator, rawValue) {
  if (rawValue == null || rawValue === "") {
    return undefined;
  }

  if (definition.inputKind === "select") {
    return parseMetadataOptionValue(rawValue);
  }

  if (definition.inputKind === "number") {
    const numericValue = Number(rawValue);

    if (!Number.isFinite(numericValue)) {
      return undefined;
    }

    if (definition.valueType === "integer" && !Number.isInteger(numericValue)) {
      return undefined;
    }

    return numericValue;
  }

  if (definition.inputKind === "date") {
    if (definition.format === "date-time") {
      return operator === "lte" || operator === "lt"
        ? `${rawValue}T23:59:59Z`
        : `${rawValue}T00:00:00Z`;
    }

    return rawValue;
  }

  const textValue = String(rawValue).trim();
  return textValue || undefined;
}

function getMetadataQuery() {
  const metadataQuery = {};

  getMetadataFilterControlState().forEach((controlState, metadataKey) => {
      const definition = queryableDefinitionMap.get(metadataKey);

      if (!definition) {
        return;
      }

      const operator = normalizeMetadataOperator(definition, controlState.operator);
      const value = coerceMetadataFilterValue(definition, operator, controlState.value);

      if (value !== undefined) {
        metadataQuery[definition.key] = { [operator]: value };
      }
    });

  return metadataQuery;
}

function cloneSearchRequest(searchRequest) {
  return JSON.parse(JSON.stringify(searchRequest));
}

function getSearchPageStartItem(pageNumber) {
  return ((pageNumber - 1) * SEARCH_RESULTS_LIMIT) + 1;
}

function getSearchRequestFromLink(link, fallbackRequest = {}) {
  if (!link) {
    return null;
  }

  if (link.body && typeof link.body === "object") {
    return cloneSearchRequest(link.body);
  }

  if (!link.href) {
    return null;
  }

  try {
    const requestUrl = new URL(link.href, window.location.href);
    const nextRequest = cloneSearchRequest(fallbackRequest);

    if (requestUrl.searchParams.has("bbox")) {
      nextRequest.bbox = requestUrl.searchParams.get("bbox")
        .split(",")
        .map(value => Number(value));
    }

    if (requestUrl.searchParams.has("collections")) {
      nextRequest.collections = requestUrl.searchParams.get("collections")
        .split(",")
        .filter(Boolean);
    }

    if (requestUrl.searchParams.has("datetime")) {
      nextRequest.datetime = requestUrl.searchParams.get("datetime");
    }

    if (requestUrl.searchParams.has("limit")) {
      nextRequest.limit = Number(requestUrl.searchParams.get("limit"));
    }

    if (requestUrl.searchParams.has("token")) {
      nextRequest.token = requestUrl.searchParams.get("token");
    }

    return nextRequest;
  } catch {
    return null;
  }
}

function resetSearchResultsState() {
  searchResultsState.currentPage = 1;
  searchResultsState.currentStartItem = 1;
  searchResultsState.isLoading = false;
  searchResultsState.pages = [];
  searchResultsPagination.hidden = true;
  searchResultsPagination.startItem = 1;
  searchResultsPagination.totalItems = SEARCH_RESULTS_LIMIT;
}

function getSearchResultsPaginationState(pageData, pageNumber) {
  const startItem = getSearchPageStartItem(pageNumber);
  const currentPageCount = pageData.items.length;

  return {
    startItem,
    totalItems: pageData.numberMatched ?? (startItem + currentPageCount - 1 + (pageData.hasMore ? 1 : 0))
  };
}

function updateSearchResultsPagination(pageData, pageNumber) {
  const paginationState = getSearchResultsPaginationState(pageData, pageNumber);

  searchResultsState.currentPage = pageNumber;
  searchResultsState.currentStartItem = paginationState.startItem;
  searchResultsPagination.pageSize = SEARCH_RESULTS_LIMIT;
  searchResultsPagination.startItem = paginationState.startItem;
  searchResultsPagination.totalItems = Math.max(paginationState.totalItems, pageData.items.length || 1);
  searchResultsPagination.hidden = !(
    pageNumber > 1 ||
    pageData.hasMore ||
    (pageData.numberMatched ?? 0) > SEARCH_RESULTS_LIMIT
  );
}

async function loadSearchResultsPage(pageNumber) {
  const cachedPageData = searchResultsState.pages[pageNumber - 1];

  if (cachedPageData) {
    renderSearchResultsPage(pageNumber);
    return;
  }

  if (pageNumber !== searchResultsState.currentPage + 1) {
    renderSearchResultsPage(searchResultsState.currentPage);
    return;
  }

  const currentPageData = searchResultsState.pages[searchResultsState.currentPage - 1];

  if (!currentPageData?.nextRequest) {
    renderSearchResultsPage(searchResultsState.currentPage);
    return;
  }

  try {
    searchResultsState.isLoading = true;
    updateSearchResultsSummary(`Loading page ${pageNumber}...`);
    const nextPageData = await searchItems(currentPageData.nextRequest);

    searchResultsState.pages[pageNumber - 1] = {
      ...nextPageData,
      request: cloneSearchRequest(currentPageData.nextRequest)
    };
    renderSearchResultsPage(pageNumber);
  } catch (error) {
    console.warn("Error loading search results page");
    console.error(error);
    renderSearchResultsPage(searchResultsState.currentPage);
  } finally {
    searchResultsState.isLoading = false;
  }
}

function populateSearchCollections(collections) {
  const collectionItems = collections.map(collection => {
    const item = document.createElement("calcite-combobox-item");

    item.value = collection.id;
    item.heading = collection.id;
    item.label = getCollectionLabel(collection);
    item.description = getCollectionDescription(collection);
    return item;
  });

  searchCollectionsCombobox.replaceChildren(...collectionItems);
  searchCollectionsCombobox.disabled = !collectionItems.length;
  searchCollectionsCombobox.placeholder = collectionItems.length
    ? "Select one or more collections"
    : "No collections available";
}

function populateSearchMetadataPicker(definitions) {
  const queryableItems = definitions.map(definition => {
    const item = document.createElement("calcite-combobox-item");

    item.value = definition.key;
    item.heading = definition.key;
    item.label = definition.label;
    item.description = definition.description;
    return item;
  });

  searchMetadataPicker.replaceChildren(...queryableItems);
  searchMetadataPicker.disabled = !queryableItems.length;
  searchMetadataPicker.placeholder = queryableItems.length
    ? "Select metadata fields"
    : "No metadata fields available";
  renderMetadataFiltersList();
}

async function loadQueryables() {
  try {
    setSearchPanelLoading(true);
    const response = await fetch(QUERYABLES_URL);

    if (!response.ok) {
      throw new Error(`Queryables request failed with status ${response.status}`);
    }

    const data = await response.json();
    const definitions = Object.entries(data.properties ?? {})
      .filter(([queryableKey]) => !SEARCH_QUERYABLE_EXCLUSIONS.has(queryableKey))
      .map(([queryableKey, schema]) => getQueryableDefinition(queryableKey, schema))
      .filter(Boolean)
      .sort((left, right) => left.label.localeCompare(right.label));

    queryableDefinitionMap.clear();
    definitions.forEach(definition => {
      queryableDefinitionMap.set(definition.key, definition);
    });

    populateSearchMetadataPicker(definitions);
  } catch (error) {
    console.warn("Error fetching queryables");
    console.error(error);
    searchMetadataPicker.disabled = true;
    searchMetadataPicker.placeholder = "Metadata fields unavailable";
    renderMetadataFiltersMessage(
      "Metadata unavailable",
      "The queryables endpoint could not be loaded."
    );
  } finally {
    setSearchPanelLoading(false);
  }
}

function createSearchResultListItem(stacItem) {
  const item = document.createElement("calcite-list-item");
  const itemDescriptionParts = [stacItem.collection, stacItem.properties?.datetime]
    .filter(Boolean);

  item.label = stacItem.id || "Untitled item";
  item.description = itemDescriptionParts.join(" | ") || getStacItemDescription(stacItem);
  item.value = stacItem.id || "";

  item.addEventListener("click", async event => {
    event.stopPropagation();

    setCurrentSelectedItemFeature(null);
    showStartPanel(itemPanel, searchPanel);
    itemPanel.heading = stacItem.id || "Item";
    itemPanel.description = stacItem.collection || "";
    itemPanelContent.replaceChildren();
    setPanelLoading(itemPanel, true);

    try {
      const itemData = await getItem({ id: stacItem.collection }, stacItem);
      setCurrentSelectedItemFeature(itemData);
      renderItem(itemData);
    } finally {
      setPanelLoading(itemPanel, false);
    }
  });

  return item;
}

function buildSearchResultsSummary(items, options = {}) {
  const { hasMore = false, numberMatched = null, pageNumber = 1 } = options;
  const resultCount = items.length;
  const startItem = getSearchPageStartItem(pageNumber);
  const endItem = startItem + resultCount - 1;

  if (!resultCount) {
    return "No items matched the current search.";
  }

  if (numberMatched != null) {
    return `Showing ${startItem}-${endItem} of ${numberMatched} matching items.`;
  }

  if (hasMore || pageNumber > 1) {
    return `Showing ${startItem}-${endItem} matching items.`;
  }

  return `Found ${resultCount} matching item${resultCount === 1 ? "" : "s"}.`;
}

function renderSearchResultsPage(pageNumber = 1) {
  const pageData = searchResultsState.pages[pageNumber - 1];

  if (!pageData?.items?.length) {
    renderSearchResultsMessage(
      "No results found",
      "Adjust the filters and try again.",
      buildSearchResultsSummary(pageData?.items ?? [], { pageNumber })
    );
    return;
  }

  updateSearchResultsSummary(buildSearchResultsSummary(pageData.items, {
    hasMore: pageData.hasMore,
    numberMatched: pageData.numberMatched,
    pageNumber
  }));
  searchResultsList.replaceChildren(...pageData.items.map(createSearchResultListItem));
  updateSearchResultsPagination(pageData, pageNumber);
}

async function searchItems(searchRequest) {
  const response = await fetch(SEARCH_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(searchRequest)
  });

  if (!response.ok) {
    throw new Error(`Search request failed with status ${response.status}`);
  }

  const data = await response.json();
  const nextLink = data.links?.find(link => link.rel === "next") || null;

  return {
    hasMore: Boolean(nextLink),
    items: data.features ?? [],
    nextRequest: getSearchRequestFromLink(nextLink, searchRequest),
    numberMatched: data.numberMatched ?? null
  };
}

function resetSearchForm() {
  searchStartDatePicker.value = "";
  searchEndDatePicker.value = "";
  searchStartDatePicker.max = "";
  searchEndDatePicker.min = "";
  clearComboboxSelection(searchCollectionsCombobox);
  clearComboboxSelection(searchMetadataPicker);
  clearSearchExtent();
  renderMetadataFiltersList();
  resetSearchResultsState();
  renderSearchResultsMessage(
    "No results yet",
    "Set filters and run a search.",
    "Set filters and run a search."
  );
}

function initializeSearchPanel() {
  searchDrawExtentButton.addEventListener("click", () => {
    toggleSearchExtentDrawing();
  });
  searchClearExtentAction.addEventListener("click", event => {
    event.stopPropagation();
    clearSearchExtent();
  });
  ["calciteInputDatePickerChange", "calciteDatePickerChange"].forEach(eventName => {
    searchStartDatePicker.addEventListener(eventName, syncSearchDateConstraints);
    searchEndDatePicker.addEventListener(eventName, syncSearchDateConstraints);
  });
  searchMetadataPicker.addEventListener("calciteComboboxChange", () => {
    renderMetadataFiltersList();
  });
  searchResultsPagination.addEventListener("calcitePaginationChange", event => {
    const requestedPage = Math.max(Math.ceil(event.target.startItem / SEARCH_RESULTS_LIMIT), 1);

    if (requestedPage === searchResultsState.currentPage || searchResultsState.isLoading) {
      renderSearchResultsPage(searchResultsState.currentPage);
      return;
    }

    if (searchResultsState.pages[requestedPage - 1]) {
      renderSearchResultsPage(requestedPage);
      return;
    }

    void loadSearchResultsPage(requestedPage);
  });
  searchSubmitButton.addEventListener("click", () => {
    void performSearch();
  });
  searchResetButton.addEventListener("click", () => {
    resetSearchForm();
  });

  updateSearchExtentUi();
  renderMetadataFiltersList();
  resetSearchResultsState();
  renderSearchResultsMessage(
    "No results yet",
    "Set filters and run a search.",
    "Set filters and run a search."
  );

  void loadQueryables();
}

searchSketchViewModel.on("create", event => {
  if (event.state === "complete") {
    searchExtentGraphic = event.graphic;
    isSearchExtentDrawing = false;
    updateSearchExtentUi();
    return;
  }

  if (event.state === "cancel") {
    isSearchExtentDrawing = false;
    updateSearchExtentUi();
  }
});

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

function hasOnlyAssetRole(asset, role) {
  return Array.isArray(asset?.roles) && asset.roles.length === 1 && asset.roles[0] === role;
}

function isTiffAsset(asset) {
  return Boolean(getAssetHref(asset)) && asset?.type?.toLowerCase().includes("image/tiff");
}

function isTileJsonAsset(asset) {
  return Boolean(getAssetHref(asset)) &&
    hasOnlyAssetRole(asset, "tiles") &&
    asset?.type?.toLowerCase() === "application/json";
}

function isAddableAsset(asset) {
  return isTiffAsset(asset) || isTileJsonAsset(asset);
}

function getAssetLayerType(asset) {
  if (isTileJsonAsset(asset)) {
    return "tiles";
  }

  if (isTiffAsset(asset)) {
    return "imagery";
  }

  return null;
}

function getAssetActionLabel(layerType, hasLayer) {
  if (layerType === "tiles") {
    return hasLayer ? "Remove web tile layer" : "Add web tile layer";
  }

  return hasLayer ? "Remove imagery layer" : "Add imagery layer";
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
    if (layerUrl === source.key || layerUrl?.startsWith(`${source.key}?`)) {
      return true;
    }

    const layerTemplate = normalizeHref(layer.urlTemplate);
    return layerTemplate === source.key || layerTemplate?.startsWith(`${source.key}?`);
  }) || null;
}

function updateAssetAction(action) {
  const sourceKey = action.dataset.assetHref;
  const layerType = action.dataset.assetLayerType || "imagery";

  if (!sourceKey) {
    return;
  }

  const existingLayer = findAddedItemLayer({ key: sourceKey });
  action.icon = existingLayer ? "minus" : "plus";
  action.label = getAssetActionLabel(layerType, Boolean(existingLayer));
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

function getGeoJsonRing(coordinates) {
  if (!Array.isArray(coordinates)) {
    return null;
  }

  const ring = coordinates
    .filter(position => Array.isArray(position) && position.length >= 2)
    .map(position => [position[0], position[1]]);

  return ring.length >= 4 ? ring : null;
}

function getFeatureFootprintGeometry(feature) {
  const geometry = feature?.geometry;
  const spatialReference = {
    wkid: 4326
  };

  if (geometry?.type === "Polygon" && Array.isArray(geometry.coordinates)) {
    const rings = geometry.coordinates
      .map(getGeoJsonRing)
      .filter(Boolean);

    if (rings.length) {
      return {
        type: "polygon",
        rings,
        spatialReference
      };
    }
  }

  if (geometry?.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    const rings = geometry.coordinates
      .flatMap(polygon => Array.isArray(polygon) ? polygon : [])
      .map(getGeoJsonRing)
      .filter(Boolean);

    if (rings.length) {
      return {
        type: "polygon",
        rings,
        spatialReference
      };
    }
  }

  const bbox = getBboxBounds(feature?.bbox);

  if (!bbox) {
    return null;
  }

  return {
    type: "polyline",
    paths: [[
      [bbox.xmin, bbox.ymin],
      [bbox.xmax, bbox.ymin],
      [bbox.xmax, bbox.ymax],
      [bbox.xmin, bbox.ymax],
      [bbox.xmin, bbox.ymin]
    ]],
    spatialReference
  };
}

function getFootprintSymbol(geometryType) {
  if (geometryType === "polygon") {
    return {
      type: "simple-fill",
      color: [255, 165, 0, 0.05],
      outline: {
        type: "simple-line",
        color: [255, 165, 0, 1],
        width: 2
      }
    };
  }

  return {
    type: "simple-line",
    color: [255, 165, 0, 1],
    width: 2
  };
}

function createFootprintGraphic(feature) {
  const geometry = getFeatureFootprintGeometry(feature);

  if (!geometry) {
    return null;
  }

  return new Graphic({
    attributes: {
      id: feature.id || ""
    },
    geometry,
    symbol: getFootprintSymbol(geometry.type)
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
    currentSelectedItemGraphic = createFootprintGraphic(currentSelectedItemFeature);

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
    .map(createFootprintGraphic)
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
  currentItemPageFeatures = features.filter(feature => Boolean(getFeatureFootprintGeometry(feature)));
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
  currentSelectedItemFeature = feature && getFeatureFootprintGeometry(feature) ? feature : null;
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

  if (!isAddableAsset(asset)) {
    return itemElement;
  }

  const action = document.createElement("calcite-action");
  const layerSource = getAssetLayerSource(asset);
  const layerType = getAssetLayerType(asset);

  if (!layerSource || !layerType) {
    return itemElement;
  }

  action.slot = "actions-end";
  action.dataset.assetHref = layerSource.key;
  action.dataset.assetLayerType = layerType;
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

function createAssetSection(item) {
  const assetEntries = Object.entries(item.assets ?? {});
  const assetSection = document.createElement("div");
  const assetList = document.createElement("calcite-list");
  const assetsGroup = document.createElement("calcite-list-item-group");

  assetSection.className = "item-assets-section";
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
  assetSection.replaceChildren(assetList);
  return assetSection;
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
  const assetSection = createAssetSection(item);

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
  itemPanelContent.replaceChildren(...(thumbnailLink ? [img] : []), itemDetailsList, assetSection);
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
    availableCollections = (data.collections ?? [])
      .slice()
      .sort((left, right) => getCollectionLabel(left).localeCompare(getCollectionLabel(right)));
    collectionsPanel.heading = `${baseCollectionsPanelHeading} (${availableCollections.length})`;
    populateSearchCollections(availableCollections);
    renderCollections(availableCollections);
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

initializeSearchPanel();

getAllCollections();

async function performSearch() {
  const startDate = searchStartDatePicker.value;
  const endDate = searchEndDatePicker.value;

  if (startDate && endDate && startDate > endDate) {
    renderSearchResultsMessage(
      "Invalid date range",
      "Choose an end date on or after the start date.",
      "Start date must be on or before the end date."
    );
    return;
  }

  const collections = getSelectedComboboxValues(searchCollectionsCombobox);
  const bbox = getSearchExtentBbox();
  const datetime = buildSearchDatetimeRange();
  const metadataQuery = getMetadataQuery();
  const searchRequest = {
    limit: SEARCH_RESULTS_LIMIT
  };

  if (collections.length) {
    searchRequest.collections = collections;
  }

  if (bbox) {
    searchRequest.bbox = bbox;
  }

  if (datetime) {
    searchRequest.datetime = datetime;
  }

  if (Object.keys(metadataQuery).length) {
    searchRequest.query = metadataQuery;
  }

  try {
    setSearchPanelLoading(true);
    resetSearchResultsState();
    searchResultsState.isLoading = true;
    renderSearchResultsMessage(
      "Searching",
      "Fetching items from the STAC search endpoint.",
      "Searching..."
    );
    const searchResults = await searchItems(searchRequest);

    searchResultsState.pages = [{
      ...searchResults,
      request: cloneSearchRequest(searchRequest)
    }];
    renderSearchResultsPage(1);
  } catch (error) {
    console.warn("Error performing search");
    console.error(error);
    renderSearchResultsMessage(
      "Search failed",
      "The STAC search request did not complete successfully.",
      "Search failed."
    );
  } finally {
    searchResultsState.isLoading = false;
    setSearchPanelLoading(false);
  }
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
  if (isTileJsonAsset(asset)) {
    return addTileJsonAssetToMap(item, asset, assetKey);
  }

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
  
  itemLayerSourceMap.set(layer, imageryUrl);
  scene.map.add(layer);
  return layer;
}

function createTileJsonFullExtent(tileJson) {
  if (!Array.isArray(tileJson?.bounds) || tileJson.bounds.length < 4) {
    return null;
  }

  const [xmin, ymin, xmax, ymax] = tileJson.bounds;

  return webMercatorUtils.geographicToWebMercator(new Extent({
    xmin,
    ymin,
    xmax,
    ymax,
    spatialReference: {
      wkid: 4326
    }
  }));
}

function getTileJsonUrlTemplate(tileJson) {
  const tileTemplate = tileJson?.tiles?.find(url => typeof url === "string");
  const [rawBase, rawQuery = ""] = tileTemplate.split("?", 2);

  const inParams = new URLSearchParams(rawQuery);
  const parts = [];

  // URLSearchParams.entries() gives decoded values.
  // Re-encode with encodeURIComponent so spaces become %20, not "+".
  for (const [key, value] of inParams.entries()) {
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }

  return parts.length ? `${rawBase}?${parts.join("&")}` : rawBase;
}

function getTileJsonSubDomains(tileJson) {
  if (Array.isArray(tileJson?.subdomains) && tileJson.subdomains.length) {
    return tileJson.subdomains.map(String);
  }

  return null;
}

async function addTileJsonAssetToMap(item, asset, assetKey) {
  const tileJsonUrl = getAssetHref(asset);

  if (!tileJsonUrl || !scene.map) {
    return null;
  }

  const response = await fetch(tileJsonUrl);

  if (!response.ok) {
    throw new Error(`TileJSON request failed with status ${response.status}`);
  }

  const tileJson = await response.json();
  const urlTemplate = getTileJsonUrlTemplate(tileJson);

  if (!urlTemplate) {
    throw new Error("TileJSON response does not include a supported tile template");
  }
  console.log(urlTemplate)

  const layer = new WebTileLayer({
    copyright: tileJson.attribution || asset.description || undefined,
    fullExtent: createTileJsonFullExtent(tileJson) || undefined,
    subDomains: getTileJsonSubDomains(tileJson) || undefined,
    title: asset.title || tileJson.name || assetKey || item.id || "STAC tiles",
    urlTemplate
  });

  console.log(layer);

  itemLayerSourceMap.set(layer, tileJsonUrl);
  scene.map.add(layer);
  return layer;
}