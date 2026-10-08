# Drag-and-Drop Auto-Routing Plan

## Overview

Add drag-and-drop to the `HROUploadZone` right panel. When a user drags a file from their OS onto the panel, a full-panel overlay appears showing exactly which slot the file will land in (auto-detected by extension). Dropping fires the existing `uploadFile()` function directly — no extra button click, no split zones.

**Routing rules:**
- `.docx` / `.doc` → always PD slot
- `.pdf` → always Class Spec slot
- `.md` → whichever slot is empty (PD first); if both filled, replaces PD

**Scope:** One file only — `HROUploadZone.tsx`. No backend changes. No changes to classify pipeline, pending-files, or any other file.

---

## Sub-Tasks

### Task 1 — Drag state tracking in `HROUploadZone`

**Intent:** Detect when a file is being dragged over the panel and compute which slot it will route to, so the overlay can show the right label before the drop.

**Expected Outcomes:**
- `dragTarget` state: `null | 'pd' | 'classspec'` — computed from the dragged file's extension
- `isDragging` boolean — true while a file hovers over the panel
- `onDragEnter`, `onDragOver`, `onDragLeave`, `onDrop` handlers attached to the outer `hro-upload-zone` div

**Todo List:**
1. Add `isDragging` and `dragTarget` state to `HROUploadZone`
2. Write `inferSlot(filename, pdFilled, csFilled)` pure function that returns `'pd' | 'classspec'` using the routing rules
3. Implement `handleDragEnter` / `handleDragOver` — read `e.dataTransfer.items[0]` for extension, set `isDragging=true` and `dragTarget`
4. Implement `handleDragLeave` — only clear when leaving the outer div (check `relatedTarget`)
5. Implement `handleDrop` — call `uploadFile(file, dragTarget)`, reset drag state

**Relevant Context:**
- `HROUploadZone` is in `apps/hawaii-shell/src/HROUploadZone.tsx` lines 480–713
- `uploadFile(file, kind)` already exists at line 494 — just call it with the inferred kind
- `pdSlot` and `csSlot` state already exist — use `isOk(pdSlot)` / `isOk(csSlot)` to decide `.md` routing

**Status:** [ ] pending

---

### Task 2 — Full-panel drag overlay UI

**Intent:** While `isDragging` is true, render an overlay over the entire panel that labels where the file will land, using the existing accent colors (purple for PD, teal for Class Spec).

**Expected Outcomes:**
- Overlay covers the full `hro-upload-zone` div (position: absolute, inset: 0)
- Shows the slot name, extension hint, and a drop icon
- Purple border/glow for PD target; teal border/glow for Class Spec target
- Overlay disappears instantly on drop or drag-leave
- Panel content underneath is visible but dimmed (backdrop blur + opacity)

**Todo List:**
1. Add an overlay `Box` conditionally rendered when `isDragging === true`, positioned `absolute` over the panel
2. Display: large icon + `"Drop as Position Description"` or `"Drop as Class Spec"` label + extension hint line
3. Apply accent color based on `dragTarget`: purple (`#7c5cf6`) for `'pd'`, teal (`#06d6a0`) for `'classspec'`
4. Animate border/glow on the overlay box using existing MUI `sx` patterns already in the file

**Relevant Context:**
- The outer `hro-upload-zone` div needs `position: relative` — check existing CSS in `HROUploadZone.tsx`
- Accent colors already defined as CSS vars `--hro-accent-1` (purple) and `--hro-accent-2` (teal)
- `accentRgb` pattern already used throughout `LibraryPicker` for rgba overlays — reuse same values directly: `124,92,246` for PD, `6,214,160` for CS

**Status:** [ ] pending

---

### Task 3 — Also add drag-and-drop to the upload-mode box inside `LibraryPicker`

**Intent:** When the user has switched a slot to Upload mode, the dashed box should also accept drops — consistent with the panel-level drag behaviour and as a fallback for users who drag onto that specific box.

**Expected Outcomes:**
- The dashed upload box in `LibraryPicker` (lines 440–467) accepts `dragover` + `drop`
- Visual feedback: border brightens, text changes to "Drop to upload" while hovering
- Dropping calls `onFileUpload(file)` directly

**Todo List:**
1. Add `isDraggingOver` local state to `LibraryPicker`
2. Add `onDragOver`, `onDragLeave`, `onDrop` to the upload-mode `Box` (lines 440–453)
3. Update `sx` to show brighter border + "Drop to upload" text when `isDraggingOver`

**Relevant Context:**
- Upload mode `Box` is at `LibraryPicker` lines 438–468
- `onFileUpload` prop already exists — call it with `e.dataTransfer.files[0]`
- This is a smaller, self-contained change within `LibraryPicker`

**Status:** [ ] pending
