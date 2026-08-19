const { ipcRenderer } = require("electron");

const OVERLAY_ATTRIBUTE = "data-pinvou-surface-overlay";
const MAX_TEXT_LENGTH = 1_000;
const MAX_HTML_LENGTH = 8_000;

let editMode = false;
let hoverTarget;
let selectedTarget;
let hoverOverlay;
let selectedOverlay;
let selectedLabel;
let renderFrame;

function truncate(value, maximum) {
  const text = String(value || "");
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

function escapeSelector(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

function uniqueSelector(selector) {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function selectorFor(element) {
  const nodeId = element.getAttribute("data-aios-node");
  if (nodeId) {
    const selector = `[data-aios-node="${escapeSelector(nodeId)}"]`;
    if (uniqueSelector(selector)) return selector;
  }
  if (element.id) {
    const selector = `#${escapeSelector(element.id)}`;
    if (uniqueSelector(selector)) return selector;
  }

  const parts = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
    const tag = current.tagName.toLowerCase();
    let part = tag;
    if (current.id) {
      part = `#${escapeSelector(current.id)}`;
      parts.unshift(part);
      break;
    }
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((candidate) => candidate.tagName === current.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(" > ");
}

function preferredTarget(value) {
  if (!(value instanceof Element)) return undefined;
  if (value.closest(`[${OVERLAY_ATTRIBUTE}]`)) return undefined;
  const stable = value.closest("[data-aios-node]");
  if (stable) return stable;
  return value.closest("svg") || value;
}

function ensureOverlays() {
  if (!document.documentElement) return false;
  if (!hoverOverlay) {
    hoverOverlay = document.createElement("div");
    hoverOverlay.setAttribute(OVERLAY_ATTRIBUTE, "hover");
    Object.assign(hoverOverlay.style, {
      position: "fixed",
      display: "none",
      pointerEvents: "none",
      zIndex: "2147483645",
      border: "1px dashed rgba(101, 171, 255, .95)",
      background: "rgba(71, 143, 255, .08)",
      boxSizing: "border-box",
    });
    document.documentElement.appendChild(hoverOverlay);
  }
  if (!selectedOverlay) {
    selectedOverlay = document.createElement("div");
    selectedOverlay.setAttribute(OVERLAY_ATTRIBUTE, "selected");
    Object.assign(selectedOverlay.style, {
      position: "fixed",
      display: "none",
      pointerEvents: "none",
      zIndex: "2147483646",
      border: "2px solid #a8e84c",
      background: "rgba(168, 232, 76, .08)",
      boxShadow: "0 0 0 1px rgba(8, 12, 16, .45), 0 8px 24px rgba(0, 0, 0, .16)",
      boxSizing: "border-box",
    });
    selectedLabel = document.createElement("div");
    selectedLabel.setAttribute(OVERLAY_ATTRIBUTE, "label");
    Object.assign(selectedLabel.style, {
      position: "absolute",
      left: "-2px",
      bottom: "100%",
      maxWidth: "260px",
      padding: "5px 8px",
      overflow: "hidden",
      borderRadius: "6px 6px 0 0",
      color: "#10150a",
      background: "#a8e84c",
      font: "600 11px/1.2 system-ui, sans-serif",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      boxSizing: "border-box",
    });
    selectedOverlay.appendChild(selectedLabel);
    document.documentElement.appendChild(selectedOverlay);
  }
  return true;
}

function positionOverlay(overlay, element) {
  if (!overlay) return;
  if (!editMode || !element || !element.isConnected) {
    overlay.style.display = "none";
    return;
  }
  const rect = element.getBoundingClientRect();
  overlay.style.display = "block";
  overlay.style.left = `${Math.max(0, rect.left)}px`;
  overlay.style.top = `${Math.max(0, rect.top)}px`;
  overlay.style.width = `${Math.max(0, rect.width)}px`;
  overlay.style.height = `${Math.max(0, rect.height)}px`;
}

function renderOverlays() {
  renderFrame = undefined;
  if (!ensureOverlays()) return;
  positionOverlay(hoverOverlay, hoverTarget && hoverTarget !== selectedTarget ? hoverTarget : undefined);
  positionOverlay(selectedOverlay, selectedTarget);
  if (selectedLabel && selectedTarget) {
    const nodeId = selectedTarget.getAttribute("data-aios-node");
    selectedLabel.textContent = nodeId
      ? `${selectedTarget.tagName.toLowerCase()} · ${nodeId}`
      : selectedTarget.tagName.toLowerCase();
  }
}

function scheduleRender() {
  if (renderFrame !== undefined) return;
  renderFrame = requestAnimationFrame(renderOverlays);
}

function describeElement(element) {
  const computed = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const attributes = {};
  for (const attribute of Array.from(element.attributes).slice(0, 30)) {
    if (attribute.name === OVERLAY_ATTRIBUTE) continue;
    attributes[attribute.name] = truncate(attribute.value, 500);
  }
  const breadcrumbs = [];
  let current = element;
  while (current && breadcrumbs.length < 6) {
    const nodeId = current.getAttribute?.("data-aios-node");
    breadcrumbs.unshift(nodeId
      ? `${current.tagName.toLowerCase()}[data-aios-node="${nodeId}"]`
      : current.tagName.toLowerCase());
    current = current.parentElement;
  }
  return {
    selector: selectorFor(element),
    nodeId: element.getAttribute("data-aios-node") || undefined,
    tagName: element.tagName.toLowerCase(),
    text: truncate(element.innerText || element.textContent || "", MAX_TEXT_LENGTH),
    outerHTML: truncate(element.outerHTML, MAX_HTML_LENGTH),
    attributes,
    breadcrumbs,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    styles: {
      display: computed.display,
      position: computed.position,
      color: computed.color,
      backgroundColor: computed.backgroundColor,
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      fontWeight: computed.fontWeight,
      lineHeight: computed.lineHeight,
      width: computed.width,
      height: computed.height,
      margin: computed.margin,
      padding: computed.padding,
      border: computed.border,
      borderRadius: computed.borderRadius,
      gridTemplateColumns: computed.gridTemplateColumns,
      flexDirection: computed.flexDirection,
      gap: computed.gap,
    },
  };
}

function selectElement(element, notify = true) {
  selectedTarget = element;
  scheduleRender();
  if (notify) ipcRenderer.send("surface:selection", element ? describeElement(element) : null);
}

function onPointerOver(event) {
  if (!editMode) return;
  hoverTarget = preferredTarget(event.target);
  scheduleRender();
}

function onPointerOut(event) {
  if (!editMode) return;
  const next = preferredTarget(event.relatedTarget);
  if (!next || next !== hoverTarget) hoverTarget = undefined;
  scheduleRender();
}

function onClick(event) {
  if (!editMode) return;
  const target = preferredTarget(event.target);
  if (!target) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  hoverTarget = undefined;
  selectElement(target);
}

function onKeyDown(event) {
  if (!editMode || event.key !== "Escape") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  selectElement(undefined);
}

function attachListeners() {
  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointerout", onPointerOut, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", scheduleRender, true);
  window.addEventListener("resize", scheduleRender, true);
}

function detachListeners() {
  document.removeEventListener("pointerover", onPointerOver, true);
  document.removeEventListener("pointerout", onPointerOut, true);
  document.removeEventListener("click", onClick, true);
  document.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("scroll", scheduleRender, true);
  window.removeEventListener("resize", scheduleRender, true);
}

ipcRenderer.on("surface:edit-mode", (_event, payload = {}) => {
  detachListeners();
  editMode = Boolean(payload.enabled);
  hoverTarget = undefined;
  selectedTarget = undefined;
  if (editMode) {
    attachListeners();
    if (payload.restoreSelector) {
      try {
        selectedTarget = document.querySelector(payload.restoreSelector) || undefined;
      } catch {
        selectedTarget = undefined;
      }
    }
    scheduleRender();
    ipcRenderer.send("surface:selection", selectedTarget ? describeElement(selectedTarget) : null);
  } else {
    scheduleRender();
  }
});

ipcRenderer.on("surface:clear-selection", () => selectElement(undefined));

