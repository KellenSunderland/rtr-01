import { useCallback, useEffect, useState } from "react";
import type { StreamInfo } from "@argus/protocol";
import { useApp } from "../ctx";
import { useInterval } from "../hooks";
import { FrameTile } from "../components/FrameTile";

export function StreamsPage() {
  const { api } = useApp();
  const [streams, setStreams] = useState<StreamInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ id: "", name: "", uri: "" });

  const refresh = useCallback(() => {
    api
      .listStreams()
      .then((s) => {
        setStreams(s);
        setErr(null);
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, [api]);
  useEffect(refresh, [refresh]);
  useInterval(refresh, 3000);

  return (
    <div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          api
            .createStream({ id: form.id, name: form.name || form.id, uri: form.uri })
            .then(() => {
              setForm({ id: "", name: "", uri: "" });
              refresh();
            })
            .catch((x: unknown) => setErr(x instanceof Error ? x.message : String(x)));
        }}
      >
        <input
          placeholder="id (a-z0-9_-)"
          value={form.id}
          required
          pattern="[a-z0-9][a-z0-9_\-]*"
          maxLength={64}
          onChange={(e) => setForm({ ...form, id: e.target.value })}
        />
        <input
          placeholder="name"
          value={form.name}
          maxLength={100}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <input
          placeholder="uri (rtsp://, http(s)://, device:N, file path)"
          value={form.uri}
          required
          maxLength={2048}
          onChange={(e) => setForm({ ...form, uri: e.target.value })}
        />
        <button type="submit">Add stream</button>
      </form>
      {err && <p className="err">{err}</p>}
      <div className="grid">
        {streams.map((s) => (
          <div key={s.id}>
            <FrameTile stream={s} />
            <button
              className="small danger"
              onClick={() => {
                if (confirm(`Delete stream ${s.id}?`))
                  api
                    .deleteStream(s.id)
                    .then(refresh)
                    .catch((x: unknown) => setErr(x instanceof Error ? x.message : String(x)));
              }}
            >
              Delete
            </button>
          </div>
        ))}
        {streams.length === 0 && <p className="muted">No streams.</p>}
      </div>
    </div>
  );
}
