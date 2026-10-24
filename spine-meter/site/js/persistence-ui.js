// Panels that the Gauntlet and Batch pages share: the preset panel, the Saved runs list and the resume notices.
// Text is always set with textContent. Nothing here sends a request. The pages pass in what each panel needs.

import { el } from "./ui.js";
import { createMemoryAdapter } from "./store/memory-adapter.js";
import { openRunStorage, deleteRun, exportRun, getRun } from "./store/run-store.js";
import { createPresetStore } from "./presets.js";
import { savedRunRows, interruptedRunsOfKind } from "./saved-runs.js";

// How long to wait before freeing a download URL, so the browser has started the download first.
const REVOKE_DELAY_MS = 1000;
const NO_STORAGE_TEXT = "Runs are not saved in this window. Presets last only until this page is closed.";
const STORAGE_TEXT = "Runs and presets are kept in this browser, so they survive a reload. The key is never saved.";
const NO_PRESETS_TEXT = "No presets yet";
const UNKNOWN_ERROR_TEXT = "Something went wrong. Try again.";
const PRESET_HINT_TEXT = "To rename, select a preset, type the new name in the box, then press Rename.";
const STORE_READ_TEXT = "The presets could not be read. The page still works.";

/**
 * Open the saved-run storage for a page. Resolves { adapter, fallback }. When the browser cannot open IndexedDB,
 * fallback is true and runs last only until the page is closed.
 */
export async function openPageStorage() {
  try {
    return await openRunStorage();
  } catch {
    return { adapter: createMemoryAdapter(), fallback: true };
  }
}

/** Return the sentence that tells the visitor whether runs survive a reload. */
export function storageText(fallback) {
  return fallback ? NO_STORAGE_TEXT : STORAGE_TEXT;
}

/** Return the message for an error. Only plain messages are shown. */
function errorText(error) {
  return error instanceof Error ? error.message : UNKNOWN_ERROR_TEXT;
}

/** Join the non-empty sentences with a space. */
function joinSentences(...parts) {
  return parts.filter((part) => part !== "").join(" ");
}

/** Return the note about fields that were left out of a preset, or an empty text when none were. */
function droppedText(dropped) {
  if (dropped.length === 0) {
    return "";
  }
  return `Left out: ${dropped.join(", ")}. These are not used on this page, or their values were not valid.`;
}

/** Save text as a file. The link is made, clicked and removed; the URL is revoked a moment later. */
export function downloadText(fileName, text, mimeType) {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const link = el("a", { href: url, download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/** Build a button with its text. */
function button(text, className = "btn") {
  return el("button", { type: "button", className, text });
}

/** Build a label for a control, linked by id. */
function labelFor(id, text) {
  return el("label", { className: "field-label", for: id, text });
}

/**
 * Build the preset panel for one page. The options are:
 * idPrefix (unique per page), page ("gauntlet" or "batch"), store (from presets.createPresetStore),
 * readSettings() (the page's current choices), applySettings(settings) (sets the page's controls and returns
 * a note, or a promise of one), and hint (a line under the controls).
 * Returns { root, refresh, setBusy }.
 */
export function buildPresetPanel({ idPrefix, page, store, readSettings, applySettings, hint = "" }) {
  const ids = {
    select: `${idPrefix}-preset-select`,
    name: `${idPrefix}-preset-name`,
    status: `${idPrefix}-preset-status`,
  };
  const select = el("select", { className: "select", id: ids.select });
  const nameInput = el("input", {
    className: "text-input", id: ids.name, type: "text", autocomplete: "off", spellcheck: "false",
  });
  const status = el("p", {
    className: "field-hint preset-status",
    id: ids.status,
    role: "status",
    "aria-live": "polite",
  });
  const loadButton = button("Load preset");
  const saveButton = button("Save as new preset");
  const renameButton = button("Rename preset");
  const deleteButton = button("Delete preset", "btn btn-danger");
  let presetCount = 0;
  let busy = false;

  /** Enable or disable the controls: none while busy, and the ones that need a preset only when there is one. */
  function applyEnabled() {
    select.disabled = busy || presetCount === 0;
    for (const control of [loadButton, renameButton, deleteButton]) {
      control.disabled = busy || presetCount === 0;
    }
    saveButton.disabled = busy;
    nameInput.disabled = busy;
  }

  /** Fill the menu with the presets of this page. selectedId is chosen when given, else the current choice is kept. */
  async function refresh(selectedId = null) {
    const keptId = selectedId ?? select.value;
    const presets = await store.list(page);
    presetCount = presets.length;
    const options = presets.length === 0
      ? [el("option", { value: "", text: NO_PRESETS_TEXT, disabled: true })]
      : presets.map((preset) => el("option", { value: preset.id, text: preset.name }));
    select.replaceChildren(...options);
    const stillThere = presets.some((preset) => preset.id === keptId);
    select.value = stillThere ? keptId : (presets[0]?.id ?? "");
    applyEnabled();
  }

  /** Return the name shown in the menu for the chosen preset. */
  function selectedName() {
    const option = select.selectedOptions[0];
    return option ? option.textContent : "";
  }

  /** Run one action: show its message, or the plain error, and refresh the menu after it. */
  async function act(action) {
    busy = true;
    applyEnabled();
    try {
      status.textContent = await action();
    } catch (error) {
      status.textContent = errorText(error);
    } finally {
      busy = false;
      await refresh().catch(() => {});
    }
  }

  loadButton.addEventListener("click", () => act(loadPreset));
  saveButton.addEventListener("click", () => act(savePreset));
  renameButton.addEventListener("click", () => act(renamePreset));
  deleteButton.addEventListener("click", () => act(deletePreset));
  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      act(savePreset);
    }
  });

  /** Apply the chosen preset to the page and say what was loaded. */
  async function loadPreset() {
    const loaded = await store.load(select.value);
    const note = await applySettings(loaded.settings);
    return joinSentences(`Loaded ${loaded.name}.`, note, droppedText(loaded.dropped));
  }

  /** Save the page's current choices as a new preset with the typed name. */
  async function savePreset() {
    const saved = await store.save(page, nameInput.value, readSettings());
    nameInput.value = "";
    await refresh(saved.id);
    return joinSentences(`Saved ${saved.name}.`, droppedText(saved.dropped));
  }

  /** Give the chosen preset the name typed in the box. */
  async function renamePreset() {
    const renamed = await store.rename(select.value, nameInput.value);
    nameInput.value = "";
    await refresh(renamed.id);
    return `Renamed to ${renamed.name}.`;
  }

  /** Delete the chosen preset after the visitor confirms. */
  async function deletePreset() {
    const name = selectedName();
    if (!window.confirm(`Delete the preset ${name}? This cannot be undone.`)) {
      return "";
    }
    await store.remove(select.value);
    return `Deleted ${name}.`;
  }

  const root = el("div", { className: "preset-panel" }, [
    el("div", { className: "field" }, [labelFor(ids.select, "Saved preset"), select]),
    el("div", { className: "field" }, [
      labelFor(ids.name, "Preset name, for save and rename"),
      nameInput,
    ]),
    el("div", { className: "button-row" }, [loadButton, saveButton, renameButton, deleteButton]),
    el("p", { className: "field-hint", text: joinSentences(hint, PRESET_HINT_TEXT) }),
    status,
  ]);

  refresh().catch(() => {
    status.textContent = STORE_READ_TEXT;
  });

  return {
    root,
    refresh: () => refresh(),
    setBusy(value) {
      busy = value;
      applyEnabled();
    },
  };
}

/** Return the words for a run's counts, such as "12 of 708 units saved". */
function countText(row, unitWord) {
  return `${row.saved} of ${row.planned} ${unitWord} saved`;
}

/**
 * Build the Saved runs list for one kind of run ("batch" or "gauntlet"), newest first. Each row has Resume (when it
 * can be resumed), Export (a JSON download) and Delete (after a confirmation). The options are adapter, kind, queue
 * (the page's serial queue for run writes), unitWord ("units" or "steps"), onResume(run) and onChanged().
 * Returns { root, refresh }.
 */
export function buildRunsList({ adapter, kind, queue, unitWord, onResume, onChanged }) {
  const host = el("div", { className: "run-list-host" });

  /** Build one row of the list. */
  function rowItem(row) {
    const resume = button("Resume");
    resume.setAttribute("aria-label", `Resume ${row.label}`);
    resume.disabled = !row.resumable;
    resume.addEventListener("click", () => resumeRow(row.id));
    const exportButton = button("Export");
    exportButton.setAttribute("aria-label", `Export ${row.label}`);
    exportButton.addEventListener("click", () => exportRunFile(adapter, row.id));
    const remove = button("Delete", "btn btn-danger");
    remove.setAttribute("aria-label", `Delete ${row.label}`);
    remove.addEventListener("click", () => removeRun(row.id, row.label, `Delete ${row.label}?`));
    return el("li", { className: "run-item" }, [
      el("div", { className: "run-main" }, [
        el("p", { className: "run-label", text: row.label }),
        el("p", {
          className: "run-meta",
          text: `${row.statusText} · ${countText(row, unitWord)} · ${formatDate(row.createdAt)}`,
        }),
      ]),
      el("div", { className: "button-row run-actions" }, [resume, exportButton, remove]),
    ]);
  }

  /** Hand one saved run to the page to resume. */
  async function resumeRow(runId) {
    const run = await getRun(adapter, runId);
    if (run !== null) {
      onResume(run);
    }
  }

  /** Delete one run after a confirmation, then tell the page. */
  async function removeRun(runId, label, question) {
    if (!window.confirm(question)) return;
    await queue.run(() => deleteRun(adapter, runId));
    onChanged(runId);
    await refresh();
  }

  /** Draw the list again from storage. */
  async function refresh() {
    const rows = await savedRunRows(adapter, kind);
    const items = rows.length === 0
      ? [el("p", { className: "field-hint", text: "No saved runs yet." })]
      : [el("ol", { className: "run-list" }, rows.map(rowItem))];
    host.replaceChildren(...items);
  }

  return { root: host, refresh };
}

/** Download one run as JSON. The export holds only the fields the store lets out, so no key is included. */
async function exportRunFile(adapter, runId) {
  const run = await getRun(adapter, runId);
  if (run !== null) {
    downloadText(`run-${runId}.json`, exportRun(run), "application/json");
  }
}

/** Return a short date and time for a run, in English. */
function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Build the notices for runs that were cut off by a reload or a closed tab. Each has Resume and Discard. The options
 * are as for buildRunsList, plus activeRunId() (the id of the run this page is working on, which is not listed).
 * Returns { root, refresh }.
 */
export function buildResumeNotices({ adapter, kind, queue, unitWord, activeRunId, onResume, onChanged }) {
  const host = el("div", { className: "notice-list" });

  /** Build one notice for an interrupted run. */
  function noticeItem(run) {
    const saved = Object.keys(run.results).length;
    const resume = button("Resume");
    resume.setAttribute("aria-label", `Resume ${run.label}`);
    resume.addEventListener("click", () => onResume(run));
    const discard = button("Discard", "btn btn-danger");
    discard.setAttribute("aria-label", `Discard ${run.label}`);
    discard.addEventListener("click", () => discardRun(run));
    const counts = `${saved} of ${run.plannedUnits.length} ${unitWord} saved`;
    return el("section", { className: "notice", "aria-label": "Unfinished run" }, [
      el("p", { className: "label notice-title", text: "Unfinished run" }),
      el("p", {
        className: "notice-text",
        text: `${run.label} was cut off before it finished. ${counts}. `
          + "Resume to carry on without repeating what is saved.",
      }),
      el("div", { className: "button-row" }, [resume, discard]),
    ]);
  }

  /** Delete an unfinished run after a confirmation, then redraw the notices. */
  async function discardRun(run) {
    if (!window.confirm(`Discard the unfinished run ${run.label}? Its saved results will be deleted.`)) return;
    await queue.run(() => deleteRun(adapter, run.id));
    onChanged(run.id);
    await refresh();
  }

  /** Draw the notices for the runs that are still marked running and are not the one open on this page. */
  async function refresh() {
    const runs = await interruptedRunsOfKind(adapter, kind, activeRunId());
    host.replaceChildren(...runs.map(noticeItem));
  }

  return { root: host, refresh };
}
