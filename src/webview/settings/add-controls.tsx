// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// How a Settings page adds what it lists — the Agents page and MCP Servers
// alike: a row of counter tiles with the add tile at its end, opening one
// add card above the list, and a searchable picker over what can be added
// from a source (the ACP registry, the curated catalog). The details of
// what is picked are each page's own.
import { useState, type ReactNode } from "react";
import { Icon } from "../shared/icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const TILE = "min-w-24 flex-none rounded-lg px-4 py-2.5 text-center";

/** Counter tiles, then the add tile — one container so they share sizing
 * and rhythm. The add tile is a tile-shaped Button: same box as the
 * counters, but it reads as an action (accent icon, hover lift), set
 * right while the counters stay left. */
export function AddTiles(props: {
  tiles: readonly { n: number; label: string; icon: string }[];
  addLabel: string;
  open: boolean;
  onToggle(): void;
}) {
  return (
    <div className="mb-3.5 flex flex-wrap gap-2.5">
      {props.tiles.map((t) => (
        <Card className={TILE} key={t.label}>
          <div className="flex items-center justify-center gap-1.5 text-[22px] font-semibold">
            <span className="text-muted-foreground"><Icon name={t.icon} /></span>
            {t.n}
          </div>
          <div className="text-[11px] text-muted-foreground">{t.label}</div>
        </Card>
      ))}
      <Button
        variant="outline"
        className={`${TILE} ml-auto h-auto flex-col items-center gap-0 border-border bg-card font-normal text-foreground shadow-sm hover:border-brand hover:bg-accent hover:text-foreground aria-expanded:border-brand aria-expanded:bg-accent`}
        onClick={props.onToggle}
        aria-expanded={props.open}
      >
        <div className="text-[22px] font-semibold text-brand">
          <Icon name={props.open ? "chevron-up" : "add"} />
        </div>
        <div className="text-[11px] text-muted-foreground">{props.open ? "close" : props.addLabel}</div>
      </Button>
    </div>
  );
}

/** One thing the picker offers. `added`: already added once — marked,
 * never hidden: adding it again adds a second one. `unavailable`: why it
 * can't be picked, said beside it. */
export interface PickerEntry {
  id: string;
  name: string;
  /** Matched by the search beside the name. */
  description: string;
  icon: ReactNode;
  /** Shown after the name — tags. */
  tags?: ReactNode;
  added: boolean;
  unavailable: string | null;
}

/** Searchable picker — type to filter, click to pick, clear to search
 * again. Fully controlled — the only local state is whether the dropdown
 * is open, so a parent reset (after Add, or on mode toggle) can't leave it
 * out of sync. */
export function SearchPicker(props: {
  entries: readonly PickerEntry[];
  placeholder: string;
  /** Said when the source has nothing at all. */
  emptySource: string;
  query: string;
  selectedId: string;
  onQueryChange(query: string): void;
  onSelect(id: string): void; // "" clears the selection
  /** The dropdown opened: the list is about to be read. */
  onBrowse?(): void;
}) {
  const [open, setOpen] = useState(false);
  const selected = props.entries.find((r) => r.id === props.selectedId);

  return (
    <div className="flex items-center gap-1.5">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) props.onBrowse?.();
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            className="w-72 max-w-full justify-between font-normal"
          >
            {selected !== undefined ? selected.name : props.placeholder}
            <Icon name="chevron-down" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput
              placeholder={props.placeholder}
              value={props.query}
              onValueChange={(q) => {
                props.onQueryChange(q);
                if (props.selectedId !== "") props.onSelect("");
              }}
            />
            <CommandList>
              <CommandEmpty>
                {props.entries.length === 0 ? props.emptySource : `no matches for “${props.query}”`}
              </CommandEmpty>
              {props.entries.map((r) => (
                <CommandItem
                  key={r.id}
                  value={r.name}
                  keywords={[r.description]}
                  disabled={r.unavailable !== null}
                  title={r.description}
                  onSelect={() => {
                    props.onSelect(r.id);
                    props.onQueryChange(r.name);
                    setOpen(false);
                  }}
                >
                  {r.id === props.selectedId && <Icon name="check" />}
                  {r.icon}
                  {r.name}
                  {r.tags}
                  {r.added && <span className="note"> — added</span>}
                  {r.unavailable !== null && <span className="note"> — {r.unavailable}</span>}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {props.selectedId !== "" && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Clear selection"
          onClick={() => {
            props.onSelect("");
            props.onQueryChange("");
          }}
        >
          <Icon name="close" />
        </Button>
      )}
    </div>
  );
}
