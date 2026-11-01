import { useFrame } from "../hooks";
import { useApp } from "../ctx";
import type { StreamInfo } from "@argus/protocol";
import { StatusBadge } from "./StatusBadge";

export function FrameTile({
  stream,
  seekTs,
  maxW = 320,
}: {
  stream: Pick<StreamInfo, "id" | "name" | "state" | "fps">;
  seekTs?: number | null;
  maxW?: number;
}) {
  const { api } = useApp();
  const { url, error } = useFrame(api, stream.id, seekTs ?? null, maxW);
  return (
    <figure className="tile">
      <div className="tile-img">
        {url ? (
          <img src={url} alt={`Latest frame of ${stream.name || stream.id}`} />
        ) : (
          <span className="muted">no frame</span>
        )}
        {seekTs != null && <span className="seek-tag">@ {Math.round(seekTs / 1000)}s</span>}
      </div>
      <figcaption>
        <strong>{stream.name || stream.id}</strong> <StatusBadge state={stream.state} fps={stream.fps} />
        {error && <div className="err small">{error}</div>}
      </figcaption>
    </figure>
  );
}
