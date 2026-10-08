import type { Field, HierarchyLevel, HierarchyNode, Option, TableRow } from './contract';

/** The tree a hierarchy field renders: inlined by the tool, or assembled from
 * side-channel rows. Both shapes are the same HierarchyNode[]. */
export function hierarchyTree(field: Field, rows?: TableRow[] | null): HierarchyNode[] {
  if (field.tree?.length) return field.tree;
  if (!rows?.length) return [];
  return treeFromRows(field.levels ?? [], rows, field.optionsSource?.valueCell);
}

/**
 * Assemble a hierarchy tree from flat option rows.
 *
 * Each level names the row `cell` carrying its label; the levels are declared
 * outermost first and need not follow the cell order. Grouping is by the FULL
 * PATH of cell values, never by the label alone: department names recur across
 * divisions on real tenants (20 of them on wwecorp2), and a name-only grouping
 * would merge unrelated branches. Interior node keys are therefore built from
 * the whole path and namespaced per level, so they can never collide with a
 * leaf. The leaf key is the row's own key (or `valueCell`) - the canonical
 * option string the server expects - so a pick from an assembled tree submits
 * exactly what a pick from an inlined tree submits.
 *
 * A row with an empty cell keeps its place under an em-dash node rather than
 * disappearing. Every level is sorted by label, case-insensitively.
 */
export function treeFromRows(
  levels: HierarchyLevel[], rows: TableRow[], valueCell?: number,
): HierarchyNode[] {
  if (!levels.length) return [];
  const cellAt = (row: TableRow, index: number | undefined): string => {
    const raw = index === undefined ? '' : row.cells[index];
    return (raw ?? '').trim() || '—';
  };
  const leafLevel = levels[levels.length - 1];

  interface Group { label: string; children: Map<string, Group>; leaves: HierarchyNode[]; }
  const roots = new Map<string, Group>();

  for (const row of rows) {
    let bucket = roots;
    let pathKey = '';
    // Interior levels first; the last level is the leaf itself.
    for (let i = 0; i < levels.length - 1; i += 1) {
      const label = cellAt(row, levels[i].cell);
      pathKey = pathKey ? `${pathKey}|${label}` : label;
      const groupKey = `${levels[i].id}:${pathKey}`;
      let group = bucket.get(groupKey);
      if (!group) {
        group = { label, children: new Map(), leaves: [] };
        bucket.set(groupKey, group);
      }
      if (i === levels.length - 2) {
        const description = leafLevel.descriptionCell === undefined
          ? undefined
          : (row.cells[leafLevel.descriptionCell] ?? '').trim() || undefined;
        const key = valueCell === undefined
          ? row.key
          : (row.cells[valueCell] ?? '').trim() || row.key;
        group.leaves.push({ key, label: cellAt(row, leafLevel.cell), description });
      }
      bucket = group.children;
    }
  }

  // A single-level hierarchy has no interior grouping at all: every row is a leaf.
  if (levels.length === 1) {
    return sortNodes(rows.map((row) => ({
      key: valueCell === undefined
        ? row.key
        : (row.cells[valueCell] ?? '').trim() || row.key,
      label: cellAt(row, leafLevel.cell),
      description: leafLevel.descriptionCell === undefined
        ? undefined
        : (row.cells[leafLevel.descriptionCell] ?? '').trim() || undefined,
    })));
  }

  const build = (bucket: Map<string, Group>): HierarchyNode[] => sortNodes(
    [...bucket.entries()].map(([key, group]) => ({
      key,
      label: group.label,
      children: group.leaves.length ? sortNodes(group.leaves) : build(group.children),
    })),
  );
  return build(roots);
}

function sortNodes(nodes: HierarchyNode[]): HierarchyNode[] {
  return [...nodes].sort(
    (a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase())
      || a.key.localeCompare(b.key),
  );
}

/** Nodes available at `levelIndex` given the chosen path so far. */
export function hierarchyOptionsAt(field: Field, path: string[], levelIndex: number): Option[] {
  return optionsAtIn(field.tree ?? [], path, levelIndex);
}

/** Tree-taking form of {@link hierarchyOptionsAt} (side-channel trees). */
export function optionsAtIn(
  tree: HierarchyNode[], path: string[], levelIndex: number,
): Option[] {
  let nodes: HierarchyNode[] = tree;
  for (let i = 0; i < levelIndex; i += 1) {
    const picked = nodes.find((n) => n.key === path[i]);
    if (!picked) return [];
    nodes = picked.children ?? [];
  }
  return nodes.map(({ key, label, description }) => ({ key, label, description }));
}

/** Human-readable labels for a chosen path, e.g. for review rows. */
export function hierarchyPathLabels(field: Field, path: string[]): string[] {
  return pathLabelsIn(field.tree ?? [], path);
}

/** Tree-taking form of {@link hierarchyPathLabels}. */
export function pathLabelsIn(tree: HierarchyNode[], path: string[]): string[] {
  const labels: string[] = [];
  let nodes: HierarchyNode[] = tree;
  for (const key of path) {
    const picked = nodes.find((n) => n.key === key);
    if (!picked) break;
    labels.push(picked.label);
    nodes = picked.children ?? [];
  }
  return labels;
}

/**
 * The full key path down to `key`, at whatever depth it sits, or null when the
 * tree does not hold it. This is what turns a bare leaf key - all a prefilled
 * side-channel field carries - back into the path the linked dropdowns render.
 */
export function pathTo(tree: HierarchyNode[], key: string): string[] | null {
  for (const node of tree) {
    if (node.key === key) return [node.key];
    const deeper = node.children ? pathTo(node.children, key) : null;
    if (deeper) return [node.key, ...deeper];
  }
  return null;
}
