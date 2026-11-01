package protocol

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestRoundTripAllTypes(t *testing.T) {
	conf := 0.9
	ev := SceneEvent{ID: "e1", StreamID: "cam1", TsMs: 5, WallMs: 6, Type: "dog.eating", Confidence: 0.5,
		Actors: []Actor{{Label: "dog", TrackID: "t1", BBox: &BBox{0.1, 0.2, 0.3, 0.4}, Confidence: &conf}},
		Attrs:  map[string]any{"k": "v"}, Summary: "s", FrameRef: &FrameRef{StreamID: "cam1", TsMs: 5}, Scenario: "pets"}
	si := StreamInfo{ID: "cam1", Name: "n", URI: "u", State: StateLive}
	ms := MinuteSummary{StreamID: "cam1", MinuteStartMs: 60000, WallMs: 1, Text: "t", EventCount: 2}
	ac := AudioChunk{Seq: 1, TsMs: 2, SampleRate: 16000, PCM16B64: "AAA="}
	msgs := []Message{
		SessionStart{Type: "session.start", Scenario: "pets", StreamIDs: []string{"cam1"}, Locale: "en-US"},
		ClientAudio{Type: "audio.chunk", AudioChunk: ac},
		TextMessage{Type: "text.message", Text: "hi"},
		BargeIn{Type: "control.barge_in"},
		Stop{Type: "control.stop"},
		HistoryQuery{Type: "history.query", RequestID: "r", StreamID: "cam1", SinceMs: 1, UntilMs: 2, Text: "q", Limit: 10},
		SessionStarted{Type: "session.started", SessionID: "x", Scenario: "pets", Streams: []StreamInfo{si}, ServerWallMs: 1},
		TranscriptPartial{Type: "transcript.partial", Text: "a", TsMs: 1},
		TranscriptFinal{Type: "transcript.final", Text: "a", TsMs: 1, UtteranceID: "u-1"},
		AssistantText{Type: "assistant.text", UtteranceID: "u-1", Delta: "d", Final: true},
		AssistantAudio{Type: "assistant.audio", AudioChunk: ac, UtteranceID: "u-1"},
		AssistantCancelled{Type: "assistant.cancelled", UtteranceID: "u-1", Reason: "barge_in"},
		EventMessage{Type: "event", Event: ev},
		SummaryMessage{Type: "summary", Summary: ms},
		StreamStatus{Type: "stream.status", Stream: si},
		HistoryResult{Type: "history.result", RequestID: "r", Events: []SceneEvent{ev}, Summaries: []MinuteSummary{ms}},
		ErrorMessage{Type: "error", Code: CodeQuota, Message: "m", RequestID: "r"},
	}
	for _, m := range msgs {
		b, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		if tp, _ := Peek(b); tp != m.MsgType() {
			t.Fatalf("%T: type field %q != %q", m, tp, m.MsgType())
		}
		got, err := Decode(b)
		if err != nil {
			t.Fatalf("%T: %v (%s)", m, err, b)
		}
		if !reflect.DeepEqual(got, m) {
			t.Fatalf("%T round trip mismatch:\n got %#v\nwant %#v", m, got, m)
		}
	}
}

func TestDecodeDefaultsAndErrors(t *testing.T) {
	m, err := Decode([]byte(`{"type":"session.start","scenario":"p","stream_ids":["a"]}`))
	if err != nil || m.(SessionStart).Locale != "en-US" {
		t.Fatalf("%v %v", m, err)
	}
	m, err = Decode([]byte(`{"type":"history.query","request_id":"r","since_ms":0,"until_ms":1}`))
	if err != nil || m.(HistoryQuery).Limit != 50 {
		t.Fatalf("%v %v", m, err)
	}
	bad := []string{
		`{}`, `not json`, `{"type":"nope"}`,
		`{"type":"session.start","scenario":"p","stream_ids":[]}`,
		`{"type":"session.start","scenario":"p","stream_ids":["Bad ID"]}`,
		`{"type":"audio.chunk","seq":0,"ts_ms":0,"sample_rate":44100,"pcm16_b64":""}`,
		`{"type":"text.message","text":""}`,
		`{"type":"text.message","text":"` + strings.Repeat("x", 4001) + `"}`,
		`{"type":"history.query","request_id":"r","since_ms":0,"until_ms":1,"limit":500}`,
	}
	for _, b := range bad {
		if _, err := Decode([]byte(b)); err == nil {
			t.Errorf("expected error for %.60s", b)
		}
	}
}

func TestValidStreamID(t *testing.T) {
	for id, want := range map[string]bool{"cam1": true, "a_b-c": true, "": false, "-a": false, "A": false, strings.Repeat("a", 65): false, strings.Repeat("a", 64): true} {
		if ValidStreamID(id) != want {
			t.Errorf("%q", id)
		}
	}
}
