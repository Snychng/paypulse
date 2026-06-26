/**
 * Typed wrappers over Tauri's event bus for the three PayPulse channels (PLAN §6).
 * Each helper returns the `UnlistenFn` promise — callers must await + clean up
 * (React 19 StrictMode double-mounts effects, so unsubscribe in the cleanup).
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  TickPayload,
  StateChangedPayload,
  MilestonePayload,
} from "./types";

export const EVENT = {
  TICK: "paypulse://tick",
  STATE_CHANGED: "paypulse://state-changed",
  MILESTONE: "paypulse://milestone",
} as const;

export function listenTick(
  handler: (payload: TickPayload) => void,
): Promise<UnlistenFn> {
  return listen<TickPayload>(EVENT.TICK, (e) => handler(e.payload));
}

export function listenStateChanged(
  handler: (payload: StateChangedPayload) => void,
): Promise<UnlistenFn> {
  return listen<StateChangedPayload>(EVENT.STATE_CHANGED, (e) =>
    handler(e.payload),
  );
}

export function listenMilestone(
  handler: (payload: MilestonePayload) => void,
): Promise<UnlistenFn> {
  return listen<MilestonePayload>(EVENT.MILESTONE, (e) => handler(e.payload));
}
