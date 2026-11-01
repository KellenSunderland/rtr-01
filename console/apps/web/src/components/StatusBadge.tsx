import type { StreamInfo } from "@argus/protocol";

export function StatusBadge({ state, fps }: Pick<StreamInfo, "state" | "fps">) {
  return (
    <span className={`badge badge-${state}`}>
      {state}
      {fps !== undefined ? ` · ${fps.toFixed(1)} fps` : ""}
    </span>
  );
}
