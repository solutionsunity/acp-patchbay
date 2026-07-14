// Shared settings controls — the 1:1 shadcn mappings of the original
// hand-built trio (ui-rendering-strategy: Field/Toggle/ConfirmButton →
// labeled row / Switch / AlertDialog).
import type { ReactNode } from "react";
import { Icon } from "../shared/icon";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

/** Labeled form field — one row: label column | control column. The row
 * layout is the binding contract (ui-rendering-strategy § component list);
 * the wrapper stays a native <label> so clicking the label focuses the
 * control — the shadcn conversion happens in the controls inside it. */
export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field" title={props.hint}>
      <span className="lbl">{props.label}</span>
      {props.children}
    </label>
  );
}

/** Destructive confirm — same honesty contract as the old two-step button
 * (no destructive action without an explicit second click), now the shadcn
 * AlertDialog (P13d: ConfirmButton → AlertDialog, 1:1). The dialog states
 * exactly what will happen (`title` — previously a hover tooltip, now
 * impossible to miss) before offering the confirm. */
export function ConfirmButton(props: {
  label: string;
  /** Codicon name — renders the trigger icon-only (label moves to aria/tooltip). */
  icon?: string;
  variant?: "outline" | "destructive";
  confirmLabel?: string;
  title?: string;
  /** In-flight guard: dims the trigger instead of unmounting it — removing
   * an open Radix AlertDialog from the tree mid-interaction can strand the
   * body's pointer-events lock and freeze the whole webview. */
  disabled?: boolean;
  onConfirm(): void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        {props.icon !== undefined ? (
          <Button variant={props.variant ?? "outline"} size="icon" className="size-8" title={props.label} aria-label={props.label} disabled={props.disabled}>
            <Icon name={props.icon} />
          </Button>
        ) : (
          <Button variant={props.variant ?? "outline"} size="sm" disabled={props.disabled}>{props.label}</Button>
        )}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.confirmLabel ?? `Confirm ${props.label.toLowerCase()}?`}</AlertDialogTitle>
          {props.title !== undefined && <AlertDialogDescription>{props.title}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={props.onConfirm}>{props.label}</AlertDialogAction>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** THE on/off control (P13d: Toggle → shadcn Switch, 1:1) — every persisted
 * boolean setting renders through this one component; Checkbox stays for
 * picking members of a set, never for state. Optional leading codicon. */
export function Toggle(props: {
  checked: boolean;
  label: string;
  icon?: string;
  title?: string;
  onChange(checked: boolean): void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-[12px]" title={props.title}>
      {props.icon !== undefined && <Icon name={props.icon} />}
      <Switch checked={props.checked} onCheckedChange={props.onChange} />
      {props.label}
    </label>
  );
}

