'use client';

import { useState } from 'react';
import { ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react';
import type { MemoryTreeNode } from '@eduagent/shared';
import { cn } from '@/lib/utils';

/**
 * The memory explorer's file tree (plans/04 §7): committed files only,
 * dirs-first (server ordering). Memory speaks terminal — mono labels.
 */
function TreeNode({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: MemoryTreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth === 0);

  if (node.type === 'dir') {
    const FolderIcon = open ? FolderOpen : Folder;
    return (
      <li>
        <button
          type="button"
          aria-expanded={open}
          title={node.name}
          onClick={() => setOpen((current) => !current)}
          className="flex h-10 w-full items-center gap-1.5 rounded-sm px-2 font-mono text-caption text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground"
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
        >
          <ChevronRight
            aria-hidden
            className={cn('size-3 shrink-0 transition-transform duration-150', open && 'rotate-90')}
          />
          <FolderIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children ? (
          <ul>
            {node.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  const selected = node.path === selectedPath;
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        title={node.name}
        onClick={() => onSelect(node.path)}
        className={cn(
          'flex h-10 w-full items-center gap-1.5 rounded-sm px-2 font-mono text-caption transition-colors duration-150',
          selected
            ? 'bg-accent-soft text-primary-legible'
            : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
        )}
        style={{ paddingLeft: `${depth * 14 + 22}px` }}
      >
        <FileText className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{node.name}</span>
      </button>
    </li>
  );
}

export function FileTree({
  tree,
  selectedPath,
  onSelect,
}: {
  tree: MemoryTreeNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <nav aria-label="Memory files" className="min-h-0 overflow-y-auto p-2">
      <ul className="flex flex-col gap-0.5">
        {tree.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </nav>
  );
}

/** First file in dirs-first order — the explorer's initial selection. */
export function firstFilePath(tree: MemoryTreeNode[]): string | null {
  for (const node of tree) {
    if (node.type === 'file') return node.path;
  }
  for (const node of tree) {
    if (node.children) {
      const found = firstFilePath(node.children);
      if (found) return found;
    }
  }
  return null;
}
