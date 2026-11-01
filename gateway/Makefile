GO ?= go
.PHONY: build test lint run build-mediacore
build:
	$(GO) build -o bin/gateway ./cmd/gateway
build-mediacore: # requires ../mediacore/build (cmake -S ../mediacore -B ../mediacore/build && cmake --build ../mediacore/build)
	$(GO) build -tags mediacore -o bin/gateway ./cmd/gateway
test:
	$(GO) vet ./... && $(GO) test -race ./...
lint:
	golangci-lint run
run: build
	./bin/gateway -config gateway.yaml
