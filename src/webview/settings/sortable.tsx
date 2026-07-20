// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Drag-drop reordering for the settings card lists (agents, MCP servers),
// wrapped once so both pages share one mechanism: dnd-kit for the pointer
// *and* keyboard paths (grab the handle, arrow keys move, announced to
// screen readers) — the part a hand-rolled pointer listener never delivers.
// The drag itself is ephemeral render state; the drop sends one reorder
// action upward and the orchestrator's republished order is what sticks.
import type { ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Icon } from "../shared/icon";

/** The card lists are vertical and homogeneous, so one context + the
 * vertical strategy covers both pages. `ids` is the rendered order;
 * `onReorder` gets the full post-drop order exactly once, on drop. */
export function SortableList(props: {
  ids: readonly string[];
  onReorder(ids: string[]): void;
  children: ReactNode;
}) {
  const sensors = useSensors(
    // distance 5: a plain click on the handle (or a wobbly press) never
    // starts a drag — only real movement does.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={({ active, over }) => {
        if (over === null || active.id === over.id) return;
        const from = props.ids.indexOf(String(active.id));
        const to = props.ids.indexOf(String(over.id));
        if (from === -1 || to === -1) return;
        props.onReorder(arrayMove([...props.ids], from, to));
      }}
    >
      <SortableContext items={[...props.ids]} strategy={verticalListSortingStrategy}>
        {props.children}
      </SortableContext>
    </DndContext>
  );
}

/** One sortable card. Render-prop so the grip handle lands inside the
 * card's own header row (not floated over it); `handle` is null when
 * dragging is off for this item (e.g. a connected-but-unpersisted agent —
 * there is no stored position to move). z-30 while dragging keeps the
 * lifted card above its siblings and below the Radix portal band. */
export function SortableItem(props: {
  id: string;
  disabled?: boolean;
  children: (handle: ReactNode) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
    disabled: props.disabled === true,
  });
  const handle =
    props.disabled === true ? null : (
      <button
        type="button"
        className="-ml-1 flex cursor-grab touch-none items-center self-stretch rounded text-muted-foreground opacity-60 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:cursor-grabbing"
        title="Drag to reorder"
        aria-label="Reorder"
        {...attributes}
        {...listeners}
      >
        <Icon name="gripper" />
      </button>
    );
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "relative z-30 opacity-70" : undefined}
    >
      {props.children(handle)}
    </div>
  );
}
