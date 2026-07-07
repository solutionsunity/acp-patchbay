// Shared settings controls — the 1:1 shadcn mappings of the original
// hand-built trio (ui-rendering-strategy: Field/Toggle/ConfirmButton →
// labeled row / Switch / AlertDialog) plus the fidelity chip.
import type { ReactNode } from "react";
import type { CapabilityMatrix } from "../../shared/protocol";
import { computeFidelity } from "../../shared/protocol";
import { FIDELITY_CLASS, FIDELITY_TEXT } from "../shared/capability-format";
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
import { Badge } from "@/components/ui/badge";
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
export function ConfirmButton(props: { label: string; confirmLabel?: string; title?: string; onConfirm(): void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">{props.label}</Button>
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

/** The active/inactive mute switch (P13d: Toggle → shadcn Switch, 1:1). */
export function Toggle(props: { checked: boolean; label: string; title?: string; onChange(checked: boolean): void }) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-[12px]" title={props.title}>
      <Switch checked={props.checked} onCheckedChange={props.onChange} />
      {props.label}
    </label>
  );
}

export function FidelityChip({ matrix, knownBypassBridge }: { matrix: CapabilityMatrix; knownBypassBridge: boolean }) {
  const label = computeFidelity(matrix, knownBypassBridge);
  return <Badge className={`fid ${FIDELITY_CLASS[label]}`}>{FIDELITY_TEXT[label]}</Badge>;
}
